/* ============================================================================
   NITRO CIRCUIT — utilities
   Small math / random / pooling helpers used everywhere. Kept dependency-free.
   ========================================================================= */

const TAU = Math.PI * 2;
const clamp = (v, a, b) => v < a ? a : (v > b ? b : v);
const clamp01 = v => v < 0 ? 0 : (v > 1 ? 1 : v);
const lerp = (a, b, t) => a + (b - a) * t;
const invLerp = (a, b, v) => (v - a) / (b - a);
const smoothstep = (a, b, v) => { const t = clamp01((v - a) / (b - a)); return t * t * (3 - 2 * t); };
const sign = v => v < 0 ? -1 : (v > 0 ? 1 : 0);
const deg = d => d * Math.PI / 180;

/** Wrap an angle into (-PI, PI]. */
function wrapPi(a) {
  a = (a + Math.PI) % TAU;
  if (a < 0) a += TAU;
  return a - Math.PI;
}
/** Shortest signed delta from a to b. */
const angleDelta = (a, b) => wrapPi(b - a);

/** Frame-rate independent exponential approach. `rate` = fraction closed per second. */
function damp(current, target, rate, dt) {
  return lerp(current, target, 1 - Math.exp(-rate * dt));
}
/** Move `current` toward `target` at most `maxStep*dt`. */
function approach(current, target, maxStep, dt) {
  const d = target - current, m = maxStep * dt;
  return Math.abs(d) <= m ? target : current + sign(d) * m;
}

