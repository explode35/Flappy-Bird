import {
  dbToGain, clamp, lerp, mulberry, jit, jitDb, makeNoiseBuffers, noiseSrc,
  osc, env, adsr, sweep, filterChain, bandpass, peaking, distortionCurve,
  shaper, transient, metallic, makeImpulseResponse,
} from './synth.js';

/**
 * Procedural spatial audio. No sample files — every sound is synthesised.
 *
 * A gunshot is layered the way a real one is: a sub-2 ms transient click, a
 * filtered noise body with a fast exponential decay, a resonant crack from a
 * bandpassed peak, a metallic action layer, and a reverb tail whose level rises
 * relative to the direct sound with distance. That last part is what actually
 * sells distance — far more than volume alone.
 */

const VOICE_LIMIT = 24;

export class Audio {
  constructor(ctx) {
    this.ctx = ctx;
    this.ac = null;
    this.ready = false;
    this.muted = false;
    this.rng = mulberry(1337);
    this.voices = [];
    this._lastStep = 0;
    this._occlusionCache = new Map();
  }

  async init() {
    // Browsers require a gesture; pointer lock is ours.
    this.ctx.bus.on('input:lock', () => this._start());
    this._bind();
  }

  _start() {
    if (this.ac) { if (this.ac.state === 'suspended') this.ac.resume(); return; }
    try {
      const AC = window.AudioContext || window.webkitAudioContext;
      if (!AC) return;
      this.ac = new AC({ latencyHint: 'interactive' });
    } catch { return; }
    const ac = this.ac;

    // --- master chain -------------------------------------------------------
    this.limiter = ac.createDynamicsCompressor();
    this.limiter.threshold.value = -6;
    this.limiter.knee.value = 6;
    this.limiter.ratio.value = 12;
    this.limiter.attack.value = 0.002;
    this.limiter.release.value = 0.18;

    this.master = ac.createGain();
    this.master.gain.value = 0.85;
    this.limiter.connect(this.master).connect(ac.destination);

    const bus = (v) => { const g = ac.createGain(); g.gain.value = v; g.connect(this.limiter); return g; };
    this.buses = {
      weapon: bus(1.0), world: bus(0.85), ui: bus(0.7), music: bus(0.4),
    };

    // Sidechain: the world bus ducks under the player's own gunfire.
    this.duck = ac.createGain();
    this.duck.gain.value = 1;
    this.buses.world.disconnect();
    this.buses.world.connect(this.duck).connect(this.limiter);

    this.noise = makeNoiseBuffers(ac, 3);

    // --- reverb zones -------------------------------------------------------
    this.convolvers = {};
    this.sends = {};
    const zones = {
      interior: { seconds: 0.55, decay: 3.2, predelay: 0.006, damp: 0.55 },
      warehouse: { seconds: 1.6, decay: 2.0, predelay: 0.014, damp: 0.35 },
      street: { seconds: 1.1, decay: 2.6, predelay: 0.020, damp: 0.28 },
      open: { seconds: 2.4, decay: 1.6, predelay: 0.030, damp: 0.18 },
    };
    for (const [name, o] of Object.entries(zones)) {
      const c = ac.createConvolver();
      c.buffer = makeImpulseResponse(ac, o);
      const send = ac.createGain();
      send.gain.value = name === 'street' ? 0.4 : 0;
      send.connect(c).connect(this.limiter);
      this.convolvers[name] = c;
      this.sends[name] = send;
    }
    this.zone = 'street';

    this.listener = ac.listener;
    this.ready = true;
    this._startMusic();
  }

  // -------------------------------------------------------------------------

