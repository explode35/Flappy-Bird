import * as THREE from 'three';
import { Piece } from '../geom/piece.js';
import { chamferBox, chamferCyl, clothSheet, extrudeProfile, boxBetween } from '../geom/chamfer.js';

/**
 * Prop library. Every prop is a Piece built once and stamped many times by the
 * level, so these are templates, not instances — they must be built at the
 * origin with their base on y = 0.
 *
 * Dimensions come from ART_DIRECTION §4. Getting prop scale right is what makes
 * a space read as real: a crate that is 1.2 m instead of 0.8 m silently breaks
 * the player's sense of the whole level.
 */

const T = (rng) => (a, b) => a + rng() * (b - a);

/** 0.8 m timber crate with corner battens and plank faces. */
export function crate(rng = Math.random) {
  const p = new Piece();
  const s = 0.8;
  const body = chamferBox(s, s, s, { uvScale: 0.8, origin: 'base', ao: 0.3, aoHeight: 0.25 });
  p.add('crate', body);
  // Corner battens — the silhouette detail that stops it being a plain cube.
  const b = 0.06;
  for (const sx of [-1, 1]) for (const sz of [-1, 1]) {
    const post = chamferBox(b, s + 0.006, b, { uvScale: 0.3, origin: 'base', chamfer: 0.008 });
    post.translate(sx * (s * 0.5 - b * 0.5), 0, sz * (s * 0.5 - b * 0.5));
    p.add('wood', post, true);
  }
  for (const y of [b * 0.6, s - b * 0.6]) {
    for (const [ax, az] of [[1, 0], [0, 1]]) {
      for (const sgn of [-1, 1]) {
        const rail = chamferBox(ax ? s : b, b, az ? s : b, { uvScale: 0.3, chamfer: 0.008 });
        rail.translate(az ? sgn * (s * 0.5 - b * 0.5) : 0, y, ax ? sgn * (s * 0.5 - b * 0.5) : 0);
        p.add('wood', rail, true);
      }
    }
  }
  p.solid(0, s * 0.5, 0, s * 0.5, s * 0.5, s * 0.5, 'crate');
  return p;
}

/** Ø0.58 × 0.88 m oil drum with rolling hoops and a rim. */
export function barrel(rng = Math.random, mat = 'rustMetal') {
  const p = new Piece();
  const r = 0.29, h = 0.88;
  const body = chamferCyl(r, r, h, { origin: 'center', seg: 16, uvScale: 0.7 });
  body.translate(0, h * 0.5, 0);
  p.add(mat, body);
  for (const y of [h * 0.28, h * 0.72]) {
    const hoop = chamferCyl(r + 0.022, r + 0.022, 0.055, { origin: 'center', seg: 16, uvScale: 0.3 });
    hoop.translate(0, y, 0);
    p.add(mat, hoop, true);
  }
  for (const y of [0.03, h - 0.03]) {
    const rim = chamferCyl(r + 0.015, r + 0.015, 0.05, { origin: 'center', seg: 16, uvScale: 0.3 });
    rim.translate(0, y, 0);
    p.add(mat, rim, true);
  }
  p.solid(0, h * 0.5, 0, r, h * 0.5, r, mat);
  return p;
}

/** Sandbag: a squashed, lumpy pillow. Stacks read as fortification instantly. */
export function sandbag(rng = Math.random) {
  const p = new Piece();
  const g = chamferBox(0.55, 0.28, 0.35, { chamfer: 0.09, uvScale: 0.4, origin: 'base' });
  // Lumpiness: shove vertices around a little so no two bags look identical.
  const pos = g.attributes.position;
  for (let i = 0; i < pos.count; i++) {
    const x = pos.getX(i), y = pos.getY(i), z = pos.getZ(i);
    const n = Math.sin(x * 21.3 + z * 13.7) * 0.5 + Math.sin(y * 17.1 + x * 9.3) * 0.5;
    pos.setXYZ(i, x + n * 0.016, y + n * 0.01, z + n * 0.014);
  }
  g.computeVertexNormals();
  p.add('sandbag', g);
  p.solid(0, 0.14, 0, 0.275, 0.14, 0.175, 'sandbag');
  return p;
}

