import * as THREE from 'three';
import { clamp, lerp } from '../core/Contracts.js';

/**
 * Game director: waves, pacing, scoring, and the start/death/restart flow.
 *
 * Pacing follows a calm → build → peak → relief curve. The relief beat matters
 * as much as the peak: dropping the next wave the instant the last man dies
 * gives the player nowhere to breathe, and the fight stops reading as a series
 * of engagements.
 */

const _v = new THREE.Vector3();
const _frustum = new THREE.Frustum();
const _mat = new THREE.Matrix4();

const WAVES = [
  { count: 3,  concurrent: 3, accuracy: 0.34, reaction: 0.75, health: 100, label: 'CONTACT' },
  { count: 5,  concurrent: 4, accuracy: 0.40, reaction: 0.62, health: 100, label: 'PUSHING UP' },
  { count: 7,  concurrent: 5, accuracy: 0.46, reaction: 0.55, health: 110, label: 'SQUAD INBOUND' },
  { count: 9,  concurrent: 6, accuracy: 0.52, reaction: 0.48, health: 115, label: 'HEAVY RESISTANCE' },
  { count: 11, concurrent: 7, accuracy: 0.58, reaction: 0.42, health: 125, label: 'THEY HAVE THE STREET' },
  { count: 14, concurrent: 8, accuracy: 0.64, reaction: 0.36, health: 135, label: 'OVERRUN' },
];

export class Director {
  constructor(ctx) {
    this.ctx = ctx;
    this.state = 'boot';        // boot | intermission | fighting | dead | over
    this.wave = 0;
    this.toSpawn = 0;
    this.spawnTimer = 0;
    this.stateTimer = 0;
    this.score = 0;
    this.kills = 0;
    this.headshots = 0;
    this.shots = 0;
    this.hits = 0;
    this.streak = 0;
    this.bestStreak = 0;
    this.alwaysUpdate = true;   // the director keeps running while paused
  }

  async init() {
    const bus = this.ctx.bus;
    bus.on('weapon:fire', () => { this.shots++; });
    bus.on('hit:enemy', () => { this.hits++; });
    bus.on('enemy:death', (e) => this._onKill(e));
    bus.on('player:death', () => this._onPlayerDeath());
    this.rng = this.ctx.rand(90210);
  }

  // -------------------------------------------------------------------------

  update(dt, time) {
    if (dt <= 0) return;
    this.stateTimer += dt;

    switch (this.state) {
      case 'boot':
        // Wait for materials and the level, then hand control to the player.
        if ((this.ctx.level?.progress ?? 0) >= 1) {
          this.state = 'intermission';
          this.stateTimer = 0;
          this.wave = 0;
          this.ctx.bus.emit('game:start', {});
          this.ctx.bus.emit('banner', {
            kicker: 'OPERATION BLACKOUT', title: 'HARBOUR',
            sub: 'CLICK TO TAKE CONTROL',
          });
          this.ctx.bus.emit('objective', { text: 'HOLD THE HARBOUR DISTRICT' });
        }
        break;

      case 'intermission': {
        const wait = this.wave === 0 ? 4.5 : 7.5;
        const left = wait - this.stateTimer;
        if (left <= 0) this._startWave();
        else if (Math.ceil(left) !== this._lastCount) {
          this._lastCount = Math.ceil(left);
          if (left < 4) {
            this.ctx.bus.emit('objective', { text: `NEXT WAVE IN ${this._lastCount}` });
          }
        }
        break;
      }

      case 'fighting': {
        const enemies = this.ctx.enemies;
        if (!enemies) break;
        const cfg = this._cfg();

        // Trickle spawns in so the wave arrives as pressure, not a wall.
        this.spawnTimer -= dt;
        if (this.toSpawn > 0 && this.spawnTimer <= 0 && enemies.alive < cfg.concurrent) {
          this._spawnOne(cfg);
          this.spawnTimer = lerp(2.2, 0.8, this.wave / WAVES.length);
        }

        if (this.toSpawn <= 0 && enemies.alive === 0) {
          this.wave++;
          this.state = 'intermission';
          this.stateTimer = 0;
          this._lastCount = -1;
          this._resupply();
          this.ctx.bus.emit('banner', {
            kicker: `WAVE ${this.wave} CLEARED`,
            title: `${this.kills} KILLS`,
            sub: 'RESUPPLIED — HOLD POSITION',
          });
        }
        break;
      }

      case 'dead':
        this.ctx.hud?.setRespawn?.(Math.max(0, 5 - this.stateTimer), 5);
        if (this.stateTimer > 5) this._respawn();
        break;
    }
  }