  _bind() {
    const bus = this.ctx.bus;
    bus.on('weapon:fire', (e) => this.gunshot(e.weapon, e.origin, true));
    bus.on('enemy:fire', (e) => this.gunshot('enemy', e.origin, false));
    bus.on('impact', (e) => this.impact(e.surface, e.point));
    bus.on('hit:enemy', (e) => this.impact('flesh', e.point));
    bus.on('player:step', (e) => this.footstep(e.surface, e.running));
    bus.on('weapon:reload', (e) => this.reload(e.phase, e.empty));
    bus.on('weapon:changed', () => this.play('swap'));
    bus.on('weapon:dryfire', () => this.play('dryfire'));
    bus.on('shell:bounce', (e) => this.shellBounce(e.point, e.speed));
    bus.on('explosion', (e) => this.explosion(e.point));
    bus.on('whizz', (e) => this.whizz(e.distance));
    bus.on('enemy:death', (e) => this.impact('flesh', e.point));
    bus.on('player:damage', () => this.play('hurt'));
  }

  // -------------------------------------------------------------------------
  //  Voice management
  // -------------------------------------------------------------------------

  /**
   * Allocate an output node for one sound. Returns null when the voice budget
   * is exhausted and this sound is not worth stealing for — without this, a
   * firefight becomes clipped mush.
   */
  _voice(busName, priority = 1, pos = null) {
    if (!this.ready || this.muted) return null;
    const now = this.ac.currentTime;
    this.voices = this.voices.filter((v) => v.until > now);
    if (this.voices.length >= VOICE_LIMIT) {
      let worst = -1, worstP = priority;
      for (let i = 0; i < this.voices.length; i++) {
        if (this.voices[i].priority < worstP) { worstP = this.voices[i].priority; worst = i; }
      }
      if (worst < 0) return null;
      try { this.voices[worst].node.disconnect(); } catch { /* already gone */ }
      this.voices.splice(worst, 1);
    }

    const out = this.ac.createGain();
    out.gain.value = 1;

    let node = out;
    if (pos) {
      const panner = this.ac.createPanner();
      panner.panningModel = 'HRTF';
      panner.distanceModel = 'inverse';
      panner.refDistance = 4;
      panner.maxDistance = 240;
      panner.rolloffFactor = 1.1;
      panner.positionX.value = pos.x;
      panner.positionY.value = pos.y;
      panner.positionZ.value = pos.z;

      // Air absorption: the cutoff falls with distance. This does more for the
      // sense of range than attenuation does.
      const cam = this.ctx.camera;
      const dist = cam ? cam.position.distanceTo(pos) : 10;
      const lp = this.ac.createBiquadFilter();
      lp.type = 'lowpass';
      lp.frequency.value = clamp(19000 * Math.exp(-dist / 42), 700, 19000);

      // Occlusion: if the world blocks the path, duck and darken it further.
      if (this._occluded(pos)) {
        lp.frequency.value = Math.min(lp.frequency.value, 780);
        out.gain.value *= 0.42;
      }

      out.connect(lp).connect(panner);
      panner.connect(this.buses[busName]);
      // Reverb send scales with distance — the tail carries when direct fades.
      const send = this.ac.createGain();
      send.gain.value = clamp(dist / 60, 0.05, 0.85);
      panner.connect(send).connect(this.sends[this.zone]);
      node = out;
    } else {
      out.connect(this.buses[busName]);
    }

    this.voices.push({ node: out, priority, until: now + 4 });
    return node;
  }

  _occluded(pos) {
    const phys = this.ctx.physics;
    const cam = this.ctx.camera;
    if (!phys?.lineOfSight || !cam) return false;
    return !phys.lineOfSight(cam.position, pos);
  }

  // -------------------------------------------------------------------------
  //  Gunfire
  // -------------------------------------------------------------------------

  /** Per-weapon spectral signature. */
  static SIG = {
    m4:    { body: 620, bodyQ: 1.1, crack: 2400, decay: 0.085, sub: 78,  level: 1.00, tail: 0.55 },
    mp5:   { body: 780, bodyQ: 1.3, crack: 3100, decay: 0.062, sub: 96,  level: 0.86, tail: 0.42 },
    m1911: { body: 520, bodyQ: 0.9, crack: 1900, decay: 0.095, sub: 68,  level: 0.92, tail: 0.50 },
    enemy: { body: 560, bodyQ: 1.0, crack: 2100, decay: 0.080, sub: 74,  level: 0.80, tail: 0.60 },
  };