/** A stack of sandbags forming waist-high cover (1.05 m per ART_DIRECTION §4). */
export function sandbagWall(rng = Math.random, len = 2.4) {
  const p = new Piece();
  const r = T(rng);
  const rows = 4, bagW = 0.55, bagH = 0.26;
  for (let row = 0; row < rows; row++) {
    const y = row * bagH;
    const offset = (row % 2) * bagW * 0.5;
    const n = Math.floor((len - offset) / bagW);
    for (let i = 0; i < n; i++) {
      const bag = sandbag(rng);
      const m = new THREE.Matrix4().makeRotationY(r(-0.09, 0.09));
      m.setPosition(-len * 0.5 + offset + bagW * (i + 0.5), y, r(-0.03, 0.03));
      p.stamp(bag, m);
    }
  }
  p.solids.length = 0;   // one clean box beats 30 bag boxes for the BVH
  p.solid(0, rows * bagH * 0.5, 0, len * 0.5, rows * bagH * 0.5, 0.2, 'sandbag');
  return p;
}

/** Jersey barrier — the classic tapered concrete profile. */
export function jerseyBarrier() {
  const p = new Piece();
  const profile = [
    [-0.30, 0], [0.30, 0], [0.22, 0.14], [0.13, 0.30],
    [0.11, 0.82], [-0.11, 0.82], [-0.13, 0.30], [-0.22, 0.14],
  ];
  const g = extrudeProfile(profile, 1.9, { uvScale: 1, chamfer: 0.018 });
  // extrudeProfile runs along Y; stand it up and lay it along X.
  g.rotateZ(Math.PI / 2);
  g.rotateY(Math.PI / 2);
  g.translate(0, 0, 0);
  p.add('concrete', g);
  p.solid(0, 0.41, 0, 0.95, 0.41, 0.3, 'concrete');
  return p;
}

/** Shipping container, 6.06 × 2.44 × 2.59 m, with corrugated sides and doors. */
export function container(rng = Math.random) {
  const p = new Piece();
  const L = 6.06, W = 2.44, H = 2.59;
  const body = chamferBox(L, H, W, { uvScale: 1.2, origin: 'base', chamfer: 0.035 });
  p.add('corrugated', body);
  // Corner castings and top/bottom rails.
  for (const sy of [0.09, H - 0.09]) {
    for (const [ax, len] of [[0, W], [1, L]]) {
      for (const sgn of [-1, 1]) {
        const rail = chamferBox(ax ? len : 0.14, 0.16, ax ? 0.14 : len, { uvScale: 0.5, chamfer: 0.02 });
        rail.translate(ax ? 0 : sgn * (L * 0.5 - 0.02), sy, ax ? sgn * (W * 0.5 - 0.02) : 0);
        p.add('metalPanel', rail, true);
      }
    }
  }
  for (const sx of [-1, 1]) for (const sz of [-1, 1]) for (const sy of [0.11, H - 0.11]) {
    const cast = chamferBox(0.22, 0.2, 0.22, { uvScale: 0.3, chamfer: 0.02 });
    cast.translate(sx * (L * 0.5 - 0.09), sy, sz * (W * 0.5 - 0.09));
    p.add('metalPanel', cast, true);
  }
  // Door end: two leaves with locking bars.
  for (const sz of [-1, 1]) {
    const leaf = chamferBox(0.06, H - 0.32, W * 0.5 - 0.1, { uvScale: 0.8, chamfer: 0.015 });
    leaf.translate(L * 0.5 + 0.02, H * 0.5, sz * W * 0.25);
    p.add('metalPanel', leaf, true);
    for (const o of [-0.28, 0.28]) {
      const bar = chamferCyl(0.028, 0.028, H - 0.5, { origin: 'center', seg: 8, uvScale: 0.3 });
      bar.translate(L * 0.5 + 0.06, H * 0.5, sz * W * 0.25 + o);
      p.add('gunmetal', bar, true);
    }
  }
  p.solid(0, H * 0.5, 0, L * 0.5, H * 0.5, W * 0.5, 'corrugated');
  return p;
}

