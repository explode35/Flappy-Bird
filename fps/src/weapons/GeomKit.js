/**
 * GeomKit — procedural geometry primitives for weapon construction.
 *
 * Convention used by every weapon built with this kit:
 *   +X = shooter's right, +Y = up, -Z = muzzle direction (matches THREE camera).
 *   The bore axis lies on y = 0, z = 0 is the middle of the receiver.
 *
 * Everything here returns a *non-indexed* BufferGeometry with position/normal/uv
 * so that any set of parts can be merged with mergeGeometries() regardless of
 * which primitive produced it.
 */
import * as THREE from 'three';
import { RoundedBoxGeometry } from 'three/examples/jsm/geometries/RoundedBoxGeometry.js';
import { mergeGeometries } from 'three/examples/jsm/utils/BufferGeometryUtils.js';

const _m4 = new THREE.Matrix4();
const _e = new THREE.Euler();
const _q = new THREE.Quaternion();

/** Force a geometry into the merge-compatible shape (non-indexed, pos/nrm/uv). */
export function normalize(geo) {
  if (geo.index) geo = geo.toNonIndexed();
  if (!geo.attributes.uv) {
    const n = geo.attributes.position.count;
    geo.setAttribute('uv', new THREE.BufferAttribute(new Float32Array(n * 2), 2));
  }
  // Drop anything else so merges never fail on attribute mismatch.
  for (const k of Object.keys(geo.attributes)) {
    if (k !== 'position' && k !== 'normal' && k !== 'uv') geo.deleteAttribute(k);
  }
  if (!geo.attributes.normal) geo.computeVertexNormals();
  geo.clearGroups();
  return geo;
}

export function triCount(geo) {
  return geo.index ? geo.index.count / 3 : geo.attributes.position.count / 3;
}

/**
 * Apply a full TRS to a geometry in place. Rotation is XYZ euler in radians.
 * Returns the geometry so calls chain.
 */
export function place(geo, x = 0, y = 0, z = 0, rx = 0, ry = 0, rz = 0, sx = 1, sy = 1, sz = 1) {
  _e.set(rx, ry, rz, 'XYZ');
  _q.setFromEuler(_e);
  _m4.compose(new THREE.Vector3(x, y, z), _q, new THREE.Vector3(sx, sy, sz));
  geo.applyMatrix4(_m4);
  return geo;
}

/* ---------------------------------------------------------------------- */
/* Boxes                                                                   */
/* ---------------------------------------------------------------------- */

/** Bevelled box. `r` is the chamfer radius, `seg` the chamfer subdivision. */
export function box(w, h, d, r = 0.0022, seg = 2) {
  const rr = Math.min(r, w * 0.49, h * 0.49, d * 0.49);
  return normalize(new RoundedBoxGeometry(w, h, d, seg, rr));
}

/** Cheap non-bevelled box for internals that are never seen up close. */
export function plainBox(w, h, d) {
  return normalize(new THREE.BoxGeometry(w, h, d));
}

/**
 * Tapered box (a frustum) — front face size differs from back face size.
 * Built from an extruded quad so it keeps hard, believable machined edges.
 */
export function taperBox(wBack, hBack, wFront, hFront, d) {
  const g = new THREE.BufferGeometry();
  const hb = d * 0.5;
  const a = [
    [-wBack / 2, -hBack / 2, hb], [wBack / 2, -hBack / 2, hb],
    [wBack / 2, hBack / 2, hb], [-wBack / 2, hBack / 2, hb],
    [-wFront / 2, -hFront / 2, -hb], [wFront / 2, -hFront / 2, -hb],
    [wFront / 2, hFront / 2, -hb], [-wFront / 2, hFront / 2, -hb],
  ];
  const faces = [
    [0, 1, 2, 3], [5, 4, 7, 6], [1, 5, 6, 2], [4, 0, 3, 7], [3, 2, 6, 7], [4, 5, 1, 0],
  ];
  const pos = [];
  for (const f of faces) {
    const [p0, p1, p2, p3] = f.map((i) => a[i]);
    pos.push(...p0, ...p1, ...p2, ...p0, ...p2, ...p3);
  }
  g.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
  g.computeVertexNormals();
  return normalize(g);
}

/* ---------------------------------------------------------------------- */
/* Rotational solids — all aligned so their length runs along Z            */
/* ---------------------------------------------------------------------- */

/** Cylinder with its axis on Z. rF = radius at the -Z (front) end. */
export function cyl(rF, rB, len, seg = 16, open = false) {
  const g = new THREE.CylinderGeometry(rF, rB, len, seg, 1, open);
  g.rotateX(-Math.PI / 2);
  return normalize(g);
}

/** Cylinder with its axis on Y (grips, pins, buttons). */
export function cylY(rT, rB, len, seg = 14, open = false) {
  return normalize(new THREE.CylinderGeometry(rT, rB, len, seg, 1, open));
}

