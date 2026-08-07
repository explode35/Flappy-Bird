import * as THREE from 'three';
import { Piece, tintGeometry } from './piece.js';
import {
  chamferBox, chamferCyl, boxBetween, catenary, clothSheet, normalizeGeometry, CHAMFER,
} from './chamfer.js';

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

const _Y = new THREE.Vector3(0, 1, 0);

/* -------------------------------------------------------------------------- */
/*  Facade helpers                                                             */
/* -------------------------------------------------------------------------- */

/**
 * Unbevelled box — 12 triangles instead of the chamfered box's 44.
 *
 * A facade covered in mouldings is hundreds of small pieces, and a 2.6 cm
 * chamfer on a 3 cm shutter slat is invisible at every distance the player
 * ever sees it from. Use this for anything thinner than ~8 cm; use chamferBox
 * for the masses (jambs, lintels, sills, cornices) where the highlight on the
 * bevel is the whole point.
 */
export function plainBox(w, h, d, opts = {}) {
  const { uvScale = 1, tint = null } = opts;
  const g = new THREE.BoxGeometry(w, h, d);
  normalizeGeometry(g, { uvScale, tint });
  return g;
}

/**
 * Facade frame convention, shared by every builder below and matching wall():
 * a face is {x, y, z, ry} at the wall's centre-line, with local +X running
 * along the wall, local +Y up from the wall's base, and local **-Z pointing
 * out of the building**. So an element that projects `p` metres from a wall of
 * thickness `t` sits at local z = -t/2 - p/2.
 */
function put(piece, mat, geo, f, lx, ly, lz, decor = true) {
  geo.translate(lx, ly, lz);
  if (f.ry) geo.rotateY(f.ry);
  geo.translate(f.x, f.y, f.z);
  piece.add(mat, geo, decor);
  return geo;
}

/** Centre z for a moulding projecting `p` from a wall face at `zOut`, with the
 *  6 cm tail that buries its back edge inside the wall (no seam, no z-fight). */
const projZ = (zOut, p) => zOut - p * 0.5 + 0.03;

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

  // Reveals: a thin lining all the way around each opening so the wall reads
  // as having thickness rather than being a cardboard cut-out. Head, sill and
  // both jambs, on both faces — plain boxes, because a 5 cm strip cannot show
  // a chamfer and 8 of them per opening adds up fast.
  const f = { x, y, z, ry };
  for (const o of cuts) {
    const t = thick * 0.5 + 0.012;
    const ocx = o.x + o.w * 0.5 - len * 0.5;
    for (const sgn of [-1, 1]) {
      put(piece, mat, plainBox(o.w + 0.1, 0.055, 0.055, { uvScale: 0.5 }), f, ocx, o.y, sgn * t);
      put(piece, mat, plainBox(o.w + 0.1, 0.055, 0.055, { uvScale: 0.5 }), f, ocx, o.y + o.h, sgn * t);
      for (const jx of [-1, 1]) {
        put(piece, mat, plainBox(0.055, o.h, 0.055, { uvScale: 0.5 }),
          f, ocx + jx * (o.w * 0.5 + 0.022), o.y + o.h * 0.5, sgn * t);
      }
    }
  }
  return piece;
}

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
    rng = Math.random, chip = 0.3, solid = true, coping = true,
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
    // Coping stone: a slightly oversailing cap. It is the line the roof reads
    // by in silhouette, and it is what makes a chipped parapet look chipped
    // rather than just badly modelled.
    if (coping && h > height * 0.8) {
      const cap = plainBox(w * 1.004, 0.075, thick + 0.09, { uvScale: 0.7 });
      cap.translate(px, h + 0.03, 0);
      if (ry) cap.rotateY(ry);
      cap.translate(x, y, z);
      piece.add(mat, cap, true);
    }
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

