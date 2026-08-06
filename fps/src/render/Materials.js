import * as THREE from 'three';
import {
  fbm, ridgedFbm, worley, valueNoise, gaussBlur, warpField, signed,
  normalizeField, contrastField, smoothstepField, clamp01, rng,
} from './textures/noise.js';
import {
  edgeWear, cavity, heightAO, grimeGradient, cornerGrime, streaks, scratches,
  cracks, speckle, pits, blotches, brickLattice, plankLattice, tileLattice,
  corrugation, weave, fibre, woodGrain, knots, rivets, rivetRow, rampLUT,
} from './textures/layers.js';
import {
  makeMaps, fillRgb, paintLUT, tint, tintLUT, modulate, darken, lighten,
  saturate, capSaturation, roughBase, roughTo, roughJitter, clampRough,
} from './textures/paint.js';

/**
 * Procedural PBR material library.
 *
 * Everything is generated in code — there is not a single image file in this
 * project. Each surface produces an albedo (sRGB), a Sobel-derived tangent
 * normal, and an ORM pack (r = AO, g = roughness, b = metalness) which three
 * reads through aoMap/roughnessMap/metalnessMap pointing at the same texture.
 *
 * A shared high-frequency detail normal is blended into every world material
 * via onBeforeCompile so surfaces still hold up with your face against them.
 *
 * See ART_DIRECTION.md §3 (palette) and §5 (material standard).
 */

// ---------------------------------------------------------------------------
//  Map -> GPU texture
// ---------------------------------------------------------------------------

function toTexture(bytes, w, h, srgb) {
  const t = new THREE.DataTexture(bytes, w, h, THREE.RGBAFormat);
  t.colorSpace = srgb ? THREE.SRGBColorSpace : THREE.NoColorSpace;
  t.wrapS = t.wrapT = THREE.RepeatWrapping;
  t.magFilter = THREE.LinearFilter;
  t.minFilter = THREE.LinearMipmapLinearFilter;
  t.generateMipmaps = true;
  t.needsUpdate = true;
  return t;
}

/** RGB triplets -> RGBA bytes (WebGL2 dislikes 3-byte row alignment). */
function rgbToRgba(src, w, h, alpha) {
  const out = new Uint8Array(w * h * 4);
  for (let i = 0, j = 0, k = 0; i < w * h; i++, j += 3, k += 4) {
    out[k] = src[j]; out[k + 1] = src[j + 1]; out[k + 2] = src[j + 2];
    out[k + 3] = alpha ? alpha[i] * 255 : 255;
  }
  return out;
}

/**
 * Sobel height -> tangent-space normal. Wraps at the edges so tiling stays
 * seamless, which a naive clamped Sobel would break.
 */
function normalFromHeight(height, w, h, strength) {
  const out = new Uint8Array(w * h * 4);
  const at = (x, y) => height[((y + h) % h) * w + ((x + w) % w)];
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const tl = at(x - 1, y - 1), t = at(x, y - 1), tr = at(x + 1, y - 1);
      const l = at(x - 1, y), r = at(x + 1, y);
      const bl = at(x - 1, y + 1), b = at(x, y + 1), br = at(x + 1, y + 1);
      const dx = (tr + 2 * r + br) - (tl + 2 * l + bl);
      const dy = (bl + 2 * b + br) - (tl + 2 * t + tr);
      let nx = -dx * strength, ny = -dy * strength, nz = 1;
      const inv = 1 / Math.sqrt(nx * nx + ny * ny + 1);
      nx *= inv; ny *= inv; nz *= inv;
      const i = (y * w + x) * 4;
      out[i] = (nx * 0.5 + 0.5) * 255;
      out[i + 1] = (ny * 0.5 + 0.5) * 255;
      out[i + 2] = (nz * 0.5 + 0.5) * 255;
      out[i + 3] = 255;
    }
  }
  return out;
}

/** ORM pack: r = AO, g = roughness, b = metalness. */
function packORM(ao, rough, metal, w, h) {
  const n = w * h;
  const out = new Uint8Array(n * 4);
  const mNum = typeof metal === 'number';
  for (let i = 0, k = 0; i < n; i++, k += 4) {
    out[k] = (ao ? ao[i] : 1) * 255;
    out[k + 1] = rough[i] * 255;
    out[k + 2] = (mNum ? metal : metal[i]) * 255;
    out[k + 3] = 255;
  }
  return out;
}

// ---------------------------------------------------------------------------
//  Surface generators
//
//  Each returns the `maps` bundle from makeMaps(). They compose from the layer
//  toolkit rather than hand-rolling loops, so they stay readable and share the
//  same wear/grime vocabulary.
// ---------------------------------------------------------------------------