/** Wooden pallet — flat clutter that breaks up empty floor. */
export function pallet() {
  const p = new Piece();
  const L = 1.2, W = 0.8;
  for (let i = 0; i < 3; i++) {
    const bearer = chamferBox(0.1, 0.09, W, { uvScale: 0.3, chamfer: 0.008 });
    bearer.translate(-L * 0.5 + 0.05 + i * (L - 0.1) * 0.5, 0.045, 0);
    p.add('wood', bearer);
  }
  for (let i = 0; i < 6; i++) {
    const plank = chamferBox(L, 0.022, 0.1, { uvScale: 0.3, chamfer: 0.005 });
    plank.translate(0, 0.101, -W * 0.5 + 0.05 + i * (W - 0.1) / 5);
    p.add('wood', plank);
  }
  p.solid(0, 0.06, 0, L * 0.5, 0.06, W * 0.5, 'wood');
  return p;
}

/** Stack of tyres. */
export function tyreStack(rng = Math.random, n = 3) {
  const p = new Piece();
  const r = T(rng);
  for (let i = 0; i < n; i++) {
    const t = new THREE.TorusGeometry(0.3, 0.11, 8, 14);
    t.rotateX(Math.PI / 2);
    t.rotateY(r(0, 3));
    t.translate(r(-0.03, 0.03), 0.13 + i * 0.22, r(-0.03, 0.03));
    t.deleteAttribute('uv');
    p.add('polymer', t);
  }
  p.solid(0, n * 0.11, 0, 0.41, n * 0.11, 0.41, 'polymer');
  return p;
}

/** Market stall: trestle table, canopy, and produce boxes. */
export function marketStall(rng = Math.random) {
  const p = new Piece();
  const r = T(rng);
  const W = 2.2, D = 1.0, TOP = 0.88;
  const top = chamferBox(W, 0.06, D, { uvScale: 0.6, chamfer: 0.01 });
  top.translate(0, TOP, 0);
  p.add('wood', top);
  for (const sx of [-1, 1]) for (const sz of [-1, 1]) {
    const leg = chamferBox(0.07, TOP, 0.07, { uvScale: 0.3, origin: 'base', chamfer: 0.008 });
    leg.translate(sx * (W * 0.5 - 0.1), 0, sz * (D * 0.5 - 0.1));
    p.add('wood', leg, true);
  }
  // Canopy on four poles.
  const CH = 2.25;
  for (const sx of [-1, 1]) for (const sz of [-1, 1]) {
    const pole = chamferCyl(0.026, 0.026, CH, { origin: 'center', seg: 6, uvScale: 0.3 });
    pole.translate(sx * (W * 0.5 - 0.06), CH * 0.5, sz * (D * 0.5 - 0.05));
    p.add('gunmetal', pole, true);
  }
  const canopy = clothSheet(W + 0.35, D + 0.5, { sag: 0.12, nx: 7, ny: 4, uvScale: 1, rng, ripple: 0.04 });
  canopy.rotateX(-Math.PI / 2);
  canopy.translate(0, CH, 0);
  p.add('canvasTarp', canopy, true);
  // Produce crates on the table.
  for (let i = 0; i < 3; i++) {
    const b = chamferBox(0.4, 0.22, 0.32, { uvScale: 0.3, origin: 'base', chamfer: 0.012 });
    b.rotateY(r(-0.2, 0.2));
    b.translate(-W * 0.35 + i * 0.62, TOP + 0.03, r(-0.08, 0.08));
    p.add('crate', b, true);
  }
  p.solid(0, TOP * 0.5, 0, W * 0.5, TOP * 0.5, D * 0.5, 'wood');
  return p;
}

/** Roof-mounted AC condenser unit with a fan grille. */
export function acUnit(rng = Math.random) {
  const p = new Piece();
  const W = 0.85, H = 0.7, D = 0.42;
  const body = chamferBox(W, H, D, { uvScale: 0.5, origin: 'base', chamfer: 0.02 });
  p.add('metalPanel', body);
  const grille = chamferCyl(0.24, 0.24, 0.04, { origin: 'center', seg: 14, uvScale: 0.3 });
  grille.rotateX(Math.PI / 2);
  grille.translate(0, H * 0.55, D * 0.5 + 0.01);
  p.add('gunmetal', grille, true);
  for (let i = 0; i < 5; i++) {
    const fin = chamferBox(W - 0.08, 0.018, 0.02, { uvScale: 0.2, chamfer: 0.004 });
    fin.translate(0, 0.1 + i * 0.055, -D * 0.5 - 0.008);
    p.add('gunmetal', fin, true);
  }
  p.solid(0, H * 0.5, 0, W * 0.5, H * 0.5, D * 0.5, 'metalPanel');
  return p;
}

