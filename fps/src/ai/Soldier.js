import * as THREE from 'three';
import { clamp, lerp, damp, smoothstep } from '../core/Contracts.js';
import { wrapPi, angleDelta, dampAngle, yawOf } from './AIMath.js';
import { chamferBox, chamferCyl } from '../world/geom/chamfer.js';

/**
 * A procedurally-built soldier: geometry, locomotion, aiming, and a verlet
 * ragdoll for death.
 *
 * The rig is a plain Object3D hierarchy rather than a SkinnedMesh. At the
 * distances this game is played at, jointed rigid segments with overlapping
 * capsule shoulders and hips read identically to skinning, cost a fraction as
 * much, and let the ragdoll drive bone transforms directly.
 *
 * Silhouette is what actually reads at range, so the plate carrier, helmet and
 * pack are deliberately chunky.
 */

const _v = new THREE.Vector3();
const _v2 = new THREE.Vector3();
const _q = new THREE.Quaternion();
const _e = new THREE.Euler();
const _up = new THREE.Vector3(0, 1, 0);
const _fwd = new THREE.Vector3(0, 0, 1);

const WALK_SPEED = 3.0;
const RUN_SPEED = 5.2;

/** Shared geometry/material cache: 12 soldiers should not build 12 rigs. */
let SHARED = null;

function buildShared(ctx) {
  if (SHARED) return SHARED;
  const M = ctx.materials;
  const mk = (color, rough, metal = 0) => new THREE.MeshStandardMaterial({
    color, roughness: rough, metalness: metal, envMapIntensity: 0.8,
  });
  const mats = {
    fatigue: mk(0x5d5c4a, 0.94),
    carrier: mk(0x3e4238, 0.86),
    pouch:   mk(0x4a4c3e, 0.9),
    helmet:  mk(0x40453c, 0.7),
    skin:    mk(0x7a5a44, 0.75),
    boot:    mk(0x22201d, 0.6),
    glove:   mk(0x272725, 0.8),
    gun:     mk(0x25272a, 0.45, 0.9),
    strap:   mk(0x2e3029, 0.95),
  };

  const G = {
    torso:    chamferBox(0.36, 0.42, 0.22, { chamfer: 0.03, uvScale: 0.5 }),
    carrier:  chamferBox(0.40, 0.36, 0.27, { chamfer: 0.035, uvScale: 0.4 }),
    pack:     chamferBox(0.32, 0.30, 0.14, { chamfer: 0.03, uvScale: 0.4 }),
    pouch:    chamferBox(0.11, 0.10, 0.07, { chamfer: 0.015, uvScale: 0.2 }),
    hips:     chamferBox(0.32, 0.20, 0.21, { chamfer: 0.03, uvScale: 0.4 }),
    head:     chamferBox(0.17, 0.21, 0.19, { chamfer: 0.045, uvScale: 0.3 }),
    helmet:   chamferBox(0.215, 0.15, 0.235, { chamfer: 0.07, uvScale: 0.3 }),
    nvgMount: chamferBox(0.06, 0.05, 0.03, { chamfer: 0.008, uvScale: 0.1 }),
    neck:     chamferCyl(0.055, 0.06, 0.09, { origin: 'center', seg: 8, uvScale: 0.2 }),
    upperArm: chamferCyl(0.055, 0.065, 0.27, { origin: 'center', seg: 8, uvScale: 0.3 }),
    foreArm:  chamferCyl(0.045, 0.055, 0.25, { origin: 'center', seg: 8, uvScale: 0.3 }),
    hand:     chamferBox(0.075, 0.10, 0.055, { chamfer: 0.02, uvScale: 0.15 }),
    thigh:    chamferCyl(0.075, 0.085, 0.42, { origin: 'center', seg: 8, uvScale: 0.35 }),
    shin:     chamferCyl(0.055, 0.072, 0.40, { origin: 'center', seg: 8, uvScale: 0.35 }),
    boot:     chamferBox(0.11, 0.09, 0.26, { chamfer: 0.025, uvScale: 0.2 }),
    knee:     chamferBox(0.10, 0.10, 0.06, { chamfer: 0.02, uvScale: 0.1 }),
    gunBody:  chamferBox(0.06, 0.11, 0.62, { chamfer: 0.012, uvScale: 0.2 }),
    gunMag:   chamferBox(0.045, 0.19, 0.05, { chamfer: 0.01, uvScale: 0.1 }),
    gunStock: chamferBox(0.05, 0.10, 0.20, { chamfer: 0.012, uvScale: 0.1 }),
  };
  SHARED = { G, mats };
  return SHARED;
}

