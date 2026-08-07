import * as THREE from 'three';
import { Piece } from '../geom/piece.js';
import { chamferBox, chamferCyl, clothSheet } from '../geom/chamfer.js';
import * as P from '../props/props.js';
import { STOREY } from '../geom/kit.js';

/**
 * ============================================================================
 *  fitout.js — what is actually inside the buildings.
 * ============================================================================
 *  `building()` gives you a shell: floor, walls, openings, ceiling. That reads
 *  as architecture from outside and as an empty concrete box from inside, and
 *  an empty box is the single loudest "this is a student project" tell there
 *  is. ART_DIRECTION §6 asks for occupancy: furniture at human scale, a light
 *  source that belongs to the room, and enough clutter that the eye has
 *  somewhere to land.
 *
 *  Each role below is a small set-dressing script for one kind of room. They
 *  return a Piece in *building-local* space — origin at the building's centre,
 *  y = 0 at the ground floor slab — plus:
 *
 *    lights  practical point lights, in the same local space. Unshadowed and
 *            short-range: they exist to lift the interior off pure ambient and
 *            to motivate the emissive fixtures, not to be the key light.
 *    glows   emissive quads/spheres for the fixtures themselves, so bloom has
 *            something to catch and the lamp reads as *on* rather than as a
 *            grey shade with a mysteriously bright floor under it.
 *
 *  Everything is placed against the interior clear dimensions, so a fitout
 *  written for a 13x16 café also works when that building is resized.
 * ============================================================================
 */

const TH = 0.3;                     // wall thickness used by building()
const _m = new THREE.Matrix4();

/**
 * Interior clear half-extents for a building of footprint w x d. The walls are
 * centred on the footprint line, so the inner face is half a wall thickness in,
 * not a whole one — getting that wrong stands every wall-hugging item 15 cm
 * off the wall it is meant to be against, which shows worst on the posters.
 */
function clear(w, d) {
  return { hx: w * 0.5 - TH * 0.5, hz: d * 0.5 - TH * 0.5 };
}

const rot = (ry, x, y, z) => _m.makeRotationY(ry).setPosition(x, y, z);

/* -------------------------------------------------------------------------- */
/*  Furniture                                                                  */
/* -------------------------------------------------------------------------- */

/**
 * Service counter. A tiled plinth with a timber top that overhangs on the
 * customer side, and a recessed kick at the bottom — the overhang and the kick
 * are what stop it reading as a wall stub.
 */
function counter(len = 3.2, rng = Math.random) {
  const p = new Piece();
  const H = 0.95, D = 0.68;
  const plinth = chamferBox(len, H - 0.05, D - 0.12, { uvScale: 1.1, origin: 'base', ao: 0.35, aoHeight: 0.3 });
  plinth.translate(0, 0, 0.06);
  p.add('tileFloor', plinth);
  const top = chamferBox(len + 0.08, 0.06, D, { uvScale: 0.8, chamfer: 0.02 });
  top.translate(0, H, 0);
  p.add('wood', top);
  // Kick rail: a dark shadow line along the base reads as contact.
  const kick = chamferBox(len - 0.04, 0.1, D - 0.24, { uvScale: 0.5, origin: 'base', chamfer: 0.012 });
  kick.translate(0, 0, 0.06);
  p.add('gunmetal', kick, true);
  // Bottles / jars on the back edge.
  for (let i = 0; i < Math.floor(len / 0.42); i++) {
    if (rng() < 0.35) continue;
    const r = 0.035 + rng() * 0.025;
    const h = 0.16 + rng() * 0.16;
    const b = chamferCyl(r, r * 0.7, h, { origin: 'base', seg: 8, uvScale: 0.2, chamfer: 0.01 });
    b.translate(-len * 0.5 + 0.24 + i * 0.42 + (rng() - 0.5) * 0.06, H + 0.03, -0.16 + (rng() - 0.5) * 0.08);
    p.add(rng() < 0.5 ? 'polymer' : 'gunmetal', b, true);
  }
  p.solid(0, H * 0.5, 0.03, len * 0.5, H * 0.5, D * 0.5, 'wood');
  return p;
}