/* ==========================================================================
 *  FACADE RELIEF
 * --------------------------------------------------------------------------
 *  ART_DIRECTION §6 forbids bare surfaces, and a plastered wall with holes in
 *  it is the biggest bare surface in the map. Everything below is the
 *  vocabulary of a Mediterranean street facade, in the order a mason would
 *  build it: plinth, quoins, pilasters, string course, window surround,
 *  shutter, balconette, shopfront, cornice.
 *
 *  All of it is chamfered or plain boxes and none of it collides — the wall
 *  behind already owns the collision, and letting 6 cm mouldings into the BVH
 *  would make the capsule catch on the architecture.
 * ======================================================================== */

/**
 * Horizontal moulding band marking a floor level. The single highest-value
 * piece of relief on the list: it gives an otherwise flat wall a hard
 * horizontal line to catch the 8.5° sun, and drops a shadow onto the storey
 * below that reads from right across the plaza.
 */
export function stringCourse(piece, mat, opts = {}) {
  const {
    x = 0, y = 0, z = 0, ry = 0, len = 8, thick = 0.3,
    height = 0.17, project = 0.085,
  } = opts;
  const f = { x, y, z, ry };
  const zOut = -thick * 0.5;
  put(piece, mat, chamferBox(len, height, project + 0.06, { uvScale: 1.1, chamfer: 0.022 }),
    f, 0, height * 0.5, projZ(zOut, project));
  // Drip fillet: throws the water — and the shadow — clear of the wall below.
  put(piece, mat, plainBox(len, 0.05, project * 0.7 + 0.06, { uvScale: 0.6 }),
    f, 0, -0.025, projZ(zOut, project * 0.7));
  return piece;
}

/**
 * Projecting cornice under the parapet: bed mould, optional dentil course,
 * corona, cyma. Four stacked bands is what stops the top of a building
 * reading as a cut-off extrusion.
 */
export function cornice(piece, mat, opts = {}) {
  const {
    x = 0, y = 0, z = 0, ry = 0, len = 8, thick = 0.3,
    project = 0.26, dentils = false,
  } = opts;
  const f = { x, y, z, ry };
  const zOut = -thick * 0.5;
  const p1 = project * 0.4, p3 = project, p4 = project * 0.66;

  put(piece, mat, chamferBox(len, 0.13, p1 + 0.06, { uvScale: 1, chamfer: 0.02 }),
    f, 0, 0.065, projZ(zOut, p1));
  if (dentils) {
    const n = Math.max(2, Math.floor(len / 0.44));
    const step = len / n;
    for (let i = 0; i < n; i++) {
      put(piece, mat, plainBox(step * 0.5, 0.14, project * 0.62 + 0.06, { uvScale: 0.5 }),
        f, -len * 0.5 + step * (i + 0.5), 0.2, projZ(zOut, project * 0.62));
    }
    put(piece, mat, chamferBox(len, 0.06, p1 + 0.08, { uvScale: 0.8, chamfer: 0.014 }),
      f, 0, 0.3, projZ(zOut, p1 + 0.02));
  }
  const yC = dentils ? 0.4 : 0.19;
  put(piece, mat, chamferBox(len, 0.16, p3 + 0.06, { uvScale: 1, chamfer: 0.026 }),
    f, 0, yC, projZ(zOut, p3));
  put(piece, mat, chamferBox(len, 0.11, p4 + 0.06, { uvScale: 0.9, chamfer: 0.02 }),
    f, 0, yC + 0.135, projZ(zOut, p4));
  return piece;
}

/**
 * Quoin run up a building corner: alternating long/short dressed stones that
 * oversail both faces. Reads as masonry from any angle and, more usefully,
 * puts a broken vertical line on the corner so the building has an edge
 * instead of a seam.
 *
 * @param opts.ox,oz  outward signs (±1) of the two faces meeting at the corner
 */
export function quoinRun(piece, mat, opts = {}) {
  const {
    x = 0, y = 0, z = 0, height = 6.4, ox = 1, oz = 1,
    big = 0.68, small = 0.46, course = 0.56, project = 0.05, rng = Math.random,
  } = opts;
  const n = Math.max(2, Math.floor(height / course));
  for (let i = 0; i < n; i++) {
    const s = (i % 2 === 0 ? big : small) * R(rng, 0.96, 1.04);
    const h = course * R(rng, 0.9, 0.99);
    const g = chamferBox(s, h, s, { uvScale: 0.9, chamfer: 0.026 });
    g.translate(
      x - ox * (s * 0.5 - project),
      y + course * i + h * 0.5 + course * 0.03,
      z - oz * (s * 0.5 - project),
    );
    piece.add(mat, g, true);
  }
  return piece;
}

