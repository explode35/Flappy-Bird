/**
 * ============================================================================
 *  chamfer.js — primitive geometry generators with bevelled edges.
 * ============================================================================
 *  ART_DIRECTION §6: "Bevel or chamfer anything the player gets within 2 m of."
 *  Sharp 90° edges are the #1 amateur tell — every primitive in the level kit
 *  therefore comes out of this file, and every one of them has a 2–4 cm
 *  chamfer that catches the low dusk sun.
 *
 *  Every geometry produced here carries exactly the attribute set
 *      position | normal | uv | color
 *  so that BufferGeometryUtils.mergeGeometries() can weld any two of them.
 *  `color` starts as a cheap baked ambient-occlusion term (dark toward the
 *  base of the object) which geom/ao.js later refines against the level
 *  occupancy field. Materials multiply it in via `vertexColors`.
 *
 *  UVs are generated in METRES (u = x / uvScale) so a tiling material reads at
 *  a constant texel density no matter how big the piece is (§5).
 * ============================================================================
 */

import * as THREE from 'three';

/** Default chamfer width in metres. 2.6 cm reads perfectly at 1.68 m eye height. */
export const CHAMFER = 0.026;

const _n = new THREE.Vector3();
const _a = new THREE.Vector3();
const _b = new THREE.Vector3();
const _c = new THREE.Vector3();
const _ab = new THREE.Vector3();
const _ac = new THREE.Vector3();

/* -------------------------------------------------------------------------- */
/*  Mesh accumulator                                                           */
/* -------------------------------------------------------------------------- */

/**
 * Tiny triangle-soup accumulator. Cheaper than building THREE objects per face
 * and lets every generator share the same winding-safe emit helpers.
 */
export class Soup {
  constructor() {
    this.pos = [];
    this.nrm = [];
    this.uv = [];
    this.col = [];
    this.idx = [];
  }

  get vertexCount() { return this.pos.length / 3; }

  /** Push one vertex, return its index. */
  vert(px, py, pz, nx, ny, nz, u, v, r = 1, g = 1, b = 1) {
    const i = this.pos.length / 3;
    this.pos.push(px, py, pz);
    this.nrm.push(nx, ny, nz);
    this.uv.push(u, v);
    this.col.push(r, g, b);
    return i;
  }

  tri(i0, i1, i2) { this.idx.push(i0, i1, i2); }

  /**
   * Emit a quad p0..p3 (in order around the perimeter) with the given normal.
   * Winding is corrected automatically against `normal` so callers never have
   * to reason about handedness.
   */
  quad(p0, p1, p2, p3, normal, uvFn, shade) {
    _ab.subVectors(p1, p0); _ac.subVectors(p2, p0);
    _n.crossVectors(_ab, _ac);
    const flip = _n.dot(normal) < 0;
    const q = flip ? [p0, p3, p2, p1] : [p0, p1, p2, p3];
    const base = this.pos.length / 3;
    for (let i = 0; i < 4; i++) {
      const p = q[i];
      const uv = uvFn(p);
      const s = shade ? shade(p) : 1;
      this.vert(p.x, p.y, p.z, normal.x, normal.y, normal.z, uv.x, uv.y, s, s, s);
    }
    this.idx.push(base, base + 1, base + 2, base, base + 2, base + 3);
  }

  /** Emit a triangle with winding corrected against `normal`. */
  triangle(p0, p1, p2, normal, uvFn, shade) {
    _ab.subVectors(p1, p0); _ac.subVectors(p2, p0);
    _n.crossVectors(_ab, _ac);
    const flip = _n.dot(normal) < 0;
    const q = flip ? [p0, p2, p1] : [p0, p1, p2];
    const base = this.pos.length / 3;
    for (let i = 0; i < 3; i++) {
      const p = q[i];
      const uv = uvFn(p);
      const s = shade ? shade(p) : 1;
      this.vert(p.x, p.y, p.z, normal.x, normal.y, normal.z, uv.x, uv.y, s, s, s);
    }
    this.idx.push(base, base + 1, base + 2);
  }

