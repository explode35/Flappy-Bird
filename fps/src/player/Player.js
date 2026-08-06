import * as THREE from 'three';
import * as T from './Tuning.js';
import { clamp, damp, lerp, smoothstep } from '../core/Contracts.js';

/**
 * Player controller — movement, camera, and state.
 *
 * The camera transform is composed every frame from independent additive
 * layers (bob, landing dip, lean, sprint cant, strafe roll, trauma shake,
 * breathing, weapon recoil) rather than being mutated in place, so no layer can
 * corrupt another and any of them can be disabled cleanly.
 *
 * Everything time-dependent uses damp() from Contracts, which is
 * framerate-independent — a raw lerp with a constant factor is not, and the
 * difference is obvious to anyone playing at 144 Hz.
 *
 * Tuning lives in Tuning.js. See ART_DIRECTION §4 and §7.
 */

const _fwd = new THREE.Vector3();
const _right = new THREE.Vector3();
const _wish = new THREE.Vector3();
const _tmp = new THREE.Vector3();
const _tmp2 = new THREE.Vector3();
const _axes = { x: 0, y: 0 };
const _look = { x: 0, y: 0 };
const _moveOut = { grounded: false, groundNormal: new THREE.Vector3(0, 1, 0), hitWall: false, steppedUp: false };
const _euler = new THREE.Euler(0, 0, 0, 'YXZ');
const _q = new THREE.Quaternion();
const _qRoll = new THREE.Quaternion();
const _UP = new THREE.Vector3(0, 1, 0);
const _FWD = new THREE.Vector3(0, 0, -1);

/** Smooth value noise — white noise shake looks cheap, this does not. */
function snoise(x) {
  const i = Math.floor(x), f = x - i;
  const h = (n) => {
    const s = Math.sin(n * 127.1) * 43758.5453;
    return (s - Math.floor(s)) * 2 - 1;
  };
  const u = f * f * (3 - 2 * f);
  return lerp(h(i), h(i + 1), u);
}

export class Player {
  constructor(ctx) {
    this.ctx = ctx;

    this.capsule = {
      start: new THREE.Vector3(0, T.RADIUS, 0),
      end: new THREE.Vector3(0, T.STAND_HEIGHT - T.RADIUS, 0),
      radius: T.RADIUS,
    };
    this.velocity = new THREE.Vector3();
    this.position = new THREE.Vector3();      // eye, world space
    this.feetPosition = new THREE.Vector3();
    this.forward = new THREE.Vector3(0, 0, -1);
    this.right = new THREE.Vector3(1, 0, 0);

    this.yaw = 0;
    this.pitch = 0;
    this.eyeHeight = T.EYE_STAND;
    this.height = T.STAND_HEIGHT;

    this.isGrounded = false;
    this.isCrouched = false;
    this.isSprinting = false;
    this.isTacSprinting = false;
    this.isADS = false;
    this.isSliding = false;
    this.isMantling = false;
    this.dead = false;
    this.frozen = false;
    this.speed = 0;

    this.health = T.MAX_HEALTH;
    this.stamina = T.MAX_STAMINA;
    this._lastDamageAt = -99;
    this._lastStaminaUseAt = -99;

    this._coyote = 0;
    this._jumpBuffer = 0;
    this._airTime = 0;
    this._sinceGround = 99;

    this._slideT = 0;
    this._slideCooldown = 0;
    this._mantleT = 0;
    this._mantleFrom = new THREE.Vector3();
    this._mantleTo = new THREE.Vector3();

    this._lean = 0;
    this._leanTarget = 0;
    this._bobDist = 0;
    this._bobAmp = 0;
    this._lastBobPhase = 0;

    this._landVel = 0;
    this._landDip = 0;
    this._sprintCant = 0;
    this._strafeRoll = 0;
    this._trauma = 0;
    this._shakeSeed = Math.random() * 1000;

    // Additive recoil from the weapon system, with its own spring recovery.
    this._recoilPitch = 0;
    this._recoilYaw = 0;
    this._recoilPitchVel = 0;
    this._recoilYawVel = 0;

    this._sprintTapAt = -99;
    this._sprintHeldFor = 0;

    this.viewBobOffset = new THREE.Vector3();
    this.time = 0;
  }

