/**
 * ============================================================================
 *  Reusable material layers — Operation Blackout
 * ============================================================================
 *  Every surface in the game is *composed* from these, never written as one
 *  monolithic pixel loop. A layer takes fields in and gives a mask out; the
 *  surface generator decides how that mask modulates albedo / height /
 *  roughness. That is what makes 20 materials share a visual family.
 *
 *  Art-direction hooks used throughout (see ART_DIRECTION.md §5):
 *    - edge wear   : lighter albedo + LOWER roughness on convex edges
 *    - grime       : darker + ROUGHER toward the ground and into corners
 *    - roughness   : never constant, minimum ±0.12 across a surface
 * ============================================================================
 */

import {
  field, fbm, valueNoise, perlinNoise, worley, boxBlur, gaussBlur, sampleWrap,
  clamp01, clamp, lerp, smoothstep, rng, strokeWalk, strokeLine, signed,
  normalizeField, smoothstepField, warpField,
} from './noise.js';

// ---------------------------------------------------------------------------
//  Colour helpers. Albedo is authored directly in sRGB byte space — that is the
//  space the texture is uploaded in and the space an artist picks colours in.
// ---------------------------------------------------------------------------

/** 0xRRGGBB -> [r,g,b] bytes. */
export const rgb = (hex) => [(hex >> 16) & 255, (hex >> 8) & 255, hex & 255];

/** Linear blend of two byte triplets. */
export function mixRgb(a, b, t, out) {
  out = out || [0, 0, 0];
  out[0] = a[0] + (b[0] - a[0]) * t;
  out[1] = a[1] + (b[1] - a[1]) * t;
  out[2] = a[2] + (b[2] - a[2]) * t;
  return out;
}

/**
 * Multi-stop colour ramp. stops = [[t, 0xRRGGBB], ...] sorted ascending.
 * Returns a sampler (t) => [r,g,b] writing into a shared scratch triplet.
 */
export function ramp(stops) {
  const cols = stops.map((s) => rgb(s[1]));
  const ts = stops.map((s) => s[0]);
  const out = [0, 0, 0];
  return function (t) {
    if (t <= ts[0]) { out[0] = cols[0][0]; out[1] = cols[0][1]; out[2] = cols[0][2]; return out; }
    const n = ts.length;
    if (t >= ts[n - 1]) { out[0] = cols[n - 1][0]; out[1] = cols[n - 1][1]; out[2] = cols[n - 1][2]; return out; }
    let i = 1; while (i < n && ts[i] < t) i++;
    const k = (t - ts[i - 1]) / (ts[i] - ts[i - 1]);
    return mixRgb(cols[i - 1], cols[i], k, out);
  };
}

/** Bake a ramp into a 256-entry LUT so the pixel loop is 3 array reads. */
export function rampLUT(stops) {
  const r = ramp(stops);
  const lut = new Uint8ClampedArray(256 * 3);
  for (let i = 0; i < 256; i++) {
    const c = r(i / 255);
    lut[i * 3] = c[0]; lut[i * 3 + 1] = c[1]; lut[i * 3 + 2] = c[2];
  }
  return lut;
}

// ---------------------------------------------------------------------------
//  Curvature / edge wear
// ---------------------------------------------------------------------------

/**
 * Signed curvature of a height field: height minus a blurred copy of itself.
 * Positive = convex (ridge, brick face, pebble crown), negative = concave
 * (mortar line, crack, dent). This is the single most useful derived field —
 * wear rides the positives, grime settles in the negatives.
 */
export function curvature(height, w, h, radius = 6) {
  const blurred = gaussBlur(height, w, h, radius);
  const out = new Float32Array(w * h);
  for (let i = 0; i < out.length; i++) out[i] = height[i] - blurred[i];
  return out;
}

/**
 * Edge wear mask in [0,1]. Rides convex curvature, broken up by noise so it
 * never reads as a uniform outline. Feed it the *height* field, get back
 * "where the paint has been rubbed off".
 *
 * opts: { radius, threshold, softness, breakup, breakupPeriod, seed, amount }
 */
