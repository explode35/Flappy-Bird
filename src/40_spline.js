/* ============================================================================
   TRACK PATH — one closed Catmull-Rom spline resampled to equal arc length.
   This single structure drives: road geometry, surface queries, lap progress,
   AI racing lines, respawn points, minimap and item projectile guidance.
   ========================================================================= */

/** Catmull-Rom interpolation on a closed array of scalars. */
function crScalar(arr, t) {
  const n = arr.length;
  const f = t * n, i = Math.floor(f), u = f - i;
  const p0 = arr[(i - 1 + n) % n], p1 = arr[i % n], p2 = arr[(i + 1) % n], p3 = arr[(i + 2) % n];
  const u2 = u * u, u3 = u2 * u;
  return .5 * ((2 * p1) + (-p0 + p2) * u + (2 * p0 - 5 * p1 + 4 * p2 - p3) * u2 + (-p0 + 3 * p1 - 3 * p2 + p3) * u3);
}

const SAMPLES = 1400;

class TrackPath {
  /**
   * pts:  [[x, y, z, halfWidth], ...] describing a closed loop.
   * opts: { autoBank, maxBank, bankOverrides:[[s0,s1,deg],...] }
   *   Banking is derived from curvature so every corner leans into itself;
   *   overrides exist for signature sections (the Coral Verge wall-ride).
   */
  constructor(pts, opts) {
    opts = opts || {};
    const n = pts.length;
    this.ctrl = pts;
    const vec = [];
    for (let i = 0; i < n; i++) vec.push(new THREE.Vector3(pts[i][0], pts[i][1], pts[i][2]));
    const curve = new THREE.CatmullRomCurve3(vec, true, 'catmullrom', .5);
    this.curve = curve;

    // --- fine pass: measure arc length in curve parameter space
    const FINE = 6000;
    const fine = new Float32Array(FINE * 3), fineLen = new Float32Array(FINE);
    let prev = curve.getPoint(0, new THREE.Vector3()), total = 0;
    fine[0] = prev.x; fine[1] = prev.y; fine[2] = prev.z; fineLen[0] = 0;
    const tmp = new THREE.Vector3();
    for (let i = 1; i < FINE; i++) {
      curve.getPoint(i / (FINE - 1), tmp);
      total += tmp.distanceTo(prev);
      fine[i * 3] = tmp.x; fine[i * 3 + 1] = tmp.y; fine[i * 3 + 2] = tmp.z;
      fineLen[i] = total;
      prev.copy(tmp);
    }
    this.length = total;

    // --- resample to SAMPLES points spaced evenly by arc length
    const N = this.N = SAMPLES;
    const P = this.pos = new Float32Array(N * 3);
    const T = this.tan = new Float32Array(N * 3);
    const R = this.right = new Float32Array(N * 3);
    const UPv = this.up = new Float32Array(N * 3);
    const W = this.width = new Float32Array(N);
    const B = this.bank = new Float32Array(N);
    const C = this.curv = new Float32Array(N);
    const TT = this.param = new Float32Array(N);

    let fi = 0;
    const widths = pts.map(p => p[3] != null ? p[3] : 10);
    for (let i = 0; i < N; i++) {
      const target = total * i / N;
      while (fi < FINE - 2 && fineLen[fi + 1] < target) fi++;
      const seg = Math.max(1e-6, fineLen[fi + 1] - fineLen[fi]);
      const f = clamp01((target - fineLen[fi]) / seg);
      const t = (fi + f) / (FINE - 1);
      TT[i] = t;
      P[i * 3] = lerp(fine[fi * 3], fine[fi * 3 + 3], f);
      P[i * 3 + 1] = lerp(fine[fi * 3 + 1], fine[fi * 3 + 4], f);
      P[i * 3 + 2] = lerp(fine[fi * 3 + 2], fine[fi * 3 + 5], f);
      W[i] = crScalar(widths, t);
    }

    // tangents / flat frames from central differences of the resampled points
    const ds = total / N;
    for (let i = 0; i < N; i++) {
      const a = (i - 1 + N) % N, b = (i + 1) % N;
      let tx = P[b * 3] - P[a * 3], ty = P[b * 3 + 1] - P[a * 3 + 1], tz = P[b * 3 + 2] - P[a * 3 + 2];
      const l = Math.hypot(tx, ty, tz) || 1;
      tx /= l; ty /= l; tz /= l;
      T[i * 3] = tx; T[i * 3 + 1] = ty; T[i * 3 + 2] = tz;
      // right = normalise(cross(tangent, worldUp)) = (-tz, 0, tx)
      let rx = -tz, rz = tx;
      const rl = Math.hypot(rx, rz) || 1;
      rx /= rl; rz /= rl;
      R[i * 3] = rx; R[i * 3 + 1] = 0; R[i * 3 + 2] = rz;
    }

    // signed curvature on the flat frame: positive = turns toward +right
    for (let i = 0; i < N; i++) {
      const a = (i - 1 + N) % N, b = (i + 1) % N;
      const dtx = T[b * 3] - T[a * 3], dtz = T[b * 3 + 2] - T[a * 3 + 2];
      C[i] = (dtx * R[i * 3] + dtz * R[i * 3 + 2]) / (2 * ds);
    }
    {
      const Cs = new Float32Array(N);
      for (let i = 0; i < N; i++) {
        let acc = 0;
        for (let k = -6; k <= 6; k++) acc += C[(i + k + N) % N];
        Cs[i] = acc / 13;
      }
      C.set(Cs);
      this.curv = C;
    }

    // --- banking: auto from curvature, then blended manual overrides.
    // autoK is radians of lean per unit curvature (1/m): a 60m-radius corner
    // (k=.017) leans ~12deg at the default.
    const autoK = opts.autoBank == null ? 12 : opts.autoBank;
    const maxB = deg(opts.maxBank == null ? 13 : opts.maxBank);
    for (let i = 0; i < N; i++) {
      B[i] = clamp(-C[i] * autoK, -maxB, maxB);
    }
    if (opts.bankOverrides) {
      for (let o = 0; o < opts.bankOverrides.length; o++) {
        const [s0, s1, degs] = opts.bankOverrides[o];
        const i0 = Math.floor(s0 * N), i1 = Math.floor(s1 * N);
        const span = (i1 - i0 + N) % N;
        for (let k = 0; k <= span; k++) {
          const i = (i0 + k) % N;
          // ease in/out so the transition onto the wall is drivable
          const f = clamp01(Math.min(k, span - k) / Math.max(1, span * .22));
          const e = f * f * (3 - 2 * f);
          B[i] = lerp(B[i], deg(degs), e);
        }
      }
    }
    // smooth the bank profile so the frame never snaps
    {
      const Bs = new Float32Array(N);
      for (let i = 0; i < N; i++) {
        let acc = 0;
        for (let k = -9; k <= 9; k++) acc += B[(i + k + N) % N];
        Bs[i] = acc / 19;
      }
      B.set(Bs);
    }

    // rotate the frame about the tangent by the bank angle
    for (let i = 0; i < N; i++) {
      const cb = Math.cos(B[i]), sb = Math.sin(B[i]);
      const rx = R[i * 3], rz = R[i * 3 + 2];
      // banked right vector: tilt upward by bank
      R[i * 3] = rx * cb; R[i * 3 + 1] = sb; R[i * 3 + 2] = rz * cb;
      // up = right x tangent (keeps a right-handed frame)
      const tx = T[i * 3], ty = T[i * 3 + 1], tz = T[i * 3 + 2];
      const ux = R[i * 3 + 1] * tz - R[i * 3 + 2] * ty;
      const uy = R[i * 3 + 2] * tx - R[i * 3] * tz;
      const uz = R[i * 3] * ty - R[i * 3 + 1] * tx;
      const ul = Math.hypot(ux, uy, uz) || 1;
      UPv[i * 3] = ux / ul; UPv[i * 3 + 1] = uy / ul; UPv[i * 3 + 2] = uz / ul;
    }
    this.ds = ds;
    this._buildRacingLine();
    this._buildGrid();
  }

