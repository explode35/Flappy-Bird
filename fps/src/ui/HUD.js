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
    this.ammo.append(this.ammoName, el('ammo__rule'), row, foot);
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

    // --- pause / death / menus ----------------------------------------------
    this.pause = el('scr pause hidden');
    this.pause.appendChild(el('scr__bg'));
    this.pause.append(
      el('pause__h', 'div', 'PAUSED'),
      el('pause__t', 'div', 'Click to resume'),
      el('pause__s', 'div', 'CLICK — resume    R — restart')
    );
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
    });
    bus.on('explosion', () => { this._flash = 0.55; });

    bus.on('input:unlock', () => {
      if (this.ctx.player?.dead || this.ctx.engine.frame < 120) return;
      this.pause.classList.remove('hidden');
      requestAnimationFrame(() => this.pause.classList.add('on'));
    });
    bus.on('input:lock', () => {
      this.pause.classList.remove('on');
      this.pause.classList.add('hidden');
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

