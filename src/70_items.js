/* ============================================================================
   ITEMS — pickup boxes, position-weighted distribution, projectiles, hazards.
   Everything here is pooled; nothing is allocated once a race is running.
   ========================================================================= */

const ITEMS = {
  dart: { name: 'Bolt Dart', color: 0x5ad2ff, hold: true, ai: 'forward', icon: 'dart' },
  triDart: { name: 'Tri-Dart', color: 0x5ad2ff, hold: true, ai: 'forward', icon: 'dart', charges: 3 },
  seeker: { name: 'Seeker Orb', color: 0xff4f6d, hold: true, ai: 'homing', icon: 'seeker' },
  gel: { name: 'Slick Gel', color: 0x8fe04a, hold: true, ai: 'trail', icon: 'gel' },
  aegis: { name: 'Aegis Ring', color: 0x66ddff, hold: false, ai: 'shield', icon: 'aegis' },
  turbo: { name: 'Turbo Cell', color: 0xffc44a, hold: false, ai: 'boost', icon: 'turbo' },
  storm: { name: 'Ion Storm', color: 0xb07bff, hold: false, ai: 'storm', icon: 'storm' }
};

/* Position-weighted distribution: front runners get defensive/minor items,
   back markers get the catch-up hardware. Row index = race position - 1. */
const ITEM_TABLE = [
  /* 1st */{ dart: 26, gel: 34, aegis: 30, turbo: 10, seeker: 0, triDart: 0, storm: 0 },
  /* 2nd */{ dart: 30, gel: 28, aegis: 24, turbo: 16, seeker: 2, triDart: 0, storm: 0 },
  /* 3rd */{ dart: 28, gel: 20, aegis: 16, turbo: 24, seeker: 10, triDart: 2, storm: 0 },
  /* 4th */{ dart: 22, gel: 14, aegis: 12, turbo: 26, seeker: 18, triDart: 7, storm: 1 },
  /* 5th */{ dart: 16, gel: 10, aegis: 9, turbo: 26, seeker: 22, triDart: 13, storm: 4 },
  /* 6th */{ dart: 11, gel: 7, aegis: 7, turbo: 24, seeker: 22, triDart: 20, storm: 9 },
  /* 7th */{ dart: 8, gel: 5, aegis: 5, turbo: 21, seeker: 20, triDart: 26, storm: 15 },
  /* 8th */{ dart: 6, gel: 4, aegis: 4, turbo: 18, seeker: 18, triDart: 28, storm: 22 }
];

const ITEM_KEYS = Object.keys(ITEMS);

function rollItem(position, luck, rng) {
  const row = ITEM_TABLE[clamp(position - 1, 0, 7)];
  const weights = ITEM_KEYS.map(k => {
    let w = row[k] || 0;
    // catch-up luck nudges the good stuff up a little, never creates it
    if (luck > 0 && (k === 'turbo' || k === 'seeker' || k === 'triDart' || k === 'storm')) w *= 1 + luck * .55;
    if (luck > 0 && (k === 'gel' || k === 'aegis')) w *= 1 - luck * .3;
    return w;
  });
  return weightedPick(ITEM_KEYS, weights, rng);
}

