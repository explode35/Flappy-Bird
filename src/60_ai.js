/* ============================================================================
   AI DRIVERS — they drive with the player's physics. No cheat forces, no
   teleporting. What catch-up assistance exists is limited to item luck and a
   small top-speed band, both visible in the code below.
   ========================================================================= */

class AIDriver {
  constructor(kart, skill, seed) {
    this.kart = kart;
    this.skill = skill;                 // 0..1
    this.rng = makeRng(seed);
    this.ctl = Input.newState();
    this.lineBias = this.rng.range(-.22, .22);
    this.mistakeTimer = this.rng.range(4, 16);
    this.mistake = 0;
    this.mistakeSteer = 0;
    this.driftHold = 0;
    this.targetTier = 2 + (this.rng() < skill * .8 ? 1 : 0);
    this._steerSmooth = 0;
    this.itemCool = this.rng.range(.5, 2.5);
    this.avoid = 0;
    this.recover = 0;
  }

  /** Produce a control state for this frame. */
  think(dt, race) {
    const k = this.kart, T = k.track, P = T.path, c = this.ctl;
    c.driftPrev = c.drift;
    c.itemPrev = c.item;

    if (k.finished) {
      c.throttle = 1; c.brake = 0;
      c.steer = this._toSteer(this._desiredYaw(dt, race), Math.abs(k.speed)) * .8;
      c.drift = false; c.item = false;
      c.driftHit = false; c.itemHit = false; c.itemRelease = false; c.reset = false;
      return c;
    }

    const speed = Math.abs(k.speed);

    // ---- mistakes: brief, believable, and never during the last corner of a
    // race they are winning by a mile (they'd look broken rather than human)
    this.mistakeTimer -= dt;
    if (this.mistakeTimer <= 0) {
      this.mistakeTimer = lerp(7, 26, this.skill) * this.rng.range(.7, 1.5);
      if (this.rng() < lerp(.85, .28, this.skill)) {
        this.mistake = this.rng.range(.35, 1.05);
        this.mistakeSteer = this.rng.sign() * this.rng.range(.25, .7);
        this.mistakeLate = this.rng() < .5;      // late braking instead of a twitch
      }
    }
    if (this.mistake > 0) this.mistake -= dt;

    // ---- steering: pure pursuit gives a *desired yaw rate*, which we then
    // invert through whichever steering model the kart is currently using.
    // Commanding yaw rate instead of raw stick keeps the line tight at every
    // speed and lets the AI hold a drift instead of spiralling into the apex.
    const yawWant = this._desiredYaw(dt, race);
    let steer = this._toSteer(yawWant, speed);
    if (this.mistake > 0 && !this.mistakeLate) steer += this.mistakeSteer * clamp01(this.mistake);
    steer = clamp(steer, -1, 1);

    // ---- speed control from the pre-computed line speed
    const look = clamp(speed * 0.9, 14, 70) / P.length;
    const vTarget = Math.min(
      P.lineSpeedAt(k.s + look),
      P.lineSpeedAt(k.s + look * 1.9) * 1.12,
      P.lineSpeedAt(k.s + look * .45) * 1.3
    ) * lerp(.84, 1.0, this.skill) * (this.mistake > 0 && this.mistakeLate ? 1.25 : 1);

    let throttle = 1, brake = 0;
    if (speed > vTarget * 1.16) { throttle = 0; brake = 1; }
    else if (speed > vTarget * 1.02) { throttle = .15; brake = 0; }
    if (!k.grounded) brake = 0;
    if (k.surf !== SURF.ROAD && k.surf !== SURF.BOOST && k.grounded) throttle = 1;   // dig out of the rough

    // ---- drifting: commit when the corner is long enough to be worth it
    const aheadCurv = Math.abs(P.curvAt(k.s + look * .8));
    const curvNow = Math.abs(P.curvAt(k.s + look * .25));
    const cornerLong = this._cornerLength(k.s, look) > lerp(.022, .05, 1 - this.skill);
    const wantDrift = !this.noDrift && speed > 21 && curvNow > .0042 && Math.abs(steer) > .18 && cornerLong && this.skill > .18;

    if (!k.drifting) {
      if (wantDrift && this.driftHold <= 0) {
        c.drift = true;
        this.driftHold = .3;
      } else {
        c.drift = c.drift && this.driftHold > 0;
      }
    } else {
      // hold until we hit the target tier, or the corner runs out
      const keep = (k.driftTier < this.targetTier && aheadCurv > .0026) || curvNow > .0038;
      c.drift = keep;
      if (k.driftTier >= 3) c.drift = false;
      // wiggle-steer to charge faster — the same trick a good player uses
      if (this.skill > .55 && k.driftTier < this.targetTier) {
        this._wig = (this._wig || 0) + dt * lerp(9, 15, this.skill);
        steer = clamp(steer + Math.sin(this._wig) * .22 * k.driftDir, -1, 1);
      }
    }
    if (this.driftHold > 0) this.driftHold -= dt;

    // ---- avoid other karts and live hazards
    steer += this._avoidance(race, dt);
    steer = clamp(steer, -1, 1);

    // ---- respawn if stuck
    if (speed < 3 && k.grounded && race.phase === 'race') {
      this.recover += dt;
      if (this.recover > 3.2) { c.reset = true; this.recover = 0; }
      else if (this.recover > 1.2) { brake = 1; throttle = 0; steer = this._lineErr > 0 ? -.8 : .8; }
    } else this.recover = 0;

    // ---- items
    this._items(dt, race, c);

    c.steer = damp(this._steerSmooth, steer, lerp(14, 26, this.skill), dt);
    this._steerSmooth = c.steer;
    c.throttle = throttle;
    c.brake = brake;
    c.driftHit = c.drift && !c.driftPrev;
    c.itemHit = c.item && !c.itemPrev;
    c.itemRelease = !c.item && c.itemPrev;
    return c;
  }