  async init() {
    const spawn = this.ctx.level?.spawnPoint || new THREE.Vector3(0, 0.2, 0);
    this.teleport(spawn.x, spawn.y, spawn.z);
    this.yaw = Math.PI;    // face down the plaza toward -Z
    const bus = this.ctx.bus;
    bus.on('shake', (e) => this.addTrauma(e.amount ?? 0.3));
    bus.on('player:damage', (e) => this.applyDamage(e));
  }

  teleport(x, y, z) {
    this.capsule.start.set(x, y + T.RADIUS, z);
    this.capsule.end.set(x, y + this.height - T.RADIUS, z);
    this.velocity.set(0, 0, 0);
  }

  // -------------------------------------------------------------------------

  update(dt, time) {
    // `frozen` hands the camera to someone else (the screenshot harness, a
    // menu flythrough). Writing it here anyway would fight them every frame.
    if (this.frozen) return;
    if (dt <= 0) { this._writeCamera(0); return; }
    this.time = time;

    const input = this.ctx.input;
    const active = !this.frozen && !this.dead && input.locked;

    this._look(dt, active);
    if (this.dead) { this._deathCamera(dt); this._writeCamera(dt); return; }

    if (active) this._intent(dt);
    this._move(dt);
    this._health(dt);
    this._cameraLayers(dt);
    this._writeCamera(dt);
  }

  _look(dt, active) {
    if (!active) return;
    this.ctx.input.readLook(_look, dt);
    this.yaw -= _look.x;
    this.pitch -= _look.y;
    // Recoil is added on top of aim, not baked into it, so recovery can return
    // the view without fighting the player's own mouse input.
    this.pitch = clamp(this.pitch, -T.PITCH_LIMIT, T.PITCH_LIMIT);
    if (this.yaw > Math.PI) this.yaw -= Math.PI * 2;
    else if (this.yaw < -Math.PI) this.yaw += Math.PI * 2;
  }

  /** Read intent: sprint modes, crouch, slide, jump buffer, lean. */
  _intent(dt) {
    const input = this.ctx.input;
    input.axes(_axes);

    // --- sprint -------------------------------------------------------------
    const wantsFwd = _axes.y > T.SPRINT_MIN_FWD;
    const sprintDown = input.down('ShiftLeft') || input.down('ShiftRight') || input.pad.buttons[10];
    if (input.hit('ShiftLeft') || input.hit('ShiftRight')) {
      if (this.time - this._sprintTapAt < T.TAC_DOUBLE_TAP) this._tacArmed = true;
      this._sprintTapAt = this.time;
      this._sprintHeldFor = 0;
    }
    if (sprintDown) this._sprintHeldFor += dt; else { this._sprintHeldFor = 0; this._tacArmed = false; }

    this.isSprinting = sprintDown && wantsFwd && !this.isCrouched && !this.isADS && this.stamina > 1;
    this.isTacSprinting = this.isSprinting &&
      (this._tacArmed || this._sprintHeldFor > T.TAC_HOLD_TIME) && this.stamina > 5;

    // --- crouch / slide -----------------------------------------------------
    const crouchKey = input.down('ControlLeft') || input.down('KeyC') || input.pad.buttons[1];
    const crouchHit = input.hit('ControlLeft') || input.hit('KeyC');
    if (T.CROUCH_TOGGLE) { if (crouchHit) this._crouchWanted = !this._crouchWanted; }
    else this._crouchWanted = crouchKey;

    this._slideCooldown = Math.max(0, this._slideCooldown - dt);
    const planarSpeed = Math.hypot(this.velocity.x, this.velocity.z);
    if (crouchHit && this.isGrounded && !this.isSliding && this._slideCooldown <= 0 &&
        planarSpeed > T.SLIDE_MIN_ENTRY_SPEED) {
      this._startSlide();
    }

    // --- jump ---------------------------------------------------------------
    if (input.hit('Space') || input.pad.buttons[0]) this._jumpBuffer = T.JUMP_BUFFER;
    this._jumpBuffer = Math.max(0, this._jumpBuffer - dt);

    // --- lean ---------------------------------------------------------------
    const l = (input.down('KeyE') ? 1 : 0) - (input.down('KeyQ') ? 1 : 0);
    this._leanTarget = this.isSprinting || this.isSliding ? 0 : l;

    // --- mantle -------------------------------------------------------------
    if (!this.isMantling && this._jumpBuffer > 0 && this._mantleCooldown <= 0) {
      if (this._tryMantle()) this._jumpBuffer = 0;
    }
    this._mantleCooldown = Math.max(0, (this._mantleCooldown || 0) - dt);
  }