/** Shallow pilaster: a flat vertical strip with a base and a capital. */
export function pilaster(piece, mat, opts = {}) {
  const {
    x = 0, y = 0, z = 0, ry = 0, thick = 0.3, at = 0,
    height = STOREY, width = 0.44, project = 0.07,
  } = opts;
  const f = { x, y, z, ry };
  const zOut = -thick * 0.5;
  put(piece, mat, chamferBox(width, height, project + 0.06, { uvScale: 1, chamfer: 0.024 }),
    f, at, height * 0.5, projZ(zOut, project));
  put(piece, mat, chamferBox(width + 0.13, 0.17, project + 0.11, { uvScale: 0.8, chamfer: 0.02 }),
    f, at, 0.085, projZ(zOut, project + 0.05));
  put(piece, mat, chamferBox(width + 0.15, 0.13, project + 0.13, { uvScale: 0.8, chamfer: 0.02 }),
    f, at, height - 0.065, projZ(zOut, project + 0.06));
  return piece;
}

/**
 * Window surround: architrave jambs, a lintel with a keystone, and a
 * projecting sill on corbels. This is the detail that makes a hole in a wall
 * read as a window rather than as a missing polygon.
 */
export function windowSurround(piece, mat, opts = {}) {
  const {
    x = 0, y = 0, z = 0, ry = 0, thick = 0.3,
    at = 0, sill = 0.95, w = 1.1, h = 1.25,
    jamb = 0.15, project = 0.07, keystone = true, corbels = true,
  } = opts;
  const f = { x, y, z, ry };
  const zOut = -thick * 0.5;
  const outer = w * 0.5 + jamb * 0.5;
  const sp = project + 0.09;                       // the sill projects further

  for (const s of [-1, 1]) {
    put(piece, mat, chamferBox(jamb, h + 0.1, project + 0.06, { uvScale: 0.9, chamfer: 0.02 }),
      f, at + s * outer, sill + h * 0.5, projZ(zOut, project));
  }
  put(piece, mat, chamferBox(w + jamb * 2 + 0.12, 0.17, project + 0.08, { uvScale: 0.9, chamfer: 0.022 }),
    f, at, sill + h + 0.085, projZ(zOut, project + 0.02));
  if (keystone) {
    put(piece, mat, plainBox(0.19, 0.27, project * 1.5 + 0.06, { uvScale: 0.6 }),
      f, at, sill + h + 0.115, projZ(zOut, project * 1.5));
  }
  put(piece, mat, chamferBox(w + jamb * 2 + 0.2, 0.095, sp + 0.06, { uvScale: 0.9, chamfer: 0.02 }),
    f, at, sill - 0.048, projZ(zOut, sp));
  if (corbels) {
    for (const s of [-1, 1]) {
      put(piece, mat, plainBox(0.11, 0.14, sp * 0.85 + 0.06, { uvScale: 0.5 }),
        f, at + s * (w * 0.5 + 0.03), sill - 0.16, projZ(zOut, sp * 0.85));
    }
  }
  return piece;
}

/**
 * Glazing set back in the reveal: a dark pane plus frame and glazing bars.
 * The recess matters more than the glass — an opening with something 12 cm
 * behind its face has depth; an empty hole does not.
 */
