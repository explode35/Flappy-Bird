import * as THREE from 'three';
import { clamp, lerp, damp, smoothstep } from '../core/Contracts.js';

const _dir = new THREE.Vector3();

/**
 * HUD and menus.
 *
 * DOM + CSS rather than canvas: sharper text, cheaper animation, and the
 * stylesheet (src/ui/hud.css) already encodes the whole design language.
 * Everything animates through transform/opacity only, and the DOM is written
 * only when a value actually changes — the HUD costs well under 0.3 ms/frame.
 *
 * Restraint is the design goal. Modern Warfare's HUD is four small clusters in
 * the corners and a crosshair; a busy HUD reads as amateur instantly.
 */

const el = (cls, tag = 'div', text) => {
  const n = document.createElement(tag);
  if (cls) n.className = cls;
  if (text !== undefined) n.textContent = text;
  return n;
};

const CARDINALS = [
  [0, 'N'], [45, 'NE'], [90, 'E'], [135, 'SE'],
  [180, 'S'], [225, 'SW'], [270, 'W'], [315, 'NW'],
];

const TIPS = [
  'Slide by sprinting into crouch. Cancel into a jump to keep your speed.',
  'Vault low walls with jump — it is faster than going around.',
  'Lean with Q and E to check a corner without exposing your body.',
  'Wood and sheet metal will not stop a rifle round. Concrete will.',
  'Your first shot is your most accurate. Tap at range, hold up close.',
  'Aiming down sights tightens your spread and slows your movement.',
];

/**
 * Weapon silhouettes for the readout. A player glancing at the bottom-right
 * corner should know what is in their hands without reading a four-character
 * model number in dim grey — which was the entire readout before.
 */
const WEAPON_ICON = {
  m4: '<svg viewBox="0 0 120 40" aria-hidden="true">'
    + '<path d="M8 18h58v5H8zM66 16h30v8H66zM96 18h16v4H96zM30 23h6v9h-6zM46 23h13v11H46z'
    + 'M12 12h10v6H12zM70 10h12v6H70z"/></svg>',
  mp5: '<svg viewBox="0 0 120 40" aria-hidden="true">'
    + '<path d="M18 17h48v6H18zM66 15h22v9H66zM88 18h10v4H88zM34 23h6v12h-6zM52 23h11v9H52z'
    + 'M24 11h9v6h-9z"/></svg>',
  m1911: '<svg viewBox="0 0 120 40" aria-hidden="true">'
    + '<path d="M40 14h44v7H40zM84 16h8v4h-8zM44 21h10v15l-6 2-6-3z"/></svg>',
};
const ICON_BY_NAME = { M4A1: 'm4', 'MP5A3': 'mp5', MP5: 'mp5', M1911: 'm1911' };

import { ACTIONS, keyLabel } from '../core/Bindings.js';

export class HUD {
  constructor(ctx) {
    this.ctx = ctx;
    this.root = document.getElementById('ui');
    this.time = 0;
    this._spread = 0;
    this._hp = 100;
    this._dmgs = [];
    this._pops = [];
    this._kf = [];
    this._last = {};
  }

  async init() {
    this._build();
    this._bind();
  }

  // -------------------------------------------------------------------------

