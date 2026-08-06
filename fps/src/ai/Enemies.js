import * as THREE from 'three';
import { clamp, lerp, damp, smoothstep } from '../core/Contracts.js';
import {
  v3, wrapPi, angleDelta, dampAngle, yawOf, noise1, fbm1, dist2XZ, gauss,
} from './AIMath.js';
import { Soldier } from './Soldier.js';
import { Squad } from './Squad.js';
import { findPath } from './Nav.js';

/**
 * Enemy manager: spawning, perception, the behaviour state machine, and the
 * per-frame work budget.
 *
 * Costs are time-sliced deliberately. Perception runs every third frame,
 * pathfinding is queued at two agents per frame, and animation updates thin out
 * with distance. Twelve agents fit inside ~2 ms that way; doing all of it every
 * frame for every agent does not.
 */

const MAX_ALIVE = 12;
const LOD_DIST = 45;

const _v = new THREE.Vector3();
const _v2 = new THREE.Vector3();
const _eye = new THREE.Vector3();
const _toPlayer = new THREE.Vector3();

let NEXT_ID = 1;

export class Enemies {
  constructor(ctx) {
    this.ctx = ctx;
    this.list = [];
    this.squad = new Squad();
    this.alertLevel = 0;
    this.pathQueue = [];
    this.frame = 0;
    this.difficulty = { accuracy: 0.55, reaction: 0.45, aggression: 0.5, health: 100 };
  }

  async init() {
    this.rng = this.ctx.rand(4242);
    this.ctx.bus.on('hit:enemy', (e) => this._onHit(e));
    this.ctx.bus.on('explosion', (e) => this._onExplosion(e));
    this.ctx.bus.on('weapon:fire', () => { this._gunfireAt = this.ctx.engine.time; });
  }

  get alive() { return this.list.filter((e) => !e.dead).length; }

  // -------------------------------------------------------------------------

  spawn(pos, opts = {}) {
    if (this.list.length >= MAX_ALIVE + 8) this._reap(true);
    const s = new Soldier(this.ctx, this.rng);
    s.id = NEXT_ID++;
    s.position.copy(pos);
    s.spawnAt(pos);
    s.maxHealth = s.health = opts.health ?? this.difficulty.health;
    s.accuracy = opts.accuracy ?? this.difficulty.accuracy;
    s.reaction = opts.reaction ?? this.difficulty.reaction;
    s.aggression = opts.aggression ?? this.difficulty.aggression;
    s.state = 'Patrol';
    s.awareness = 0;
    this.list.push(s);
    this.squad.add(s);
    this.ctx.bus.emit('enemy:spawn', { enemy: s });
    return s;
  }

  clearAll() {
    for (const e of this.list) e.dispose();
    this.list.length = 0;
    this.squad.clear();
  }

  // -------------------------------------------------------------------------

  update(dt, time) {
    if (dt <= 0) return;
    this.frame++;
    const player = this.ctx.player;
    if (!player) return;

    _eye.copy(player.position);

    // Perception on a third of the agents each frame.
    for (let i = this.frame % 3; i < this.list.length; i += 3) {
      this._perceive(this.list[i], dt * 3, time);
    }

    // Pathing budget: two agents per frame, from a queue.
    let paths = 0;
    while (this.pathQueue.length && paths < 2) {
      const e = this.pathQueue.shift();
      if (!e.dead) this._repath(e);
      paths++;
    }

    this.squad.update(dt, this.list, _eye);

    let maxAware = 0;
    for (const e of this.list) {
      if (e.dead) { e.updateDead(dt); continue; }
      this._think(e, dt, time);
      e.update(dt, time, _eye);
      maxAware = Math.max(maxAware, e.awareness);
    }
    this.alertLevel = damp(this.alertLevel, maxAware, 2.2, dt);

    this._reap(false);
  }

  _reap(force) {
    for (let i = this.list.length - 1; i >= 0; i--) {
      const e = this.list[i];
      if (e.dead && (force || e.deadFor > 14)) {
        e.dispose();
        this.squad.remove(e);
        this.list.splice(i, 1);
      }
    }
  }

  // -------------------------------------------------------------------------
  //  Perception
  // -------------------------------------------------------------------------