/* --- deterministic RNG (mulberry32) so tracks/decor rebuild identically --- */
function makeRng(seed) {
  let a = seed >>> 0;
  const f = function () {
    a |= 0; a = (a + 0x6D2B79F5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
  f.range = (lo, hi) => lo + f() * (hi - lo);
  f.int = (lo, hi) => Math.floor(lo + f() * (hi - lo + 1));
  f.pick = arr => arr[Math.floor(f() * arr.length) % arr.length];
  f.sign = () => f() < .5 ? -1 : 1;
  return f;
}
const rand = (a, b) => a + Math.random() * (b - a);
const randInt = (a, b) => Math.floor(a + Math.random() * (b - a + 1));
const pick = arr => arr[Math.floor(Math.random() * arr.length)];

/** Weighted pick. `weights` parallel to `items`. */
function weightedPick(items, weights, rng) {
  let total = 0;
  for (let i = 0; i < weights.length; i++) total += weights[i];
  let r = (rng ? rng() : Math.random()) * total;
  for (let i = 0; i < items.length; i++) { r -= weights[i]; if (r <= 0) return items[i]; }
  return items[items.length - 1];
}

/* --- time formatting --- */
function fmtTime(t) {
  if (t == null || !isFinite(t) || t < 0) return '--:--.--';
  const m = Math.floor(t / 60), s = Math.floor(t % 60), c = Math.floor((t * 100) % 100);
  return m + ':' + (s < 10 ? '0' : '') + s + '.' + (c < 10 ? '0' : '') + c;
}
function fmtGap(t) {
  if (t == null || !isFinite(t)) return '';
  const s = Math.floor(t), c = Math.floor((t * 100) % 100);
  return '+' + s + '.' + (c < 10 ? '0' : '') + c;
}
const ORD = ['', '1st', '2nd', '3rd', '4th', '5th', '6th', '7th', '8th'];
const ORD_N = ['', '1', '2', '3', '4', '5', '6', '7', '8'];
const ORD_S = ['', 'st', 'nd', 'rd', 'th', 'th', 'th', 'th', 'th'];

/* --- colour helpers --- */
function hexLerp(a, b, t) {
  const ar = (a >> 16) & 255, ag = (a >> 8) & 255, ab = a & 255;
  const br = (b >> 16) & 255, bg = (b >> 8) & 255, bb = b & 255;
  return ((ar + (br - ar) * t) << 16 | (ag + (bg - ag) * t) << 8 | (ab + (bb - ab) * t)) & 0xffffff;
}
function shade(hex, f) {
  const r = clamp(((hex >> 16) & 255) * f, 0, 255) | 0;
  const g = clamp(((hex >> 8) & 255) * f, 0, 255) | 0;
  const b = clamp((hex & 255) * f, 0, 255) | 0;
  return (r << 16) | (g << 8) | b;
}
const cssHex = h => '#' + ('000000' + (h >>> 0).toString(16)).slice(-6);

/* --- scratch vectors: allocating in the update loop is the enemy of 60fps --- */
const _v0 = new THREE.Vector3(), _v1 = new THREE.Vector3(), _v2 = new THREE.Vector3();
const _v3 = new THREE.Vector3(), _v4 = new THREE.Vector3(), _v5 = new THREE.Vector3();
const _q0 = new THREE.Quaternion(), _m0 = new THREE.Matrix4(), _e0 = new THREE.Euler();
const _c0 = new THREE.Color(), _c1 = new THREE.Color();

/* --- generic free-list pool ---------------------------------------------- */
class Pool {
  constructor(factory, size) {
    this.items = [];
    this.factory = factory;
    for (let i = 0; i < size; i++) { const o = factory(i); o._alive = false; this.items.push(o); }
    this.cursor = 0;
  }
  /** Grab a dead item, or steal the oldest if we're saturated (never allocates). */
  get() {
    const n = this.items.length;
    for (let i = 0; i < n; i++) {
      const idx = (this.cursor + i) % n;
      if (!this.items[idx]._alive) { this.cursor = (idx + 1) % n; const o = this.items[idx]; o._alive = true; return o; }
    }
    const o = this.items[this.cursor];
    this.cursor = (this.cursor + 1) % n;
    o._alive = true;
    return o;
  }
  forEach(fn) { for (let i = 0; i < this.items.length; i++) if (this.items[i]._alive) fn(this.items[i], i); }
  releaseAll() { for (let i = 0; i < this.items.length; i++) this.items[i]._alive = false; }
}

/* --- canvas texture factory ---------------------------------------------- */
const _texCache = new Map();
function canvasTexture(key, w, h, draw, opts) {
  if (_texCache.has(key)) return _texCache.get(key);
  const c = document.createElement('canvas');
  c.width = w; c.height = h;
  const g = c.getContext('2d');
  draw(g, w, h);
  const t = new THREE.CanvasTexture(c);
  // these canvases are painted in sRGB; tell three so lighting maths is linear
  if (!(opts && opts.linear)) t.encoding = THREE.sRGBEncoding;
  t.wrapS = t.wrapT = (opts && opts.clamp) ? THREE.ClampToEdgeWrapping : THREE.RepeatWrapping;
  t.anisotropy = (opts && opts.aniso) || 4;
  if (opts && opts.repeat) t.repeat.set(opts.repeat[0], opts.repeat[1]);
  t.needsUpdate = true;
  _texCache.set(key, t);
  return t;
}

/** Value-noise field on a 2D canvas — the base of every procedural texture here. */
function noiseFill(g, w, h, scale, colA, colB, seed, octaves) {
  const rng = makeRng(seed);
  const gw = Math.ceil(w / scale) + 2, gh = Math.ceil(h / scale) + 2;
  const grid = new Float32Array(gw * gh);
  for (let i = 0; i < grid.length; i++) grid[i] = rng();
  // wrap edges so the texture tiles seamlessly
  for (let y = 0; y < gh; y++) grid[y * gw + gw - 2] = grid[y * gw];
  for (let x = 0; x < gw; x++) grid[(gh - 2) * gw + x] = grid[x];
  const img = g.createImageData(w, h);
  const d = img.data;
  const ar = (colA >> 16) & 255, ag = (colA >> 8) & 255, ab = colA & 255;
  const br = (colB >> 16) & 255, bg = (colB >> 8) & 255, bb = colB & 255;
  const oct = octaves || 2;
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      let n = 0, amp = 1, tot = 0, sc = scale;
      for (let o = 0; o < oct; o++) {
        const fx = x / sc, fy = y / sc;
        const x0 = Math.floor(fx) % (gw - 1), y0 = Math.floor(fy) % (gh - 1);
        const tx = fx - Math.floor(fx), ty = fy - Math.floor(fy);
        const sx = tx * tx * (3 - 2 * tx), sy = ty * ty * (3 - 2 * ty);
        const v00 = grid[y0 * gw + x0], v10 = grid[y0 * gw + x0 + 1];
        const v01 = grid[(y0 + 1) * gw + x0], v11 = grid[(y0 + 1) * gw + x0 + 1];
        n += amp * lerp(lerp(v00, v10, sx), lerp(v01, v11, sx), sy);
        tot += amp; amp *= .5; sc *= .5;
      }
      n /= tot;
      const i = (y * w + x) * 4;
      d[i] = ar + (br - ar) * n; d[i + 1] = ag + (bg - ag) * n; d[i + 2] = ab + (bb - ab) * n; d[i + 3] = 255;
    }
  }
  g.putImageData(img, 0, 0);
}