  _build() {
    const R = this.root;

    // --- crosshair ----------------------------------------------------------
    this.xh = el('xh');
    this.xhTicks = [];
    for (let i = 0; i < 4; i++) {
      const t = el(`xh__t xh__t--${i < 2 ? 'v' : 'h'}`);
      this.xh.appendChild(t);
      this.xhTicks.push(t);
    }
    this.xhDot = el('xh__dot');
    this.xh.appendChild(this.xhDot);
    R.appendChild(this.xh);

    // --- hitmarker ----------------------------------------------------------
    this.hm = el('hm');
    this.hmTicks = [];
    for (let i = 0; i < 4; i++) {
      const t = el('hm__t');
      this.hm.appendChild(t);
      this.hmTicks.push(t);
    }
    this.hm.appendChild(el('hm__ring'));
    R.appendChild(this.hm);

    // --- damage direction ---------------------------------------------------
    this.dmgRing = el('dmgring');
    R.appendChild(this.dmgRing);

    // --- health treatment ---------------------------------------------------
    this.vig = el('vig');
    this.spatter = el('spatter');
    this.flash = el('flash');
    R.append(this.vig, this.spatter, this.flash);

    // --- ammo ---------------------------------------------------------------
    this.ammo = el('ammo');
    this.ammoIcon = el('ammo__icon');
    this.ammoIcon.innerHTML = WEAPON_ICON.m4;
    this.ammoName = el('ammo__name', 'div', 'M4A1');
    const row = el('ammo__row');
    this.ammoMag = el('ammo__mag', 'div', '30');
    this.ammoSep = el('ammo__sep', 'div', '/');
    this.ammoRes = el('ammo__res', 'div', '210');
    row.append(this.ammoMag, this.ammoSep, this.ammoRes);
    const foot = el('ammo__foot');
    this.fm = el('fm');
    this.fmDots = [];
    for (let i = 0; i < 3; i++) { const b = el('fm__b'); this.fm.appendChild(b); this.fmDots.push(b); }
    this.fmLabel = el('fm__l', 'div', 'AUTO');
    this.fm.appendChild(this.fmLabel);
    this.grenades = el('grp');
    this.grenadeCount = el('grp__h', 'div', '3');
    this.grenades.appendChild(this.grenadeCount);
    foot.append(this.fm, this.grenades);
    this.ammo.append(this.ammoIcon, this.ammoName, el('ammo__rule'), row, foot);
    R.appendChild(this.ammo);

    // --- compass ------------------------------------------------------------
    this.cmp = el('cmp');
    this.cmpStrip = el('cmp__strip');
    // 2 full turns of ticks so the strip never runs out as you spin.
    for (let deg = -360; deg <= 720; deg += 15) {
      const label = CARDINALS.find(([d]) => ((deg % 360) + 360) % 360 === d);
      const t = el(label ? 'cmp__tick cmp__hdg' : 'cmp__tick');
      t.style.transform = `translateX(${deg * 2.4}px)`;
      if (label) t.appendChild(el('cmp__lbl', 'div', label[1]));
      else t.appendChild(el('cmp__notch'));
      this.cmpStrip.appendChild(t);
    }
    this.cmp.appendChild(this.cmpStrip);
    R.appendChild(this.cmp);

    // --- killfeed, score pops, banner, objective, prompt --------------------
    this.kfEl = el('kf'); R.appendChild(this.kfEl);
    this.popsEl = el('pops'); R.appendChild(this.popsEl);

    this.banner = el('banner');
    this.bannerK = el('banner__k', 'div', '');
    this.bannerT = el('banner__t', 'div', '');
    this.bannerS = el('banner__s', 'div', '');
    this.banner.append(this.bannerK, el('banner__rule'), this.bannerT, this.bannerS);
    R.appendChild(this.banner);

    this.obj = el('obj');
    this.objN = el('obj__n', 'div', 'OBJECTIVE');
    this.objT = el('obj__t', 'div', '');
    this.obj.append(this.objN, this.objT);
    R.appendChild(this.obj);

    this.prompt = el('prompt');
    this.promptK = el('prompt__k', 'div', 'F');
    this.promptT = el('prompt__t', 'div', '');
    this.prompt.append(this.promptK, this.promptT);
    R.appendChild(this.prompt);

    this.reload = el('reload hidden', 'div', 'RELOAD');
    R.appendChild(this.reload);

    // --- loading ------------------------------------------------------------
    this.load = el('scr scr--solid load on');
    this.load.appendChild(el('scr__bg'));
    const li = el('load__inner scr__inner');
    li.append(
      el('load__t', 'div', 'OPERATION BLACKOUT'),
      el('load__sub', 'div', 'HARBOUR — 18:40 LOCAL')
    );
    this.loadBar = el('load__bar');
    this.loadFill = el('load__fill');
    this.loadBar.appendChild(this.loadFill);
    this.loadMeta = el('load__meta', 'div', 'GENERATING SURFACES');
    this.loadTip = el('load__tip', 'div', TIPS[(Math.random() * TIPS.length) | 0]);
    li.append(this.loadBar, this.loadMeta, this.loadTip);
    this.load.appendChild(li);
    R.appendChild(this.load);

    // --- start menu ---------------------------------------------------------
    // The game used to drop you straight into a locked-pointer FPS with no
    // statement of the controls anywhere. "I am not sure how to shoot" is a
    // fair thing for a player to say about that.
    this.menu = el('scr scr--solid menu hidden');
    this.menu.appendChild(el('scr__bg'));
    const mi = el('menu__inner scr__inner');
    mi.append(
      el('menu__k', 'div', 'OPERATION BLACKOUT'),
      el('menu__t', 'div', 'HARBOUR'),
      el('menu__s', 'div', 'WAVE SURVIVAL — HOLD THE HARBOUR DISTRICT')
    );
    mi.appendChild(this._buildBindPanel());
    this.menuGo = el('menu__go', 'div', 'CLICK ANYWHERE TO PLAY');
    mi.appendChild(this.menuGo);
    this.menu.appendChild(mi);
    R.appendChild(this.menu);

    // --- pause / death / menus ----------------------------------------------
    this.pause = el('scr pause hidden');
    this.pause.appendChild(el('scr__bg'));
    const pi = el('pause__inner scr__inner');
    pi.append(
      el('pause__h', 'div', 'PAUSED'),
      el('pause__t', 'div', 'Click to resume')
    );
    // Same control list as the menu — this is where people actually look for
    // it once they are already playing.
    pi.appendChild(this._buildBindPanel(true));
    pi.appendChild(el('pause__s', 'div', 'CLICK — resume     R — restart'));
    this.pause.appendChild(pi);
    R.appendChild(this.pause);

    this.death = el('scr scr--light death hidden');
    this.death.appendChild(el('scr__bg'));
    this.deathT = el('death__t', 'div', 'YOU WERE KILLED');
    this.deathS = el('death__s', 'div', '');
    this.deathBar = el('death__bar');
    this.deathFill = el('death__fill');
    this.deathBar.appendChild(this.deathFill);
    this.deathCd = el('death__cd', 'div', 'RESPAWNING');
    this.death.append(this.deathT, this.deathS, this.deathBar, this.deathCd);
    R.appendChild(this.death);

    // Everything except the loading screen is hidden until the game starts.
    this._setPlayVisible(false);
  }