/** HUD / pickup icon, drawn procedurally into a 2D context. */
function drawItemIcon(g, id, w, h) {
  g.clearRect(0, 0, w, h);
  if (!id) return;
  const c = w / 2, m = w * .5;
  const col = cssHex(ITEMS[id].color);
  g.save();
  g.translate(c, c);
  g.lineWidth = w * .07;
  g.strokeStyle = col; g.fillStyle = col;
  g.shadowColor = col; g.shadowBlur = w * .18;
  const icon = ITEMS[id].icon;
  if (icon === 'dart') {
    const n = ITEMS[id].charges || 1;
    for (let i = 0; i < n; i++) {
      const off = (i - (n - 1) / 2) * m * .48;
      g.beginPath();
      g.moveTo(off, -m * .62); g.lineTo(off + m * (n > 1 ? .19 : .28), m * .34);
      g.lineTo(off, m * .12); g.lineTo(off - m * (n > 1 ? .19 : .28), m * .34);
      g.closePath(); g.fill();
    }
  } else if (icon === 'seeker') {
    g.beginPath(); g.arc(0, 0, m * .5, 0, TAU); g.fill();
    g.globalAlpha = .55;
    g.beginPath(); g.arc(0, 0, m * .78, .4, 2.2); g.stroke();
    g.beginPath(); g.arc(0, 0, m * .78, .4 + Math.PI, 2.2 + Math.PI); g.stroke();
  } else if (icon === 'gel') {
    g.beginPath();
    for (let i = 0; i <= 22; i++) {
      const a = i / 22 * TAU;
      const r = m * (.52 + .16 * Math.sin(a * 3) + .07 * Math.sin(a * 7));
      i ? g.lineTo(Math.cos(a) * r, Math.sin(a) * r * .78) : g.moveTo(Math.cos(a) * r, Math.sin(a) * r * .78);
    }
    g.closePath(); g.fill();
  } else if (icon === 'aegis') {
    g.globalAlpha = .9;
    g.beginPath(); g.arc(0, 0, m * .62, 0, TAU); g.stroke();
    g.globalAlpha = .35;
    g.beginPath(); g.arc(0, 0, m * .4, 0, TAU); g.fill();
  } else if (icon === 'turbo') {
    for (let i = 0; i < 3; i++) {
      g.globalAlpha = 1 - i * .26;
      g.beginPath();
      g.moveTo(-m * .5 + i * m * .34, -m * .55);
      g.lineTo(m * .05 + i * m * .34, 0);
      g.lineTo(-m * .5 + i * m * .34, m * .55);
      g.lineTo(-m * .26 + i * m * .34, 0);
      g.closePath(); g.fill();
    }
  } else if (icon === 'storm') {
    g.globalAlpha = .9;
    for (let i = 0; i < 5; i++) {
      const a = i / 5 * TAU;
      g.beginPath();
      g.moveTo(0, 0);
      g.lineTo(Math.cos(a) * m * .75, Math.sin(a) * m * .75);
      g.lineTo(Math.cos(a + .5) * m * .45, Math.sin(a + .5) * m * .45);
      g.closePath(); g.fill();
    }
    g.globalAlpha = 1;
    g.beginPath(); g.arc(0, 0, m * .2, 0, TAU); g.fill();
  }
  g.restore();
}

/* ------------------------------------------------------------------------ */

class ItemSystem {
  constructor(race) {
    this.race = race;
    this.track = race.track;
    this.root = new THREE.Group();
    this.rng = makeRng(0xA17E5 + (Date.now() & 0xffff));
    this.boxes = [];
    this._buildBoxes();
    this._buildPools();
  }

  _buildBoxes() {
    const T = this.track, P = T.path;
    const rows = 3, perRow = 5;
    const geo = new THREE.BoxGeometry(2.1, 2.1, 2.1);
    const mat = new THREE.MeshStandardMaterial({
      color: 0xffffff, emissive: 0x66ccff, emissiveIntensity: .8,
      roughness: .25, metalness: .3, transparent: true, opacity: .88
    });
    const coreGeo = new THREE.OctahedronGeometry(.62, 0);
    const coreMat = new THREE.MeshBasicMaterial({ color: 0xffe9a0 });
    const slots = [];
    for (let r = 0; r < rows; r++) {
      let s = (T.startS + .17 + r * .295) % 1;
      for (let guard = 0; guard < 20 && (T.rampAt(s) >= 0 || T._nearBoost(s)); guard++) s = (s + .012) % 1;
      const w = P.widthAt(s);
      for (let i = 0; i < perRow; i++) {
        const u = (-1 + 2 * i / (perRow - 1)) * w * .68;
        const p = P.surfacePoint(s, u, new THREE.Vector3());
        p.y += 1.6;
        slots.push({ p, s, u });
      }
    }
    // two instanced meshes for the whole set instead of two per box
    this.boxShell = new THREE.InstancedMesh(geo, mat, slots.length);
    this.boxCore = new THREE.InstancedMesh(coreGeo, coreMat, slots.length);
    this.boxShell.frustumCulled = false; this.boxCore.frustumCulled = false;
    this.root.add(this.boxShell, this.boxCore);
    slots.forEach((sl, i) => {
      this.boxes.push({ i, pos: sl.p.clone(), taken: 0, spin: Math.random() * TAU, s: sl.s, u: sl.u, scale: 1, y: sl.p.y });
    });
    this._boxM = new THREE.Matrix4();
    this._boxQ = new THREE.Quaternion();
    this._boxE = new THREE.Euler();
    this._boxS = new THREE.Vector3();
    this._boxP = new THREE.Vector3();
  }