/** Satellite dish on a bracket — roofline silhouette. */
export function satDish(rng = Math.random) {
  const p = new Piece();
  const dish = new THREE.SphereGeometry(0.42, 14, 8, 0, Math.PI * 2, 0, Math.PI * 0.33);
  dish.rotateX(Math.PI * 0.72);
  dish.translate(0, 0.85, 0.1);
  dish.deleteAttribute('uv');
  p.add('metalPanel', dish);
  const mast = chamferCyl(0.035, 0.045, 0.85, { origin: 'center', seg: 8, uvScale: 0.3 });
  mast.translate(0, 0.425, 0);
  p.add('gunmetal', mast, true);
  const arm = chamferCyl(0.018, 0.018, 0.42, { origin: 'center', seg: 6, uvScale: 0.2 });
  arm.rotateX(Math.PI / 2);
  arm.translate(0, 0.85, 0.32);
  p.add('gunmetal', arm, true);
  p.solid(0, 0.5, 0, 0.1, 0.5, 0.1, 'gunmetal');
  return p;
}

/** Concrete planter with a scruffy dry shrub. */
export function planter(rng = Math.random) {
  const p = new Piece();
  const r = T(rng);
  const box = chamferBox(1.1, 0.62, 1.1, { uvScale: 0.6, origin: 'base', chamfer: 0.035, ao: 0.25 });
  p.add('concrete', box);
  const rim = chamferBox(1.2, 0.1, 1.2, { uvScale: 0.5, chamfer: 0.02 });
  rim.translate(0, 0.6, 0);
  p.add('concrete', rim, true);
  const soil = chamferBox(0.95, 0.06, 0.95, { uvScale: 0.4, chamfer: 0.01 });
  soil.translate(0, 0.6, 0);
  p.add('gravel', soil, true);
  // Foliage as crossed alpha cards — cheap, and reads well at any distance.
  for (let i = 0; i < 5; i++) {
    const card = new THREE.PlaneGeometry(0.8, 0.9);
    card.rotateY(r(0, Math.PI));
    card.rotateZ(r(-0.3, 0.3));
    card.translate(r(-0.2, 0.2), 0.95 + r(-0.1, 0.2), r(-0.2, 0.2));
    p.add('foliage', card, true);
  }
  p.solid(0, 0.33, 0, 0.58, 0.33, 0.58, 'concrete');
  return p;
}

/** Streetlight: post, curved arm, luminaire. */
export function streetlight() {
  const p = new Piece();
  const H = 5.2;
  const post = chamferCyl(0.075, 0.095, H, { origin: 'center', seg: 10, uvScale: 0.6 });
  post.translate(0, H * 0.5, 0);
  p.add('gunmetal', post);
  const base = chamferCyl(0.16, 0.19, 0.35, { origin: 'center', seg: 10, uvScale: 0.3 });
  base.translate(0, 0.175, 0);
  p.add('concrete', base, true);
  const arm = chamferCyl(0.05, 0.05, 1.1, { origin: 'center', seg: 8, uvScale: 0.3 });
  arm.rotateZ(Math.PI / 2);
  arm.translate(0.5, H - 0.12, 0);
  p.add('gunmetal', arm, true);
  const head = chamferBox(0.62, 0.13, 0.3, { uvScale: 0.3, chamfer: 0.03 });
  head.translate(1.0, H - 0.2, 0);
  p.add('metalPanel', head, true);
  p.solid(0, H * 0.5, 0, 0.12, H * 0.5, 0.12, 'gunmetal');
  return p;
}