export class Soldier {
  constructor(ctx, rng) {
    this.ctx = ctx;
    this.rng = rng;
    const { G, mats } = buildShared(ctx);

    this.position = new THREE.Vector3();
    this.velocity = new THREE.Vector3();
    this.moveTarget = new THREE.Vector3();
    this.lastKnown = new THREE.Vector3();
    this.path = [];
    this.pathIndex = 0;
    this.arrived = false;
    this.yaw = 0;
    this.aimYaw = 0;
    this.aimPitch = 0;

    this.state = 'Patrol';
    this.stateTime = 0;
    this.awareness = 0;
    this.canSeePlayer = false;
    this.distToPlayer = 99;
    this.lastSeenAt = -99;
    this.coverPoint = null;
    this.crouching = false;
    this.aiming = false;
    this.flinch = 0;
    this.dead = false;
    this.deadFor = 0;
    this.health = 100;
    this.maxHealth = 100;
    this.ammo = 30;
    this.magSize = 30;
    this.burstLeft = 0;
    this.burstPause = 0;
    this.fireCooldown = 0;
    this.muzzleFlash = 0;
    this.gaitPhase = rng() * 6.28;

    // --- build the rig ------------------------------------------------------
    const root = new THREE.Group();
    root.name = 'soldier';
    this.root = root;

    // Per-soldier tint so a squad does not read as clones.
    const tint = new THREE.Color().setHSL(0.12 + rng() * 0.06, 0.10 + rng() * 0.08, 0.42 + rng() * 0.1);
    const M = {};
    for (const k of Object.keys(mats)) {
      M[k] = mats[k].clone();
      if (k === 'fatigue' || k === 'carrier' || k === 'pouch') M[k].color.lerp(tint, 0.35);
    }
    this.mats = M;

    const mesh = (geo, mat, parent, x, y, z) => {
      const m = new THREE.Mesh(geo, mat);
      m.castShadow = true;
      m.receiveShadow = true;
      m.position.set(x || 0, y || 0, z || 0);
      parent.add(m);
      return m;
    };
    const node = (parent, x, y, z) => {
      const n = new THREE.Group();
      n.position.set(x, y, z);
      parent.add(n);
      return n;
    };

    // Pelvis is the animation root; everything hangs off it.
    this.pelvis = node(root, 0, 0.94, 0);
    mesh(G.hips, M.fatigue, this.pelvis, 0, 0, 0);

    this.spine = node(this.pelvis, 0, 0.12, 0);
    mesh(G.torso, M.fatigue, this.spine, 0, 0.19, 0);
    mesh(G.carrier, M.carrier, this.spine, 0, 0.20, 0.01);
    mesh(G.pack, M.pouch, this.spine, 0, 0.19, -0.17);
    // Pouches across the front of the carrier — the read-at-distance detail.
    for (let i = 0; i < 3; i++) {
      mesh(G.pouch, M.pouch, this.spine, -0.12 + i * 0.12, 0.10, 0.15);
    }
    for (const sx of [-1, 1]) mesh(G.pouch, M.pouch, this.spine, sx * 0.21, 0.20, 0.0);
    // Shoulder straps
    for (const sx of [-1, 1]) {
      const s = mesh(chamferBox(0.06, 0.30, 0.05, { chamfer: 0.01, uvScale: 0.1 }), M.strap, this.spine, sx * 0.12, 0.28, 0.09);
      s.rotation.x = 0.2;
    }

    this.neck = node(this.spine, 0, 0.40, 0);
    mesh(G.neck, M.skin, this.neck, 0, 0, 0);
    this.head = node(this.neck, 0, 0.11, 0);
    mesh(G.head, M.skin, this.head, 0, 0, 0);
    mesh(G.helmet, M.helmet, this.head, 0, 0.10, -0.005);
    mesh(G.nvgMount, M.helmet, this.head, 0, 0.10, 0.10);
    // Shemagh / balaclava across the lower face
    mesh(chamferBox(0.175, 0.09, 0.195, { chamfer: 0.03, uvScale: 0.15 }), M.strap, this.head, 0, -0.05, 0.005);

    // Arms
    this.arms = {};
    for (const side of ['l', 'r']) {
      const sx = side === 'l' ? -1 : 1;
      const shoulder = node(this.spine, sx * 0.215, 0.32, 0);
      const upper = mesh(G.upperArm, M.fatigue, shoulder, 0, -0.135, 0);
      const elbow = node(shoulder, 0, -0.27, 0);
      const fore = mesh(G.foreArm, M.fatigue, elbow, 0, -0.125, 0);
      const wrist = node(elbow, 0, -0.25, 0);
      mesh(G.hand, M.glove, wrist, 0, -0.05, 0.01);
      this.arms[side] = { shoulder, elbow, wrist, upper, fore };
    }

    // Legs
    this.legs = {};
    for (const side of ['l', 'r']) {
      const sx = side === 'l' ? -1 : 1;
      const hip = node(this.pelvis, sx * 0.10, -0.10, 0);
      mesh(G.thigh, M.fatigue, hip, 0, -0.21, 0);
      const knee = node(hip, 0, -0.42, 0);
      mesh(G.knee, M.carrier, knee, 0, 0, 0.045);
      mesh(G.shin, M.fatigue, knee, 0, -0.20, 0);
      const ankle = node(knee, 0, -0.40, 0);
      mesh(G.boot, M.boot, ankle, 0, -0.045, 0.045);
      this.legs[side] = { hip, knee, ankle };
    }

    // Weapon, held in the right hand and steadied by the left.
    this.gun = node(this.arms.r.wrist, -0.02, -0.10, 0.14);
    mesh(G.gunBody, M.gun, this.gun, 0, 0, 0);
    mesh(G.gunMag, M.gun, this.gun, 0, -0.13, 0.02);
    mesh(G.gunStock, M.gun, this.gun, 0, -0.01, 0.36);
    this.muzzleNode = node(this.gun, 0, 0.02, -0.33);

    const flash = new THREE.Mesh(
      new THREE.PlaneGeometry(0.32, 0.32),
      new THREE.MeshBasicMaterial({
        color: 0xffc070, transparent: true, opacity: 0,
        blending: THREE.AdditiveBlending, depthWrite: false, toneMapped: false, fog: false,
      })
    );
    this.muzzleNode.add(flash);
    this.flashMesh = flash;

    ctx.scene.add(root);
    this._registerHitboxes();
  }