  /** Push one box's current transform into both instanced meshes. */
  _writeBox(b) {
    this._boxE.set(Math.sin(b.spin * .7) * .3, b.spin, 0);
    this._boxQ.setFromEuler(this._boxE);
    this._boxP.set(b.pos.x, b.y, b.pos.z);
    this._boxS.setScalar(b.scale);
    this._boxM.compose(this._boxP, this._boxQ, this._boxS);
    this.boxShell.setMatrixAt(b.i, this._boxM);
    this._boxE.set(0, -b.spin * 2.2, 0);
    this._boxQ.setFromEuler(this._boxE);
    this._boxM.compose(this._boxP, this._boxQ, this._boxS);
    this.boxCore.setMatrixAt(b.i, this._boxM);
  }

  _buildPools() {
    // --- projectiles
    const dartGeo = new THREE.ConeGeometry(.55, 2.4, 7);
    dartGeo.rotateX(Math.PI / 2);
    const seekerGeo = new THREE.IcosahedronGeometry(.95, 1);
    const dartMat = new THREE.MeshStandardMaterial({ color: 0x9be8ff, emissive: 0x2aa8ff, emissiveIntensity: 1.6, roughness: .3, metalness: .5 });
    const seekerMat = new THREE.MeshStandardMaterial({ color: 0xff8fa0, emissive: 0xff2244, emissiveIntensity: 1.8, roughness: .3, metalness: .4 });

    this.projectiles = new Pool(() => {
      const g = new THREE.Group();
      const dart = new THREE.Mesh(dartGeo, dartMat);
      const seeker = new THREE.Mesh(seekerGeo, seekerMat);
      const halo = new THREE.Mesh(new THREE.SphereGeometry(1.5, 10, 8), new THREE.MeshBasicMaterial({
        color: 0xffffff, transparent: true, opacity: .22, blending: THREE.AdditiveBlending, depthWrite: false
      }));
      g.add(dart, seeker, halo);
      g.visible = false;
      this.root.add(g);
      return { obj: g, dart, seeker, halo, kind: 'dart', s: 0, u: 0, life: 0, owner: null, target: null, speed: 0, dir: 1, _alive: false };
    }, 14);

    // --- hazards (gel puddles)
    const gelGeo = new THREE.CircleGeometry(2.3, 14);
    gelGeo.rotateX(-Math.PI / 2);
    const gelMat = new THREE.MeshStandardMaterial({
      color: 0x8fe04a, emissive: 0x2a5a10, emissiveIntensity: .6,
      roughness: .15, metalness: .1, transparent: true, opacity: .82
    });
    this.hazards = new Pool(() => {
      const m = new THREE.Mesh(gelGeo, gelMat);
      m.visible = false;
      this.root.add(m);
      return { obj: m, pos: new THREE.Vector3(), life: 0, owner: null, s: 0, u: 0, _alive: false };
    }, 10);
  }