/** Workbench: plywood top, angle-iron frame, vice, and junk. */
function workbench(len = 2.4, rng = Math.random) {
  const p = new Piece();
  const H = 0.88, D = 0.7;
  const top = chamferBox(len, 0.07, D, { uvScale: 0.7, chamfer: 0.014 });
  top.translate(0, H, 0);
  p.add('plywood', top);
  for (const sx of [-1, 1]) for (const sz of [-1, 1]) {
    const leg = chamferBox(0.06, H, 0.06, { uvScale: 0.3, origin: 'base', chamfer: 0.01 });
    leg.translate(sx * (len * 0.5 - 0.1), 0, sz * (D * 0.5 - 0.08));
    p.add('gunmetal', leg, true);
  }
  const rail = chamferBox(len - 0.14, 0.05, 0.05, { uvScale: 0.3, chamfer: 0.008 });
  rail.translate(0, 0.22, 0);
  p.add('gunmetal', rail, true);
  // Vice on the near corner — the detail that says "someone works here".
  const jaw = chamferBox(0.2, 0.13, 0.16, { uvScale: 0.2, origin: 'base', chamfer: 0.012 });
  jaw.translate(-len * 0.5 + 0.3, H + 0.035, D * 0.5 - 0.1);
  p.add('gunmetal', jaw, true);
  const screw = chamferCyl(0.022, 0.022, 0.24, { origin: 'center', seg: 8, uvScale: 0.2 });
  screw.rotateZ(Math.PI / 2);
  screw.translate(-len * 0.5 + 0.3, H + 0.1, D * 0.5 - 0.02);
  p.add('gunmetal', screw, true);
  // Clutter.
  for (let i = 0; i < 5; i++) {
    const bx = chamferBox(0.1 + rng() * 0.22, 0.06 + rng() * 0.14, 0.09 + rng() * 0.2,
      { uvScale: 0.25, origin: 'base', chamfer: 0.01 });
    bx.rotateY(rng() * 3.1);
    bx.translate((rng() - 0.5) * (len - 0.6), H + 0.035, (rng() - 0.5) * (D - 0.28));
    p.add(rng() < 0.5 ? 'crate' : 'polymer', bx, true);
  }
  p.solid(0, H * 0.5, 0, len * 0.5, H * 0.5, D * 0.5, 'wood');
  return p;
}

/** Pegboard of hand tools above a bench. Silhouette only — it is read at 3 m. */
function toolBoard(len = 1.8, rng = Math.random) {
  const p = new Piece();
  const board = chamferBox(len, 0.9, 0.03, { uvScale: 0.6, chamfer: 0.008 });
  p.add('plywood', board);
  for (let i = 0; i < 9; i++) {
    const kind = rng();
    const x = -len * 0.5 + 0.16 + rng() * (len - 0.32);
    const y = 0.3 - rng() * 0.5;
    if (kind < 0.45) {
      const shaft = chamferBox(0.028, 0.24 + rng() * 0.14, 0.026, { uvScale: 0.15, origin: 'base', chamfer: 0.006 });
      shaft.translate(x, y, 0.03);
      p.add('gunmetal', shaft, true);
    } else if (kind < 0.8) {
      const head = chamferBox(0.16, 0.045, 0.03, { uvScale: 0.15, chamfer: 0.008 });
      head.rotateZ((rng() - 0.5) * 0.5);
      head.translate(x, y, 0.03);
      p.add('rustMetal', head, true);
    } else {
      const ring = chamferCyl(0.055, 0.055, 0.02, { origin: 'center', seg: 10, uvScale: 0.15 });
      ring.rotateX(Math.PI / 2);
      ring.translate(x, y, 0.035);
      p.add('rustMetal', ring, true);
    }
  }
  return p;
}

