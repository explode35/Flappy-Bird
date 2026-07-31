/* ============================================================================
   RACE — scene assembly, the per-frame loop, positions, laps, split-screen
   viewports and rendering.
   ========================================================================= */

const GP_POINTS = [15, 11, 9, 7, 5, 3, 2, 1];

class Race {
  constructor(app, opts) {
    this.app = app;
    this.opts = opts;
    this.mode = opts.mode;
    this.laps = opts.laps || 3;
    this.cfg = opts.track;
    this.quality = app.quality;

    this.scene = new THREE.Scene();
    this.track = new Track(this.cfg);
    this.scene.add(this.track.root);
    this.scene.fog = new THREE.Fog(this.cfg.env.fog, this.cfg.env.fogNear, this.cfg.env.fogFar);

    this._buildLights();

    this.fx = new FX(this.scene, this.quality);
    this.time = 0;
    this.phase = 'countdown';
    this.countdown = 4.2;
    this.lastLight = 99;
    this.finishOrder = [];
    this.storm = 0;
    this.stormSource = null;
    this.resultTimer = 0;
    this.rng = makeRng((Date.now() ^ 0x51ed) >>> 0);

    this._buildField();
    this.items = new ItemSystem(this);
    this.scene.add(this.items.root);

    this._buildViews();
    this._setupGhost();

    Audio.startAmbience(this.cfg.ambience);
    Audio.startMusic(this.cfg.music);
    this.grid();
  }

  /* ---------------------------------------------------------------- lights */
  _buildLights() {
    const e = this.cfg.env;
    const sun = new THREE.DirectionalLight(e.sunCol, e.sunInt);
    sun.position.set(e.sunDir[0], e.sunDir[1], e.sunDir[2]).multiplyScalar(300);
    sun.castShadow = true;
    const S = 110;
    sun.shadow.camera.left = -S; sun.shadow.camera.right = S;
    sun.shadow.camera.top = S; sun.shadow.camera.bottom = -S;
    sun.shadow.camera.near = 50; sun.shadow.camera.far = 700;
    const sm = this.quality === 'low' ? 1024 : 2048;
    sun.shadow.mapSize.set(sm, sm);
    sun.shadow.bias = -0.0012;
    sun.shadow.normalBias = 0.9;
    this.scene.add(sun);
    this.scene.add(sun.target);
    this.sun = sun;

    this.scene.add(new THREE.HemisphereLight(e.ambCol, shade(e.ground, .7), e.ambInt));

    // coloured rim light from the opposite side — the trick that makes the
    // karts read as solid objects against the sky
    const rim = new THREE.DirectionalLight(e.rim, e.rimInt);
    rim.position.set(-e.sunDir[0], .35, -e.sunDir[2]).multiplyScalar(200);
    this.scene.add(rim);
    this.rim = rim;
  }

  /* ------------------------------------------------------------ the field */
  _buildField() {
    const opts = this.opts;
    this.karts = [];
    this.ais = [];
    const used = {};
    const players = opts.players;
    players.forEach(p => used[p.charId] = true);

    const field = [];
    players.forEach(p => field.push({ char: CHARACTERS.find(c => c.id === p.charId), player: p }));
    if (opts.fieldSize > players.length) {
      const rest = CHARACTERS.filter(c => !used[c.id]);
      for (let i = 0; i < rest.length && field.length < opts.fieldSize; i++) field.push({ char: rest[i], player: null });
    }

    field.forEach((f, i) => {
      const k = new Kart(f.char, this.track, i);
      this.scene.add(k.obj);
      k.itemCharges = 0;
      if (f.player) {
        k.isPlayer = true;
        k.playerIdx = f.player.index;
        k.ctl = Input.newState();
      } else {
        const skill = clamp(opts.aiSkill + (i - field.length / 2) * .035 + (Math.random() - .5) * .09, .12, .98);
        const ai = new AIDriver(k, skill, 1000 + i * 977);
        this.ais.push(ai);
        k.ai = ai;
      }
      this._hookKart(k);
      this.karts.push(k);
    });

    // engine voices: both players plus the two nearest rivals
    this.voices = [];
    const nVoices = Math.min(4, this.karts.length);
    for (let i = 0; i < nVoices; i++) this.voices.push({ v: Audio.makeEngineVoice(), kart: null });
    this.driftVoices = players.map(() => Audio.makeDriftVoice());
  }