  /** How far ahead the current corner keeps bending (in s units). */
  _cornerLength(s, look) {
    const P = this.kart.track.path;
    const dir = sign(P.curvAt(s + look * .3));
    let len = 0;
    for (let i = 0; i < 26; i++) {
      const ss = s + look * .3 + i * .004;
      const k = P.curvAt(ss);
      if (sign(k) !== dir || Math.abs(k) < .004) break;
      len += .004;
    }
    return len;
  }

  /** Desired yaw rate (rad/s) from pure pursuit toward the racing line. */
  _desiredYaw(dt, race) {
    const k = this.kart, P = k.track.path;
    const speed = Math.max(4, Math.abs(k.speed));
    // lookahead grows with speed: short enough to be accurate, long enough
    // that the kart isn't chasing a point it has already passed
    const L1 = clamp(11 + speed * .46, 14, 42);
    const L2 = clamp(26 + speed * 1.05, 34, 105);
    const d1 = L1 / P.length, d2 = L2 / P.length;
    const w1 = P.widthAt(k.s + d1), w2 = P.widthAt(k.s + d2);
    const off = clamp(P.lineOffsetAt(k.s + d1) + this.lineBias * w1 * .5 + this.avoid, -w1 + 2.2, w1 - 2.2);
    const off2 = clamp(P.lineOffsetAt(k.s + d2) + this.lineBias * w2 * .4, -w2 + 2.2, w2 - 2.2);
    P.surfacePoint(k.s + d1, off, _v2);
    P.surfacePoint(k.s + d2, off2, _v3);

    const e1 = angleDelta(k.yaw, Math.atan2(_v2.x - k.pos.x, _v2.z - k.pos.z));
    const e2 = angleDelta(k.yaw, Math.atan2(_v3.x - k.pos.x, _v3.z - k.pos.z));
    this._lineErr = e1;
    // pure-pursuit curvature: omega = 2 v sin(e) / L
    const dist = Math.max(6, Math.hypot(_v2.x - k.pos.x, _v2.z - k.pos.z));
    let omega = 2 * speed * Math.sin(e1) / dist;
    omega += e2 * lerp(.5, .85, this.skill);      // anticipate the next phase
    return omega;
  }