  toGeometry() {
    const g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.Float32BufferAttribute(this.pos, 3));
    g.setAttribute('normal', new THREE.Float32BufferAttribute(this.nrm, 3));
    g.setAttribute('uv', new THREE.Float32BufferAttribute(this.uv, 2));
    g.setAttribute('color', new THREE.Float32BufferAttribute(this.col, 3));
    g.setIndex(this.idx.length > 65535
      ? new THREE.Uint32BufferAttribute(this.idx, 1)
      : new THREE.Uint16BufferAttribute(this.idx, 1));
    return g;
  }
}

/* -------------------------------------------------------------------------- */
/*  Normalisation helper: force a foreign geometry into our attribute set       */
/* -------------------------------------------------------------------------- */

const _tmpBox = new THREE.Box3();

/**
 * Make any THREE geometry merge-compatible with ours: guarantees
 * position/normal/uv/color, drops everything else, and re-projects UVs into
 * metres if `uvScale` is supplied.
 */
export function normalizeGeometry(geo, opts = {}) {
  const { uvScale = 0, aoBase = 0, aoHeight = 0.35, tint = null } = opts;
  if (!geo.attributes.normal) geo.computeVertexNormals();
  if (!geo.attributes.uv || uvScale > 0) {
    // Box-project UVs in metres against the dominant normal axis.
    const pos = geo.attributes.position;
    const nrm = geo.attributes.normal;
    const s = uvScale > 0 ? uvScale : 1;
    const uv = new Float32Array(pos.count * 2);
    for (let i = 0; i < pos.count; i++) {
      const nx = Math.abs(nrm.getX(i)), ny = Math.abs(nrm.getY(i)), nz = Math.abs(nrm.getZ(i));
      let u, v;
      if (ny >= nx && ny >= nz) { u = pos.getX(i); v = pos.getZ(i); }
      else if (nx >= nz) { u = pos.getZ(i); v = pos.getY(i); }
      else { u = pos.getX(i); v = pos.getY(i); }
      uv[i * 2] = u / s; uv[i * 2 + 1] = v / s;
    }
    geo.setAttribute('uv', new THREE.BufferAttribute(uv, 2));
  }
  if (!geo.attributes.color) {
    const pos = geo.attributes.position;
    geo.computeBoundingBox();
    _tmpBox.copy(geo.boundingBox);
    const y0 = _tmpBox.min.y;
    const col = new Float32Array(pos.count * 3);
    for (let i = 0; i < pos.count; i++) {
      let s = 1;
      if (aoBase > 0) {
        const t = Math.min(1, Math.max(0, (pos.getY(i) - y0) / aoHeight));
        s = 1 - aoBase * (1 - t * t);
      }
      col[i * 3] = s * (tint ? tint.r : 1);
      col[i * 3 + 1] = s * (tint ? tint.g : 1);
      col[i * 3 + 2] = s * (tint ? tint.b : 1);
    }
    geo.setAttribute('color', new THREE.BufferAttribute(col, 3));
  }
  // Strip attributes merge would choke on.
  for (const k of Object.keys(geo.attributes)) {
    if (k !== 'position' && k !== 'normal' && k !== 'uv' && k !== 'color') geo.deleteAttribute(k);
  }
  geo.morphAttributes = {};
  if (!geo.index) {
    const n = geo.attributes.position.count;
    const idx = n > 65535 ? new Uint32Array(n) : new Uint16Array(n);
    for (let i = 0; i < n; i++) idx[i] = i;
    geo.setIndex(new THREE.BufferAttribute(idx, 1));
  }
  geo.clearGroups();
  return geo;
}

/* -------------------------------------------------------------------------- */
/*  Chamfered box — the workhorse                                              */
/* -------------------------------------------------------------------------- */

// (axis, sign) -> tangent basis such that u × v == normal
const FACE_BASIS = [
  // +X, -X
  { n: [1, 0, 0], u: [0, 0, -1], v: [0, 1, 0] },
  { n: [-1, 0, 0], u: [0, 0, 1], v: [0, 1, 0] },
  // +Y, -Y
  { n: [0, 1, 0], u: [1, 0, 0], v: [0, 0, -1] },
  { n: [0, -1, 0], u: [1, 0, 0], v: [0, 0, 1] },
  // +Z, -Z
  { n: [0, 0, 1], u: [1, 0, 0], v: [0, 1, 0] },
  { n: [0, 0, -1], u: [-1, 0, 0], v: [0, 1, 0] },
];