  _hookKart(k) {
    const race = this;
    k.onDriftTier = tier => {
      if (tier > 0 && k.isPlayer) Audio.sfx('tier' + tier, 1);
      else if (tier === 3) Audio.sfx('tier3', .12);
    };
    k.onDriftRelease = tier => {
      race.fx.boostRing(k);
      Audio.sfx('boost', k.isPlayer ? .95 : .18);
      const view = race.viewOf(k);
      if (view) { view.cam.addShake(.12 + tier * .07); view.flash = .1 + tier * .06; }
    };
    k.onHop = () => Audio.sfx('hop', k.isPlayer ? .8 : .12);
    k.onLand = (fall, clean) => {
      if (fall > 6) {
        Audio.sfx('land', k.isPlayer ? Math.min(1, fall / 16) : .1);
        race.fx.burst(k.pos, SURFACES[k.surf].dust, 8, 5);
        const view = race.viewOf(k);
        if (view) view.cam.addShake(clamp(fall / 34, 0, .5));
      }
      if (clean) {
        race.fx.boostRing(k);
        const view = race.viewOf(k);
        if (view) view.hud.toast('Clean landing', '#9fe8ff');
      }
    };
    k.onLaunch = () => { const v = race.viewOf(k); if (v) v.cam.addShake(.16); };
    k.onWall = imp => {
      Audio.sfx('bump', k.isPlayer ? clamp(imp / 22, .2, 1) : .1);
      race.fx.burst(k.pos, 0xffcc88, 8, 6);
      const view = race.viewOf(k);
      if (view) view.cam.addShake(clamp(imp / 40, 0, .55));
    };
    k.onPad = () => {
      Audio.sfx('boost', k.isPlayer ? .8 : .12);
      race.fx.boostRing(k);
      const v = race.viewOf(k); if (v) { v.cam.addShake(.12); v.flash = .12; }
    };
    k.onRespawn = () => { race.fx.burst(k.pos, 0xaad4ff, 22, 10); };
    k.onLap = lap => race._onLap(k, lap);
  }

  /* ----------------------------------------------------------- viewports */
  _buildViews() {
    const layer = $('#hudlayer');
    layer.innerHTML = '';
    this.views = [];
    const players = this.karts.filter(k => k.isPlayer);
    players.forEach((k, i) => {
      const cam = new ChaseCam(1);
      const post = new PostFX(this.app.renderer, this.quality);
      const hud = new HUD(layer, i, this.cfg.accent);
      this.views.push({
        kart: k, cam, post, hud, index: i,
        rect: { x: 0, y: 0, w: 1, h: 1 }, glRect: { x: 0, y: 0, w: 1, h: 1 },
        flash: 0, storm: 0, split: 0, lastLapShown: 0
      });
    });
    this.mergeT = 0;
    this.merged = false;
    layer.classList.remove('hidden');
  }

  viewOf(kart) {
    for (let i = 0; i < this.views.length; i++) if (this.views[i].kart === kart) return this.views[i];
    return null;
  }

  /* --------------------------------------------------------------- ghosts */
  _setupGhost() {
    this.ghostRec = null;
    this.ghost = null;
    if (this.mode !== 'tt') return;
    this.ghostRec = { t: 0, data: [], step: .05 };
    const saved = this.app.ghosts[this.cfg.id];
    if (saved && saved.data.length) {
      const ch = CHARACTERS.find(c => c.id === saved.charId) || CHARACTERS[0];
      const obj = buildKart(ch);
      obj.traverse(o => {
        if (o.material) {
          o.material = o.material.clone();
          o.material.transparent = true;
          o.material.opacity = .34;
          o.material.depthWrite = false;
        }
        o.castShadow = false;
      });
      this.scene.add(obj);
      this.ghost = { obj, data: saved.data, time: saved.time, i: 0 };
    }
  }

  /* ----------------------------------------------------------------- grid */
  grid() {
    const n = this.karts.length;
    // grid order: players first, then AI, spread across the rows
    this.karts.forEach((k, i) => {
      k.reset(this.track.gridSlot(i, n));
      k.position = i + 1;
      k.launchHold = 0;
      k.stallTime = 0;
      k.rubber = 1;
      if (k.ai) k.ai.launchTarget = lerp(.55, .16, k.ai.skill) * rand(.7, 1.4);
    });
    this.time = 0;
    this.phase = 'countdown';
    this.countdown = 4.2;
    this.lastLight = 99;
    this.finishOrder.length = 0;
    this.storm = 0;
    this.items.reset();
    this.fx.clear();
    this.track.lapPhase = 0;
    if (this.ghostRec) { this.ghostRec.t = 0; this.ghostRec.data.length = 0; }
    // "Race again" comes back through here, so the bed has to restart too
    Audio.startAmbience(this.cfg.ambience);
    Audio.startMusic(this.cfg.music);
    if (this.ghost) this.ghost.i = 0;
    this.views.forEach(v => { v.cam._first = true; v.hud.clearBig(); v.storm = 0; v.flash = 0; });
    this.updatePositions();
  }