  idxOf(s) { return ((Math.floor(s * this.N) % this.N) + this.N) % this.N; }
  sOf(i) { return i / this.N; }

  /** Write centre position at normalised progress s into `out`. */
  posAt(s, out) {
    const f = ((s % 1) + 1) % 1 * this.N;
    const i = Math.floor(f) % this.N, j = (i + 1) % this.N, u = f - Math.floor(f);
    out.set(
      lerp(this.pos[i * 3], this.pos[j * 3], u),
      lerp(this.pos[i * 3 + 1], this.pos[j * 3 + 1], u),
      lerp(this.pos[i * 3 + 2], this.pos[j * 3 + 2], u)
    );
    return out;
  }
  tanAt(s, out) {
    const i = this.idxOf(s);
    return out.set(this.tan[i * 3], this.tan[i * 3 + 1], this.tan[i * 3 + 2]);
  }
  rightAt(s, out) {
    const i = this.idxOf(s);
    return out.set(this.right[i * 3], this.right[i * 3 + 1], this.right[i * 3 + 2]);
  }
  widthAt(s) { return this.width[this.idxOf(s)]; }
  bankAt(s) { return this.bank[this.idxOf(s)]; }
  curvAt(s) { return this.curv[this.idxOf(s)]; }
  headingAt(s) { const i = this.idxOf(s); return Math.atan2(this.tan[i * 3], this.tan[i * 3 + 2]); }