export function edgeWear(height, w, h, opts = {}) {
  const {
    radius = 5, threshold = 0.012, softness = 0.05,
    breakup = 0.65, breakupPeriod = 10, octaves = 4, seed = 21, amount = 1,
  } = opts;

  const curv = curvature(height, w, h, radius);
  const noise = fbm(w, h, { period: breakupPeriod, octaves, seed, type: 'mix', gain: 0.55 });

  const out = new Float32Array(w * h);
  const inv = 1 / Math.max(1e-5, softness);
  for (let i = 0; i < out.length; i++) {
    // Modulate the threshold by noise: some edges are pristine, some are bald.
    const th = threshold * (1 + (noise[i] - 0.5) * 2 * breakup);
    let t = (curv[i] - th) * inv;
    t = t < 0 ? 0 : t > 1 ? 1 : t;
    out[i] = t * t * (3 - 2 * t) * amount;
  }
  return out;
}

/**
 * Cavity / occlusion mask from height — the inverse of edge wear, used both as
 * a baked AO term and as the place grime accumulates.
 */
export function cavity(height, w, h, radius = 8, strength = 1) {
  const blurred = gaussBlur(height, w, h, radius);
  const out = new Float32Array(w * h);
  for (let i = 0; i < out.length; i++) {
    const d = (blurred[i] - height[i]) * strength;
    out[i] = clamp01(d * 4);
  }
  return out;
}

/**
 * Multi-scale ambient occlusion approximation from a height field. Compares
 * the height against blurred copies at three radii — cheap, but it reads
 * convincingly because real AO is exactly "how far below my neighbourhood am I".
 */
export function heightAO(height, w, h, opts = {}) {
  const { radii = [3, 9, 26], strength = 1.0, bias = 0.0 } = opts;
  const out = new Float32Array(w * h);
  out.fill(0);
  let total = 0;
  for (let k = 0; k < radii.length; k++) {
    const wgt = 1 / (k + 1);
    const b = gaussBlur(height, w, h, radii[k]);
    for (let i = 0; i < out.length; i++) out[i] += (b[i] - height[i]) * wgt;
    total += wgt;
  }
  const inv = strength * 3.2 / total;
  for (let i = 0; i < out.length; i++) out[i] = clamp01(1 - (out[i] * inv + bias));
  return out;
}

// ---------------------------------------------------------------------------
//  Grime / dirt gradients
// ---------------------------------------------------------------------------

/**
 * Grime gradient: darker and rougher toward the bottom of the tile (where a
 * wall meets the ground) plus blotchy noise so it never reads as a linear ramp.
 *
 * opts: { direction:'down'|'up'|'none', bandStart, bandEnd, blotchPeriod,
 *         blotch, seed, strength }
 */
export function grimeGradient(w, h, opts = {}) {
  const {
    direction = 'down', bandStart = 0.0, bandEnd = 0.55,
    blotchPeriod = 4, blotch = 0.75, seed = 77, strength = 1, octaves = 5,
  } = opts;

  const blotches = fbm(w, h, { period: blotchPeriod, octaves, seed, type: 'mix', gain: 0.58, warp: 0.6 });
  const out = new Float32Array(w * h);

  for (let y = 0; y < h; y++) {
    let v = y / (h - 1);                          // 0 at bottom row (v=0)
    if (direction === 'up') v = 1 - v;
    let g;
    if (direction === 'none') g = 1;
    else g = 1 - smoothstep(bandStart, bandEnd, v);
    const o = y * w;
    for (let x = 0; x < w; x++) {
      const b = blotches[o + x];
      // Noise both scales and offsets the band so its edge is ragged.
      const m = clamp01(g * (1 - blotch + blotch * b * 1.8) + (b - 0.62) * 0.35 * blotch);
      out[o + x] = clamp01(m) * strength;
    }
  }
  return out;
}

/**
 * Corner darkening for a tile that will be used on a wall: pushes grime into
 * the left/right extremes as well, so tiled walls get vertical soiling bands.
 */
export function cornerGrime(w, h, opts = {}) {
  const { inset = 0.18, strength = 1, seed = 909 } = opts;
  const n = fbm(w, h, { period: 3, octaves: 4, seed, type: 'perlin' });
  const out = new Float32Array(w * h);
  for (let y = 0; y < h; y++) {
    const v = y / (h - 1);
    const gy = 1 - smoothstep(0, inset, Math.min(v, 1 - v));
    const o = y * w;
    for (let x = 0; x < w; x++) {
      const u = x / (w - 1);
      const gx = 1 - smoothstep(0, inset, Math.min(u, 1 - u));
      out[o + x] = clamp01(Math.max(gx, gy) * (0.55 + n[o + x] * 0.9)) * strength;
    }
  }
  return out;
}