/** Low bed / daybed with a rumpled cover. */
function bed(rng = Math.random) {
  const p = new Piece();
  const W = 1.05, L = 1.95, H = 0.42;
  const frame = chamferBox(W, H, L, { uvScale: 0.5, origin: 'base', ao: 0.35, aoHeight: 0.25 });
  p.add('wood', frame);
  const mat = chamferBox(W - 0.06, 0.18, L - 0.06, { uvScale: 0.6, origin: 'base', chamfer: 0.06 });
  mat.translate(0, H, 0);
  p.add('canvasTarp', mat);
  // A cover thrown over it, sagging off one side.
  const cover = clothSheet(W + 0.16, L * 0.62, { sag: 0.05, nx: 5, ny: 6, uvScale: 0.7, rng, ripple: 0.035 });
  cover.rotateX(-Math.PI / 2);
  cover.translate(0, H + 0.2, L * 0.16);
  p.add('canvasTarp', cover, true);
  const pillow = chamferBox(0.46, 0.12, 0.3, { uvScale: 0.4, origin: 'base', chamfer: 0.05 });
  pillow.rotateY(0.14);
  pillow.translate(0, H + 0.18, -L * 0.5 + 0.26);
  p.add('canvasTarp', pillow, true);
  p.solid(0, (H + 0.18) * 0.5, 0, W * 0.5, (H + 0.18) * 0.5, L * 0.5, 'wood');
  return p;
}

/** Wardrobe / tall cabinet — vertical mass to break a room up. */
function cabinet(rng = Math.random) {
  const p = new Piece();
  const W = 0.98, H = 1.92, D = 0.52;
  const body = chamferBox(W, H, D, { uvScale: 0.7, origin: 'base', ao: 0.4, aoHeight: 0.3 });
  p.add('wood', body);
  for (const sx of [-1, 1]) {
    const door = chamferBox(W * 0.47, H - 0.14, 0.03, { uvScale: 0.5, chamfer: 0.01 });
    door.translate(sx * W * 0.245, H * 0.5, D * 0.5 + 0.012);
    p.add('plywood', door, true);
    const knob = chamferCyl(0.017, 0.017, 0.04, { origin: 'center', seg: 8, uvScale: 0.1 });
    knob.rotateX(Math.PI / 2);
    knob.translate(sx * 0.06, H * 0.52, D * 0.5 + 0.035);
    p.add('gunmetal', knob, true);
  }
  const cornice = chamferBox(W + 0.06, 0.07, D + 0.05, { uvScale: 0.4, chamfer: 0.012 });
  cornice.translate(0, H, 0);
  p.add('wood', cornice, true);
  p.solid(0, H * 0.5, 0, W * 0.5, H * 0.5, D * 0.5, 'wood');
  return p;
}

/** Framed picture or peeling poster. Flat, but it kills a bare wall. */
function poster(rng = Math.random) {
  const p = new Piece();
  const w = 0.5 + rng() * 0.5, h = 0.4 + rng() * 0.55;
  const sheet = chamferBox(w, h, 0.012, { uvScale: 0.9, chamfer: 0.004 });
  p.add(rng() < 0.5 ? 'canvasTarp' : 'plywood', sheet, true);
  if (rng() < 0.55) {
    for (const [ox, oy, fw, fh] of [[0, h * 0.5, w + 0.05, 0.035], [0, -h * 0.5, w + 0.05, 0.035],
      [-w * 0.5, 0, 0.035, h + 0.035], [w * 0.5, 0, 0.035, h + 0.035]]) {
      const bar = chamferBox(fw, fh, 0.022, { uvScale: 0.2, chamfer: 0.005 });
      bar.translate(ox, oy, 0.004);
      p.add('wood', bar, true);
    }
  }
  return p;
}

/* -------------------------------------------------------------------------- */
/*  Light fixtures                                                             */
/* -------------------------------------------------------------------------- */

/**
 * Pendant lamp on a flex. Returns the piece; the caller places the practical
 * light and the glow at the shade's mouth.
 * @returns {{piece: Piece, dropY: number}}
 */
function pendant(drop = 0.9, rng = Math.random) {
  const p = new Piece();
  const flex = chamferCyl(0.008, 0.008, drop, { origin: 'base', seg: 6, uvScale: 0.2 });
  flex.translate(0, -drop, 0);
  p.add('gunmetal', flex, true);
  const shade = chamferCyl(0.055, 0.19, 0.17, { origin: 'base', seg: 14, uvScale: 0.3, capBottom: false });
  shade.translate(0, -drop - 0.17, 0);
  p.add(rng() < 0.5 ? 'metalPanel' : 'polymer', shade, true);
  return { piece: p, dropY: -drop - 0.2 };
}

