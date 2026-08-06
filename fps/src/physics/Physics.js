import * as THREE from 'three';
import * as BufferGeometryUtils from 'three/examples/jsm/utils/BufferGeometryUtils.js';
import { MeshBVH, SAH } from 'three-mesh-bvh';

/**
 * Collision and queries.
 *
 * The whole static world is merged into one geometry with a single BVH — one
 * tree beats N per-mesh raycasts by a wide margin, and the AI fires a lot of
 * rays. A parallel per-triangle surface table lets raycast() report what was
 * actually hit so impact FX and audio can respond correctly.
 *
 * Enemy hitboxes are analytic spheres rather than meshes: far cheaper, and
 * they can follow animated bones without rebuilding anything.
 *
 * See src/core/Contracts.js for the frozen public API.
 */

const SLOPE_LIMIT = Math.cos(THREE.MathUtils.degToRad(46));
const STEP_HEIGHT = 0.42;
const SNAP_DOWN = 0.5;
const DEPEN_ITERS = 4;
const SKIN = 0.002;

// --- scratch: nothing in the hot path allocates ------------------------------
const _tri = new THREE.Triangle();
const _v0 = new THREE.Vector3(), _v1 = new THREE.Vector3(), _v2 = new THREE.Vector3();
const _pt = new THREE.Vector3(), _pt2 = new THREE.Vector3();
const _n = new THREE.Vector3(), _n2 = new THREE.Vector3();
const _delta = new THREE.Vector3(), _rem = new THREE.Vector3();
const _seg = new THREE.Line3();
const _box = new THREE.Box3();
const _cap = { start: new THREE.Vector3(), end: new THREE.Vector3(), radius: 0.32 };
const _capSave = { start: new THREE.Vector3(), end: new THREE.Vector3(), radius: 0.32 };
const _ray = new THREE.Ray();
const _mat = new THREE.Matrix4();
const _crease = new THREE.Vector3();
const _tmp = new THREE.Vector3();
const _hitOut = {
  point: new THREE.Vector3(), normal: new THREE.Vector3(), distance: 0,
  object: null, surface: 'concrete', isEnemy: false, enemy: null, bone: null, damageMul: 1,
};
const _moveOut = { grounded: false, groundNormal: new THREE.Vector3(0, 1, 0), hitWall: false, steppedUp: false };

export class Physics {
  constructor(ctx) {
    this.ctx = ctx;
    this.statics = [];
    this.bvh = null;
    this.geometry = null;
    this.surfaceRanges = [];   // { start, count, surface, object }
    this.triSurface = null;    // Uint8Array per-triangle surface index
    this.surfaceNames = [];
    this.enemies = [];         // { enemy, boxes: [{obj, bone, mul, center, radius}] }
    this.debug = false;
    this.stats = { rays: 0, moves: 0 };
    this._collector = [];
  }

  async init() { /* nothing to load */ }

  // -------------------------------------------------------------------------
  //  World registration
  // -------------------------------------------------------------------------

  addStatic(object3D) {
    if (!object3D) return;
    object3D.updateWorldMatrix(true, true);
    object3D.traverse((o) => {
      if ((o.isMesh || o.isInstancedMesh) && o.geometry) this.statics.push(o);
    });
  }

  build() {
    if (this.bvh) return;              // idempotent: Level builds it early
    if (!this.statics.length) {
      console.warn('[physics] no static geometry registered');
      return;
    }
    const materials = this.ctx.materials;
    const geos = [];
    const ranges = [];
    let triCursor = 0;

    for (const mesh of this.statics) {
      mesh.updateWorldMatrix(true, false);
      const surface = materials?.surfaceOf?.(mesh.material) ?? 'concrete';
      let si = this.surfaceNames.indexOf(surface);
      if (si < 0) { si = this.surfaceNames.length; this.surfaceNames.push(surface); }

      // InstancedMesh: bake every instance into world space so one BVH covers all.
      const instances = mesh.isInstancedMesh ? mesh.count : 1;
      for (let i = 0; i < instances; i++) {
        const g = mesh.geometry.index ? mesh.geometry.toNonIndexed() : mesh.geometry.clone();
        // Strip everything but position — the BVH does not need UVs or colours,
        // and mismatched attribute sets make mergeGeometries fail.
        for (const name of Object.keys(g.attributes)) if (name !== 'position') g.deleteAttribute(name);
        if (mesh.isInstancedMesh) {
          mesh.getMatrixAt(i, _mat);
          _mat.premultiply(mesh.matrixWorld);
          g.applyMatrix4(_mat);
        } else {
          g.applyMatrix4(mesh.matrixWorld);
        }
        const triCount = g.attributes.position.count / 3;
        ranges.push({ start: triCursor, count: triCount, surfaceIndex: si, object: mesh });
        triCursor += triCount;
        geos.push(g);
      }
    }

    const merged = BufferGeometryUtils.mergeGeometries(geos, false);
    for (const g of geos) g.dispose();
    if (!merged) { console.error('[physics] merge failed'); return; }

    this.geometry = merged;
    this.bvh = new MeshBVH(merged, { strategy: SAH, targetLeafSize: 8 });
    merged.boundsTree = this.bvh;

    // Flatten the ranges into a per-triangle lookup — O(1) at query time.
    this.triSurface = new Uint8Array(triCursor);
    this.triObject = new Array(triCursor);
    for (const r of ranges) {
      for (let t = r.start; t < r.start + r.count; t++) {
        this.triSurface[t] = r.surfaceIndex;
        this.triObject[t] = r.object;
      }
    }
    this.surfaceRanges = ranges;
    this.collider = new THREE.Mesh(merged, new THREE.MeshBasicMaterial());
    this.collider.matrixAutoUpdate = false;

    console.log(`[physics] BVH: ${triCursor} tris from ${this.statics.length} meshes, ${this.surfaceNames.length} surfaces`);
  }