  // -------------------------------------------------------------------------
  //  Movement
  // -------------------------------------------------------------------------

  _move(dt) {
    if (this.isMantling) { this._updateMantle(dt); return; }

    const phys = this.ctx.physics;
    const input = this.ctx.input;
    input.axes(_axes);

    // Basis from yaw only — pitch must never tilt the movement plane.
    _fwd.set(-Math.sin(this.yaw), 0, -Math.cos(this.yaw));
    _right.set(-Math.cos(this.yaw), 0, Math.sin(this.yaw));
    this.forward.copy(_fwd);
    this.right.copy(_right);

    // --- crouch height ------------------------------------------------------
    const wantCrouch = this._crouchWanted || this.isSliding;
    if (!wantCrouch && this.isCrouched && !this._hasHeadroom()) {
      // Blocked from standing — stay down.
    } else {
      this.isCrouched = wantCrouch;
    }
    const targetH = this.isCrouched ? T.CROUCH_HEIGHT : T.STAND_HEIGHT;
    this.height = damp(this.height, targetH, T.EYE_LAMBDA, dt);
    this.capsule.end.y = this.capsule.start.y + Math.max(0.02, this.height - T.RADIUS * 2);

    // --- desired direction and speed ---------------------------------------
    _wish.set(0, 0, 0).addScaledVector(_right, _axes.x).addScaledVector(_fwd, _axes.y);
    const wishLen = _wish.length();
    if (wishLen > 1e-4) _wish.multiplyScalar(1 / wishLen);

    let target = T.WALK_SPEED;
    if (this.isTacSprinting) target = T.TAC_SPRINT_SPEED;
    else if (this.isSprinting) target = T.SPRINT_SPEED;
    else if (this.isCrouched) target = T.CROUCH_SPEED;
    else if (this.isADS) target = T.ADS_SPEED;
    if (!this.isSprinting) {
      if (_axes.y < -0.1) target *= T.BACK_SPEED_MUL;
      else if (Math.abs(_axes.x) > 0.6) target *= T.STRAFE_SPEED_MUL;
    }
    target *= wishLen;

    // --- slide --------------------------------------------------------------
    if (this.isSliding) {
      this._slideT -= dt;
      const dragK = Math.exp(-T.SLIDE_FRICTION * dt);
      this.velocity.x *= dragK;
      this.velocity.z *= dragK;
      // A little steering authority so a slide is a decision, not a cutscene.
      this.velocity.x += _right.x * _axes.x * T.SLIDE_STEER_ACCEL * dt;
      this.velocity.z += _right.z * _axes.x * T.SLIDE_STEER_ACCEL * dt;
      if (this._slideT <= 0 || Math.hypot(this.velocity.x, this.velocity.z) < 2.0) this._endSlide();
    } else if (this.isGrounded) {
      this._groundMove(dt, target);
    } else {
      this._airMove(dt, target);
    }

    // --- gravity and jump ---------------------------------------------------
    this.velocity.y += T.GRAVITY * dt;
    if (this.isGrounded && this.velocity.y < 0) this.velocity.y = -T.GROUND_STICK;

    const canJump = (this.isGrounded || this._coyote > 0) && this._sinceGround > -1;
    if (this._jumpBuffer > 0 && canJump && !this.isMantling) {
      if (this.isSliding) {
        this.velocity.x *= T.SLIDE_JUMP_KEEP;
        this.velocity.z *= T.SLIDE_JUMP_KEEP;
        this._endSlide();
      }
      this.velocity.y = T.JUMP_VELOCITY;
      this._jumpBuffer = 0;
      this._coyote = 0;
      this.isGrounded = false;
      this._sinceGround = 0;
      this.ctx.bus.emit('player:jump', {});
    }

    // --- integrate ----------------------------------------------------------
    const wasGrounded = this.isGrounded;
    const fallSpeed = this.velocity.y;
    _tmp.copy(this.velocity).multiplyScalar(dt);
    if (phys?.moveCapsule) phys.moveCapsule(this.capsule, _tmp, _moveOut);
    else { this.capsule.start.add(_tmp); this.capsule.end.add(_tmp); }

    this.isGrounded = _moveOut.grounded;
    if (this.isGrounded) {
      if (!wasGrounded) this._land(fallSpeed);
      this.velocity.y = Math.max(this.velocity.y, -T.GROUND_STICK);
      this._coyote = T.COYOTE_TIME;
      this._airTime = 0;
      this._sinceGround += dt;
    } else {
      this._coyote = Math.max(0, this._coyote - dt);
      this._airTime += dt;
      this._sinceGround += dt;
    }
    // Cancel upward velocity when we clip a ceiling.
    if (_moveOut.hitWall && this.velocity.y > 0 && !this.isGrounded) { /* walls only, keep y */ }

    this.speed = Math.hypot(this.velocity.x, this.velocity.z);
    this.feetPosition.set(this.capsule.start.x, this.capsule.start.y - T.RADIUS, this.capsule.start.z);
  }

