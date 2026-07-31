/* ============================================================================
   HUD — one per player view. DOM for text, canvas for the item icon and the
   live minimap. Everything scales with the viewport so split-screen stays legible.
   ========================================================================= */

class HUD {
  constructor(layer, playerIdx, accent) {
    this.idx = playerIdx;
    this.root = el('div', 'hud');
    this.accent = accent;
    this.root.innerHTML =
      '<div class="edge"></div>' +
      '<div class="itemslot"><canvas></canvas></div>' +
      '<div class="lap"><div class="l1">LAP</div><div class="l2">1/3</div></div>' +
      '<div class="timer">0:00.00<span class="sp"></span></div>' +
      '<div class="pos"><span class="n">1</span><span class="s">st</span></div>' +
      '<div class="speedo"><b>0</b> KM/H</div>' +
      '<div class="mapwrap"><canvas></canvas></div>' +
      '<div class="center"><div class="bigmsg"></div></div>' +
      '<div class="toast"></div>';
    layer.appendChild(this.root);

    this.slot = this.root.querySelector('.itemslot');
    this.itemCanvas = this.slot.querySelector('canvas');
    this.itemCtx = this.itemCanvas.getContext('2d');
    this.lapEl = this.root.querySelector('.lap .l2');
    this.timerEl = this.root.querySelector('.timer');
    this.splitEl = this.root.querySelector('.timer .sp');
    this.posN = this.root.querySelector('.pos .n');
    this.posS = this.root.querySelector('.pos .s');
    this.speedEl = this.root.querySelector('.speedo b');
    this.mapCanvas = this.root.querySelector('.mapwrap canvas');
    this.mapCtx = this.mapCanvas.getContext('2d');
    this.bigEl = this.root.querySelector('.bigmsg');
    this.toastEl = this.root.querySelector('.toast');
    this.wrongEl = null;
    this._item = undefined;
    this._lap = '';
    this._pos = -1;
    this._speed = -1;
    this._toastTimer = 0;
  }

  layout(rect, scale) {
    const st = this.root.style;
    st.left = rect.x + 'px'; st.top = rect.y + 'px';
    st.width = rect.w + 'px'; st.height = rect.h + 'px';
    st.display = rect.w < 8 ? 'none' : 'block';
    const s = scale;
    st.setProperty('--posN', (70 * s) + 'px');
    st.setProperty('--posS', (27 * s) + 'px');
    st.setProperty('--posW', (108 * s) + 'px');
    st.setProperty('--lapS', (11 * s) + 'px');
    st.setProperty('--lapN', (34 * s) + 'px');
    st.setProperty('--timerS', (21 * s) + 'px');
    st.setProperty('--timerT', (56 * s) + 'px');
    st.setProperty('--itemW', (86 * s) + 'px');
    st.setProperty('--mapW', (152 * s) + 'px');
    st.setProperty('--spdS', (13 * s) + 'px');
    st.setProperty('--bigS', (78 * s) + 'px');
    st.setProperty('--toastS', (18 * s) + 'px');
    st.setProperty('--wwS', (26 * s) + 'px');
    const ic = Math.round(86 * s * .78 * (window.devicePixelRatio || 1));
    if (this.itemCanvas.width !== ic) {
      this.itemCanvas.width = this.itemCanvas.height = ic;
      this._item = undefined;
    }
    const mc = Math.round(152 * s * (window.devicePixelRatio || 1));
    if (this.mapCanvas.width !== mc) this.mapCanvas.width = this.mapCanvas.height = mc;
  }