/**
 * Vertical drip / rain streaks. Real streaks are narrow, start at a feature
 * and fade downward with a hard top and soft bottom.
 */
export function streaks(w, h, opts = {}) {
  const {
    count = 90, seed = 404, minLen = 0.15, maxLen = 0.8,
    width = 3, strength = 1, startJitter = 0.55, downward = true,
  } = opts;
  const R = rng(seed);
  const out = new Float32Array(w * h);
  const fine = valueNoise(w, h, Math.max(8, Math.round(w / 12)), seed + 12);

  for (let s = 0; s < count; s++) {
    const cx = Math.floor(R() * w);
    const startV = R() * startJitter + (downward ? 1 - startJitter : 0);
    const y0 = Math.floor(startV * h);
    const len = Math.floor((minLen + R() * (maxLen - minLen)) * h);
    const wd = width * (0.4 + R() * 1.6);
    const amp = strength * (0.25 + R() * 0.75);
    const wander = (R() - 0.5) * 0.02;
    for (let k = 0; k < len; k++) {
      const t = k / len;
      const fadeIn = smoothstep(0, 0.06, t);
      const fadeOut = 1 - smoothstep(0.45, 1, t);
      const a = amp * fadeIn * fadeOut;
      if (a <= 0.002) continue;
      const yy = downward ? y0 - k : y0 + k;
      const y = ((yy % h) + h) % h;
      const xc = cx + wander * k;
      const ri = Math.ceil(wd);
      const row = y * w;
      for (let ox = -ri; ox <= ri; ox++) {
        const d = Math.abs(ox - (xc - cx - Math.round(xc - cx)));
        if (d > wd) continue;
        const x = ((Math.round(xc) + ox) % w + w) % w;
        const prof = 1 - d / wd;
        const i = row + x;
        const v = a * prof * prof * (0.55 + fine[i] * 0.9);
        if (v > out[i]) out[i] = v;
      }
    }
  }
  return out;
}

/**
 * Random scratch layer — thin, mostly-aligned gouges. Used on metal, polymer,
 * tile and plastic. Returns [0,1] where 1 = deepest scratch.
 */
export function scratches(w, h, opts = {}) {
  const {
    count = 120, seed = 55, length = 0.25, lenVar = 0.8,
    width = 1.0, strength = 1, angle = null, angleSpread = Math.PI, wobble = 0.25,
  } = opts;
  const R = rng(seed);
  const out = new Float32Array(w * h);
  for (let s = 0; s < count; s++) {
    const x = R() * w, y = R() * h;
    const a = (angle === null ? R() * Math.PI * 2 : angle + (R() - 0.5) * angleSpread);
    const len = length * w * (1 - lenVar * 0.5 + R() * lenVar);
    const wd = width * (0.5 + R() * 1.1);
    const st = strength * (0.25 + R() * 0.75);
    strokeWalk(out, w, h, x, y, a, len, wd, st, wobble, R);
  }
  return out;
}

/**
 * Crack network built from Worley cell borders. `f2 - f1` is ~0 exactly on the
 * boundary between two cells, which is the shape of a real crack network.
 */
