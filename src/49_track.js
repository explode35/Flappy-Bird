/* ============================================================================
   TRACK — assembles a circuit and answers every physics question about it.
   ========================================================================= */

const SQ = { s: 0, u: 0, i: 0, height: 0, bank: 0, curv: 0, width: 0, surf: 0, onRoad: true, wall: 0, kerb: false, alt: false, boost: false, ramp: -1, glide: false, fell: false };

class Track {
  constructor(cfg) {
    this.cfg = cfg;
    this.path = new TrackPath(cfg.points, cfg.pathOpts || {});
    this.root = new THREE.Group();
    this.animMats = [];
    this.chunks = [];
    this.rng = makeRng(0xC0FFEE ^ cfg.id.charCodeAt(0) * 7919);
    this.time = 0;
    this.lapPhase = 0;

    const P = this.path;
    this.kerbW = 1.3;
    this.shoulderW = cfg.shoulderW;
    this.wallAt = i => P.width[i] + this.kerbW + this.shoulderW;

    this._findStart();
    this._buildRoad();
    this._buildFeatures();
    this._buildBarrier();
    this._buildTerrain();
    this._buildEnvironment();
    this._buildDecor();
    this._buildStartLine();
    this._buildMinimap();
  }

  /* --- start line goes on the straightest 95m window ---------------------- */
  _findStart() {
    const P = this.path, N = P.N;
    const win = Math.max(4, Math.floor(95 / P.ds));
    let best = 1e9, bi = 0;
    for (let i = 0; i < N; i++) {
      let m = 0;
      for (let k = 0; k < win; k++) m = Math.max(m, Math.abs(P.curv[(i + k) % N]));
      if (m < best) { best = m; bi = i; }
    }
    this.startIdx = (bi + win - 1) % N;
    this.startS = this.startIdx / N;
  }

  /** Race progress relative to the start line, 0..1. */
  prog(s) { return ((s - this.startS) % 1 + 1) % 1; }

  /* --- road, kerbs, shoulder --------------------------------------------- */
  _buildRoad() {
    const P = this.path, cfg = this.cfg;
    const step = 2;

    const roadTex = roadTexture(cfg.road);
    roadTex.repeat.set(1, 1);
    const roadMat = new THREE.MeshStandardMaterial({
      map: roadTex, roughness: cfg.road.tex === 'ice' ? .28 : .92,
      metalness: cfg.road.tex === 'metal' ? .35 : .04,
      color: 0xffffff
    });
    const roadGeo = buildRibbon(P, step, 10,
      (i, k) => (-1 + 2 * k / 10) * P.width[i],
      (i, k) => this.rampHeight(i / P.N),
      [1, 12]);
    // paint the edge lines straight into the UV: v across width, so use a
    // second UV channel trick — simpler to bake lines by vertex colour
    this.roadMesh = new THREE.Mesh(roadGeo, roadMat);
    this.roadMesh.receiveShadow = true;
    this.root.add(this.roadMesh);

    // edge lines as thin emissive ribbons
    const lineMat = new THREE.MeshBasicMaterial({ color: cfg.road.line, transparent: true, opacity: .82 });
    [-1, 1].forEach(sgn => {
      const g = buildRibbon(P, step, 1,
        (i, k) => sgn * (P.width[i] - (k ? .35 : .95)),
        (i) => this.rampHeight(i / P.N) + .035, [1, 6]);
      this.root.add(new THREE.Mesh(g, lineMat));
    });

    // kerbs
    const kerbTex = stripeTexture(cfg.road.kerb[0], cfg.road.kerb[1]);
    const kerbMat = new THREE.MeshLambertMaterial({ map: kerbTex });
    [-1, 1].forEach(sgn => {
      const g = buildRibbon(P, step, 1,
        (i, k) => sgn * (P.width[i] + k * this.kerbW),
        (i, k) => this.rampHeight(i / P.N) + (k ? .1 : .02), [1, 2.4]);
      const m = new THREE.Mesh(g, kerbMat);
      m.receiveShadow = true;
      this.root.add(m);
    });

    // shoulder / run-off
    const sd = SURFACES[cfg.shoulder];
    const shTex = groundTexture(cfg.id + '_sh', shade(sd.dust, .62), shade(sd.dust, 1.06), 41);
    const shMat = new THREE.MeshLambertMaterial({ map: shTex, vertexColors: true });
    [-1, 1].forEach(sgn => {
      const g = buildRibbon(P, step, 4,
        (i, k) => sgn * (P.width[i] + this.kerbW + this.shoulderW * (k / 4)),
        (i, k) => -0.02 - k * .05, [3, 9],
        (i, k, s, out) => { out.setHex(0xffffff).multiplyScalar(.8 + .2 * ((Math.sin(i * .31) + Math.sin(k * 2.1 + i * .07)) * .25 + .5)); });
      const m = new THREE.Mesh(g, shMat);
      m.receiveShadow = true;
      this.root.add(m);
    });
  }

