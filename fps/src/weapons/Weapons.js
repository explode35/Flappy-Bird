import * as THREE from 'three';
import { WEAPONS, GRENADE, ORDER } from './WeaponDefs.js';
import { BUILDERS, buildLooseMag } from './Models.js';
import { buildGunMaterials, disposeGunMaterials } from './GunMaterials.js';
import { clamp, damp, lerp, smoothstep } from '../core/Contracts.js';

/**
 * Weapon system: viewmodel rig, animation, ballistics.
 *
 * The rig is a chain of nested groups so each animation layer is independent
 * and cannot corrupt the others:
 *
 *   rig            base placement (hip or ADS pose)
 *    └ swayNode    idle drift + camera lag
 *       └ bobNode  movement bob and sprint cant
 *          └ kickNode  recoil translation/rotation
 *             └ model
 *
 * ADS alignment is computed from the model's actual `sight` anchor rather than
 * hand-tuned offsets, so the dot lands exactly on screen centre for every
 * weapon and stays correct if the models change.
 */

const _v = new THREE.Vector3();
const _v2 = new THREE.Vector3();
const _dir = new THREE.Vector3();
const _q = new THREE.Quaternion();
const _m = new THREE.Matrix4();
const _euler = new THREE.Euler();
const _up = new THREE.Vector3(0, 1, 0);
const _origin = new THREE.Vector3();

const HIP_POS = new THREE.Vector3(0.086, -0.082, -0.335);
const HIP_ROT = new THREE.Euler(0.026, -0.052, 0.014);
const SPRINT_POS = new THREE.Vector3(0.118, -0.140, -0.300);
const SPRINT_ROT = new THREE.Euler(-0.16, 0.55, 0.32);   // ~18deg cant

/** Simple 2-octave drift, used for idle sway. */
function drift(t, seed) {
  return Math.sin(t * 0.9 + seed) * 0.62 + Math.sin(t * 2.27 + seed * 3.1) * 0.38;
}

export class Weapons {
  constructor(ctx) {
    this.ctx = ctx;
    this.models = {};
    this.slots = ORDER.slice();
    this.index = 0;
    this.state = {};          // per-weapon ammo/heat
    this.currentSpread = 0;

    this.adsFactor = 0;
    this._adsWanted = false;
    this._forcedADS = false;

    this._fireAccum = 0;
    this._shotIndex = 0;
    this._spread = 0;
    this._triggerHeld = false;
    this._lastShotAt = -99;

    this._reloadT = 0;
    this._reloadDur = 0;
    this._reloadEmpty = false;
    this._reloading = false;

    this._swapT = 0;
    this._swapping = false;
    this._pendingIndex = -1;

    this._kick = new THREE.Vector3();
    this._kickVel = new THREE.Vector3();
    this._kickRot = new THREE.Vector3();
    this._kickRotVel = new THREE.Vector3();

    this._lagYaw = 0; this._lagPitch = 0;
    this._lastCamYaw = 0; this._lastCamPitch = 0;
    this._inspectT = -1;

    this._looseMags = [];
    this._grenades = GRENADE.count;
    this._liveGrenades = [];
    this._cookT = -1;
    this.time = 0;
  }

  get def() { return WEAPONS[this.slots[this.index]]; }
  get current() { return this.def; }
  get ammo() { return this.state[this.slots[this.index]]; }

  async init() {
    const { ctx } = this;
    this.mats = buildGunMaterials(ctx);

    // --- rig ----------------------------------------------------------------
    this.rig = new THREE.Group(); this.rig.name = 'weaponRig';
    this.swayNode = new THREE.Group(); this.swayNode.name = 'sway';
    this.bobNode = new THREE.Group(); this.bobNode.name = 'bob';
    this.kickNode = new THREE.Group(); this.kickNode.name = 'kick';
    this.rig.add(this.swayNode);
    this.swayNode.add(this.bobNode);
    this.bobNode.add(this.kickNode);
    ctx.viewScene.add(this.rig);

    // The world sun does not light the viewmodel usefully, so give it a rig of
    // its own parented to the view camera.
    const key = new THREE.DirectionalLight(0xffd7b0, 2.6);
    key.position.set(-0.6, 0.9, 0.5);
    const fill = new THREE.DirectionalLight(0x7d90a8, 1.15);
    fill.position.set(0.8, -0.2, 0.4);
    const rim = new THREE.DirectionalLight(0xbfd4ff, 1.9);
    rim.position.set(0.3, 0.4, -1.0);
    ctx.viewScene.add(key, fill, rim);
    ctx.viewScene.environment = ctx.scene.environment;
    ctx.viewScene.environmentIntensity = 0.65;

    // --- models -------------------------------------------------------------
    let tris = 0;
    for (const id of this.slots) {
      const model = BUILDERS[id](this.mats);
      model.visible = false;
      this.kickNode.add(model);
      this.models[id] = model;
      tris += model.userData.tris || 0;
      const d = WEAPONS[id];
      this.state[id] = { mag: d.magSize, reserve: d.reserve };
      // Where the sight anchor sits relative to the model root: the ADS pose is
      // whatever cancels this out.
      model.updateMatrixWorld(true);
      const s = model.userData.anchors.sight;
      model.userData.sightLocal = s.position.clone();
    }
    console.log(`[weapons] ${this.slots.length} models, ${tris} tris total`);

    this._equip(0, true);
    this._bind();
  }