/** Fluorescent batten fixture — warehouses and garages. */
function batten(len = 1.5) {
  const p = new Piece();
  const body = chamferBox(len, 0.09, 0.13, { uvScale: 0.4, chamfer: 0.014 });
  p.add('metalPanel', body, true);
  for (const sx of [-1, 1]) {
    const chain = chamferCyl(0.006, 0.006, 0.34, { origin: 'base', seg: 5, uvScale: 0.2 });
    chain.translate(sx * len * 0.36, 0.045, 0);
    p.add('gunmetal', chain, true);
  }
  return p;
}

/** Wall sconce — apartments. */
function sconce() {
  const p = new Piece();
  const back = chamferBox(0.12, 0.16, 0.04, { uvScale: 0.2, chamfer: 0.01 });
  p.add('gunmetal', back, true);
  const arm = chamferCyl(0.012, 0.012, 0.14, { origin: 'base', seg: 6, uvScale: 0.1 });
  arm.rotateX(Math.PI / 2);
  arm.translate(0, 0.03, 0.02);
  p.add('gunmetal', arm, true);
  const shade = chamferCyl(0.085, 0.06, 0.11, { origin: 'base', seg: 10, uvScale: 0.2, capTop: false });
  shade.translate(0, 0.02, 0.16);
  p.add('polymer', shade, true);
  return p;
}

/* -------------------------------------------------------------------------- */
/*  Roles                                                                      */
/* -------------------------------------------------------------------------- */

/**
 * @param {object} o
 * @param {string} o.role   cafe | apartment | shop | garage | warehouse
 * @param {number} o.w      building footprint width
 * @param {number} o.d      building footprint depth
 * @param {number} o.storeys
 * @param {function} o.rng
 * @returns {{piece: Piece, lights: object[], glows: object[]}}
 */
