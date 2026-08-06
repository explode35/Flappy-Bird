/**
 * ============================================================================
 *  piece.js — batching, instancing and collision bookkeeping.
 * ============================================================================
 *  Two ideas only:
 *
 *  1. `Piece` — a bag of (materialName -> geometry) parts in local space. Every
 *     kit function and every prop returns one. Pieces compose: you can stamp a
 *     Piece into another Piece with a transform.
 *
 *  2. `WorldBuilder` — the world accumulator. You `place()` Pieces into it with
 *     a matrix; it sorts their parts into per-material buckets and, at
 *     `finish()`, merges each bucket into exactly one Mesh. That is where the
 *     draw-call budget is won: ~40 architectural draw calls instead of 4000.
 *
 *  Collision is declared separately and explicitly, as oriented boxes, so the
 *  physics BVH is a clean convex-ish soup rather than a bevelled 400k-tri mess.
 *  Each collision box remembers its material name so Physics.surfaceOf() still
 *  returns 'wood' when you shoot a crate.
 * ============================================================================
 */

import * as THREE from 'three';
import { mergeGeometries } from 'three/examples/jsm/utils/BufferGeometryUtils.js';
import { chamferBox, normalizeGeometry } from './chamfer.js';

const _m = new THREE.Matrix4();
const _v = new THREE.Vector3();
const _q = new THREE.Quaternion();
const _s = new THREE.Vector3();

/* -------------------------------------------------------------------------- */

export class Piece {
  constructor() {
    /** @type {{mat:string, geo:THREE.BufferGeometry, decor?:boolean}[]} */
    this.parts = [];
    /** Oriented collision boxes in local space: {c:[x,y,z], h:[hx,hy,hz], ry, mat} */
    this.solids = [];
    /** Points other passes may hang things off (lamp heads, cable anchors...) */
    this.anchors = {};
  }

  /**
   * @param {string} mat material name from the Materials catalogue.
   *
   * Stock three geometries (Plane/Torus/Sphere) carry no `color` attribute, and
   * mergeGeometries refuses to mix attribute sets. Normalising here means prop
   * authors can drop a TorusGeometry straight in and it just works.
   */
  add(mat, geo, decor = false) {
    if (!geo) return this;
    if (!geo.attributes.color) normalizeGeometry(geo, { uvScale: geo.attributes.uv ? 0 : 1 });
    this.parts.push({ mat, geo, decor });
    return this;
  }

  /** Declare a solid box (local space, axis-aligned unless ry given). */
  solid(cx, cy, cz, hx, hy, hz, mat = 'concrete', ry = 0) {
    this.solids.push({ c: [cx, cy, cz], h: [hx, hy, hz], ry, mat });
    return this;
  }

  /** Convenience: chamfered box visual + matching collision in one call. */
  box(mat, w, h, d, x, y, z, opts = {}) {
    const g = chamferBox(w, h, d, opts);
    if (opts.ry) g.rotateY(opts.ry);
    g.translate(x, y, z);
    this.add(mat, g, opts.decor);
    if (opts.solid !== false) this.solid(x, y, z, w * 0.5, h * 0.5, d * 0.5, opts.collideMat || mat, opts.ry || 0);
    return this;
  }

  /** Stamp another Piece into this one, transformed. */
  stamp(other, matrix) {
    for (const p of other.parts) {
      const g = p.geo.clone();
      if (matrix) g.applyMatrix4(matrix);
      this.parts.push({ mat: p.mat, geo: g, decor: p.decor });
    }
    for (const s of other.solids) {
      if (!matrix) { this.solids.push({ c: s.c.slice(), h: s.h.slice(), ry: s.ry, mat: s.mat }); continue; }
      _v.set(s.c[0], s.c[1], s.c[2]).applyMatrix4(matrix);
      matrix.decompose(_s, _q, _s);
      const e = new THREE.Euler().setFromQuaternion(_q, 'YXZ');
      matrix.decompose(new THREE.Vector3(), new THREE.Quaternion(), _s);
      this.solids.push({
        c: [_v.x, _v.y, _v.z],
        h: [s.h[0] * Math.abs(_s.x), s.h[1] * Math.abs(_s.y), s.h[2] * Math.abs(_s.z)],
        ry: s.ry + e.y,
        mat: s.mat,
      });
    }
    return this;
  }

  transform(matrix) {
    for (const p of this.parts) p.geo.applyMatrix4(matrix);
    for (const s of this.solids) {
      _v.set(s.c[0], s.c[1], s.c[2]).applyMatrix4(matrix);
      s.c[0] = _v.x; s.c[1] = _v.y; s.c[2] = _v.z;
    }
    return this;
  }

  translate(x, y, z) {
    for (const p of this.parts) p.geo.translate(x, y, z);
    for (const s of this.solids) { s.c[0] += x; s.c[1] += y; s.c[2] += z; }
    return this;
  }

