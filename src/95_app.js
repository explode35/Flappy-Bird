/* ============================================================================
   APP — renderer, screens, modes, Grand Prix bookkeeping and the main loop.
   ========================================================================= */

const SCREENS = ['title', 'char', 'track', 'results', 'pause'];

class App {
  constructor() {
    this.canvas = $('#gl');
    this.width = window.innerWidth;
    this.height = window.innerHeight;
    this.quality = 'high';
    this.dpr = Math.min(window.devicePixelRatio || 1, 1.75);
    this.paused = false;
    this.race = null;
    this.mode = 'single';
    this.playerChars = ['nova', 'sable'];
    this.selIdx = 0;
    this.gp = null;
    this.bestLap = {};
    this.ghosts = {};
    this.showFps = false;
    this._fpsAcc = 0; this._fpsN = 0; this._slow = 0;

    this._initRenderer();
    this._load();
    this._buildMenus();
    this._bindGlobalKeys();
    this.show('title');

    window.addEventListener('resize', () => this.resize());
    document.addEventListener('visibilitychange', () => {
      if (document.hidden && this.race && !this.paused && this.race.phase !== 'results') this.setPaused(true);
    });
    this.resize();
  }

  _initRenderer() {
    const r = new THREE.WebGLRenderer({ canvas: this.canvas, antialias: false, powerPreference: 'high-performance', stencil: false });
    r.setPixelRatio(1);          // we drive resolution ourselves through the post chain
    r.shadowMap.enabled = true;
    r.shadowMap.type = THREE.PCFSoftShadowMap;
    r.outputEncoding = THREE.sRGBEncoding;
    r.autoClear = true;
    this.renderer = r;
    const gl = r.getContext();
    const dbg = gl.getExtension('WEBGL_debug_renderer_info');
    const name = dbg ? String(gl.getParameter(dbg.UNMASKED_RENDERER_WEBGL)) : '';
    if (/swiftshader|llvmpipe|software/i.test(name)) { this.quality = 'low'; this.dpr = 1; }
    if ((navigator.hardwareConcurrency || 8) <= 4) this.quality = 'low';
  }

  _load() {
    try {
      const raw = localStorage.getItem('nitro-circuit');
      if (raw) {
        const d = JSON.parse(raw);
        this.bestLap = d.bestLap || {};
        this.ghosts = d.ghosts || {};
        if (d.chars) this.playerChars = d.chars;
      }
    } catch (e) { /* private mode — run without persistence */ }
  }
  save() {
    try {
      localStorage.setItem('nitro-circuit', JSON.stringify({
        bestLap: this.bestLap, ghosts: this.ghosts, chars: this.playerChars
      }));
    } catch (e) { }
  }
  saveGhosts() { this.save(); }

  /* ------------------------------------------------------------- screens */
  show(name) {
    SCREENS.forEach(s => $('#s-' + s).classList.toggle('hidden', s !== name));
    this.screen = name;
    this.selIdx = 0;
    if (name === 'char') this._refreshChar();
    if (name === 'track') this._refreshTrack();
    this._syncSel();
  }
  hideScreens() { SCREENS.forEach(s => $('#s-' + s).classList.add('hidden')); this.screen = null; }

  _selectables() {
    if (!this.screen) return [];
    const root = $('#s-' + this.screen);
    return $$('#s-' + this.screen + ' .btn, #s-' + this.screen + ' .card, #s-' + this.screen + ' .tcard');
  }
  _syncSel() {
    const list = this._selectables();
    list.forEach((e, i) => e.classList.toggle('sel', i === this.selIdx));
    if (list[this.selIdx] && list[this.selIdx].scrollIntoView) {
      // keep the highlighted card on screen on small displays
      const r = list[this.selIdx].getBoundingClientRect();
      if (r.top < 0 || r.bottom > window.innerHeight) list[this.selIdx].scrollIntoView({ block: 'nearest' });
    }
  }