  gunshot(weapon, pos, isPlayer) {
    const out = this._voice('weapon', isPlayer ? 5 : 3, isPlayer ? null : pos);
    if (!out) return;
    const ac = this.ac, r = this.rng, t0 = ac.currentTime;
    const S = Audio.SIG[weapon] || Audio.SIG.m4;
    const lvl = S.level * (isPlayer ? 1 : 0.85) * jitDb(r, 1.5);

    // (a) transient — the initial crack of the muzzle blast, under 2 ms
    const tr = transient(ac, t0, this.noise.white, { dur: 0.0018, gain: 0.9 * lvl });
    // transient() returns { out, src, end }, not a node.
    if (tr) tr.out.connect(out);

    // (b) body — filtered noise burst, fast exponential decay
    const bodySrc = noiseSrc(ac, this.noise.white, t0, S.decay * 3, jit(r, 0.04), r);
    // bandpass() hands back filterChain()'s { in, out, nodes }, not an array.
    const bp = bandpass(ac, S.body * jit(r, 0.06), S.bodyQ, 2);
    const bodyGain = ac.createGain();
    bodyGain.gain.setValueAtTime(1.1 * lvl, t0);
    bodyGain.gain.exponentialRampToValueAtTime(0.0008, t0 + S.decay * 3);
    bodySrc.connect(bp.in);
    bp.out.connect(bodyGain).connect(out);

    // (c) resonant crack — a narrow peak riding on top
    const crackSrc = noiseSrc(ac, this.noise.white, t0, 0.05, 1, r);
    const pk = peaking(ac, S.crack * jit(r, 0.05), 3.5, 12);
    const crackGain = ac.createGain();
    crackGain.gain.setValueAtTime(0.55 * lvl, t0);
    crackGain.gain.exponentialRampToValueAtTime(0.0008, t0 + 0.05);
    // peaking() is a filterChain too: connect through .in / .out.
    crackSrc.connect(pk.in);
    pk.out.connect(crackGain).connect(out);

    // (d) chest thump — real energy below 120 Hz
    const sub = osc(ac, 'sine', S.sub * jit(r, 0.08), t0, 0.13);
    sweep(sub.frequency, t0, S.sub * 1.9, S.sub * 0.55, 0.09);
    const subGain = ac.createGain();
    subGain.gain.setValueAtTime(0.85 * lvl, t0);
    subGain.gain.exponentialRampToValueAtTime(0.001, t0 + 0.13);
    sub.connect(subGain).connect(out);

    // (e) mechanical action
    const mech = metallic(ac, t0 + 0.012, { freq: 1800 * jit(r, 0.1), dur: 0.05, gain: 0.18 * lvl });
    if (mech) mech.out.connect(out);

    // Distant shots get a bigger, later tail.
    if (!isPlayer) {
      const send = ac.createGain();
      send.gain.value = S.tail;
      bodyGain.connect(send).connect(this.sends[this.zone]);
    }

    if (isPlayer) this._duck(0.55, 0.09);
  }

  _duck(amount, time) {
    if (!this.duck) return;
    const t = this.ac.currentTime;
    this.duck.gain.cancelScheduledValues(t);
    this.duck.gain.setValueAtTime(this.duck.gain.value, t);
    this.duck.gain.linearRampToValueAtTime(amount, t + 0.012);
    this.duck.gain.linearRampToValueAtTime(1, t + time + 0.18);
  }

  // -------------------------------------------------------------------------