  _cfg() { return WAVES[Math.min(this.wave, WAVES.length - 1)]; }

  _startWave() {
    const cfg = this._cfg();
    this.state = 'fighting';
    this.stateTimer = 0;
    this.toSpawn = cfg.count;
    this.spawnTimer = 0;
    if (this.ctx.enemies) {
      this.ctx.enemies.difficulty = {
        accuracy: cfg.accuracy, reaction: cfg.reaction,
        aggression: 0.4 + this.wave * 0.08, health: cfg.health,
      };
    }
    this.ctx.bus.emit('banner', {
      kicker: `WAVE ${this.wave + 1}`, title: cfg.label,
      sub: `${cfg.count} HOSTILES`,
    });
    this.ctx.bus.emit('objective', { text: `ELIMINATE ${cfg.count} HOSTILES` });
  }

  /** Spawn out of the player's view where possible — nobody likes a popper. */
  _spawnOne(cfg) {
    const level = this.ctx.level;
    const pts = level?.spawnPoints;
    if (!pts || !pts.length) return;

    const cam = this.ctx.camera;
    _mat.multiplyMatrices(cam.projectionMatrix, cam.matrixWorldInverse);
    _frustum.setFromProjectionMatrix(_mat);

    let best = null, bestScore = -Infinity;
    for (let i = 0; i < 14; i++) {
      const p = pts[(this.rng() * pts.length) | 0];
      const d = p.distanceTo(cam.position);
      if (d < 14) continue;
      _v.copy(p); _v.y += 1.0;
      const visible = _frustum.containsPoint(_v);
      // Prefer: out of view, and a sensible engagement distance away.
      const score = (visible ? -60 : 0) - Math.abs(d - 30) + this.rng() * 6;
      if (score > bestScore) { bestScore = score; best = p; }
    }
    if (!best) best = pts[(this.rng() * pts.length) | 0];

    this.ctx.enemies.spawn(best, {
      accuracy: cfg.accuracy, reaction: cfg.reaction, health: cfg.health,
    });
    this.toSpawn--;
  }

  _resupply() {
    const w = this.ctx.weapons;
    if (!w) return;
    for (const id of w.slots) {
      const d = w.state[id];
      const def = w.current && w.slots.includes(id) ? null : null;
      d.reserve = Math.max(d.reserve, 150);
    }
    w._grenades = 3;
    w._emitAmmo?.();
  }

  _onKill(e) {
    this.kills++;
    this.streak++;
    this.bestStreak = Math.max(this.bestStreak, this.streak);
    this.score += e.headshot ? 150 : 100;
    if (e.headshot) this.headshots++;
    // Streak callouts, sparingly — they should feel earned.
    if (this.streak === 5 || this.streak === 10 || this.streak === 20) {
      this.ctx.bus.emit('banner', {
        kicker: 'STREAK', title: `${this.streak} KILLS`, sub: '',
      });
    }
  }

  _onPlayerDeath() {
    this.state = 'dead';
    this.stateTimer = 0;
    this.streak = 0;
    const acc = this.shots ? Math.round((this.hits / this.shots) * 100) : 0;
    if (this.ctx.hud) {
      this.ctx.hud.deathS.textContent =
        `WAVE ${this.wave + 1}   ${this.kills} KILLS   ${this.headshots} HS   ${acc}% ACC`;
    }
  }

  _respawn() {
    this.ctx.player?.respawn?.();
    this.ctx.enemies?.clearAll?.();
    this.state = 'intermission';
    this.stateTimer = 0;
    this.toSpawn = 0;
    // Losing a wave costs you that wave, not the whole run.
    this.wave = Math.max(0, this.wave - 1);
    this.ctx.hud?.death?.classList.remove('on');
    this.ctx.hud?.death?.classList.add('hidden');
    this.ctx.bus.emit('game:start', {});
  }

  get accuracy() { return this.shots ? this.hits / this.shots : 0; }

  /** Used by the screenshot harness to populate a combat frame. */
  debugSpawnWave(n) {
    const cfg = this._cfg();
    for (let i = 0; i < n; i++) this._spawnOne(cfg);
  }
}
