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
  countdownPhase: false,
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

    // touch overrides player one's scheme entirely when it's active
    if (Touch.enabled && playerIdx === 0) {
      out.driftPrev = out.drift;
      out.itemPrev = out.item;
      Touch.apply(out, true, this.countdownPhase);
      out.driftHit = out.drift && !out.driftPrev;
      out.itemHit = out.item && !out.itemPrev;
      out.itemRelease = !out.item && out.itemPrev;
      out.look = false;
      return out;
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

/* ============================================================================
   TOUCH — an on-screen scheme designed for two thumbs, not a keyboard with
   pictures of keys on it. Steering is a floating analog pad (the stick appears
   wherever you put your thumb and follows it), throttle is automatic while
   racing, and the countdown maps "first touch" onto the same launch-boost
   timing window the keyboard uses.
   ========================================================================= */

const Touch = {
  enabled: false,
  steer: 0, brake: false, drift: false, item: false, reset: false, touching: false,
  _id: null, _cx: 0, _cy: 0, _radius: 0,

  /** Coarse pointer + no real mouse = treat it as a touch device. */
  detect() {
    const coarse = window.matchMedia && window.matchMedia('(pointer: coarse)').matches;
    const hasTouch = ('ontouchstart' in window) || navigator.maxTouchPoints > 0;
    return !!(hasTouch && (coarse || !window.matchMedia || !window.matchMedia('(pointer: fine)').matches));
  },

  init() {
    this.layer = document.getElementById('touch');
    if (!this.layer) return;
    this.stick = document.getElementById('tstick');
    this.base = document.getElementById('tbase');
    this.knob = document.getElementById('tknob');

    // --- fixed steering pad.
    // This used to float: wherever you first touched became centre, and only
    // movement from there steered. That reads as inverted, because putting a
    // thumb on the left edge does nothing and the correcting slide toward the
    // middle is a *rightward* motion. An anchored pad means touching left of
    // centre is left, immediately, which is what a thumb expects.
    const centre = () => {
      const r = this.stick.getBoundingClientRect();
      const vmin = Math.min(window.innerWidth, window.innerHeight) / 100;
      // fall back to the window if the element hasn't been laid out yet
      const left = r.width ? r.left : 0;
      const bottom = r.height ? r.bottom : window.innerHeight;
      return { x: left + 24 * vmin, y: bottom - 24 * vmin, rad: Math.max(46, 17 * vmin) };
    };
    const place = () => {
      const c = centre();
      this._cx = c.x; this._cy = c.y; this._radius = c.rad;
      this.base.style.left = c.x + 'px'; this.base.style.top = c.y + 'px';
      if (this._id === null) { this.knob.style.left = c.x + 'px'; this.knob.style.top = c.y + 'px'; }
    };
    this._place = place;
    place();
    window.addEventListener('resize', place);

    const track = (x, y) => {
      const dx = clamp(x - this._cx, -this._radius, this._radius);
      const dy = clamp(y - this._cy, -this._radius, this._radius);
      const dz = 0.10;
      const n = dx / this._radius;
      this.steer = Math.abs(n) < dz ? 0 : (n - sign(n) * dz) / (1 - dz);
      this.knob.style.left = (this._cx + dx) + 'px';
      this.knob.style.top = (this._cy + dy) + 'px';
    };

    this.stick.addEventListener('pointerdown', e => {
      this._id = e.pointerId;
      this.stick.classList.add('held');
      this.touching = true;
      track(e.clientX, e.clientY);          // steers from the first frame
      try { this.stick.setPointerCapture(e.pointerId); } catch (err) { }
      e.preventDefault();
    });
    this.stick.addEventListener('pointermove', e => {
      if (e.pointerId !== this._id) return;
      track(e.clientX, e.clientY);
      e.preventDefault();
    });
    const end = e => {
      if (this._id !== null && e.pointerId !== this._id) return;
      this._id = null; this.steer = 0; this.touching = false;
      this.stick.classList.remove('held');
      this.knob.style.left = this._cx + 'px';
      this.knob.style.top = this._cy + 'px';
    };
    this.stick.addEventListener('pointerup', end);
    this.stick.addEventListener('pointercancel', end);

    // --- buttons
    const hold = (id, on, off) => {
      const el = document.getElementById(id);
      if (!el) return;
      el.addEventListener('pointerdown', e => {
        // set the state first: pointer capture is a nicety and it can throw,
        // and a drift button that silently does nothing is unforgivable
        on();
        el.classList.add('press');
        try { el.setPointerCapture(e.pointerId); } catch (err) { }
        e.preventDefault();
      });
      const up = e => { el.classList.remove('press'); if (off) off(); };
      el.addEventListener('pointerup', up);
      el.addEventListener('pointercancel', up);
    };
    hold('tdrift', () => { this.drift = true; this.touching = true; }, () => this.drift = false);
    hold('titem', () => this.item = true, () => this.item = false);
    hold('tbrake', () => this.brake = true, () => this.brake = false);
    hold('treset', () => this.reset = true, () => { });
  },

  show(on) {
    if (!this.layer) return;
    // unhide first: measuring the pad while display:none gives a zeroed rect
    // and parks its centre off-screen, where no touch can ever reach it
    this.layer.classList.toggle('hidden', !on);
    this.layer.classList.toggle('on', !!on);
    if (on && this._place) this._place();
    if (!on) { this.steer = 0; this.drift = false; this.item = false; this.brake = false; this.touching = false; }
  },

  /** Merge touch state into a control struct. `racing` enables auto-throttle. */
  apply(out, racing, countdown) {
    out.steer = this.steer;
    // Countdown: holding the screen is the throttle, so the same launch-boost
    // window works. During the race the throttle just stays on.
    out.throttle = countdown ? (this.touching ? 1 : 0) : (this.brake ? 0 : 1);
    out.brake = this.brake ? 1 : 0;
    out.drift = this.drift;
    out.item = this.item;
    if (this.reset) { out.reset = true; this.reset = false; }
    return out;
  }
};