  /* --------------------------------------------------------------- update */
  update(dt) {
    const dtc = Math.min(dt, 1 / 24);   // never integrate a giant step

    if (this.phase === 'countdown') this._countdown(dtc);
    else if (this.phase === 'race' || this.phase === 'finishing') this.time += dtc;

    // --- controls
    for (let i = 0; i < this.karts.length; i++) {
      const k = this.karts[i];
      let ctl;
      if (k.isPlayer) {
        ctl = k.ctl;
        if (this.app.paused) { ctl.throttle = 0; ctl.brake = 0; ctl.steer = 0; ctl.drift = false; }
        else Input.read(k.playerIdx, ctl, dtc);
        if (k.finished) { ctl.throttle = 1; ctl.brake = 0; ctl.drift = false; ctl.item = false; ctl.steer *= .4; }
        this._playerItems(k, ctl);
      } else {
        ctl = k.ai.think(dtc, this);
        this._aiItems(k, ctl);
      }
      k.update(dtc, ctl, this);
    }

    this._collisions(dtc);
    this.items.update(dtc);
    this._hazardChecks(dtc);
    this.updatePositions();
    this._rubberBand(dtc);
    this.fx.update(dtc);
    this._kartFx(dtc);

    // storm decay
    if (this.storm > 0) {
      this.storm -= dtc;
      if (this.storm < 0) this.storm = 0;
    }

    this._ghost(dtc);
    this._audio(dtc);
    this._cameras(dtc);
    this.track.update(dtc, this.views.map(v => v.cam.cam.position));
    this._huds(dtc);

    if (this.phase === 'finishing') {
      this.resultTimer -= dtc;
      if (this.resultTimer <= 0 || this.finishOrder.length === this.karts.length) this._toResults();
    }
  }

  _countdown(dt) {
    const prev = this.countdown;
    this.countdown -= dt;
    const lights = this.track.startLights;
    const step = Math.ceil(clamp(this.countdown - .2, 0, 4));
    if (lights) {
      const lit = clamp(4 - Math.floor(this.countdown), 0, 5);
      for (let i = 0; i < lights.length; i++) {
        const on = i < lit;
        lights[i].material.color.setHex(this.countdown <= 0 ? 0x35ff6a : (on ? 0xff2a1a : 0x220505));
      }
    }
    // beeps
    const n = Math.ceil(this.countdown);
    if (n !== this.lastLight) {
      this.lastLight = n;
      if (n >= 1 && n <= 3) {
        Audio.sfx('countdown');
        this.views.forEach(v => v.hud.big(String(n), '#ffffff'));
      }
    }
    // hold-throttle accumulation for the launch boost
    for (let i = 0; i < this.karts.length; i++) {
      const k = this.karts[i];
      let holding;
      if (k.isPlayer) {
        // k.ctl was filled by the control pass last frame — one frame of lag
        // here is invisible and avoids consuming input edges twice.
        holding = k.ctl.throttle > .5;
      } else {
        holding = this.countdown < k.ai.launchTarget;
      }
      if (holding) k.launchHold += dt; else if (this.countdown > 0.05) k.launchHold = 0;
    }

    if (prev > 0 && this.countdown <= 0) {
      this.phase = 'race';
      this.time = 0;
      Audio.sfx('go');
      this.karts.forEach(k => {
        const h = k.launchHold;
        if (h > 1.05) { k.stallTime = 1.35; if (k.isPlayer) this.viewOf(k).hud.toast('Engine flooded!', '#ff6a6a'); }
        else if (h > 0.04 && h <= 0.30) {
          k.applyBoost(2, true);
          if (k.isPlayer) { this.viewOf(k).hud.toast('Perfect start!', '#ffd84a'); this.viewOf(k).flash = .3; }
        } else if (h > 0.30 && h <= 0.62) {
          k.applyBoost(1, true);
          if (k.isPlayer) this.viewOf(k).hud.toast('Good start', '#9fe8ff');
        }
        k.lapStart = 0;
      });
      this.views.forEach(v => v.hud.big('GO!', '#6bff9c'));
    }
  }