  // -------------------------------------------------------------------------
  //  Rays
  // -------------------------------------------------------------------------

  /**
   * @returns {object|null} shared Hit object — copy anything you keep.
   */
  raycast(origin, dir, maxDist = 500, opt) {
    this.stats.rays++;
    let best = null;
    let bestDist = maxDist;

    if (!opt?.skipWorld && this.bvh) {
      _ray.origin.copy(origin);
      _ray.direction.copy(dir).normalize();
      _ray.far = maxDist;
      const hit = this.bvh.raycastFirst(_ray, THREE.FrontSide);
      if (hit && hit.distance <= bestDist) {
        bestDist = hit.distance;
        _hitOut.point.copy(hit.point);
        _hitOut.normal.copy(hit.face.normal);
        _hitOut.distance = hit.distance;
        const tri = hit.faceIndex;
        _hitOut.object = this.triObject?.[tri] ?? null;
        _hitOut.surface = this.surfaceNames[this.triSurface?.[tri] ?? 0] || 'concrete';
        _hitOut.isEnemy = false;
        _hitOut.enemy = null;
        _hitOut.bone = null;
        _hitOut.damageMul = 1;
        best = _hitOut;
      }
    }

    if (!opt?.skipEnemies && this.enemies.length) {
      const eh = this._raycastEnemies(origin, dir, bestDist, opt);
      if (eh) best = eh;
    }
    return best;
  }

  _raycastEnemies(origin, dir, maxDist, opt) {
    let found = null;
    let bestT = maxDist;
    for (let e = 0; e < this.enemies.length; e++) {
      const rec = this.enemies[e];
      if (rec.enemy?.dead && rec.enemy?.noHitWhenDead) continue;
      if (opt?.ignore && opt.ignore.includes(rec.enemy)) continue;
      for (let b = 0; b < rec.boxes.length; b++) {
        const hb = rec.boxes[b];
        // Ray/sphere: the analytic form, no allocation.
        _tmp.subVectors(hb.center, origin);
        const tca = _tmp.dot(dir);
        if (tca < 0) continue;
        const d2 = _tmp.lengthSq() - tca * tca;
        const r2 = hb.radius * hb.radius;
        if (d2 > r2) continue;
        const thc = Math.sqrt(r2 - d2);
        const t = tca - thc;
        if (t < 0 || t >= bestT) continue;
        bestT = t;
        found = hb;
      }
    }
    if (!found) return null;
    _hitOut.distance = bestT;
    _hitOut.point.copy(origin).addScaledVector(dir, bestT);
    _hitOut.normal.subVectors(_hitOut.point, found.center).normalize();
    _hitOut.object = found.obj;
    _hitOut.surface = 'flesh';
    _hitOut.isEnemy = true;
    _hitOut.enemy = found.enemy;
    _hitOut.bone = found.bone;
    _hitOut.damageMul = found.mul;
    return _hitOut;
  }

  /** World-only visibility test. */
  lineOfSight(a, b) {
    if (!this.bvh) return true;
    _tmp.subVectors(b, a);
    const dist = _tmp.length();
    if (dist < 1e-4) return true;
    _tmp.multiplyScalar(1 / dist);
    _ray.origin.copy(a);
    _ray.direction.copy(_tmp);
    _ray.far = dist - 0.05;
    return !this.bvh.raycastFirst(_ray, THREE.FrontSide);
  }

  /** Downward probe used for prop placement and AI foot IK. */
  groundHeightAt(x, z, from = 60) {
    _tmp.set(x, from, z);
    _n.set(0, -1, 0);
    const hit = this.raycast(_tmp, _n, from + 60, { skipEnemies: true });
    return hit ? hit.point.y : 0;
  }