  _registerHitboxes() {
    const phys = this.ctx.physics;
    if (!phys?.registerHitbox) return;
    phys.registerHitbox(this, this.head, 'head', 2.0, 0.15);
    phys.registerHitbox(this, this.spine, 'torso', 1.0, 0.26);
    phys.registerHitbox(this, this.pelvis, 'torso', 1.0, 0.20);
    for (const s of ['l', 'r']) {
      phys.registerHitbox(this, this.arms[s].elbow, 'arm', 0.8, 0.11);
      phys.registerHitbox(this, this.legs[s].knee, 'leg', 0.8, 0.13);
    }
  }

  spawnAt(pos) {
    this.position.copy(pos);
    this.root.position.copy(pos);
    this.moveTarget.copy(pos);
    this.lastKnown.copy(pos);
  }

  eyePosition(out) {
    this.head.getWorldPosition(out);
    return out;
  }

  facingVector(out) {
    out.set(Math.sin(this.yaw), 0, Math.cos(this.yaw));
    return out;
  }

  // -------------------------------------------------------------------------
  //  Locomotion
  // -------------------------------------------------------------------------

  update(dt, time, playerEye) {
    const phys = this.ctx.physics;

    // --- follow the path ----------------------------------------------------
    let desiredSpeed = 0;
    if (this.path.length && this.pathIndex < this.path.length) {
      const wp = this.path[this.pathIndex];
      _v.subVectors(wp, this.position); _v.y = 0;
      const d = _v.length();
      if (d < 0.55) {
        this.pathIndex++;
        if (this.pathIndex >= this.path.length) { this.path.length = 0; this.arrived = true; }
      } else {
        _v.multiplyScalar(1 / d);
        desiredSpeed = this.awareness > 0.5 ? RUN_SPEED : WALK_SPEED;
        if (this.crouching) desiredSpeed *= 0.45;
        // Local avoidance: push away from squadmates who are too close.
        this._avoid(_v);
        this.velocity.x = damp(this.velocity.x, _v.x * desiredSpeed, 8, dt);
        this.velocity.z = damp(this.velocity.z, _v.z * desiredSpeed, 8, dt);
      }
    } else {
      this.velocity.x = damp(this.velocity.x, 0, 10, dt);
      this.velocity.z = damp(this.velocity.z, 0, 10, dt);
    }

    // --- move and stick to the ground --------------------------------------
    this.position.x += this.velocity.x * dt;
    this.position.z += this.velocity.z * dt;
    if (phys?.groundHeightAt) {
      const gy = phys.groundHeightAt(this.position.x, this.position.z, this.position.y + 3);
      this.position.y = damp(this.position.y, gy, 14, dt);
    }
    this.root.position.copy(this.position);

    // --- facing -------------------------------------------------------------
    const speed = Math.hypot(this.velocity.x, this.velocity.z);
    let targetYaw;
    if (this.aiming || this.awareness > 0.6) {
      _v.subVectors(playerEye, this.position);
      targetYaw = yawOf(_v.x, _v.z);
    } else if (speed > 0.3) {
      targetYaw = yawOf(this.velocity.x, this.velocity.z);
    } else {
      targetYaw = this.yaw;
    }
    this.yaw = dampAngle(this.yaw, targetYaw, 7, dt);
    this.root.rotation.y = this.yaw;

    // --- animation ----------------------------------------------------------
    // Thin out the animation rate for distant agents; nobody can see a 45 m
    // soldier's elbow interpolate.
    const far = this.distToPlayer > 45;
    if (far && (this.ctx.engine.frame & 1)) { this._flash(dt); return; }
    const adt = far ? dt * 2 : dt;

    this._animate(adt, time, speed, playerEye);
    this._flash(dt);
    this.flinch = Math.max(0, this.flinch - adt * 3);
  }