  static IMPACT = {
    concrete: { f: 380, q: 1.2, dur: 0.10, tone: 0,    g: 0.5 },
    metal:    { f: 2600, q: 8,  dur: 0.34, tone: 1,    g: 0.42 },
    wood:     { f: 800, q: 2.4, dur: 0.10, tone: 0.3,  g: 0.45 },
    dirt:     { f: 220, q: 0.8, dur: 0.09, tone: 0,    g: 0.38 },
    sand:     { f: 190, q: 0.7, dur: 0.08, tone: 0,    g: 0.34 },
    glass:    { f: 4200, q: 6,  dur: 0.42, tone: 1,    g: 0.4 },
    flesh:    { f: 260, q: 1.6, dur: 0.09, tone: 0,    g: 0.52 },
    foliage:  { f: 1600, q: 1.0, dur: 0.11, tone: 0,   g: 0.24 },
    water:    { f: 900, q: 1.4, dur: 0.16, tone: 0,    g: 0.34 },
  };

  impact(surface, pos) {
    const out = this._voice('world', 2, pos);
    if (!out) return;
    const ac = this.ac, r = this.rng, t0 = ac.currentTime;
    const S = Audio.IMPACT[surface] || Audio.IMPACT.concrete;

    const src = noiseSrc(ac, this.noise.white, t0, S.dur, jit(r, 0.12), r);
    const bp = bandpass(ac, S.f * jit(r, 0.14), S.q, 2);
    const g = ac.createGain();
    g.gain.setValueAtTime(S.g * jitDb(r, 2), t0);
    g.gain.exponentialRampToValueAtTime(0.0006, t0 + S.dur);
    src.connect(bp.in);
    bp.out.connect(g).connect(out);

    // Ringing partials for metal and glass.
    if (S.tone > 0) {
      const m = metallic(ac, t0, { freq: S.f * jit(r, 0.2), dur: S.dur * 1.6, gain: 0.22 * S.tone });
      if (m) m.out.connect(out);
    }
  }

  footstep(surface, running) {
    const now = performance.now();
    if (now - this._lastStep < 130) return;
    this._lastStep = now;
    const out = this._voice('world', 1);
    if (!out) return;
    const ac = this.ac, r = this.rng, t0 = ac.currentTime;
    const S = Audio.IMPACT[surface] || Audio.IMPACT.concrete;
    const src = noiseSrc(ac, this.noise.brown || this.noise.white, t0, 0.09, jit(r, 0.15), r);
    const bp = bandpass(ac, clamp(S.f * 0.5, 120, 1400) * jit(r, 0.2), 1.1, 2);
    const g = ac.createGain();
    g.gain.setValueAtTime((running ? 0.22 : 0.13) * jitDb(r, 2.5), t0);
    g.gain.exponentialRampToValueAtTime(0.0004, t0 + 0.09);
    src.connect(bp.in);
    bp.out.connect(g).connect(out);
  }

  reload(phase, empty) {
    if (phase !== 'start') return;
    const ac = this.ac;
    if (!ac) return;
    const t0 = ac.currentTime;
    // Mag out, mag in, and — on an empty reload — the bolt.
    const beats = empty
      ? [[0.05, 1400, 0.10], [0.55, 900, 0.14], [1.35, 1200, 0.12], [2.15, 2200, 0.18], [2.45, 1700, 0.15]]
      : [[0.05, 1400, 0.10], [0.50, 900, 0.14], [1.25, 1200, 0.13], [1.85, 1600, 0.11]];
    for (const [dt, f, g] of beats) {
      const out = this._voice('weapon', 2);
      if (!out) continue;
      const m = metallic(ac, t0 + dt, { freq: f * jit(this.rng, 0.08), dur: 0.07, gain: g });
      if (m) m.out.connect(out);
    }
  }

  shellBounce(pos, speed) {
    if (speed < 0.6) return;
    const out = this._voice('world', 0.4, pos);
    if (!out) return;
    const m = metallic(this.ac, this.ac.currentTime, {
      freq: 3200 * jit(this.rng, 0.25), dur: 0.14,
      gain: clamp(speed * 0.03, 0.02, 0.12),
    });
    if (m) m.out.connect(out);
  }