export function cracks(w, h, opts = {}) {
  const {
    cells = 9, seed = 31, width = 0.035, strength = 1,
    jitter = 1, warpAmt = 0.02, coverage = 0.55, warpPeriod = 7,
  } = opts;
  const { f1, f2, id } = worley(w, h, cells, seed, jitter);
  // Two things used to go wrong here and they compounded. Uncracked borders
  // were still drawn at 0.15 rather than skipped, so every cell edge in the
  // texture showed; and the edge profile was a hard clamp on a sub-texel
  // width, so each of those edges aliased into a dotted line. The result on a
  // plaster wall at 2 m was a field of dotted polygon outlines — crazy paving
  // sketched in pen. Borders are now either cracked or they are not, the
  // profile is smooth so it antialiases, and an fbm along the crack breaks it
  // up the way a real one fades in and out.
  const along = fbm(w, h, { period: Math.max(3, cells * 2), octaves: 3, seed: seed + 13 });
  const raw = new Float32Array(w * h);
  for (let i = 0; i < raw.length; i++) {
    // Hash the cell id so cracked cells are scattered. Thresholding the id
    // directly cracks one contiguous region of the texture and leaves the
    // rest clean.
    const key = ((Math.sin(id[i] * 127.1) * 43758.5453) % 1 + 1) % 1;
    if (key > coverage) continue;
    const d = (f2[i] - f1[i]) / width;
    if (d >= 1) continue;
    const e = 1 - d;
    raw[i] = e * e * (3 - 2 * e) * clamp01((along[i] - 0.3) * 2.4);
  }
  if (warpAmt > 0) {
    const dx = signed(perlinNoise(w, h, warpPeriod, seed + 51));
    const dy = signed(perlinNoise(w, h, warpPeriod, seed + 97));
    const warped = warpField(raw, w, h, dx, dy, warpAmt * w);
    for (let i = 0; i < warped.length; i++) warped[i] *= strength;
    return warped;
  }
  for (let i = 0; i < raw.length; i++) raw[i] *= strength;
  return raw;
}

/**
 * Fine grain speckle — aggregate in concrete, sand grains, dust. Uses a
 * white-noise lattice at (nearly) texel resolution then a 1px blur so it has
 * energy at the Nyquist limit without aliasing to death.
 */
export function speckle(w, h, opts = {}) {
  const { seed = 8, scale = 1, blur = 0.8, contrast = 1 } = opts;
  const p = Math.max(2, Math.round(w / scale));
  const n = valueNoise(w, h, p, seed);
  const b = blur > 0 ? boxBlur(n, w, h, blur) : n;
  if (contrast !== 1) for (let i = 0; i < b.length; i++) b[i] = clamp01((b[i] - 0.5) * contrast + 0.5);
  return b;
}

/**
 * Pitting / pockmarks: isolated round divots. Concrete, cast metal, asphalt.
 */
export function pits(w, h, opts = {}) {
  const { count = 260, seed = 66, radius = 4, radVar = 2.2, strength = 1, depthVar = 0.7 } = opts;
  const R = rng(seed);
  const out = new Float32Array(w * h);
  for (let p = 0; p < count; p++) {
    const cx = R() * w, cy = R() * h;
    const r = radius * (1 - radVar * 0.35 + R() * radVar);
    const d = strength * (1 - depthVar + R() * depthVar);
    const ri = Math.ceil(r);
    const sx = Math.round(cx), sy = Math.round(cy);
    for (let oy = -ri; oy <= ri; oy++) {
      const yy = ((sy + oy) % h + h) % h;
      const row = yy * w;
      const ddy = sy + oy - cy;
      for (let ox = -ri; ox <= ri; ox++) {
        const ddx = sx + ox - cx;
        const dist = Math.sqrt(ddx * ddx + ddy * ddy) / r;
        if (dist > 1) continue;
        const xx = ((sx + ox) % w + w) % w;
        const prof = Math.cos(dist * Math.PI * 0.5);
        const v = prof * prof * d;
        const i = row + xx;
        if (v > out[i]) out[i] = v;
      }
    }
  }
  return out;
}

/**
 * Blotch / stain mask with a hard-ish rim, for rust blooms, damp patches,
 * paint spall and efflorescence.
 */
export function blotches(w, h, opts = {}) {
  const {
    period = 3, octaves = 5, seed = 123, threshold = 0.55,
    softness = 0.12, warp = 1.2, rim = 0,
  } = opts;
  const n = fbm(w, h, { period, octaves, seed, type: 'mix', gain: 0.56, warp });
  const out = new Float32Array(w * h);
  const inv = 1 / Math.max(1e-4, softness);
  for (let i = 0; i < out.length; i++) {
    let t = (n[i] - threshold) * inv;
    t = t < 0 ? 0 : t > 1 ? 1 : t;
    out[i] = t * t * (3 - 2 * t);
  }
  if (rim > 0) {
    const b = gaussBlur(out, w, h, rim);
    for (let i = 0; i < out.length; i++) out[i] = clamp01(out[i] + Math.max(0, b[i] - out[i]) * 0.0);
  }
  return out;
}