export function glazing(piece, matGlass, matFrame, opts = {}) {
  const {
    x = 0, y = 0, z = 0, ry = 0, thick = 0.3,
    at = 0, sill = 0.95, w = 1.1, h = 1.25, recess = 0.12,
    bars = true, tint = 0.3,
  } = opts;
  const f = { x, y, z, ry };
  const zg = -thick * 0.5 + recess;
  const col = new THREE.Color(tint * 0.92, tint * 1.0, tint * 1.16);
  put(piece, matGlass, plainBox(w - 0.04, h - 0.04, 0.024, { uvScale: 0.8, tint: col }),
    f, at, sill + h * 0.5, zg);
  // Frame: two stiles, head and cill rail, plus a central mullion.
  const fw = 0.05;
  for (const s of [-1, 1]) {
    put(piece, matFrame, plainBox(fw, h - 0.04, 0.06, { uvScale: 0.4 }),
      f, at + s * (w * 0.5 - fw * 0.5 - 0.02), sill + h * 0.5, zg - 0.02);
  }
  for (const s of [-1, 1]) {
    put(piece, matFrame, plainBox(w - 0.04, fw, 0.06, { uvScale: 0.4 }),
      f, at, sill + h * 0.5 + s * (h * 0.5 - fw * 0.5 - 0.02), zg - 0.02);
  }
  if (bars) {
    put(piece, matFrame, plainBox(0.035, h - 0.06, 0.045, { uvScale: 0.3 }),
      f, at, sill + h * 0.5, zg - 0.015);
    put(piece, matFrame, plainBox(w - 0.06, 0.035, 0.045, { uvScale: 0.3 }),
      f, at, sill + h * 0.62, zg - 0.015);
  }
  return piece;
}

/**
 * Louvred timber shutters hinged at the jambs, thrown half open. Along with
 * the balconette this is the most recognisable single detail of the
 * architecture, and — because each leaf sits at its own angle — it is also
 * the cheapest way to stop a rank of identical windows reading as a texture.
 */
export function shutters(piece, mat, opts = {}) {
  const {
    x = 0, y = 0, z = 0, ry = 0, thick = 0.3,
    at = 0, sill = 0.95, w = 1.1, h = 1.25,
    slats = 3, rng = Math.random, both = true,
  } = opts;
  const f = { x, y, z, ry };
  const zOut = -thick * 0.5;
  const lw = w * 0.53, lt = 0.042;

  for (const s of [-1, 1]) {
    if (!both && s < 0) continue;
    // Closed leaves lie flat on the wall; open ones swing out (toward -Z).
    const shut = rng() < 0.16;
    const ang = shut ? R(rng, 0.02, 0.07) : R(rng, 0.42, 1.18);
    const th = -s * ang;
    const hingeX = at + s * (w * 0.5 + 0.02);

    const leaf = new THREE.Group();
    void leaf;
    const parts = [];
    parts.push([mat, plainBox(lw, h - 0.03, lt, { uvScale: 0.55 }), -s * lw * 0.5, (h - 0.03) * 0.5, 0]);
    // Louvre bands, raised proud of the leaf so they catch the raking light.
    for (let i = 0; i < slats; i++) {
      const bh = (h / slats) * 0.58;
      parts.push([mat, plainBox(lw - 0.055, bh, 0.055, { uvScale: 0.3 }),
        -s * lw * 0.5, (h / slats) * (i + 0.5), -0.026]);
    }
    for (const [m, g, px, py, pz] of parts) {
      g.translate(px, py, pz);
      g.rotateY(th);
      put(piece, m, g, f, hingeX, sill + 0.015, zOut - lt * 0.5 - 0.015);
    }
  }
  return piece;
}

/**
 * Wrought-iron balconette on a small projecting stone slab: the Juliet
 * balcony that every upper-floor window on this coast has. Bellied out in the
 * middle, because a straight one looks like a fence.
 */