  whizz(distance) {
    const out = this._voice('world', 1.5);
    if (!out) return;
    const ac = this.ac, t0 = ac.currentTime;
    const src = noiseSrc(ac, this.noise.white, t0, 0.09, 1, this.rng);
    const bp = bandpass(ac, 2400, 3, 2);
    const g = ac.createGain();
    const lvl = clamp(0.3 * (1 - distance / 2), 0.02, 0.3);
    g.gain.setValueAtTime(0.001, t0);
    g.gain.linearRampToValueAtTime(lvl, t0 + 0.02);
    g.gain.exponentialRampToValueAtTime(0.0004, t0 + 0.09);
    src.connect(bp.in);
    bp.out.connect(g).connect(out);
  }

  explosion(pos) {
    const out = this._voice('world', 8, pos);
    if (!out) return;
    const ac = this.ac, t0 = ac.currentTime, r = this.rng;

    // Deep sub thump
    const sub = osc(ac, 'sine', 46, t0, 0.9);
    sweep(sub.frequency, t0, 92, 26, 0.6);
    const sg = ac.createGain();
    sg.gain.setValueAtTime(1.5, t0);
    sg.gain.exponentialRampToValueAtTime(0.001, t0 + 0.9);
    sub.connect(sg).connect(out);

    // Broadband blast with a long crackling tail
    const src = noiseSrc(ac, this.noise.white, t0, 2.2, 1, r);
    const lp = ac.createBiquadFilter();
    lp.type = 'lowpass';
    lp.frequency.setValueAtTime(9000, t0);
    lp.frequency.exponentialRampToValueAtTime(320, t0 + 1.6);
    const g = ac.createGain();
    g.gain.setValueAtTime(1.2, t0);
    g.gain.exponentialRampToValueAtTime(0.0008, t0 + 2.2);
    src.connect(lp).connect(g).connect(out);
    const send = ac.createGain();
    send.gain.value = 0.9;
    g.connect(send).connect(this.sends[this.zone]);

    // Concussion: everything else ducks hard, and a sine rings in your ears.
    this._duck(0.12, 1.4);
    const ring = osc(ac, 'sine', 3400, t0 + 0.03, 2.6);
    const rg = ac.createGain();
    rg.gain.setValueAtTime(0.0001, t0);
    rg.gain.linearRampToValueAtTime(0.10, t0 + 0.06);
    rg.gain.exponentialRampToValueAtTime(0.0001, t0 + 2.6);
    ring.connect(rg).connect(this.buses.ui);
  }

  play(name) {
    const out = this._voice('ui', 1);
    if (!out) return;
    const ac = this.ac, t0 = ac.currentTime;
    const table = {
      swap:    [900, 0.06, 0.10],
      dryfire: [2600, 0.03, 0.14],
      hurt:    [180, 0.18, 0.16],
      click:   [1600, 0.02, 0.08],
    };
    const [f, dur, g] = table[name] || table.click;
    const m = metallic(ac, t0, { freq: f, dur, gain: g });
    if (m) m.out.connect(out);
  }

  // -------------------------------------------------------------------------
  //  Adaptive score
  // -------------------------------------------------------------------------

  _startMusic() {
    const ac = this.ac;
    const t0 = ac.currentTime;
    // A low modal drone: two detuned saws a fifth apart through a slow filter.
    this.droneGain = ac.createGain();
    this.droneGain.gain.value = 0.0;
    const lp = ac.createBiquadFilter();
    lp.type = 'lowpass';
    lp.frequency.value = 320;
    lp.Q.value = 1.4;
    this.droneGain.connect(lp).connect(this.buses.music);
    for (const [f, d] of [[55, 0], [55, 7], [82.4, -5]]) {
      const o = ac.createOscillator();
      o.type = 'sawtooth';
      o.frequency.value = f;
      o.detune.value = d;
      const g = ac.createGain();
      g.gain.value = 0.28;
      o.connect(g).connect(this.droneGain);
      o.start(t0);
    }
    this._pulseAt = 0;
  }