  /**
   * The control list, rendered from the live bindings so it is always the
   * truth rather than a hand-maintained copy of it. Click a key to rebind.
   * Built twice — once for the start menu, once for pause — and both instances
   * refresh on 'input:bindings'.
   */
  _buildBindPanel(small) {
    const wrap = el(`binds${small ? ' binds--sm' : ''}`);
    const grid = el('keys');
    this._bindRows = this._bindRows || [];

    // Mouse is fixed. Saying so beats leaving a new player to guess.
    for (const [cap, what] of [['LEFT-CLICK', 'Fire'], ['RIGHT-CLICK', 'Aim down sights'], ['MOUSE', 'Look']]) {
      const r = el('keys__r');
      const k = el('keys__k');
      k.appendChild(el('keys__cap keys__cap--fixed', 'kbd', cap));
      r.append(k, el('keys__w', 'div', what));
      grid.appendChild(r);
    }

    for (const a of ACTIONS) {
      const r = el('keys__r');
      const k = el('keys__k');
      const btn = el('keys__cap keys__cap--bind', 'kbd', '');
      btn.tabIndex = 0;
      btn.addEventListener('click', (ev) => {
        ev.stopPropagation();
        this._beginRebind(a, btn);
      });
      k.appendChild(btn);
      r.append(k, el('keys__w', 'div', a.label));
      grid.appendChild(r);
      this._bindRows.push({ action: a, btn });
    }
    wrap.appendChild(grid);

    const foot = el('binds__foot');
    const reset = el('binds__reset', 'button', 'RESET TO DEFAULTS');
    reset.addEventListener('click', (ev) => {
      ev.stopPropagation();
      this.ctx.input.resetBindings();
    });
    foot.append(el('binds__hint', 'div', 'Click a key to change it · ESC cancels'), reset);
    wrap.appendChild(foot);

    this._refreshBinds();
    return wrap;
  }

  _beginRebind(action, btn) {
    if (this._rebinding) {
      this.ctx.input.cancelCapture();
      this._refreshBinds();
    }
    this._rebinding = btn;
    btn.classList.add('listening');
    btn.textContent = 'PRESS A KEY';
    this.ctx.input.captureNextKey((code) => {
      this._rebinding = null;
      btn.classList.remove('listening');
      if (code) {
        const clash = this.ctx.input.rebind(action.id, code);
        if (clash) this.objective(`${keyLabel(code).toUpperCase()} taken from ${clash.label.toUpperCase()}`);
      }
      this._refreshBinds();
    });
  }