export function balconette(piece, matStone, matIron, opts = {}) {
  const {
    x = 0, y = 0, z = 0, ry = 0, thick = 0.3,
    at = 0, sill = 0.95, w = 1.1,
    depth = 0.42, height = 0.94, belly = 0.075, rng = Math.random,
  } = opts;
  const f = { x, y, z, ry };
  const zOut = -thick * 0.5;
  const bw = w + 0.62;

  put(piece, matStone, chamferBox(bw, 0.11, depth + 0.06, { uvScale: 0.9, chamfer: 0.022 }),
    f, at, sill - 0.055, projZ(zOut, depth));
  const zRail = zOut - depth * 0.62;
  const y0 = sill + 0.02;
  // Rails
  put(piece, matIron, plainBox(bw - 0.09, 0.045, 0.05, { uvScale: 0.3 }), f, at, y0 + 0.07, zRail);
  put(piece, matIron, plainBox(bw - 0.06, 0.06, 0.075, { uvScale: 0.3 }), f, at, y0 + height, zRail);
  put(piece, matIron, plainBox(bw - 0.09, 0.035, 0.04, { uvScale: 0.3 }), f, at, y0 + height * 0.58, zRail);
  // Corner posts, then balusters bowed outward toward the middle.
  for (const s of [-1, 1]) {
    put(piece, matIron, plainBox(0.038, height, 0.038, { uvScale: 0.2 }),
      f, at + s * (bw * 0.5 - 0.04), y0 + height * 0.5, zRail);
    // Returns back to the wall so it is a box, not a plank.
    put(piece, matIron, plainBox(0.035, 0.05, depth * 0.7, { uvScale: 0.2 }),
      f, at + s * (bw * 0.5 - 0.04), y0 + height, zOut - depth * 0.35);
  }
  const n = Math.max(4, Math.round((bw - 0.2) / 0.15));
  for (let i = 1; i < n; i++) {
    const t = i / n;
    const bz = zRail - Math.sin(Math.PI * t) * belly;
    put(piece, matIron, plainBox(0.026, height - 0.05, 0.026, { uvScale: 0.2 }),
      f, at - bw * 0.5 + 0.1 + (bw - 0.2) * t, y0 + height * 0.5, bz);
  }
  void rng;
  return piece;
}

/**
 * Ground-floor shopfront: stallriser, flanking pilasters, a deep fascia with
 * a sign board, and either display glazing or a half-dropped roller shutter.
 *
 * A facade whose ground floor is the same wall as its upper floors is the
 * clearest tell that a street was extruded rather than built — the ground
 * floor is where the money, the wear and the human scale all live.
 */
export function shopfront(piece, mats, opts = {}) {
  const {
    x = 0, y = 0, z = 0, ry = 0, thick = 0.3,
    at = 0, sill = 0.5, w = 2.6, h = 2.1,
    kind = 'glazed', rng = Math.random,
  } = opts;
  const { stone = 'concrete', frame = 'wood', shutter = 'corrugated', glass = 'polymer' } = mats;
  const f = { x, y, z, ry };
  const zOut = -thick * 0.5;
  const top = sill + h;

  // Stallriser under the glass — takes the kicks, so it is always a different
  // material from the wall above it.
  if (sill > 0.12) {
    put(piece, frame, chamferBox(w + 0.16, sill, 0.1, { uvScale: 0.7, chamfer: 0.02 }),
      f, at, sill * 0.5, projZ(zOut, 0.06));
  }
  // Flanking pilasters and the fascia they carry.
  for (const s of [-1, 1]) {
    put(piece, stone, chamferBox(0.24, top + 0.1, 0.16, { uvScale: 0.9, chamfer: 0.024 }),
      f, at + s * (w * 0.5 + 0.14), (top + 0.1) * 0.5, projZ(zOut, 0.11));
  }
  put(piece, stone, chamferBox(w + 0.74, 0.44, 0.2, { uvScale: 0.9, chamfer: 0.024 }),
    f, at, top + 0.22, projZ(zOut, 0.15));
  put(piece, frame, plainBox(w * 0.72, 0.26, 0.045, { uvScale: 0.5 }),
    f, at, top + 0.22, projZ(zOut, 0.18) - 0.06);
  put(piece, stone, plainBox(w + 0.86, 0.07, 0.26, { uvScale: 0.5 }),
    f, at, top + 0.46, projZ(zOut, 0.2));

  if (kind === 'shutter') {
    // Roller shutter part way down, with its box and guide rails.
    const drop = R(rng, 0.35, 0.95) * h;
    const slats = Math.max(2, Math.round(drop / 0.13));
    for (let i = 0; i < slats; i++) {
      put(piece, shutter, plainBox(w - 0.06, 0.115, 0.05, { uvScale: 0.35 }),
        f, at, top - 0.07 - i * 0.13, zOut + 0.06);
    }
    put(piece, shutter, plainBox(w + 0.02, 0.09, 0.075, { uvScale: 0.3 }),
      f, at, top - drop - 0.02, zOut + 0.055);
    for (const s of [-1, 1]) {
      put(piece, shutter, plainBox(0.055, h, 0.1, { uvScale: 0.3 }),
        f, at + s * (w * 0.5 + 0.01), sill + h * 0.5, zOut + 0.05);
    }
  } else {
    const col = new THREE.Color(0.26, 0.29, 0.34);
    put(piece, glass, plainBox(w - 0.08, h - 0.08, 0.024, { uvScale: 0.8, tint: col }),
      f, at, sill + h * 0.5, zOut + 0.13);
    for (const s of [-1, 1]) {
      put(piece, frame, plainBox(0.07, h - 0.06, 0.07, { uvScale: 0.4 }),
        f, at + s * (w * 0.5 - 0.05), sill + h * 0.5, zOut + 0.11);
    }
    put(piece, frame, plainBox(0.055, h - 0.06, 0.06, { uvScale: 0.3 }), f, at, sill + h * 0.5, zOut + 0.11);
    put(piece, frame, plainBox(w - 0.08, 0.06, 0.06, { uvScale: 0.3 }), f, at, sill + h * 0.72, zOut + 0.11);
  }
  return piece;
}

