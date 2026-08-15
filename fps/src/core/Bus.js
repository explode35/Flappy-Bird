/**
 * Minimal synchronous event bus shared by every system.
 * Systems must never import each other directly — they talk through this.
 */
export class Bus {
  constructor() { this.map = new Map(); }

  on(evt, fn) {
    let a = this.map.get(evt);
    if (!a) { a = []; this.map.set(evt, a); }
    a.push(fn);
    return () => this.off(evt, fn);
  }

  off(evt, fn) {
    const a = this.map.get(evt);
    if (!a) return;
    const i = a.indexOf(fn);
    if (i >= 0) a.splice(i, 1);
  }

  /**
   * Listeners are isolated from each other.
   *
   * They were not, and it cost a lot: Audio.gunshot threw on every shot
   * (it called .connect() on a wrapper object rather than on the node inside
   * it), the exception unwound back through emit into the weapon's fire path,
   * and every system after Weapons missed that frame. What a player saw was
   * "left click does nothing" -- no sound, no tracer, no recoil, no ammo
   * coming down -- and nothing in the game said otherwise, because the throw
   * happened inside an event dispatch nobody was watching.
   *
   * A broken subsystem should degrade to a silent subsystem, not take the
   * frame down with it. The error is reported once per event name so a
   * per-frame failure cannot flood the console into uselessness.
   */
  emit(evt, payload) {
    const a = this.map.get(evt);
    if (!a) return;
    for (let i = 0; i < a.length; i++) {
      try {
        a[i](payload);
      } catch (err) {
        if (!this._reported) this._reported = new Set();
        if (!this._reported.has(evt)) {
          this._reported.add(evt);
          console.error(`[bus] listener for "${evt}" threw; further reports for this event suppressed`, err);
        }
      }
    }
  }
}