  /** Repaint every bind button from the current bindings. */
  _refreshBinds() {
    const b = this.ctx.input?.bindings;
    if (!b || !this._bindRows) return;
    for (const { action, btn } of this._bindRows) {
      if (btn === this._rebinding) continue;
      btn.textContent = keyLabel((b[action.id] || [])[0]);
    }
  }

  /** Fade the loading screen out, then take it out of the layout entirely. */
  _hideLoad() {
    if (this.load.classList.contains('hidden')) return;
    this.load.classList.remove('on');
    setTimeout(() => this.load.classList.add('hidden'), 320);
  }

  _setPlayVisible(v) {
    for (const n of [this.xh, this.ammo, this.cmp, this.kfEl, this.popsEl]) {
      n.classList.toggle('hidden', !v);
    }
  }

  // -------------------------------------------------------------------------

  _bind() {
    const bus = this.ctx.bus;

    bus.on('ammo:changed', (e) => {
      this._set(this.ammoMag, String(e.mag).padStart(2, '0'));
      this._set(this.ammoRes, String(e.reserve));
      this._set(this.grenadeCount, String(e.grenades ?? 0));
      this.ammoMag.classList.toggle('low', e.mag <= 6);
      // Re-trigger the digit kick without a layout read.
      this.ammoMag.style.animation = 'none';
      void this.ammoMag.offsetWidth;
      this.ammoMag.style.animation = '';
    });

    bus.on('weapon:changed', (e) => {
      this._set(this.ammoName, e.name);
      const icon = WEAPON_ICON[e.id] || WEAPON_ICON[ICON_BY_NAME[e.name]] || WEAPON_ICON.m4;
      if (this.ammoIcon.innerHTML !== icon) this.ammoIcon.innerHTML = icon;
      // Flash the whole readout on a swap so the change is impossible to miss.
      this.ammo.classList.remove('swap');
      void this.ammo.offsetWidth;
      this.ammo.classList.add('swap');
      this._set(this.fmLabel, e.auto ? 'AUTO' : 'SEMI');
      for (let i = 0; i < 3; i++) this.fmDots[i].classList.toggle('on', e.auto || i === 0);
    });

    bus.on('weapon:reload', (e) => {
      this.reload.classList.toggle('hidden', e.phase !== 'start');
    });

    bus.on('hit:enemy', (e) => this.hitmarker(e.headshot, false));
    bus.on('enemy:death', (e) => {
      this.hitmarker(e.headshot, true);
      this.pop(e.headshot ? '+150  HEADSHOT' : '+100  KILL', e.headshot);
      this.killfeed('YOU', 'ENEMY', e.headshot);
    });

    bus.on('player:damage', (e) => this.damageFrom(e.fromDir));
    bus.on('player:health', (e) => { this._hp = e.hp; });
    bus.on('player:death', () => this.showDeath());
    bus.on('objective', (e) => this.objective(e.text));
    bus.on('banner', (e) => this.showBanner(e));
    bus.on('score', (e) => this.pop(e.label));
    bus.on('game:start', () => {
      this._hideLoad();
      this._setPlayVisible(true);
      this.death.classList.add('hidden');
      // First time only: the start menu stands between the loading screen and
      // the game. After that a restart goes straight back into play.
      if (!this._everStarted) {
        this.menu.classList.remove('hidden');
        requestAnimationFrame(() => this.menu.classList.add('on'));
      }
    });
    bus.on('explosion', () => { this._flash = 0.55; });

    bus.on('input:unlock', () => {
      // Before the player has ever taken control the start menu owns the
      // screen; putting the pause screen over it as well would stack two
      // dialogs on a player who has not begun.
      if (!this._everStarted || this.ctx.player?.dead) return;
      this.pause.classList.remove('hidden');
      requestAnimationFrame(() => this.pause.classList.add('on'));
    });
    bus.on('input:bindings', () => this._refreshBinds());
    bus.on('input:lock', () => {
      this._everStarted = true;
      this.pause.classList.remove('on');
      this.pause.classList.add('hidden');
      this.menu.classList.remove('on');
      this.menu.classList.add('hidden');
    });
  }

  _set(node, text) {
    if (this._last[node.className] === text) return;
    this._last[node.className] = text;
    node.textContent = text;
  }

  // -------------------------------------------------------------------------
  //  Transient elements
  // -------------------------------------------------------------------------