  /* --- ramps / boost pads / gimmick furniture ----------------------------- */
  _buildFeatures() {
    const P = this.path, F = this.cfg.features || {};
    this.ramps = (F.ramps || []).map(r => ({ s0: r[0], s1: r[1], power: r[2], h: r[2] * .34 }));
    this.boosts = (F.boosts || []).map(b => ({ s0: b[0], s1: b[1], u0: b[2], u1: b[3] }));
    this.glideZones = (F.glide || []).map(g => ({ s0: g[0], s1: g[1] }));
    this.laneSwaps = (F.laneSwap || []).map(g => ({ s0: g[0], s1: g[1] }));

    // ramp wedges
    this.ramps.forEach(r => {
      const geo = buildRibbon(P, 1, 8,
        (i, k) => (-1 + 2 * k / 8) * (P.width[i] * .92),
        (i, k, s) => this.rampHeight(s) + .06,
        [1, 3], null, [r.s0, r.s1 + .004]);
      const mat = new THREE.MeshStandardMaterial({ color: 0x6a5f7a, roughness: .7, metalness: .25 });
      const m = new THREE.Mesh(geo, mat);
      m.receiveShadow = true; m.castShadow = false;
      this.root.add(m);
      // glowing lip so it reads before you reach it
      const lip = buildRibbon(P, 1, 4,
        (i, k) => (-1 + 2 * k / 4) * (P.width[i] * .92),
        (i, k, s) => this.rampHeight(s) + .14,
        [1, 1], null, [r.s1 - .006, r.s1 + .002]);
      const lm = energyMaterial(this.cfg.accent, 1.4, .9);
      this.animMats.push(lm);
      this.root.add(new THREE.Mesh(lip, lm));
      // chevrons on the ramp face
      const pad = buildRibbon(P, 1, 4,
        (i, k) => (-1 + 2 * k / 4) * (P.width[i] * .9),
        (i, k, s) => this.rampHeight(s) + .1,
        [1, 8], null, [r.s0, r.s1]);
      const pm = boostPadMaterial(0xffffff);
      this.animMats.push(pm);
      this.root.add(new THREE.Mesh(pad, pm));
    });

    // boost pads
    this.boosts.forEach(b => {
      const geo = buildRibbon(P, 1, 4,
        (i, k) => lerp(b.u0, b.u1, k / 4) * P.width[i],
        (i, k, s) => this.rampHeight(s) + .05,
        [1, 7], null, [b.s0, b.s1]);
      const mat = boostPadMaterial(0x59f0ff);
      this.animMats.push(mat);
      const m = new THREE.Mesh(geo, mat);
      m.renderOrder = 2;
      this.root.add(m);
    });

    // glide rings
    this.glideZones.forEach(z => {
      const n = 7;
      for (let k = 0; k < n; k++) {
        const s = lerp(z.s0 + .012, z.s1, k / (n - 1));
        const p = P.surfacePoint(s, 0, new THREE.Vector3());
        const g = new THREE.TorusGeometry(7.5, .34, 5, 22);
        const m = new THREE.Mesh(g, energyMaterial(this.cfg.accent, 1.1, .75));
        this.animMats.push(m.material);
        m.position.copy(p);
        m.position.y += 7 + k * 1.1;
        m.rotation.y = P.headingAt(s) + Math.PI / 2;
        m.rotation.x = Math.PI / 2;
        m.rotation.order = 'YXZ';
        m.lookAt(P.surfacePoint(s + .01, 0, _v0).setY(m.position.y));
        this.root.add(m);
      }
    });

    // lane-swap strips (two lanes that trade "lit" state every lap)
    this.laneStrips = [];
    this.laneSwaps.forEach(z => {
      [-1, 1].forEach(side => {
        const geo = buildRibbon(P, 1, 3,
          (i, k) => side * (P.width[i] * (.12 + .82 * k / 3)),
          (i, k, s) => this.rampHeight(s) + .05,
          [1, 7], null, [z.s0, z.s1]);
        const mat = boostPadMaterial(0x59f0ff);
        this.animMats.push(mat);
        const m = new THREE.Mesh(geo, mat);
        m.renderOrder = 2;
        this.root.add(m);
        this.laneStrips.push({ mesh: m, side, zone: z });
      });
    });

    // shortcut
    if (F.shortcut) {
      this.alt = new AltPath(F.shortcut);
      this._buildShortcut();
    }
    // geysers
    if (F.geysers) this._buildGeysers(F.geysers);
    // tunnel over the wall-ride
    if (F.tunnel) this._buildTunnel(F.tunnel);
  }

  /** Extra surface height from ramps at progress s. */
  rampHeight(s) {
    if (!this.ramps) return 0;
    for (let i = 0; i < this.ramps.length; i++) {
      const r = this.ramps[i];
      if (s >= r.s0 && s <= r.s1) {
        const t = (s - r.s0) / (r.s1 - r.s0);
        return r.h * Math.pow(t, 1.45);
      }
    }
    return 0;
  }
  rampAt(s) {
    if (!this.ramps) return -1;
    for (let i = 0; i < this.ramps.length; i++) if (s >= this.ramps[i].s0 && s <= this.ramps[i].s1) return i;
    return -1;
  }

  _buildShortcut() {
    const A = this.alt, def = A.def;
    const M = A.M;
    const pos = [], idx = [], uvs = [];
    const gap0 = def.gap ? def.gap[0] : 2, gap1 = def.gap ? def.gap[1] : 2;
    let vLen = 0;
    for (let i = 0; i < M; i++) {
      const t = i / (M - 1);
      const px = A.pos[i * 3], py = A.pos[i * 3 + 1], pz = A.pos[i * 3 + 2];
      if (i > 0) vLen += Math.hypot(px - A.pos[i * 3 - 3], pz - A.pos[i * 3 - 1]);
      const w = A.width * (1 - .25 * Math.abs(Math.sin(t * Math.PI * 3)) * 0);
      const rx = A.right[i * 3], rz = A.right[i * 3 + 2];
      const lift = (def.gapPower && (Math.abs(t - gap0) < .045)) ? def.gapPower * .18 * (1 - Math.abs(t - gap0) / .045) : 0;
      pos.push(px - rx * w, py + lift, pz - rz * w, px + rx * w, py + lift, pz + rz * w);
      uvs.push(0, vLen / 8, 1, vLen / 8);
    }
    for (let i = 0; i < M - 1; i++) {
      const t = i / (M - 1);
      if (def.gap && t > gap0 && t < gap1) continue;   // the ravine
      const a = i * 2, b = (i + 1) * 2;
      idx.push(a, a + 1, b, a + 1, b + 1, b);
    }
    const geo = new THREE.BufferGeometry();
    geo.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
    geo.setAttribute('uv', new THREE.Float32BufferAttribute(uvs, 2));
    geo.setIndex(idx);
    geo.computeVertexNormals();
    const sd = SURFACES[def.surf];
    const tex = groundTexture(this.cfg.id + '_alt', shade(sd.dust, .6), shade(sd.dust, 1.08), 77);
    const m = new THREE.Mesh(geo, new THREE.MeshLambertMaterial({ map: tex }));
    m.receiveShadow = true;
    this.root.add(m);

    // entry/exit gate markers
    [0, 1].forEach(e => {
      const i = e ? M - 1 : 0;
      const p = new THREE.Vector3(A.pos[i * 3], A.pos[i * 3 + 1], A.pos[i * 3 + 2]);
      const g = new THREE.TorusGeometry(A.width * 1.15, .3, 4, 16, Math.PI);
      const mm = new THREE.Mesh(g, energyMaterial(0xffc44a, 1, .8));
      this.animMats.push(mm.material);
      mm.position.copy(p).setY(p.y + .1);
      mm.rotation.y = Math.atan2(A.right[i * 3], A.right[i * 3 + 2]);
      this.root.add(mm);
    });
    // ravine walls so the gap reads as a real hole
    const gi0 = Math.floor(gap0 * (M - 1)), gi1 = Math.ceil(gap1 * (M - 1));
    const wp = [], wi = [];
    for (let i = gi0; i <= gi1; i++) {
      const px = A.pos[i * 3], py = A.pos[i * 3 + 1], pz = A.pos[i * 3 + 2];
      const rx = A.right[i * 3], rz = A.right[i * 3 + 2];
      for (const sgn of [-1, 1]) {
        wp.push(px + rx * sgn * A.width, py, pz + rz * sgn * A.width);
        wp.push(px + rx * sgn * (A.width + 3), def.floor || -16, pz + rz * sgn * (A.width + 3));
      }
    }
    const per = 4;
    for (let i = 0; i < gi1 - gi0; i++) {
      const a = i * per, b = (i + 1) * per;
      wi.push(a, b, a + 1, a + 1, b, b + 1);
      wi.push(a + 2, a + 3, b + 2, a + 3, b + 3, b + 2);
    }
    const wg = new THREE.BufferGeometry();
    wg.setAttribute('position', new THREE.Float32BufferAttribute(wp, 3));
    wg.setIndex(wi);
    wg.computeVertexNormals();
    this.root.add(new THREE.Mesh(wg, new THREE.MeshPhongMaterial({ color: shade(this.cfg.env.ground, .5), side: THREE.DoubleSide, flatShading: true, shininess: 3 })));

    // where the shortcut meets the main road, open the barrier
    const q = { d: 0, t: 0, y: 0, i: 0 };
    const pr = {};
    this.barrierGaps = [];
    [0, M - 1].forEach(i => {
      this.path.project(A.pos[i * 3], A.pos[i * 3 + 1], A.pos[i * 3 + 2], null, pr);
      this.barrierGaps.push([pr.s - .014, pr.s + .014, sign(pr.u)]);
    });
  }

