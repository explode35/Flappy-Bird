import * as THREE from 'three';
import { Piece } from './piece.js';
import { chamferBox, chamferCyl, boxBetween, catenary, clothSheet, CHAMFER } from './chamfer.js';

/**
 * Modular architecture kit.
 *
 * Everything here emits chamfered geometry — ART_DIRECTION §6 forbids bare 90°
 * corners, and a 2-4 cm chamfer is the difference between "3D shapes" and
 * "built environment", because it gives every edge a highlight to catch.
 *
 * All builders take/return a Piece so they compose, and declare their own
 * collision solids so the level never has to describe collision twice.
 */

const R = (rng, a, b) => a + rng() * (b - a);

/** Floor-to-floor and opening sizes from ART_DIRECTION §4. */
export const STOREY = 3.2;
export const DOOR_W = 0.92;
export const DOOR_H = 2.05;
export const RAIL_H = 1.05;

/**
 * A wall with rectangular cut-outs. Openings are {x, y, w, h} in wall-local
 * space (x from the wall's left edge, y from its base). Built as a set of
 * chamfered box segments rather than a CSG subtract — cheaper, and every
 * reveal edge gets its own chamfer, which is what you actually want.
 */
export function wall(piece, mat, opts = {}) {
  const {
    x = 0, y = 0, z = 0, len = 4, height = STOREY, thick = 0.28, ry = 0,
    openings = [], uvScale = 2, solid = true, ao = 0.35,
  } = opts;

  // Sort the vertical slabs between openings.
  const cuts = openings.slice().sort((a, b) => a.x - b.x);
  const segs = [];   // [x0, x1, y0, y1]
  let cursor = 0;
  for (const o of cuts) {
    const ox0 = Math.max(0, o.x), ox1 = Math.min(len, o.x + o.w);
    if (ox0 > cursor) segs.push([cursor, ox0, 0, height]);
    // Below and above the opening.
    if (o.y > 0) segs.push([ox0, ox1, 0, o.y]);
    const top = o.y + o.h;
    if (top < height) segs.push([ox0, ox1, top, height]);
    cursor = Math.max(cursor, ox1);
  }
  if (cursor < len) segs.push([cursor, len, 0, height]);

  const g = [];
  for (const [x0, x1, y0, y1] of segs) {
    const w = x1 - x0, h = y1 - y0;
    if (w <= 0.001 || h <= 0.001) continue;
    const b = chamferBox(w, h, thick, { uvScale, ao, aoHeight: 0.5 });
    b.translate(x0 + w * 0.5 - len * 0.5, y0 + h * 0.5, 0);
    g.push(b);
    if (solid) {
      // Collision in wall-local space; rotated into place below.
      const cx = x0 + w * 0.5 - len * 0.5;
      const c = new THREE.Vector3(cx, y0 + h * 0.5, 0);
      if (ry) c.applyAxisAngle(_Y, ry);
      piece.solid(x + c.x, y + c.y, z + c.z, w * 0.5, h * 0.5, thick * 0.5, mat, ry);
    }
  }
  for (const b of g) {
    if (ry) b.rotateY(ry);
    b.translate(x, y, z);
    piece.add(mat, b);
  }

  // Reveals: a thin lining around each opening so the wall reads as having
  // thickness rather than being a cardboard cut-out.
  for (const o of cuts) {
    const lining = new THREE.Group();
    void lining;
    const t = thick * 0.5 + 0.012;
    const mk = (lx, ly, lw, lh, lz) => {
      const b = chamferBox(lw, lh, 0.05, { uvScale: 1, chamfer: 0.012 });
      b.translate(lx - len * 0.5, ly, lz);
      if (ry) b.rotateY(ry);
      b.translate(x, y, z);
      piece.add(mat, b, true);
    };
    for (const sgn of [-1, 1]) {
      mk(o.x + o.w * 0.5, o.y, o.w + 0.06, 0.06, sgn * t);            // sill
      mk(o.x + o.w * 0.5, o.y + o.h, o.w + 0.06, 0.06, sgn * t);      // head
    }
  }
  return piece;
}

const _Y = new THREE.Vector3(0, 1, 0);