export function fitout({ role = 'shop', w = 12, d = 12, storeys = 1, doors = [], rng = Math.random }) {
  const p = new Piece();
  const lights = [];
  const glows = [];
  const { hx, hz } = clear(w, d);
  const r = (a, b) => a + rng() * (b - a);

  // Keep the doorways clear. A shelving run that happens to land across the
  // only entrance is both an obvious authoring mistake and a way to seal a
  // room the AI is pathing into, so every placement is tested against a
  // threshold disc in front of each ground-floor door.
  const blocked = [];
  for (const o of doors) {
    if ((o.storey ?? 0) !== 0) continue;
    const t = o.at ?? 0.5;
    if (o.side === 'n') blocked.push([(t - 0.5) * w, -hz + 0.9]);
    else if (o.side === 's') blocked.push([(t - 0.5) * w, hz - 0.9]);
    else if (o.side === 'w') blocked.push([-hx + 0.9, (t - 0.5) * d]);
    else blocked.push([hx - 0.9, (t - 0.5) * d]);
  }
  const clearOf = (x, z, rad = 1.5) =>
    !blocked.some(([bx, bz]) => (x - bx) ** 2 + (z - bz) ** 2 < rad * rad);

  const put = (piece, x, y, z, ry = 0, rad) => {
    if (!clearOf(x, z, rad)) return p;
    return p.stamp(piece, rot(ry, x, y, z));
  };

  // Ceiling height available on the ground floor. The top storey's ceiling
  // panel hangs 0.32 m below the slab; intermediate floors are the slab.
  const ceilY = storeys === 1 ? STOREY - 0.46 : STOREY - 0.14;

  /** Hang a pendant, wire up its practical light and its glow. */
  const hangPendant = (x, z, drop = r(0.75, 1.15)) => {
    const { piece, dropY } = pendant(drop, rng);
    put(piece, x, ceilY, z);
    const y = ceilY + dropY;
    lights.push({ x, y, z, color: 0xffcb8e, intensity: 9, distance: 7.5 });
    glows.push({ x, y: y + 0.03, z, r: 0.075, color: 0xffd9a8 });
  };

  const hangBatten = (x, z, ry = 0, len = 1.6) => {
    put(batten(len), x, ceilY - 0.36, z, ry);
    lights.push({ x, y: ceilY - 0.5, z, color: 0xdfe9ff, intensity: 8, distance: 8.5 });
    glows.push({ x, y: ceilY - 0.42, z, r: 0.05, color: 0xe8f0ff, sx: len * 0.86, sz: 0.07, ry });
  };

  /** Scatter posters along a wall run, facing inwards. */
  const posterRun = (n, side) => {
    for (let i = 0; i < n; i++) {
      const t = (i + 0.5) / n + r(-0.12, 0.12);
      const y = r(1.35, 2.1);
      if (side === 'n') put(poster(rng), (t - 0.5) * 2 * hx * 0.8, y, -hz + 0.03, 0);
      else if (side === 's') put(poster(rng), (t - 0.5) * 2 * hx * 0.8, y, hz - 0.03, Math.PI);
      else if (side === 'w') put(poster(rng), -hx + 0.03, y, (t - 0.5) * 2 * hz * 0.8, Math.PI / 2);
      else put(poster(rng), hx - 0.03, y, (t - 0.5) * 2 * hz * 0.8, -Math.PI / 2);
    }
  };

  switch (role) {
    /* ---------------------------------------------------------------- café */
    case 'cafe': {
      // Counter along the west wall, tables filling the rest, shelving behind.
      put(counter(Math.min(4.2, hz * 1.5), rng), -hx + 0.5, 0.02, hz * 0.05, Math.PI / 2);
      put(P.shelf(rng), -hx + 0.32, 0.02, -hz * 0.55, Math.PI / 2);
      put(P.shelf(rng), -hx + 0.32, 0.02, -hz * 0.55 + 1.72, Math.PI / 2);
      // Three café sets on a loose grid — never a regular one, it reads fake.
      const cols = 2, rows = 2;
      for (let i = 0; i < cols; i++) {
        for (let j = 0; j < rows; j++) {
          if (rng() < 0.18) continue;
          const x = hx * (-0.05 + (i + 0.5) / cols * 0.9) + r(-0.25, 0.25);
          const z = -hz * 0.7 + ((j + 0.5) / rows) * hz * 1.5 + r(-0.3, 0.3);
          put(P.cafeSet(rng), x, 0.02, z, r(-0.5, 0.5));
        }
      }
      hangPendant(-hx * 0.35, hz * 0.1);
      hangPendant(hx * 0.4, -hz * 0.35);
      hangPendant(hx * 0.35, hz * 0.5);
      posterRun(3, 'n');
      posterRun(2, 's');
      // A crate of stock nobody put away.
      put(P.crate(rng), -hx + 0.6, 0.02, -hz + 0.7, r(0, 1.5));
      break;
    }

    /* ----------------------------------------------------------- apartment */
    case 'apartment': {
      put(bed(rng), -hx + 0.75, 0.02, -hz + 1.3, r(-0.05, 0.05));
      put(cabinet(rng), hx - 0.4, 0.02, -hz + 1.1, -Math.PI / 2);
      put(P.cafeSet(rng), hx * 0.15, 0.02, hz * 0.3, r(-0.4, 0.4));
      put(P.shelf(rng), 0.2, 0.02, -hz + 0.32, 0);
      // A rug of hung cloth against the back wall, the way these rooms are.
      const drape = clothSheet(2.0, 1.4, { sag: 0.05, nx: 5, ny: 4, uvScale: 0.8, rng, ripple: 0.04 });
      drape.translate(-hx * 0.1, 1.85, hz - 0.06);
      p.add('canvasTarp', drape, true);
      put(sconce(), -hx + 0.04, 2.05, hz * 0.1, Math.PI / 2);
      put(sconce(), hx - 0.04, 2.05, -hz * 0.2, -Math.PI / 2);
      lights.push({ x: -hx + 0.35, y: 2.02, z: hz * 0.1, color: 0xffc389, intensity: 4.5, distance: 5.5 });
      lights.push({ x: hx - 0.35, y: 2.02, z: -hz * 0.2, color: 0xffc389, intensity: 4.5, distance: 5.5 });
      glows.push({ x: -hx + 0.2, y: 2.03, z: hz * 0.1, r: 0.05, color: 0xffd2a1 });
      glows.push({ x: hx - 0.2, y: 2.03, z: -hz * 0.2, r: 0.05, color: 0xffd2a1 });
      hangPendant(hx * 0.15, hz * 0.3, 0.85);
      posterRun(3, 'w');
      break;
    }

    /* ---------------------------------------------------------------- shop */
    case 'shop': {
      put(counter(3.0, rng), 0, 0.02, -hz + 1.0, 0);
      for (let i = 0; i < 3; i++) {
        put(P.shelf(rng), -hx + 0.32, 0.02, -hz + 2.6 + i * 1.75, Math.PI / 2);
      }
      for (let i = 0; i < 2; i++) {
        put(P.shelf(rng), hx - 0.32, 0.02, -hz + 2.9 + i * 1.75, -Math.PI / 2);
      }
      // Stock stacked in the middle of the floor.
      put(P.crate(rng), hx * 0.1, 0.02, hz * 0.3, r(0, 1.5));
      put(P.crate(rng), hx * 0.1 + 0.1, 0.84, hz * 0.3 - 0.06, r(0, 1.5));
      put(P.pallet(), -hx * 0.3, 0.02, hz * 0.5, r(0, 1.5));
      hangPendant(0, -hz * 0.4);
      hangPendant(0, hz * 0.35);
      posterRun(2, 'n');
      break;
    }

    /* -------------------------------------------------------------- garage */
    case 'garage': {
      put(workbench(Math.min(3.0, hx * 1.4), rng), 0, 0.02, -hz + 0.45, 0);
      put(toolBoard(1.8, rng), -0.2, 1.72, -hz + 0.06, 0);
      put(P.barrel(rng, 'rustMetal'), hx - 0.6, 0.02, -hz + 0.9, 0);
      put(P.barrel(rng, 'gunmetal'), hx - 0.6, 0.02, -hz + 1.6, 0);
      put(P.tyreStack(rng, 4), -hx + 0.75, 0.02, hz - 1.0, r(0, 1.5));
      put(P.tyreStack(rng, 2), -hx + 1.5, 0.02, hz - 0.8, r(0, 1.5));
      put(P.crate(rng), hx - 0.7, 0.02, hz - 0.8, r(0, 1.5));
      put(P.shelf(rng), hx - 0.32, 0.02, 0.4, -Math.PI / 2);
      hangBatten(-hx * 0.2, -hz * 0.25, 0, 1.6);
      hangBatten(hx * 0.15, hz * 0.4, 0, 1.6);
      break;
    }

    /* ----------------------------------------------------------- warehouse */
    default: {
      // Two shelving runs down the long axis with an aisle between them: it
      // makes the shed navigable instead of an empty hangar, and the aisle is
      // a genuine sightline that matters in a firefight.
      const rows = Math.max(2, Math.floor((hz * 2 - 3) / 3.4));
      for (let j = 0; j < rows; j++) {
        const z = -hz + 2.0 + j * 3.4;
        if (z > hz - 1.4) break;
        for (const sx of [-1, 1]) {
          put(P.shelf(rng), sx * (hx - 0.36), 0.02, z, sx > 0 ? -Math.PI / 2 : Math.PI / 2);
        }
      }
      // Crate and pallet stacks, biased to the corners so the middle stays
      // fightable.
      const spots = [
        [-hx + 1.1, -hz + 1.2], [hx - 1.2, -hz + 1.4],
        [-hx + 1.3, hz - 1.5], [hx - 1.0, hz - 1.2], [0.6, hz - 2.2],
      ];
      for (const [x, z] of spots) {
        put(P.pallet(), x, 0.02, z, r(0, 1.5));
        const n = 1 + Math.floor(rng() * 3);
        for (let k = 0; k < n; k++) {
          put(P.crate(rng), x + r(-0.12, 0.12), 0.16 + k * 0.81, z + r(-0.12, 0.12), r(0, 1.5));
        }
      }
      put(P.barrel(rng, 'rustMetal'), -0.9, 0.02, -hz + 1.0, 0);
      put(P.barrel(rng, 'rustMetal'), -0.3, 0.02, -hz + 1.15, 0);
      // High battens down the aisle.
      const bn = Math.max(2, Math.round(hz / 3.2));
      for (let i = 0; i < bn; i++) {
        hangBatten(0, -hz + ((i + 0.5) / bn) * hz * 2, Math.PI / 2, 1.8);
      }
      break;
    }
  }

  return { piece: p, lights, glows };
}