  _bind() {
    const bus = this.ctx.bus;
    bus.on('player:mantle', () => { this._mantleT = 0.42; });
    bus.on('game:start', () => { this._resetAmmo(); });
  }

  _resetAmmo() {
    for (const id of this.slots) {
      const d = WEAPONS[id];
      this.state[id] = { mag: d.magSize, reserve: d.reserve };
    }
    this._grenades = GRENADE.count;
    this._emitAmmo();
  }

  _equip(i, instant) {
    if (i === this.index && !instant) return;
    for (const id of this.slots) this.models[id].visible = false;
    this.index = i;
    const model = this.models[this.slots[i]];
    model.visible = true;
    this._shotIndex = 0;
    this._spread = 0;
    this._reloading = false;
    this._swapping = !instant;
    this._swapT = instant ? 0 : this.def.swapTime;
    this._computeAdsPose();
    this._emitAmmo();
    this.ctx.bus.emit('weapon:changed', {
      name: this.def.name, icon: this.def.icon,
      mag: this.ammo.mag, reserve: this.ammo.reserve, auto: this.def.auto,
    });
  }

  /**
   * The ADS pose: translate the rig so the sight anchor lands on the view
   * camera's forward axis at eye level, and cancel any model rotation.
   */
  _computeAdsPose() {
    const model = this.models[this.slots[this.index]];
    const s = model.userData.sightLocal;
    // Sight should sit on (0, 0, -adsDist) in view space.
    const adsDist = 0.26;
    this._adsPos = new THREE.Vector3(-s.x, -s.y, -adsDist - s.z);
    this._adsRot = new THREE.Euler(0, 0, 0);
  }

  forceADS(v) { this._forcedADS = !!v; this.adsFactor = v ? 1 : 0; }

  // -------------------------------------------------------------------------

  update(dt, time) {
    if (dt <= 0) { this._pose(0); return; }
    this.time = time;
    const input = this.ctx.input;
    const player = this.ctx.player;
    const active = input.locked && !player?.dead && !player?.frozen;

    this._swapT = Math.max(0, this._swapT - dt);
    if (this._swapping && this._swapT <= 0) this._swapping = false;

    if (active) this._handleInput(dt);
    this._updateReload(dt);
    this._updateFire(dt);
    this._updateSpread(dt);
    this._updateGrenades(dt);
    this._updateLooseMags(dt);
    this._animate(dt);
    this._pose(dt);
  }