const LUT = {
  concrete: rampLUT([[0, 0x6f6a63], [0.4, 0x8f8a80], [0.72, 0xa9a294], [1, 0xbdb5a6]]),
  plaster:  rampLUT([[0, 0x9c8f7c], [0.45, 0xbdae98], [0.8, 0xcbbba4], [1, 0xd8cab4]]),
  brick:    rampLUT([[0, 0x6b3a28], [0.35, 0x8f4a22], [0.7, 0xa35c33], [1, 0xb87146]]),
  asphalt:  rampLUT([[0, 0x2b2b2d], [0.5, 0x3c3c3e], [1, 0x51504e]]),
  sand:     rampLUT([[0, 0x9c8a6c], [0.5, 0xc0ad8a], [1, 0xd6c6a4]]),
  wood:     rampLUT([[0, 0x4a3524], [0.4, 0x6d4e33], [0.75, 0x8a6742], [1, 0xa6835a]]),
  metal:    rampLUT([[0, 0x54565a], [0.5, 0x6e6f72], [1, 0x8b8d90]]),
  rust:     rampLUT([[0, 0x4a2412], [0.4, 0x7a3d18], [0.75, 0xa15426], [1, 0xc4763a]]),
  gun:      rampLUT([[0, 0x1d1f22], [0.5, 0x2b2e33], [1, 0x3d4147]]),
  foliage:  rampLUT([[0, 0x3c4726], [0.45, 0x4a5734], [0.8, 0x6b7b4a], [1, 0x869160]]),
  tarp:     rampLUT([[0, 0x5a5344], [0.5, 0x7a7160], [1, 0x968b76]]),
};

function G(w, h) { return makeMaps(w, h); }

function genConcrete(w, h, seed, wall) {
  const m = G(w, h);
  const base = fbm(w, h, { period: wall ? 5 : 6, octaves: 6, seed, type: 'mix', warp: 0.25 });
  const grain = fbm(w, h, { period: 48, octaves: 3, seed: seed + 7 });
  const pit = pits(w, h, { count: wall ? 220 : 420, seed: seed + 3, radius: 2.4, radVar: 1.8, strength: 0.9 });
  const crk = cracks(w, h, { cells: wall ? 7 : 11, seed: seed + 11, width: 0.03, strength: 0.85, coverage: 0.5 });
  const agg = worley(w, h, 26, seed + 5).f1;

  for (let i = 0; i < m.height.length; i++) {
    m.height[i] = base[i] * 0.55 + grain[i] * 0.12 + agg[i] * 0.2 - pit[i] * 0.5 - crk[i] * 0.6;
  }
  normalizeField(m.height);

  paintLUT(m.albedo, base, LUT.concrete);
  modulate(m.albedo, grain, 0.22);
  tint(m.albedo, agg, 0xc9c3b6, 0.18);
  const grime = grimeGradient(w, h, { direction: wall ? 'down' : 'none', strength: wall ? 0.75 : 0.3, seed: seed + 13 });
  darken(m.albedo, grime, 0.42);
  if (wall) darken(m.albedo, streaks(w, h, { count: 34, seed: seed + 17, minLen: 0.12, maxLen: 0.55, width: 3 }), 0.3);
  const wear = edgeWear(m.height, w, h, { radius: 4, threshold: 0.02, amount: 0.8 });
  lighten(m.albedo, wear, 0.16);
  darken(m.albedo, crk, 0.55);

  roughBase(m.rough, 0.88);
  roughJitter(m.rough, base, 0.2);
  roughTo(m.rough, wear, 0.66, 0.7);
  roughTo(m.rough, grime, 0.96, 0.5);
  if (!wall) roughTo(m.rough, smoothstepField(base, 0.1, 0.34, new Float32Array(w * h)), 0.52, 0.4); // shallow damp patches
  clampRough(m.rough);

  m.ao = heightAO(m.height, w, h, { strength: 0.9 });
  m.normalStrength = wall ? 2.0 : 1.7;
  capSaturation(m.albedo, 0.4);
  return m;
}