  /* ---- pickup ---- */
  update(dt) {
    const race = this.race;
    // boxes
    for (let i = 0; i < this.boxes.length; i++) {
      const b = this.boxes[i];
      b.spin += dt * 1.9;
      b.y = b.pos.y + Math.sin(b.spin * 1.3) * .22;
      if (b.taken > 0) {
        b.taken -= dt;
        // respawn by growing back rather than blinking in
        const t = clamp01(1 - b.taken / 3.5);
        b.scale = b.taken <= 0 ? 1 : t * t;
        if (b.taken <= 0) { b.taken = 0; b.scale = 1; }
      } else {
        b.scale = 1;
        for (let k = 0; k < race.karts.length; k++) {
          const kart = race.karts[k];
          if (kart.item) continue;
          const dx = kart.pos.x - b.pos.x, dz = kart.pos.z - b.pos.z;
          const dy = kart.pos.y - b.y;
          if (dx * dx + dz * dz < 9 && Math.abs(dy) < 4) {
            this.give(kart);
            b.taken = 3.5;
            b.scale = 0;
            _v0.set(b.pos.x, b.y, b.pos.z);
            race.fx.burst(_v0, 0x9fe8ff, 16, 8);
            if (kart.isPlayer) Audio.sfx('itemget', .9);
            break;
          }
        }
      }
      this._writeBox(b);
    }
    this.boxShell.instanceMatrix.needsUpdate = true;
    this.boxCore.instanceMatrix.needsUpdate = true;

    // projectiles
    this.projectiles.forEach(p => this._updateProjectile(p, dt));
    // hazards
    this.hazards.forEach(h => {
      h.life -= dt;
      const t = clamp01(h.life / 1.2);
      h.obj.scale.setScalar(lerp(.4, 1, clamp01((15 - h.life) * 3)) * (h.life < 1.2 ? t : 1));
      h.obj.rotation.y += dt * .4;
      if (h.life <= 0) { h._alive = false; h.obj.visible = false; return; }
      for (let k = 0; k < race.karts.length; k++) {
        const kart = race.karts[k];
        if (kart === h.owner && h.life > 14) continue;
        const dx = kart.pos.x - h.pos.x, dz = kart.pos.z - h.pos.z;
        if (dx * dx + dz * dz < 9 && Math.abs(kart.pos.y - h.pos.y) < 3.4) {
          if (kart.spinOut()) {
            race.onHit(kart, 'gel');
            h.life = Math.min(h.life, .6);
          }
        }
      }
    });
  }

  give(kart) {
    const race = this.race;
    // luck scales with how far behind the leader you are, capped
    const leader = race.karts.reduce((a, b) => b.progress > a.progress ? b : a, race.karts[0]);
    const gap = clamp01((leader.progress - kart.progress) * 3.1);
    const luck = kart.isPlayer ? gap : gap * .8;
    const id = rollItem(kart.position, luck, this.rng);
    kart.item = id;
    kart.itemCharges = ITEMS[id].charges || 1;
    kart.itemRolling = .55;
  }

  /* ---- use ---- */
  use(kart, backwards) {
    if (!kart.item) return;
    const def = ITEMS[kart.item];
    const race = this.race;
    switch (kart.item) {
      case 'dart':
      case 'triDart':
        this._fireDart(kart, backwards);
        Audio.sfx('fire', kart.isPlayer ? 1 : .35);
        break;
      case 'seeker':
        this._fireSeeker(kart);
        Audio.sfx('homing', kart.isPlayer ? 1 : .35);
        break;
      case 'gel':
        this._dropGel(kart);
        Audio.sfx('drop', kart.isPlayer ? 1 : .3);
        break;
      case 'aegis':
        kart.shield = 9;
        Audio.sfx('shield', kart.isPlayer ? 1 : .3);
        break;
      case 'turbo':
        kart.applyBoost(3, true);
        Audio.sfx('boost', kart.isPlayer ? 1 : .35);
        race.fx.boostRing(kart);
        break;
      case 'storm':
        race.triggerStorm(kart);
        break;
    }
    kart.itemCharges--;
    if (kart.itemCharges <= 0) { kart.item = null; kart.itemCharges = 0; }
  }

  _spawn(kind, kart) {
    const p = this.projectiles.get();
    p.kind = kind;
    p.owner = kart;
    p.life = kind === 'seeker' ? 11 : 5.5;
    p.s = kart.s;
    p.u = kart.u;
    p.target = null;
    p.obj.visible = true;
    p.dart.visible = kind !== 'seeker';
    p.seeker.visible = kind === 'seeker';
    p.halo.material.color.setHex(kind === 'seeker' ? 0xff5577 : 0x6fd8ff);
    return p;
  }