const _p = [new THREE.Vector3(), new THREE.Vector3(), new THREE.Vector3(), new THREE.Vector3()];
const _uv = new THREE.Vector2();
const _fn = new THREE.Vector3();

/**
 * A box with all 12 edges chamfered and all 8 corners cut.
 *
 * @param {number} w  width  (X)
 * @param {number} h  height (Y)
 * @param {number} d  depth  (Z)
 * @param {object} opts
 *   chamfer   {number} bevel width, metres (default 2.6 cm)
 *   uvScale   {number} metres per texture tile (default 2)
 *   uvOffset  {[number,number]} UV shift in tiles, for breaking repetition
 *   origin    {'center'|'base'} where local (0,0,0) sits (default 'center')
 *   skip      {object} { px,nx,py,ny,pz,nz:true } to omit hidden faces
 *   ao        {number} 0..1 darkening at the base of the box
 *   aoHeight  {number} metres over which the base AO fades out
 *   taper     {number} scale factor applied to the +Y face (crates/planters)
 *   soup      {Soup}   append into an existing soup instead of allocating
 */
export function chamferBox(w, h, d, opts = {}) {
  const {
    chamfer = CHAMFER, uvScale = 2, uvOffset = null, origin = 'center',
    skip = null, ao = 0, aoHeight = 0.4, soup = null, uvSwapY = false,
  } = opts;

  const s = soup || new Soup();
  const hx = w * 0.5, hy = h * 0.5, hz = d * 0.5;
  const c = Math.min(chamfer, hx * 0.45, hy * 0.45, hz * 0.45);
  const ix = hx - c, iy = hy - c, iz = hz - c;
  const hs = [hx, hy, hz];
  const is = [ix, iy, iz];
  const yoff = origin === 'base' ? hy : 0;
  const uo = uvOffset ? uvOffset[0] : 0;
  const vo = uvOffset ? uvOffset[1] : 0;
  const invS = 1 / uvScale;
  const y0 = -hy;

  const shade = ao > 0
    ? (p) => {
      const t = Math.min(1, Math.max(0, (p.y - y0) / aoHeight));
      return 1 - ao * (1 - t * t);
    }
    : null;

  // Box-projected UVs in metres.
  const uvFn = (p) => {
    const anx = Math.abs(_fn.x), any = Math.abs(_fn.y), anz = Math.abs(_fn.z);
    let u, v;
    if (any >= anx && any >= anz) { u = p.x; v = p.z; }
    else if (anx >= anz) { u = p.z; v = p.y; }
    else { u = p.x; v = p.y; }
    if (uvSwapY) { const t = u; u = v; v = t; }
    _uv.set(u * invS + uo, v * invS + vo);
    return _uv;
  };

  const SKIPKEY = ['px', 'nx', 'py', 'ny', 'pz', 'nz'];

  // ---- 6 faces -------------------------------------------------------------
  for (let f = 0; f < 6; f++) {
    if (skip && skip[SKIPKEY[f]]) continue;
    const B = FACE_BASIS[f];
    const ax = f >> 1;
    const sgn = B.n[ax];
    _fn.set(B.n[0], B.n[1], B.n[2]);
    // inset extents along u and v
    const uAx = B.u[0] !== 0 ? 0 : B.u[1] !== 0 ? 1 : 2;
    const vAx = B.v[0] !== 0 ? 0 : B.v[1] !== 0 ? 1 : 2;
    const iu = is[uAx], iv = is[vAx];
    const cx = B.n[0] * sgn * hs[ax] * (B.n[0] !== 0 ? 1 : 0);
    const corners = [[-1, -1], [1, -1], [1, 1], [-1, 1]];
    for (let k = 0; k < 4; k++) {
      const su = corners[k][0], sv = corners[k][1];
      _p[k].set(
        B.n[0] * hs[ax] * (ax === 0 ? 1 : 0) + B.u[0] * iu * su + B.v[0] * iv * sv,
        B.n[1] * hs[ax] * (ax === 1 ? 1 : 0) + B.u[1] * iu * su + B.v[1] * iv * sv,
        B.n[2] * hs[ax] * (ax === 2 ? 1 : 0) + B.u[2] * iu * su + B.v[2] * iv * sv,
      );
      _p[k].y += yoff;
    }
    void cx;
    s.quad(_p[0], _p[1], _p[2], _p[3], _fn, uvFn, shade);
  }

  // ---- 12 edges ------------------------------------------------------------
  // Each edge is defined by two axes (a1, a2) and their signs.
  const EDGE_AXES = [[0, 1], [1, 2], [0, 2]];
  for (const [a1, a2] of EDGE_AXES) {
    const at = 3 - a1 - a2; // the axis the edge runs along
    for (const s1 of [-1, 1]) {
      for (const s2 of [-1, 1]) {
        _fn.set(0, 0, 0);
        _fn.setComponent(a1, s1); _fn.setComponent(a2, s2);
        _fn.normalize();
        for (let k = 0; k < 4; k++) _p[k].set(0, 0, 0);
        // two verts on face a1, two on face a2
        _p[0].setComponent(a1, s1 * hs[a1]); _p[0].setComponent(a2, s2 * is[a2]); _p[0].setComponent(at, -is[at]);
        _p[1].setComponent(a1, s1 * hs[a1]); _p[1].setComponent(a2, s2 * is[a2]); _p[1].setComponent(at, is[at]);
        _p[2].setComponent(a1, s1 * is[a1]); _p[2].setComponent(a2, s2 * hs[a2]); _p[2].setComponent(at, is[at]);
        _p[3].setComponent(a1, s1 * is[a1]); _p[3].setComponent(a2, s2 * hs[a2]); _p[3].setComponent(at, -is[at]);
        for (let k = 0; k < 4; k++) _p[k].y += yoff;
        s.quad(_p[0], _p[1], _p[2], _p[3], _fn, uvFn, shade);
      }
    }
  }

  // ---- 8 corners -----------------------------------------------------------
  for (const sx of [-1, 1]) {
    for (const sy of [-1, 1]) {
      for (const sz of [-1, 1]) {
        _fn.set(sx, sy, sz).normalize();
        _p[0].set(sx * hx, sy * iy, sz * iz);
        _p[1].set(sx * ix, sy * hy, sz * iz);
        _p[2].set(sx * ix, sy * iy, sz * hz);
        for (let k = 0; k < 3; k++) _p[k].y += yoff;
        s.triangle(_p[0], _p[1], _p[2], _fn, uvFn, shade);
      }
    }
  }

  return soup ? s : s.toGeometry();
}