/** Burnt-out car — a strong midfield silhouette and a piece of hard cover. */
export function burntCar(rng = Math.random) {
  const p = new Piece();
  const r = T(rng);
  const L = 4.3, W = 1.78;
  const body = chamferBox(L, 0.62, W, { uvScale: 1, chamfer: 0.06 });
  body.translate(0, 0.62, 0);
  p.add('rustMetal', body);
  const cabin = chamferBox(L * 0.48, 0.55, W - 0.16, { uvScale: 0.8, chamfer: 0.07 });
  cabin.translate(-0.18, 1.16, 0);
  p.add('rustMetal', cabin, true);
  const bonnet = chamferBox(L * 0.3, 0.16, W - 0.1, { uvScale: 0.8, chamfer: 0.04 });
  bonnet.translate(L * 0.31, 0.98, 0);
  p.add('rustMetal', bonnet, true);
  for (const sx of [-1, 1]) for (const sz of [-1, 1]) {
    const wheel = new THREE.TorusGeometry(0.31, 0.1, 6, 12);
    wheel.rotateY(Math.PI / 2);
    wheel.translate(sx * L * 0.33, 0.3, sz * (W * 0.5 - 0.06));
    wheel.deleteAttribute('uv');
    p.add('polymer', wheel, true);
  }
  // Blown-out window frames.
  for (const sz of [-1, 1]) {
    const frame = chamferBox(L * 0.44, 0.5, 0.03, { uvScale: 0.5, chamfer: 0.012 });
    frame.translate(-0.18, 1.18, sz * (W * 0.5 - 0.08));
    p.add('gunmetal', frame, true);
  }
  p.solid(0, 0.7, 0, L * 0.5, 0.7, W * 0.5, 'rustMetal');
  p.solid(-0.18, 1.3, 0, L * 0.24, 0.3, W * 0.45, 'rustMetal');
  return p;
}

/** Rubble pile — debris scatter that hides bare wall-floor junctions. */
export function rubble(rng = Math.random, scale = 1) {
  const p = new Piece();
  const r = T(rng);
  const n = 10 + Math.floor(rng() * 8);
  for (let i = 0; i < n; i++) {
    const s = r(0.06, 0.28) * scale;
    const g = chamferBox(s, s * r(0.4, 0.9), s * r(0.6, 1.2), { uvScale: 0.25, chamfer: 0.012 });
    g.rotateY(r(0, 6.28));
    g.rotateX(r(-0.5, 0.5));
    const rad = r(0, 0.75) * scale;
    const a = r(0, 6.28);
    g.translate(Math.cos(a) * rad, s * 0.3, Math.sin(a) * rad);
    p.add('concrete', g, true);
  }
  return p;   // no collision: it is ankle-height dressing
}

/** Café table and chairs. */
export function cafeSet(rng = Math.random) {
  const p = new Piece();
  const r = T(rng);
  const top = chamferCyl(0.36, 0.36, 0.045, { origin: 'center', seg: 14, uvScale: 0.3 });
  top.translate(0, 0.74, 0);
  p.add('metalPanel', top);
  const stem = chamferCyl(0.035, 0.05, 0.74, { origin: 'center', seg: 8, uvScale: 0.2 });
  stem.translate(0, 0.37, 0);
  p.add('gunmetal', stem, true);
  const foot = chamferCyl(0.22, 0.24, 0.03, { origin: 'center', seg: 12, uvScale: 0.2 });
  foot.translate(0, 0.015, 0);
  p.add('gunmetal', foot, true);
  for (let i = 0; i < 2; i++) {
    const a = r(0, 6.28);
    const cx = Math.cos(a) * 0.72, cz = Math.sin(a) * 0.72;
    const seat = chamferBox(0.4, 0.04, 0.4, { uvScale: 0.25, chamfer: 0.01 });
    seat.rotateY(-a);
    seat.translate(cx, 0.45, cz);
    p.add('polymer', seat, true);
    const back = chamferBox(0.4, 0.42, 0.04, { uvScale: 0.25, chamfer: 0.01 });
    back.rotateY(-a);
    back.translate(cx + Math.cos(a) * 0.18, 0.66, cz + Math.sin(a) * 0.18);
    p.add('polymer', back, true);
    for (const sx of [-1, 1]) for (const sz of [-1, 1]) {
      const leg = chamferBox(0.03, 0.45, 0.03, { uvScale: 0.2, origin: 'base', chamfer: 0.006 });
      leg.translate(cx + sx * 0.16, 0, cz + sz * 0.16);
      p.add('gunmetal', leg, true);
    }
  }
  p.solid(0, 0.37, 0, 0.36, 0.37, 0.36, 'metalPanel');
  return p;
}