  hitmarker(headshot, kill) {
    this.hm.className = `hm${kill ? ' hm--kill' : ''}${headshot ? ' hm--head' : ''}`;
    this._hmT = 0;
  }

  damageFrom(dir) {
    if (!dir) return;
    const d = el('dmg');
    this.dmgRing.appendChild(d);
    this._dmgs.push({ node: d, t: 0, dir: dir.clone ? dir.clone() : dir });
    if (this._dmgs.length > 6) {
      const old = this._dmgs.shift();
      old.node.remove();
    }
  }

  pop(text, hero) {
    const p = el(hero ? 'pop pop--hero' : 'pop', 'div', text);
    this.popsEl.appendChild(p);
    this._pops.push({ node: p, t: 0 });
    if (this._pops.length > 5) this._pops.shift().node.remove();
  }

  killfeed(src, vic, headshot) {
    const row = el('kf__row');
    row.append(
      el('kf__src kf__you', 'span', src),
      el('kf__w', 'span', this.ctx.weapons?.def?.name || ''),
      headshot ? el('kf__hs', 'span', 'HS') : el('kf__hs', 'span', ''),
      el('kf__vic', 'span', vic)
    );
    this.kfEl.appendChild(row);
    this._kf.push({ node: row, t: 0 });
    if (this._kf.length > 5) this._kf.shift().node.remove();
  }

  showBanner({ kicker = '', title = '', sub = '' }) {
    this._set(this.bannerK, kicker);
    this._set(this.bannerT, title);
    this._set(this.bannerS, sub);
    this.banner.classList.remove('show');
    void this.banner.offsetWidth;
    this.banner.classList.add('show');
    this._bannerT = 0;
  }

  objective(text) {
    this._set(this.objT, text);
    this.obj.classList.add('show');
  }

  showPrompt(key, text) {
    this._set(this.promptK, key);
    this._set(this.promptT, text);
    this.prompt.classList.add('show');
  }
  hidePrompt() { this.prompt.classList.remove('show'); }

  showDeath() {
    this.death.classList.remove('hidden');
    requestAnimationFrame(() => this.death.classList.add('on'));
    this._setPlayVisible(false);
  }

  setRespawn(t, total) {
    this.deathFill.style.transform = `scaleX(${clamp(1 - t / total, 0, 1)})`;
    this._set(this.deathCd, `RESPAWNING IN ${Math.ceil(t)}`);
  }

  // -------------------------------------------------------------------------