  _buildGeysers(n) {
    this.geysers = [];
    const geo = new THREE.CylinderGeometry(1.5, 2.6, 14, 8, 1, true);
    geo.translate(0, 7, 0);
    for (let i = 0; i < n; i++) {
      const mat = new THREE.MeshBasicMaterial({
        color: 0xff7a2a, transparent: true, opacity: .85, side: THREE.DoubleSide,
        blending: THREE.AdditiveBlending, depthWrite: false
      });
      const m = new THREE.Mesh(geo, mat);
      m.visible = false;
      this.root.add(m);
      const vent = new THREE.Mesh(new THREE.TorusGeometry(2.2, .45, 4, 12),
        new THREE.MeshLambertMaterial({ color: 0x3a2018, emissive: 0x1a0800 }));
      vent.rotation.x = Math.PI / 2;
      this.root.add(vent);
      const lt = new THREE.PointLight(0xff5a10, 0, 34);
      this.root.add(lt);
      this.geysers.push({ mesh: m, vent, light: lt, s: 0, u: 0, phase: 0, period: 3.2 + i * .23, active: false });
    }
    this._placeGeysers(0);
  }

  _placeGeysers(lap) {
    if (!this.geysers) return;
    const rng = makeRng(0x9E37 + lap * 7717);
    const P = this.path;
    this.geysers.forEach((gy, i) => {
      let s, tries = 0;
      do {
        s = rng();
        tries++;
      } while (tries < 24 && (this.rampAt(s) >= 0 || this._nearBoost(s) || Math.abs(this.prog(s)) < .04));
      gy.s = s;
      gy.u = rng.range(-.72, .72) * P.widthAt(s);
      gy.phase = rng() * gy.period;
      const p = P.surfacePoint(s, gy.u, new THREE.Vector3());
      gy.mesh.position.copy(p);
      gy.vent.position.copy(p).setY(p.y + .07);
      gy.light.position.copy(p).setY(p.y + 3);
    });
  }
  _nearBoost(s) {
    for (let i = 0; i < this.boosts.length; i++) if (s > this.boosts[i].s0 - .02 && s < this.boosts[i].s1 + .02) return true;
    return false;
  }

  /**
   * The Shell Barrel'sarchitecture: open ribs rather than a closed tube, so
   * the banked section still frames the drama instead of hiding it.
   */
  _buildTunnel(range) {
    const P = this.path;
    const ribs = 16;
    const right = new THREE.Vector3(), up = new THREE.Vector3(), tan = new THREE.Vector3();
    const basis = new THREE.Matrix4();
    for (let n = 0; n < ribs; n++) {
      const s = lerp(range[0], range[1], n / (ribs - 1));
      const i = P.idxOf(s);
      const r = P.widthAt(s) + this.kerbW + 2.4;
      const geo = new THREE.TorusGeometry(r, .55, 6, 22, Math.PI);
      right.set(P.right[i * 3], P.right[i * 3 + 1], P.right[i * 3 + 2]).normalize();
      up.set(P.up[i * 3], P.up[i * 3 + 1], P.up[i * 3 + 2]).normalize();
      tan.set(P.tan[i * 3], P.tan[i * 3 + 1], P.tan[i * 3 + 2]).normalize();
      basis.makeBasis(right, up, tan);
      const m = new THREE.Mesh(geo, this._ribMat || (this._ribMat = new THREE.MeshStandardMaterial({
        color: 0x2f8f9c, roughness: .5, metalness: .35, emissive: 0x0d3a42
      })));
      P.surfacePoint(s, 0, m.position);
      m.quaternion.setFromRotationMatrix(basis);
      m.castShadow = false;
      this.root.add(m);
    }
    // light strips running the length of the barrel, level with the road
    for (const sgn of [-1, 1]) {
      const g = buildRibbon(P, 1, 1,
        (i, k) => sgn * (P.width[i] + this.kerbW + .45 + k * .5),
        (i, k) => .12 + k * .02,
        [1, 5], null, [range[0] - .01, range[1] + .01]);
      const em = energyMaterial(this.cfg.accent, .8, .9);
      this.animMats.push(em);
      this.root.add(new THREE.Mesh(g, em));
    }
  }