function genBrick(w, h, seed) {
  const m = G(w, h);
  const lat = brickLattice(w, h, { rows: 12, cols: 5, mortar: 0.05, bevel: 0.1, seed });
  const varyLUT = fbm(w, h, { period: 3, octaves: 2, seed: seed + 2 });
  const rough = fbm(w, h, { period: 40, octaves: 4, seed: seed + 4 });
  const chip = pits(w, h, { count: 300, seed: seed + 6, radius: 3, radVar: 2, strength: 1 });

  for (let i = 0; i < m.height.length; i++) {
    m.height[i] = lat.mask[i] * 0.75 + rough[i] * 0.12 - chip[i] * 0.4;
  }
  normalizeField(m.height);

  // Per-brick colour comes from the lattice id, not a smooth field.
  const perBrick = new Float32Array(w * h);
  for (let i = 0; i < perBrick.length; i++) {
    const id = lat.id[i];
    perBrick[i] = ((Math.sin(id * 127.1) * 43758.5453) % 1 + 1) % 1;
  }
  paintLUT(m.albedo, perBrick, LUT.brick);
  modulate(m.albedo, rough, 0.24);
  tint(m.albedo, invert(lat.mask), 0xa79c8a, 0.92);      // mortar
  darken(m.albedo, grimeGradient(w, h, { direction: 'down', strength: 0.6, seed: seed + 9 }), 0.4);
  lighten(m.albedo, edgeWear(m.height, w, h, { radius: 3, threshold: 0.03 }), 0.2);
  darken(m.albedo, chip, 0.3);

  roughBase(m.rough, 0.8);
  roughTo(m.rough, invert(lat.mask), 0.97, 1);            // mortar is much rougher
  roughJitter(m.rough, perBrick, 0.16);
  roughJitter(m.rough, rough, 0.12);
  clampRough(m.rough);
  m.ao = heightAO(m.height, w, h, { strength: 1.1 });
  m.normalStrength = 2.6;
  capSaturation(m.albedo, 0.46);
  return m;
}

function genPlaster(w, h, seed) {
  const m = G(w, h);
  const base = fbm(w, h, { period: 4, octaves: 5, seed, type: 'mix', warp: 0.4 });
  const trowel = fbm(w, h, { period: 9, octaves: 3, seed: seed + 5, warp: 0.7, warpPeriod: 3 });
  const crk = cracks(w, h, { cells: 14, seed: seed + 8, width: 0.026, strength: 1, coverage: 0.6 });
  const spall = blotches(w, h, { period: 4, octaves: 4, seed: seed + 12, threshold: 0.62, softness: 0.1, warp: 1.2 });

  for (let i = 0; i < m.height.length; i++) {
    m.height[i] = base[i] * 0.3 + trowel[i] * 0.4 - crk[i] * 0.7 - spall[i] * 0.5;
  }
  normalizeField(m.height);

  paintLUT(m.albedo, base, LUT.plaster);
  modulate(m.albedo, trowel, 0.18);
  // Spalled patches expose the brick behind.
  tintLUT(m.albedo, spall, base, LUT.brick, 0.85);
  darken(m.albedo, crk, 0.5);
  darken(m.albedo, grimeGradient(w, h, { direction: 'down', strength: 0.85, seed: seed + 3 }), 0.45);
  darken(m.albedo, streaks(w, h, { count: 26, seed: seed + 21, minLen: 0.15, maxLen: 0.7, width: 4 }), 0.26);
  darken(m.albedo, cornerGrime(w, h, { strength: 0.7 }), 0.3);

  roughBase(m.rough, 0.82);
  roughJitter(m.rough, trowel, 0.18);
  roughTo(m.rough, spall, 0.95, 0.8);
  clampRough(m.rough);
  m.ao = heightAO(m.height, w, h, { strength: 0.85 });
  m.normalStrength = 1.5;
  capSaturation(m.albedo, 0.38);
  return m;
}

function genAsphalt(w, h, seed) {
  const m = G(w, h);
  const agg = worley(w, h, 40, seed).f1;
  const base = fbm(w, h, { period: 5, octaves: 5, seed: seed + 2, type: 'mix' });
  const crk = cracks(w, h, { cells: 8, seed: seed + 4, width: 0.045, strength: 1 });
  const patch = blotches(w, h, { period: 3, octaves: 4, seed: seed + 6, threshold: 0.58, softness: 0.18, warp: 1.4 });

  for (let i = 0; i < m.height.length; i++) {
    m.height[i] = agg[i] * 0.55 + base[i] * 0.3 - crk[i] * 0.8;
  }
  normalizeField(m.height);
  paintLUT(m.albedo, base, LUT.asphalt);
  tint(m.albedo, smoothstepField(agg, 0.5, 0.95, new Float32Array(w * h)), 0x6b6862, 0.4);   // exposed aggregate
  tint(m.albedo, patch, 0x24242a, 0.55);                            // tar repairs
  darken(m.albedo, crk, 0.6);
  lighten(m.albedo, speckle(w, h, { seed: seed + 9, scale: 2.2, blur: 0.6, contrast: 1.6 }), 0.3);

  roughBase(m.rough, 0.92);
  roughJitter(m.rough, base, 0.16);
  roughTo(m.rough, patch, 0.6, 0.7);   // fresh tar is smoother and catches highlights
  clampRough(m.rough);
  m.ao = heightAO(m.height, w, h, { strength: 1.0 });
  m.normalStrength = 1.9;
  capSaturation(m.albedo, 0.25);
  return m;
}

