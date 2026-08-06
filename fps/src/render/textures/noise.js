/**
 * ============================================================================
 *  Procedural noise toolkit — Operation Blackout
 * ============================================================================
 *  Everything here is *tileable*. Every generator works on an integer lattice
 *  whose period divides the output width/height exactly, and every lattice
 *  lookup wraps with `% P`, so a field generated at (w,h) tiles seamlessly
 *  against itself in both axes. Visible seams are a hard fail, so there is no
 *  "almost tileable" path in this module — the wrap is structural.
 *
 *  Fields are plain `Float32Array`s of length w*h, row-major, row 0 = v=0
 *  (matches THREE.DataTexture with flipY = false).
 *
 *  Zero dependencies. Runs identically in a browser, a worker, or node.
 * ============================================================================
 */

export const TAU = Math.PI * 2;

export const clamp01 = (v) => (v < 0 ? 0 : v > 1 ? 1 : v);
export const clamp = (v, a, b) => (v < a ? a : v > b ? b : v);
export const lerp = (a, b, t) => a + (b - a) * t;
export const smoothstep = (e0, e1, x) => {
  const t = clamp01((x - e0) / (e1 - e0));
  return t * t * (3 - 2 * t);
};
/** Quintic fade — C2 continuous, kills the grid-aligned crease of a cubic. */
export const fade = (t) => t * t * t * (t * (t * 6 - 15) + 10);