  /* --------------------------------------------------------------- items */
  _playerItems(k, ctl) {
    if (!k.item || k.itemRolling > 0) { k.itemHeld = false; return; }
    const def = ITEMS[k.item];
    if (def.hold) {
      k.itemHeld = ctl.item;
      if (ctl.itemRelease) this.items.use(k, ctl.brake > .5);
    } else if (ctl.itemHit) {
      this.items.use(k, false);
    }
    this._trailVisual(k);
  }
  _aiItems(k, ctl) {
    if (!k.item || k.itemRolling > 0) { k.itemHeld = false; return; }
    const def = ITEMS[k.item];
    if (def.hold) {
      k.itemHeld = ctl.item;
      if (ctl.itemRelease) this.items.use(k, false);
    } else if (ctl.itemHit) this.items.use(k, false);
    this._trailVisual(k);
  }

  /** A held item trails behind the kart and eats one hit — a real shield. */
  _trailVisual(k) {
    if (k.itemHeld && k.item) {
      if (!k.trailObj) {
        const g = new THREE.Group();
        const m = new THREE.Mesh(new THREE.OctahedronGeometry(.85, 0),
          new THREE.MeshStandardMaterial({ emissive: ITEMS[k.item].color, emissiveIntensity: 1.5, color: 0x222222, roughness: .3 }));
        g.add(m);
        this.scene.add(g);
        k.trailObj = g;
      }
      k.trailObj.visible = true;
      k.trailObj.children[0].material.emissive.setHex(ITEMS[k.item].color);
      k.trailObj.position.copy(k.pos)
        .addScaledVector(_v0.set(Math.sin(k.yaw), 0, Math.cos(k.yaw)), -4.6);
      k.trailObj.position.y += .3;
      k.trailObj.rotation.y += .06;
    } else if (k.trailObj) k.trailObj.visible = false;
  }

  triggerStorm(source) {
    this.storm = 3.6;
    this.stormSource = source;
    Audio.sfx('storm', 1);
    for (let i = 0; i < this.karts.length; i++) {
      const k = this.karts[i];
      if (k === source || k.progress <= source.progress) continue;
      if (k.shield > 0) { k.shield = 0; continue; }
      k.stormTime = 3.6;
      k.item = null; k.itemCharges = 0;
      const v = this.viewOf(k);
      if (v) { v.storm = 1; v.hud.toast('ION STORM', '#c8a0ff'); }
    }
    this.views.forEach(v => { if (v.kart === source) v.hud.toast('Ion Storm released', '#c8a0ff'); });
  }

  onHit(kart, kind) {
    const v = this.viewOf(kart);
    if (v) { v.cam.addShake(.75); v.flash = .35; v.hud.toast('Hit!', '#ff7a7a'); }
    this.fx.explode(kart.pos, 0xffaa55);
    Audio.sfx('spin', kart.isPlayer ? .8 : .14);
  }

  /* --------------------------------------------------------- interactions */
  _collisions(dt) {
    const n = this.karts.length;
    for (let i = 0; i < n; i++) {
      const a = this.karts[i];
      for (let j = i + 1; j < n; j++) {
        const b = this.karts[j];
        const dx = b.pos.x - a.pos.x, dz = b.pos.z - a.pos.z, dy = b.pos.y - a.pos.y;
        const d2 = dx * dx + dz * dz;
        const R = 3.0;
        if (d2 > R * R || Math.abs(dy) > 2.6) continue;
        const d = Math.sqrt(d2) || .001;
        const nx = dx / d, nz = dz / d;
        const overlap = R - d;
        const ma = a.stats.mass, mb = b.stats.mass, mt = ma + mb;
        a.pos.x -= nx * overlap * (mb / mt); a.pos.z -= nz * overlap * (mb / mt);
        b.pos.x += nx * overlap * (ma / mt); b.pos.z += nz * overlap * (ma / mt);
        // exchange a little momentum along the normal
        const van = a.vel.x * nx + a.vel.z * nz, vbn = b.vel.x * nx + b.vel.z * nz;
        const rel = van - vbn;
        if (rel > 0) {
          const imp = rel * (1 + K.bumpRestitution);
          a.vel.x -= nx * imp * (mb / mt); a.vel.z -= nz * imp * (mb / mt);
          b.vel.x += nx * imp * (ma / mt); b.vel.z += nz * imp * (ma / mt);
          // the heavier kart shrugs it off; the lighter one loses drive
          const now = this.time;
          if (now - a.lastCollide > .25) {
            a.lastCollide = now; b.lastCollide = now;
            const heavy = ma > mb ? a : b, light = ma > mb ? b : a;
            if (ma !== mb) light._vLong *= lerp(1, .88, Math.abs(ma - mb));
            Audio.sfx('bump', (a.isPlayer || b.isPlayer) ? .5 : .08);
            this.fx.burst(_v0.copy(a.pos).lerp(b.pos, .5), 0xffe9a0, 6, 5);
            const va = this.viewOf(a), vb = this.viewOf(b);
            if (va) va.cam.addShake(.12); if (vb) vb.cam.addShake(.12);
          }
        }
      }
    }
  }

