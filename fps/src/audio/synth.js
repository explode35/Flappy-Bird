/**
 * ============================================================================
 *  synth.js — the runtime synthesis toolkit.
 * ============================================================================
 *  Pure WebAudio helpers. NO imports, NO three, NO game knowledge — so this
 *  file can be loaded by an OfflineAudioContext test harness verbatim.
 *
 *  Everything here is allocation-conscious: the only AudioBuffers ever created
 *  are the three noise beds and the reverb impulse responses, and both are
 *  built exactly once at init. Per-shot we only ever spin up cheap
 *  AudioBufferSourceNodes over the *same* buffers.
 * ============================================================================
 */

export const dbToGain = (db) => Math.pow(10, db / 20);
export const gainToDb = (g) => 20 * Math.log10(Math.max(1e-9, g));
export const clamp = (v, a, b) => (v < a ? a : v > b ? b : v);
export const lerp = (a, b, t) => a + (b - a) * t;

/** Tiny deterministic PRNG (mulberry32) so IR generation is reproducible. */
export function mulberry(seed = 1) {
  let a = seed >>> 0;
  return function () {
    a |= 0; a = (a + 0x6D2B79F5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** Symmetric multiplicative jitter: jit(rng, 0.04) -> 0.96 .. 1.04 */
export const jit = (rng, amt) => 1 + (rng() * 2 - 1) * amt;
/** Additive dB jitter as a linear multiplier: jitDb(rng, 1.5) -> ±1.5 dB */
export const jitDb = (rng, db) => dbToGain((rng() * 2 - 1) * db);

// ---------------------------------------------------------------------------
//  Noise beds — generated ONCE, reused forever.
// ---------------------------------------------------------------------------

/**
 * White / pink / brown noise beds. Mono, `seconds` long. Each play reads from
 * a random offset so repeated shots never phase-lock into a machine-gun buzz.
 */
export function makeNoiseBuffers(ac, seconds = 3) {
  const sr = ac.sampleRate;
  const n = Math.max(1024, Math.floor(sr * seconds));
  const white = ac.createBuffer(1, n, sr);
  const pink = ac.createBuffer(1, n, sr);
  const brown = ac.createBuffer(1, n, sr);
  const w = white.getChannelData(0);
  const p = pink.getChannelData(0);
  const b = brown.getChannelData(0);

  let b0 = 0, b1 = 0, b2 = 0, b3 = 0, b4 = 0, b5 = 0, b6 = 0;
  let last = 0, pmax = 1e-9, bmax = 1e-9;
  for (let i = 0; i < n; i++) {
    const v = Math.random() * 2 - 1;
    w[i] = v;
    // Paul Kellet's refined pink filter.
    b0 = 0.99886 * b0 + v * 0.0555179;
    b1 = 0.99332 * b1 + v * 0.0750759;
    b2 = 0.96900 * b2 + v * 0.1538520;
    b3 = 0.86650 * b3 + v * 0.3104856;
    b4 = 0.55000 * b4 + v * 0.5329522;
    b5 = -0.7616 * b5 - v * 0.0168980;
    const pv = b0 + b1 + b2 + b3 + b4 + b5 + b6 + v * 0.5362;
    b6 = v * 0.115926;
    p[i] = pv;
    const ap = pv < 0 ? -pv : pv; if (ap > pmax) pmax = ap;
    // Leaky integrator -> brown (-6 dB/oct).
    last = (last + 0.02 * v) / 1.02;
    b[i] = last;
    const ab = last < 0 ? -last : last; if (ab > bmax) bmax = ab;
  }
  const ps = 0.985 / pmax, bs = 0.985 / bmax;
  for (let i = 0; i < n; i++) { p[i] *= ps; b[i] *= bs; }
  return { white, pink, brown, seconds: n / sr };
}

/**
 * One-shot noise voice over a pre-generated bed.
 * @returns AudioBufferSourceNode already started/stopped.
 */
export function noiseSrc(ac, buf, t0, dur, rate = 1, rng = Math.random) {
  const s = ac.createBufferSource();
  s.buffer = buf;
  s.playbackRate.value = rate;
  const span = Math.max(0, buf.duration - dur * rate - 0.02);
  s.start(Math.max(0, t0), rng() * span);
  s.stop(Math.max(0, t0) + dur + 0.03);
  return s;
}

/** Oscillator voice. */
export function osc(ac, type, freq, t0, dur, detune = 0) {
  const o = ac.createOscillator();
  o.type = type;
  o.frequency.value = freq;
  if (detune) o.detune.value = detune;
  o.start(Math.max(0, t0));
  o.stop(Math.max(0, t0) + dur + 0.02);
  return o;
}

// ---------------------------------------------------------------------------
//  Envelopes
// ---------------------------------------------------------------------------

/**
 * Percussive envelope: linear attack (so transients stay genuinely sharp),
 * exponential decay (so tails sound natural), hard zero at the end so the
 * node can be reclaimed without a click.
 * @returns GainNode — connect the source into it.
 */
export function env(ac, t0, o = {}) {
  const peak = Math.max(1e-5, o.peak == null ? 1 : o.peak);
  const attack = Math.max(0.00005, o.attack == null ? 0.001 : o.attack);
  const hold = o.hold || 0;
  const decay = Math.max(0.002, o.decay == null ? 0.1 : o.decay);
  const floor = o.floor == null ? 0.0008 : o.floor;
  const g = ac.createGain();
  const p = g.gain;
  const t = Math.max(0, t0);
  p.setValueAtTime(0, t);
  p.linearRampToValueAtTime(peak, t + attack);
  if (hold > 0) p.setValueAtTime(peak, t + attack + hold);
  p.exponentialRampToValueAtTime(peak * floor, t + attack + hold + decay);
  p.linearRampToValueAtTime(0, t + attack + hold + decay + 0.006);
  g._end = t + attack + hold + decay + 0.008;
  return g;
}

/** Classic ADSR for sustained material (music pads, sirens). */
export function adsr(ac, t0, o = {}) {
  const { a = 0.01, d = 0.1, s = 0.6, r = 0.3, peak = 1, dur = 0.5 } = o;
  const g = ac.createGain();
  const p = g.gain;
  const t = Math.max(0, t0);
  p.setValueAtTime(0, t);
  p.linearRampToValueAtTime(peak, t + a);
  p.exponentialRampToValueAtTime(Math.max(1e-4, peak * s), t + a + d);
  const rel = t + Math.max(a + d, dur);
  p.setValueAtTime(Math.max(1e-4, peak * s), rel);
  p.exponentialRampToValueAtTime(1e-4, rel + r);
  p.linearRampToValueAtTime(0, rel + r + 0.005);
  g._end = rel + r + 0.008;
  return g;
}

/** Exponential parameter sweep, guarded against non-positive targets. */
export function sweep(param, t0, from, to, time) {
  const t = Math.max(0, t0);
  param.setValueAtTime(Math.max(1e-3, from), t);
  param.exponentialRampToValueAtTime(Math.max(1e-3, to), t + Math.max(0.002, time));
  return param;
}

// ---------------------------------------------------------------------------
//  Filters
// ---------------------------------------------------------------------------

/**
 * Build a serial biquad chain from a spec list.
 * spec: [{ type, freq, Q, gain }]  — returns { in, out, nodes }.
 */
export function filterChain(ac, specs) {
  const nodes = [];
  let head = null, tail = null;
  for (const s of specs) {
    if (!s) continue;
    const f = ac.createBiquadFilter();
    f.type = s.type || 'lowpass';
    f.frequency.value = clamp(s.freq == null ? 1000 : s.freq, 10, ac.sampleRate * 0.48);
    if (s.Q != null) f.Q.value = s.Q;
    if (s.gain != null) f.gain.value = s.gain;
    nodes.push(f);
    if (!head) head = f; else tail.connect(f);
    tail = f;
  }
  if (!head) { const g = ac.createGain(); return { in: g, out: g, nodes: [g] }; }
  return { in: head, out: tail, nodes };
}

/** Resonant bandpass pair: steeper skirts than one biquad, keeps the ring. */
export function bandpass(ac, freq, Q = 6, stages = 2) {
  const specs = [];
  for (let i = 0; i < stages; i++) specs.push({ type: 'bandpass', freq, Q });
  return filterChain(ac, specs);
}

/** Peaking EQ helper. */
export function peaking(ac, freq, Q = 1, gain = 6) {
  return filterChain(ac, [{ type: 'peaking', freq, Q, gain }]);
}

// ---------------------------------------------------------------------------
//  Waveshaping
// ---------------------------------------------------------------------------

const _curveCache = new Map();

/**
 * Waveshaper curves.
 *   'tanh'  — smooth analogue-ish saturation (mic/preamp overload on gunfire)
 *   'hard'  — asymmetric clipper, nastier, for explosion body
 *   'fold'  — wavefolder, metallic, for debris/glass grit
 */
export function distortionCurve(kind = 'tanh', amount = 2, n = 2048) {
  const key = kind + '|' + amount + '|' + n;
  let c = _curveCache.get(key);
  if (c) return c;
  c = new Float32Array(n);
  const k = Math.max(0.001, amount);
  for (let i = 0; i < n; i++) {
    const x = (i / (n - 1)) * 2 - 1;
    let y;
    if (kind === 'hard') {
      y = Math.max(-0.92, Math.min(1, x * k));
      y = y / Math.max(1, k * 0.8);
    } else if (kind === 'fold') {
      y = Math.sin(x * k * 1.6) / Math.max(1, k * 0.35);
    } else {
      y = Math.tanh(x * k) / Math.tanh(k);
    }
    c[i] = y;
  }
  _curveCache.set(key, c);
  return c;
}

export function shaper(ac, kind = 'tanh', amount = 2) {
  const w = ac.createWaveShaper();
  w.curve = distortionCurve(kind, amount);
  w.oversample = '2x';
  return w;
}

// ---------------------------------------------------------------------------
//  Transient click — the single most important ingredient in a gunshot.
// ---------------------------------------------------------------------------

/**
 * A sub-2 ms broadband spike with a tuned "snap" formant.
 * @returns { out: GainNode, src: AudioBufferSourceNode, end: number }
 */
export function transient(ac, t0, buf, o = {}) {
  const dur = o.dur == null ? 0.0016 : o.dur;
  const peak = o.peak == null ? 0.6 : o.peak;
  const hp = o.hp == null ? 2200 : o.hp;
  const tone = o.tone == null ? 5000 : o.tone;
  const toneGain = o.toneGain == null ? 9 : o.toneGain;
  const rng = o.rng || Math.random;

  const s = noiseSrc(ac, buf, t0, dur + 0.006, o.rate || 1, rng);
  const ch = filterChain(ac, [
    { type: 'highpass', freq: hp, Q: 0.6 },
    { type: 'peaking', freq: tone, Q: 1.2, gain: toneGain },
  ]);
  const g = env(ac, t0, {
    peak,
    attack: Math.min(0.00025, dur * 0.18),
    decay: dur,
    floor: 0.0012,
  });
  s.connect(ch.in); ch.out.connect(g);
  return { out: g, src: s, end: g._end };
}

/**
 * Inharmonic metallic resonance — bolt carriers, casings, ricochets, hinges.
 * @returns { out, srcs, end }
 */
export function metallic(ac, t0, o = {}) {
  const f = o.freq == null ? 2400 : o.freq;
  const peak = o.peak == null ? 0.12 : o.peak;
  const decay = o.decay == null ? 0.09 : o.decay;
  const rng = o.rng || Math.random;
  const ratios = o.ratios || [1, 2.37, 3.61, 5.43];
  const out = ac.createGain();
  out.gain.value = 1;
  const srcs = [];
  let end = t0;
  for (let i = 0; i < ratios.length; i++) {
    const fr = f * ratios[i] * jit(rng, 0.03);
    if (fr > ac.sampleRate * 0.45) continue;
    const d = decay * Math.pow(0.62, i);
    const o1 = osc(ac, i === 0 ? 'triangle' : 'sine', fr, t0, d + 0.02);
    const g = env(ac, t0, { peak: peak * Math.pow(0.55, i), attack: 0.0004, decay: d, floor: 0.002 });
    o1.connect(g); g.connect(out);
    srcs.push(o1);
    if (g._end > end) end = g._end;
  }
  return { out, srcs, end };
}

// ---------------------------------------------------------------------------
//  Impulse-response generator for convolution reverb.
// ---------------------------------------------------------------------------

/**
 * Synthesise a stereo IR.
 *   rt60      reverberation time (s)
 *   seconds   IR length; keep >= rt60 * 0.8
 *   hf0/hfEnd high-frequency damping envelope (air + soft surfaces)
 *   density   1 = dense diffuse field, <1 = sparse discrete reflections
 *   early     [[timeSec, gain], ...] discrete early reflections / slapbacks
 *   norm      target per-channel L2 norm (energy-matched across zones)
 */
export function makeImpulseResponse(ac, opts = {}) {
  const o = Object.assign({
    seconds: 2.0, rt60: 1.6, preDelay: 0.006,
    hf0: 9000, hfEnd: 700, damp: 1.2,
    density: 1.0, early: [], seed: 1, width: 0.9, norm: 1.0,
  }, opts);

  const sr = ac.sampleRate;
  const n = Math.max(256, Math.floor(sr * o.seconds));
  const ir = ac.createBuffer(2, n, sr);
  const pd = Math.floor(Math.max(0, o.preDelay) * sr);
  const decayK = 6.9078 / Math.max(0.05, o.rt60);

  for (let c = 0; c < 2; c++) {
    const d = ir.getChannelData(c);
    const rnd = mulberry(o.seed * 7919 + c * 104729);
    let lp = 0, a = 0, recalc = 0;
    for (let i = pd; i < n; i++) {
      const t = (i - pd) / sr;
      if (recalc-- <= 0) {
        recalc = 32;
        const fc = Math.max(o.hfEnd, o.hf0 * Math.exp(-o.damp * t));
        a = Math.exp(-2 * Math.PI * fc / sr);
      }
      let v = rnd() * 2 - 1;
      if (o.density < 1 && rnd() > o.density) v = 0;
      lp = lp * a + v * (1 - a);
      d[i] = lp * Math.exp(-decayK * t);
    }
    // Discrete early reflections / slapbacks, decorrelated per channel.
    for (let k = 0; k < o.early.length; k++) {
      const et = o.early[k][0], eg = o.early[k][1];
      const skew = (c ? 1 : -1) * o.width * 0.0011 * (0.4 + rnd());
      const idx = pd + Math.floor((et + skew + rnd() * 0.0008) * sr);
      if (idx > 0 && idx < n - 2) {
        const sgn = rnd() < 0.5 ? -1 : 1;
        d[idx] += eg * sgn;
        d[idx + 1] += eg * sgn * 0.5;
        d[idx + 2] -= eg * sgn * 0.22;
      }
    }
  }

  // Energy-match so crossfading between zones never jumps in level.
  let e = 0;
  for (let c = 0; c < 2; c++) {
    const d = ir.getChannelData(c);
    for (let i = 0; i < n; i++) e += d[i] * d[i];
  }
  const rms = Math.sqrt(e / (2 * n));
  const target = o.norm * 0.035;
  const s = rms > 1e-9 ? target / rms : 1;
  let pk = 0;
  for (let c = 0; c < 2; c++) {
    const d = ir.getChannelData(c);
    for (let i = 0; i < n; i++) { d[i] *= s; const av = d[i] < 0 ? -d[i] : d[i]; if (av > pk) pk = av; }
  }
  // Never let a stray early reflection spike drive the convolver into clipping.
  if (pk > 0.98) {
    const k = 0.98 / pk;
    for (let c = 0; c < 2; c++) {
      const d = ir.getChannelData(c);
      for (let i = 0; i < n; i++) d[i] *= k;
    }
  }
  return ir;
}