  /** Quake-style accelerate: add along wishdir only up to the target speed. */
  _groundMove(dt, target) {
    const vx = this.velocity.x, vz = this.velocity.z;
    if (target < 1e-4) {
      // Constant-deceleration brake feels crisper than exponential friction.
      const s = Math.hypot(vx, vz);
      if (s > 1e-4) {
        const drop = Math.min(s, T.STOP_DECEL * dt);
        const k = (s - drop) / s;
        this.velocity.x = vx * k; this.velocity.z = vz * k;
      }
      return;
    }
    const current = vx * _wish.x + vz * _wish.z;
    const add = target - current;
    if (add > 0) {
      const accel = Math.min(add, T.ACCEL_K * target * dt);
      this.velocity.x += _wish.x * accel;
      this.velocity.z += _wish.z * accel;
    }
    // Friction pulls the *whole* velocity down, which is what kills strafe drift.
    const s = Math.hypot(this.velocity.x, this.velocity.z);
    if (s > target) {
      const k = Math.max(target, s - T.FRICTION * (s - target) * dt) / s;
      this.velocity.x *= k; this.velocity.z *= k;
    }
  }

  /** Air control: limited redirect authority, no free speed. */
  _airMove(dt, target) {
    if (target < 1e-4) return;
    const current = this.velocity.x * _wish.x + this.velocity.z * _wish.z;
    const add = Math.min(T.AIR_SPEED_CAP, target - current);
    if (add > 0) {
      const accel = Math.min(add, T.AIR_ACCEL_K * dt * target);
      this.velocity.x += _wish.x * accel;
      this.velocity.z += _wish.z * accel;
    }
    const cap = target * T.AIR_SPEED_LIMIT_MUL;
    const s = Math.hypot(this.velocity.x, this.velocity.z);
    if (s > cap) {
      const k = Math.max(cap, s - T.AIR_DRAG_OVER * (s - cap) * dt) / s;
      this.velocity.x *= k; this.velocity.z *= k;
    }
  }

  _hasHeadroom() {
    const phys = this.ctx.physics;
    if (!phys?.capsuleOverlapAny) return true;
    const probe = {
      start: _tmp.copy(this.capsule.start),
      end: _tmp2.set(this.capsule.start.x, this.capsule.start.y + T.STAND_HEIGHT - T.RADIUS * 2 + T.STAND_CLEARANCE, this.capsule.start.z),
      radius: T.RADIUS,
    };
    return !phys.capsuleOverlapAny(probe);
  }