  _updateMusic(dt, time) {
    if (!this.ready || !this.droneGain) return;
    const alert = this.ctx.enemies?.alertLevel ?? 0;
    const t = this.ac.currentTime;
    this.droneGain.gain.setTargetAtTime(0.12 + alert * 0.35, t, 1.2);

    // Percussive pulse layer enters at high alert.
    if (alert > 0.55 && t > this._pulseAt) {
      this._pulseAt = t + lerp(0.75, 0.42, clamp((alert - 0.55) / 0.45, 0, 1));
      const out = this._voice('music', 0.6);
      if (!out) return;
      const o = osc(this.ac, 'sine', 62, t, 0.22);
      sweep(o.frequency, t, 96, 44, 0.14);
      const g = this.ac.createGain();
      g.gain.setValueAtTime(0.5, t);
      g.gain.exponentialRampToValueAtTime(0.001, t + 0.22);
      o.connect(g).connect(out);
    }
  }

  // -------------------------------------------------------------------------

  /** Probe the space with six rays and pick a reverb zone from the mean size. */
  _updateZone() {
    const phys = this.ctx.physics;
    const cam = this.ctx.camera;
    if (!phys?.raycast || !cam) return;
    let sum = 0, n = 0;
    const dirs = Audio._PROBE;
    for (const d of dirs) {
      const hit = phys.raycast(cam.position, d, 40, { skipEnemies: true });
      sum += hit ? hit.distance : 40;
      n++;
    }
    const mean = sum / n;
    const zone = mean < 5 ? 'interior' : mean < 12 ? 'warehouse' : mean < 24 ? 'street' : 'open';
    if (zone === this.zone) return;
    // Crossfade so the change never clicks.
    const t = this.ac.currentTime;
    for (const [name, send] of Object.entries(this.sends)) {
      send.gain.setTargetAtTime(name === zone ? 0.45 : 0, t, 0.35);
    }
    this.zone = zone;
  }

  update(dt, time) {
    if (!this.ready) return;
    const cam = this.ctx.camera;
    const L = this.ac.listener;
    if (cam && L) {
      const p = cam.position;
      if (L.positionX) {
        L.positionX.value = p.x; L.positionY.value = p.y; L.positionZ.value = p.z;
        _f.set(0, 0, -1).applyQuaternion(cam.quaternion);
        _u.set(0, 1, 0).applyQuaternion(cam.quaternion);
        L.forwardX.value = _f.x; L.forwardY.value = _f.y; L.forwardZ.value = _f.z;
        L.upX.value = _u.x; L.upY.value = _u.y; L.upZ.value = _u.z;
      } else if (L.setPosition) {
        L.setPosition(p.x, p.y, p.z);
      }
    }
    if ((this.ctx.engine.frame % 30) === 0) this._updateZone();
    this._updateMusic(dt, time);
  }

  setBusGain(name, v) { if (this.buses?.[name]) this.buses[name].gain.value = v; }
  suspend() { this.ac?.suspend?.(); }
  resume() { this.ac?.resume?.(); }
}

// Small standalone vector so Audio does not pull in three.
class V { constructor() { this.x = 0; this.y = 0; this.z = 0; }
  set(x, y, z) { this.x = x; this.y = y; this.z = z; return this; }
  applyQuaternion(q) {
    const { x, y, z } = this; const { x: qx, y: qy, z: qz, w: qw } = q;
    const ix = qw * x + qy * z - qz * y, iy = qw * y + qz * x - qx * z;
    const iz = qw * z + qx * y - qy * x, iw = -qx * x - qy * y - qz * z;
    this.x = ix * qw + iw * -qx + iy * -qz - iz * -qy;
    this.y = iy * qw + iw * -qy + iz * -qx - ix * -qz;
    this.z = iz * qw + iw * -qz + ix * -qy - iy * -qx;
    return this;
  } }
const _f = new V();
const _u = new V();

Audio._PROBE = [
  { x: 1, y: 0, z: 0 }, { x: -1, y: 0, z: 0 },
  { x: 0, y: 0, z: 1 }, { x: 0, y: 0, z: -1 },
  { x: 0, y: 1, z: 0 }, { x: 0.7, y: 0.2, z: 0.7 },
];