/** Cylinder with its axis on X (pins, takedown lugs, rollers). */
export function cylX(rT, rB, len, seg = 12, open = false) {
  const g = new THREE.CylinderGeometry(rT, rB, len, seg, 1, open);
  g.rotateZ(Math.PI / 2);
  return normalize(g);
}

export function sphere(r, w = 14, h = 10) {
  return normalize(new THREE.SphereGeometry(r, w, h));
}

export function torusZ(r, tube, radial = 8, tubular = 18, arc = Math.PI * 2) {
  const g = new THREE.TorusGeometry(r, tube, radial, tubular, arc);
  return normalize(g);
}

/**
 * Solid of revolution about the Z axis.
 * `profile` is [[radius, z], ...] running from the back (+z) to the front (-z).
 */
export function lathe(profile, seg = 20) {
  const pts = profile.map((p) => new THREE.Vector2(Math.max(p[0], 1e-5), p[1]));
  const g = new THREE.LatheGeometry(pts, seg);
  // LatheGeometry revolves around +Y; map +Y onto -Z (forward).
  g.rotateX(Math.PI / 2);
  return normalize(g);
}

/**
 * Hollow tube along Z with real wall thickness and visible annular ends.
 * Used for optic bodies, handguard shells, suppressor cans, barrel bores.
 */
export function tube(rOuter, rInner, len, seg = 22) {
  const z0 = len * 0.5, z1 = -len * 0.5;
  return lathe([
    [rInner, z0], [rOuter, z0], [rOuter, z1], [rInner, z1], [rInner, z0],
  ], seg);
}

/* ---------------------------------------------------------------------- */
/* Shapes and extrusions                                                   */
/* ---------------------------------------------------------------------- */

export function roundedRectPath(w, h, r, cx = 0, cy = 0) {
  const s = new THREE.Shape();
  const x = cx - w / 2, y = cy - h / 2;
  r = Math.min(r, w * 0.5, h * 0.5);
  s.moveTo(x + r, y);
  s.lineTo(x + w - r, y);
  s.quadraticCurveTo(x + w, y, x + w, y + r);
  s.lineTo(x + w, y + h - r);
  s.quadraticCurveTo(x + w, y + h, x + w - r, y + h);
  s.lineTo(x + r, y + h);
  s.quadraticCurveTo(x, y + h, x, y + h - r);
  s.lineTo(x, y + r);
  s.quadraticCurveTo(x, y, x + r, y);
  return s;
}

export function roundedHole(w, h, r, cx, cy) {
  const p = new THREE.Path();
  const s = roundedRectPath(w, h, r, cx, cy);
  p.curves = s.curves;
  return p;
}

/** Extrude a Shape along Z, centred on z = 0. */
export function extrude(shape, depth, bevel = 0.0012, bevelSeg = 1, curveSeg = 6) {
  const g = new THREE.ExtrudeGeometry(shape, {
    depth,
    bevelEnabled: bevel > 0,
    bevelThickness: bevel,
    bevelSize: bevel,
    bevelSegments: bevelSeg,
    curveSegments: curveSeg,
    steps: 1,
  });
  g.translate(0, 0, -depth * 0.5);
  return normalize(g);
}

/**
 * A flat plate pierced by a row of real slots (extruded Shape with holes).
 * Plate spans `len` on Z and `wid` on X, `thick` on Y; slots run across X.
 * This is how handguard venting and M-LOK panels are built — genuine holes,
 * not painted-on lines.
 */
export function slottedPlate(len, wid, thick, count, slotLen, slotWid, edgeR = 0.0015) {
  const shape = roundedRectPath(len, wid, edgeR);
  const pitch = len / count;
  for (let i = 0; i < count; i++) {
    const cx = -len / 2 + pitch * (i + 0.5);
    shape.holes.push(roundedHole(slotLen, slotWid, Math.min(slotWid * 0.45, 0.0025), cx, 0));
  }
  // Shape lives in XY; extrude on Z then rotate so thickness ends up on Y.
  const g = extrude(shape, thick, 0.0008, 1, 4);
  g.rotateX(-Math.PI / 2);      // plate XY -> XZ, thickness on Y
  g.rotateY(-Math.PI / 2);      // shape's X (len) onto Z
  return normalize(g);
}

/**
 * Picatinny rail section running along Z: a continuous dovetail base plus
 * individually modelled cross-teeth, so the recoil slots are real gaps.
 */