/** Flat slab. `mat` drives the surface type for footsteps and impacts. */
export function floor(piece, mat, opts = {}) {
  const { x = 0, y = 0, z = 0, w = 8, d = 8, thick = 0.25, uvScale = 2, solid = true } = opts;
  const g = chamferBox(w, thick, d, { uvScale, chamfer: 0.02 });
  g.translate(x, y - thick * 0.5, z);
  piece.add(mat, g);
  if (solid) piece.solid(x, y - thick * 0.5, z, w * 0.5, thick * 0.5, d * 0.5, mat);
  return piece;
}

/**
 * A stair flight. Risers 0.17, treads 0.28 per ART_DIRECTION §4. Emits one
 * chamfered box per step plus a single ramp collision solid, because stepping
 * a capsule up 20 individual boxes is wasted BVH work when a ramp feels the
 * same and the step-up logic handles the visual mismatch.
 */
export function stairs(piece, mat, opts = {}) {
  const {
    x = 0, y = 0, z = 0, steps = 10, width = 1.6, rise = 0.17, run = 0.28,
    ry = 0, uvScale = 1.5, solid = true,
  } = opts;
  for (let i = 0; i < steps; i++) {
    const h = rise * (i + 1);
    const b = chamferBox(width, h, run, { uvScale, chamfer: 0.014 });
    b.translate(0, h * 0.5, -run * (i + 0.5));
    if (ry) b.rotateY(ry);
    b.translate(x, y, z);
    piece.add(mat, b);
  }
  if (solid) {
    // Blocky approximation: one solid per 3 steps keeps the capsule happy.
    for (let i = 0; i < steps; i += 3) {
      const n = Math.min(3, steps - i);
      const h = rise * (i + n);
      const cz = -run * (i + n * 0.5);
      const c = new THREE.Vector3(0, h * 0.5, cz);
      if (ry) c.applyAxisAngle(_Y, ry);
      piece.solid(x + c.x, y + c.y, z + c.z, width * 0.5, h * 0.5, (run * n) * 0.5, mat, ry);
    }
  }
  return piece;
}

/** Balcony / stairwell railing: posts + two rails. Reads well in silhouette. */
export function railing(piece, mat, opts = {}) {
  const {
    x = 0, y = 0, z = 0, len = 4, height = RAIL_H, ry = 0, posts = 0, solid = true,
  } = opts;
  const n = posts || Math.max(2, Math.round(len / 1.1));
  const parts = [];
  for (let i = 0; i <= n; i++) {
    const px = -len * 0.5 + (len * i) / n;
    const p = chamferCyl(0.022, 0.026, height, { origin: 'center', seg: 6, uvScale: 0.4 });
    p.translate(px, height * 0.5, 0);
    parts.push(p);
  }
  for (const ry2 of [height - 0.03, height * 0.52]) {
    const bar = chamferBox(len, 0.05, 0.05, { uvScale: 0.5, chamfer: 0.008 });
    bar.translate(0, ry2, 0);
    parts.push(bar);
  }
  for (const p of parts) {
    if (ry) p.rotateY(ry);
    p.translate(x, y, z);
    piece.add(mat, p, true);
  }
  if (solid) {
    const c = new THREE.Vector3(0, height * 0.5, 0);
    if (ry) c.applyAxisAngle(_Y, ry);
    piece.solid(x + c.x, y + c.y, z + c.z, len * 0.5, height * 0.5, 0.06, mat, ry);
  }
  return piece;
}

/** Roof parapet with randomly chipped capstones — silhouette breakup. */
export function parapet(piece, mat, opts = {}) {
  const {
    x = 0, y = 0, z = 0, len = 8, height = 0.85, thick = 0.24, ry = 0,
    rng = Math.random, chip = 0.3, solid = true,
  } = opts;
  const n = Math.max(1, Math.round(len / 1.2));
  for (let i = 0; i < n; i++) {
    const w = len / n;
    const px = -len * 0.5 + w * (i + 0.5);
    const h = height * (1 - (rng() < chip ? R(rng, 0.12, 0.34) : 0));
    const b = chamferBox(w * 1.002, h, thick, { uvScale: 1.5, chamfer: 0.03 });
    b.translate(px, h * 0.5, 0);
    if (ry) b.rotateY(ry);
    b.translate(x, y, z);
    piece.add(mat, b);
  }
  if (solid) {
    const c = new THREE.Vector3(0, height * 0.5, 0);
    if (ry) c.applyAxisAngle(_Y, ry);
    piece.solid(x + c.x, y + c.y, z + c.z, len * 0.5, height * 0.5, thick * 0.5, mat, ry);
  }
  return piece;
}