  /** Merge parts sharing a material — required before instancing. */
  compact() {
    const byMat = new Map();
    for (const p of this.parts) {
      if (!byMat.has(p.mat)) byMat.set(p.mat, []);
      byMat.get(p.mat).push(p.geo);
    }
    this.parts = [];
    for (const [mat, list] of byMat) {
      this.parts.push({ mat, geo: list.length === 1 ? list[0] : mergeGeometries(list, false) });
    }
    return this;
  }

  triangleCount() {
    let n = 0;
    for (const p of this.parts) n += (p.geo.index ? p.geo.index.count : p.geo.attributes.position.count) / 3;
    return n;
  }

  bounds(out = new THREE.Box3()) {
    out.makeEmpty();
    for (const p of this.parts) {
      p.geo.computeBoundingBox();
      out.union(p.geo.boundingBox);
    }
    return out;
  }
}

/* -------------------------------------------------------------------------- */

/**
 * A prop template that will be stamped many times. If it appears more than
 * INSTANCE_THRESHOLD times the builder promotes it to InstancedMesh
 * automatically (ART_DIRECTION §6 / requirement 4).
 */
export const INSTANCE_THRESHOLD = 8;

export class WorldBuilder {
  /**
   * @param {(name:string)=>THREE.Material} matResolver
   */
  constructor(matResolver, rng) {
    this.matResolver = matResolver;
    this.rng = rng || Math.random;
    /** merged static geometry buckets: matName -> geo[] */
    this.buckets = new Map();
    /** decorative (non-shadow-casting-heavy) buckets */
    this.decorBuckets = new Map();
    /** instance groups: key -> { piece, mats:Matrix4[], tints:Color[] } */
    this.instances = new Map();
    /** collision boxes: {c,h,ry,mat} in world space */
    this.solids = [];
    this.stats = { tris: 0, drawCalls: 0, instances: 0 };
  }

  /** Raw geometry, already in world space. */
  push(mat, geo, decor = false) {
    const map = decor ? this.decorBuckets : this.buckets;
    if (!map.has(mat)) map.set(mat, []);
    map.get(mat).push(geo);
  }

  /** Place a Piece into the world (geometry is cloned, so templates are reusable). */
  place(piece, matrix, opts = {}) {
    const collide = opts.collide !== false;
    for (const p of piece.parts) {
      const g = p.geo.clone();
      if (matrix) g.applyMatrix4(matrix);
      this.push(p.mat, g, p.decor || opts.decor);
    }
    if (collide) this.placeSolids(piece, matrix);
  }

  placeSolids(piece, matrix) {
    let ry = 0, sx = 1, sy = 1, sz = 1;
    if (matrix) {
      matrix.decompose(_v, _q, _s);
      ry = new THREE.Euler().setFromQuaternion(_q, 'YXZ').y;
      sx = Math.abs(_s.x); sy = Math.abs(_s.y); sz = Math.abs(_s.z);
    }
    for (const s of piece.solids) {
      _v.set(s.c[0], s.c[1], s.c[2]);
      if (matrix) _v.applyMatrix4(matrix);
      this.solids.push({
        c: [_v.x, _v.y, _v.z],
        h: [s.h[0] * sx, s.h[1] * sy, s.h[2] * sz],
        ry: s.ry + ry,
        mat: s.mat,
      });
    }
  }

  /** Declare a world-space collision box with no visual. */
  solid(cx, cy, cz, hx, hy, hz, mat = 'concrete', ry = 0) {
    this.solids.push({ c: [cx, cy, cz], h: [hx, hy, hz], ry, mat });
  }

  /**
   * Register a repeated prop. `key` identifies the template; the first call
   * supplies the Piece. Transform + per-instance tint are stored; the builder
   * decides at finish() whether to instance or merge.
   *
   * @param {string} key
   * @param {()=>Piece} makePiece  lazily built once
   * @param {THREE.Matrix4} matrix
   * @param {object} opts { tint:number(0..1 jitter), collide:boolean }
   */
  instance(key, makePiece, matrix, opts = {}) {
    let grp = this.instances.get(key);
    if (!grp) {
      const piece = makePiece();
      piece.compact();
      grp = { piece, mats: [], tints: [], collide: opts.collide !== false, decor: !!opts.decor };
      this.instances.set(key, grp);
    }
    grp.mats.push(matrix.clone());
    const j = opts.tint === undefined ? 0.06 : opts.tint;
    const r = this.rng, base = 1 - j * 0.5;
    grp.tints.push(new THREE.Color(
      base + r() * j, base + r() * j * 0.92, base + r() * j * 0.86,
    ));
    if (grp.collide) this.placeSolids(grp.piece, matrix);
  }