/**
 * Dressed doorway: architrave, lintel, a panelled leaf set back in the
 * reveal, and a stone step up off the street. The step is the only piece of
 * facade relief that gets collision — the player walks on it.
 */
export function doorway(piece, mats, opts = {}) {
  const {
    x = 0, y = 0, z = 0, ry = 0, thick = 0.3, at = 0,
    w = DOOR_W, h = DOOR_H, step = true, canopy = false, rng = Math.random,
  } = opts;
  const { stone = 'concrete', frame = 'wood', iron = 'gunmetal' } = mats;
  const f = { x, y, z, ry };
  const zOut = -thick * 0.5;
  const jamb = 0.19, project = 0.08;

  for (const s of [-1, 1]) {
    put(piece, stone, chamferBox(jamb, h + 0.12, project + 0.06, { uvScale: 0.9, chamfer: 0.022 }),
      f, at + s * (w * 0.5 + jamb * 0.5), (h + 0.12) * 0.5, projZ(zOut, project));
  }
  put(piece, stone, chamferBox(w + jamb * 2 + 0.16, 0.2, project + 0.09, { uvScale: 0.9, chamfer: 0.024 }),
    f, at, h + 0.16, projZ(zOut, project + 0.02));
  put(piece, stone, plainBox(0.2, 0.3, project * 1.5 + 0.06, { uvScale: 0.6 }),
    f, at, h + 0.19, projZ(zOut, project * 1.5));

  // Leaf, recessed into the reveal so the opening has depth.
  const zl = zOut + 0.14;
  put(piece, frame, plainBox(w - 0.04, h - 0.03, 0.055, { uvScale: 0.5 }), f, at, (h - 0.03) * 0.5, zl);
  for (let i = 0; i < 4; i++) {
    const py = 0.28 + i * (h - 0.5) / 3.4;
    put(piece, frame, plainBox(w - 0.24, (h - 0.5) / 5.2, 0.03, { uvScale: 0.3 }), f, at, py, zl - 0.04);
  }
  put(piece, iron, plainBox(0.05, 0.16, 0.05, { uvScale: 0.2 }), f, at + w * 0.32, h * 0.5, zl - 0.05);

  if (canopy) {
    put(piece, stone, plainBox(w + 0.8, 0.08, 0.62, { uvScale: 0.6 }), f, at, h + 0.6, zOut - 0.3);
    for (const s of [-1, 1]) {
      put(piece, iron, boxBetween(
        at + s * (w * 0.5 + 0.2), h + 0.56, zOut - 0.55,
        at + s * (w * 0.5 + 0.24), h + 0.6, zOut,
        { chamfer: 0.01, uvScale: 0.3 },
      ), f, 0, 0, 0);
    }
  }
  if (step) {
    const sh = 0.16, sd = 0.46;
    const g = chamferBox(w + 0.62, sh, sd, { uvScale: 0.8, chamfer: 0.024 });
    put(piece, stone, g, f, at, sh * 0.5, zOut - sd * 0.5 + 0.02, false);
    const c = new THREE.Vector3(at, sh * 0.5, zOut - sd * 0.5 + 0.02);
    if (ry) c.applyAxisAngle(_Y, ry);
    piece.solid(x + c.x, y + c.y, z + c.z, (w + 0.62) * 0.5, sh * 0.5, sd * 0.5, stone, ry);
  }
  void rng;
  return piece;
}

