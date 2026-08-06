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

  emit(evt, payload) {
    const a = this.map.get(evt);
    if (!a) return;
    for (let i = 0; i < a.length; i++) a[i](payload);
  }
}