  /**
   * Merge every bucket into one mesh per material, promote instance groups,
   * and return { meshes, instancedMeshes }.
   */
  finish(name = 'level') {
    const out = new THREE.Group();
    out.name = name;
    const merged = [];

    const flush = (map, decor) => {
      for (const [mat, list] of map) {
        if (!list.length) continue;
        let geo;
        try {
          geo = list.length === 1 ? list[0] : mergeGeometries(list, false);
        } catch (e) {
          console.warn('[Level] merge failed for material', mat, e);
          continue;
        }
        if (!geo) continue;
        geo.computeBoundingSphere();
        const mesh = new THREE.Mesh(geo, this.matResolver(mat));
        mesh.name = `${name}:${mat}${decor ? ':decor' : ''}`;
        mesh.castShadow = !decor;
        mesh.receiveShadow = true;
        mesh.matrixAutoUpdate = false;
        mesh.updateMatrix();
        mesh.userData.matName = mat;
        out.add(mesh);
        merged.push(mesh);
        this.stats.tris += (geo.index ? geo.index.count : geo.attributes.position.count) / 3;
        this.stats.drawCalls++;
      }
      map.clear();
    };

    flush(this.buckets, false);
    flush(this.decorBuckets, true);

    const instanced = [];
    for (const [key, grp] of this.instances) {
      const n = grp.mats.length;
      if (n === 0) continue;
      if (n < INSTANCE_THRESHOLD) {
        // Cheaper to just bake it into the merged soup.
        for (let i = 0; i < n; i++) {
          for (const p of grp.piece.parts) {
            const g = p.geo.clone();
            g.applyMatrix4(grp.mats[i]);
            tintGeometry(g, grp.tints[i]);
            this.push(p.mat, g, grp.decor || p.decor);
          }
        }
        continue;
      }
      for (const p of grp.piece.parts) {
        const im = new THREE.InstancedMesh(p.geo, this.matResolver(p.mat), n);
        im.name = `inst:${key}:${p.mat}`;
        im.castShadow = !(grp.decor || p.decor);
        im.receiveShadow = true;
        im.instanceMatrix.setUsage(THREE.StaticDrawUsage);
        for (let i = 0; i < n; i++) {
          im.setMatrixAt(i, grp.mats[i]);
          im.setColorAt(i, grp.tints[i]);
        }
        im.instanceMatrix.needsUpdate = true;
        if (im.instanceColor) im.instanceColor.needsUpdate = true;
        im.frustumCulled = true;
        im.computeBoundingSphere();
        out.add(im);
        instanced.push(im);
        this.stats.tris += ((p.geo.index ? p.geo.index.count : p.geo.attributes.position.count) / 3) * n;
        this.stats.drawCalls++;
        this.stats.instances += n;
      }
    }
    this.instances.clear();
    // Anything demoted from instancing above landed back in the buckets.
    flush(this.buckets, false);
    flush(this.decorBuckets, true);

    return { group: out, meshes: merged, instanced };
  }

  /**
   * Build the collision proxy: one invisible merged mesh per material family.
   * Plain (unchamfered) boxes — 12 tris each — keeps the BVH tight and fast.
   */
  buildColliders() {
    const byMat = new Map();
    for (const s of this.solids) {
      if (s.h[0] <= 0.001 || s.h[1] <= 0.001 || s.h[2] <= 0.001) continue;
      const g = new THREE.BoxGeometry(s.h[0] * 2, s.h[1] * 2, s.h[2] * 2);
      g.deleteAttribute('uv');
      g.deleteAttribute('normal');
      if (s.ry) g.rotateY(s.ry);
      g.translate(s.c[0], s.c[1], s.c[2]);
      if (!byMat.has(s.mat)) byMat.set(s.mat, []);
      byMat.get(s.mat).push(g);
    }
    const group = new THREE.Group();
    group.name = 'collision';
    group.visible = false;
    const meshes = [];
    for (const [mat, list] of byMat) {
      const geo = list.length === 1 ? list[0] : mergeGeometries(list, false);
      if (!geo) continue;
      const mesh = new THREE.Mesh(geo, this.matResolver(mat));
      mesh.name = `collide:${mat}`;
      mesh.visible = false;
      mesh.matrixAutoUpdate = false;
      mesh.updateMatrix();
      mesh.userData.matName = mat;
      mesh.userData.collisionProxy = true;
      group.add(mesh);
      meshes.push(mesh);
    }
    return { group, meshes };
  }
}

/* -------------------------------------------------------------------------- */

/** Multiply a geometry's vertex colours by a tint (used when demoting instances). */
export function tintGeometry(geo, color) {
  const c = geo.attributes.color;
  if (!c) return geo;
  for (let i = 0; i < c.count; i++) {
    c.setXYZ(i, c.getX(i) * color.r, c.getY(i) * color.g, c.getZ(i) * color.b);
  }
  c.needsUpdate = true;
  return geo;
}

/** Fast transform builder — avoids allocating Euler/Quaternion per call. */
export function trs(x, y, z, ry = 0, sx = 1, sy = sx, sz = sx, rx = 0, rz = 0) {
  _q.setFromEuler(new THREE.Euler(rx, ry, rz, 'YXZ'));
  return new THREE.Matrix4().compose(
    _v.set(x, y, z), _q, _s.set(sx, sy, sz),
  );
}

export { _m as _scratchMatrix };
