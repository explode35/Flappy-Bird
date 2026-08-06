/**
 * ============================================================================
 *  Albedo painting helpers — Operation Blackout
 * ============================================================================
 *  Albedo lives in a Uint8ClampedArray of RGB triplets, authored directly in
 *  sRGB byte space (the space it is uploaded in, and the space the palette in
 *  ART_DIRECTION.md is quoted in). These are the only functions that touch it,
 *  so every generator paints the same way.
 * ============================================================================
 */

import { rgb, clamp01 } from './layers.js';

/** Allocate the standard map set for a surface. */
export function makeMaps(w, h) {
  return {
    w, h,
    albedo: new Uint8ClampedArray(w * h * 3),
    height: new Float32Array(w * h),
    rough: new Float32Array(w * h),
    ao: null,
    metal: 0,
    alpha: null,
    normalStrength: 1.6,
  };
}

/** Flat fill. */
export function fillRgb(alb, hex) {
  const c = rgb(hex);
  for (let i = 0; i < alb.length; i += 3) { alb[i] = c[0]; alb[i + 1] = c[1]; alb[i + 2] = c[2]; }
  return alb;
}

/**
 * Paint from a 256-entry LUT indexed by a [0,1] field. This is how base
 * colour variation gets in: one field, one ramp, zero branching.
 */
export function paintLUT(alb, t, lut) {
  const n = t.length;
  for (let i = 0, j = 0; i < n; i++, j += 3) {
    let k = (t[i] * 255) | 0;
    k = k < 0 ? 0 : k > 255 ? 255 : k;
    const o = k * 3;
    alb[j] = lut[o]; alb[j + 1] = lut[o + 1]; alb[j + 2] = lut[o + 2];
  }
  return alb;
}

/** Lerp toward a solid colour by a mask. */
export function tint(alb, mask, hex, amount = 1) {
  const c = rgb(hex);
  const n = mask.length;
  for (let i = 0, j = 0; i < n; i++, j += 3) {
    const m = mask[i] * amount;
    if (m <= 0) continue;
    alb[j] += (c[0] - alb[j]) * m;
    alb[j + 1] += (c[1] - alb[j + 1]) * m;
    alb[j + 2] += (c[2] - alb[j + 2]) * m;
  }
  return alb;
}

/** Lerp toward a per-pixel colour taken from a LUT and a second field. */
export function tintLUT(alb, mask, t, lut, amount = 1) {
  const n = mask.length;
  for (let i = 0, j = 0; i < n; i++, j += 3) {
    const m = mask[i] * amount;
    if (m <= 0) continue;
    let k = (t[i] * 255) | 0; k = k < 0 ? 0 : k > 255 ? 255 : k;
    const o = k * 3;
    alb[j] += (lut[o] - alb[j]) * m;
    alb[j + 1] += (lut[o + 1] - alb[j + 1]) * m;
    alb[j + 2] += (lut[o + 2] - alb[j + 2]) * m;
  }
  return alb;
}

/** Multiply brightness by (1 + k*(field-pivot)) — value noise into albedo. */
export function modulate(alb, f, k, pivot = 0.5) {
  const n = f.length;
  for (let i = 0, j = 0; i < n; i++, j += 3) {
    const s = 1 + (f[i] - pivot) * k;
    alb[j] *= s; alb[j + 1] *= s; alb[j + 2] *= s;
  }
  return alb;
}

/** Darken by a mask (grime, AO bake-in, cavity). */
export function darken(alb, mask, amount = 0.5) {
  const n = mask.length;
  for (let i = 0, j = 0; i < n; i++, j += 3) {
    const s = 1 - mask[i] * amount;
    alb[j] *= s; alb[j + 1] *= s; alb[j + 2] *= s;
  }
  return alb;
}

/** Lighten by a mask (edge wear, sun bleach, dust). */
export function lighten(alb, mask, amount = 0.3) {
  const n = mask.length;
  for (let i = 0, j = 0; i < n; i++, j += 3) {
    const m = mask[i] * amount;
    alb[j] += (255 - alb[j]) * m;
    alb[j + 1] += (255 - alb[j + 1]) * m;
    alb[j + 2] += (255 - alb[j + 2]) * m;
  }
  return alb;
}

/**
 * Pull saturation toward/away from luma. ART_DIRECTION §3: nothing in the
 * world exceeds ~55% saturation, so every generator ends with a desat pass.
 */
export function saturate(alb, k) {
  for (let j = 0; j < alb.length; j += 3) {
    const r = alb[j], g = alb[j + 1], b = alb[j + 2];
    const l = r * 0.2126 + g * 0.7152 + b * 0.0722;
    alb[j] = l + (r - l) * k;
    alb[j + 1] = l + (g - l) * k;
    alb[j + 2] = l + (b - l) * k;
  }
  return alb;
}

/** Clamp overall HSL-ish saturation to a ceiling without killing hue. */
export function capSaturation(alb, maxSat = 0.55) {
  for (let j = 0; j < alb.length; j += 3) {
    const r = alb[j], g = alb[j + 1], b = alb[j + 2];
    const mx = r > g ? (r > b ? r : b) : (g > b ? g : b);
    const mn = r < g ? (r < b ? r : b) : (g < b ? g : b);
    if (mx <= 0) continue;
    const s = (mx - mn) / mx;
    if (s <= maxSat) continue;
    const k = maxSat / s;
    const l = r * 0.2126 + g * 0.7152 + b * 0.0722;
    alb[j] = l + (r - l) * k;
    alb[j + 1] = l + (g - l) * k;
    alb[j + 2] = l + (b - l) * k;
  }
  return alb;
}

/**
 * Roughness composition. Start from a base, then push it around with masks.
 * `rough` is written in place.
 */
export function roughBase(rough, v) { rough.fill(v); return rough; }

/** rough += (target - rough) * mask * amount */
export function roughTo(rough, mask, target, amount = 1) {
  for (let i = 0; i < rough.length; i++) {
    const m = mask[i] * amount;
    if (m <= 0) continue;
    rough[i] += (target - rough[i]) * m;
  }
  return rough;
}

/** rough += (field - 0.5) * amount — the mandatory ±0.12 breakup. */
export function roughJitter(rough, f, amount) {
  for (let i = 0; i < rough.length; i++) rough[i] += (f[i] - 0.5) * amount;
  return rough;
}

export function clampRough(rough, lo = 0.04, hi = 1) {
  for (let i = 0; i < rough.length; i++) { const v = rough[i]; rough[i] = v < lo ? lo : v > hi ? hi : v; }
  return rough;
}

/** Metalness field helper — most surfaces are 0, metals are masked. */
export function metalFrom(mask, hi = 1, lo = 0) {
  const out = new Float32Array(mask.length);
  for (let i = 0; i < mask.length; i++) out[i] = lo + (hi - lo) * mask[i];
  return out;
}

export { clamp01 };