/** Mulberry32 — deterministic PRNG, same algorithm as core/Contracts.js. */
export function rng(seed = 1) {
  let a = seed >>> 0;
  return function () {
    a |= 0; a = (a + 0x6D2B79F5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** 2D integer hash -> [0,1). Avalanches well enough for lattice noise. */
export function hash2(x, y, seed) {
  let h = Math.imul(x | 0, 0x27d4eb2d) ^ Math.imul(y | 0, 0x165667b1) ^ Math.imul(seed | 0, 0x9e3779b1);
  h = Math.imul(h ^ (h >>> 15), 0x85ebca6b);
  h = Math.imul(h ^ (h >>> 13), 0xc2b2ae35);
  return ((h ^ (h >>> 16)) >>> 0) / 4294967296;
}

// ---------------------------------------------------------------------------
//  Field allocation / basic array math
// ---------------------------------------------------------------------------

export const field = (w, h, v = 0) => {
  const f = new Float32Array(w * h);
  if (v !== 0) f.fill(v);
  return f;
};

/** out = a + b*s   (in place on `a`) */
export function addScaled(a, b, s = 1) {
  for (let i = 0; i < a.length; i++) a[i] += b[i] * s;
  return a;
}
/** a *= b (in place) */
export function mulField(a, b) {
  for (let i = 0; i < a.length; i++) a[i] *= b[i];
  return a;
}
/** a = lerp(a, b, t) with scalar or field t */
export function mixField(a, b, t) {
  if (typeof t === 'number') { for (let i = 0; i < a.length; i++) a[i] += (b[i] - a[i]) * t; }
  else { for (let i = 0; i < a.length; i++) a[i] += (b[i] - a[i]) * t[i]; }
  return a;
}
/** a = max(a,b) */
export function maxField(a, b) {
  for (let i = 0; i < a.length; i++) if (b[i] > a[i]) a[i] = b[i];
  return a;
}
/** a = min(a,b) */
export function minField(a, b) {
  for (let i = 0; i < a.length; i++) if (b[i] < a[i]) a[i] = b[i];
  return a;
}
export function scaleBias(a, s, b = 0) {
  for (let i = 0; i < a.length; i++) a[i] = a[i] * s + b;
  return a;
}
export function clampField(a, lo = 0, hi = 1) {
  for (let i = 0; i < a.length; i++) { const v = a[i]; a[i] = v < lo ? lo : v > hi ? hi : v; }
  return a;
}
/** Rescale so min->0 and max->1. Guards against flat fields. */
export function normalizeField(a) {
  let lo = Infinity, hi = -Infinity;
  for (let i = 0; i < a.length; i++) { const v = a[i]; if (v < lo) lo = v; if (v > hi) hi = v; }
  const d = hi - lo;
  if (d < 1e-9) { a.fill(0.5); return a; }
  const inv = 1 / d;
  for (let i = 0; i < a.length; i++) a[i] = (a[i] - lo) * inv;
  return a;
}
/** Contrast about a pivot. k>1 hardens, k<1 softens. */
export function contrastField(a, k, pivot = 0.5) {
  for (let i = 0; i < a.length; i++) a[i] = (a[i] - pivot) * k + pivot;
  return a;
}
/** Per-element smoothstep remap — the workhorse for turning noise into masks. */
export function smoothstepField(a, e0, e1, out) {
  out = out || a;
  const inv = 1 / (e1 - e0);
  for (let i = 0; i < a.length; i++) {
    let t = (a[i] - e0) * inv;
    t = t < 0 ? 0 : t > 1 ? 1 : t;
    out[i] = t * t * (3 - 2 * t);
  }
  return out;
}
export function powField(a, p) {
  for (let i = 0; i < a.length; i++) a[i] = Math.pow(a[i] < 0 ? 0 : a[i], p);
  return a;
}
export const copyField = (a) => Float32Array.prototype.slice.call(a);

// ---------------------------------------------------------------------------
//  Sampling / resampling (always wrapping)
// ---------------------------------------------------------------------------

/** Bilinear sample with wrap. x,y in pixel units, may be out of range. */
export function sampleWrap(src, w, h, x, y) {
  let x0 = Math.floor(x), y0 = Math.floor(y);
  const fx = x - x0, fy = y - y0;
  x0 = ((x0 % w) + w) % w; y0 = ((y0 % h) + h) % h;
  const x1 = x0 + 1 === w ? 0 : x0 + 1;
  const y1 = y0 + 1 === h ? 0 : y0 + 1;
  const r0 = y0 * w, r1 = y1 * w;
  const a = src[r0 + x0], b = src[r0 + x1], c = src[r1 + x0], d = src[r1 + x1];
  const t = a + (b - a) * fx, u = c + (d - c) * fx;
  return t + (u - t) * fy;
}

/** Resample a field to a new resolution (smooth, wrapping). */
export function resampleField(src, sw, sh, dw, dh, out) {
  out = out || new Float32Array(dw * dh);
  const sx = sw / dw, sy = sh / dh;
  for (let y = 0; y < dh; y++) {
    const fy = (y + 0.5) * sy - 0.5;
    const o = y * dw;
    for (let x = 0; x < dw; x++) out[o + x] = sampleWrap(src, sw, sh, (x + 0.5) * sx - 0.5, fy);
  }
  return out;
}

/**
 * Domain warp by resampling `src` with per-pixel offsets taken from two
 * signed fields. This is the tileable equivalent of `noise(p + noise(p))` and
 * is far cheaper than re-evaluating noise at warped coordinates.
 */
export function warpField(src, w, h, dx, dy, amount, out) {
  out = out || new Float32Array(w * h);
  for (let y = 0; y < h; y++) {
    const o = y * w;
    for (let x = 0; x < w; x++) {
      const i = o + x;
      out[i] = sampleWrap(src, w, h, x + dx[i] * amount, y + dy[i] * amount);
    }
  }
  return out;
}

// ---------------------------------------------------------------------------
//  Blur — separable box; three passes approximate a Gaussian to within ~3%.
// ---------------------------------------------------------------------------

function boxBlurH(src, dst, w, h, r) {
  const norm = 1 / (r * 2 + 1);
  for (let y = 0; y < h; y++) {
    const o = y * w;
    let acc = 0;
    for (let k = -r; k <= r; k++) acc += src[o + (((k % w) + w) % w)];
    for (let x = 0; x < w; x++) {
      dst[o + x] = acc * norm;
      const outIdx = (x - r + w) % w;
      const inIdx = (x + r + 1) % w;
      acc += src[o + inIdx] - src[o + outIdx];
    }
  }
}

function boxBlurV(src, dst, w, h, r) {
  const norm = 1 / (r * 2 + 1);
  for (let x = 0; x < w; x++) {
    let acc = 0;
    for (let k = -r; k <= r; k++) acc += src[(((k % h) + h) % h) * w + x];
    for (let y = 0; y < h; y++) {
      dst[y * w + x] = acc * norm;
      const outIdx = (y - r + h) % h;
      const inIdx = (y + r + 1) % h;
      acc += src[inIdx * w + x] - src[outIdx * w + x];
    }
  }
}

/** Wrapping box blur, radius r. Returns a new field (or writes into `out`). */
export function boxBlur(src, w, h, r, out) {
  r = Math.max(0, Math.round(r));
  out = out || new Float32Array(w * h);
  if (r === 0) { out.set(src); return out; }
  const tmp = new Float32Array(w * h);
  boxBlurH(src, tmp, w, h, r);
  boxBlurV(tmp, out, w, h, r);
  return out;
}

/** Wrapping Gaussian-ish blur (3 box passes). sigma ~= r. */
export function gaussBlur(src, w, h, sigma, out) {
  const r = Math.max(1, Math.round(sigma * 0.62));
  const a = new Float32Array(w * h);
  const b = out || new Float32Array(w * h);
  const t = new Float32Array(w * h);
  boxBlurH(src, t, w, h, r); boxBlurV(t, a, w, h, r);
  boxBlurH(a, t, w, h, r); boxBlurV(t, b, w, h, r);
  boxBlurH(b, t, w, h, r); boxBlurV(t, b, w, h, r);
  return b;
}

// ---------------------------------------------------------------------------
//  Value noise
// ---------------------------------------------------------------------------

/**
 * Tileable value noise. `period` cells span the full width AND height, so the
 * field repeats exactly. Output in [0,1].
 *
 * Implementation note: the per-axis cell index and faded fraction are hoisted
 * into lookup tables so the inner loop is 4 loads + 3 lerps. At 1024² this is
 * a couple of milliseconds.
 */
export function valueNoise(w, h, period, seed, out) {
  out = out || new Float32Array(w * h);
  const P = Math.max(1, period | 0);
  const lat = new Float32Array(P * P);
  for (let y = 0; y < P; y++) for (let x = 0; x < P; x++) lat[y * P + x] = hash2(x, y, seed);

  const xi0 = new Int32Array(w), xi1 = new Int32Array(w), xf = new Float32Array(w);
  for (let x = 0; x < w; x++) {
    const fx = (x * P) / w; const i0 = Math.floor(fx);
    xi0[x] = i0 % P; xi1[x] = (i0 + 1) % P; xf[x] = fade(fx - i0);
  }
  const yi0 = new Int32Array(h), yi1 = new Int32Array(h), yf = new Float32Array(h);
  for (let y = 0; y < h; y++) {
    const fy = (y * P) / h; const i0 = Math.floor(fy);
    yi0[y] = i0 % P; yi1[y] = (i0 + 1) % P; yf[y] = fade(fy - i0);
  }

  for (let y = 0; y < h; y++) {
    const r0 = yi0[y] * P, r1 = yi1[y] * P, ty = yf[y], o = y * w;
    for (let x = 0; x < w; x++) {
      const a = lat[r0 + xi0[x]], b = lat[r0 + xi1[x]];
      const c = lat[r1 + xi0[x]], d = lat[r1 + xi1[x]];
      const tx = xf[x];
      const t = a + (b - a) * tx, u = c + (d - c) * tx;
      out[o + x] = t + (u - t) * ty;
    }
  }
  return out;
}

// ---------------------------------------------------------------------------
//  Gradient (Perlin) noise
// ---------------------------------------------------------------------------

/**
 * Tileable gradient/Perlin noise. Output roughly in [0,1] (the raw signed
 * result is scaled by 1/0.7 and biased). Gradient noise has a very different
 * character to value noise — flatter tops, cleaner ridges — and mixing the two
 * is what stops procedural texture from looking procedural.
 */
export function perlinNoise(w, h, period, seed, out) {
  out = out || new Float32Array(w * h);
  const P = Math.max(1, period | 0);
  const gx = new Float32Array(P * P), gy = new Float32Array(P * P);
  for (let y = 0; y < P; y++) {
    for (let x = 0; x < P; x++) {
      const a = hash2(x, y, seed) * TAU;
      gx[y * P + x] = Math.cos(a); gy[y * P + x] = Math.sin(a);
    }
  }
  const xi0 = new Int32Array(w), xi1 = new Int32Array(w);
  const xfr = new Float32Array(w), xfd = new Float32Array(w);
  for (let x = 0; x < w; x++) {
    const fx = (x * P) / w; const i0 = Math.floor(fx); const f = fx - i0;
    xi0[x] = i0 % P; xi1[x] = (i0 + 1) % P; xfr[x] = f; xfd[x] = fade(f);
  }
  const yi0 = new Int32Array(h), yi1 = new Int32Array(h);
  const yfr = new Float32Array(h), yfd = new Float32Array(h);
  for (let y = 0; y < h; y++) {
    const fy = (y * P) / h; const i0 = Math.floor(fy); const f = fy - i0;
    yi0[y] = i0 % P; yi1[y] = (i0 + 1) % P; yfr[y] = f; yfd[y] = fade(f);
  }

  for (let y = 0; y < h; y++) {
    const r0 = yi0[y] * P, r1 = yi1[y] * P;
    const fy = yfr[y], ty = yfd[y], fy1 = fy - 1, o = y * w;
    for (let x = 0; x < w; x++) {
      const c0 = xi0[x], c1 = xi1[x];
      const fx = xfr[x], tx = xfd[x], fx1 = fx - 1;
      const i00 = r0 + c0, i10 = r0 + c1, i01 = r1 + c0, i11 = r1 + c1;
      const n00 = gx[i00] * fx + gy[i00] * fy;
      const n10 = gx[i10] * fx1 + gy[i10] * fy;
      const n01 = gx[i01] * fx + gy[i01] * fy1;
      const n11 = gx[i11] * fx1 + gy[i11] * fy1;
      const t = n00 + (n10 - n00) * tx, u = n01 + (n11 - n01) * tx;
      out[o + x] = (t + (u - t) * ty) * 0.7071 + 0.5;
    }
  }
  return out;
}

// ---------------------------------------------------------------------------
//  fBm / ridged fBm
// ---------------------------------------------------------------------------

/**
 * Tileable fractal Brownian motion. Each octave doubles the lattice period, so
 * every octave tiles on its own and therefore so does the sum.
 *
 * opts: { period=4, octaves=5, gain=0.5, lacunarity=2, seed=1,
 *         type:'value'|'perlin'|'mix', ridged=false, warp=0, warpPeriod=6 }
 */
export function fbm(w, h, opts = {}) {
  const {
    period = 4, octaves = 5, gain = 0.5, lacunarity = 2, seed = 1,
    type = 'value', ridged = false, warp = 0, warpPeriod = 6,
  } = opts;

  const out = new Float32Array(w * h);
  const tmp = new Float32Array(w * h);
  let amp = 1, norm = 0, per = period;

  for (let o = 0; o < octaves; o++) {
    const kind = type === 'mix' ? (o & 1 ? 'perlin' : 'value') : type;
    const P = Math.max(1, Math.round(per));
    if (kind === 'perlin') perlinNoise(w, h, P, seed + o * 7919, tmp);
    else valueNoise(w, h, P, seed + o * 7919, tmp);

    if (ridged) {
      // 1 - |2n-1|, squared: sharp creases where the noise crosses 0.5.
      for (let i = 0; i < out.length; i++) {
        let v = 1 - Math.abs(tmp[i] * 2 - 1);
        v *= v;
        out[i] += v * amp;
      }
    } else {
      for (let i = 0; i < out.length; i++) out[i] += tmp[i] * amp;
    }
    norm += amp;
    amp *= gain;
    per *= lacunarity;
  }

  const inv = 1 / norm;
  for (let i = 0; i < out.length; i++) out[i] *= inv;

  if (warp > 0) {
    const dx = perlinNoise(w, h, warpPeriod, seed + 313, tmp);
    const dxs = new Float32Array(w * h);
    for (let i = 0; i < dxs.length; i++) dxs[i] = dx[i] - 0.5;
    const dy = perlinNoise(w, h, warpPeriod, seed + 977);
    for (let i = 0; i < dy.length; i++) dy[i] = dy[i] - 0.5;
    return warpField(out, w, h, dxs, dy, warp * w * 0.01);
  }
  return out;
}

/** Convenience: ridged fBm (mountain-ridge / crack-vein character). */
export function ridgedFbm(w, h, opts = {}) {
  return fbm(w, h, { gain: 0.55, ...opts, ridged: true });
}

/** Signed field in [-0.5,0.5] from any [0,1] field, allocating a new array. */
export function signed(f) {
  const o = new Float32Array(f.length);
  for (let i = 0; i < f.length; i++) o[i] = f[i] - 0.5;
  return o;
}

// ---------------------------------------------------------------------------
//  Worley / cellular
// ---------------------------------------------------------------------------

/**
 * Tileable Worley noise. Returns { f1, f2, id } where
 *   f1  = distance to nearest feature point, normalised by cell size
 *   f2  = distance to second nearest  (f2-f1 gives clean cell borders)
 *   id  = a per-cell random value in [0,1] (pebble colour, tile variation)
 *
 * `cells` feature points span the width and the height, one jittered point
 * per cell, searched over the 3×3 neighbourhood with wrap. Iterating cell-major
 * keeps the 9 candidate points in registers for a whole block of pixels.
 */
export function worley(w, h, cells, seed, jitter = 1, metric = 'euclidean') {
  const C = Math.max(1, cells | 0);
  const px = new Float32Array(C * C), py = new Float32Array(C * C);
  const cid = new Float32Array(C * C);
  for (let cy = 0; cy < C; cy++) {
    for (let cx = 0; cx < C; cx++) {
      const i = cy * C + cx;
      px[i] = cx + 0.5 + (hash2(cx, cy, seed) - 0.5) * jitter;
      py[i] = cy + 0.5 + (hash2(cx, cy, seed + 5501) - 0.5) * jitter;
      cid[i] = hash2(cx, cy, seed + 9173);
    }
  }

  const f1 = new Float32Array(w * h);
  const f2 = new Float32Array(w * h);
  const id = new Float32Array(w * h);
  const cw = w / C, ch = h / C;
  const nx = new Float32Array(9), ny = new Float32Array(9), nid = new Float32Array(9);

  for (let cy = 0; cy < C; cy++) {
    const y0 = Math.floor(cy * ch), y1 = Math.floor((cy + 1) * ch);
    for (let cx = 0; cx < C; cx++) {
      const x0 = Math.floor(cx * cw), x1 = Math.floor((cx + 1) * cw);
      // gather 3x3 neighbours in *cell space*, offsetting wrapped ones so the
      // distance stays continuous across the tile edge.
      let n = 0;
      for (let oy = -1; oy <= 1; oy++) {
        for (let ox = -1; ox <= 1; ox++) {
          const gx = cx + ox, gy = cy + oy;
          const wx = ((gx % C) + C) % C, wy = ((gy % C) + C) % C;
          const i = wy * C + wx;
          nx[n] = px[i] + (gx - wx);
          ny[n] = py[i] + (gy - wy);
          nid[n] = cid[i];
          n++;
        }
      }
      for (let y = y0; y < y1; y++) {
        const fy = (y + 0.5) / ch;
        const o = y * w;
        for (let x = x0; x < x1; x++) {
          const fx = (x + 0.5) / cw;
          let d1 = 1e9, d2 = 1e9, best = 0;
          for (let k = 0; k < 9; k++) {
            const ddx = fx - nx[k], ddy = fy - ny[k];
            const d = metric === 'manhattan'
              ? Math.abs(ddx) + Math.abs(ddy)
              : Math.sqrt(ddx * ddx + ddy * ddy);
            if (d < d1) { d2 = d1; d1 = d; best = nid[k]; }
            else if (d < d2) { d2 = d; }
          }
          const i = o + x;
          f1[i] = d1; f2[i] = d2; id[i] = best;
        }
      }
    }
  }
  return { f1, f2, id, cells: C };
}

// ---------------------------------------------------------------------------
//  Line / stroke rasterisation into a field (wrapping)
// ---------------------------------------------------------------------------

/**
 * Additively stamp a soft-edged line segment. Used by scratch, crack and
 * fibre layers. Coordinates are in pixels and wrap.
 */
export function strokeLine(dst, w, h, x0, y0, x1, y1, width, strength) {
  const dx = x1 - x0, dy = y1 - y0;
  const len = Math.hypot(dx, dy);
  if (len < 1e-4) return;
  const steps = Math.ceil(len);
  const r = Math.max(0.6, width);
  const ri = Math.ceil(r);
  const invStep = 1 / steps;
  for (let s = 0; s <= steps; s++) {
    const t = s * invStep;
    const cxf = x0 + dx * t, cyf = y0 + dy * t;
    const cx = Math.round(cxf), cy = Math.round(cyf);
    for (let oy = -ri; oy <= ri; oy++) {
      const yy = (((cy + oy) % h) + h) % h;
      const row = yy * w;
      const ddy = cy + oy - cyf;
      for (let ox = -ri; ox <= ri; ox++) {
        const ddx = cx + ox - cxf;
        const d = Math.sqrt(ddx * ddx + ddy * ddy);
        if (d > r) continue;
        const xx = (((cx + ox) % w) + w) % w;
        const a = (1 - d / r);
        const v = a * a * strength;
        const i = row + xx;
        if (v > dst[i]) dst[i] = v;
      }
    }
  }
}

/** A jittered polyline walk — organic scratches/cracks rather than straight rules. */
export function strokeWalk(dst, w, h, x, y, angle, length, width, strength, wobble, R) {
  const segs = Math.max(2, Math.round(length / 12));
  const segLen = length / segs;
  let a = angle;
  for (let s = 0; s < segs; s++) {
    a += (R() - 0.5) * wobble;
    const nx2 = x + Math.cos(a) * segLen, ny2 = y + Math.sin(a) * segLen;
    const taper = 1 - Math.abs((s / segs) * 2 - 1) * 0.55;
    strokeLine(dst, w, h, x, y, nx2, ny2, width * taper, strength * taper);
    x = nx2; y = ny2;
  }
}
