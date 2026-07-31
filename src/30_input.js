/* ============================================================================
   INPUT — keyboard (two local layouts) + gamepad, merged into a per-player
   control struct. Analog steering from sticks; digital keys ramp so keyboard
   players still get a usable steering curve rather than instant full lock.
   ========================================================================= */

const KEYMAPS = [
  { // player 1
    up: ['KeyW', 'ArrowUp'], down: ['KeyS', 'ArrowDown'],
    left: ['KeyA', 'ArrowLeft'], right: ['KeyD', 'ArrowRight'],
    drift: ['Space'], item: ['ShiftLeft', 'ShiftRight'], reset: ['KeyR'], look: ['KeyC']
  },
  { // player 2 (split-screen) — arrows + the punctuation cluster
    up: ['ArrowUp'], down: ['ArrowDown'], left: ['ArrowLeft'], right: ['ArrowRight'],
    drift: ['Slash'], item: ['Period'], reset: ['Comma'], look: ['Semicolon']
  }
];
// In split-screen P1 loses the arrow keys to P2.
const KEYMAP_SPLIT_P1 = {
  up: ['KeyW'], down: ['KeyS'], left: ['KeyA'], right: ['KeyD'],
  drift: ['Space'], item: ['ShiftLeft'], reset: ['KeyR'], look: ['KeyC']
};

const Input = {
  down: Object.create(null),
  pressed: Object.create(null),   // consumed edge-triggers
  released: Object.create(null),
  splitMode: false,
  pads: [null, null],
  anyKeyTime: 0,

  init() {
    window.addEventListener('keydown', e => {
      if (e.repeat) { e.preventDefault(); return; }
      this.down[e.code] = true;
      this.pressed[e.code] = true;
      this.anyKeyTime = performance.now();
      if (['Space', 'ArrowUp', 'ArrowDown', 'ArrowLeft', 'ArrowRight', 'Slash', 'Tab'].indexOf(e.code) >= 0) e.preventDefault();
      Audio.resume();
    });
    window.addEventListener('keyup', e => { this.down[e.code] = false; this.released[e.code] = true; });
    window.addEventListener('blur', () => { this.down = Object.create(null); });
    window.addEventListener('gamepadconnected', e => { this.pads[Math.min(1, e.gamepad.index)] = e.gamepad.index; });
    window.addEventListener('gamepaddisconnected', e => {
      for (let i = 0; i < 2; i++) if (this.pads[i] === e.gamepad.index) this.pads[i] = null;
    });
  },

  endFrame() {
    this.pressed = Object.create(null);
    this.released = Object.create(null);
  },

  keyDown(codes) { for (let i = 0; i < codes.length; i++) if (this.down[codes[i]]) return true; return false; },
  keyHit(codes) { for (let i = 0; i < codes.length; i++) if (this.pressed[codes[i]]) return true; return false; },
  hit(code) { return !!this.pressed[code]; },

  pad(playerIdx) {
    if (!navigator.getGamepads) return null;
    const list = navigator.getGamepads();
    // first pass: honour explicit connection order, else fall back to index
    let n = -1;
    for (let i = 0; i < list.length; i++) {
      if (!list[i] || !list[i].connected) continue;
      n++;
      if (n === playerIdx) return list[i];
    }
    return null;
  },

  /** Fill `out` with this player's controls. dt used for keyboard steering ramp. */
  read(playerIdx, out, dt) {
    const km = (this.splitMode && playerIdx === 0) ? KEYMAP_SPLIT_P1 : KEYMAPS[playerIdx];
    let steerTarget = 0, throttle = 0, brake = 0, drift = false, item = false, reset = false, look = false;

    if (km) {
      if (this.keyDown(km.left)) steerTarget -= 1;
      if (this.keyDown(km.right)) steerTarget += 1;
      if (this.keyDown(km.up)) throttle = 1;
      if (this.keyDown(km.down)) brake = 1;
      drift = this.keyDown(km.drift);
      item = this.keyDown(km.item);
      reset = this.keyHit(km.reset);
      look = this.keyDown(km.look);
    }

    const gp = this.pad(playerIdx);
    if (gp) {
      const ax = gp.axes[0] || 0;
      const dz = Math.abs(ax) < .14 ? 0 : (ax - sign(ax) * .14) / .86;
      if (dz) steerTarget = clamp(steerTarget + dz, -1, 1);
      const b = gp.buttons;
      const bp = i => b[i] && (b[i].pressed || b[i].value > .35);
      const bv = i => b[i] ? b[i].value : 0;
      if (bp(0) || bv(7) > .1) throttle = Math.max(throttle, Math.max(bv(7), bp(0) ? 1 : 0));
      if (bp(1) || bv(6) > .1) brake = Math.max(brake, Math.max(bv(6), bp(1) ? 1 : 0));
      if (bp(2) || bp(5)) drift = true;
      if (bp(4) || bp(3)) item = true;
      if (bp(9)) reset = true;
      if (bp(10) || bp(11)) look = true;
      if (bp(12)) throttle = 1;
      if (bp(13)) brake = 1;
      if (bp(14)) steerTarget = -1;
      if (bp(15)) steerTarget = 1;
    }

    // Keyboard steer ramp: reaching full lock takes ~0.16s, releasing ~0.09s.
    // Analog input overrides the ramp so pads stay 1:1.
    const analog = gp && Math.abs(gp.axes[0] || 0) > .14;
    if (analog) out.steer = steerTarget;
    else {
      const rate = steerTarget === 0 ? 11 : 6.4;
      out.steer = approach(out.steer, steerTarget, rate, dt);
      if (steerTarget === 0 && Math.abs(out.steer) < .02) out.steer = 0;
    }

    out.throttle = throttle;
    out.brake = brake;
    out.driftPrev = out.drift;
    out.drift = drift;
    out.driftHit = drift && !out.driftPrev;
    out.itemPrev = out.item;
    out.item = item;
    out.itemHit = item && !out.itemPrev;
    out.itemRelease = !item && out.itemPrev;
    out.reset = reset;
    out.look = look;
    return out;
  },

  newState() {
    return {
      steer: 0, throttle: 0, brake: 0, drift: false, driftPrev: false, driftHit: false,
      item: false, itemPrev: false, itemHit: false, itemRelease: false, reset: false, look: false
    };
  }
};