function genSand(w, h, seed, gravel) {
  const m = G(w, h);
  const dunes = fbm(w, h, { period: 6, octaves: 4, seed, warp: 0.5 });
  const ripple = fbm(w, h, { period: 30, octaves: 2, seed: seed + 3 });
  const stones = worley(w, h, gravel ? 34 : 60, seed + 5).f1;
  for (let i = 0; i < m.height.length; i++) {
    m.height[i] = dunes[i] * 0.4 + ripple[i] * 0.22 + (gravel ? stones[i] * 0.5 : stones[i] * 0.12);
  }
  normalizeField(m.height);
  paintLUT(m.albedo, dunes, LUT.sand);
  modulate(m.albedo, ripple, 0.2);
  if (gravel) {
    tint(m.albedo, smoothstepField(stones, 0.45, 0.9, new Float32Array(w * h)), 0x8b8175, 0.6);
    darken(m.albedo, invert(smoothstepField(stones, 0.1, 0.5, new Float32Array(w * h))), 0.25);
  }
  lighten(m.albedo, speckle(w, h, { seed: seed + 7, scale: 3, blur: 0.5, contrast: 1.4 }), 0.22);
  roughBase(m.rough, gravel ? 0.93 : 0.96);
  roughJitter(m.rough, dunes, 0.12);
  clampRough(m.rough);
  m.ao = heightAO(m.height, w, h, { strength: gravel ? 1.1 : 0.6 });
  m.normalStrength = gravel ? 2.2 : 1.2;
  capSaturation(m.albedo, 0.34);
  return m;
}

function genMetalPanel(w, h, seed, corrugated) {
  const m = G(w, h);
  const panel = corrugated
    ? corrugation(w, h, { ribs: 12, sharpness: 1.6, vertical: true, amplitude: 1 })
    : tileLattice(w, h, { n: 2, grout: 0.014, bevel: 0.03 }).mask;
  const grain = fbm(w, h, { period: 64, octaves: 2, seed: seed + 1 });
  const dent = blotches(w, h, { period: 3, octaves: 3, seed: seed + 4, threshold: 0.6, softness: 0.25, warp: 1 });
  const scr = scratches(w, h, { count: 90, seed: seed + 6, length: 0.16, width: 1.1 });
  const riv = corrugated
    ? rivets(w, h, { positions: [...rivetRow(0.06, 10), ...rivetRow(0.5, 10), ...rivetRow(0.94, 10)], radius: 3.5, seed })
    : rivets(w, h, { positions: [...rivetRow(0.06, 3, 0.08, 0.92), ...rivetRow(0.94, 3, 0.08, 0.92)], radius: 5, seed });

  for (let i = 0; i < m.height.length; i++) {
    m.height[i] = panel[i] * 0.6 + grain[i] * 0.05 - dent[i] * 0.25 + riv[i] * 0.35 - scr[i] * 0.1;
  }
  normalizeField(m.height);

  paintLUT(m.albedo, grain, LUT.metal);
  const rustMask = fbm(w, h, { period: 4, octaves: 5, seed: seed + 9, type: 'mix', warp: 0.6 });
  contrastField(rustMask, 2.6, 0.62);
  const rustPlace = new Float32Array(w * h);
  const grime = grimeGradient(w, h, { direction: 'down', strength: 1, seed: seed + 2 });
  for (let i = 0; i < rustPlace.length; i++) rustPlace[i] = clamp01(rustMask[i] * (0.35 + grime[i]));
  tintLUT(m.albedo, rustPlace, rustMask, LUT.rust, 0.9);
  darken(m.albedo, streaks(w, h, { count: 40, seed: seed + 13, minLen: 0.1, maxLen: 0.5, width: 3 }), 0.32);
  lighten(m.albedo, scr, 0.35);
  lighten(m.albedo, edgeWear(m.height, w, h, { radius: 3, threshold: 0.02 }), 0.25);

  roughBase(m.rough, 0.42);
  roughTo(m.rough, rustPlace, 0.95, 1);
  roughTo(m.rough, scr, 0.24, 0.8);
  roughJitter(m.rough, grain, 0.14);
  clampRough(m.rough, 0.12);

  const metal = new Float32Array(w * h);
  for (let i = 0; i < metal.length; i++) metal[i] = 1 - rustPlace[i] * 0.75;
  m.metal = metal;
  m.ao = heightAO(m.height, w, h, { strength: 0.9 });
  m.normalStrength = corrugated ? 3.0 : 1.8;
  capSaturation(m.albedo, 0.5);
  return m;
}