  /* --- barriers ----------------------------------------------------------- */
  _buildBarrier() {
    const P = this.path, cfg = this.cfg, b = cfg.barrier;
    this.wallSolid = b.solid !== false;
    this.wallHeight = b.height;
    const step = 2;
    const gaps = this.barrierGaps || [];
    const inGap = (s, sgn) => {
      for (let i = 0; i < gaps.length; i++) {
        const g = gaps[i];
        if (sign(g[2]) === sgn && ((s > g[0] && s < g[1]) || (g[0] < 0 && (s > g[0] + 1 || s < g[1])))) return true;
      }
      return false;
    };
    const tex = canvasTexture('bar_' + cfg.id, 128, 64, (g, w, h) => {
      noiseFill(g, w, h, 18, shade(b.color, .6), shade(b.color, 1.15), 33, 2);
      g.globalAlpha = .5;
      if (b.style === 'girder') {
        g.fillStyle = '#141414';
        for (let x = 0; x < w; x += 24) g.fillRect(x, 0, 5, h);
        g.fillStyle = '#ffb43a'; g.globalAlpha = .8;
        for (let x = 12; x < w; x += 48) g.fillRect(x, h * .3, 12, h * .2);
      } else if (b.style === 'rock') {
        g.fillStyle = '#000';
        for (let i = 0; i < 30; i++) g.fillRect(Math.random() * w, Math.random() * h, 3 + Math.random() * 12, 2 + Math.random() * 6);
      } else if (b.style === 'crystal') {
        g.fillStyle = '#cfe6ff';
        for (let x = 0; x < w; x += 16) { g.beginPath(); g.moveTo(x, h); g.lineTo(x + 8, h * .1); g.lineTo(x + 16, h); g.fill(); }
      } else {
        g.fillStyle = '#ffd0e0';
        for (let i = 0; i < 24; i++) { g.beginPath(); g.arc(Math.random() * w, Math.random() * h, 2 + Math.random() * 7, 0, TAU); g.fill(); }
      }
      g.globalAlpha = 1;
    }, { repeat: [1, 1] });

    for (const sgn of [-1, 1]) {
      const pos = [], nor = [], uv = [], idx = [];
      let v = 0, run = 0, ringMap = [];
      for (let r = 0; r * step < P.N; r++) {
        const i = (r * step) % P.N;
        const s = i / P.N;
        if (r > 0) run += P.ds * step;
        const skip = inGap(s, sgn);
        ringMap.push(skip ? -1 : v);
        if (skip) continue;
        const u = sgn * this.wallAt(i);
        const bx = P.pos[i * 3] + P.right[i * 3] * u;
        const by = P.pos[i * 3 + 1] + P.right[i * 3 + 1] * u - .2;
        const bz = P.pos[i * 3 + 2] + P.right[i * 3 + 2] * u;
        const ux = P.up[i * 3], uy = P.up[i * 3 + 1], uz = P.up[i * 3 + 2];
        pos.push(bx, by, bz, bx + ux * b.height, by + uy * b.height, bz + uz * b.height);
        const nx = -sgn * P.right[i * 3], ny = -sgn * P.right[i * 3 + 1], nz = -sgn * P.right[i * 3 + 2];
        nor.push(nx, ny, nz, nx, ny, nz);
        uv.push(run / 9, 0, run / 9, 1);
        v += 2;
      }
      for (let r = 0; r < ringMap.length; r++) {
        const a = ringMap[r], bb = ringMap[(r + 1) % ringMap.length];
        if (a < 0 || bb < 0) continue;
        if (sgn > 0) idx.push(a, bb, a + 1, a + 1, bb, bb + 1);
        else idx.push(a, a + 1, bb, a + 1, bb + 1, bb);
      }
      const geo = new THREE.BufferGeometry();
      geo.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
      geo.setAttribute('normal', new THREE.Float32BufferAttribute(nor, 3));
      geo.setAttribute('uv', new THREE.Float32BufferAttribute(uv, 2));
      geo.setIndex(idx);
      const mat = new THREE.MeshLambertMaterial({
        map: tex, side: THREE.DoubleSide,
        emissive: b.style === 'crystal' ? 0x2a3a7a : 0x000000
      });
      const m = new THREE.Mesh(geo, mat);
      m.castShadow = false; m.receiveShadow = true;
      this.root.add(m);
    }
  }

  /* --- outer terrain ------------------------------------------------------ */

  /** Lateral offset of terrain column t (0..1) beside sample i. */
  terrainU(i, t) { return this.wallAt(i) + Math.pow(t, 1.7) * this.reach[i]; }
  /** Height of the terrain, relative to the centreline, at column t. */
  terrainY(i, t) {
    if (t < .02) return -.3;
    const n = Math.sin(i * .11 + t * 11.9) * .5 + Math.sin(i * .043 + t * 6.3) * .5;
    // always descends away from the track, so scenery never walls off the sky
    return -1.4 - t * this.terrainFall + (n - .3) * t * (this.cfg.water ? 5 : 11);
  }
  /** Inverse of terrainU: which column a lateral offset falls in. */
  terrainT(i, au) {
    return clamp01(Math.pow(Math.max(0, au - this.wallAt(i)) / this.reach[i], 1 / 1.7));
  }

  /**
   * How far the terrain apron may extend beside each sample before it would
   * run into another part of the circuit. Without this the two aprons overlap
   * inside the loop and z-fight.
   */
  _buildReach() {
    const P = this.path, N = P.N;
    const reach = this.reach = new Float32Array(N);
    const minArc = Math.floor(240 / P.ds);
    for (let i = 0; i < N; i++) {
      let best = 1e9;
      for (let j = 0; j < N; j += 6) {
        const arc = Math.min((j - i + N) % N, (i - j + N) % N);
        if (arc < minArc) continue;
        const dx = P.pos[i * 3] - P.pos[j * 3], dz = P.pos[i * 3 + 2] - P.pos[j * 3 + 2];
        const d = dx * dx + dz * dz;
        if (d < best) best = d;
      }
      reach[i] = clamp(Math.sqrt(best) * .46, 45, this.terrainOuter);
    }
    // smooth so the apron edge is a flowing landform, not a sawtooth
    const sm = new Float32Array(N);
    for (let i = 0; i < N; i++) {
      let acc = 0;
      for (let k = -22; k <= 22; k++) acc += reach[(i + k + N) % N];
      sm[i] = acc / 45;
    }
    reach.set(sm);
  }