/* -------------------------------------------------------------------------- */
/*  Chamfered cylinder — barrels, pillars, pipes, drums                         */
/* -------------------------------------------------------------------------- */

/**
 * A cylinder whose top and bottom rims are chamfered.
 * @param {number} rb bottom radius
 * @param {number} rt top radius
 * @param {number} h  height
 * @param {object} opts { seg, chamfer, uvScale, origin, cap, ao }
 */
export function chamferCyl(rb, rt, h, opts = {}) {
  const {
    seg = 14, chamfer = CHAMFER, uvScale = 1.2, origin = 'base',
    capTop = true, capBottom = true, ao = 0, aoHeight = 0.4, soup = null,
    uvOffset = null,
  } = opts;
  const s = soup || new Soup();
  const c = Math.min(chamfer, h * 0.24, Math.min(rb, rt) * 0.4);
  const y0 = origin === 'base' ? 0 : -h * 0.5;
  const y1 = y0 + h;
  const uo = uvOffset ? uvOffset[0] : 0;
  const vo = uvOffset ? uvOffset[1] : 0;

  const shade = ao > 0
    ? (p) => {
      const t = Math.min(1, Math.max(0, (p.y - y0) / aoHeight));
      return 1 - ao * (1 - t * t);
    }
    : null;

  const ring = (r, y) => {
    const out = [];
    for (let i = 0; i < seg; i++) {
      const a = (i / seg) * Math.PI * 2;
      out.push(new THREE.Vector3(Math.cos(a) * r, y, Math.sin(a) * r));
    }
    return out;
  };

  const rbi = rb - c, rti = rt - c;
  const r0 = ring(rbi, y0);          // bottom cap edge
  const r1 = ring(rb, y0 + c);       // bottom chamfer top
  const r2 = ring(rt, y1 - c);       // top chamfer bottom
  const r3 = ring(rti, y1);          // top cap edge

  const circ = Math.PI * 2 * ((rb + rt) * 0.5);
  const uvSide = (p) => {
    const a = Math.atan2(p.z, p.x);
    _uv.set((a / (Math.PI * 2)) * (circ / uvScale) + uo, p.y / uvScale + vo);
    return _uv;
  };
  const uvCap = (p) => { _uv.set(p.x / uvScale + uo, p.z / uvScale + vo); return _uv; };

  const band = (A, B, uvFn) => {
    for (let i = 0; i < seg; i++) {
      const j = (i + 1) % seg;
      const rx = A[i].x + A[j].x + B[i].x + B[j].x;
      const rz = A[i].z + A[j].z + B[i].z + B[j].z;
      const rl = Math.hypot(rx, rz) || 1;
      const dy = B[i].y - A[i].y;
      const dr = Math.hypot(B[i].x, B[i].z) - Math.hypot(A[i].x, A[i].z);
      const l = Math.hypot(dy, dr) || 1;
      _fn.set((rx / rl) * (dy / l), -dr / l, (rz / rl) * (dy / l));
      if (_fn.lengthSq() < 1e-8) _fn.set(rx / rl, 0, rz / rl);
      _fn.normalize();
      s.quad(A[i], A[j], B[j], B[i], _fn, uvFn, shade);
    }
  };

  band(r0, r1, uvSide);
  band(r1, r2, uvSide);
  band(r2, r3, uvSide);

  if (capBottom) {
    const ctr = new THREE.Vector3(0, y0, 0);
    _fn.set(0, -1, 0);
    for (let i = 0; i < seg; i++) {
      const j = (i + 1) % seg;
      s.triangle(ctr, r0[i], r0[j], _fn, uvCap, shade);
    }
  }
  if (capTop) {
    const ctr = new THREE.Vector3(0, y1, 0);
    _fn.set(0, 1, 0);
    for (let i = 0; i < seg; i++) {
      const j = (i + 1) % seg;
      s.triangle(ctr, r3[i], r3[j], _fn, uvCap, shade);
    }
  }
  return soup ? s : s.toGeometry();
}