  _buildMenus() {
    // title
    $$('#s-title .btn').forEach(b => b.addEventListener('click', () => this._titleAct(b.dataset.act)));
    // pause
    $$('#s-pause .btn').forEach(b => b.addEventListener('click', () => this._pauseAct(b.dataset.act)));

    // character grid
    const grid = $('#charGrid');
    CHARACTERS.forEach((c, i) => {
      const card = el('div', 'card');
      card.style.setProperty('--c', cssHex(c.color));
      const bar = (label, v) => `<div class="stat"><b>${label}</b><div class="bar"><i style="width:${v * 20}%"></i></div></div>`;
      card.innerHTML = '<div class="chip"></div>' +
        '<h3>' + c.name + '</h3><div class="role">' + c.role + '</div>' +
        bar('SPD', c.speed) + bar('ACC', c.accel) + bar('HND', c.handling) + bar('WGT', c.weight);
      card.addEventListener('click', () => this._pickChar(i));
      grid.appendChild(card);
    });

    // track grid
    const tg = $('#trackGrid');
    TRACKS.forEach((t, i) => {
      const card = el('div', 'tcard');
      card.style.setProperty('--c', cssHex(t.accent));
      card.innerHTML = '<div class="sky"><canvas width="420" height="180"></canvas></div>' +
        '<div class="meta"><h3>' + t.name + '</h3><p>' + t.blurb + '</p>' +
        '<span class="gimmick">' + t.gimmick + '</span></div>';
      card.addEventListener('click', () => this._pickTrack(i));
      tg.appendChild(card);
      this._drawTrackCard(card.querySelector('canvas'), t);
    });
  }

  /** Little procedural postcard for each circuit: sky gradient + course shape. */
  _drawTrackCard(cv, t) {
    const g = cv.getContext('2d'), w = cv.width, h = cv.height;
    const e = t.env;
    const grad = g.createLinearGradient(0, 0, 0, h);
    grad.addColorStop(0, cssHex(e.skyTop));
    grad.addColorStop(.55, cssHex(e.skyMid));
    grad.addColorStop(1, cssHex(e.skyBot));
    g.fillStyle = grad; g.fillRect(0, 0, w, h);
    if (e.star) {
      g.fillStyle = 'rgba(255,255,255,.85)';
      for (let i = 0; i < 60; i++) g.fillRect(Math.random() * w, Math.random() * h * .6, 1.4, 1.4);
    }
    // course outline
    const X = t.points.map(p => p[0]), Z = t.points.map(p => p[2]);
    const pts = [];
    for (let i = 0; i < 200; i++) pts.push([crScalar(X, i / 200), crScalar(Z, i / 200)]);
    const minx = Math.min.apply(null, pts.map(p => p[0])), maxx = Math.max.apply(null, pts.map(p => p[0]));
    const minz = Math.min.apply(null, pts.map(p => p[1])), maxz = Math.max.apply(null, pts.map(p => p[1]));
    const sc = Math.min((w - 40) / (maxx - minx), (h - 30) / (maxz - minz));
    const ox = w / 2 - (minx + maxx) / 2 * sc, oz = h / 2 + 6 - (minz + maxz) / 2 * sc;
    g.lineJoin = g.lineCap = 'round';
    g.strokeStyle = 'rgba(0,0,0,.30)'; g.lineWidth = 13;
    g.beginPath();
    pts.forEach((p, i) => i ? g.lineTo(p[0] * sc + ox, p[1] * sc + oz) : g.moveTo(p[0] * sc + ox, p[1] * sc + oz));
    g.closePath(); g.stroke();
    g.strokeStyle = cssHex(t.accent); g.lineWidth = 3.4;
    g.stroke();
  }

  _refreshChar() {
    const which = (this.mode === 'split' && this.pickPhase === 1) ? 1 : 0;
    $('#charTitle').textContent = this.mode === 'split'
      ? 'Player ' + (which + 1) + ' — choose your racer'
      : 'Choose your racer';
    const cards = $$('#charGrid .card');
    cards.forEach((c, i) => {
      const tag = c.querySelector('.p2tag');
      if (tag) tag.remove();
      if (this.mode === 'split' && which === 1 && CHARACTERS[i].id === this.playerChars[0]) {
        const t = el('div', 'p2tag', 'P1');
        c.appendChild(t);
      }
    });
    const ch = CHARACTERS[Math.max(0, CHARACTERS.findIndex(c => c.id === this.playerChars[which]))];
    $('#charHint').textContent = '“' + ch.quip + '”';
    this.selIdx = Math.max(0, CHARACTERS.findIndex(c => c.id === this.playerChars[which]));
  }