  _buildTerrain() {
    const P = this.path, cfg = this.cfg;
    this.terrainOuter = 300;
    this.terrainFall = cfg.water ? 34 : 17;
    this._buildReach();
    const tex = groundTexture(cfg.id + '_gnd', shade(cfg.env.ground, .58), shade(cfg.env.ground, 1.14), 17);
    const mat = new THREE.MeshLambertMaterial({ map: tex, vertexColors: true });
    const cols = 9;
    // One ribbon per side. (Building it as a single strip across both sides
    // would bridge a quad straight over the racing surface.)
    for (const sgn of [-1, 1]) {
      const geo = buildRibbon(P, 4, cols,
        (i, k) => sgn * this.terrainU(i, k / cols),
        (i, k) => this.terrainY(i, k / cols),
        [10, 26],
        (i, k, s, out) => {
          const t = k / cols;
          out.setHex(0xffffff).multiplyScalar(lerp(1.0, .62, t) * (.9 + .1 * Math.sin(i * .23 + k)));
        });
      geo.computeVertexNormals();
      const m = new THREE.Mesh(geo, mat);
      m.receiveShadow = true;
      this.root.add(m);
    }
    this._buildBackdrop(tex, mat);
  }

  /**
   * Closes the world: a wide floor plus a ring of distant hills, so the
   * landscape never simply stops at the edge of the terrain ribbon.
   */
  _buildBackdrop(tex, mat) {
    const P = this.path, b = P.bounds, cfg = this.cfg;
    let lowY = 1e9;
    for (let i = 0; i < P.N; i++) lowY = Math.min(lowY, P.pos[i * 3 + 1]);
    const floorY = lowY - this.terrainFall - 6;
    this.floorY = floorY;

    if (!cfg.water) {
      const g = new THREE.CircleGeometry(2400, 40);
      g.rotateX(-Math.PI / 2);
      const m = new THREE.Mesh(g, new THREE.MeshLambertMaterial({
        color: shade(cfg.env.ground, .74), polygonOffset: true, polygonOffsetFactor: 2, polygonOffsetUnits: 2
      }));
      m.position.set(b.cx, floorY - 1, b.cz);
      this.root.add(m);
    }

    // distant hills: one instanced cone ring, two draw calls total
    const rng = makeRng(0x5EED);
    const n = 96;
    const geo = new THREE.ConeGeometry(1, 1, 7);
    geo.translate(0, .5, 0);
    // tinted toward the fog colour so they read as distance, not as objects
    const hillCol = hexLerp(shade(cfg.env.ground, .8), cfg.env.fog, .42);
    const im = new THREE.InstancedMesh(geo, new THREE.MeshLambertMaterial({ color: hillCol }), n);
    const mtx = new THREE.Matrix4(), q = new THREE.Quaternion(), sc = new THREE.Vector3(), pv = new THREE.Vector3();
    const radius = Math.max(b.w, b.h) * .58 + 780;
    for (let i = 0; i < n; i++) {
      const a = (i / n) * TAU + rng.range(-.03, .03);
      const r = radius * rng.range(.9, 1.9);
      const s = rng.range(70, 200) * (r / radius);
      q.setFromAxisAngle(_v0.set(0, 1, 0), rng() * TAU);
      sc.set(s, s * rng.range(.22, .46), s);
      pv.set(b.cx + Math.cos(a) * r, floorY - 6, b.cz + Math.sin(a) * r);
      mtx.compose(pv, q, sc);
      im.setMatrixAt(i, mtx);
    }
    im.instanceMatrix.needsUpdate = true;
    this.root.add(im);
  }

  /* --- sky, lights, water, aurora ---------------------------------------- */
  _buildEnvironment() {
    const e = this.cfg.env;

    // gradient sky dome
    const skyGeo = new THREE.SphereGeometry(2600, 24, 16);
    const skyMat = new THREE.ShaderMaterial({
      side: THREE.BackSide, depthWrite: false, fog: false,
      uniforms: {
        uTop: { value: new THREE.Color(e.skyTop) },
        uMid: { value: new THREE.Color(e.skyMid) },
        uBot: { value: new THREE.Color(e.skyBot) },
        uSun: { value: new THREE.Vector3(e.sunDir[0], e.sunDir[1], e.sunDir[2]).normalize() },
        uSunCol: { value: new THREE.Color(e.sunCol) },
        uStars: { value: e.star || 0 },
        uAurora: { value: e.aurora || 0 },
        uTime: { value: 0 }
      },
      vertexShader: `varying vec3 vDir;
        void main(){ vDir = normalize(position); gl_Position = projectionMatrix * modelViewMatrix * vec4(position,1.0); }`,
      fragmentShader: `
        uniform vec3 uTop,uMid,uBot,uSunCol; uniform vec3 uSun;
        uniform float uStars,uAurora,uTime; varying vec3 vDir;
        float hash(vec3 p){ return fract(sin(dot(p,vec3(12.9898,78.233,45.164)))*43758.5453); }
        float noise(vec3 p){
          vec3 i=floor(p), f=fract(p); f=f*f*(3.0-2.0*f);
          return mix(mix(mix(hash(i),hash(i+vec3(1,0,0)),f.x),mix(hash(i+vec3(0,1,0)),hash(i+vec3(1,1,0)),f.x),f.y),
                     mix(mix(hash(i+vec3(0,0,1)),hash(i+vec3(1,0,1)),f.x),mix(hash(i+vec3(0,1,1)),hash(i+vec3(1,1,1)),f.x),f.y),f.z);
        }
        void main(){
          vec3 d = normalize(vDir);
          float h = d.y*0.5+0.5;
          vec3 col = mix(uBot, uMid, smoothstep(0.35,0.56,h));
          col = mix(col, uTop, smoothstep(0.52,0.95,h));
          // sun disc + bloom halo
          float sd = max(dot(d, normalize(uSun)), 0.0);
          col += uSunCol * pow(sd, 900.0) * 4.0;
          col += uSunCol * pow(sd, 12.0) * 0.34;
          col += uSunCol * pow(sd, 3.0) * 0.09;
          if(uStars > 0.5){
            float st = hash(floor(d*260.0));
            float tw = 0.5+0.5*sin(uTime*2.0+st*90.0);
            col += vec3(0.85,0.9,1.0) * smoothstep(0.9965,0.9995,st) * tw * smoothstep(0.05,0.4,d.y);
          }
          if(uAurora > 0.5 && d.y > -0.02){
            float band = noise(vec3(d.x*3.2, d.z*3.2, uTime*0.09));
            float band2 = noise(vec3(d.x*7.0+3.0, d.z*7.0, uTime*0.13));
            float mask = smoothstep(0.02,0.5,d.y)*smoothstep(1.0,0.35,d.y);
            float a = pow(max(band*0.7+band2*0.5-0.42,0.0), 1.6)*mask*2.4;
            col += mix(vec3(0.25,1.0,0.6), vec3(0.5,0.35,1.0), band2) * a;
          }
          // subtle dithering keeps big gradients from banding
          col += (hash(vec3(gl_FragCoord.xy,1.0))-0.5)*0.008;
          gl_FragColor = vec4(col,1.0);
        }`
    });
    this.sky = new THREE.Mesh(skyGeo, skyMat);
    this.sky.frustumCulled = false;
    this.skyMat = skyMat;
    this.root.add(this.sky);

    if (this.cfg.water) this._buildWater();
  }