/* -------------------------------------------------------------------------- */
/*  Misc primitives                                                            */
/* -------------------------------------------------------------------------- */

/** Single-sided (or double) quad in the XY plane, metres-UV. Cloth, decals. */
export function quadXY(w, h, opts = {}) {
  const { uvScale = 1, origin = 'center', doubleSided = false, soup = null, shade = null } = opts;
  const s = soup || new Soup();
  const hx = w * 0.5, hy = h * 0.5;
  const yo = origin === 'base' ? hy : 0;
  const p0 = new THREE.Vector3(-hx, -hy + yo, 0);
  const p1 = new THREE.Vector3(hx, -hy + yo, 0);
  const p2 = new THREE.Vector3(hx, hy + yo, 0);
  const p3 = new THREE.Vector3(-hx, hy + yo, 0);
  const uvFn = (p) => { _uv.set((p.x + hx) / uvScale, (p.y - yo + hy) / uvScale); return _uv; };
  _fn.set(0, 0, 1);
  s.quad(p0, p1, p2, p3, _fn, uvFn, shade);
  if (doubleSided) { _fn.set(0, 0, -1); s.quad(p0, p1, p2, p3, _fn, uvFn, shade); }
  return soup ? s : s.toGeometry();
}

/**
 * A sagging cloth / tarp sheet: a subdivided quad with catenary droop and a
 * little noise so it never reads as a flat card. Double-sided.
 */