  _avoid(dir) {
    const list = this.ctx.enemies?.list;
    if (!list) return;
    for (let i = 0; i < list.length; i++) {
      const o = list[i];
      if (o === this || o.dead) continue;
      const dx = this.position.x - o.position.x;
      const dz = this.position.z - o.position.z;
      const d2 = dx * dx + dz * dz;
      if (d2 > 1.44 || d2 < 1e-4) continue;     // 1.2 m personal space
      const inv = 1 / Math.sqrt(d2);
      dir.x += dx * inv * 0.8;
      dir.z += dz * inv * 0.8;
    }
    dir.normalize();
  }

  _animate(dt, time, speed, playerEye) {
    const A = this.arms, L = this.legs;
    const run = clamp(speed / RUN_SPEED, 0, 1);
    const moving = speed > 0.25;

    // Gait phase advances with distance travelled so the feet never skate.
    if (moving) this.gaitPhase += (speed / 1.55) * dt * Math.PI * 2;
    const p = this.gaitPhase;
    const amp = run * (this.crouching ? 0.55 : 1);

    // Contralateral swing: left leg with right arm.
    const legSwing = Math.sin(p) * 0.72 * amp;
    const kneeBend = (Math.max(0, -Math.cos(p)) * 0.9 + 0.12) * amp;
    L.l.hip.rotation.x = legSwing;
    L.r.hip.rotation.x = -legSwing;
    L.l.knee.rotation.x = -(Math.max(0, Math.sin(p + 1.2)) * 1.1) * amp - 0.08;
    L.r.knee.rotation.x = -(Math.max(0, Math.sin(p + 1.2 + Math.PI)) * 1.1) * amp - 0.08;
    L.l.ankle.rotation.x = Math.sin(p + 0.6) * 0.28 * amp;
    L.r.ankle.rotation.x = Math.sin(p + 0.6 + Math.PI) * 0.28 * amp;

    // Pelvis bob and hip sway — without these the walk reads as a glide.
    const bob = -Math.abs(Math.sin(p)) * 0.055 * amp;
    const crouchDrop = this.crouching ? -0.34 : 0;
    this.pelvis.position.y = damp(this.pelvis.position.y, 0.94 + bob + crouchDrop, 14, dt);
    this.pelvis.rotation.z = Math.sin(p) * 0.06 * amp;
    this.pelvis.rotation.y = -Math.sin(p) * 0.10 * amp;
    // Torso counter-rotates against the hips.
    this.spine.rotation.y = Math.sin(p) * 0.14 * amp;
    this.spine.rotation.x = lerp(0.04, 0.26, run) + (this.crouching ? 0.22 : 0);

    // --- aim: point the weapon at the target via spine + shoulder -----------
    const aimBlend = damp(this._aimBlend ?? 0, this.aiming ? 1 : 0, 8, dt);
    this._aimBlend = aimBlend;

    _v.subVectors(playerEye, this.position);
    const horiz = Math.hypot(_v.x, _v.z);
    const wantPitch = -Math.atan2(_v.y - 1.35, Math.max(0.2, horiz));
    this.aimPitch = damp(this.aimPitch, wantPitch, 8, dt);

    if (aimBlend > 0.01) {
      // Raise both arms into a shouldered stance and lean the torso in.
      this.spine.rotation.x = lerp(this.spine.rotation.x, 0.10 + this.aimPitch * 0.35, aimBlend);
      A.r.shoulder.rotation.x = lerp(A.r.shoulder.rotation.x, -1.28 + this.aimPitch * 0.7, aimBlend);
      A.r.shoulder.rotation.z = lerp(A.r.shoulder.rotation.z, -0.30, aimBlend);
      A.r.elbow.rotation.x = lerp(A.r.elbow.rotation.x, -1.05, aimBlend);
      A.l.shoulder.rotation.x = lerp(A.l.shoulder.rotation.x, -1.35 + this.aimPitch * 0.7, aimBlend);
      A.l.shoulder.rotation.z = lerp(A.l.shoulder.rotation.z, 0.62, aimBlend);
      A.l.elbow.rotation.x = lerp(A.l.elbow.rotation.x, -1.5, aimBlend);
      this.gun.rotation.x = lerp(this.gun.rotation.x, 0.0, aimBlend);
      this.head.rotation.x = damp(this.head.rotation.x, this.aimPitch * 0.5, 8, dt);
    } else {
      // Weapon carried low, arms swinging.
      const armSwing = -Math.sin(p) * 0.55 * amp;
      A.l.shoulder.rotation.x = damp(A.l.shoulder.rotation.x, -0.62 + armSwing, 9, dt);
      A.r.shoulder.rotation.x = damp(A.r.shoulder.rotation.x, -0.72 - armSwing * 0.4, 9, dt);
      A.l.shoulder.rotation.z = damp(A.l.shoulder.rotation.z, 0.42, 9, dt);
      A.r.shoulder.rotation.z = damp(A.r.shoulder.rotation.z, -0.24, 9, dt);
      A.l.elbow.rotation.x = damp(A.l.elbow.rotation.x, -1.15, 9, dt);
      A.r.elbow.rotation.x = damp(A.r.elbow.rotation.x, -0.95, 9, dt);
      this.head.rotation.x = damp(this.head.rotation.x, 0, 6, dt);
    }

    // --- flinch --------------------------------------------------------------
    if (this.flinch > 0.01) {
      const f = this.flinch;
      this.spine.rotation.x -= f * 0.30;
      this.spine.rotation.z = Math.sin(time * 40) * f * 0.12;
      this.head.rotation.z = Math.sin(time * 33) * f * 0.2;
    }

    // Idle breathing when still.
    if (!moving) {
      const b = Math.sin(time * 1.4 + this.gaitPhase) * 0.012;
      this.spine.position.y = b;
    }
  }