  _buildWater() {
    const w = this.cfg.water;
    const geo = new THREE.PlaneGeometry(4200, 4200, 60, 60);
    geo.rotateX(-Math.PI / 2);
    const mat = new THREE.ShaderMaterial({
      uniforms: {
        uTime: { value: 0 },
        uShallow: { value: new THREE.Color(w.color) },
        uDeep: { value: new THREE.Color(w.deep) },
        uSky: { value: new THREE.Color(this.cfg.env.skyMid) },
        uSun: { value: new THREE.Vector3(...this.cfg.env.sunDir).normalize() },
        uFogCol: { value: new THREE.Color(this.cfg.env.fog) },
        uFogNear: { value: this.cfg.env.fogNear },
        uFogFar: { value: this.cfg.env.fogFar }
      },
      vertexShader: `
        uniform float uTime; varying vec3 vW; varying vec3 vN; varying float vFog;
        float wv(vec2 p, vec2 d, float f, float sp, float t){ return sin(dot(p,d)*f + t*sp); }
        void main(){
          vec3 p = position;
          vec2 xz = p.xz;
          float h = 0.0;
          h += wv(xz, normalize(vec2(1.0,0.3)), 0.035, 1.1, uTime)*0.55;
          h += wv(xz, normalize(vec2(-0.4,1.0)), 0.062, 1.5, uTime)*0.32;
          h += wv(xz, normalize(vec2(0.7,-0.7)), 0.11, 2.2, uTime)*0.16;
          p.y += h;
          // analytic-ish normal from neighbouring wave samples
          float e = 2.0;
          float hx = wv(xz+vec2(e,0.0), normalize(vec2(1.0,0.3)),0.035,1.1,uTime)*0.55
                   + wv(xz+vec2(e,0.0), normalize(vec2(-0.4,1.0)),0.062,1.5,uTime)*0.32;
          float hz = wv(xz+vec2(0.0,e), normalize(vec2(1.0,0.3)),0.035,1.1,uTime)*0.55
                   + wv(xz+vec2(0.0,e), normalize(vec2(-0.4,1.0)),0.062,1.5,uTime)*0.32;
          vN = normalize(vec3(h-hx, e, h-hz));
          vec4 mv = modelViewMatrix * vec4(p,1.0);
          vW = (modelMatrix*vec4(p,1.0)).xyz;
          vFog = -mv.z;
          gl_Position = projectionMatrix * mv;
        }`,
      fragmentShader: `
        uniform vec3 uShallow,uDeep,uSky,uSun,uFogCol; uniform float uTime,uFogNear,uFogFar;
        varying vec3 vW; varying vec3 vN; varying float vFog;
        void main(){
          vec3 V = normalize(cameraPosition - vW);
          float fres = pow(1.0 - max(dot(V, vN),0.0), 3.0);
          vec3 col = mix(uDeep, uShallow, clamp(vN.y*1.2-0.1,0.0,1.0));
          col = mix(col, uSky, fres*0.85);
          vec3 H = normalize(normalize(uSun) + V);
          col += vec3(1.0,0.96,0.86) * pow(max(dot(vN,H),0.0), 180.0) * 1.7;
          float sparkle = pow(max(dot(vN,H),0.0), 42.0)*0.25;
          col += vec3(0.6,0.9,1.0)*sparkle;
          float f = smoothstep(uFogNear, uFogFar, vFog);
          col = mix(col, uFogCol, f);
          gl_FragColor = vec4(col, 1.0);
        }`
    });
    this.waterMat = mat;
    const m = new THREE.Mesh(geo, mat);
    m.position.y = this.cfg.water.level;
    m.frustumCulled = false;
    this.root.add(m);
  }

  /* --- scenery ------------------------------------------------------------ */
  _buildDecor() {
    const P = this.path, cfg = this.cfg, rng = makeRng(0xBEEF);
    const CH = 12;
    for (let c = 0; c < CH; c++) {
      const g = new THREE.Group();
      g.userData.s = (c + .5) / CH;
      const p = P.surfacePoint(g.userData.s, 0, new THREE.Vector3());
      g.userData.center = p;
      this.root.add(g);
      this.chunks.push({ group: g, center: p, radius: P.length / CH * .5 + 640 });
    }
    (cfg.decor || []).forEach(d => {
      const proto = DecorLib.get(d.kind, cfg.env);
      // one InstancedMesh per (kind, chunk)
      const buckets = [];
      for (let c = 0; c < CH; c++) buckets.push([]);
      for (let i = 0; i < d.count; i++) {
        const s = rng();
        const side = rng() < .5 ? -1 : 1;
        const u = side * rng.range(d.u[0], d.u[1]);
        const sc = rng.range(d.scale[0], d.scale[1]);
        const rot = rng() * TAU;
        // keep scenery off the racing surface
        const idx = P.idxOf(s);
        const wall = this.wallAt(idx);
        const au = Math.abs(u);
        if (au < wall + 3) continue;
        // sit it on the terrain surface, using the same profile the mesh uses,
        // so nothing floats or sinks
        const t = this.terrainT(idx, au);
        const flatRight = _v1.set(-P.tan[idx * 3 + 2], 0, P.tan[idx * 3]).normalize();
        let y = P.pos[idx * 3 + 1] + this.terrainY(idx, t);
        const x = P.pos[idx * 3] + flatRight.x * u;
        const z = P.pos[idx * 3 + 2] + flatRight.z * u;
        if (cfg.water) {
          const under = y < cfg.water.level + .5;
          if (under && d.kind !== 'buoy' && d.kind !== 'islet') continue;
          if (d.kind === 'buoy') y = cfg.water.level - .3;
          if (d.kind === 'islet') y = cfg.water.level - 1.5;
        }
        if (d.kind === 'balloon') y += rng.range(14, 46);
        buckets[Math.min(CH - 1, Math.floor(s * CH))].push({ x, y, z, sc, rot });
      }
      for (let c = 0; c < CH; c++) {
        const list = buckets[c];
        if (!list.length) continue;
        const im = new THREE.InstancedMesh(proto.geo, proto.mat, list.length);
        im.castShadow = false; im.receiveShadow = false;
        const mtx = new THREE.Matrix4(), q = new THREE.Quaternion(), sv = new THREE.Vector3(), pv = new THREE.Vector3();
        for (let i = 0; i < list.length; i++) {
          const o = list[i];
          q.setFromAxisAngle(_v0.set(0, 1, 0), o.rot);
          sv.set(o.sc, o.sc, o.sc);
          pv.set(o.x, o.y, o.z);
          mtx.compose(pv, q, sv);
          im.setMatrixAt(i, mtx);
        }
        im.instanceMatrix.needsUpdate = true;
        im.frustumCulled = true;
        this.chunks[c].group.add(im);
      }
    });
  }