  _hazardChecks(dt) {
    const T = this.track;
    if (!T.geysers) return;
    for (let g = 0; g < T.geysers.length; g++) {
      const gy = T.geysers[g];
      if (!gy.active) continue;
      const p = gy.mesh.position;
      for (let i = 0; i < this.karts.length; i++) {
        const k = this.karts[i];
        const dx = k.pos.x - p.x, dz = k.pos.z - p.z;
        if (dx * dx + dz * dz < 10 && k.pos.y < p.y + 12) {
          if (k.spinOut()) {
            k.vy = Math.max(k.vy, 9);
            k.grounded = false;
            this.onHit(k, 'geyser');
          }
        }
      }
    }
  }

  /* ------------------------------------------------------------ positions */
  updatePositions() {
    const arr = this._sortBuf || (this._sortBuf = []);
    arr.length = 0;
    for (let i = 0; i < this.karts.length; i++) arr.push(this.karts[i]);
    arr.sort((a, b) => {
      if (a.finished && b.finished) return a.finishPlace - b.finishPlace;
      if (a.finished) return -1;
      if (b.finished) return 1;
      return b.progress - a.progress;
    });
    for (let i = 0; i < arr.length; i++) arr[i].position = i + 1;
    this.order = arr;
  }

  nearestAhead(kart) {
    let best = null, bd = 1e9;
    const fwd = kart.forward(_v0);
    for (let i = 0; i < this.karts.length; i++) {
      const o = this.karts[i];
      if (o === kart) continue;
      const dx = o.pos.x - kart.pos.x, dz = o.pos.z - kart.pos.z;
      const ahead = dx * fwd.x + dz * fwd.z;
      if (ahead <= 0) continue;
      const d = Math.hypot(dx, dz);
      if (d < bd) {
        bd = d;
        const ang = angleDelta(kart.yaw, Math.atan2(dx, dz));
        best = { kart: o, dist: d, angle: ang };
      }
    }
    return best;
  }
  nearestBehind(kart) {
    let best = null, bd = 1e9;
    const fwd = kart.forward(_v0);
    for (let i = 0; i < this.karts.length; i++) {
      const o = this.karts[i];
      if (o === kart) continue;
      const dx = o.pos.x - kart.pos.x, dz = o.pos.z - kart.pos.z;
      if (dx * fwd.x + dz * fwd.z >= 0) continue;
      const d = Math.hypot(dx, dz);
      if (d < bd) { bd = d; best = { kart: o, dist: d }; }
    }
    return best;
  }

  /**
   * Catch-up assistance. Deliberately small: a +-5% top-speed band that scales
   * with the gap to the leader, and nothing else. Item luck (see ItemSystem.give)
   * does the rest. No teleporting, no free acceleration.
   */
  _rubberBand(dt) {
    if (this.karts.length < 2) return;
    const leader = this.order[0];
    const L = this.track.path.length;
    for (let i = 0; i < this.karts.length; i++) {
      const k = this.karts[i];
      if (k.isPlayer) { k.rubber = 1; continue; }
      const gapM = (leader.progress - k.progress) * L;
      const target = clamp(1 + gapM * 0.00042, 0.955, 1.052);
      k.rubber = damp(k.rubber, target, 1.2, dt);
      if (k.stormTime > 0) { k.stormTime -= dt; k.rubber *= .78; }
    }
    // players feel the storm as a top-speed cut too
    for (let i = 0; i < this.karts.length; i++) {
      const k = this.karts[i];
      if (!k.isPlayer) continue;
      if (k.stormTime > 0) { k.stormTime -= dt; k.rubber = .78; } else k.rubber = 1;
    }
  }

  /* ------------------------------------------------------------------ fx */
  _kartFx(dt) {
    for (let i = 0; i < this.karts.length; i++) {
      const k = this.karts[i];
      if (k.shield > 0) k.shield -= dt;
      if (k.stunTime > 0) k.stunTime -= dt;
      const sd = SURFACES[k.surf];
      if (!this._nearCamera(k)) continue;
      const moving = Math.abs(k.speed) > 3;
      if (k.grounded && moving) {
        this.fx.wheels(k, sd, dt, clamp01(Math.abs(k.speed) / 30) * (k.drifting ? 1.7 : 1));
        if (k.drifting) this.fx.driftSparks(k, k.driftTier, dt);
      }
      this.fx.exhaust(k, dt, k.boostTime > 0);
    }
  }
  _nearCamera(k) {
    for (let i = 0; i < this.views.length; i++) {
      if (this.views[i].cam.cam.position.distanceToSquared(k.pos) < 240 * 240) return true;
    }
    return false;
  }