  _handleInput(dt) {
    const input = this.ctx.input;
    const player = this.ctx.player;
    const def = this.def;

    // Weapon select
    if (input.hit('Digit1')) this._equip(0);
    if (input.hit('Digit2')) this._equip(1);
    if (input.hit('Digit3')) this._equip(2);
    if (input.wheel) this._equip((this.index + (input.wheel > 0 ? 1 : 2)) % 3);
    if (input.hit('KeyF') && this._inspectT < 0 && !this._reloading) this._inspectT = 0;

    // ADS — blocked while sprinting or mid-swap
    this._adsWanted = input.mDown(2) && !player.isSprinting && !this._swapping && !this.isThrowing;
    const adsRate = this._adsWanted ? 1 / def.adsIn : -1 / def.adsOut;
    this.adsFactor = clamp(this.adsFactor + adsRate * dt, 0, 1);
    player.setADS?.(this.adsFactor > 0.5);

    // FOV follows ADS with a slight ease so it does not feel like a snap zoom.
    const cam = this.ctx.camera;
    const targetFov = lerp(80, def.fovAds, smoothstep(0, 1, this.adsFactor));
    if (Math.abs(cam.fov - targetFov) > 0.01) {
      cam.fov = damp(cam.fov, targetFov, 18, dt);
      cam.updateProjectionMatrix();
    }

    // Reload
    const a = this.ammo;
    if ((input.hit('KeyR') || (a.mag === 0 && input.mDown(0))) && !this._reloading &&
        a.mag < def.magSize && a.reserve > 0 && !this._swapping) {
      this._startReload();
    }

    // Trigger
    const wantFire = input.mDown(0) && !player.isSprinting && !this._reloading && !this._swapping;
    if (def.auto) this._triggerHeld = wantFire;
    else this._triggerHeld = input.mHit(0) && !player.isSprinting && !this._reloading && !this._swapping;

    // Grenade
    if (input.hit('KeyG') && this._grenades > 0 && this._cookT < 0) this._cookT = 0;
    if (this._cookT >= 0) {
      this._cookT += dt;
      if (!input.down('KeyG') || this._cookT > GRENADE.cook) this._throwGrenade();
    }
  }

  // -------------------------------------------------------------------------
  //  Firing
  // -------------------------------------------------------------------------

  _updateFire(dt) {
    const def = this.def;
    const a = this.ammo;
    const interval = 60 / def.rpm;

    // Accumulator, so the rate is exact regardless of framerate and a long
    // frame can still emit several rounds.
    this._fireAccum += dt;
    if (!this._triggerHeld) { this._fireAccum = Math.min(this._fireAccum, interval); return; }

    let guard = 0;
    while (this._fireAccum >= interval && guard++ < 8) {
      this._fireAccum -= interval;
      if (a.mag <= 0) { this._triggerHeld = false; this.ctx.bus.emit('weapon:dryfire', {}); break; }
      this._fireOne();
      if (!def.auto) { this._triggerHeld = false; break; }
    }
  }

  _fireOne() {
    const def = this.def;
    const a = this.ammo;
    const ctx = this.ctx;
    const cam = ctx.camera;
    a.mag--;
    this._lastShotAt = this.time;

    // --- aim ray, with spread -------------------------------------------
    cam.getWorldDirection(_dir);
    const spread = this.currentSpread;
    if (spread > 0) {
      // Uniform disc in the plane perpendicular to the aim direction.
      const ang = Math.random() * Math.PI * 2;
      const r = Math.sqrt(Math.random()) * spread;
      _v.set(1, 0, 0).cross(_dir);
      if (_v.lengthSq() < 1e-6) _v.set(0, 0, 1).cross(_dir);
      _v.normalize();
      _v2.crossVectors(_dir, _v);
      _dir.addScaledVector(_v, Math.cos(ang) * r).addScaledVector(_v2, Math.sin(ang) * r).normalize();
    }

    const muzzle = this.models[this.slots[this.index]].userData.anchors.muzzle;
    muzzle.getWorldPosition(_origin);
    // The tracer starts at the muzzle but the shot is traced from the eye, so
    // what you hit always matches the crosshair.
    ctx.bus.emit('weapon:fire', {
      origin: _origin.clone(), dir: _dir.clone(),
      weapon: def.id, silenced: !!def.silenced,
    });

    this._trace(cam.position, _dir, def);

    // --- recoil -------------------------------------------------------------
    const pat = def.pattern;
    const p = pat[Math.min(this._shotIndex, pat.length - 1)];
    const rp = p[0] + (Math.random() - 0.5) * def.randPitch;
    const ry = p[1] + (Math.random() - 0.5) * def.randYaw;
    ctx.player?.addRecoil?.(rp * 0.016, ry * 0.016);
    this._shotIndex++;

    this._kickVel.z += def.kickBack * def.kickFreq;
    this._kickRotVel.x += def.kickUp * def.kickFreq;
    this._kickRotVel.z += (Math.random() - 0.5) * def.kickRoll * def.kickFreq;

    this._spread = Math.min(def.spreadMax, this._spread + def.spreadPerShot);
    this._boltT = 0;
    ctx.bus.emit('shake', { amount: def.kind === 'rifle' ? 0.055 : 0.04, duration: 0.08 });

    // --- shell casing -------------------------------------------------------
    const eject = this.models[this.slots[this.index]].userData.anchors.eject;
    eject.getWorldPosition(_v);
    ctx.bus.emit('shell', {
      position: _v.clone(),
      velocity: new THREE.Vector3(
        1.6 + Math.random() * 0.8, 1.5 + Math.random() * 0.7, -0.3 + Math.random() * 0.6
      ).applyQuaternion(cam.quaternion),
      size: def.shellSize,
    });

    this._emitAmmo();
  }