  _flash(dt) {
    if (this.muzzleFlash > 0) {
      this.muzzleFlash -= dt;
      const k = clamp(this.muzzleFlash / 0.05, 0, 1);
      this.flashMesh.material.opacity = k;
      this.flashMesh.scale.setScalar(0.7 + Math.random() * 0.5);
      this.flashMesh.rotation.z = Math.random() * 6.28;
      this.flashMesh.visible = true;
    } else if (this.flashMesh.visible) {
      this.flashMesh.visible = false;
    }
  }

  // -------------------------------------------------------------------------
  //  Death and ragdoll
  // -------------------------------------------------------------------------

  /**
   * Verlet ragdoll. Points are the joint world positions; distance constraints
   * hold the skeleton together and a floor plane stops it sinking. Around 100
   * lines, and it beats a canned death animation comprehensively.
   */
  kill(dir, point) {
    if (this.dead) return;
    this.dead = true;
    this.deadFor = 0;
    this.ctx.physics?.unregisterEnemy?.(this);

    const joints = [
      ['pelvis', this.pelvis], ['spine', this.spine], ['head', this.head],
      ['lsh', this.arms.l.shoulder], ['lel', this.arms.l.elbow], ['lwr', this.arms.l.wrist],
      ['rsh', this.arms.r.shoulder], ['rel', this.arms.r.elbow], ['rwr', this.arms.r.wrist],
      ['lhp', this.legs.l.hip], ['lkn', this.legs.l.knee], ['lan', this.legs.l.ankle],
      ['rhp', this.legs.r.hip], ['rkn', this.legs.r.knee], ['ran', this.legs.r.ankle],
    ];
    this.rag = { pts: [], links: [], map: {} };
    for (const [name, obj] of joints) {
      const pos = new THREE.Vector3();
      obj.getWorldPosition(pos);
      const impulse = dir.clone().multiplyScalar(0.035 + Math.random() * 0.02);
      impulse.y += 0.012;
      const pt = { pos, prev: pos.clone().sub(impulse), obj, name };
      this.rag.map[name] = pt;
      this.rag.pts.push(pt);
    }
    const link = (a, b, stiff = 1) => {
      const pa = this.rag.map[a], pb = this.rag.map[b];
      this.rag.links.push({ a: pa, b: pb, len: pa.pos.distanceTo(pb.pos), stiff });
    };
    link('pelvis', 'spine'); link('spine', 'head');
    link('spine', 'lsh'); link('lsh', 'lel'); link('lel', 'lwr');
    link('spine', 'rsh'); link('rsh', 'rel'); link('rel', 'rwr');
    link('pelvis', 'lhp'); link('lhp', 'lkn'); link('lkn', 'lan');
    link('pelvis', 'rhp'); link('rhp', 'rkn'); link('rkn', 'ran');
    // Cross-braces stop the torso folding in half.
    link('pelvis', 'head', 0.4); link('lsh', 'rsh', 0.8);
    link('lhp', 'rhp', 0.8); link('lsh', 'rhp', 0.3); link('rsh', 'lhp', 0.3);

    // Detach the visual hierarchy: from here the ragdoll drives world positions.
    this.root.rotation.set(0, 0, 0);
    this._ragGroundY = this.position.y;
  }