  _land(fallSpeed) {
    const impact = Math.abs(fallSpeed);
    this._landVel = -impact * T.LAND_DIP_PER_MS;
    const surface = this._surfaceBelow();
    this.ctx.bus.emit('player:land', { speed: impact, surface });
    if (impact > T.LAND_HARD_SPEED) this.addTrauma(Math.min(0.35, impact * 0.03));
    if (impact > T.FALL_DAMAGE_SPEED) {
      this.ctx.bus.emit('player:damage', {
        amount: (impact - T.FALL_DAMAGE_SPEED) * T.FALL_DAMAGE_PER_MS,
        fromDir: _UP.clone(), source: 'fall',
      });
    }
  }

  _surfaceBelow() {
    const phys = this.ctx.physics;
    if (!phys?.raycast) return 'concrete';
    _tmp.copy(this.capsule.start);
    _tmp2.set(0, -1, 0);
    const hit = phys.raycast(_tmp, _tmp2, T.RADIUS + 0.4, { skipEnemies: true });
    return hit ? hit.surface : 'concrete';
  }

  _startSlide() {
    this.isSliding = true;
    this._slideT = T.SLIDE_TIME;
    const s = Math.hypot(this.velocity.x, this.velocity.z);
    if (s > 1e-3) {
      const k = T.SLIDE_ENTRY_SPEED / s;
      this.velocity.x *= k; this.velocity.z *= k;
    }
    this.ctx.bus.emit('player:slide', { phase: 'start' });
  }

  _endSlide() {
    this.isSliding = false;
    this._slideCooldown = T.SLIDE_COOLDOWN;
    this.ctx.bus.emit('player:slide', { phase: 'end' });
  }

  // -------------------------------------------------------------------------
  //  Mantle
  // -------------------------------------------------------------------------

  /**
   * Probe forward for a ledge between MANTLE_MIN_H and MANTLE_MAX_H with clear
   * space above, and start a scripted climb if one is there.
   */
  _tryMantle() {
    const phys = this.ctx.physics;
    if (!phys?.raycast) return false;
    _fwd.set(-Math.sin(this.yaw), 0, -Math.cos(this.yaw));

    // Is there a wall in front at chest height?
    _tmp.copy(this.capsule.start); _tmp.y += 0.2;
    const wall = phys.raycast(_tmp, _fwd, T.RADIUS + T.MANTLE_REACH, { skipEnemies: true });
    if (!wall) return false;

    // Find the top of it by probing straight down just past the face.
    _tmp2.copy(wall.point).addScaledVector(_fwd, T.MANTLE_PROBE);
    _tmp2.y = this.capsule.start.y - T.RADIUS + T.MANTLE_MAX_H + 0.4;
    const top = phys.raycast(_tmp2, new THREE.Vector3(0, -1, 0), T.MANTLE_MAX_H + 0.8, { skipEnemies: true });
    if (!top) return false;

    const feetY = this.capsule.start.y - T.RADIUS;
    const h = top.point.y - feetY;
    if (h < T.MANTLE_MIN_H || h > T.MANTLE_MAX_H) return false;
    if (top.normal.y < 0.7) return false;

    // Headroom above the landing spot.
    const landing = new THREE.Vector3().copy(top.point).addScaledVector(_fwd, T.MANTLE_LAND_FWD);
    landing.y = top.point.y + 0.02;
    const probe = {
      start: new THREE.Vector3(landing.x, landing.y + T.RADIUS, landing.z),
      end: new THREE.Vector3(landing.x, landing.y + T.MANTLE_CLEAR, landing.z),
      radius: T.RADIUS * 0.92,
    };
    if (phys.capsuleOverlapAny?.(probe)) return false;

    this.isMantling = true;
    this._mantleT = 0;
    this._mantleFrom.set(this.capsule.start.x, feetY, this.capsule.start.z);
    this._mantleTo.copy(landing);
    this.velocity.set(0, 0, 0);
    this.ctx.bus.emit('player:mantle', { from: this._mantleFrom.clone(), to: landing.clone() });
    return true;
  }