  /**
   * Hitscan with penetration. Thin wood and sheet metal pass rounds through
   * with a damage and angle penalty; concrete stops them.
   */
  _trace(from, dir, def) {
    const ctx = this.ctx;
    const phys = ctx.physics;
    if (!phys?.raycast) return;

    let origin = _v2.copy(from);
    let budget = def.penetration;
    let damageScale = 1;
    let traveled = 0;

    for (let pass = 0; pass < 3; pass++) {
      const hit = phys.raycast(origin, dir, 400 - traveled, {});
      if (!hit) {
        this._tracer(from, _v.copy(origin).addScaledVector(dir, 90), def);
        return;
      }
      traveled += hit.distance;

      if (hit.isEnemy) {
        const dmg = this._damageAt(traveled, def) * (hit.damageMul || 1) * damageScale;
        const headshot = hit.bone === 'head';
        ctx.bus.emit('hit:enemy', {
          enemy: hit.enemy, point: hit.point.clone(), normal: hit.normal.clone(),
          damage: dmg, headshot, dir: dir.clone(),
        });
        this._tracer(from, hit.point, def);
        // Rounds do not carry on through bodies at these calibres.
        return;
      }

      ctx.bus.emit('impact', {
        point: hit.point.clone(), normal: hit.normal.clone(),
        surface: hit.surface, dir: dir.clone(),
      });
      this._tracer(from, hit.point, def);

      // Penetration cost by material, scaled by the angle of incidence.
      const cost = PEN_COST[hit.surface] ?? 1;
      const incidence = Math.abs(hit.normal.dot(dir));
      const effective = cost / Math.max(0.25, incidence);
      budget -= effective;
      if (budget <= 0) return;
      damageScale *= 0.55;
      origin = _v2.copy(hit.point).addScaledVector(dir, 0.12);
    }
  }

  _damageAt(dist, def) {
    const t = clamp((dist - def.distNear) / Math.max(1e-3, def.distFar - def.distNear), 0, 1);
    return lerp(def.dmgNear, def.dmgFar, t);
  }

  _tracer(from, to, def) {
    // Only some rounds are traced — that is how real belts are loaded, and a
    // tracer on every shot looks like a laser show.
    if (this._shotIndex % def.tracerEvery !== 0) return;
    const muzzle = this.models[this.slots[this.index]].userData.anchors.muzzle;
    muzzle.getWorldPosition(_v);
    this.ctx.bus.emit('tracer', { from: _v.clone(), to: to.clone(), speed: def.tracerSpeed });
  }

  _updateSpread(dt) {
    const def = this.def;
    const player = this.ctx.player;
    this._spread = Math.max(0, this._spread - def.spreadDecay * this._spread * dt);

    let base = lerp(def.spreadBase, def.spreadAds, this.adsFactor);
    if (player) {
      base += (player.speed / 6) * def.spreadMove * (1 - this.adsFactor * 0.6);
      if (!player.isGrounded) base += def.spreadJump;
      if (player.isCrouched) base *= def.spreadCrouch;
    }
    this.currentSpread = Math.min(def.spreadMax, base + this._spread);
  }

  // -------------------------------------------------------------------------
  //  Reload
  // -------------------------------------------------------------------------

  _startReload() {
    const def = this.def;
    this._reloading = true;
    this._reloadEmpty = this.ammo.mag === 0;
    this._reloadDur = this._reloadEmpty ? def.reloadEmpty : def.reloadTactical;
    this._reloadT = 0;
    this._adsWanted = false;
    this.ctx.bus.emit('weapon:reload', { name: def.name, phase: 'start', empty: this._reloadEmpty });
  }

