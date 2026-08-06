import * as THREE from 'three';

/**
 * Procedural sprite textures for the atmosphere layer.
 *
 * Rule 1 of the project: no external asset files. Everything here is drawn into
 * an offscreen canvas at boot. All of these are tiny (<=256px) and cached, so
 * the cost is a fraction of a millisecond.
 */

const _cache = new Map();

function canvas(w, h) {
  const c = document.createElement('canvas');
  c.width = w; c.height = h;
  return c;
}

function finish(c, key) {
  const tex = new THREE.CanvasTexture(c);
  tex.colorSpace = THREE.SRGBColorSpace;
  tex.wrapS = tex.wrapT = THREE.ClampToEdgeWrapping;
  tex.minFilter = THREE.LinearMipmapLinearFilter;
  tex.magFilter = THREE.LinearFilter;
  tex.generateMipmaps = true;
  tex.needsUpdate = true;
  tex.name = key;
  _cache.set(key, tex);
  return tex;
}

/**
 * Soft round mote / glow. `power` shapes the falloff: 1 = linear-ish halo,
 * 3 = tight hot core with a long tail (what a real out-of-focus point looks like).
 */
export function glowSprite(size = 128, power = 2.6, coreBoost = 0.0) {
  const key = `glow_${size}_${power}_${coreBoost}`;
  if (_cache.has(key)) return _cache.get(key);
  const c = canvas(size, size);
  const g = c.getContext('2d');
  const img = g.createImageData(size, size);
  const d = img.data;
  const r = size * 0.5;
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      const dx = (x + 0.5 - r) / r, dy = (y + 0.5 - r) / r;
      const dist = Math.sqrt(dx * dx + dy * dy);
      let a = Math.max(0, 1 - dist);
      a = Math.pow(a, power);
      if (coreBoost > 0) a += coreBoost * Math.pow(Math.max(0, 1 - dist * 3.2), 3);
      a = Math.min(1, a);
      const i = (y * size + x) * 4;
      d[i] = 255; d[i + 1] = 255; d[i + 2] = 255;
      d[i + 3] = Math.round(a * 255);
    }
  }
  g.putImageData(img, 0, 0);
  return finish(c, key);
}

/**
 * Anamorphic streak: a long horizontal smear with a hard-ish vertical profile.
 * Tinted very slightly cool at the tips the way a real anamorphic flare is.
 */
export function streakSprite(w = 512, h = 64) {
  const key = `streak_${w}_${h}`;
  if (_cache.has(key)) return _cache.get(key);
  const c = canvas(w, h);
  const g = c.getContext('2d');
  const img = g.createImageData(w, h);
  const d = img.data;
  for (let y = 0; y < h; y++) {
    const v = (y + 0.5) / h * 2 - 1;
    // Vertical profile: very tight, with a faint bleed.
    const vy = Math.pow(Math.max(0, 1 - Math.abs(v)), 9) + 0.10 * Math.pow(Math.max(0, 1 - Math.abs(v)), 2);
    for (let x = 0; x < w; x++) {
      const u = (x + 0.5) / w * 2 - 1;
      const hx = Math.pow(Math.max(0, 1 - Math.abs(u)), 1.7);
      const a = Math.min(1, vy * hx);
      const tip = Math.abs(u);
      const i = (y * w + x) * 4;
      d[i] = 255;
      d[i + 1] = Math.round(255 * (1 - 0.10 * tip));
      d[i + 2] = Math.round(255 * (1 - 0.02 * tip + 0.02));
      d[i + 3] = Math.round(a * 255);
    }
  }
  g.putImageData(img, 0, 0);
  return finish(c, key);
}

/**
 * Iris ghost: soft polygonal aperture shape with a bright rim and a hollow
 * centre. Two of these is tasteful; twelve is a 2005 screensaver.
 */
export function ghostSprite(size = 128, sides = 7) {
  const key = `ghost_${size}_${sides}`;
  if (_cache.has(key)) return _cache.get(key);
  const c = canvas(size, size);
  const g = c.getContext('2d');
  const img = g.createImageData(size, size);
  const d = img.data;
  const r = size * 0.5;
  const apothem = Math.cos(Math.PI / sides);
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      const dx = (x + 0.5 - r) / r, dy = (y + 0.5 - r) / r;
      const dist = Math.sqrt(dx * dx + dy * dy);
      let ang = Math.atan2(dy, dx);
      // Distance to a regular polygon boundary in this direction.
      const seg = (2 * Math.PI) / sides;
      const a2 = ang - Math.round(ang / seg) * seg;
      const bound = apothem / Math.max(1e-4, Math.cos(a2));
      const t = dist / bound;                      // 0 centre .. 1 edge
      let a = Math.max(0, 1 - t);
      a = Math.pow(a, 0.85) * 0.30;                // flat-ish disc
      a += 0.75 * Math.pow(Math.max(0, 1 - Math.abs(t - 0.92) * 9.0), 2.0); // rim
      a *= 1 - Math.pow(Math.max(0, Math.min(1, t)), 14);
      a = Math.min(1, Math.max(0, a));
      const i = (y * size + x) * 4;
      d[i] = 255; d[i + 1] = 245; d[i + 2] = 232;
      d[i + 3] = Math.round(a * 255);
    }
  }
  g.putImageData(img, 0, 0);
  return finish(c, key);
}

/** Grey-scale value noise tile used to break up light-shaft interiors. */
export function noiseTile(size = 128, seed = 7) {
  const key = `noise_${size}_${seed}`;
  if (_cache.has(key)) return _cache.get(key);
  let s = seed >>> 0;
  const rnd = () => { s = (s * 1664525 + 1013904223) >>> 0; return s / 4294967296; };
  const base = 16;
  const grid = new Float32Array(base * base);
  for (let i = 0; i < grid.length; i++) grid[i] = rnd();
  const sample = (x, y) => {
    const xi = Math.floor(x), yi = Math.floor(y);
    const xf = x - xi, yf = y - yi;
    const sx = xf * xf * (3 - 2 * xf), sy = yf * yf * (3 - 2 * yf);
    const g = (ix, iy) => grid[((iy % base) + base) % base * base + (((ix % base) + base) % base)];
    const a = g(xi, yi), b = g(xi + 1, yi), c1 = g(xi, yi + 1), d1 = g(xi + 1, yi + 1);
    return (a + (b - a) * sx) + ((c1 + (d1 - c1) * sx) - (a + (b - a) * sx)) * sy;
  };
  const c = canvas(size, size);
  const g2 = c.getContext('2d');
  const img = g2.createImageData(size, size);
  const d = img.data;
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      const u = x / size * base, v = y / size * base;
      let n = 0, amp = 0.55, f = 1;
      for (let o = 0; o < 4; o++) { n += sample(u * f, v * f) * amp; amp *= 0.5; f *= 2; }
      const val = Math.round(Math.max(0, Math.min(1, n)) * 255);
      const i = (y * size + x) * 4;
      d[i] = d[i + 1] = d[i + 2] = val; d[i + 3] = 255;
    }
  }
  g2.putImageData(img, 0, 0);
  const tex = finish(c, key);
  tex.wrapS = tex.wrapT = THREE.RepeatWrapping;
  tex.colorSpace = THREE.NoColorSpace;
  return tex;
}

export function disposeTextures() {
  for (const t of _cache.values()) t.dispose();
  _cache.clear();
}
