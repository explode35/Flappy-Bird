/* ============================================================================
   AUDIO — everything synthesised at runtime with the Web Audio API.
   No samples, no files. Engine voices, item SFX, ambience and a procedural
   music loop per track (each track picks its own scale, tempo and progression).
   ========================================================================= */

const Audio = {
  ctx: null, ready: false, muted: false,
  master: null, sfxBus: null, musicBus: null, engineBus: null, ambBus: null,
  noiseBuf: null,
  _voices: [], _music: null, _amb: null,

  init() {
    if (this.ctx) return;
    const AC = window.AudioContext || window.webkitAudioContext;
    if (!AC) return;
    const ctx = this.ctx = new AC();

    // master chain: limiter-ish compressor keeps 8 engines + music from clipping
    const comp = ctx.createDynamicsCompressor();
    comp.threshold.value = -13; comp.knee.value = 24; comp.ratio.value = 9;
    comp.attack.value = .004; comp.release.value = .22;
    const master = this.master = ctx.createGain();
    master.gain.value = .85;
    master.connect(comp); comp.connect(ctx.destination);

    const mk = v => { const g = ctx.createGain(); g.gain.value = v; g.connect(master); return g; };
    this.sfxBus = mk(.9);
    this.musicBus = mk(.34);
    this.engineBus = mk(.5);
    this.ambBus = mk(.3);

    // shared white-noise buffer (2s) — used for skids, impacts, hats, wind
    const len = ctx.sampleRate * 2;
    const buf = ctx.createBuffer(1, len, ctx.sampleRate);
    const d = buf.getChannelData(0);
    for (let i = 0; i < len; i++) d[i] = Math.random() * 2 - 1;
    this.noiseBuf = buf;

    this.ready = true;
  },

  resume() { if (this.ctx && this.ctx.state === 'suspended') this.ctx.resume(); },
  now() { return this.ctx ? this.ctx.currentTime : 0; },
  setMuted(m) { this.muted = m; if (this.master) this.master.gain.value = m ? 0 : .85; },

  noiseSource() {
    const s = this.ctx.createBufferSource();
    s.buffer = this.noiseBuf; s.loop = true;
    return s;
  },

  /* ---- one-shot helpers ------------------------------------------------ */
  tone(freq, dur, type, vol, opt) {
    if (!this.ready || this.muted) return;
    opt = opt || {};
    const ctx = this.ctx, t = ctx.currentTime + (opt.delay || 0);
    const o = ctx.createOscillator(), g = ctx.createGain();
    o.type = type || 'sine';
    o.frequency.setValueAtTime(freq, t);
    if (opt.to) o.frequency[opt.exp ? 'exponentialRampToValueAtTime' : 'linearRampToValueAtTime'](Math.max(1, opt.to), t + dur);
    if (opt.detune) o.detune.value = opt.detune;
    let node = o;
    if (opt.filter) {
      const f = ctx.createBiquadFilter();
      f.type = opt.filter; f.frequency.value = opt.fc || 900; f.Q.value = opt.q || 1;
      o.connect(f); node = f;
    }
    const atk = opt.attack != null ? opt.attack : .006;
    g.gain.setValueAtTime(0, t);
    g.gain.linearRampToValueAtTime(vol, t + atk);
    g.gain.exponentialRampToValueAtTime(.0001, t + dur);
    node.connect(g); g.connect(opt.bus || this.sfxBus);
    o.start(t); o.stop(t + dur + .03);
  },

  noise(dur, vol, opt) {
    if (!this.ready || this.muted) return;
    opt = opt || {};
    const ctx = this.ctx, t = ctx.currentTime + (opt.delay || 0);
    const s = this.noiseSource(), f = ctx.createBiquadFilter(), g = ctx.createGain();
    f.type = opt.filter || 'bandpass';
    f.frequency.setValueAtTime(opt.f0 || 1200, t);
    if (opt.f1) f.frequency.exponentialRampToValueAtTime(Math.max(20, opt.f1), t + dur);
    f.Q.value = opt.q || 1.2;
    g.gain.setValueAtTime(0, t);
    g.gain.linearRampToValueAtTime(vol, t + (opt.attack || .008));
    g.gain.exponentialRampToValueAtTime(.0001, t + dur);
    s.connect(f); f.connect(g); g.connect(opt.bus || this.sfxBus);
    s.start(t); s.stop(t + dur + .03);
  },

  /* ---- named SFX ------------------------------------------------------- */
  sfx(name, vol, pan) {
    if (!this.ready || this.muted) return;
    const v = vol == null ? 1 : vol;
    switch (name) {
      case 'countdown': this.tone(520, .26, 'square', .16 * v, { filter: 'lowpass', fc: 2200 }); break;
      case 'go':
        this.tone(880, .5, 'square', .2 * v, { filter: 'lowpass', fc: 4200 });
        this.tone(1320, .55, 'sawtooth', .1 * v, { delay: .02 });
        this.noise(.5, .1 * v, { filter: 'highpass', f0: 600, f1: 5200 });
        break;
      case 'tier1': this.tone(420, .16, 'triangle', .14 * v, { to: 640, exp: true }); break;
      case 'tier2': this.tone(560, .18, 'triangle', .17 * v, { to: 940, exp: true }); this.tone(1120, .12, 'sine', .07 * v); break;
      case 'tier3':
        this.tone(720, .22, 'sawtooth', .16 * v, { to: 1440, exp: true, filter: 'lowpass', fc: 3000 });
        this.tone(1440, .2, 'sine', .1 * v, { delay: .03 });
        this.noise(.22, .07 * v, { filter: 'highpass', f0: 2000, f1: 8000 });
        break;
      case 'boost':
        this.noise(.62, .2 * v, { filter: 'bandpass', f0: 320, f1: 4800, q: .8 });
        this.tone(180, .5, 'sawtooth', .13 * v, { to: 680, exp: true, filter: 'lowpass', fc: 1800 });
        break;
      case 'hop': this.noise(.09, .09 * v, { filter: 'highpass', f0: 1800, f1: 900 }); break;
      case 'land': this.tone(90, .16, 'sine', .17 * v, { to: 44, exp: true }); this.noise(.13, .1 * v, { filter: 'lowpass', f0: 1400, f1: 260 }); break;
      case 'itemroll': this.tone(660, .05, 'square', .05 * v); break;
      case 'itemget': this.tone(600, .1, 'square', .12 * v, { to: 900, exp: true }); this.tone(900, .16, 'square', .1 * v, { delay: .09, to: 1350, exp: true }); break;
      case 'fire': this.noise(.2, .16 * v, { filter: 'bandpass', f0: 2600, f1: 500, q: 2 }); this.tone(400, .18, 'sawtooth', .1 * v, { to: 120, exp: true }); break;
      case 'homing': this.tone(300, .4, 'sine', .1 * v, { to: 900, exp: true }); this.tone(450, .4, 'sine', .07 * v, { to: 1350, exp: true, delay: .04 }); break;
      case 'drop': this.tone(220, .16, 'triangle', .12 * v, { to: 90, exp: true }); break;
      case 'shield': this.tone(300, .5, 'sine', .1 * v, { to: 620, exp: true }); this.tone(600, .5, 'sine', .06 * v, { to: 1240, exp: true }); break;
      case 'hit':
        this.tone(140, .3, 'sawtooth', .22 * v, { to: 40, exp: true, filter: 'lowpass', fc: 900 });
        this.noise(.28, .2 * v, { filter: 'lowpass', f0: 2200, f1: 180 });
        break;
      case 'bump': this.tone(120, .12, 'sine', .12 * v, { to: 60, exp: true }); this.noise(.1, .08 * v, { filter: 'lowpass', f0: 1100, f1: 300 }); break;
      case 'spin': this.tone(700, .55, 'sawtooth', .12 * v, { to: 160, exp: true, filter: 'lowpass', fc: 2000 }); break;
      case 'storm':
        this.noise(1.5, .2 * v, { filter: 'lowpass', f0: 200, f1: 6000, q: 3 });
        this.tone(70, 1.4, 'sawtooth', .15 * v, { to: 320, exp: true, filter: 'lowpass', fc: 900 });
        break;
      case 'lap': this.tone(700, .13, 'square', .12 * v); this.tone(1050, .2, 'square', .1 * v, { delay: .1 }); break;
      case 'finish':
        [523, 659, 784, 1047].forEach((f, i) => this.tone(f, .5, 'triangle', .15 * v, { delay: i * .1 }));
        break;
      case 'ui': this.tone(760, .06, 'square', .07 * v); break;
      case 'uiConfirm': this.tone(620, .08, 'square', .1 * v); this.tone(930, .12, 'square', .08 * v, { delay: .06 }); break;
      case 'record': [784, 988, 1175, 1568].forEach((f, i) => this.tone(f, .45, 'sine', .13 * v, { delay: i * .08 })); break;
      case 'offroad': break;
    }
  },

  /* ---- engine voices --------------------------------------------------- */
  /** A voice is a pair of detuned saws + sub + skid noise, filtered by "rpm". */
  makeEngineVoice() {
    if (!this.ready) return null;
    const ctx = this.ctx;
    const out = ctx.createGain(); out.gain.value = 0;
    const pan = ctx.createStereoPanner ? ctx.createStereoPanner() : null;
    if (pan) { out.connect(pan); pan.connect(this.engineBus); } else out.connect(this.engineBus);

    const filt = ctx.createBiquadFilter();
    filt.type = 'lowpass'; filt.frequency.value = 900; filt.Q.value = 3.5;
    filt.connect(out);

    const o1 = ctx.createOscillator(); o1.type = 'sawtooth';
    const o2 = ctx.createOscillator(); o2.type = 'sawtooth'; o2.detune.value = 14;
    const o3 = ctx.createOscillator(); o3.type = 'square';
    const g1 = ctx.createGain(); g1.gain.value = .5;
    const g3 = ctx.createGain(); g3.gain.value = .32;
    o1.connect(g1); o2.connect(g1); g1.connect(filt);
    o3.connect(g3); g3.connect(filt);

    // rasp: a little noise mixed in gives the engine grain instead of a pure tone
    const nz = this.noiseSource();
    const nf = ctx.createBiquadFilter(); nf.type = 'bandpass'; nf.frequency.value = 800; nf.Q.value = .7;
    const ng = ctx.createGain(); ng.gain.value = .06;
    nz.connect(nf); nf.connect(ng); ng.connect(out);

    o1.start(); o2.start(); o3.start(); nz.start();
    const v = { out, pan, filt, o1, o2, o3, ng, nf, _gain: 0 };
    this._voices.push(v);
    return v;
  },

  /** rpm 0..1, load 0..1 (throttle), skid 0..1, pan -1..1 */
  updateEngine(v, rpm, load, vol, panv, skid) {
    if (!v || !this.ready) return;
    const t = this.ctx.currentTime;
    const base = 46 + rpm * 168;
    v.o1.frequency.setTargetAtTime(base, t, .045);
    v.o2.frequency.setTargetAtTime(base * 1.005, t, .045);
    v.o3.frequency.setTargetAtTime(base * .5, t, .05);
    v.filt.frequency.setTargetAtTime(360 + rpm * 2600 + load * 700, t, .05);
    v.nf.frequency.setTargetAtTime(500 + rpm * 2600, t, .06);
    v.ng.gain.setTargetAtTime(.03 + skid * .3, t, .05);
    v.out.gain.setTargetAtTime(vol * (.24 + load * .18 + rpm * .1), t, .06);
    if (v.pan) v.pan.pan.setTargetAtTime(clamp(panv, -1, 1), t, .08);
  },
  silenceEngine(v) { if (v && this.ready) v.out.gain.setTargetAtTime(0, this.ctx.currentTime, .05); },

  /* ---- drift charge whine ---------------------------------------------- */
  makeDriftVoice() {
    if (!this.ready) return null;
    const ctx = this.ctx;
    const g = ctx.createGain(); g.gain.value = 0; g.connect(this.sfxBus);
    const o = ctx.createOscillator(); o.type = 'triangle'; o.frequency.value = 300;
    const f = ctx.createBiquadFilter(); f.type = 'bandpass'; f.frequency.value = 1400; f.Q.value = 4;
    const nz = this.noiseSource(); const ng = ctx.createGain(); ng.gain.value = .5;
    o.connect(g); nz.connect(f); f.connect(ng); ng.connect(g);
    o.start(); nz.start();
    return { g, o, f };
  },
  updateDrift(v, charge, active, vol) {
    if (!v || !this.ready) return;
    const t = this.ctx.currentTime;
    v.o.frequency.setTargetAtTime(240 + charge * 520, t, .05);
    v.f.frequency.setTargetAtTime(900 + charge * 2600, t, .05);
    v.g.gain.setTargetAtTime(active ? (.02 + charge * .05) * vol : 0, t, .07);
  },

  /* ---- ambience -------------------------------------------------------- */
  startAmbience(cfg) {
    if (!this.ready) return;
    this.stopAmbience();
    const ctx = this.ctx, nodes = [];
    // wind / room tone
    const w = this.noiseSource();
    const wf = ctx.createBiquadFilter(); wf.type = 'lowpass'; wf.frequency.value = cfg.windFc || 420; wf.Q.value = .5;
    const wg = ctx.createGain(); wg.gain.value = 0;
    w.connect(wf); wf.connect(wg); wg.connect(this.ambBus);
    w.start(); wg.gain.setTargetAtTime(cfg.wind == null ? .5 : cfg.wind, ctx.currentTime, 1.2);
    nodes.push(w, wg);
    // crowd: band-passed noise wobbled by a slow LFO so it breathes
    const c = this.noiseSource();
    const cf = ctx.createBiquadFilter(); cf.type = 'bandpass'; cf.frequency.value = 1500; cf.Q.value = .9;
    const cg = ctx.createGain(); cg.gain.value = 0;
    const lfo = ctx.createOscillator(); lfo.type = 'sine'; lfo.frequency.value = .13;
    const lg = ctx.createGain(); lg.gain.value = .12;
    lfo.connect(lg); lg.connect(cg.gain);
    c.connect(cf); cf.connect(cg); cg.connect(this.ambBus);
    c.start(); lfo.start();
    cg.gain.setTargetAtTime(cfg.crowd == null ? .22 : cfg.crowd, ctx.currentTime, 2);
    nodes.push(c, cg, lfo);
    this._amb = { nodes };
  },
  stopAmbience() {
    if (!this._amb) return;
    const t = this.ctx.currentTime;
    this._amb.nodes.forEach(n => { try { if (n.gain) n.gain.setTargetAtTime(0, t, .3); n.stop && n.stop(t + 1.4); } catch (e) { } });
    this._amb = null;
  },

  /* ---- procedural music ------------------------------------------------ */
  /** cfg: {bpm, root, scale[], prog[[deg,...]], mood} — one per track. */
  startMusic(cfg) {
    if (!this.ready) return;
    this.stopMusic();
    this._music = { cfg, step: 0, next: this.ctx.currentTime + .08, timer: 0, on: true, energy: 0 };
    this._musicTick();
  },
  stopMusic() {
    if (this._music) { this._music.on = false; clearTimeout(this._music.timer); this._music = null; }
  },
  setMusicEnergy(e) { if (this._music) this._music.energy = clamp01(e); },

  _musicTick() {
    const M = this._music;
    if (!M || !M.on || !this.ready) return;
    const ctx = this.ctx, cfg = M.cfg;
    const spb = 60 / cfg.bpm, stepDur = spb / 4;      // 16th notes
    const horizon = ctx.currentTime + .35;
    while (M.next < horizon) {
      this._musicStep(M.step, M.next, stepDur, cfg, M.energy);
      M.step++; M.next += stepDur;
    }
    M.timer = setTimeout(() => this._musicTick(), 90);
  },

  _musicStep(step, t, dur, cfg, energy) {
    if (this.muted) return;
    const bus = this.musicBus, sc = cfg.scale, bar = Math.floor(step / 16) % cfg.prog.length;
    const chord = cfg.prog[bar], s16 = step % 16;
    const note = (degree, oct) => {
      const d = ((degree % sc.length) + sc.length) % sc.length;
      const o = Math.floor(degree / sc.length) + (oct || 0);
      return cfg.root * Math.pow(2, o + sc[d] / 12);
    };
    const env = (freq, len, type, vol, fc) => {
      const o = this.ctx.createOscillator(), g = this.ctx.createGain(), f = this.ctx.createBiquadFilter();
      o.type = type; o.frequency.setValueAtTime(freq, t);
      f.type = 'lowpass'; f.frequency.setValueAtTime(fc || 2400, t);
      f.frequency.exponentialRampToValueAtTime(Math.max(180, (fc || 2400) * .4), t + len);
      g.gain.setValueAtTime(0, t);
      g.gain.linearRampToValueAtTime(vol, t + .012);
      g.gain.exponentialRampToValueAtTime(.0001, t + len);
      o.connect(f); f.connect(g); g.connect(bus);
      o.start(t); o.stop(t + len + .02);
    };
    const hit = (len, vol, f0, f1, filter, q) => {
      const s = this.noiseSource(), f = this.ctx.createBiquadFilter(), g = this.ctx.createGain();
      f.type = filter || 'bandpass'; f.frequency.setValueAtTime(f0, t);
      if (f1) f.frequency.exponentialRampToValueAtTime(f1, t + len);
      f.Q.value = q || 1;
      g.gain.setValueAtTime(vol, t); g.gain.exponentialRampToValueAtTime(.0001, t + len);
      s.connect(f); f.connect(g); g.connect(bus);
      s.start(t); s.stop(t + len + .02);
    };

    const E = .55 + energy * .45;

    // kick on 1 and 3 (+ a push on the &-of-3 as energy rises)
    if (s16 % 8 === 0 || (energy > .5 && s16 === 14)) {
      const o = this.ctx.createOscillator(), g = this.ctx.createGain();
      o.type = 'sine'; o.frequency.setValueAtTime(150, t);
      o.frequency.exponentialRampToValueAtTime(42, t + .13);
      g.gain.setValueAtTime(.5 * E, t); g.gain.exponentialRampToValueAtTime(.0001, t + .19);
      o.connect(g); g.connect(bus); o.start(t); o.stop(t + .22);
    }
    // snare / clap on 2 and 4
    if (s16 % 8 === 4) hit(.16, .3 * E, 2100, 700, 'bandpass', .8);
    // hats
    if (s16 % 2 === (energy > .6 ? 0 : 1)) hit(.045, .1 * E * (s16 % 4 === 0 ? 1.4 : .8), 8200, 6000, 'highpass', .7);

    // bass: root of the bar, with a syncopated pickup
    if (s16 === 0 || s16 === 6 || s16 === 10) {
      env(note(chord[0], -2), s16 === 0 ? dur * 3.4 : dur * 1.6, 'sawtooth', .3 * E, 420);
    }
    // pad: chord stab at the top of each bar
    if (s16 === 0) {
      for (let i = 0; i < chord.length; i++) env(note(chord[i], 0), dur * 12, 'triangle', .075 * E, 1500);
    }
    // arpeggio lead — density scales with race energy
    const arpOn = energy > .25 ? (s16 % 2 === 0) : (s16 % 4 === 0);
    if (arpOn) {
      const idx = Math.floor(step / (energy > .25 ? 2 : 4)) % 4;
      const dgr = chord[idx % chord.length] + (idx === 3 ? sc.length : 0);
      env(note(dgr, 1), dur * 1.7, 'square', .075 * E, 2800 + energy * 2600);
    }
    // shimmer every other bar keeps 8-bar loops from feeling static
    if (s16 === 12 && (Math.floor(step / 16) % 2 === 1)) {
      env(note(chord[0] + sc.length, 2), dur * 5, 'sine', .05 * E, 5200);
    }
  }
};