  _fireDart(kart, backwards) {
    const p = this._spawn('dart', kart);
    p.dir = backwards ? -1 : 1;
    p.speed = (backwards ? 26 : 46 + Math.abs(kart.speed) * .35);
    p.u = kart.u;
    p.s = kart.s + p.dir * .002;
  }

  _fireSeeker(kart) {
    const p = this._spawn('seeker', kart);
    p.dir = 1;
    p.speed = 52;
    const race = this.race;
    // target the racer one place ahead
    let best = null;
    for (let i = 0; i < race.karts.length; i++) {
      const o = race.karts[i];
      if (o === kart || o.finished) continue;
      if (o.progress > kart.progress) {
        if (!best || o.progress < best.progress) best = o;
      }
    }
    p.target = best;
  }

  _dropGel(kart) {
    const h = this.hazards.get();
    h.life = 15;
    const back = _v0.set(Math.sin(kart.yaw), 0, Math.cos(kart.yaw)).multiplyScalar(-4.4);
    h.pos.copy(kart.pos).add(back);
    const q = this.track.query(h.pos.x, h.pos.y, h.pos.z, kart.hint, _hazQ);
    h.pos.y = q.height + .08;
    h.owner = kart;
    h.obj.position.copy(h.pos);
    h.obj.visible = true;
    h.obj.scale.setScalar(.4);
  }

  _updateProjectile(p, dt) {
    const T = this.track, P = T.path, race = this.race;
    p.life -= dt;
    if (p.life <= 0) { this._kill(p); return; }

    if (p.kind === 'seeker') {
      // rides the spline toward its mark: dodgeable sideways, never leaves the road
      if (p.target && !p.target.finished) p.u = damp(p.u, p.target.u, 2.6, dt);
      p.speed = 58;
    }

    p.s += (p.dir * p.speed * dt) / P.length;
    const w = P.widthAt(p.s);
    p.u = clamp(p.u, -w - 1.5, w + 1.5);
    P.surfacePoint(p.s, p.u, _v0);
    const q = T.query(_v0.x, _v0.y, _v0.z, null, _hazQ);
    _v0.y = Math.max(_v0.y, q.height) + 1.15;
    p.obj.position.copy(_v0);
    const head = P.headingAt(p.s);
    p.obj.rotation.y = head + (p.dir < 0 ? Math.PI : 0);
    p.seeker.rotation.x += dt * 7; p.seeker.rotation.y += dt * 5;
    p.halo.scale.setScalar(1 + Math.sin(race.time * 18) * .12);

    race.fx.trail(_v0, p.kind === 'seeker' ? 0xff5577 : 0x6fd8ff, dt);

    // collisions
    for (let i = 0; i < race.karts.length; i++) {
      const k = race.karts[i];
      if (k === p.owner && p.life > 5.2) continue;
      const dx = k.pos.x - _v0.x, dz = k.pos.z - _v0.z, dy = k.pos.y - _v0.y;
      if (dx * dx + dz * dz < 12 && Math.abs(dy) < 4.5) {
        if (k.spinOut()) {
          race.onHit(k, p.kind);
          race.fx.explode(_v0, p.kind === 'seeker' ? 0xff5577 : 0x6fd8ff);
          Audio.sfx('hit', k.isPlayer ? 1 : .3);
        } else {
          race.fx.burst(_v0, 0x88ffff, 20, 12);
          Audio.sfx('bump', .6);
        }
        this._kill(p);
        return;
      }
    }
    // hit the barrier?
    if (Math.abs(p.u) > w + this.track.kerbW + 1 && T.wallSolid) {
      race.fx.explode(_v0, 0xffaa55);
      this._kill(p);
    }
  }

  _kill(p) {
    p._alive = false;
    p.obj.visible = false;
    p.target = null;
  }

  reset() {
    this.projectiles.forEach(p => this._kill(p));
    this.hazards.forEach(h => { h._alive = false; h.obj.visible = false; });
    this.boxes.forEach(b => { b.taken = 0; b.scale = 1; this._writeBox(b); });
    this.boxShell.instanceMatrix.needsUpdate = true;
    this.boxCore.instanceMatrix.needsUpdate = true;
  }
}

const _hazQ = Object.assign({}, SQ);