export function picatinny(len, scale = 1, bevel = 0.0006) {
  const S = scale;
  const pts = [
    [-0.0078 * S, 0], [0.0078 * S, 0], [0.0078 * S, 0.0032 * S],
    [0.0106 * S, 0.0055 * S], [0.0092 * S, 0.0070 * S],
    [-0.0092 * S, 0.0070 * S], [-0.0106 * S, 0.0055 * S], [-0.0078 * S, 0.0032 * S],
  ];
  const shape = new THREE.Shape();
  shape.moveTo(pts[0][0], pts[0][1]);
  for (let i = 1; i < pts.length; i++) shape.lineTo(pts[i][0], pts[i][1]);
  shape.closePath();

  const baseShape = roundedRectPath(0.0156 * S, 0.0032 * S, 0.0004, 0, 0.0016 * S);

  const parts = [];
  const pitch = 0.0100 * S;
  const tooth = 0.0055 * S;
  const n = Math.max(1, Math.floor(len / pitch));
  const used = n * pitch;
  for (let i = 0; i < n; i++) {
    const z = -used / 2 + pitch * (i + 0.5);
    const g = extrude(shape, tooth, bevel, 1, 1);
    g.translate(0, 0, z);
    parts.push(g);
  }
  const base = extrude(baseShape, used, bevel, 1, 1);
  parts.push(base);
  const merged = mergeGeometries(parts, false);
  for (const p of parts) p.dispose();
  return normalize(merged);
}

/**
 * Knurled / stippled ring — a band of raised pyramids. Used on grips,
 * charging-handle latches and adjustment knobs.
 */
export function knurlBand(radius, len, rows, cols, depth, axis = 'z') {
  const parts = [];
  for (let r = 0; r < rows; r++) {
    const z = -len / 2 + (len / rows) * (r + 0.5);
    for (let c = 0; c < cols; c++) {
      const a = (c / cols) * Math.PI * 2 + (r % 2) * (Math.PI / cols);
      const g = new THREE.ConeGeometry(depth * 1.5, depth, 4, 1);
      g.rotateX(Math.PI / 2);
      g.rotateY(a + Math.PI / 2);
      const gg = normalize(g);
      gg.translate(Math.cos(a) * radius, Math.sin(a) * radius, z);
      parts.push(gg);
    }
  }
  const m = mergeGeometries(parts, false);
  for (const p of parts) p.dispose();
  if (axis === 'y') m.rotateX(Math.PI / 2);
  return normalize(m);
}

/** A grid of small pyramids on a flat XZ patch — polymer grip stippling. */
export function stipplePatch(w, d, nx, nz, h) {
  const parts = [];
  for (let i = 0; i < nx; i++) {
    for (let j = 0; j < nz; j++) {
      const g = new THREE.ConeGeometry(h * 1.25, h, 4, 1);
      const gg = normalize(g);
      gg.translate(-w / 2 + (w / nx) * (i + 0.5), 0, -d / 2 + (d / nz) * (j + 0.5));
      parts.push(gg);
    }
  }
  const m = mergeGeometries(parts, false);
  for (const p of parts) p.dispose();
  return normalize(m);
}

/** Screw / pin head with a slot, facing +X by default. */
export function screwX(r, len) {
  const parts = [];
  const head = cylX(r, r, len, 10);
  parts.push(head);
  const slot = plainBox(len * 0.5, r * 0.35, r * 1.7);
  slot.translate(len * 0.32, 0, 0);
  parts.push(slot);
  const m = mergeGeometries(parts, false);
  for (const p of parts) p.dispose();
  return normalize(m);
}

/* ---------------------------------------------------------------------- */
/* Part accumulation                                                       */
/* ---------------------------------------------------------------------- */

/**
 * Collects geometries into per-material buckets and merges each bucket into a
 * single mesh. Static weapon detail becomes 3–5 draw calls; anything that has
 * to animate is built as its own PartSet into its own node.
 */
export class PartSet {
  constructor() {
    this.buckets = new Map();
    this.tris = 0;
  }

  /** @param {THREE.BufferGeometry} geo @param {string} mat material key */
  add(geo, mat = 'metal') {
    if (!geo) return geo;
    normalize(geo);
    let a = this.buckets.get(mat);
    if (!a) { a = []; this.buckets.set(mat, a); }
    a.push(geo);
    this.tris += triCount(geo);
    return geo;
  }

  /** Convenience: add many geometries with one material. */
  addAll(list, mat) { for (const g of list) this.add(g, mat); return this; }

  /** Merge and attach to `parent`. Returns the triangle count added. */
  build(parent, mats, name = 'part') {
    for (const [key, list] of this.buckets) {
      let merged;
      if (list.length === 1) merged = list[0];
      else {
        merged = mergeGeometries(list, false);
        for (const g of list) g.dispose();
      }
      if (!merged) continue;
      merged.computeBoundingSphere();
      const mesh = new THREE.Mesh(merged, mats[key] || mats.metal);
      mesh.name = `${name}:${key}`;
      mesh.frustumCulled = false;
      mesh.castShadow = false;
      mesh.receiveShadow = false;
      mesh.matrixAutoUpdate = false;
      mesh.updateMatrix();
      parent.add(mesh);
    }
    this.buckets.clear();
    return this.tris;
  }
}

/** Count triangles under an Object3D — used for the build-time budget report. */
export function countTris(root) {
  let n = 0;
  root.traverse((o) => { if (o.isMesh && o.geometry) n += triCount(o.geometry); });
  return n;
}
