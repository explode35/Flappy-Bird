/**
 * ============================================================================
 *  fx/Noise.js — CPU noise helpers used only at load time to bake textures.
 * ============================================================================
 *  Never called per frame. Zero dependencies.
 */

/** 32-bit integer hash -> [0,1) */
export function ihash(x, y, s) {
  let h = Math.imul(x | 0, 374761393) ^ Math.imul(y | 0, 668265263) ^ Math.imul(s | 0, 1442695041);
  h = Math.imul(h ^ (h >>> 13), 1274126177);
  return ((h ^ (h >>> 16)) >>> 0) / 4294967296;
}

/** Bilinear, smoothstep-interpolated value noise. */
export function vnoise(x, y, s) {
  const xi = Math.floor(x), yi = Math.floor(y);
  const xf = x - xi, yf = y - yi;
  const u = xf * xf * (3 - 2 * xf);
  const v = yf * yf * (3 - 2 * yf);
  const a = ihash(xi, yi, s), b = ihash(xi + 1, yi, s);
  const c = ihash(xi, yi + 1, s), d = ihash(xi + 1, yi + 1, s);
  const ab = a + (b - a) * u;
  const cd = c + (d - c) * u;
  return ab + (cd - ab) * v;
}

/** Fractal brownian motion. Returns roughly [0,1]. */
export function fbm(x, y, s, oct = 4, lac = 2.03, gain = 0.5) {
  let amp = 0.5, freq = 1, sum = 0, norm = 0;
  for (let i = 0; i < oct; i++) {
    sum += amp * vnoise(x * freq, y * freq, s + i * 7919);
    norm += amp;
    amp *= gain; freq *= lac;
  }
  return sum / norm;
}

/** Ridged fbm — good for smoke filaments and flame licks. */
export function ridge(x, y, s, oct = 4) {
  let amp = 0.5, freq = 1, sum = 0, norm = 0;
  for (let i = 0; i < oct; i++) {
    const n = 1 - Math.abs(vnoise(x * freq, y * freq, s + i * 4093) * 2 - 1);
    sum += amp * n * n;
    norm += amp;
    amp *= 0.55; freq *= 2.11;
  }
  return sum / norm;
}

/** Cellular / worley F1 distance in [0,~1]. Chunky detail for chips & gravel. */
export function worley(x, y, s) {
  const xi = Math.floor(x), yi = Math.floor(y);
  let best = 8;
  for (let j = -1; j <= 1; j++) {
    for (let i = -1; i <= 1; i++) {
      const cx = xi + i, cy = yi + j;
      const px = cx + ihash(cx, cy, s);
      const py = cy + ihash(cx, cy, s + 1013);
      const dx = px - x, dy = py - y;
      const d = dx * dx + dy * dy;
      if (d < best) best = d;
    }
  }
  return Math.min(1, Math.sqrt(best));
}

export const clamp01 = (v) => (v < 0 ? 0 : v > 1 ? 1 : v);
export const smoothstep = (e0, e1, x) => {
  const t = clamp01((x - e0) / (e1 - e0));
  return t * t * (3 - 2 * t);
};
export const mix = (a, b, t) => a + (b - a) * t;

/** sRGB hex -> linear float triple, written into out[0..2]. */
export function hexToLinear(hex, out) {
  const r = ((hex >> 16) & 255) / 255;
  const g = ((hex >> 8) & 255) / 255;
  const b = (hex & 255) / 255;
  out[0] = r <= 0.04045 ? r / 12.92 : Math.pow((r + 0.055) / 1.055, 2.4);
  out[1] = g <= 0.04045 ? g / 12.92 : Math.pow((g + 0.055) / 1.055, 2.4);
  out[2] = b <= 0.04045 ? b / 12.92 : Math.pow((b + 0.055) / 1.055, 2.4);
  return out;
}
