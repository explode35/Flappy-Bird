import * as THREE from 'three';
import { chamferBox } from '../world/geom/chamfer.js';

/**
 * ============================================================================
 *  Pickups.js — ammo and health you can walk over.
 * ============================================================================
 *  There was nothing to collect anywhere in this game: three weapons handed
 *  out at spawn, fixed reserves, and no way to get health back except standing
 *  still long enough for regeneration. A wave shooter with no attrition to
 *  manage has no reason to move you around its map.
 *
 *  Cheap by construction: two InstancedMeshes for the crates, a handful of
 *  emissive markers, and a squared-distance test against the player once a
 *  frame over a couple of dozen items. No physics, no raycasts.
 * ============================================================================
 */

const AMMO_COLOR = 0xc4763a;
const HEALTH_COLOR = 0x3ea06b;

const RADIUS = 1.25;          // how close you have to be, metres
const RESPAWN = 26;           // seconds before a taken crate comes back
const HEALTH_GIVES = 45;
const AMMO_FRACTION = 0.4;    // of each weapon's full reserve

export class Pickups {
  constructor(ctx) {
    this.ctx = ctx;
    this.items = [];
    this.alwaysUpdate = false;
    this._t = 0;
  }

  async init() {
    const level = this.ctx.level;
    const pts = level?.coverPoints || [];
    if (!pts.length) return;

    // Spread them over the map rather than clustering wherever cover happens
    // to be dense: walk the cover list and keep a point only if it is a decent
    // distance from everything already kept.
    const rng = this.ctx.rand(70141);
    const chosen = [];
    const MIN_GAP = 11;
    for (let i = 0; i < pts.length && chosen.length < 14; i++) {
      const p = pts[(i * 7919) % pts.length].pos;
      if (Math.abs(p.x) > 42 || Math.abs(p.z) > 40) continue;
      let ok = true;
      for (const c of chosen) {
        if (c.distanceToSquared(p) < MIN_GAP * MIN_GAP) { ok = false; break; }
      }
      if (ok) chosen.push(p.clone());
    }

    const group = new THREE.Group();
    group.name = 'pickups';
    this.group = group;
    this.ctx.scene.add(group);

    for (let i = 0; i < chosen.length; i++) {
      // Roughly two ammo crates for every medkit: you burn bullets faster than
      // you burn health.
      const kind = i % 3 === 2 ? 'health' : 'ammo';
      const mesh = this._buildCrate(kind, rng);
      mesh.position.copy(chosen[i]);
      mesh.position.y += 0.34;
      mesh.rotation.y = rng() * Math.PI * 2;
      group.add(mesh);
      this.items.push({ kind, mesh, home: mesh.position.clone(), taken: 0, phase: rng() * 6.28 });
    }
    console.log(`[pickups] ${this.items.length} placed`);
  }

  /** A small crate with a lit band around it, so it reads at distance. */
  _buildCrate(kind, rng) {
    const g = new THREE.Group();
    const mats = this.ctx.materials;
    const body = new THREE.Mesh(
      chamferBox(0.46, 0.34, 0.34, { uvScale: 0.5, chamfer: 0.02 }),
      mats.get(kind === 'ammo' ? 'crate' : 'polymer')
    );
    body.castShadow = true;
    body.receiveShadow = true;
    g.add(body);

    // The lit band is what you actually see from across the plaza. Basic
    // material, overbright, so bloom picks it up and it survives the dusk.
    const c = new THREE.Color(kind === 'ammo' ? AMMO_COLOR : HEALTH_COLOR).multiplyScalar(2.4);
    const band = new THREE.Mesh(
      chamferBox(0.48, 0.075, 0.36, { uvScale: 0.4, chamfer: 0.012 }),
      new THREE.MeshBasicMaterial({ color: c, toneMapped: true, fog: true })
    );
    band.position.y = 0.055;
    g.add(band);

    // A cross on the medkits, a stripe on the ammo, so colour is not the only
    // thing telling them apart.
    const markMat = new THREE.MeshBasicMaterial({ color: c, toneMapped: true, fog: true });
    if (kind === 'health') {
      const a = new THREE.Mesh(chamferBox(0.2, 0.05, 0.012, { uvScale: 0.2, chamfer: 0.004 }), markMat);
      const b = new THREE.Mesh(chamferBox(0.05, 0.2, 0.012, { uvScale: 0.2, chamfer: 0.004 }), markMat);
      a.position.set(0, 0.02, 0.176); b.position.set(0, 0.02, 0.176);
      g.add(a, b);
    } else {
      for (let i = -1; i <= 1; i++) {
        const s = new THREE.Mesh(chamferBox(0.045, 0.17, 0.012, { uvScale: 0.2, chamfer: 0.004 }), markMat);
        s.position.set(i * 0.09, 0.02, 0.176);
        g.add(s);
      }
    }
    return g;
  }

  update(dt) {
    if (dt <= 0 || !this.items.length) return;
    this._t += dt;
    const p = this.ctx.player;
    if (!p || p.dead) return;
    const px = p.capsule.start.x, py = p.capsule.start.y, pz = p.capsule.start.z;

    for (const it of this.items) {
      if (it.taken > 0) {
        it.taken -= dt;
        if (it.taken <= 0) {
          it.mesh.visible = true;
          this.ctx.bus.emit('pickup:respawn', { kind: it.kind });
        }
        continue;
      }
      // Idle motion: a slow spin and a shallow bob, which is what makes a
      // static box read as something you are meant to pick up.
      it.mesh.rotation.y += dt * 0.7;
      it.mesh.position.y = it.home.y + Math.sin(this._t * 1.6 + it.phase) * 0.06;

      const dx = it.mesh.position.x - px;
      const dy = it.mesh.position.y - py;
      const dz = it.mesh.position.z - pz;
      if (dx * dx + dy * dy + dz * dz > RADIUS * RADIUS) continue;
      if (!this._collect(it)) continue;

      it.mesh.visible = false;
      it.taken = RESPAWN;
    }
  }

  /** @returns {boolean} false if the player has no use for it right now. */
  _collect(it) {
    const bus = this.ctx.bus;
    if (it.kind === 'health') {
      const p = this.ctx.player;
      if (p.health >= p.maxHealth - 0.5) return false;   // leave it for later
      p.heal?.(HEALTH_GIVES);
      bus.emit('score', { label: `+${HEALTH_GIVES} HEALTH` });
      bus.emit('pickup', { kind: 'health' });
      return true;
    }
    const w = this.ctx.weapons;
    if (!w?.addReserve) return false;
    const added = w.addReserve(AMMO_FRACTION);
    if (!added) return false;                            // already full
    bus.emit('score', { label: 'AMMO' });
    bus.emit('pickup', { kind: 'ammo' });
    return true;
  }

  dispose() {
    if (this.group) this.ctx.scene.remove(this.group);
    this.items.length = 0;
  }
}