function genRustMetal(w, h, seed) {
  const m = genMetalPanel(w, h, seed, false);
  // Push the same generator much further into decay.
  const heavy = fbm(w, h, { period: 3, octaves: 6, seed: seed + 31, type: 'mix', warp: 0.8 });
  contrastField(heavy, 2.2, 0.45);
  tintLUT(m.albedo, heavy, heavy, LUT.rust, 0.85);
  roughTo(m.rough, heavy, 0.97, 0.9);
  const metal = m.metal;
  for (let i = 0; i < metal.length; i++) metal[i] *= 1 - heavy[i] * 0.8;
  const flake = pits(w, h, { count: 500, seed: seed + 33, radius: 3, radVar: 2, strength: 1 });
  for (let i = 0; i < m.height.length; i++) m.height[i] = clamp01(m.height[i] - flake[i] * 0.3);
  darken(m.albedo, flake, 0.35);
  m.normalStrength = 2.4;
  return m;
}

function genGunmetal(w, h, seed) {
  const m = G(w, h);
  const grain = fbm(w, h, { period: 90, octaves: 2, seed });
  const cast = fbm(w, h, { period: 26, octaves: 4, seed: seed + 2 });
  const scr = scratches(w, h, { count: 140, seed: seed + 4, length: 0.1, width: 0.9 });
  for (let i = 0; i < m.height.length; i++) m.height[i] = cast[i] * 0.5 + grain[i] * 0.3 - scr[i] * 0.2;
  normalizeField(m.height);
  paintLUT(m.albedo, cast, LUT.gun);
  lighten(m.albedo, scr, 0.42);
  lighten(m.albedo, edgeWear(m.height, w, h, { radius: 3, threshold: 0.015, amount: 1 }), 0.3);
  roughBase(m.rough, 0.46);
  roughJitter(m.rough, cast, 0.14);
  roughTo(m.rough, scr, 0.2, 0.9);
  clampRough(m.rough, 0.1);
  m.metal = 1;
  m.ao = heightAO(m.height, w, h, { strength: 0.7 });
  m.normalStrength = 1.1;
  return m;
}

function genPolymer(w, h, seed) {
  const m = G(w, h);
  const stipple = speckle(w, h, { seed, scale: 4, blur: 0.4, contrast: 1.8 });
  const base = fbm(w, h, { period: 20, octaves: 3, seed: seed + 2 });
  for (let i = 0; i < m.height.length; i++) m.height[i] = stipple[i] * 0.7 + base[i] * 0.2;
  normalizeField(m.height);
  fillRgb(m.albedo, 0x24262a);
  modulate(m.albedo, base, 0.3);
  lighten(m.albedo, stipple, 0.12);
  roughBase(m.rough, 0.68);
  roughTo(m.rough, stipple, 0.86, 0.7);
  roughJitter(m.rough, base, 0.1);
  clampRough(m.rough);
  m.ao = heightAO(m.height, w, h, { strength: 0.6 });
  m.normalStrength = 1.4;
  return m;
}

function genWood(w, h, seed, planks) {
  const m = G(w, h);
  const grain = woodGrain(w, h, { rings: planks ? 12 : 20, seed, wobble: 0.32, ringSharp: 2.6 });
  const kn = knots(w, h, { count: planks ? 4 : 6, seed: seed + 3, radius: 0.035 });
  const lat = planks ? plankLattice(w, h, { count: 5, gap: 0.012, bevel: 0.08, seed: seed + 5 }) : null;
  const scr = scratches(w, h, { count: 70, seed: seed + 7, length: 0.2, width: 1 });

  for (let i = 0; i < m.height.length; i++) {
    const l = lat ? lat.mask[i] : 1;
    m.height[i] = (grain[i] * 0.35 + kn[i] * 0.3) * l + l * 0.4 - scr[i] * 0.15;
  }
  normalizeField(m.height);
  paintLUT(m.albedo, grain, LUT.wood);
  darken(m.albedo, kn, 0.45);
  if (lat) {
    // Per-plank tonal variation, then darken the gaps.
    const perPlank = new Float32Array(w * h);
    for (let i = 0; i < perPlank.length; i++) perPlank[i] = ((Math.sin(lat.id[i] * 91.7) * 4318.5) % 1 + 1) % 1;
    modulate(m.albedo, perPlank, 0.28);
    darken(m.albedo, invert(lat.mask), 0.75);
  }
  lighten(m.albedo, scr, 0.22);
  darken(m.albedo, grimeGradient(w, h, { direction: 'down', strength: 0.5, seed: seed + 11 }), 0.3);
  roughBase(m.rough, 0.78);
  roughJitter(m.rough, grain, 0.18);
  roughTo(m.rough, kn, 0.6, 0.6);
  if (lat) roughTo(m.rough, invert(lat.mask), 0.95, 1);
  clampRough(m.rough);
  m.ao = heightAO(m.height, w, h, { strength: planks ? 1.1 : 0.8 });
  m.normalStrength = planks ? 2.2 : 1.6;
  capSaturation(m.albedo, 0.45);
  return m;
}