// ---------------------------------------------------------------------------
//  Structural layers — bricks, planks, tiles, corrugation, weave
// ---------------------------------------------------------------------------

/**
 * Running-bond brick lattice.
 * Returns { mask (1 = brick face, 0 = mortar), id (per-brick random),
 *           edge (0..1 distance-to-mortar, for bevels), row, u, v }
 */
export function brickLattice(w, h, opts = {}) {
  const {
    rows = 8, cols = 4, mortar = 0.055, bevel = 0.09,
    offset = 0.5, seed = 5, jitter = 0.012,
  } = opts;
  const mask = new Float32Array(w * h);
  const id = new Float32Array(w * h);
  const edge = new Float32Array(w * h);
  const lu = new Float32Array(w * h);
  const lv = new Float32Array(w * h);

  const rowH = 1 / rows, colW = 1 / cols;
  // Per-row/col jitter so courses are not machine-perfect.
  const rowJit = new Float32Array(rows + 1);
  for (let r = 0; r <= rows; r++) rowJit[r] = (hashf(r, 0, seed) - 0.5) * jitter;

  for (let y = 0; y < h; y++) {
    const v = (y + 0.5) / h;
    let row = Math.floor(v / rowH);
    if (row >= rows) row = rows - 1;
    const rowStart = row * rowH + (row === 0 ? 0 : rowJit[row]);
    const rowEnd = (row + 1) * rowH + (row + 1 === rows ? 0 : rowJit[row + 1]);
    const rv = (v - rowStart) / Math.max(1e-5, rowEnd - rowStart);
    const shift = (row & 1) ? offset : 0;
    const o = y * w;
    // vertical distance to nearest mortar joint, in row-local units
    const dv = Math.min(rv, 1 - rv);
    for (let x = 0; x < w; x++) {
      const u = (x + 0.5) / w;
      const su = (u + shift) % 1;
      let col = Math.floor(su / colW);
      if (col >= cols) col = cols - 1;
      const cu = (su - col * colW) / colW;
      const du = Math.min(cu, 1 - cu);
      // convert to a common "fraction of a brick" metric, scaled by aspect
      const dvp = dv * rowH, dup = du * colW;
      const d = Math.min(dvp, dup);
      const i = o + x;
      const m = smoothstep(mortar * 0.5, mortar * 0.5 + bevel * 0.5 * Math.min(rowH, colW) / 0.1, d / 1);
      mask[i] = m;
      edge[i] = clamp01(d / (mortar + 0.06));
      id[i] = hashf(col, row, seed + 771);
      lu[i] = cu; lv[i] = rv;
    }
  }
  return { mask, id, edge, u: lu, v: lv, rows, cols };
}

function hashf(x, y, s) {
  let hh = Math.imul(x | 0, 0x27d4eb2d) ^ Math.imul(y | 0, 0x165667b1) ^ Math.imul(s | 0, 0x9e3779b1);
  hh = Math.imul(hh ^ (hh >>> 15), 0x85ebca6b);
  hh = Math.imul(hh ^ (hh >>> 13), 0xc2b2ae35);
  return ((hh ^ (hh >>> 16)) >>> 0) / 4294967296;
}

/**
 * Plank lattice (horizontal boards by default).
 * Returns { mask, id, edge, along (0..1 along the board), across }
 */
export function plankLattice(w, h, opts = {}) {
  const { count = 6, gap = 0.012, bevel = 0.02, seed = 3, vertical = false, stagger = 0 } = opts;
  const mask = new Float32Array(w * h);
  const id = new Float32Array(w * h);
  const across = new Float32Array(w * h);
  const along = new Float32Array(w * h);
  const bw = 1 / count;
  // Uneven board widths read as real timber.
  const edges = new Float32Array(count + 1);
  for (let i = 0; i <= count; i++) {
    edges[i] = i * bw + (i === 0 || i === count ? 0 : (hashf(i, 7, seed) - 0.5) * bw * 0.28);
  }

  for (let y = 0; y < h; y++) {
    const o = y * w;
    for (let x = 0; x < w; x++) {
      const a = vertical ? (x + 0.5) / w : (y + 0.5) / h;   // across-boards axis
      const b = vertical ? (y + 0.5) / h : (x + 0.5) / w;   // along-boards axis
      let bi = Math.floor(a / bw); if (bi >= count) bi = count - 1;
      // find true board via jittered edges
      while (bi > 0 && a < edges[bi]) bi--;
      while (bi < count - 1 && a >= edges[bi + 1]) bi++;
      const e0 = edges[bi], e1 = edges[bi + 1];
      const t = (a - e0) / Math.max(1e-5, e1 - e0);
      const d = Math.min(t, 1 - t) * (e1 - e0);
      const i = o + x;
      mask[i] = smoothstep(gap * 0.5, gap * 0.5 + bevel, d);
      across[i] = t;
      let bb = b;
      if (stagger > 0) bb = (b + hashf(bi, 3, seed + 91) * stagger) % 1;
      along[i] = bb;
      id[i] = hashf(bi, 0, seed + 401);
    }
  }
  return { mask, id, across, along, count };
}