  _refreshTrack() {
    const cards = $$('#trackGrid .tcard');
    cards.forEach((c, i) => {
      const b = this.bestLap[TRACKS[i].id];
      let p = c.querySelector('.best');
      if (b != null) {
        if (!p) { p = el('p', 'best'); p.style.marginTop = '6px'; c.querySelector('.meta').appendChild(p); }
        p.innerHTML = '<span style="color:var(--warn)">Best lap ' + fmtTime(b) + '</span>';
      }
    });
  }

  /* -------------------------------------------------------------- actions */
  _titleAct(act) {
    Audio.init(); Audio.resume(); Audio.sfx('uiConfirm');
    this.mode = act;
    this.pickPhase = 0;
    Input.splitMode = (act === 'split');
    this.show('char');
  }

  _pickChar(i) {
    Audio.sfx('uiConfirm');
    const which = (this.mode === 'split' && this.pickPhase === 1) ? 1 : 0;
    this.playerChars[which] = CHARACTERS[i].id;
    if (this.mode === 'split' && this.pickPhase === 0) {
      this.pickPhase = 1;
      if (this.playerChars[1] === this.playerChars[0]) {
        const alt = CHARACTERS.find(c => c.id !== this.playerChars[0]);
        this.playerChars[1] = alt.id;
      }
      this._refreshChar();
      this._syncSel();
      return;
    }
    this.save();
    if (this.mode === 'gp') { this._startGP(); return; }
    this.show('track');
  }

  _pickTrack(i) {
    Audio.sfx('uiConfirm');
    this.startRace(TRACKS[i]);
  }

  _pauseAct(act) {
    Audio.sfx('ui');
    if (act === 'resume') this.setPaused(false);
    else if (act === 'restart') { this.setPaused(false); this.race.grid(); $('#hudlayer').classList.remove('hidden'); }
    else if (act === 'quit') { this.setPaused(false); this.quitRace(); }
  }

  /* ---------------------------------------------------------------- races */
  startRace(trackCfg) {
    this.hideScreens();
    if (this.race) { this.race.dispose(); this.race = null; }
    Audio.init(); Audio.resume();
    const players = [{ charId: this.playerChars[0], index: 0 }];
    if (this.mode === 'split') players.push({ charId: this.playerChars[1], index: 1 });
    const opts = {
      track: trackCfg,
      players,
      mode: this.mode,
      laps: 3,
      fieldSize: this.mode === 'tt' ? 1 : 8,
      aiSkill: this.mode === 'gp' ? .74 : .68
    };
    this.race = new Race(this, opts);
    this.resize();
    $('#hudlayer').classList.remove('hidden');
    $('#fps').classList.toggle('hidden', !this.showFps);
  }

  quitRace() {
    if (this.race) { this.race.dispose(); this.race = null; }
    this.gp = null;
    Audio.stopMusic(); Audio.stopAmbience();
    this.show('title');
  }

  _startGP() {
    this.gp = { round: 0, order: TRACKS.slice(0, 4), points: {} };
    CHARACTERS.forEach(c => this.gp.points[c.id] = 0);
    this.startRace(this.gp.order[0]);
  }

  onRaceComplete(race) {
    const rows = race.finishOrder.slice();
    if (this.gp) {
      rows.forEach((k, i) => { this.gp.points[k.ch.id] = (this.gp.points[k.ch.id] || 0) + (GP_POINTS[i] || 0); });
    }
    this._showResults(race, rows);
  }