function genTile(w, h, seed) {
  const m = G(w, h);
  const lat = tileLattice(w, h, { n: 6, grout: 0.03, bevel: 0.02 });
  const speck = speckle(w, h, { seed, scale: 3, blur: 0.5, contrast: 1.5 });
  const wearF = fbm(w, h, { period: 4, octaves: 4, seed: seed + 3, type: 'mix' });
  for (let i = 0; i < m.height.length; i++) m.height[i] = lat.mask[i] * 0.8 + speck[i] * 0.08;
  normalizeField(m.height);
  fillRgb(m.albedo, 0xbdb2a0);
  modulate(m.albedo, wearF, 0.22);
  lighten(m.albedo, speck, 0.18);
  const perTile = new Float32Array(w * h);
  for (let i = 0; i < perTile.length; i++) perTile[i] = ((Math.sin(lat.id[i] * 57.3) * 2718.3) % 1 + 1) % 1;
  modulate(m.albedo, perTile, 0.16);
  tint(m.albedo, invert(lat.mask), 0x6e685e, 0.9);
  darken(m.albedo, cornerGrime(w, h, { strength: 0.8 }), 0.35);
  roughBase(m.rough, 0.34);
  roughTo(m.rough, invert(lat.mask), 0.95, 1);
  roughTo(m.rough, wearF, 0.7, 0.5);
  clampRough(m.rough, 0.1);
  m.ao = heightAO(m.height, w, h, { strength: 1.2 });
  m.normalStrength = 2.4;
  capSaturation(m.albedo, 0.3);
  return m;
}

function genFabric(w, h, seed, kind) {
  const m = G(w, h);
  const wv = weave(w, h, { threads: kind === 'sandbag' ? 26 : 48, thickness: 0.62, slub: 0.4, seed, depth: 1 });
  const fib = fibre(w, h, { period: 6, aniso: 24, octaves: 4, seed });
  const sag = fbm(w, h, { period: 5, octaves: 3, seed: seed + 2 });
  for (let i = 0; i < m.height.length; i++) m.height[i] = wv[i] * 0.6 + fib[i] * 0.15 + sag[i] * 0.25;
  normalizeField(m.height);
  paintLUT(m.albedo, sag, kind === 'sandbag' ? LUT.sand : LUT.tarp);
  modulate(m.albedo, wv, 0.26);
  darken(m.albedo, grimeGradient(w, h, { direction: 'down', strength: 0.8, seed: seed + 4 }), 0.4);
  lighten(m.albedo, fib, 0.16);
  roughBase(m.rough, 0.93);
  roughJitter(m.rough, wv, 0.1);
  clampRough(m.rough, 0.5);
  m.ao = heightAO(m.height, w, h, { strength: 0.9 });
  m.normalStrength = 2.0;
  capSaturation(m.albedo, 0.35);
  return m;
}

function genFoliage(w, h, seed) {
  const m = G(w, h);
  const leaf = fbm(w, h, { period: 8, octaves: 4, seed, type: 'mix', warp: 0.5 });
  const vein = ridgedFbm(w, h, { period: 14, octaves: 3, seed: seed + 3 });
  for (let i = 0; i < m.height.length; i++) m.height[i] = leaf[i] * 0.6 + vein[i] * 0.3;
  normalizeField(m.height);
  paintLUT(m.albedo, leaf, LUT.foliage);
  darken(m.albedo, vein, 0.22);
  // Alpha cut-out: a cluster of leaf blobs so the card reads as foliage.
  const alpha = new Float32Array(w * h);
  const blob = blotches(w, h, { period: 6, octaves: 4, seed: seed + 9, threshold: 0.5, softness: 0.06, warp: 1.5 });
  for (let i = 0; i < alpha.length; i++) alpha[i] = blob[i] > 0.42 ? 1 : 0;
  m.alpha = alpha;
  roughBase(m.rough, 0.72);
  roughJitter(m.rough, leaf, 0.16);
  clampRough(m.rough);
  m.ao = null;
  m.normalStrength = 1.4;
  capSaturation(m.albedo, 0.42);
  return m;
}