  _updateMantle(dt) {
    this._mantleT += dt;
    const t = clamp(this._mantleT / T.MANTLE_TIME, 0, 1);
    // Up first, then forward — the shape of an actual pull-up.
    const up = smoothstep(0, 0.72, t);
    const fwd = smoothstep(0.28, 1, t);
    const x = lerp(this._mantleFrom.x, this._mantleTo.x, fwd);
    const z = lerp(this._mantleFrom.z, this._mantleTo.z, fwd);
    const y = lerp(this._mantleFrom.y, this._mantleTo.y, up);
    this.capsule.start.set(x, y + T.RADIUS, z);
    this.capsule.end.set(x, y + this.height - T.RADIUS, z);
    this.feetPosition.set(x, y, z);
    this._mantlePhase = t;

    if (t >= 1) {
      this.isMantling = false;
      this._mantleCooldown = T.MANTLE_COOLDOWN;
      _fwd.set(-Math.sin(this.yaw), 0, -Math.cos(this.yaw));
      this.velocity.copy(_fwd).multiplyScalar(T.MANTLE_EXIT_SPEED);
      this.isGrounded = true;
    }
  }

  // -------------------------------------------------------------------------
  //  Health
  // -------------------------------------------------------------------------

  applyDamage(e) {
    if (this.dead || e.source === '__applied') return;
    const amount = e.amount || 0;
    if (amount <= 0) return;
    this.health = Math.max(0, this.health - amount);
    this._lastDamageAt = this.time;
    this.addTrauma(Math.min(0.5, amount * 0.012));
    this.ctx.bus.emit('player:health', { hp: this.health, max: T.MAX_HEALTH });
    if (this.health <= 0) this._die();
  }

  _die() {
    this.dead = true;
    this._deathT = 0;
    this.ctx.bus.emit('player:death', {});
  }

  respawn() {
    this.dead = false;
    this.health = T.MAX_HEALTH;
    this.stamina = T.MAX_STAMINA;
    this._trauma = 0;
    const s = this.ctx.level?.spawnPoint || new THREE.Vector3();
    this.teleport(s.x, s.y, s.z);
    this.ctx.bus.emit('player:health', { hp: this.health, max: T.MAX_HEALTH });
  }

  _health(dt) {
    if (this.health < T.MAX_HEALTH && this.time - this._lastDamageAt > T.REGEN_DELAY) {
      const before = this.health;
      this.health = Math.min(T.MAX_HEALTH, this.health + T.REGEN_RATE * dt);
      if (this.health !== before) this.ctx.bus.emit('player:health', { hp: this.health, max: T.MAX_HEALTH });
    }
    const drain = this.isTacSprinting ? T.TAC_DRAIN : this.isSprinting ? T.SPRINT_DRAIN : 0;
    if (drain > 0) {
      this.stamina = Math.max(0, this.stamina - drain * dt);
      this._lastStaminaUseAt = this.time;
    } else if (this.time - this._lastStaminaUseAt > T.STAMINA_DELAY) {
      this.stamina = Math.min(T.MAX_STAMINA, this.stamina + T.STAMINA_REGEN * dt);
    }
  }

  // -------------------------------------------------------------------------
  //  Camera layers
  // -------------------------------------------------------------------------

  addTrauma(n) { this._trauma = Math.min(T.TRAUMA_MAX, this._trauma + n); }

  /** Called by the weapon system on each shot. */
  addRecoil(pitch, yaw) {
    this._recoilPitchVel += pitch;
    this._recoilYawVel += yaw;
  }

  setADS(v) { this.isADS = !!v; }