  _perceive(e, dt, time) {
    if (e.dead) return;
    const phys = this.ctx.physics;
    e.eyePosition(_v);
    _toPlayer.subVectors(_eye, _v);
    const dist = _toPlayer.length();
    e.distToPlayer = dist;

    let sees = false;
    if (dist < 55) {
      _toPlayer.multiplyScalar(1 / dist);
      // 110 degree cone.
      e.facingVector(_v2);
      if (_v2.dot(_toPlayer) > Math.cos(0.96)) {
        sees = phys?.lineOfSight ? phys.lineOfSight(_v, _eye) : true;
      }
    }
    e.canSeePlayer = sees;

    // Awareness ramps rather than snapping — the player gets a moment to react.
    const player = this.ctx.player;
    let rate = 0;
    if (sees) {
      rate = 1 / Math.max(0.12, e.reaction * (0.4 + dist / 45));
      if (player.isSprinting) rate *= 1.6;
      if (this._gunfireAt && time - this._gunfireAt < 0.6) rate *= 2.2;
      e.lastKnown.copy(_eye);
      e.lastSeenAt = time;
    } else {
      rate = -0.35;
    }
    e.awareness = clamp(e.awareness + rate * dt, 0, 1);

    // Hearing: gunfire carries much further than sight.
    if (this._gunfireAt && time - this._gunfireAt < 0.25 && dist < 70) {
      e.awareness = Math.max(e.awareness, 0.45);
      if (!sees) e.lastKnown.copy(_eye);
    }
  }

  // -------------------------------------------------------------------------
  //  Behaviour
  // -------------------------------------------------------------------------

  _think(e, dt, time) {
    e.stateTime += dt;
    const player = this.ctx.player;
    const engaged = e.awareness > 0.85;

    switch (e.state) {
      case 'Patrol':
        e.aiming = false;
        if (e.awareness > 0.25) this._enter(e, 'Investigate');
        else if (!e.path.length && e.stateTime > 2) this._wander(e);
        break;

      case 'Investigate':
        e.aiming = false;
        e.moveTarget.copy(e.lastKnown);
        if (engaged) this._enter(e, 'TakeCover');
        else if (e.awareness < 0.08) this._enter(e, 'Patrol');
        else if (!e.path.length) this.pathQueue.push(e);
        break;

      case 'TakeCover': {
        const cover = this.squad.claimCover(e, _eye, this.ctx.level?.coverPoints);
        if (cover) {
          e.coverPoint = cover;
          e.moveTarget.copy(cover.pos);
          this.pathQueue.push(e);
          this._enter(e, 'Advance');
        } else {
          this._enter(e, 'Advance');
          e.moveTarget.copy(e.lastKnown);
          this.pathQueue.push(e);
        }
        break;
      }

      case 'Advance':
        e.aiming = e.canSeePlayer;
        if (e.canSeePlayer && e.distToPlayer < 34 && this.squad.mayFire(e)) {
          this._enter(e, 'PeekAndFire');
        } else if (e.arrived && e.coverPoint) {
          this._enter(e, 'PeekAndFire');
        } else if (e.stateTime > 8) {
          this._enter(e, 'TakeCover');
        } else if (!e.path.length && !e.arrived) {
          this.pathQueue.push(e);
        }
        break;

      case 'PeekAndFire':
        e.aiming = true;
        e.crouching = !!e.coverPoint && e.coverPoint.height < 1.3;
        if (!e.canSeePlayer) {
          if (e.stateTime > 1.4) this._enter(e, 'Reposition');
        } else if (this.squad.mayFire(e)) {
          this._fire(e, dt, time);
        }
        if (e.ammo <= 0) this._enter(e, 'Reload');
        // Do not camp one spot: rotate out after a while.
        if (e.stateTime > 6 + this.rng() * 4) this._enter(e, 'Reposition');
        break;

      case 'Reload':
        e.aiming = false;
        e.crouching = true;
        if (e.stateTime > 2.4) { e.ammo = e.magSize; this._enter(e, 'PeekAndFire'); }
        break;

      case 'Reposition': {
        e.aiming = false;
        e.crouching = false;
        if (e.coverPoint) { this.squad.releaseCover(e); e.coverPoint = null; }
        this._enter(e, 'TakeCover');
        break;
      }

      case 'Suppress':
        e.aiming = true;
        if (e.stateTime > 2.5) this._enter(e, 'Advance');
        else this._fire(e, dt, time, true);
        break;
    }
  }

  _enter(e, state) {
    if (e.state === 'PeekAndFire' && state !== 'PeekAndFire') e.burstLeft = 0;
    e.state = state;
    e.stateTime = 0;
    e.arrived = false;
  }