  /* --- start/finish furniture --------------------------------------------- */
  _buildStartLine() {
    const P = this.path, s = this.startS;
    const w = P.widthAt(s);
    const geo = buildRibbon(P, 1, 4,
      (i, k) => (-1 + 2 * k / 4) * P.width[i],
      () => .06, [4, 3], null, [s - .0035, s + .0035]);
    const mat = new THREE.MeshBasicMaterial({ map: checkerTexture() });
    this.root.add(new THREE.Mesh(geo, mat));

    // gantry
    const p = P.surfacePoint(s, 0, new THREE.Vector3());
    const head = P.headingAt(s);
    const g = new THREE.Group();
    g.position.copy(p);
    g.rotation.y = head;
    const postGeo = new THREE.BoxGeometry(1.3, 12, 1.3);
    const postMat = new THREE.MeshStandardMaterial({ color: 0x2b3140, roughness: .6, metalness: .5 });
    for (const sgn of [-1, 1]) {
      const m = new THREE.Mesh(postGeo, postMat);
      m.position.set(sgn * (w + 2.4), 6, 0);
      m.castShadow = true;
      g.add(m);
    }
    const beam = new THREE.Mesh(new THREE.BoxGeometry((w + 3) * 2, 2.4, 1.6), postMat);
    beam.position.y = 12.4;
    beam.castShadow = true;
    g.add(beam);
    const bandMat = energyMaterial(this.cfg.accent, .7, .95);
    this.animMats.push(bandMat);
    const band = new THREE.Mesh(new THREE.BoxGeometry((w + 3) * 2 - 1, .5, 1.75), bandMat);
    band.position.y = 11.1;
    g.add(band);
    // start lights
    this.startLights = [];
    for (let i = 0; i < 5; i++) {
      const m = new THREE.Mesh(new THREE.SphereGeometry(.65, 10, 8),
        new THREE.MeshBasicMaterial({ color: 0x220505 }));
      m.position.set((i - 2) * 2.3, 13.2, 0);
      g.add(m);
      this.startLights.push(m);
    }
    this.root.add(g);

    // grandstands facing the straight
    const standMat = new THREE.MeshPhongMaterial({ color: 0x39415a, flatShading: true, shininess: 5 });
    const crowdTex = canvasTexture('crowd', 128, 64, (gg, ww, hh) => {
      gg.fillStyle = '#1b2033'; gg.fillRect(0, 0, ww, hh);
      const rng = makeRng(9);
      for (let i = 0; i < 900; i++) {
        gg.fillStyle = 'hsl(' + (rng() * 360 | 0) + ',60%,' + (35 + rng() * 40 | 0) + '%)';
        gg.fillRect(rng() * ww, rng() * hh, 2, 3);
      }
    });
    const crowdMat = new THREE.MeshLambertMaterial({ map: crowdTex });
    for (let k = 0; k < 5; k++) {
      const ss = s - .012 + k * .006;
      const sp = P.surfacePoint(ss, 0, new THREE.Vector3());
      const hd = P.headingAt(ss);
      for (const sgn of [-1, 1]) {
        const st = new THREE.Group();
        st.position.copy(sp);
        st.rotation.y = hd;
        const base = new THREE.Mesh(new THREE.BoxGeometry(9, 7, 13), standMat);
        base.position.set(sgn * (P.widthAt(ss) + this.shoulderW + 8), 3.5, 0);
        st.add(base);
        const seats = new THREE.Mesh(new THREE.PlaneGeometry(13, 7), crowdMat);
        seats.position.set(sgn * (P.widthAt(ss) + this.shoulderW + 3.9), 4.2, 0);
        seats.rotation.y = sgn * Math.PI / 2;
        seats.rotation.x = -.35;
        st.add(seats);
        this.root.add(st);
      }
    }
  }

  _buildMinimap() {
    const P = this.path, b = P.bounds;
    const pad = 20;
    const scale = 1 / Math.max(b.w, b.h);
    const pts = [];
    for (let i = 0; i < P.N; i += 8) {
      pts.push((P.pos[i * 3] - b.cx) * scale, (P.pos[i * 3 + 2] - b.cz) * scale);
    }
    this.map = { pts, scale, cx: b.cx, cz: b.cz };
  }
  mapX(x) { return (x - this.map.cx) * this.map.scale; }
  mapZ(z) { return (z - this.map.cz) * this.map.scale; }

  /* --- grid ---------------------------------------------------------------- */
  gridSlot(n, total) {
    const P = this.path;
    const row = Math.floor(n / 2), col = (n % 2) ? 1 : -1;
    const back = 0.010 + row * 0.0068;
    const s = this.startS - back;
    const u = col * (P.widthAt(s) * .42);
    const p = P.surfacePoint(s, u, new THREE.Vector3());
    return { pos: p, yaw: P.headingAt(s), s: ((s % 1) + 1) % 1, u };
  }