function invert(f) {
  const o = new Float32Array(f.length);
  for (let i = 0; i < f.length; i++) o[i] = 1 - f[i];
  return o;
}

// ---------------------------------------------------------------------------
//  Registry
// ---------------------------------------------------------------------------

const RECIPES = {
  concrete:    { gen: (w, h) => genConcrete(w, h, 11, false), surface: 'concrete' },
  concreteWall:{ gen: (w, h) => genConcrete(w, h, 23, true),  surface: 'concrete' },
  brick:       { gen: (w, h) => genBrick(w, h, 31),           surface: 'concrete' },
  plaster:     { gen: (w, h) => genPlaster(w, h, 41),         surface: 'concrete' },
  asphalt:     { gen: (w, h) => genAsphalt(w, h, 53),         surface: 'concrete' },
  sand:        { gen: (w, h) => genSand(w, h, 61, false),     surface: 'sand' },
  gravel:      { gen: (w, h) => genSand(w, h, 67, true),      surface: 'dirt' },
  metalPanel:  { gen: (w, h) => genMetalPanel(w, h, 71, false), surface: 'metal' },
  corrugated:  { gen: (w, h) => genMetalPanel(w, h, 73, true),  surface: 'metal' },
  rustMetal:   { gen: (w, h) => genRustMetal(w, h, 79),       surface: 'metal' },
  gunmetal:    { gen: (w, h) => genGunmetal(w, h, 83),        surface: 'metal' },
  polymer:     { gen: (w, h) => genPolymer(w, h, 89),         surface: 'metal' },
  wood:        { gen: (w, h) => genWood(w, h, 97, false),     surface: 'wood' },
  plywood:     { gen: (w, h) => genWood(w, h, 101, false),    surface: 'wood' },
  crate:       { gen: (w, h) => genWood(w, h, 103, true),     surface: 'wood' },
  tileFloor:   { gen: (w, h) => genTile(w, h, 107),           surface: 'concrete' },
  canvasTarp:  { gen: (w, h) => genFabric(w, h, 109, 'tarp'), surface: 'dirt' },
  sandbag:     { gen: (w, h) => genFabric(w, h, 113, 'sandbag'), surface: 'sand' },
  foliage:     { gen: (w, h) => genFoliage(w, h, 127),        surface: 'foliage' },
};

// ---------------------------------------------------------------------------

export class Materials {
  constructor(ctx) {
    this.ctx = ctx;
    this.cache = new Map();       // name -> base material
    this.tiled = new Map();       // "name|sx|sy" -> cloned material
    this.surfaceByUUID = new Map();
    this.progress = 0;
    this.onCreated = null;
    this.res = ctx.quality.tier >= 2 ? 512 : 256;
    this.detailNormal = null;
    this.detailScale = 12;
    this.detailStrength = 0.55;
  }

  async init() {
    const t0 = performance.now();
    this.detailNormal = this._buildDetailNormal();

    const names = Object.keys(RECIPES);
    for (let i = 0; i < names.length; i++) {
      this._build(names[i]);
      this.progress = (i + 1) / names.length;
      // Yield so the loading screen can paint between surfaces.
      if (i % 2 === 1) await new Promise((r) => setTimeout(r, 0));
    }
    this.genMs = Math.round(performance.now() - t0);
    console.log(`[materials] ${names.length} surfaces @${this.res}² in ${this.genMs}ms`);
  }

  /** Fine-grain normal blended into every world material to kill close-up flatness. */
  _buildDetailNormal() {
    const n = 256;
    const a = fbm(n, n, { period: 26, octaves: 4, seed: 909, type: 'mix' });
    const b = worley(n, n, 48, 55).f1;
    const hgt = new Float32Array(n * n);
    for (let i = 0; i < hgt.length; i++) hgt[i] = a[i] * 0.6 + b[i] * 0.4;
    normalizeField(hgt);
    const tex = toTexture(normalFromHeight(hgt, n, n, 1.4), n, n, false);
    tex.anisotropy = 4;
    return tex;
  }