  _updateReload(dt) {
    if (!this._reloading) return;
    this._reloadT += dt;
    const t = this._reloadT / this._reloadDur;

    // Drop the magazine as a real falling prop at the mag-release beat.
    if (!this._magDropped && t > 0.22) {
      this._magDropped = true;
      this._dropMag();
    }
    if (t >= 1) {
      this._reloading = false;
      this._magDropped = false;
      const def = this.def, a = this.ammo;
      const want = def.magSize - a.mag;
      const give = Math.min(want, a.reserve);
      a.mag += give; a.reserve -= give;
      this._shotIndex = 0;
      this._emitAmmo();
      this.ctx.bus.emit('weapon:reload', { name: def.name, phase: 'end' });
    }
  }

  _dropMag() {
    const model = this.models[this.slots[this.index]];
    const mag = model.userData.mag;
    if (mag) mag.visible = false;
    const loose = buildLooseMag(this.mats, this.slots[this.index]);
    model.userData.anchors.magWell.getWorldPosition(_v);
    // The loose mag lives in the world scene so it falls past the viewmodel.
    this.ctx.viewScene.add(loose);
    loose.position.copy(this.rig.worldToLocal(_v.clone()));
    this._looseMags.push({
      obj: loose, life: 1.6,
      vel: new THREE.Vector3(-0.1 + Math.random() * 0.2, -0.2, 0.1),
      spin: new THREE.Vector3(Math.random() * 3, Math.random() * 2, Math.random() * 4),
    });
    setTimeout(() => { if (mag) mag.visible = true; }, this._reloadDur * 1000 * 0.55);
  }

  _updateLooseMags(dt) {
    for (let i = this._looseMags.length - 1; i >= 0; i--) {
      const m = this._looseMags[i];
      m.life -= dt;
      m.vel.y -= 3.2 * dt;
      m.obj.position.addScaledVector(m.vel, dt);
      m.obj.rotation.x += m.spin.x * dt;
      m.obj.rotation.y += m.spin.y * dt;
      m.obj.rotation.z += m.spin.z * dt;
      if (m.life <= 0) {
        m.obj.removeFromParent();
        m.obj.traverse((o) => o.geometry?.dispose?.());
        this._looseMags.splice(i, 1);
      }
    }
  }

  // -------------------------------------------------------------------------
  //  Grenades
  // -------------------------------------------------------------------------

  _throwGrenade() {
    const cook = this._cookT;
    this._cookT = -1;
    if (this._grenades <= 0) return;
    this._grenades--;
    const cam = this.ctx.camera;
    cam.getWorldDirection(_dir);
    const g = {
      pos: cam.position.clone().addScaledVector(_dir, 0.5),
      vel: _dir.clone().multiplyScalar(GRENADE.throwSpeed).addScaledVector(_up, 2.2),
      fuse: Math.max(0.35, GRENADE.cook - cook),
      mesh: null,
    };
    const mesh = new THREE.Mesh(
      new THREE.IcosahedronGeometry(GRENADE.radiusBody, 1),
      this.mats.olive
    );
    mesh.castShadow = true;
    this.ctx.scene.add(mesh);
    g.mesh = mesh;
    this._liveGrenades.push(g);
    this.ctx.bus.emit('grenade:thrown', { grenades: this._grenades });
  }

  _updateGrenades(dt) {
    const phys = this.ctx.physics;
    for (let i = this._liveGrenades.length - 1; i >= 0; i--) {
      const g = this._liveGrenades[i];
      g.fuse -= dt;
      g.vel.y -= GRENADE.gravity * dt;

      _v.copy(g.vel).multiplyScalar(dt);
      const dist = _v.length();
      if (dist > 1e-5 && phys?.raycast) {
        _v2.copy(_v).multiplyScalar(1 / dist);
        const hit = phys.raycast(g.pos, _v2, dist + GRENADE.radiusBody, { skipEnemies: true });
        if (hit) {
          // Reflect, lose energy, and scrub tangential speed as friction.
          g.pos.copy(hit.point).addScaledVector(hit.normal, GRENADE.radiusBody + 0.01);
          const vn = hit.normal.dot(g.vel);
          g.vel.addScaledVector(hit.normal, -(1 + GRENADE.restitution) * vn);
          g.vel.multiplyScalar(GRENADE.friction);
          this.ctx.bus.emit('grenade:bounce', { point: g.pos.clone(), speed: Math.abs(vn) });
        } else {
          g.pos.add(_v);
        }
      } else {
        g.pos.add(_v);
      }
      g.mesh.position.copy(g.pos);
      g.mesh.rotation.x += dt * 6; g.mesh.rotation.z += dt * 4;

      if (g.fuse <= 0) {
        this.ctx.bus.emit('explosion', {
          point: g.pos.clone(), radius: GRENADE.radius, damage: GRENADE.damage,
        });
        g.mesh.removeFromParent();
        g.mesh.geometry.dispose();
        this._liveGrenades.splice(i, 1);
      }
    }
  }