export function clothSheet(w, h, opts = {}) {
  const {
    sag = 0.12, nx = 8, ny = 5, uvScale = 1, rng = Math.random,
    ripple = 0.03, soup = null, shade = null, axis = 'x',
  } = opts;
  const s = soup || new Soup();
  const grid = [];
  for (let j = 0; j <= ny; j++) {
    const row = [];
    for (let i = 0; i <= nx; i++) {
      const u = i / nx, v = j / ny;
      const x = (u - 0.5) * w;
      const y = (v - 0.5) * h;
      let z = 0;
      if (axis === 'x') z = Math.sin(u * Math.PI) * sag * (0.35 + 0.65 * (1 - v));
      else z = Math.sin(v * Math.PI) * sag;
      z += (rng() - 0.5) * ripple;
      row.push(new THREE.Vector3(x, y, z));
    }
    grid.push(row);
  }
  const uvFn = (p) => { _uv.set((p.x + w * 0.5) / uvScale, (p.y + h * 0.5) / uvScale); return _uv; };
  for (let j = 0; j < ny; j++) {
    for (let i = 0; i < nx; i++) {
      const a = grid[j][i], b = grid[j][i + 1], c = grid[j + 1][i + 1], d = grid[j + 1][i];
      _ab.subVectors(b, a); _ac.subVectors(d, a);
      _fn.crossVectors(_ab, _ac).normalize();
      if (_fn.lengthSq() < 1e-6) _fn.set(0, 0, 1);
      s.quad(a, b, c, d, _fn, uvFn, shade);
      _fn.negate();
      s.quad(a, b, c, d, _fn, uvFn, shade);
    }
  }
  return soup ? s : s.toGeometry();
}

/**
 * A catenary tube between two points — cables, ropes, laundry lines.
 * Enormously effective silhouette breakup for almost no cost (§6).
 */
export function catenary(from, to, opts = {}) {
  const {
    sag = 0.5, radius = 0.018, segments = 12, radialSeg = 4,
    uvScale = 0.5, soup = null, shade = null,
  } = opts;
  const s = soup || new Soup();
  const pts = [];
  const dx = to.x - from.x, dy = to.y - from.y, dz = to.z - from.z;
  for (let i = 0; i <= segments; i++) {
    const t = i / segments;
    pts.push(new THREE.Vector3(
      from.x + dx * t,
      from.y + dy * t - Math.sin(t * Math.PI) * sag,
      from.z + dz * t,
    ));
  }
  // Frame each ring.
  const tan = new THREE.Vector3(), up = new THREE.Vector3(0, 1, 0);
  const nrm = new THREE.Vector3(), bin = new THREE.Vector3();
  const rings = [];
  let run = 0;
  const lens = [0];
  for (let i = 0; i <= segments; i++) {
    if (i === 0) tan.subVectors(pts[1], pts[0]);
    else if (i === segments) tan.subVectors(pts[segments], pts[segments - 1]);
    else tan.subVectors(pts[i + 1], pts[i - 1]);
    if (i > 0) { run += pts[i].distanceTo(pts[i - 1]); lens.push(run); }
    tan.normalize();
    nrm.crossVectors(tan, up);
    if (nrm.lengthSq() < 1e-6) nrm.set(1, 0, 0);
    nrm.normalize();
    bin.crossVectors(nrm, tan).normalize();
    const ring = [];
    for (let k = 0; k < radialSeg; k++) {
      const a = (k / radialSeg) * Math.PI * 2;
      ring.push(new THREE.Vector3(
        pts[i].x + (nrm.x * Math.cos(a) + bin.x * Math.sin(a)) * radius,
        pts[i].y + (nrm.y * Math.cos(a) + bin.y * Math.sin(a)) * radius,
        pts[i].z + (nrm.z * Math.cos(a) + bin.z * Math.sin(a)) * radius,
      ));
    }
    rings.push(ring);
  }
  const invU = 1 / uvScale;
  for (let i = 0; i < segments; i++) {
    for (let k = 0; k < radialSeg; k++) {
      const k2 = (k + 1) % radialSeg;
      const A = rings[i][k], B = rings[i][k2], C = rings[i + 1][k2], D = rings[i + 1][k];
      const cx = (pts[i].x + pts[i + 1].x) * 0.5;
      const cy = (pts[i].y + pts[i + 1].y) * 0.5;
      const cz = (pts[i].z + pts[i + 1].z) * 0.5;
      _fn.set(
        (A.x + B.x + C.x + D.x) * 0.25 - cx,
        (A.y + B.y + C.y + D.y) * 0.25 - cy,
        (A.z + B.z + C.z + D.z) * 0.25 - cz,
      );
      if (_fn.lengthSq() < 1e-10) _fn.set(0, 1, 0);
      _fn.normalize();
      // UV from the point's own progress along the run — order-independent.
      const uvFn = (p) => {
        const t = Math.hypot(p.x - from.x, p.y - from.y, p.z - from.z) * invU;
        const ang = Math.atan2(p.y - cy, p.x - cx);
        _uv.set(t, (ang / (Math.PI * 2) + 0.5) * (Math.PI * 2 * radius) * invU);
        return _uv;
      };
      s.quad(A, B, C, D, _fn, uvFn, shade);
    }
  }
  void lens;
  return soup ? s : s.toGeometry();
}