  /* --------------------------------------------------------------- audio */
  _audio(dt) {
    if (!Audio.ready) return;
    const players = this.views.map(v => v.kart);
    // assign voices: each player, then the nearest rivals
    const assigned = [];
    players.forEach(p => assigned.push(p));
    const rest = this.karts.filter(k => assigned.indexOf(k) < 0);
    rest.sort((a, b) => a.pos.distanceToSquared(players[0].pos) - b.pos.distanceToSquared(players[0].pos));
    for (let i = 0; assigned.length < this.voices.length && i < rest.length; i++) assigned.push(rest[i]);

    for (let i = 0; i < this.voices.length; i++) {
      const slot = this.voices[i], k = assigned[i];
      if (!k) { Audio.silenceEngine(slot.v); continue; }
      const rpm = clamp01(Math.abs(k.speed) / k.stats.top) * (k.boostTime > 0 ? 1.15 : 1);
      const isPlayer = k.isPlayer;
      let pan = 0, vol = 1;
      if (!isPlayer) {
        const p0 = players[0];
        const d = k.pos.distanceTo(p0.pos);
        vol = clamp01(1 - d / 90) * .75;
        const rel = _v0.copy(k.pos).sub(p0.pos);
        pan = clamp(rel.x * Math.cos(p0.yaw) - rel.z * Math.sin(p0.yaw), -30, 30) / 30;
      }
      Audio.updateEngine(slot.v, rpm, k.ctl ? k.ctl.throttle : .8, vol, pan, k.drifting ? .8 : k.slip * .4);
    }
    // drift whine per player
    this.views.forEach((v, i) => {
      const dv = this.driftVoices[i];
      if (!dv) return;
      const k = v.kart;
      Audio.updateDrift(dv, clamp01(k.driftCharge / K.chargeTiers[2]), k.drifting, 1);
    });
    Audio.setMusicEnergy(this.phase === 'race' ? clamp01(.35 + (1 - (this.views[0].kart.position - 1) / 7) * .4 + (this.views[0].kart.boostTime > 0 ? .25 : 0)) : .2);
  }

  /* -------------------------------------------------------------- ghosts */
  _ghost(dt) {
    if (this.mode !== 'tt') return;
    const k = this.views[0].kart;
    if (this.ghostRec && this.phase === 'race' && !k.finished) {
      this.ghostRec.t += dt;
      if (this.ghostRec.t >= this.ghostRec.step) {
        this.ghostRec.t -= this.ghostRec.step;
        this.ghostRec.data.push(k.pos.x, k.pos.y, k.pos.z, k.yaw);
      }
    }
    if (this.ghost) {
      const g = this.ghost;
      const f = this.time / .05;
      const i = Math.floor(f), t = f - i;
      const n = g.data.length / 4;
      if (i < n - 1 && this.phase === 'race') {
        g.obj.visible = true;
        const a = i * 4, b = (i + 1) * 4;
        g.obj.position.set(
          lerp(g.data[a], g.data[b], t),
          lerp(g.data[a + 1], g.data[b + 1], t),
          lerp(g.data[a + 2], g.data[b + 2], t));
        g.obj.rotation.y = g.data[a + 3] + angleDelta(g.data[a + 3], g.data[b + 3]) * t;
      } else g.obj.visible = false;
    }
  }