  /** World point at (s, lateral offset u), following the banked cross-section. */
  surfacePoint(s, u, out) {
    this.posAt(s, out);
    const i = this.idxOf(s);
    out.x += this.right[i * 3] * u;
    out.y += this.right[i * 3 + 1] * u;
    out.z += this.right[i * 3 + 2] * u;
    return out;
  }

  /* --- spatial grid so first-time projection is O(1)-ish ----------------- */
  _buildGrid() {
    const cell = this.cell = 26;
    const g = this.grid = new Map();
    let minX = 1e9, minZ = 1e9, maxX = -1e9, maxZ = -1e9;
    for (let i = 0; i < this.N; i++) {
      const x = this.pos[i * 3], z = this.pos[i * 3 + 2];
      minX = Math.min(minX, x); maxX = Math.max(maxX, x);
      minZ = Math.min(minZ, z); maxZ = Math.max(maxZ, z);
      const key = Math.floor(x / cell) + ',' + Math.floor(z / cell);
      let a = g.get(key); if (!a) { a = []; g.set(key, a); }
      a.push(i);
    }
    this.bounds = { minX, minZ, maxX, maxZ, cx: (minX + maxX) / 2, cz: (minZ + maxZ) / 2, w: maxX - minX, h: maxZ - minZ };
  }

  /** Nearest sample index to a world XZ, using the hint if we have one. */
  nearestIndex(x, z, hint) {
    if (hint != null && hint >= 0) {
      let best = -1, bd = 1e18;
      // karts move continuously — a local window around the last index is enough
      for (let k = -34; k <= 34; k++) {
        const i = (hint + k + this.N) % this.N;
        const dx = x - this.pos[i * 3], dz = z - this.pos[i * 3 + 2];
        const d = dx * dx + dz * dz;
        if (d < bd) { bd = d; best = i; }
      }
      if (bd < 4900) return best;   // within 70m — trust it
    }
    const cell = this.cell;
    const cx = Math.floor(x / cell), cz = Math.floor(z / cell);
    let best = -1, bd = 1e18;
    for (let r = 0; r <= 6 && best < 0; r++) {
      for (let a = -r; a <= r; a++) for (let b = -r; b <= r; b++) {
        if (r > 0 && Math.abs(a) !== r && Math.abs(b) !== r) continue;
        const arr = this.grid.get((cx + a) + ',' + (cz + b));
        if (!arr) continue;
        for (let k = 0; k < arr.length; k++) {
          const i = arr[k];
          const dx = x - this.pos[i * 3], dz = z - this.pos[i * 3 + 2];
          const d = dx * dx + dz * dz;
          if (d < bd) { bd = d; best = i; }
        }
      }
    }
    if (best < 0) {
      for (let i = 0; i < this.N; i++) {
        const dx = x - this.pos[i * 3], dz = z - this.pos[i * 3 + 2];
        const d = dx * dx + dz * dz;
        if (d < bd) { bd = d; best = i; }
      }
    }
    return best;
  }