/** Square or round column with a base and capital. */
export function pillar(piece, mat, opts = {}) {
  const { x = 0, y = 0, z = 0, height = STOREY, r = 0.16, round = false, solid = true } = opts;
  const shaft = round
    ? chamferCyl(r, r * 1.06, height, { origin: 'center', seg: 12, uvScale: 1 })
    : chamferBox(r * 2, height, r * 2, { uvScale: 1 });
  shaft.translate(x, y + height * 0.5, z);
  piece.add(mat, shaft);
  for (const [yy, s] of [[y + 0.06, 1.28], [y + height - 0.07, 1.2]]) {
    const cap = chamferBox(r * 2 * s, 0.13, r * 2 * s, { uvScale: 0.8, chamfer: 0.02 });
    cap.translate(x, yy, z);
    piece.add(mat, cap);
  }
  if (solid) piece.solid(x, y + height * 0.5, z, r * 1.1, height * 0.5, r * 1.1, mat);
  return piece;
}

/** Fabric awning over a shopfront, with a pole frame and a scalloped valance. */
export function awning(piece, matCloth, matFrame, opts = {}) {
  const {
    x = 0, y = 2.5, z = 0, w = 3.2, depth = 1.4, drop = 0.5, ry = 0, rng = Math.random,
  } = opts;
  const cloth = clothSheet(w, depth, { sag: 0.1, nx: 8, ny: 4, uvScale: 1, rng, ripple: 0.035, axis: 'x' });
  cloth.rotateX(-Math.PI / 2 + 0.26);
  cloth.translate(0, 0, -depth * 0.42);
  const valance = clothSheet(w, drop, { sag: 0.05, nx: 8, ny: 2, uvScale: 1, rng, ripple: 0.03 });
  valance.translate(0, -drop * 0.5 - 0.14, -depth * 0.82);
  for (const g of [cloth, valance]) {
    if (ry) g.rotateY(ry);
    g.translate(x, y, z);
    piece.add(matCloth, g, true);
  }
  // Support poles back to the wall.
  for (const sx of [-w * 0.5 + 0.08, w * 0.5 - 0.08]) {
    const bar = boxBetween(sx, 0, 0, sx + 0.05, 0.05, -depth, { chamfer: 0.01, uvScale: 0.4 });
    if (ry) bar.rotateY(ry);
    bar.translate(x, y, z);
    piece.add(matFrame, bar, true);
  }
  return piece;
}

/** Sagging cable between two world points. Cheap, and it sells a lived-in city. */
export function cable(piece, mat, from, to, opts = {}) {
  const g = catenary(from, to, { sag: opts.sag ?? 0.6, radius: opts.radius ?? 0.02, segments: 14, radialSeg: 4 });
  piece.add(mat, g, true);
  return piece;
}

/** Kerb strip along a street edge — the trim that kills the bare-corner tell. */
export function curb(piece, mat, opts = {}) {
  const { x = 0, y = 0, z = 0, len = 10, height = 0.14, width = 0.3, ry = 0 } = opts;
  const n = Math.max(1, Math.round(len / 2));
  for (let i = 0; i < n; i++) {
    const w = len / n;
    const b = chamferBox(w * 0.995, height, width, { uvScale: 1, chamfer: 0.022 });
    b.translate(-len * 0.5 + w * (i + 0.5), height * 0.5, 0);
    if (ry) b.rotateY(ry);
    b.translate(x, y, z);
    piece.add(mat, b);
  }
  const c = new THREE.Vector3(0, height * 0.5, 0);
  if (ry) c.applyAxisAngle(_Y, ry);
  piece.solid(x + c.x, y + c.y, z + c.z, len * 0.5, height * 0.5, width * 0.5, mat, ry);
  return piece;
}