/**
 * A complete building shell: floors, four walls with openings, an interior
 * partition or two, a roof slab and a parapet. This is the workhorse — the
 * whole map is a handful of these plus street dressing.
 */
/**
 * Fill a wall with a regular window rhythm. Real Mediterranean facades put an
 * opening roughly every 3 m per storey; hand-listing them per side in the
 * layout data is why the buildings previously read as slabs with a few holes.
 * Explicit `windows` entries for a side always win over the generated rhythm.
 */
function windowRhythm(len, storey, rng, spacing = 3.15) {
  const n = Math.max(1, Math.round((len - 1.6) / spacing));
  if (n < 1) return [];
  const out = [];
  for (let i = 0; i < n; i++) {
    const frac = (i + 0.5) / n;
    // Ground floor gets taller openings; upper floors are squarer.
    const w = storey === 0 ? 1.25 : 1.05;
    const h = storey === 0 ? 1.55 : 1.25;
    out.push({ at: frac, w, h, sill: storey === 0 ? 0.85 : 0.98 });
  }
  return out;
}

export function building(opts = {}) {
  const {
    w = 10, d = 8, storeys = 2, matWall = 'plaster', matFloor = 'concrete',
    matRoof = 'concrete', matTrim = 'concrete', rng = Math.random,
    doors = [], windows = [], openRoof = true, interiorFloor = 'tileFloor',
    detail = true, commercial = false,
  } = opts;
  const p = new Piece();
  const H = STOREY;
  const TH = 0.3;

  for (let s = 0; s < storeys; s++) {
    const y = s * H;
    if (s > 0) {
      floor(p, interiorFloor, { x: 0, y, z: 0, w: w - 0.5, d: d - 0.5, thick: 0.24, uvScale: 2 });
    } else {
      // The ground floor used to just expose the terrain underneath, which is
      // why interiors read as gravel yards: you were standing on the street
      // material with a roof over it. Lay a real floor 2 cm proud of the
      // terrain instead.
      floor(p, interiorFloor, {
        x: 0, y: 0.02, z: 0, w: w - TH * 2, d: d - TH * 2, thick: 0.12, uvScale: 2,
      });
    }

    // Four walls. Openings are supplied per side as fractions of the length.
    const sides = [
      { ry: 0, len: w, cx: 0, cz: -d * 0.5, side: 'n' },
      { ry: Math.PI, len: w, cx: 0, cz: d * 0.5, side: 's' },
      { ry: Math.PI / 2, len: d, cx: -w * 0.5, cz: 0, side: 'w' },
      { ry: -Math.PI / 2, len: d, cx: w * 0.5, cz: 0, side: 'e' },
    ];
    for (const sd of sides) {
      const openings = [];
      const myDoors = doors.filter((o) => o.side === sd.side && (o.storey ?? 0) === s);
      for (const o of myDoors) {
        openings.push({ x: o.at * sd.len - DOOR_W * 0.5, y: 0, w: DOOR_W, h: DOOR_H });
      }

      let myWindows = windows.filter((o) => o.side === sd.side && (o.storey ?? 0) === s);
      if (detail && !myWindows.length) {
        myWindows = windowRhythm(sd.len, s, rng)
          // Do not drop a window on top of a door.
          .filter((o) => !myDoors.some((dr) => Math.abs(dr.at - o.at) * sd.len < 1.5));
      }
      for (const o of myWindows) {
        const ww = o.w ?? 1.1, wh = o.h ?? 1.25;
        openings.push({ x: o.at * sd.len - ww * 0.5, y: o.sill ?? 0.95, w: ww, h: wh });
      }

      wall(p, matWall, {
        x: sd.cx, y, z: sd.cz, len: sd.len, height: H, thick: TH, ry: sd.ry,
        openings, uvScale: 2.4,
      });

      if (!detail) continue;
      const frame = { x: sd.cx, y, z: sd.cz, ry: sd.ry, thick: TH };

      // --- per-opening dressing -------------------------------------------
      for (const o of myWindows) {
        const ww = o.w ?? 1.1, wh = o.h ?? 1.25, sill = o.sill ?? 0.95;
        const at = o.at * sd.len - sd.len * 0.5;
        const g = { ...frame, at, sill, w: ww, h: wh };
        windowSurround(p, matTrim, g);
        glazing(p, 'glass', matTrim, g);
        // Not every window is shuttered, and a fully shuttered row looks fake.
        if (rng() < 0.62) shutters(p, 'wood', { ...g, rng });
        // Balconettes only upstairs — one at ground level would block the street.
        if (s > 0 && rng() < 0.34) balconette(p, matTrim, 'gunmetal', { ...g, rng });
      }

      for (const o of myDoors) {
        const at = o.at * sd.len - sd.len * 0.5;
        if (commercial && s === 0) {
          shopfront(p, { stone: matTrim, frame: 'wood', shutter: 'corrugated', glass: 'glass' },
            { ...frame, at, w: 3.0, rng });
        } else {
          doorway(p, { stone: matTrim, frame: 'wood', iron: 'gunmetal' }, { ...frame, at, rng });
        }
      }

      // --- horizontal banding ----------------------------------------------
      // A string course on every floor line, and a cornice under the parapet.
      if (s > 0) {
        stringCourse(p, matTrim, { ...frame, y, len: sd.len, project: 0.085 });
      }
      if (s === storeys - 1) {
        cornice(p, matTrim, {
          x: sd.cx, y: y + H, z: sd.cz, ry: sd.ry, thick: TH,
          len: sd.len, project: 0.26, dentils: storeys >= 3,
        });
      }
    }
  }

  // Quoins bind the corners together and stop the box reading as an extrusion.
  if (detail) {
    for (const ox of [-1, 1]) {
      for (const oz of [-1, 1]) {
        quoinRun(p, matTrim, {
          x: ox * w * 0.5, y: 0, z: oz * d * 0.5,
          height: storeys * H, ox, oz, rng,
        });
      }
    }
  }

  // Roof
  const topY = storeys * H;
  floor(p, matRoof, { x: 0, y: topY, z: 0, w, d, thick: 0.28, uvScale: 2.5 });
  // Ceiling below it. Without this the top-floor "ceiling" is the underside of
  // the roof slab in exterior concrete, which is the other half of why
  // interiors looked like yards with lids on.
  if (detail) {
    const ceil = chamferBox(w - TH * 2, 0.06, d - TH * 2, { uvScale: 2.2, chamfer: 0.02 });
    ceil.translate(0, topY - 0.32, 0);
    p.add('plaster', ceil, true);
    // Exposed beams break up the slab and give the light something to catch.
    const nb = Math.max(2, Math.round((d - TH * 2) / 1.15));
    for (let i = 0; i < nb; i++) {
      const bz = -(d - TH * 2) * 0.5 + ((i + 0.5) * (d - TH * 2)) / nb;
      const beam = chamferBox(w - TH * 2, 0.17, 0.13, { uvScale: 0.8, chamfer: 0.014 });
      beam.translate(0, topY - 0.44, bz);
      p.add('wood', beam, true);
    }
  }
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