  updateDead(dt) {
    this.deadFor += dt;
    if (!this.rag) return;
    if (this.deadFor > 6) return;    // settled; stop simulating

    const steps = 2;
    const h = dt / steps;
    const phys = this.ctx.physics;
    for (let s = 0; s < steps; s++) {
      // Verlet integrate
      for (const p of this.rag.pts) {
        const vx = (p.pos.x - p.prev.x) * 0.985;
        const vy = (p.pos.y - p.prev.y) * 0.985;
        const vz = (p.pos.z - p.prev.z) * 0.985;
        p.prev.copy(p.pos);
        p.pos.x += vx; p.pos.z += vz;
        p.pos.y += vy - 9.8 * h * h * 60;
      }
      // Satisfy constraints
      for (let it = 0; it < 3; it++) {
        for (const l of this.rag.links) {
          _v.subVectors(l.b.pos, l.a.pos);
          const d = _v.length();
          if (d < 1e-6) continue;
          const diff = ((d - l.len) / d) * 0.5 * l.stiff;
          _v.multiplyScalar(diff);
          l.a.pos.add(_v);
          l.b.pos.sub(_v);
        }
        // Floor
        for (const p of this.rag.pts) {
          const gy = phys?.groundHeightAt
            ? phys.groundHeightAt(p.pos.x, p.pos.z, p.pos.y + 2)
            : this._ragGroundY;
          const min = gy + 0.09;
          if (p.pos.y < min) {
            p.pos.y = min;
            // Ground friction on the tangential component.
            p.prev.x += (p.pos.x - p.prev.x) * 0.4;
            p.prev.z += (p.pos.z - p.prev.z) * 0.4;
          }
        }
      }
    }

    // Push the simulated positions back onto the rig.
    for (const p of this.rag.pts) {
      p.obj.parent.worldToLocal(_v.copy(p.pos));
      p.obj.position.lerp(_v, 0.6);
    }
    // Aim each segment down its chain so limbs point where the joints went.
    this._orient('spine', 'head', this.neck);
    this._orient('lsh', 'lel', this.arms.l.shoulder);
    this._orient('rsh', 'rel', this.arms.r.shoulder);
    this._orient('lhp', 'lkn', this.legs.l.hip);
    this._orient('rhp', 'rkn', this.legs.r.hip);
  }

  _orient(aName, bName, obj) {
    const a = this.rag.map[aName], b = this.rag.map[bName];
    if (!a || !b) return;
    _v.subVectors(b.pos, a.pos).normalize();
    obj.parent.getWorldQuaternion(_q).invert();
    _v.applyQuaternion(_q);
    _q.setFromUnitVectors(_v2.set(0, -1, 0), _v);
    obj.quaternion.slerp(_q, 0.4);
  }

  dispose() {
    this.ctx.physics?.unregisterEnemy?.(this);
    this.root.removeFromParent();
    for (const k of Object.keys(this.mats)) this.mats[k].dispose();
  }
}