/** Skirting/moulding run where a wall meets a floor. */
export function skirting(piece, mat, opts = {}) {
  const { x = 0, y = 0, z = 0, len = 4, height = 0.12, depth = 0.05, ry = 0 } = opts;
  const b = chamferBox(len, height, depth, { uvScale: 0.6, chamfer: 0.014 });
  b.translate(0, height * 0.5, 0);
  if (ry) b.rotateY(ry);
  b.translate(x, y, z);
  piece.add(mat, b, true);
  return piece;
}

/** Drainpipe running down a facade, with wall brackets. */
export function drainpipe(piece, mat, opts = {}) {
  const { x = 0, y = 0, z = 0, height = 6, r = 0.055 } = opts;
  const p = chamferCyl(r, r, height, { origin: 'center', seg: 8, uvScale: 0.5 });
  p.translate(x, y + height * 0.5, z);
  piece.add(mat, p, true);
  for (let h = 0.6; h < height; h += 1.8) {
    const br = chamferBox(0.1, 0.05, 0.14, { chamfer: 0.008, uvScale: 0.3 });
    br.translate(x, y + h, z - 0.08);
    piece.add(mat, br, true);
  }
  piece.solid(x, y + height * 0.5, z, r * 1.4, height * 0.5, r * 1.4, mat);
  return piece;
}

/**
 * A complete building shell: floors, four walls with openings, an interior
 * partition or two, a roof slab and a parapet. This is the workhorse — the
 * whole map is a handful of these plus street dressing.
 */
export function building(opts = {}) {
  const {
    w = 10, d = 8, storeys = 2, matWall = 'plaster', matFloor = 'concrete',
    matRoof = 'concrete', matTrim = 'concrete', rng = Math.random,
    doors = [], windows = [], openRoof = true, interiorFloor = 'tileFloor',
  } = opts;
  const p = new Piece();
  const H = STOREY;

  for (let s = 0; s < storeys; s++) {
    const y = s * H;
    // Slab (the ground floor sits on the terrain, so skip it there).
    if (s > 0) floor(p, interiorFloor, { x: 0, y, z: 0, w: w - 0.5, d: d - 0.5, thick: 0.24, uvScale: 2 });

    // Four walls. Openings are supplied per side as fractions of the length.
    const sides = [
      { ry: 0, len: w, cx: 0, cz: -d * 0.5, side: 'n' },
      { ry: Math.PI, len: w, cx: 0, cz: d * 0.5, side: 's' },
      { ry: Math.PI / 2, len: d, cx: -w * 0.5, cz: 0, side: 'w' },
      { ry: -Math.PI / 2, len: d, cx: w * 0.5, cz: 0, side: 'e' },
    ];
    for (const sd of sides) {
      const openings = [];
      for (const o of doors) {
        if (o.side !== sd.side || (o.storey ?? 0) !== s) continue;
        openings.push({ x: o.at * sd.len - DOOR_W * 0.5, y: 0, w: DOOR_W, h: DOOR_H });
      }
      for (const o of windows) {
        if (o.side !== sd.side || (o.storey ?? 0) !== s) continue;
        const ww = o.w ?? 1.1, wh = o.h ?? 1.25;
        openings.push({ x: o.at * sd.len - ww * 0.5, y: o.sill ?? 0.95, w: ww, h: wh });
      }
      wall(p, matWall, {
        x: sd.cx, y, z: sd.cz, len: sd.len, height: H, thick: 0.3, ry: sd.ry,
        openings, uvScale: 2.4,
      });
    }
  }

  // Roof
  const topY = storeys * H;
  floor(p, matRoof, { x: 0, y: topY, z: 0, w, d, thick: 0.28, uvScale: 2.5 });
  if (openRoof) {
    for (const [cx, cz, len, ry] of [
      [0, -d * 0.5 + 0.12, w, 0], [0, d * 0.5 - 0.12, w, 0],
      [-w * 0.5 + 0.12, 0, d, Math.PI / 2], [w * 0.5 - 0.12, 0, d, Math.PI / 2],
    ]) {
      parapet(p, matTrim, { x: cx, y: topY, z: cz, len, ry, rng, height: 0.82, thick: 0.22 });
    }
  }
  return p;
}