  _showResults(race, rows) {
    const head = $('#resHead'), body = $('#resBody'), btns = $('#resBtns');
    const isGP = !!this.gp;
    $('#resTitle').textContent = isGP
      ? 'Round ' + (this.gp.round + 1) + ' — ' + race.cfg.name
      : (this.mode === 'tt' ? 'Time Trial — ' + race.cfg.name : race.cfg.name);
    const badge = $('#resBadge');
    badge.innerHTML = isGP ? '<div class="gpbadge">Grand Prix · Round ' + (this.gp.round + 1) + ' of 4</div>' :
      (race.newRecord ? '<div class="gpbadge">New personal best</div>' : '');

    head.innerHTML = '<tr><th></th><th></th><th>Racer</th><th style="text-align:right">Time</th>' +
      (isGP ? '<th style="text-align:right">Pts</th><th style="text-align:right">Total</th>' : '<th style="text-align:right">Best lap</th>') + '</tr>';
    body.innerHTML = '';
    const winner = rows[0];
    rows.forEach((k, i) => {
      const tr = el('tr');
      tr.className = 'rowin' + (k.isPlayer && k.playerIdx === 0 ? ' me' : '') + (k.playerIdx === 1 ? ' p2' : '');
      tr.style.animationDelay = (i * .05) + 's';
      const gap = i === 0 ? fmtTime(k.finishTime) : fmtGap(k.finishTime - winner.finishTime);
      const best = k.lapTimes.length ? fmtTime(Math.min.apply(null, k.lapTimes)) : '--';
      tr.innerHTML = '<td class="p">' + ORD[i + 1] + '</td>' +
        '<td class="dot"><span class="swatch" style="background:' + cssHex(k.ch.color) + '"></span></td>' +
        '<td>' + k.ch.name + (k.isPlayer ? ' <span style="color:var(--accent);font-size:11px">P' + (k.playerIdx + 1) + '</span>' : '') + '</td>' +
        '<td class="t">' + gap + '</td>' +
        (isGP
          ? '<td class="pts">+' + (GP_POINTS[i] || 0) + '</td><td class="pts">' + this.gp.points[k.ch.id] + '</td>'
          : '<td class="t">' + best + '</td>');
      body.appendChild(tr);
    });

    btns.innerHTML = '';
    const mk = (label, fn) => {
      const b = el('div', 'btn', '<span>' + label + '</span>');
      b.addEventListener('click', () => { Audio.sfx('uiConfirm'); fn(); });
      btns.appendChild(b);
      return b;
    };
    if (isGP && this.gp.round < 3) {
      mk('Next race', () => { this.gp.round++; this.startRace(this.gp.order[this.gp.round]); });
      mk('Quit GP', () => this.quitRace());
    } else if (isGP) {
      mk('Final standings', () => this._showStandings());
      mk('Quit', () => this.quitRace());
    } else {
      mk('Race again', () => { this.hideScreens(); this.race.grid(); $('#hudlayer').classList.remove('hidden'); });
      mk('Menu', () => this.quitRace());
    }
    this.show('results');
    $('#hudlayer').classList.add('hidden');
  }

  _showStandings() {
    const rows = CHARACTERS.slice().sort((a, b) => this.gp.points[b.id] - this.gp.points[a.id]);
    $('#resTitle').textContent = 'Grand Prix — final standings';
    $('#resBadge').innerHTML = '<div class="gpbadge">4 rounds complete</div>';
    $('#resHead').innerHTML = '<tr><th></th><th></th><th>Racer</th><th style="text-align:right">Points</th></tr>';
    const body = $('#resBody');
    body.innerHTML = '';
    rows.forEach((c, i) => {
      const tr = el('tr');
      const isMe = this.playerChars.indexOf(c.id) >= 0;
      tr.className = 'rowin' + (isMe ? ' me' : '');
      tr.style.animationDelay = (i * .06) + 's';
      tr.innerHTML = '<td class="p">' + ORD[i + 1] + '</td>' +
        '<td class="dot"><span class="swatch" style="background:' + cssHex(c.color) + '"></span></td>' +
        '<td>' + c.name + '</td><td class="pts">' + this.gp.points[c.id] + '</td>';
      body.appendChild(tr);
    });
    const btns = $('#resBtns');
    btns.innerHTML = '';
    const b = el('div', 'btn', '<span>Back to menu</span>');
    b.addEventListener('click', () => { Audio.sfx('uiConfirm'); this.quitRace(); });
    btns.appendChild(b);
    Audio.sfx('finish', .8);
  }