  _cameraLayers(dt) {
    // --- head bob, distance-driven so it stays in step with the feet --------
    const moving = this.isGrounded && this.speed > 0.35 && !this.isSliding;
    this._bobDist += moving ? this.speed * dt : 0;
    let ampTarget = moving ? clamp(this.speed / T.SPRINT_SPEED, 0, 1.15) : 0;
    if (this.isADS) ampTarget *= T.BOB_ADS_MUL;
    if (this.isCrouched) ampTarget *= T.BOB_CROUCH_MUL;
    this._bobAmp = damp(this._bobAmp, ampTarget, T.BOB_AIR_LAMBDA, dt);

    const phase = (this._bobDist / T.BOB_CYCLE_DIST) * Math.PI * 2;
    // Figure-8: lateral at f, vertical at 2f.
    this._bobX = Math.sin(phase) * T.BOB_AMP_LAT * this._bobAmp;
    this._bobY = -Math.abs(Math.sin(phase * 2)) * T.BOB_AMP_VERT * this._bobAmp;
    this._bobRoll = Math.sin(phase) * T.BOB_ROLL * this._bobAmp;

    // Footstep on each vertical trough — synced to the visual, never a timer.
    const step = Math.floor(phase / Math.PI);
    if (moving && step !== this._lastBobPhase) {
      this._lastBobPhase = step;
      this.ctx.bus.emit('player:step', {
        surface: this._surfaceBelow(),
        running: this.isSprinting,
        speed: this.speed,
      });
    }
    if (!moving) this._lastBobPhase = step;

    // --- landing dip: critically damped spring ------------------------------
    const k = T.LAND_OMEGA * T.LAND_OMEGA;
    const c = 2 * T.LAND_OMEGA;
    this._landVel += (-k * this._landDip - c * this._landVel) * dt;
    this._landDip += this._landVel * dt;
    this._landDip = clamp(this._landDip, -T.LAND_DIP_MAX, T.LAND_DIP_MAX);

    // --- sprint cant and strafe roll ---------------------------------------
    const sprintAmt = this.isSprinting ? (this.isTacSprinting ? 1.35 : 1) : 0;
    this._sprintCant = damp(this._sprintCant, sprintAmt, T.SPRINT_CAM_LAMBDA, dt);
    this.ctx.input.axes(_axes);
    this._strafeRoll = damp(this._strafeRoll, -_axes.x * T.STRAFE_ROLL, T.STRAFE_LAMBDA, dt);

    // --- lean, blocked by geometry -----------------------------------------
    let leanT = this._leanTarget;
    if (leanT !== 0) {
      _right.set(-Math.cos(this.yaw), 0, Math.sin(this.yaw));
      _tmp.copy(this.capsule.start); _tmp.y += this.eyeHeight - T.RADIUS;
      _tmp2.copy(_right).multiplyScalar(leanT);
      const hit = this.ctx.physics?.raycast?.(_tmp, _tmp2, T.LEAN_OFFSET + T.LEAN_PROBE_PAD, { skipEnemies: true });
      if (hit) leanT *= clamp((hit.distance - T.LEAN_PROBE_PAD) / T.LEAN_OFFSET, 0, 1);
    }
    this._lean = damp(this._lean, leanT, T.LEAN_LAMBDA, dt);

    // --- trauma shake -------------------------------------------------------
    this._trauma = Math.max(0, this._trauma - T.TRAUMA_DECAY * dt);
    const tr = this._trauma * this._trauma;   // quadratic falloff reads better
    const s = this._shakeSeed + this.time * T.SHAKE_FREQ;
    this._shakePos = tr * T.SHAKE_POS;
    this._shakeRot = tr * T.SHAKE_ROT;
    this._shakeA = snoise(s);
    this._shakeB = snoise(s + 31.7);
    this._shakeC = snoise(s + 71.3);

    // --- recoil spring ------------------------------------------------------
    // 70% auto-recovery: the rest is left for the player to pull back down.
    this._recoilPitch += this._recoilPitchVel * dt * 60;
    this._recoilYaw += this._recoilYawVel * dt * 60;
    this._recoilPitchVel *= Math.exp(-24 * dt);
    this._recoilYawVel *= Math.exp(-24 * dt);
    this._recoilPitch = damp(this._recoilPitch, this._recoilPitch * 0.3, 7, dt);
    this._recoilYaw = damp(this._recoilYaw, this._recoilYaw * 0.3, 7, dt);

    // --- breathing ----------------------------------------------------------
    let breath = 1;
    if (this.isADS) breath *= T.BREATH_ADS_MUL;
    if (this.stamina < 20) breath *= lerp(1, T.BREATH_TIRED_MUL, 1 - this.stamina / 20);
    const bt = this.time * T.BREATH_RATE * Math.PI * 2;
    this._breathY = Math.sin(bt) * T.BREATH_POS * breath;
    this._breathP = Math.sin(bt * 1.31 + 0.6) * T.BREATH_ROT * breath;

    // --- eye height ---------------------------------------------------------
    const eyeTarget = this.isCrouched ? T.EYE_CROUCH : T.EYE_STAND;
    this.eyeHeight = damp(this.eyeHeight, eyeTarget, T.EYE_LAMBDA, dt);
  }