  update(kart, race, dt) {
    // position
    if (this._pos !== kart.position) {
      this._pos = kart.position;
      this.posN.textContent = ORD_N[kart.position];
      this.posS.textContent = ORD_S[kart.position];
      const c = kart.position === 1 ? '#ffd84a' : (kart.position <= 3 ? '#eaf2ff' : '#c6d2e6');
      this.posN.style.color = c; this.posS.style.color = c;
    }
    // lap
    const lapTxt = clamp(Math.max(1, kart.lap), 1, race.laps) + '/' + race.laps;
    if (this._lap !== lapTxt) { this._lap = lapTxt; this.lapEl.textContent = lapTxt; }
    // timer
    const t = race.phase === 'countdown' ? 0 : race.time;
    this.timerEl.firstChild.textContent = fmtTime(kart.finished ? kart.finishTime : t);
    // speed
    const sp = Math.round(kart.speedKmh);
    if (sp !== this._speed) { this._speed = sp; this.speedEl.textContent = sp; }
    // item
    const key = kart.item + '|' + (kart.itemCharges || 0) + '|' + (kart.itemRolling > 0 ? Math.floor(race.time * 22) % 7 : 'x');
    if (key !== this._item) {
      this._item = key;
      const g = this.itemCtx, w = this.itemCanvas.width;
      if (kart.itemRolling > 0) {
        drawItemIcon(g, ITEM_KEYS[Math.floor(race.time * 22) % ITEM_KEYS.length], w, w);
        Audio.sfx('itemroll', .25);
      } else drawItemIcon(g, kart.item, w, w);
    }
    this.slot.classList.toggle('roll', kart.itemRolling > 0);
    this.slot.classList.toggle('have', !!kart.item && kart.itemRolling <= 0);

    // wrong way
    if (kart.wrongWay && !this.wrongEl) {
      this.wrongEl = el('div', 'wrongway', 'WRONG WAY');
      this.root.appendChild(this.wrongEl);
    } else if (!kart.wrongWay && this.wrongEl) {
      this.root.removeChild(this.wrongEl); this.wrongEl = null;
    }

    this.drawMap(kart, race);
  }

  drawMap(kart, race) {
    const g = this.mapCtx, c = this.mapCanvas.width;
    const T = race.track;
    g.clearRect(0, 0, c, c);
    const pad = c * .11, sc = (c - pad * 2);
    const X = x => c / 2 + T.mapX(x) * sc;
    const Z = z => c / 2 + T.mapZ(z) * sc;

    // track ribbon
    g.lineJoin = 'round'; g.lineCap = 'round';
    g.strokeStyle = 'rgba(255,255,255,.13)';
    g.lineWidth = Math.max(4, c * .052);
    g.beginPath();
    const pts = T.map.pts;
    for (let i = 0; i < pts.length; i += 2) {
      const x = c / 2 + pts[i] * sc, z = c / 2 + pts[i + 1] * sc;
      i ? g.lineTo(x, z) : g.moveTo(x, z);
    }
    g.closePath(); g.stroke();
    g.strokeStyle = 'rgba(160,210,255,.35)';
    g.lineWidth = Math.max(1, c * .012);
    g.stroke();

    // start line
    const sp = T.path.surfacePoint(T.startS, 0, _v0);
    g.fillStyle = '#ffd84a';
    g.beginPath(); g.arc(X(sp.x), Z(sp.z), c * .022, 0, TAU); g.fill();

    // racers
    for (let i = 0; i < race.karts.length; i++) {
      const k = race.karts[i];
      const isMe = k === kart;
      const r = isMe ? c * .042 : c * .03;
      g.beginPath(); g.arc(X(k.pos.x), Z(k.pos.z), r, 0, TAU);
      g.fillStyle = cssHex(k.ch.color);
      g.globalAlpha = isMe ? 1 : .82;
      g.fill();
      if (isMe) {
        g.globalAlpha = 1;
        g.lineWidth = Math.max(1.5, c * .012);
        g.strokeStyle = '#fff'; g.stroke();
      }
      g.globalAlpha = 1;
    }
  }

  big(text, color, hold) {
    this.bigEl.className = 'bigmsg';
    void this.bigEl.offsetWidth;
    this.bigEl.textContent = text;
    this.bigEl.style.color = color || '#fff';
    this.bigEl.classList.add('show');
    if (!hold) {
      clearTimeout(this._bigT);
      this._bigT = setTimeout(() => this.bigEl.classList.add('fade'), 700);
    }
  }
  clearBig() { this.bigEl.className = 'bigmsg'; }

  toast(text, color) {
    this.toastEl.className = 'toast';
    void this.toastEl.offsetWidth;
    this.toastEl.textContent = text;
    this.toastEl.style.color = color || '#eaf2ff';
    this.toastEl.classList.add('show');
  }

  split(text, color) {
    this.splitEl.textContent = text;
    this.splitEl.style.color = color || 'var(--accent)';
  }

  destroy() { this.root.remove(); }
}