  /* --------------------------------------------------------------- pause */
  setPaused(p) {
    if (!this.race || this.race.phase === 'results') return;
    this.paused = p;
    $('#s-pause').classList.toggle('hidden', !p);
    $('#hudlayer').classList.toggle('hidden', p);
    this.screen = p ? 'pause' : null;
    this.selIdx = 0;
    if (p) this._syncSel();
    Audio.setMuted(p);
  }

  /* --------------------------------------------------------------- input */
  _bindGlobalKeys() {
    window.addEventListener('keydown', e => {
      if (e.code === 'KeyF' && !this.race) { }
      if (e.code === 'KeyF') {
        this.showFps = !this.showFps;
        $('#fps').classList.toggle('hidden', !this.showFps);
      }
      if (e.code === 'KeyM') { Audio.setMuted(!Audio.muted); }
      if (e.code === 'Escape') {
        if (this.race && !this.screen) this.setPaused(true);
        else if (this.screen === 'pause') this.setPaused(false);
        else if (this.screen === 'char') { if (this.mode === 'split' && this.pickPhase === 1) { this.pickPhase = 0; this._refreshChar(); this._syncSel(); } else this.show('title'); }
        else if (this.screen === 'track') this.show('char');
        return;
      }
      if (!this.screen) return;
      const list = this._selectables();
      if (!list.length) return;
      const grid = this.screen === 'char' ? 4 : (this.screen === 'track' ? 2 : 1);
      let d = 0;
      if (e.code === 'ArrowDown') d = grid;
      else if (e.code === 'ArrowUp') d = -grid;
      else if (e.code === 'ArrowRight') d = 1;
      else if (e.code === 'ArrowLeft') d = -1;
      if (d) {
        this.selIdx = (this.selIdx + d + list.length) % list.length;
        this._syncSel();
        Audio.sfx('ui', .5);
        e.preventDefault();
      }
      if (e.code === 'Enter' || e.code === 'Space') {
        list[this.selIdx].click();
        e.preventDefault();
      }
    });
  }

  /* -------------------------------------------------------------- resize */
  resize() {
    this.width = window.innerWidth;
    this.height = window.innerHeight;
    this.renderer.setSize(Math.floor(this.width * this.dpr), Math.floor(this.height * this.dpr), false);
    this.canvas.style.width = this.width + 'px';
    this.canvas.style.height = this.height + 'px';
    if (this.race) this.race.layout(this.width, this.height);
  }

  /** Adaptive resolution: if we can't hold the frame budget, render smaller. */
  _adaptive(dt) {
    this._fpsAcc += dt; this._fpsN++;
    if (this._fpsAcc >= .5) {
      const fps = this._fpsN / this._fpsAcc;
      if (this.showFps) {
        $('#fps').textContent = fps.toFixed(0) + ' fps · ' + this.dpr.toFixed(2) + 'x · ' +
          (this.race ? this.renderer.info.render.calls + ' calls' : '-');
      }
      if (this.race && this.race.phase !== 'results') {
        if (fps < 48 && this.dpr > 0.62) { this.dpr = Math.max(0.62, this.dpr - 0.12); this.resize(); }
        else if (fps < 34 && this.quality !== 'low') { this.quality = 'low'; }
        else if (fps > 58 && this.dpr < Math.min(window.devicePixelRatio || 1, 1.75) - .01) {
          this._fast = (this._fast || 0) + 1;
          if (this._fast > 6) { this.dpr = Math.min(Math.min(window.devicePixelRatio || 1, 1.75), this.dpr + .1); this.resize(); this._fast = 0; }
        }
      }
      this._fpsAcc = 0; this._fpsN = 0;
    }
  }

  /* ----------------------------------------------------------- main loop */
  frame(dt) {
    this._adaptive(dt);
    if (this.race) {
      if (!this.paused) {
        this.race.update(dt);
        if (this.race.phase !== 'results') this.race.layout(this.width, this.height);
      }
      this.race.render();
    } else {
      this.renderer.setScissorTest(false);
      this.renderer.setViewport(0, 0, this.width * this.dpr, this.height * this.dpr);
      this.renderer.clear();
    }
    Input.endFrame();
  }
}