  // -------------------------------------------------------------------------
  //  Animation
  // -------------------------------------------------------------------------

  _animate(dt) {
    const def = this.def;
    const model = this.models[this.slots[this.index]];
    const ud = model.userData;

    // --- bolt cycle ---------------------------------------------------------
    if (this._boltT !== undefined && this._boltT >= 0) {
      this._boltT += dt;
      const cycleTime = Math.min(0.055, 60 / def.rpm * 0.7);
      const t = this._boltT / cycleTime;
      if (t >= 1) { this._boltT = -1; if (ud.bolt) ud.bolt.position.z = 0; }
      else if (ud.bolt) {
        // Back fast, forward slower — the asymmetry is what reads as a cycle.
        const s = t < 0.4 ? t / 0.4 : 1 - (t - 0.4) / 0.6;
        ud.bolt.position.z = s * 0.030;
      }
    }
    if (ud.port) ud.port.rotation.x = this._boltT >= 0 ? -0.9 : 0;

    // --- reload part motion -------------------------------------------------
    if (this._reloading) {
      const t = this._reloadT / this._reloadDur;
      if (ud.mag) {
        // Mag out, gap, new mag in with a tap.
        const off = t < 0.28 ? smoothstep(0.1, 0.28, t) * -0.14
          : t < 0.55 ? -0.14
            : -0.14 * (1 - smoothstep(0.55, 0.82, t)) - Math.max(0, 0.012 * Math.sin((t - 0.82) * 30));
        ud.mag.position.y = off;
      }
      // Charging handle on an empty reload.
      if (this._reloadEmpty && ud.charge) {
        const c = smoothstep(0.84, 0.92, t) - smoothstep(0.92, 0.99, t);
        ud.charge.position.z = c * 0.055;
        if (ud.bolt) ud.bolt.position.z = c * 0.030;
      }
    } else if (ud.mag) {
      ud.mag.position.y = damp(ud.mag.position.y, 0, 22, dt);
    }

    // --- red dot: only visible when actually looking through the optic ------
    const optic = model.getObjectByName('optic');
    if (optic?.userData.dot) {
      optic.userData.dot.material.opacity = smoothstep(0.55, 0.95, this.adsFactor);
    }

    // --- recoil springs -----------------------------------------------------
    const kd = def.kickDamp;
    for (const [val, vel, stiff] of [[this._kick, this._kickVel, def.kickFreq * 1.6],
      [this._kickRot, this._kickRotVel, def.kickFreq * 1.4]]) {
      vel.x += -stiff * val.x * dt - kd * vel.x * dt;
      vel.y += -stiff * val.y * dt - kd * vel.y * dt;
      vel.z += -stiff * val.z * dt - kd * vel.z * dt;
      val.addScaledVector(vel, dt);
    }

    // --- camera lag: the gun trails the view ---------------------------------
    const player = this.ctx.player;
    const yaw = player?.yaw ?? 0, pitch = player?.pitch ?? 0;
    let dYaw = yaw - this._lastCamYaw;
    if (dYaw > Math.PI) dYaw -= Math.PI * 2; else if (dYaw < -Math.PI) dYaw += Math.PI * 2;
    const dPitch = pitch - this._lastCamPitch;
    this._lastCamYaw = yaw; this._lastCamPitch = pitch;
    const lagScale = lerp(1, 0.35, this.adsFactor);
    this._lagYaw = damp(this._lagYaw + dYaw * 1.6 * lagScale, 0, 11, dt);
    this._lagPitch = damp(this._lagPitch + dPitch * 1.4 * lagScale, 0, 11, dt);
    this._lagYaw = clamp(this._lagYaw, -0.30, 0.30);
    this._lagPitch = clamp(this._lagPitch, -0.26, 0.26);

    if (this._inspectT >= 0) {
      this._inspectT += dt;
      if (this._inspectT > 1.5) this._inspectT = -1;
    }
    if (this._mantleT > 0) this._mantleT -= dt;
  }