  _wander(e) {
    const level = this.ctx.level;
    if (!level?.spawnPoints?.length) return;
    const t = level.spawnPoints[(this.rng() * level.spawnPoints.length) | 0];
    e.moveTarget.copy(t);
    this.pathQueue.push(e);
  }

  _repath(e) {
    const grid = this.ctx.level?.navGrid;
    if (!grid) { e.path = [e.moveTarget.clone()]; return; }
    e.path = findPath(grid, e.position, e.moveTarget) || [];
    e.pathIndex = 0;
    e.arrived = e.path.length === 0;
  }

  /** Burst fire with deliberate first-shot inaccuracy that tightens over time. */
  _fire(e, dt, time, suppressing) {
    if (e.fireCooldown > 0) { e.fireCooldown -= dt; return; }
    if (e.burstLeft <= 0) {
      if (e.burstPause > 0) { e.burstPause -= dt; return; }
      e.burstLeft = 3 + ((this.rng() * 3) | 0);
      e.burstPause = 0.5 + this.rng() * 0.9;
    }

    e.burstLeft--;
    e.ammo--;
    e.fireCooldown = 0.09 + this.rng() * 0.03;
    if (e.burstLeft <= 0) e.fireCooldown = e.burstPause;

    e.muzzleFlash = 0.05;
    e.eyePosition(_v);
    _v2.subVectors(_eye, _v).normalize();

    // Accuracy improves the longer they have been shooting at you.
    const engagedFor = clamp(e.stateTime / 3, 0, 1);
    const skill = e.accuracy * (0.45 + 0.55 * engagedFor);
    const cone = lerp(0.10, 0.012, skill) * (suppressing ? 2.6 : 1);
    _v2.x += gauss(this.rng) * cone;
    _v2.y += gauss(this.rng) * cone;
    _v2.z += gauss(this.rng) * cone;
    _v2.normalize();

    this.ctx.bus.emit('enemy:fire', { enemy: e, origin: _v.clone(), dir: _v2.clone() });

    // Trace it so the round actually interacts with the world.
    const phys = this.ctx.physics;
    const hit = phys?.raycast?.(_v, _v2, 90, { skipEnemies: true });
    const endPoint = hit ? hit.point : _v.clone().addScaledVector(_v2, 90);
    this.ctx.bus.emit('tracer', { from: _v.clone(), to: endPoint.clone(), speed: 560 });

    // Did it pass close enough to the player to count as a hit?
    const player = this.ctx.player;
    _v.subVectors(player.position, _v);
    const along = _v.dot(_v2);
    if (along > 0) {
      const miss = _v.clone().addScaledVector(_v2, -along).length();
      const blocked = hit && hit.distance < along;
      if (!blocked && miss < 0.42) {
        this.ctx.bus.emit('player:damage', {
          amount: 9 + this.rng() * 7,
          fromDir: _v2.clone().negate(),
          source: e,
        });
      } else if (!blocked && miss < 2.0) {
        this.ctx.bus.emit('whizz', { distance: miss });
      }
    }
  }

  // -------------------------------------------------------------------------

  _onHit(ev) {
    const e = ev.enemy;
    if (!e || e.dead) return;
    e.health -= ev.damage;
    e.awareness = 1;
    e.lastKnown.copy(this.ctx.player.position);
    e.flinch = Math.min(1, e.flinch + ev.damage * 0.02);
    if (e.health <= 0) {
      e.kill(ev.dir, ev.point);
      this.squad.releaseCover(e);
      this.ctx.bus.emit('enemy:death', {
        enemy: e, point: ev.point.clone(), dir: ev.dir.clone(), headshot: ev.headshot,
      });
    }
  }

  _onExplosion(ev) {
    const phys = this.ctx.physics;
    for (const e of this.list) {
      if (e.dead) continue;
      const d = e.position.distanceTo(ev.point);
      if (d > ev.radius) continue;
      // Line of sight gate: cover should protect you from a blast.
      e.eyePosition(_v);
      if (phys?.lineOfSight && !phys.lineOfSight(ev.point, _v)) continue;
      const falloff = 1 - d / ev.radius;
      const dmg = ev.damage * falloff * falloff;
      e.health -= dmg;
      e.awareness = 1;
      if (e.health <= 0) {
        _v2.subVectors(e.position, ev.point).normalize();
        e.kill(_v2, e.position.clone());
        this.squad.releaseCover(e);
        this.ctx.bus.emit('enemy:death', {
          enemy: e, point: e.position.clone(), dir: _v2.clone(), headshot: false,
        });
      }
    }
  }
}
