/**
 * Pointer-lock mouse + keyboard + gamepad input.
 * Mouse deltas accumulate between frames and are drained by consumers via
 * `readLook()` exactly once per frame (Player owns that call).
 */
export class Input {
  constructor(canvas, bus) {
    this.canvas = canvas;
    this.bus = bus;
    this.keys = new Set();
    this.pressed = new Set();   // edge-triggered, cleared at end of frame
    this.released = new Set();
    this.mouse = [false, false, false];
    this.mousePressed = [false, false, false];
    this.mouseReleased = [false, false, false];
    this.dx = 0; this.dy = 0;
    this.wheel = 0;
    this.locked = false;
    this.sensitivity = 0.0022;
    this.invertY = false;
    this.padIndex = null;
    this.pad = { lx: 0, ly: 0, rx: 0, ry: 0, lt: 0, rt: 0, buttons: [] };

    this._onKeyDown = (e) => {
      if (e.repeat) return;
      const c = e.code;
      if (!this.keys.has(c)) this.pressed.add(c);
      this.keys.add(c);
      if (c === 'Tab' || c.startsWith('Arrow') || c === 'Space' || c === 'Slash') e.preventDefault();
    };
    this._onKeyUp = (e) => { this.keys.delete(e.code); this.released.add(e.code); };
    this._onMouseDown = (e) => {
      if (!this.locked) return;
      if (e.button < 3) { if (!this.mouse[e.button]) this.mousePressed[e.button] = true; this.mouse[e.button] = true; }
    };
    this._onMouseUp = (e) => {
      if (e.button < 3) { this.mouse[e.button] = false; this.mouseReleased[e.button] = true; }
    };
    this._onMove = (e) => {
      if (!this.locked) return;
      // movementX can spike on some platforms; clamp to sane per-event range.
      const mx = Math.max(-400, Math.min(400, e.movementX || 0));
      const my = Math.max(-400, Math.min(400, e.movementY || 0));
      this.dx += mx; this.dy += my;
    };
    this._onWheel = (e) => { if (this.locked) { this.wheel += Math.sign(e.deltaY); e.preventDefault(); } };
    this._onLockChange = () => {
      this.locked = document.pointerLockElement === this.canvas;
      this.bus.emit(this.locked ? 'input:lock' : 'input:unlock', {});
      if (!this.locked) { this.keys.clear(); this.mouse = [false, false, false]; }
    };
    this._onContext = (e) => e.preventDefault();

    window.addEventListener('keydown', this._onKeyDown);
    window.addEventListener('keyup', this._onKeyUp);
    window.addEventListener('mousedown', this._onMouseDown);
    window.addEventListener('mouseup', this._onMouseUp);
    window.addEventListener('mousemove', this._onMove);
    window.addEventListener('wheel', this._onWheel, { passive: false });
    document.addEventListener('pointerlockchange', this._onLockChange);
    canvas.addEventListener('contextmenu', this._onContext);
    window.addEventListener('gamepadconnected', (e) => { this.padIndex = e.gamepad.index; });
    window.addEventListener('gamepaddisconnected', () => { this.padIndex = null; });
  }

  requestLock() {
    if (!this.locked) this.canvas.requestPointerLock?.({ unadjustedMovement: true })?.catch?.(() => this.canvas.requestPointerLock());
  }
  exitLock() { if (this.locked) document.exitPointerLock(); }

  down(code) { return this.keys.has(code); }
  hit(code) { return this.pressed.has(code); }
  up(code) { return this.released.has(code); }
  mDown(b) { return this.mouse[b]; }
  mHit(b) { return this.mousePressed[b]; }
  mUp(b) { return this.mouseReleased[b]; }

  /** Movement axes, keyboard + left stick, normalised to a unit disc. */
  axes(out) {
    let x = (this.down('KeyD') ? 1 : 0) - (this.down('KeyA') ? 1 : 0);
    let y = (this.down('KeyW') ? 1 : 0) - (this.down('KeyS') ? 1 : 0);
    x += this.pad.lx; y += -this.pad.ly;
    const l = Math.hypot(x, y);
    if (l > 1) { x /= l; y /= l; }
    out.x = x; out.y = y;
    return out;
  }

  /** Drain accumulated look delta (radians). Call once per frame. */
  readLook(out, dt) {
    const s = this.sensitivity;
    // Gamepad right stick uses a cubic response curve for fine aim.
    const cx = this.pad.rx * Math.abs(this.pad.rx) * 2.6 * dt;
    const cy = this.pad.ry * Math.abs(this.pad.ry) * 2.2 * dt;
    out.x = this.dx * s + cx;
    out.y = (this.dy * s + cy) * (this.invertY ? -1 : 1);
    this.dx = 0; this.dy = 0;
    return out;
  }

  poll() {
    if (this.padIndex === null || !navigator.getGamepads) return;
    const gp = navigator.getGamepads()[this.padIndex];
    if (!gp) return;
    const dz = (v) => (Math.abs(v) < 0.14 ? 0 : (v - Math.sign(v) * 0.14) / 0.86);
    this.pad.lx = dz(gp.axes[0] || 0); this.pad.ly = dz(gp.axes[1] || 0);
    this.pad.rx = dz(gp.axes[2] || 0); this.pad.ry = dz(gp.axes[3] || 0);
    this.pad.lt = gp.buttons[6]?.value || 0;
    this.pad.rt = gp.buttons[7]?.value || 0;
    this.pad.buttons = gp.buttons.map((b) => b.pressed);
    if (this.pad.rt > 0.5) this.mouse[0] = true; else if (this.pad.rt < 0.3) this.mouse[0] = false;
    if (this.pad.lt > 0.5) this.mouse[2] = true; else if (this.pad.lt < 0.3) this.mouse[2] = false;
  }

  /** Called by Engine at the very end of a frame. */
  endFrame() {
    this.pressed.clear();
    this.released.clear();
    this.mousePressed[0] = this.mousePressed[1] = this.mousePressed[2] = false;
    this.mouseReleased[0] = this.mouseReleased[1] = this.mouseReleased[2] = false;
    this.wheel = 0;
  }
}