  /* ------------------------------------------------------------- cameras */
  _cameras(dt) {
    const vs = this.views;
    // dynamic split: when two players are close the views merge into one
    if (vs.length === 2) {
      const d = vs[0].kart.pos.distanceTo(vs[1].kart.pos);
      if (!this.merged && d < 26) this.merged = true;
      else if (this.merged && d > 42) this.merged = false;
      this.mergeT = damp(this.mergeT, this.merged ? 1 : 0, 4, dt);
    }

    for (let i = 0; i < vs.length; i++) {
      const v = vs[i], k = v.kart;
      const sd = SURFACES[k.surf];
      const shake = (k.grounded ? sd.shake : 0) * clamp01(Math.abs(k.speed) / 34) * .16;
      const intro = this.phase === 'countdown' ? clamp01((this.countdown - .6) / 3.0) : 0;
      v.cam.update(k, dt, {
        look: k.ctl ? k.ctl.look : false,
        surfShake: shake,
        fovBias: k.stormTime > 0 ? 6 : 0,
        intro
      });
      v.flash = Math.max(0, v.flash - dt * 2.4);
      v.storm = damp(v.storm, k.stormTime > 0 ? 1 : 0, 6, dt);
    }

    // merged view: frame both karts from behind their average heading
    if (vs.length === 2 && this.mergeT > .001) {
      const a = vs[0].kart, b = vs[1].kart;
      _v0.copy(a.pos).add(b.pos).multiplyScalar(.5);
      const sep = a.pos.distanceTo(b.pos);
      const yaw = Math.atan2(
        Math.sin(a.yaw) + Math.sin(b.yaw),
        Math.cos(a.yaw) + Math.cos(b.yaw));
      const dist = 13 + sep * .55;
      _v1.set(Math.sin(yaw), 0, Math.cos(yaw));
      _v2.copy(_v0).addScaledVector(_v1, -dist);
      _v2.y += 6 + sep * .17;
      const c = vs[0].cam;
      c.pos.lerp(_v2, this.mergeT);
      c.cam.position.copy(c.pos);
      _v3.copy(_v0).addScaledVector(_v1, 5); _v3.y += 1.4;
      c.look.lerp(_v3, this.mergeT);
      c.cam.lookAt(c.look);
    }

    // the shadow camera follows player one
    const p0 = this.views[0].kart;
    this.sun.target.position.copy(p0.pos);
    this.sun.position.copy(p0.pos).add(
      _v0.set(this.cfg.env.sunDir[0], this.cfg.env.sunDir[1], this.cfg.env.sunDir[2]).multiplyScalar(220));
    this.rim.position.copy(p0.pos).add(
      _v0.set(-this.cfg.env.sunDir[0], .5, -this.cfg.env.sunDir[2]).multiplyScalar(160));
    this.rim.target.position.copy(p0.pos);
    this.rim.target.updateMatrixWorld();
    if (this.track.sky) this.track.sky.position.copy(p0.pos);
  }

  /* ----------------------------------------------------------------- HUD */
  _huds(dt) {
    for (let i = 0; i < this.views.length; i++) {
      const v = this.views[i];
      v.hud.update(v.kart, this, dt);
    }
  }

  /* ---------------------------------------------------------------- laps */
  _onLap(kart, lap) {
    if (lap <= 0) return;
    if (lap === 1) { kart.lapStart = this.time; return; }
    const t = this.time - kart.lapStart;
    kart.lapTimes.push(t);
    kart.lapStart = this.time;
    if (kart === this.views[0].kart) this.track.onLap(lap - 1);

    const v = this.viewOf(kart);
    if (v) {
      const best = this.app.bestLap[this.cfg.id];
      if (best == null || t < best) {
        this.app.bestLap[this.cfg.id] = t;
        v.hud.split('LAP ' + fmtTime(t) + '  ★', '#ffd84a');
        if (lap > 2) Audio.sfx('record', .7);
      } else v.hud.split('LAP ' + fmtTime(t), '#9fe8ff');
      clearTimeout(v._splitT);
      v._splitT = setTimeout(() => v.hud.split(''), 3200);
    }

    if (lap > this.laps) { this._finishKart(kart); return; }
    if (v) {
      Audio.sfx('lap', .8);
      if (lap === this.laps) v.hud.big('FINAL LAP', '#ffd84a');
      else v.hud.big('LAP ' + lap, '#ffffff');
    }
  }

  _finishKart(kart) {
    if (kart.finished) return;
    kart.finished = true;
    kart.finishTime = this.time;
    kart.finishPlace = this.finishOrder.length + 1;
    this.finishOrder.push(kart);
    const v = this.viewOf(kart);
    if (v) {
      v.hud.big(ORD[kart.finishPlace], kart.finishPlace === 1 ? '#ffd84a' : '#ffffff', true);
      Audio.sfx('finish', 1);
    }
    // once every human is home, give the pack a few seconds then show results
    const humansLeft = this.views.some(vv => !vv.kart.finished);
    if (!humansLeft && this.phase === 'race') {
      this.phase = 'finishing';
      this.resultTimer = 6.5;
      if (this.mode === 'tt') this.resultTimer = 1.4;
    }
  }