/** Dry palm — vertical accent for the plaza. */
export function palm(rng = Math.random) {
  const p = new Piece();
  const r = T(rng);
  const H = r(4.2, 6.0);
  const seg = 7;
  for (let i = 0; i < seg; i++) {
    const t = i / seg;
    const rr = 0.16 * (1 - t * 0.45);
    const s = chamferCyl(rr, rr * 1.08, H / seg + 0.02, { origin: 'center', seg: 7, uvScale: 0.5 });
    s.translate(Math.sin(t * 2.1) * 0.22, H * (t + 0.5 / seg), Math.cos(t * 1.7) * 0.14);
    p.add('wood', s);
  }
  for (let i = 0; i < 7; i++) {
    const a = (i / 7) * Math.PI * 2 + r(-0.2, 0.2);
    const frond = new THREE.PlaneGeometry(2.6, 0.72);
    frond.translate(1.3, 0, 0);
    frond.rotateZ(r(-0.55, -0.05));
    frond.rotateY(a);
    frond.translate(Math.sin(1) * 0.22, H - 0.15, Math.cos(1) * 0.14);
    p.add('foliage', frond, true);
  }
  p.solid(0, H * 0.5, 0, 0.2, H * 0.5, 0.2, 'wood');
  return p;
}

/** Fishing boat hull moored at the quay. */
export function fishingBoat(rng = Math.random) {
  const p = new Piece();
  const L = 8.4, W = 2.6, H = 1.7;
  const profile = [
    [-L * 0.5, -W * 0.28], [-L * 0.32, -W * 0.5], [L * 0.22, -W * 0.5],
    [L * 0.5, 0], [L * 0.22, W * 0.5], [-L * 0.32, W * 0.5], [-L * 0.5, W * 0.28],
  ];
  const hull = extrudeProfile(profile, H, { uvScale: 1.4, chamfer: 0.05 });
  p.add('wood', hull);
  const deck = chamferBox(L * 0.86, 0.1, W * 0.84, { uvScale: 1, chamfer: 0.02 });
  deck.translate(0, H, 0);
  p.add('plywood', deck, true);
  const cabin = chamferBox(2.0, 1.5, W * 0.66, { uvScale: 0.8, origin: 'base', chamfer: 0.04 });
  cabin.translate(-L * 0.22, H + 0.05, 0);
  p.add('plywood', cabin, true);
  const mast = chamferCyl(0.06, 0.075, 4.2, { origin: 'center', seg: 8, uvScale: 0.5 });
  mast.translate(L * 0.05, H + 2.1, 0);
  p.add('wood', mast, true);
  for (const sz of [-1, 1]) {
    const rail = chamferBox(L * 0.8, 0.07, 0.07, { uvScale: 0.5, chamfer: 0.012 });
    rail.translate(0, H + 0.5, sz * W * 0.4);
    p.add('gunmetal', rail, true);
  }
  p.solid(0, H * 0.5, 0, L * 0.5, H * 0.5, W * 0.5, 'wood');
  p.solid(-L * 0.22, H + 0.8, 0, 1.0, 0.75, W * 0.33, 'plywood');
  return p;
}

/** Quayside crane — the map's landmark, visible from everywhere. */
export function crane() {
  const p = new Piece();
  const H = 12.5;
  for (const sx of [-1, 1]) for (const sz of [-1, 1]) {
    const leg = chamferBox(0.26, H, 0.26, { uvScale: 1, origin: 'base', chamfer: 0.02 });
    leg.translate(sx * 1.5, 0, sz * 1.5);
    p.add('rustMetal', leg);
    p.solid(sx * 1.5, H * 0.5, sz * 1.5, 0.2, H * 0.5, 0.2, 'rustMetal');
  }
  // Lattice bracing.
  for (let y = 1.6; y < H; y += 2.2) {
    for (const [ax, sgn] of [[0, -1], [0, 1], [1, -1], [1, 1]]) {
      const brace = chamferBox(ax ? 3.0 : 0.12, 0.12, ax ? 0.12 : 3.0, { uvScale: 0.5, chamfer: 0.012 });
      brace.translate(ax ? 0 : sgn * 1.5, y, ax ? sgn * 1.5 : 0);
      p.add('rustMetal', brace, true);
    }
  }
  const jib = chamferBox(11, 0.5, 0.7, { uvScale: 1.2, chamfer: 0.03 });
  jib.translate(3.2, H + 0.4, 0);
  p.add('rustMetal', jib, true);
  const counter = chamferBox(2.4, 1.0, 1.4, { uvScale: 0.8, chamfer: 0.04 });
  counter.translate(-3.4, H + 0.5, 0);
  p.add('metalPanel', counter, true);
  const cable = chamferCyl(0.03, 0.03, 6.4, { origin: 'center', seg: 5, uvScale: 0.4 });
  cable.translate(7.4, H - 2.8, 0);
  p.add('gunmetal', cable, true);
  const hook = chamferBox(0.4, 0.55, 0.4, { uvScale: 0.3, chamfer: 0.03 });
  hook.translate(7.4, H - 6.2, 0);
  p.add('gunmetal', hook, true);
  return p;
}