  /**
   * Project a world position onto the path.
   * out gets {s, u, i, height, bank, curv, width} — the backbone of all physics.
   */
  project(x, y, z, hint, out) {
    const i = this.nearestIndex(x, z, hint);
    // refine between i-1..i+1 by projecting onto the two adjacent segments
    let bi = i, bt = 0, bd = 1e18, bu = 0;
    for (let k = -1; k <= 0; k++) {
      const a = (i + k + this.N) % this.N, b = (a + 1) % this.N;
      const ax = this.pos[a * 3], ay = this.pos[a * 3 + 1], az = this.pos[a * 3 + 2];
      const bx = this.pos[b * 3], by = this.pos[b * 3 + 1], bz = this.pos[b * 3 + 2];
      const ex = bx - ax, ez = bz - az;
      const len2 = ex * ex + ez * ez || 1;
      let t = ((x - ax) * ex + (z - az) * ez) / len2;
      t = clamp01(t);
      const px = ax + ex * t, pz = az + ez * t;
      const dx = x - px, dz = z - pz;
      const d = dx * dx + dz * dz;
      if (d < bd) { bd = d; bi = a; bt = t; }
    }
    const j = (bi + 1) % this.N;
    const rx = lerp(this.right[bi * 3], this.right[j * 3], bt);
    const ry = lerp(this.right[bi * 3 + 1], this.right[j * 3 + 1], bt);
    const rz = lerp(this.right[bi * 3 + 2], this.right[j * 3 + 2], bt);
    const cxp = lerp(this.pos[bi * 3], this.pos[j * 3], bt);
    const cyp = lerp(this.pos[bi * 3 + 1], this.pos[j * 3 + 1], bt);
    const czp = lerp(this.pos[bi * 3 + 2], this.pos[j * 3 + 2], bt);
    // lateral offset measured on the flat plane then lifted onto the bank
    const rl = Math.hypot(rx, rz) || 1e-6;
    const u = ((x - cxp) * (rx / rl) + (z - czp) * (rz / rl)) / Math.max(.25, rl);
    out.i = bi;
    out.s = (bi + bt) / this.N;
    out.u = u;
    out.height = cyp + ry * u;
    out.cx = cxp; out.cy = cyp; out.cz = czp;
    out.rx = rx; out.ry = ry; out.rz = rz;
    out.bank = lerp(this.bank[bi], this.bank[j], bt);
    out.curv = lerp(this.curv[bi], this.curv[j], bt);
    out.width = lerp(this.width[bi], this.width[j], bt);
    out.tx = lerp(this.tan[bi * 3], this.tan[j * 3], bt);
    out.ty = lerp(this.tan[bi * 3 + 1], this.tan[j * 3 + 1], bt);
    out.tz = lerp(this.tan[bi * 3 + 2], this.tan[j * 3 + 2], bt);
    return out;
  }

  /**
   * Pre-computed racing line: shifts toward the inside of corners with
   * look-back/look-ahead smoothing so it flows (late apex, early exit).
   */
  _buildRacingLine() {
    const N = this.N;
    const raw = new Float32Array(N);
    for (let i = 0; i < N; i++) {
      const k = this.curv[i];
      const w = this.width[i];
      // inside of the corner is -sign(curv); magnitude saturates on tight bends
      raw[i] = -sign(k) * Math.min(1, Math.abs(k) * 62) * (w - 3.1);
      // On steeply banked sections the fast line is *up* the wall, not on the
      // apex — this is what turns a banked corner into a wall-ride.
      const steep = smoothstep(deg(26), deg(44), Math.abs(this.bank[i]));
      if (steep > 0) raw[i] = lerp(raw[i], sign(this.bank[i]) * (w - 2.4), steep);
    }
    // two-pass smoothing widens entry and straightens exits
    let a = new Float32Array(N), b = new Float32Array(N);
    for (let i = 0; i < N; i++) {
      let acc = 0, wsum = 0;
      for (let k = -26; k <= 26; k++) {
        const wgt = 1 - Math.abs(k) / 30;
        acc += raw[(i + k + N) % N] * wgt; wsum += wgt;
      }
      a[i] = acc / wsum;
    }
    for (let i = 0; i < N; i++) {
      let acc = 0, wsum = 0;
      for (let k = -12; k <= 12; k++) {
        const wgt = 1 - Math.abs(k) / 16;
        acc += a[(i + k + N) % N] * wgt; wsum += wgt;
      }
      b[i] = clamp(acc / wsum, -(this.width[i] - 2.6), this.width[i] - 2.6);
    }
    this.line = b;

    // Target speed along the line, from local curvature (used by AI braking).
    const v = this.lineSpeed = new Float32Array(N);
    for (let i = 0; i < N; i++) {
      const k = Math.abs(this.curv[i]) + 1e-5;
      const bankHelp = 1 + Math.abs(Math.sin(this.bank[i])) * .8;
      v[i] = clamp(Math.sqrt(13.2 * bankHelp / k), 12, 200);
    }
    // propagate braking backwards so AI slows *before* the corner
    for (let pass = 0; pass < 3; pass++) {
      for (let n = N - 1; n >= 0; n--) {
        const i = n, j = (i + 1) % N;
        const maxV = Math.sqrt(v[j] * v[j] + 2 * 26 * this.ds);
        if (v[i] > maxV) v[i] = maxV;
      }
    }
  }

  lineOffsetAt(s) {
    const f = ((s % 1) + 1) % 1 * this.N;
    const i = Math.floor(f) % this.N, j = (i + 1) % this.N;
    return lerp(this.line[i], this.line[j], f - Math.floor(f));
  }
  lineSpeedAt(s) {
    const f = ((s % 1) + 1) % 1 * this.N;
    const i = Math.floor(f) % this.N, j = (i + 1) % this.N;
    return lerp(this.lineSpeed[i], this.lineSpeed[j], f - Math.floor(f));
  }
}