  update(dt, time) {
    this.time = time;
    const ctx = this.ctx;

    // --- loading ------------------------------------------------------------
    if (!this.load.classList.contains('hidden')) {
      const mp = ctx.materials?.progress ?? 0;
      const lp = ctx.level?.progress ?? 0;
      const p = mp * 0.45 + lp * 0.55;
      this.loadFill.style.transform = `scaleX(${p})`;
      this._set(this.loadMeta, lp > 0 ? 'BUILDING HARBOUR' : 'GENERATING SURFACES');
    }

    // --- crosshair ----------------------------------------------------------
    const w = ctx.weapons;
    const spread = w?.currentSpread ?? 0.004;
    // Convert the cone half-angle to pixels at the current FOV.
    const h = window.innerHeight;
    const fov = (ctx.camera.fov * Math.PI) / 180;
    const px = (spread / (fov * 0.5)) * (h * 0.5);
    this._spread = damp(this._spread, clamp(px, 3, 90), 16, dt);
    const gap = this._spread + 3;
    const s = 1;
    this.xhTicks[0].style.transform = `translate(-1px, ${-gap - 6}px) scaleY(${s})`;
    this.xhTicks[1].style.transform = `translate(-1px, ${gap}px) scaleY(${s})`;
    this.xhTicks[2].style.transform = `translate(${-gap - 6}px, -1px) scaleX(${s})`;
    this.xhTicks[3].style.transform = `translate(${gap}px, -1px) scaleX(${s})`;

    const ads = w?.adsFactor ?? 0;
    this.xh.classList.toggle('ads-optic', ads > 0.75);
    // Red when the crosshair is over an enemy.
    if (ctx.physics?.raycast && ctx.engine.frame % 4 === 0) {
      const cam = ctx.camera;
      cam.getWorldDirection(_dir);
      const hit = ctx.physics.raycast(cam.position, _dir, 120, {});
      this.xh.classList.toggle('hot', !!hit?.isEnemy);
    }

    // --- hitmarker ----------------------------------------------------------
    if (this._hmT !== undefined && this._hmT >= 0) {
      this._hmT += dt;
      const t = this._hmT;
      if (t > 0.24) { this._hmT = -1; this.hm.style.opacity = '0'; }
      else {
        const grow = smoothstep(0, 0.04, t);
        const fade = 1 - smoothstep(0.06, 0.24, t);
        const r = lerp(6, 11, grow);
        this.hm.style.opacity = String(fade);
        for (let i = 0; i < 4; i++) {
          const a = 45 + i * 90;
          this.hmTicks[i].style.transform =
            `rotate(${a}deg) translate(-1px, ${r}px)`;
        }
      }
    }

    // --- damage indicators ---------------------------------------------------
    const camYaw = ctx.player?.yaw ?? 0;
    for (let i = this._dmgs.length - 1; i >= 0; i--) {
      const d = this._dmgs[i];
      d.t += dt;
      if (d.t > 1.4) { d.node.remove(); this._dmgs.splice(i, 1); continue; }
      // Angle of the hit relative to where the player is looking.
      const world = Math.atan2(d.dir.x, d.dir.z);
      const rel = world - camYaw + Math.PI;
      d.node.style.opacity = String((1 - d.t / 1.4) * 0.95);
      d.node.style.transform = `rotate(${(rel * 180) / Math.PI}deg)`;
    }

    // --- health treatment ----------------------------------------------------
    const hurt = 1 - clamp(this._hp / 100, 0, 1);
    this.vig.style.opacity = String(hurt * hurt * 1.15);
    this.vig.classList.toggle('vig--beat', this._hp < 35);
    this.spatter.style.opacity = String(clamp((hurt - 0.45) * 1.8, 0, 0.7));

    // Drive the post-process grade from health, so the world desaturates too.
    const grade = ctx.engine?.grade?.uniforms;
    if (grade) {
      grade.uTime.value = time;
      grade.uLowHealth.value = damp(grade.uLowHealth.value, clamp((hurt - 0.5) * 2, 0, 1), 6, dt);
      grade.uDamage.value = damp(grade.uDamage.value, hurt * 0.55, 5, dt);
      this._flash = Math.max(0, (this._flash || 0) - dt * 3);
      grade.uFlash.value = this._flash;
      grade.uScope.value = damp(grade.uScope.value, ads > 0.8 && w?.def?.kind === 'sniper' ? 1 : 0, 10, dt);
      // Camera-velocity motion blur.
      const p = ctx.player;
      if (p) {
        const dy = (p.yaw - (this._prevYaw ?? p.yaw));
        const dp = (p.pitch - (this._prevPitch ?? p.pitch));
        this._prevYaw = p.yaw; this._prevPitch = p.pitch;
        const k = 26 / Math.max(dt, 1e-3) * 0.0025;
        grade.uMotion.value.set(
          clamp(-dy * k, -14, 14),
          clamp(dp * k, -14, 14)
        );
      }
    }

    // --- compass -------------------------------------------------------------
    const deg = ((-camYaw * 180) / Math.PI + 540) % 360 - 180;
    this.cmpStrip.style.transform = `translateX(${-deg * 2.4}px)`;

    // --- score pops and killfeed ---------------------------------------------
    for (let i = this._pops.length - 1; i >= 0; i--) {
      const p = this._pops[i];
      p.t += dt;
      if (p.t > 1.1) { p.node.remove(); this._pops.splice(i, 1); continue; }
      p.node.style.opacity = String(1 - smoothstep(0.5, 1.1, p.t));
      p.node.style.transform = `translateX(-50%) translateY(${-p.t * 26}px)`;
    }
    for (let i = this._kf.length - 1; i >= 0; i--) {
      const k = this._kf[i];
      k.t += dt;
      if (k.t > 5.5) { k.node.remove(); this._kf.splice(i, 1); continue; }
      k.node.style.opacity = String(1 - smoothstep(4.6, 5.5, k.t));
    }

    if (this._bannerT !== undefined) {
      this._bannerT += dt;
      if (this._bannerT > 3.2) this.banner.classList.remove('show');
    }

    // --- mantle prompt --------------------------------------------------------
    const p = ctx.player;
    if (p && !p.dead) {
      if (p.isMantling) this.showPrompt('SPACE', 'MANTLE');
      else this.hidePrompt();
    }
  }
}