/** Convenience: a chamfered box already positioned by min/max corners. */
export function boxBetween(x0, y0, z0, x1, y1, z1, opts = {}) {
  const g = chamferBox(Math.abs(x1 - x0), Math.abs(y1 - y0), Math.abs(z1 - z0), opts);
  g.translate((x0 + x1) * 0.5, (y0 + y1) * 0.5, (z0 + z1) * 0.5);
  return g;
}

/**
 * Extrudes a closed 2D profile along Y with chamfered top/bottom rims.
 * Used for kerbs, mouldings, hull sections, awning valances.
 */
export function extrudeProfile(points2D, height, opts = {}) {
  const { uvScale = 1, soup = null, shade = null, closed = true, chamfer = 0.02 } = opts;
  const s = soup || new Soup();
  const n = points2D.length;
  const inner = [];
  // Inset the profile by `chamfer` using vertex normals (approximate).
  for (let i = 0; i < n; i++) {
    const p = points2D[i];
    const a = points2D[(i - 1 + n) % n], b = points2D[(i + 1) % n];
    let nx = -(b[1] - a[1]), ny = (b[0] - a[0]);
    const l = Math.hypot(nx, ny) || 1; nx /= l; ny /= l;
    inner.push([p[0] - nx * chamfer, p[1] - ny * chamfer]);
  }
  const yb = 0, yt = height;
  const ring = (src, y) => src.map((p) => new THREE.Vector3(p[0], y, p[1]));
  const R0 = ring(inner, yb);
  const R1 = ring(points2D, yb + chamfer);
  const R2 = ring(points2D, yt - chamfer);
  const R3 = ring(inner, yt);
  const uvFn = (p) => { _uv.set((p.x + p.z) / uvScale, p.y / uvScale); return _uv; };
  const uvCap = (p) => { _uv.set(p.x / uvScale, p.z / uvScale); return _uv; };
  const band = (A, B) => {
    const lim = closed ? n : n - 1;
    for (let i = 0; i < lim; i++) {
      const j = (i + 1) % n;
      _fn.set(B[j].x - A[i].x, 0, B[j].z - A[i].z);
      const ex = A[j].x - A[i].x, ez = A[j].z - A[i].z;
      _fn.set(-ez, 0, ex).normalize();
      const dy = B[i].y - A[i].y;
      if (Math.abs(dy) < 1e-6) _fn.y = 0;
      s.quad(A[i], A[j], B[j], B[i], _fn, uvFn, shade);
    }
  };
  band(R0, R1); band(R1, R2); band(R2, R3);
  // Caps via fan (profiles here are convex or near-convex).
  const ctrT = new THREE.Vector3(); const ctrB = new THREE.Vector3();
  for (const p of R3) ctrT.add(p); ctrT.multiplyScalar(1 / n);
  for (const p of R0) ctrB.add(p); ctrB.multiplyScalar(1 / n);
  for (let i = 0; i < n; i++) {
    const j = (i + 1) % n;
    _fn.set(0, 1, 0); s.triangle(ctrT, R3[i], R3[j], _fn, uvCap, shade);
    _fn.set(0, -1, 0); s.triangle(ctrB, R0[i], R0[j], _fn, uvCap, shade);
  }
  return soup ? s : s.toGeometry();
}