/**
 * Square tile lattice with grout. Returns { mask, id, edge, u, v }.
 */
export function tileLattice(w, h, opts = {}) {
  const { n = 6, grout = 0.035, bevel = 0.02, seed = 17 } = opts;
  const mask = new Float32Array(w * h);
  const id = new Float32Array(w * h);
  const uu = new Float32Array(w * h);
  const vv = new Float32Array(w * h);
  const cell = 1 / n;
  for (let y = 0; y < h; y++) {
    const v = (y + 0.5) / h;
    const ry = Math.min(n - 1, Math.floor(v / cell));
    const tv = (v - ry * cell) / cell;
    const dv = Math.min(tv, 1 - tv) * cell;
    const o = y * w;
    for (let x = 0; x < w; x++) {
      const u = (x + 0.5) / w;
      const rx = Math.min(n - 1, Math.floor(u / cell));
      const tu = (u - rx * cell) / cell;
      const du = Math.min(tu, 1 - tu) * cell;
      const d = Math.min(du, dv);
      const i = o + x;
      mask[i] = smoothstep(grout * 0.5, grout * 0.5 + bevel, d);
      id[i] = hashf(rx, ry, seed);
      uu[i] = tu; vv[i] = tv;
    }
  }
  return { mask, id, u: uu, v: vv, n };
}

/**
 * Corrugated profile — a proper sinusoid with a flattened crest, plus the
 * per-sheet overlap seam. Returns { height, slopeSign }.
 */
export function corrugation(w, h, opts = {}) {
  const { ribs = 8, sharpness = 1.35, vertical = true, amplitude = 1 } = opts;
  const out = new Float32Array(w * h);
  const per = new Float32Array(vertical ? w : h);
  for (let i = 0; i < per.length; i++) {
    const t = (i + 0.5) / per.length * ribs;
    const s = Math.sin(t * Math.PI * 2);
    // Push toward a trapezoid: |sin|^(1/sharpness) keeps rounded valleys
    per[i] = (Math.sign(s) * Math.pow(Math.abs(s), 1 / sharpness) * 0.5 + 0.5) * amplitude;
  }
  for (let y = 0; y < h; y++) {
    const o = y * w;
    if (vertical) { for (let x = 0; x < w; x++) out[o + x] = per[x]; }
    else { const v = per[y]; for (let x = 0; x < w; x++) out[o + x] = v; }
  }
  return out;
}

/**
 * Woven fabric — the over/under of warp and weft threads, with slub (thread
 * thickness variation). Burlap, canvas, sandbag.
 */
export function weave(w, h, opts = {}) {
  const { threads = 48, thickness = 0.62, slub = 0.35, seed = 71, depth = 1 } = opts;
  const out = new Float32Array(w * h);
  const T = threads;
  // per-thread thickness variation
  const wv = new Float32Array(T), wf = new Float32Array(T);
  for (let i = 0; i < T; i++) {
    wv[i] = 1 + (hashf(i, 0, seed) - 0.5) * slub;
    wf[i] = 1 + (hashf(i, 1, seed + 3) - 0.5) * slub;
  }
  const per = w / T;
  for (let y = 0; y < h; y++) {
    const ty = (y / h) * T;
    const jy = Math.min(T - 1, Math.floor(ty));
    const fy = ty - jy;
    const o = y * w;
    for (let x = 0; x < w; x++) {
      const tx = (x / w) * T;
      const jx = Math.min(T - 1, Math.floor(tx));
      const fx = tx - jx;
      // Thread cross-section: cosine bump across its width.
      const cx = Math.cos((fx - 0.5) * Math.PI) * wv[jx];
      const cy = Math.cos((fy - 0.5) * Math.PI) * wf[jy];
      const bx = Math.max(0, cx - (1 - thickness));
      const by = Math.max(0, cy - (1 - thickness));
      // Checkerboard decides which thread is on top.
      const over = ((jx + jy) & 1) === 0;
      const v = over ? bx * 1.0 + by * 0.35 : by * 1.0 + bx * 0.35;
      out[o + x] = v * depth;
    }
  }
  normalizeField(out);
  return out;
}