  // -------------------------------------------------------------------------
  //  Capsule movement
  // -------------------------------------------------------------------------

  /**
   * Slide-and-collide with step-up and ground snapping.
   * `capsule.start`/`end` are the sphere centres of the capsule, mutated in place.
   */
  moveCapsule(capsule, delta, out) {
    out = out || _moveOut;
    out.grounded = false;
    out.hitWall = false;
    out.steppedUp = false;
    out.groundNormal.set(0, 1, 0);
    this.stats.moves++;
    if (!this.bvh) { capsule.start.add(delta); capsule.end.add(delta); return out; }

    // Substep so a fast mover can't tunnel through thin geometry.
    const len = delta.length();
    const maxStep = capsule.radius * 0.4;
    const steps = len > maxStep ? Math.min(8, Math.ceil(len / maxStep)) : 1;
    _delta.copy(delta).multiplyScalar(1 / steps);

    const wantH = Math.hypot(_delta.x, _delta.z);

    for (let s = 0; s < steps; s++) {
      // Remember where we were, in case we need to retry the move stepped up.
      _capSave.start.copy(capsule.start);
      _capSave.end.copy(capsule.end);

      capsule.start.add(_delta);
      capsule.end.add(_delta);
      this._resolve(capsule, out);

      // Whether we were blocked is judged by how far we actually got, not by
      // the contact normal. Edge contacts produce diagonal normals that are
      // neither "ground" nor "wall", and a normal-based test misses them —
      // which is exactly the case you hit walking into a stair riser.
      if (wantH > 1e-5) {
        const gotH = Math.hypot(
          capsule.start.x - _capSave.start.x,
          capsule.start.z - _capSave.start.z
        );
        if (gotH < wantH * 0.72) {
          const climbed = this._tryStepUp(_capSave, _delta, capsule, out);
          if (climbed) out.steppedUp = true;
          else out.hitWall = true;
        }
      }
    }

    if (out.grounded) this._snapDown(capsule, out);
    return out;
  }

  /**
   * Push the capsule out of anything it overlaps. Iterated, because resolving
   * one contact commonly creates another (inside corners especially).
   */
  _resolve(capsule, out) {
    const radius = capsule.radius;

    for (let iter = 0; iter < DEPEN_ITERS; iter++) {
      _box.makeEmpty();
      _box.expandByPoint(capsule.start);
      _box.expandByPoint(capsule.end);
      _box.min.addScalar(-radius);
      _box.max.addScalar(radius);

      _seg.start.copy(capsule.start);
      _seg.end.copy(capsule.end);
      let moved = false;
      let creaseCount = 0;
      _crease.set(0, 0, 0);

      this.bvh.shapecast({
        intersectsBounds: (bounds) => bounds.intersectsBox(_box),
        intersectsTriangle: (tri) => {
          // Closest points between the capsule segment and this triangle.
          const dist = tri.closestPointToSegment(_seg, _pt, _pt2);
          if (dist >= radius) return false;

          _n.subVectors(_pt2, _pt);
          const l = _n.length();
          if (l < 1e-8) {
            tri.getNormal(_n);
          } else {
            _n.multiplyScalar(1 / l);
          }
          const depth = radius - dist + SKIN;
          _seg.start.addScaledVector(_n, depth);
          _seg.end.addScaledVector(_n, depth);
          moved = true;

          if (_n.y > SLOPE_LIMIT) {
            out.grounded = true;
            if (_n.y > out.groundNormal.y || creaseCount === 0) out.groundNormal.copy(_n);
          } else if (_n.y < 0.6) {
            _crease.add(_n);
            creaseCount++;
          }
          return false;
        },
      });

      capsule.start.copy(_seg.start);
      capsule.end.copy(_seg.end);
      if (!moved) break;
    }
  }

  /**
   * Retry the blocked move from STEP_HEIGHT higher; if that clears, drop back
   * down onto the step. This is what makes stairs feel smooth instead of
   * bouncing the camera on every riser.
   */
  _tryStepUp(fromCap, delta, capsule, out) {
    _cap.radius = capsule.radius;
    _cap.start.copy(fromCap.start); _cap.start.y += STEP_HEIGHT;
    _cap.end.copy(fromCap.end);     _cap.end.y += STEP_HEIGHT;

    // Is the raised position itself free?
    if (this._overlaps(_cap)) return false;

    // Advance horizontally only — the vertical part of the move was already
    // consumed by lifting to STEP_HEIGHT.
    _cap.start.x += delta.x; _cap.start.z += delta.z;
    _cap.end.x += delta.x; _cap.end.z += delta.z;
    if (this._overlaps(_cap)) return false;

    // Drop back onto the step surface and land *flush*. A coarse scan followed
    // by a bisection: leaving even 3-4 cm of float here makes the camera dip
    // once per riser on the way up, which reads as stair jitter.
    const yFree0 = _cap.start.y;
    const landY = this._dropToSurface(_cap, STEP_HEIGHT + 0.06);
    if (landY === null) return false;
    _cap.start.y = landY;
    _cap.end.y = landY + (_capSave.end.y - _capSave.start.y);
    void yFree0;

    capsule.start.copy(_cap.start);
    capsule.end.copy(_cap.end);
    out.grounded = true;
    out.groundNormal.set(0, 1, 0);
    return true;
  }