  /** Compose the rig transform from every layer. */
  _pose(dt) {
    const player = this.ctx.player;
    const def = this.def;
    const ads = smoothstep(0, 1, this.adsFactor);

    // --- base pose: hip -> ADS, overridden by sprint ------------------------
    const sprint = player ? (player.isSprinting ? 1 : 0) : 0;
    this._sprintBlend = damp(this._sprintBlend ?? 0, sprint, 9, dt || 0.016);
    const sb = this._sprintBlend * (1 - ads);

    _v.copy(HIP_POS).lerp(this._adsPos || HIP_POS, ads);
    _v.lerp(SPRINT_POS, sb);
    // Swap: drop the weapon out of frame and bring it back.
    if (this._swapping) {
      const t = 1 - this._swapT / def.swapTime;
      const dip = Math.sin(t * Math.PI);
      _v.y -= dip * 0.26;
      _v.z += dip * 0.06;
    }
    // Reload: lower slightly and cant in.
    if (this._reloading) {
      const t = this._reloadT / this._reloadDur;
      const dip = Math.sin(clamp(t, 0, 1) * Math.PI);
      _v.y -= dip * 0.055;
      _v.x -= dip * 0.028;
    }
    if (this._mantleT > 0) _v.y -= this._mantleT * 0.4;
    this.rig.position.copy(_v);

    _euler.set(
      lerp(HIP_ROT.x, this._adsRot?.x ?? 0, ads),
      lerp(HIP_ROT.y, this._adsRot?.y ?? 0, ads),
      lerp(HIP_ROT.z, this._adsRot?.z ?? 0, ads)
    );
    _euler.x = lerp(_euler.x, SPRINT_ROT.x, sb);
    _euler.y = lerp(_euler.y, SPRINT_ROT.y, sb);
    _euler.z = lerp(_euler.z, SPRINT_ROT.z, sb);
    if (this._reloading) {
      const t = clamp(this._reloadT / this._reloadDur, 0, 1);
      _euler.z += Math.sin(t * Math.PI) * 0.30;
      _euler.x += Math.sin(t * Math.PI) * 0.12;
    }
    if (this._inspectT >= 0) {
      const t = this._inspectT / 1.5;
      _euler.y += Math.sin(t * Math.PI) * 0.9;
      _euler.z += Math.sin(t * Math.PI * 2) * 0.35;
    }
    this.rig.rotation.copy(_euler);

    // --- sway: idle drift + camera lag --------------------------------------
    const swayAmt = lerp(1, 0.22, ads);
    const t = this.time;
    this.swayNode.position.set(
      drift(t, 0.0) * 0.0035 * swayAmt + this._lagYaw * 0.09,
      drift(t, 2.1) * 0.0030 * swayAmt - this._lagPitch * 0.07,
      0
    );
    this.swayNode.rotation.set(
      drift(t, 4.3) * 0.008 * swayAmt + this._lagPitch * 0.55,
      drift(t, 6.7) * 0.010 * swayAmt + this._lagYaw * 0.65,
      drift(t, 1.7) * 0.006 * swayAmt - this._lagYaw * 0.30
    );

    // --- bob: counter to the player's, halved when aiming -------------------
    const bob = player?.viewBobOffset;
    const bobAmt = lerp(1, 0.3, ads);
    if (bob) {
      this.bobNode.position.set(-bob.x * 1.5 * bobAmt, -bob.y * 1.3 * bobAmt, 0);
      this.bobNode.rotation.z = bob.x * 2.2 * bobAmt;
      this.bobNode.rotation.x = bob.y * 1.8 * bobAmt;
    }

    // --- recoil kick --------------------------------------------------------
    this.kickNode.position.set(this._kick.x, this._kick.y, this._kick.z);
    this.kickNode.rotation.set(this._kickRot.x, this._kickRot.y, this._kickRot.z);
  }

  _emitAmmo() {
    const a = this.ammo;
    this.ctx.bus.emit('ammo:changed', {
      mag: a.mag, reserve: a.reserve, name: this.def.name,
      grenades: this._grenades, auto: this.def.auto,
    });
  }

  dispose() { disposeGunMaterials(this.mats); }
}

/**
 * Penetration cost per surface, in units of the weapon's penetration budget.
 * Anything at or above 1.0 stops a typical rifle round on the first hit.
 */
const PEN_COST = {
  wood: 0.28,
  glass: 0.10,
  metal: 0.55,
  sand: 0.75,
  dirt: 0.80,
  foliage: 0.05,
  concrete: 1.20,
  flesh: 0.40,
  water: 0.90,
};