/**
 * Directional fibre / grain — long streaky structures. Wood grain, canvas
 * fibres, brushed metal. `aniso` stretches the noise along the given axis.
 */
export function fibre(w, h, opts = {}) {
  const { period = 6, aniso = 24, octaves = 5, seed = 44, vertical = false, gain = 0.55 } = opts;
  // Generate at a squashed resolution then stretch — an anisotropic fBm that
  // still tiles, because both dimensions stay on integer lattices.
  const out = new Float32Array(w * h);
  const tmp = new Float32Array(w * h);
  let amp = 1, norm = 0, p = period;
  for (let o = 0; o < octaves; o++) {
    const pa = Math.max(1, Math.round(p));
    const pb = Math.max(1, Math.round(p * aniso));
    if (vertical) anisoValueNoise(w, h, pb, pa, seed + o * 131, tmp);
    else anisoValueNoise(w, h, pa, pb, seed + o * 131, tmp);
    for (let i = 0; i < out.length; i++) out[i] += tmp[i] * amp;
    norm += amp; amp *= gain; p *= 2;
  }
  const inv = 1 / norm;
  for (let i = 0; i < out.length; i++) out[i] *= inv;
  return out;
}

/** Value noise with independent X and Y lattice periods (still tileable). */
export function anisoValueNoise(w, h, px, py, seed, out) {
  out = out || new Float32Array(w * h);
  const PX = Math.max(1, px | 0), PY = Math.max(1, py | 0);
  const lat = new Float32Array(PX * PY);
  for (let y = 0; y < PY; y++) for (let x = 0; x < PX; x++) lat[y * PX + x] = hashf(x, y, seed);
  const xi0 = new Int32Array(w), xi1 = new Int32Array(w), xf = new Float32Array(w);
  for (let x = 0; x < w; x++) {
    const fx = (x * PX) / w; const i0 = Math.floor(fx);
    xi0[x] = i0 % PX; xi1[x] = (i0 + 1) % PX;
    const f = fx - i0; xf[x] = f * f * f * (f * (f * 6 - 15) + 10);
  }
  for (let y = 0; y < h; y++) {
    const fy = (y * PY) / h; const j0 = Math.floor(fy);
    const r0 = (j0 % PY) * PX, r1 = ((j0 + 1) % PY) * PX;
    const g = fy - j0; const ty = g * g * g * (g * (g * 6 - 15) + 10);
    const o = y * w;
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

/**
 * Wood grain: concentric rings warped by fibre noise, which is exactly how
 * annual rings read on a flat-sawn board. `rings` per board width.
 */
export function woodGrain(w, h, opts = {}) {
  const {
    rings = 11, seed = 9, vertical = false, wobble = 0.28,
    ringSharp = 2.4, fibreAmt = 0.35,
  } = opts;
  const distort = fibre(w, h, { period: 3, aniso: 14, octaves: 4, seed: seed + 5, vertical });
  const fine = fibre(w, h, { period: 10, aniso: 40, octaves: 3, seed: seed + 61, vertical });
  const out = new Float32Array(w * h);
  for (let y = 0; y < h; y++) {
    const o = y * w;
    for (let x = 0; x < w; x++) {
      const i = o + x;
      const a = (vertical ? x / w : y / h) + (distort[i] - 0.5) * wobble;
      let r = a * rings;
      r = r - Math.floor(r);
      // asymmetric ring: slow earlywood, abrupt latewood
      let v = Math.pow(1 - Math.abs(r * 2 - 1), ringSharp);
      v = v * (1 - fibreAmt) + fine[i] * fibreAmt;
      out[i] = v;
    }
  }
  normalizeField(out);
  return out;
}

/** Knot mask: a few tight elliptical whorls that the grain should bend around. */
export function knots(w, h, opts = {}) {
  const { count = 3, seed = 88, radius = 0.055, strength = 1 } = opts;
  const R = rng(seed);
  const out = new Float32Array(w * h);
  for (let k = 0; k < count; k++) {
    const cx = R() * w, cy = R() * h;
    const rr = radius * w * (0.6 + R() * 0.8);
    const ar = 0.55 + R() * 0.9;
    const ri = Math.ceil(rr * Math.max(1, 1 / ar));
    const rings = 5 + Math.floor(R() * 5);
    for (let oy = -ri; oy <= ri; oy++) {
      const yy = ((Math.round(cy) + oy) % h + h) % h;
      const row = yy * w;
      for (let ox = -ri; ox <= ri; ox++) {
        const dx = ox / rr, dy = (oy * ar) / rr;
        const d = Math.sqrt(dx * dx + dy * dy);
        if (d > 1) continue;
        const xx = ((Math.round(cx) + ox) % w + w) % w;
        const fall = Math.pow(1 - d, 1.4);
        const ring = 0.5 + 0.5 * Math.cos(d * rings * Math.PI * 2);
        const i = row + xx;
        const v = fall * (0.45 + ring * 0.55) * strength;
        if (v > out[i]) out[i] = v;
      }
    }
  }
  return out;
}

/**
 * Rivet / bolt row generator. Stamps domed heads at regular intervals with a
 * ring shadow, into a height field.
 */
export function rivets(w, h, opts = {}) {
  const {
    positions = [], radius = 6, strength = 1, ring = 1.35, seed = 5, jitter = 0,
  } = opts;
  const R = rng(seed);
  const out = new Float32Array(w * h);
  for (const [px, py] of positions) {
    const cx = px * w + (R() - 0.5) * jitter * w;
    const cy = py * h + (R() - 0.5) * jitter * h;
    const rr = radius * (0.9 + R() * 0.2);
    const ri = Math.ceil(rr * ring);
    const sx = Math.round(cx), sy = Math.round(cy);
    for (let oy = -ri; oy <= ri; oy++) {
      const yy = ((sy + oy) % h + h) % h;
      const row = yy * w;
      const ddy = sy + oy - cy;
      for (let ox = -ri; ox <= ri; ox++) {
        const ddx = sx + ox - cx;
        const d = Math.sqrt(ddx * ddx + ddy * ddy) / rr;
        if (d > ring) continue;
        const xx = ((sx + ox) % w + w) % w;
        const i = row + xx;
        let v;
        if (d <= 1) v = Math.sqrt(Math.max(0, 1 - d * d)) * strength;      // dome
        else v = -(1 - (d - 1) / (ring - 1)) * strength * 0.22;             // seating shadow
        if (Math.abs(v) > Math.abs(out[i])) out[i] = v;
      }
    }
  }
  return out;
}

/** Evenly spaced rivet positions along a line, in UV space. */
export function rivetRow(y, n, x0 = 0, x1 = 1, vertical = false) {
  const p = [];
  for (let i = 0; i < n; i++) {
    const t = x0 + (x1 - x0) * ((i + 0.5) / n);
    p.push(vertical ? [y, t] : [t, y]);
  }
  return p;
}

// ---------------------------------------------------------------------------
//  Composition helpers used by every generator
// ---------------------------------------------------------------------------

/** dst = dst*(1-m) + value*m, per element (value scalar). */
export function blendConst(dst, mask, value, amount = 1) {
  for (let i = 0; i < dst.length; i++) {
    const m = mask[i] * amount;
    dst[i] += (value - dst[i]) * m;
  }
  return dst;
}

/** dst = dst*(1-m) + src*m */
export function blendField(dst, mask, src, amount = 1) {
  for (let i = 0; i < dst.length; i++) {
    const m = mask[i] * amount;
    dst[i] += (src[i] - dst[i]) * m;
  }
  return dst;
}

/** Additively raise/lower a height field by a mask. */
export function addMask(dst, mask, amount) {
  for (let i = 0; i < dst.length; i++) dst[i] += mask[i] * amount;
  return dst;
}

export { clamp01, clamp, lerp, smoothstep };