/** Soft radial sprite used by every particle system (one channel, tinted per-vertex). */
function makeSpriteTexture(kind) {
  return canvasTexture('spr_' + kind, 64, 64, (g, w, h) => {
    const cx = w / 2, cy = h / 2;
    if (kind === 'soft') {
      const grad = g.createRadialGradient(cx, cy, 0, cx, cy, w / 2);
      grad.addColorStop(0, 'rgba(255,255,255,1)');
      grad.addColorStop(.35, 'rgba(255,255,255,.55)');
      grad.addColorStop(1, 'rgba(255,255,255,0)');
      g.fillStyle = grad; g.fillRect(0, 0, w, h);
    } else if (kind === 'spark') {
      const grad = g.createRadialGradient(cx, cy, 0, cx, cy, w / 2);
      grad.addColorStop(0, 'rgba(255,255,255,1)');
      grad.addColorStop(.18, 'rgba(255,255,255,.85)');
      grad.addColorStop(.5, 'rgba(255,255,255,.14)');
      grad.addColorStop(1, 'rgba(255,255,255,0)');
      g.fillStyle = grad; g.fillRect(0, 0, w, h);
      g.globalCompositeOperation = 'lighter';
      g.strokeStyle = 'rgba(255,255,255,.85)'; g.lineWidth = 3;
      g.beginPath(); g.moveTo(cx - 26, cy); g.lineTo(cx + 26, cy);
      g.moveTo(cx, cy - 26); g.lineTo(cx, cy + 26); g.stroke();
    } else if (kind === 'ring') {
      g.strokeStyle = 'rgba(255,255,255,1)'; g.lineWidth = 7;
      g.beginPath(); g.arc(cx, cy, w / 2 - 6, 0, TAU); g.stroke();
      g.strokeStyle = 'rgba(255,255,255,.3)'; g.lineWidth = 14;
      g.beginPath(); g.arc(cx, cy, w / 2 - 6, 0, TAU); g.stroke();
    } else { // 'smoke' — lumpy blob
      const rng = makeRng(7);
      g.globalCompositeOperation = 'lighter';
      for (let i = 0; i < 9; i++) {
        const a = rng() * TAU, r = rng() * 13;
        const x = cx + Math.cos(a) * r, y = cy + Math.sin(a) * r, rr = 11 + rng() * 15;
        const grad = g.createRadialGradient(x, y, 0, x, y, rr);
        grad.addColorStop(0, 'rgba(255,255,255,.34)');
        grad.addColorStop(1, 'rgba(255,255,255,0)');
        g.fillStyle = grad; g.beginPath(); g.arc(x, y, rr, 0, TAU); g.fill();
      }
    }
  }, { clamp: true });
}

/* --- tiny DOM helpers ----------------------------------------------------- */
const $ = sel => document.querySelector(sel);
const $$ = sel => Array.prototype.slice.call(document.querySelectorAll(sel));
function el(tag, cls, html) {
  const e = document.createElement(tag);
  if (cls) e.className = cls;
  if (html != null) e.innerHTML = html;
  return e;
}