  /** Invert the kart's own steering model so a yaw-rate request lands exactly. */
  _toSteer(omega, speed) {
    const k = this.kart;
    const spdFrac = clamp01(speed / Math.max(1, k.stats.top));
    if (k.drifting) {
      // yaw = dir * (base + steerTerm * into) * speedScale  ->  solve for `into`
      const scale = lerp(.72, 1.12, spdFrac);
      const into = ((omega * k.driftDir) / scale - K.driftYawBase) / K.driftYawSteer;
      return k.driftDir * clamp(into, K.driftSteerMin, 1);
    }
    const authority = lerp(1, K.steerHighSpeed, spdFrac * spdFrac);
    return clamp(omega / Math.max(.25, k.stats.steer * authority), -1, 1);
  }

  _avoidance(race, dt) {
    const k = this.kart;
    let bias = 0, target = 0;
    const fwd = k.forward(_v0);
    for (let i = 0; i < race.karts.length; i++) {
      const o = race.karts[i];
      if (o === k) continue;
      const dx = o.pos.x - k.pos.x, dz = o.pos.z - k.pos.z;
      const d2 = dx * dx + dz * dz;
      if (d2 > 220) continue;
      const ahead = dx * fwd.x + dz * fwd.z;
      if (ahead < 0.5) continue;
      const side = dx * Math.cos(k.yaw) - dz * Math.sin(k.yaw);
      const w = clamp01(1 - Math.sqrt(d2) / 15);
      target += (side > 0 ? -1 : 1) * w * 5.5;
      bias += (side > 0 ? -1 : 1) * w * .34;
    }
    // live geysers
    const T = k.track;
    if (T.geysers) {
      for (let i = 0; i < T.geysers.length; i++) {
        const g = T.geysers[i];
        const dd = ((g.s - k.s) % 1 + 1) % 1;
        if (dd < .028 && (g.active || g.phase % g.period > g.period * .4)) {
          target += (g.u > k.u ? -1 : 1) * 9;
          bias += (g.u > k.u ? -1 : 1) * .3;
        }
      }
    }
    this.avoid = damp(this.avoid, clamp(target, -8, 8), 5, dt);
    return clamp(bias, -.45, .45);
  }

  _items(dt, race, c) {
    const k = this.kart;
    this.itemCool -= dt;
    // firing is an input *release*, exactly like the player's — one frame held,
    // one frame let go, so AI and human go through identical code.
    if (this.firing) { c.item = false; this.firing = false; this.itemCool = this.rng.range(1.8, 4.5); return; }
    if (!k.item) { c.item = false; return; }
    const def = ITEMS[k.item];
    if (this.itemCool > 0) { c.item = def.hold && this.rng() < .5; return; }

    let use = false;
    const ahead = race.nearestAhead(k), behind = race.nearestBehind(k);
    switch (def.ai) {
      case 'forward':
        use = ahead && ahead.dist < 55 && Math.abs(ahead.angle) < .28;
        break;
      case 'homing':
        use = k.position > 1 && (this.rng() < .02 || (ahead && ahead.dist < 120));
        break;
      case 'trail':
        // hold it as a shield while someone is close behind, then drop it
        if (behind && behind.dist < 26) { c.item = true; use = this.rng() < .02; }
        else use = this.rng() < .01;
        break;
      case 'shield':
        use = true;
        break;
      case 'boost':
        use = Math.abs(k.track.path.curvAt(k.s + .02)) < .006 && Math.abs(k.speed) > k.stats.top * .6;
        break;
      case 'storm':
        use = k.position > 3 && this.rng() < .04;
        break;
      default: use = this.rng() < .03;
    }
    if (use) { c.item = true; this.firing = true; }
  }
}