/** Warehouse catwalk section with grating and handrails. */
export function catwalk(len = 6) {
  const p = new Piece();
  const deck = chamferBox(len, 0.08, 1.3, { uvScale: 0.8, chamfer: 0.012 });
  p.add('metalPanel', deck);
  for (const sz of [-1, 1]) {
    for (let i = 0; i <= Math.round(len / 1.5); i++) {
      const post = chamferCyl(0.024, 0.024, 1.0, { origin: 'center', seg: 6, uvScale: 0.3 });
      post.translate(-len * 0.5 + (len * i) / Math.round(len / 1.5), 0.5, sz * 0.62);
      p.add('gunmetal', post, true);
    }
    for (const y of [0.98, 0.52]) {
      const rail = chamferBox(len, 0.045, 0.045, { uvScale: 0.4, chamfer: 0.008 });
      rail.translate(0, y, sz * 0.62);
      p.add('gunmetal', rail, true);
    }
    const kick = chamferBox(len, 0.12, 0.03, { uvScale: 0.3, chamfer: 0.006 });
    kick.translate(0, 0.1, sz * 0.63);
    p.add('metalPanel', kick, true);
  }
  p.solid(0, 0, 0, len * 0.5, 0.06, 0.65, 'metalPanel');
  for (const sz of [-1, 1]) p.solid(0, 0.5, sz * 0.62, len * 0.5, 0.5, 0.05, 'gunmetal');
  return p;
}

/** Shelving unit for interiors. */
export function shelf(rng = Math.random) {
  const p = new Piece();
  const r = T(rng);
  const W = 1.6, H = 2.0, D = 0.5;
  for (const sx of [-1, 1]) for (const sz of [-1, 1]) {
    const post = chamferBox(0.05, H, 0.05, { uvScale: 0.3, origin: 'base', chamfer: 0.008 });
    post.translate(sx * (W * 0.5 - 0.04), 0, sz * (D * 0.5 - 0.04));
    p.add('metalPanel', post);
  }
  for (let i = 0; i < 4; i++) {
    const board = chamferBox(W, 0.035, D, { uvScale: 0.4, chamfer: 0.008 });
    board.translate(0, 0.28 + i * 0.55, 0);
    p.add('plywood', board);
    if (rng() < 0.7) {
      const bx = chamferBox(r(0.2, 0.42), r(0.16, 0.3), r(0.22, 0.4), { uvScale: 0.25, origin: 'base', chamfer: 0.01 });
      bx.rotateY(r(-0.25, 0.25));
      bx.translate(r(-0.4, 0.4), 0.3 + i * 0.55, 0);
      p.add('crate', bx, true);
    }
  }
  p.solid(0, H * 0.5, 0, W * 0.5, H * 0.5, D * 0.5, 'metalPanel');
  return p;
}

/** Hanging laundry line with cloth. */
export function laundry(rng = Math.random, len = 4) {
  const p = new Piece();
  const r = T(rng);
  const n = Math.max(2, Math.floor(len / 0.9));
  for (let i = 0; i < n; i++) {
    const w = r(0.5, 0.8), h = r(0.6, 1.1);
    const cloth = clothSheet(w, h, { sag: 0.06, nx: 4, ny: 4, uvScale: 0.8, rng, ripple: 0.05 });
    cloth.rotateY(r(-0.2, 0.2));
    cloth.translate(-len * 0.5 + (len * (i + 0.5)) / n, -h * 0.5 - 0.04, 0);
    p.add('canvasTarp', cloth, true);
  }
  return p;
}