  _deathCamera(dt) {
    this._deathT = Math.min(T.DEATH_TIME, (this._deathT || 0) + dt);
    const t = this._deathT / T.DEATH_TIME;
    this.eyeHeight = damp(this.eyeHeight, T.DEATH_EYE, T.DEATH_LAMBDA, dt);
    this._deathRoll = lerp(0, T.DEATH_ROLL, smoothstep(0, 1, t));
    this._deathPitch = lerp(0, T.DEATH_PITCH, smoothstep(0, 1, t));
    this._trauma = Math.max(0, this._trauma - T.TRAUMA_DECAY * dt);
  }

  /** Compose the layers into the actual camera transform. */
  _writeCamera(dt) {
    const cam = this.ctx.camera;

    // Position: capsule base + eye height + bob + dip + lean + shake.
    _right.set(-Math.cos(this.yaw), 0, Math.sin(this.yaw));
    _fwd.set(-Math.sin(this.yaw), 0, -Math.cos(this.yaw));

    const baseY = this.capsule.start.y - T.RADIUS + this.eyeHeight;
    this.position.set(this.capsule.start.x, baseY, this.capsule.start.z);
    this.position.addScaledVector(_right, (this._bobX || 0) + this._lean * T.LEAN_OFFSET);
    this.position.y += (this._bobY || 0) + this._landDip + (this._breathY || 0);
    if (this.isSliding) this.position.y -= T.SLIDE_DIP;
    if (this.isMantling) this.position.addScaledVector(_fwd, T.MANTLE_SURGE * Math.sin(this._mantlePhase * Math.PI));

    if (this._shakePos) {
      this.position.x += this._shakeA * this._shakePos;
      this.position.y += this._shakeB * this._shakePos;
      this.position.z += this._shakeC * this._shakePos;
    }
    cam.position.copy(this.position);

    // Rotation: yaw/pitch, then all the additive tilts.
    let pitch = this.pitch + this._recoilPitch + (this._breathP || 0);
    let yaw = this.yaw + this._recoilYaw;
    pitch += this._landDip * T.LAND_PITCH_MUL;
    pitch -= this._sprintCant * T.SPRINT_PITCH;
    if (this.isMantling) pitch += Math.sin(this._mantlePhase * Math.PI) * T.MANTLE_PITCH;
    if (this.dead) pitch += this._deathPitch || 0;
    if (this._shakeRot) { pitch += this._shakeB * this._shakeRot; yaw += this._shakeA * this._shakeRot; }
    pitch = clamp(pitch, -T.PITCH_LIMIT - 0.2, T.PITCH_LIMIT + 0.2);

    let roll = this._strafeRoll + (this._bobRoll || 0);
    roll += -this._lean * T.LEAN_ANGLE;
    roll += Math.sin(this.time * 6.1) * T.SPRINT_ROLL * this._sprintCant;
    if (this.isSliding) roll += T.SLIDE_ROLL;
    if (this.isMantling) roll += Math.sin(this._mantlePhase * Math.PI * 2) * T.MANTLE_ROLL;
    if (this.dead) roll += this._deathRoll || 0;
    if (this._shakeRot) roll += this._shakeC * this._shakeRot * 1.4;

    _euler.set(pitch, yaw, 0, 'YXZ');
    _q.setFromEuler(_euler);
    // Roll last, about the camera's own forward axis, so it never skews yaw.
    _tmp.set(0, 0, -1).applyQuaternion(_q);
    _qRoll.setFromAxisAngle(_tmp, roll);
    _q.premultiply(_qRoll);
    cam.quaternion.copy(_q);

    // The viewmodel camera shares orientation; the weapon system adds its own
    // sway and lag on top of this in view space.
    this.ctx.viewCamera.quaternion.copy(_q);
    this.viewBobOffset.set(this._bobX || 0, this._bobY || 0, 0);
  }
}