  /* --- respawn ------------------------------------------------------------- */
  respawnAt(s, u) {
    const P = this.path;
    const su = clamp(u || 0, -P.widthAt(s) * .55, P.widthAt(s) * .55);
    const p = P.surfacePoint(s, su, new THREE.Vector3());
    p.y += 1.2;
    return { pos: p, yaw: P.headingAt(s) };
  }

  /* --- THE surface query --------------------------------------------------- */
  query(x, y, z, hint, out) {
    const P = this.path;
    P.project(x, y, z, hint, out);
    const W = out.width;
    const au = Math.abs(out.u);
    const s = out.s;
    out.kerb = false; out.alt = false; out.boost = false; out.fell = false; out.wall = 0;

    // ramps lift the surface
    const rh = this.rampHeight(s);
    out.ramp = this.rampAt(s);
    out.height += rh;

    const wallU = W + this.kerbW + this.shoulderW;
    if (au <= W) out.surf = SURF.ROAD;
    else if (au <= W + this.kerbW) { out.surf = SURF.ROAD; out.kerb = true; }
    else if (au <= wallU) out.surf = this.cfg.shoulder;
    else out.surf = this.cfg.outer;

    // barrier
    if (au > wallU) {
      const gapped = this._inBarrierGap(s, sign(out.u));
      if (this.wallSolid && !gapped) out.wall = sign(out.u) * (au - wallU);
      else if (!this.wallSolid) {
        // no wall — you're over the edge
        out.height = out.height - (au - wallU) * 1.35;
        if (au > wallU + 4) out.fell = true;
      }
    }

    // boost pads
    for (let i = 0; i < this.boosts.length; i++) {
      const b = this.boosts[i];
      if (s >= b.s0 && s <= b.s1) {
        const uu = out.u / W;
        if (uu >= Math.min(b.u0, b.u1) && uu <= Math.max(b.u0, b.u1)) { out.boost = true; out.surf = SURF.BOOST; }
      }
    }
    // lane-swap strips: lit lane boosts, dark lane is slick
    for (let i = 0; i < this.laneSwaps.length; i++) {
      const z = this.laneSwaps[i];
      if (s >= z.s0 && s <= z.s1) {
        const litSide = (this.lapPhase & 1) ? 1 : -1;
        const side = sign(out.u) || 1;
        if (au < W * .95) {
          if (side === litSide) { out.boost = true; out.surf = SURF.BOOST; }
          else out.surf = SURF.ICE;
        }
      }
    }
    // glide zones
    out.glide = false;
    for (let i = 0; i < this.glideZones.length; i++) {
      const g = this.glideZones[i];
      if (s >= g.s0 && s <= g.s1) out.glide = true;
    }

    // shortcut: if we're inside the alternate ribbon and it's nearer, use it
    if (this.alt) {
      const q = this.alt.query(x, z, _altQ);
      if (q.d < this.alt.width && q.d < au) {
        const def = this.alt.def;
        if (def.gap && q.t > def.gap[0] && q.t < def.gap[1]) {
          out.height = def.floor || -16;
          out.surf = SURF.VOID;
          out.fell = y < (def.floor || -16) + 6;
        } else {
          out.height = q.y;
          out.surf = def.surf;
          if (def.boost && q.t > def.boost[0] && q.t < def.boost[1]) { out.boost = true; out.surf = SURF.BOOST; }
        }
        out.alt = true;
        out.altT = q.t;
        out.wall = 0;
        out.kerb = false;
      }
    }
    out.onRoad = au <= W + this.kerbW || out.alt;
    return out;
  }

  _inBarrierGap(s, sgn) {
    const gaps = this.barrierGaps;
    if (!gaps) return false;
    for (let i = 0; i < gaps.length; i++) {
      const g = gaps[i];
      if (sign(g[2]) !== sgn) continue;
      const a = ((g[0] % 1) + 1) % 1, b = ((g[1] % 1) + 1) % 1;
      if (a < b ? (s > a && s < b) : (s > a || s < b)) return true;
    }
    return false;
  }

  /* --- per-frame ----------------------------------------------------------- */
  update(dt, cams) {
    this.time += dt;
    for (let i = 0; i < this.animMats.length; i++) this.animMats[i].uniforms.uTime.value = this.time;
    if (this.skyMat) this.skyMat.uniforms.uTime.value = this.time;
    if (this.waterMat) this.waterMat.uniforms.uTime.value = this.time;

    // geysers
    if (this.geysers) {
      for (let i = 0; i < this.geysers.length; i++) {
        const g = this.geysers[i];
        g.phase += dt;
        const t = (g.phase % g.period) / g.period;
        const up = t > .62 ? smoothstep(.62, .72, t) * smoothstep(1.0, .86, t) : 0;
        g.active = up > .28;
        g.mesh.visible = up > .01;
        g.mesh.scale.set(.5 + up * .8, up * 1.25, .5 + up * .8);
        g.mesh.material.opacity = up * .9;
        g.light.intensity = up * 6;
        // telegraph: the vent glows just before it fires
        const warn = smoothstep(.42, .62, t) * (1 - up);
        g.vent.material.emissive.setRGB(.1 + warn * 1.4, .03 + warn * .35, 0);
      }
    }

    // lane strips follow the current lap phase
    if (this.laneStrips) {
      const lit = (this.lapPhase & 1) ? 1 : -1;
      for (let i = 0; i < this.laneStrips.length; i++) {
        const L = this.laneStrips[i];
        const on = L.side === lit;
        L.mesh.material.uniforms.uColor.value.setHex(on ? 0x59f0ff : 0x2a3550);
      }
    }

    // chunk culling / LOD
    if (cams && cams.length) {
      for (let i = 0; i < this.chunks.length; i++) {
        const c = this.chunks[i];
        let vis = false;
        for (let k = 0; k < cams.length; k++) {
          if (c.center.distanceToSquared(cams[k]) < c.radius * c.radius) { vis = true; break; }
        }
        if (c.group.visible !== vis) c.group.visible = vis;
      }
    }
  }

  onLap(lap) {
    this.lapPhase = lap;
    if (this.geysers) this._placeGeysers(lap);
  }

  dispose() {
    this.root.traverse(o => {
      if (o.geometry) o.geometry.dispose();
      if (o.material) {
        if (Array.isArray(o.material)) o.material.forEach(m => m.dispose());
        else o.material.dispose();
      }
    });
  }
}

const _altQ = { d: 0, t: 0, y: 0, i: 0 };