  _build(name) {
    const recipe = RECIPES[name];
    const res = this.res;
    const m = recipe.gen(res, res);

    const maxAniso = this.ctx.renderer.capabilities.getMaxAnisotropy?.() ?? 1;
    const aniso = Math.min(8, maxAniso);

    const albedoTex = toTexture(rgbToRgba(m.albedo, res, res, m.alpha), res, res, true);
    const normalTex = toTexture(normalFromHeight(m.height, res, res, m.normalStrength), res, res, false);
    const ormTex = toTexture(packORM(m.ao, m.rough, m.metal, res, res), res, res, false);
    albedoTex.anisotropy = normalTex.anisotropy = ormTex.anisotropy = aniso;

    const isFoliage = name === 'foliage';
    const isGlassy = false;

    const mat = new THREE.MeshStandardMaterial({
      map: albedoTex,
      normalMap: normalTex,
      normalScale: new THREE.Vector2(1, 1),
      roughnessMap: ormTex,
      metalnessMap: ormTex,
      aoMap: m.ao ? ormTex : null,
      aoMapIntensity: 1.0,
      roughness: 1,
      metalness: typeof m.metal === 'number' ? m.metal : 1,
      side: isFoliage ? THREE.DoubleSide : THREE.FrontSide,
      alphaTest: isFoliage ? 0.5 : 0,
      transparent: false,
      vertexColors: true,           // Level bakes AO + per-instance tint here
      envMapIntensity: 1.0,
      dithering: true,
    });
    mat.name = name;

    this._patch(mat, isFoliage);
    this.cache.set(name, mat);
    this.surfaceByUUID.set(mat.uuid, recipe.surface);
    if (this.onCreated) this.onCreated(mat, name);
    return mat;
  }

  /**
   * Inject the shared detail normal (reoriented-normal blend) and, for foliage,
   * a wrap-lighting term that fakes the light bleeding through a leaf.
   */
  _patch(mat, isFoliage) {
    const detail = this.detailNormal;
    const scale = this.detailScale;
    const strength = this.detailStrength;
    mat.onBeforeCompile = (shader) => {
      shader.uniforms.detailMap = { value: detail };
      shader.uniforms.detailScale = { value: scale };
      shader.uniforms.detailStrength = { value: strength };
      shader.fragmentShader = shader.fragmentShader
        .replace('#include <normalmap_pars_fragment>', `
          #include <normalmap_pars_fragment>
          uniform sampler2D detailMap;
          uniform float detailScale;
          uniform float detailStrength;
        `)
        .replace('#include <normal_fragment_maps>', `
          #ifdef USE_NORMALMAP_TANGENTSPACE
            vec3 mapN = texture2D( normalMap, vNormalMapUv ).xyz * 2.0 - 1.0;
            mapN.xy *= normalScale;
            vec3 detN = texture2D( detailMap, vNormalMapUv * detailScale ).xyz * 2.0 - 1.0;
            detN.xy *= detailStrength;
            // Reoriented normal mapping — correct, unlike a naive add.
            vec3 tN = mapN + vec3( 0.0, 0.0, 1.0 );
            vec3 uN = detN * vec3( -1.0, -1.0, 1.0 );
            mapN = normalize( tN * dot( tN, uN ) / max( tN.z, 1e-4 ) - uN );
            #ifdef USE_TANGENT
              normal = normalize( vTBN * mapN );
            #else
              normal = normalize( tbn * mapN );
            #endif
          #else
            #include <normal_fragment_maps>
          #endif
        `);
      if (isFoliage) {
        shader.fragmentShader = shader.fragmentShader.replace(
          '#include <lights_fragment_end>',
          `#include <lights_fragment_end>
           reflectedLight.indirectDiffuse += diffuseColor.rgb * 0.22;`
        );
      }
      mat.userData.shader = shader;
    };
    // Distinct cache key so three doesn't share a program with unpatched mats.
    mat.customProgramCacheKey = () => 'ob-detail-' + (isFoliage ? 'f' : 'w');
  }

  get(name) {
    let m = this.cache.get(name);
    if (!m) {
      console.warn(`[materials] unknown surface "${name}", falling back to concrete`);
      m = this.cache.get('concrete') || this._build('concrete');
    }
    return m;
  }

  getTiled(name, sx = 1, sy = sx) {
    const key = `${name}|${sx}|${sy}`;
    let m = this.tiled.get(key);
    if (m) return m;
    const base = this.get(name);
    m = base.clone();
    // Clone the textures too — repeat lives on the texture, not the material.
    for (const slot of ['map', 'normalMap', 'roughnessMap', 'metalnessMap', 'aoMap']) {
      const t = base[slot];
      if (!t) continue;
      const c = t.clone();
      c.repeat.set(sx, sy);
      c.wrapS = c.wrapT = THREE.RepeatWrapping;
      c.needsUpdate = true;
      m[slot] = c;
    }
    m.name = key;
    this._patch(m, name === 'foliage');
    this.tiled.set(key, m);
    this.surfaceByUUID.set(m.uuid, this.surfaceByUUID.get(base.uuid) || 'concrete');
    return m;
  }

  surfaceOf(material) {
    if (!material) return 'concrete';
    if (Array.isArray(material)) return this.surfaceOf(material[0]);
    return this.surfaceByUUID.get(material.uuid) || 'concrete';
  }

  update() { /* materials are static once generated */ }
}