  _toResults() {
    this.phase = 'results';
    // anyone still running gets a place in progress order
    this.updatePositions();
    const L = this.track.path.length;
    for (let i = 0; i < this.order.length; i++) {
      const k = this.order[i];
      if (!k.finished) {
        k.finished = true;
        k.finishPlace = this.finishOrder.length + 1;
        // project the rest of their race rather than inventing a flat gap
        const remain = Math.max(0, (this.laps + 1 - k.progress)) * L;
        k.finishTime = this.time + remain / Math.max(16, Math.abs(k.speed));
        this.finishOrder.push(k);
      }
    }
    // save a time-trial ghost when it's a personal best
    if (this.mode === 'tt' && this.ghostRec) {
      const me = this.views[0].kart;
      const prev = this.app.ghosts[this.cfg.id];
      if (!prev || me.finishTime < prev.time) {
        this.app.ghosts[this.cfg.id] = {
          time: me.finishTime, charId: me.ch.id, data: this.ghostRec.data.slice()
        };
        this.app.saveGhosts();
        this.newRecord = true;
      }
    }
    Audio.stopMusic();
    Audio.setMuted(Audio.muted);
    this.app.onRaceComplete(this);
  }

  /* -------------------------------------------------------------- render */
  layout(w, h) {
    const dpr = this.app.dpr;
    const n = this.views.length;
    if (n === 1) {
      const v = this.views[0];
      v.rect = { x: 0, y: 0, w, h };
      v.glRect = { x: 0, y: 0, w: Math.floor(w * dpr), h: Math.floor(h * dpr) };
      v.cam.cam.aspect = w / h;
      v.cam.cam.updateProjectionMatrix();
      v.post.setSize(w, h, dpr);
      v.hud.layout(v.rect, 1);
      return;
    }
    // wide windows split side-by-side, tall ones stack
    const sideBySide = w / h > 1.25;
    const m = clamp01(this.mergeT);
    const f = lerp(.5, 1, m);
    if (sideBySide) {
      const w0 = Math.round(w * f), w1 = w - w0;
      this._setView(this.views[0], 0, 0, w0, h, dpr);
      this._setView(this.views[1], w0, 0, w1, h, dpr);
    } else {
      const h0 = Math.round(h * f), h1 = h - h0;
      this._setView(this.views[0], 0, 0, w, h0, dpr);
      this._setView(this.views[1], 0, h0, w, h1, dpr);
    }
  }
  _setView(v, x, y, w, h, dpr) {
    const H = this.app.height;
    v.rect = { x, y, w, h };
    v.glRect = {
      x: Math.floor(x * dpr), y: Math.floor((H - y - h) * dpr),
      w: Math.floor(w * dpr), h: Math.floor(h * dpr)
    };
    if (w > 4 && h > 4) {
      v.cam.cam.aspect = w / h;
      v.cam.cam.updateProjectionMatrix();
      v.post.setSize(w, h, dpr);
    }
    v.hud.layout(v.rect, clamp(Math.min(w, h * 1.7) / 900, .58, 1));
  }

  render() {
    const r = this.app.renderer;
    r.setScissorTest(false);
    r.setViewport(0, 0, this.app.width * this.app.dpr, this.app.height * this.app.dpr);
    r.clear();
    for (let i = 0; i < this.views.length; i++) {
      const v = this.views[i];
      if (v.glRect.w < 4 || v.glRect.h < 4) continue;
      const k = v.kart;
      const speedFrac = clamp01(Math.abs(k.speed) / k.stats.top);
      const boost = k.boostTime > 0 ? 1 : 0;
      const p = this._post || (this._post = { flash: [0, 0, 0] });
      p.bloom = this.quality === 'low' ? .42 : .58 + boost * .34;
      p.threshold = .80 - boost * .16;
      p.exposure = 0.92 + boost * .08;
      p.chroma = (0.0006 + speedFrac * 0.0016 + boost * 0.0012) * (1 + v.storm * 2);
      p.vignette = .34 + speedFrac * .3 + boost * .12;
      p.speed = clamp01((speedFrac - .62) / .38) * .55 + boost * .35;
      p.storm = v.storm;
      p.time = this.time;
      p.sat = 1.05 + boost * .12;
      const fl = v.flash;
      p.flash[0] = fl * .9; p.flash[1] = fl * .95; p.flash[2] = fl;
      v.post.render(this.scene, v.cam.cam, p, v.glRect);
    }
    r.setScissorTest(false);
  }

  dispose() {
    Audio.stopMusic();
    Audio.stopAmbience();
    this.views.forEach(v => { v.hud.destroy(); v.post.dispose(); });
    this.voices.forEach(s => Audio.silenceEngine(s.v));
    this.driftVoices.forEach(d => d && Audio.updateDrift(d, 0, false, 0));
    this.track.dispose();
    this.scene.traverse(o => {
      if (o.geometry) o.geometry.dispose();
    });
    $('#hudlayer').classList.add('hidden');
  }
}
