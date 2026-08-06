/**
 * Squad coordination.
 *
 * Two jobs, both of which exist to make a firefight *readable* rather than
 * realistic: stop everyone claiming the same cover, and cap how many enemies
 * are allowed to shoot at the player simultaneously. Without the second rule a
 * six-man push is an unavoidable wall of damage; with it, the same six men read
 * as a squad taking turns, which is what CoD actually does.
 */

const MAX_FIRING = 2;
const FIRE_SLOT_TIME = 2.4;

export class Squad {
  constructor() {
    this.members = [];
    this.firing = [];        // { enemy, until }
    this.time = 0;
  }

  add(e) { this.members.push(e); }
  remove(e) {
    const i = this.members.indexOf(e);
    if (i >= 0) this.members.splice(i, 1);
    this.releaseCover(e);
    this.firing = this.firing.filter((f) => f.enemy !== e);
  }
  clear() { this.members.length = 0; this.firing.length = 0; }

  update(dt, list, playerPos) {
    this.time += dt;
    // Expire firing slots and drop anyone who died or lost sight.
    this.firing = this.firing.filter((f) =>
      !f.enemy.dead && f.enemy.canSeePlayer && f.until > this.time);
  }

  /** Is this enemy allowed to shoot right now? */
  mayFire(e) {
    const existing = this.firing.find((f) => f.enemy === e);
    if (existing) { existing.until = this.time + FIRE_SLOT_TIME; return true; }
    if (this.firing.length >= MAX_FIRING) return false;
    this.firing.push({ enemy: e, until: this.time + FIRE_SLOT_TIME });
    return true;
  }

  /**
   * Pick the best unclaimed cover point: one that blocks the player's line,
   * moves the squad forward, and is not already taken.
   */
  claimCover(e, playerPos, points) {
    if (!points || !points.length) return null;
    let best = null, bestScore = -Infinity;
    const myDist = e.position.distanceTo(playerPos);

    for (let i = 0; i < points.length; i++) {
      const p = points[i];
      if (p.claimedBy && p.claimedBy !== e && !p.claimedBy.dead) continue;

      const d = p.pos.distanceTo(playerPos);
      if (d < 6 || d > 42) continue;                 // not on top of them, not miles away

      // The cover normal should face the player for the point to protect.
      const dx = playerPos.x - p.pos.x, dz = playerPos.z - p.pos.z;
      const inv = 1 / Math.max(1e-3, Math.hypot(dx, dz));
      const facing = p.normal.x * dx * inv + p.normal.z * dz * inv;
      if (facing < 0.25) continue;

      const travel = e.position.distanceTo(p.pos);
      if (travel > 34) continue;

      // Prefer: protects well, advances on the player, is close to reach.
      const score = facing * 3.0
        + (myDist - d) * 0.30
        - travel * 0.16
        + (p.height > 1.3 ? 0.7 : 0.25);
      if (score > bestScore) { bestScore = score; best = p; }
    }

    if (best) {
      this.releaseCover(e);
      best.claimedBy = e;
    }
    return best;
  }

  releaseCover(e) {
    if (e.coverPoint && e.coverPoint.claimedBy === e) e.coverPoint.claimedBy = null;
    e.coverPoint = null;
  }
}