  /**
   * Lower the capsule until it just touches something, and return the resting
   * `start.y`. Coarse 4 cm scan, then 5 bisection steps to land within ~1 mm.
   * Returns null if nothing was found within `maxDrop`.
   */
  _dropToSurface(cap, maxDrop) {
    const yTop = cap.start.y;
    const h = cap.end.y - cap.start.y;
    let yFree = yTop;
    let yHit = null;
    for (let d = 0.04; d <= maxDrop; d += 0.04) {
      cap.start.y = yTop - d; cap.end.y = cap.start.y + h;
      if (this._overlaps(cap)) { yHit = cap.start.y; break; }
      yFree = cap.start.y;
    }
    if (yHit === null) return null;
    for (let i = 0; i < 5; i++) {
      const mid = (yFree + yHit) * 0.5;
      cap.start.y = mid; cap.end.y = mid + h;
      if (this._overlaps(cap)) yHit = mid; else yFree = mid;
    }
    cap.start.y = yFree; cap.end.y = yFree + h;
    return yFree;
  }

  /** Keep the player glued to descending slopes and stairs. */
  _snapDown(capsule, out) {
    _cap.radius = capsule.radius;
    _cap.start.copy(capsule.start);
    _cap.end.copy(capsule.end);
    if (this._overlaps(_cap)) return;   // already touching, nothing to snap

    const landY = this._dropToSurface(_cap, SNAP_DOWN);
    if (landY === null) return;
    const h = capsule.end.y - capsule.start.y;
    capsule.start.y = landY;
    capsule.end.y = landY + h;
    out.grounded = true;
  }

  _overlaps(cap) {
    if (!this.bvh) return false;
    const radius = cap.radius;
    _box.makeEmpty();
    _box.expandByPoint(cap.start);
    _box.expandByPoint(cap.end);
    _box.min.addScalar(-radius);
    _box.max.addScalar(radius);
    _seg.start.copy(cap.start);
    _seg.end.copy(cap.end);
    let hit = false;
    this.bvh.shapecast({
      intersectsBounds: (bounds) => bounds.intersectsBox(_box),
      intersectsTriangle: (tri) => {
        if (tri.closestPointToSegment(_seg, _pt, _pt2) < radius) { hit = true; return true; }
        return false;
      },
    });
    return hit;
  }

  capsuleOverlapAny(capsule) { return this._overlaps(capsule); }

  // -------------------------------------------------------------------------
  //  Volumes
  // -------------------------------------------------------------------------

  /** Broadphase for explosions: which enemies are inside the blast sphere. */
  sphereOverlap(center, radius) {
    const out = [];
    const r2 = radius * radius;
    for (const rec of this.enemies) {
      const hb = rec.boxes[0];
      if (!hb) continue;
      if (hb.center.distanceToSquared(center) <= r2) out.push(rec.enemy);
    }
    return out;
  }

  // -------------------------------------------------------------------------
  //  Enemy hitboxes
  // -------------------------------------------------------------------------

  registerHitbox(enemy, object3D, boneName, damageMul = 1, radius = 0.18) {
    let rec = this.enemies.find((r) => r.enemy === enemy);
    if (!rec) { rec = { enemy, boxes: [] }; this.enemies.push(rec); }
    rec.boxes.push({
      enemy, obj: object3D, bone: boneName, mul: damageMul,
      radius, center: new THREE.Vector3(),
    });
  }

  unregisterEnemy(enemy) {
    const i = this.enemies.findIndex((r) => r.enemy === enemy);
    if (i >= 0) this.enemies.splice(i, 1);
  }

  /** Pull hitbox centres from their (animated) source objects. */
  syncHitboxes() {
    for (let e = 0; e < this.enemies.length; e++) {
      const boxes = this.enemies[e].boxes;
      for (let b = 0; b < boxes.length; b++) {
        const hb = boxes[b];
        if (hb.obj) hb.obj.getWorldPosition(hb.center);
      }
    }
  }

  update() {
    this.syncHitboxes();
    this.stats.rays = 0;
    this.stats.moves = 0;
  }
}
