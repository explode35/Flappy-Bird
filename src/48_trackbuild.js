/* ============================================================================
   TRACK BUILDER — turns a track definition into geometry, textures, scenery
   and the surface-query function the physics runs against.
   ========================================================================= */

/* ---------- procedural textures ----------------------------------------- */

function roadTexture(cfg) {
  return canvasTexture('road_' + cfg.tex + '_' + cfg.color, 256, 256, (g, w, h) => {
    const base = cfg.color;
    noiseFill(g, w, h, 26, shade(base, .72), shade(base, 1.22), 91, 3);
    const rng = makeRng(5);
    if (cfg.tex === 'asphalt') {
      g.globalAlpha = .18;
      for (let i = 0; i < 260; i++) {                       // aggregate speckle
        g.fillStyle = rng() < .5 ? '#000' : '#fff';
        g.fillRect(rng() * w, rng() * h, 1 + rng() * 2, 1 + rng() * 2);
      }
      g.globalAlpha = .12; g.strokeStyle = '#000'; g.lineWidth = 1.6;
      for (let i = 0; i < 14; i++) {                        // hairline cracks
        g.beginPath();
        let x = rng() * w, y = rng() * h;
        g.moveTo(x, y);
        for (let k = 0; k < 7; k++) { x += rng() * 40 - 20; y += rng() * 40 - 20; g.lineTo(x, y); }
        g.stroke();
      }
    } else if (cfg.tex === 'metal') {
      g.globalAlpha = .3; g.strokeStyle = '#000'; g.lineWidth = 2;
      for (let y = 0; y < h; y += 32) { g.beginPath(); g.moveTo(0, y); g.lineTo(w, y); g.stroke(); }
      for (let x = 0; x < w; x += 64) { g.beginPath(); g.moveTo(x, 0); g.lineTo(x, h); g.stroke(); }
      g.globalAlpha = .5; g.fillStyle = '#fff';
      for (let y = 8; y < h; y += 32) for (let x = 8; x < w; x += 64) g.fillRect(x, y, 2, 2);
    } else if (cfg.tex === 'ice') {
      g.globalAlpha = .25; g.strokeStyle = '#dff';
      for (let i = 0; i < 26; i++) {
        g.lineWidth = .6 + rng() * 1.4;
        g.beginPath();
        let x = rng() * w, y = rng() * h;
        g.moveTo(x, y);
        for (let k = 0; k < 4; k++) { x += rng() * 70 - 35; y += rng() * 70 - 35; g.lineTo(x, y); }
        g.stroke();
      }
    } else { // coral / organic
      g.globalAlpha = .2;
      for (let i = 0; i < 90; i++) {
        g.fillStyle = rng() < .5 ? '#7fe' : '#fff';
        g.beginPath(); g.arc(rng() * w, rng() * h, 1 + rng() * 4, 0, TAU); g.fill();
      }
    }
    g.globalAlpha = 1;
  }, { repeat: [1, 1], aniso: 8 });
}

function stripeTexture(a, b) {
  return canvasTexture('kerb_' + a + '_' + b, 64, 64, (g, w, h) => {
    g.fillStyle = cssHex(a); g.fillRect(0, 0, w, h);
    g.fillStyle = cssHex(b); g.fillRect(0, 0, w, h / 2);
    g.globalAlpha = .18; g.fillStyle = '#000';
    g.fillRect(0, 0, w, 3); g.fillRect(0, h - 3, w, 3);
  }, { repeat: [1, 1] });
}

function groundTexture(key, colA, colB, seed) {
  return canvasTexture('gnd_' + key, 256, 256, (g, w, h) => {
    noiseFill(g, w, h, 40, colA, colB, seed, 3);
    const rng = makeRng(seed + 3);
    g.globalAlpha = .16;
    for (let i = 0; i < 400; i++) {
      g.fillStyle = rng() < .5 ? '#000' : '#fff';
      g.fillRect(rng() * w, rng() * h, 1 + rng() * 3, 1 + rng() * 3);
    }
    g.globalAlpha = 1;
  }, { repeat: [1, 1], aniso: 4 });
}

function checkerTexture() {
  return canvasTexture('checker', 128, 128, (g, w, h) => {
    const n = 8, s = w / n;
    for (let y = 0; y < n; y++) for (let x = 0; x < n; x++) {
      g.fillStyle = ((x + y) & 1) ? '#f4f4f4' : '#16181f';
      g.fillRect(x * s, y * s, s, s);
    }
  });
}

/* ---------- ribbon helper ------------------------------------------------ */

/**
 * Build a strip that follows the path.
 * uAt(i, col) returns the lateral offset for ring i, column col (0..cols).
 * yAt(i, col) returns extra height. colAt(i, col, out THREE.Color).
 */
function buildRibbon(path, step, cols, uAt, yAt, uvScale, colAt, sRange) {
  const N = path.N;
  const i0 = sRange ? Math.floor(sRange[0] * N) : 0;
  const rings = sRange ? Math.floor(((sRange[1] - sRange[0] + 1) % 1 || 1) * N / step) + 1 : Math.floor(N / step) + 1;
  const closed = !sRange;
  const vcount = rings * (cols + 1);
  const pos = new Float32Array(vcount * 3);
  const nor = new Float32Array(vcount * 3);
  const uv = new Float32Array(vcount * 2);
  const col = colAt ? new Float32Array(vcount * 3) : null;
  const idx = [];
  const c = new THREE.Color();
  let vLen = 0;

  for (let r = 0; r < rings; r++) {
    const i = (i0 + r * step) % N;
    const s = i / N;
    if (r > 0) {
      const p = (i0 + (r - 1) * step) % N;
      vLen += Math.hypot(path.pos[i * 3] - path.pos[p * 3], path.pos[i * 3 + 1] - path.pos[p * 3 + 1], path.pos[i * 3 + 2] - path.pos[p * 3 + 2]);
    }
    for (let k = 0; k <= cols; k++) {
      const u = uAt(i, k, s);
      const y = yAt ? yAt(i, k, s) : 0;
      const vi = (r * (cols + 1) + k);
      pos[vi * 3] = path.pos[i * 3] + path.right[i * 3] * u + path.up[i * 3] * y;
      pos[vi * 3 + 1] = path.pos[i * 3 + 1] + path.right[i * 3 + 1] * u + path.up[i * 3 + 1] * y;
      pos[vi * 3 + 2] = path.pos[i * 3 + 2] + path.right[i * 3 + 2] * u + path.up[i * 3 + 2] * y;
      nor[vi * 3] = path.up[i * 3]; nor[vi * 3 + 1] = path.up[i * 3 + 1]; nor[vi * 3 + 2] = path.up[i * 3 + 2];
      uv[vi * 2] = k / cols * (uvScale ? uvScale[0] : 1);
      uv[vi * 2 + 1] = vLen / (uvScale ? uvScale[1] : 1);
      if (col) { colAt(i, k, s, c); col[vi * 3] = c.r; col[vi * 3 + 1] = c.g; col[vi * 3 + 2] = c.b; }
    }
  }
  // Winding has to follow the direction the columns run. Strips built from the
  // centre outward on the left side sweep u the other way, which mirrors the
  // triangles — without this check half of every surface is backface-culled.
  const uSpan = uAt(i0, cols, i0 / N) - uAt(i0, 0, i0 / N);
  const lastRing = closed ? rings : rings - 1;
  for (let r = 0; r < lastRing; r++) {
    const a = r * (cols + 1), b = ((r + 1) % rings) * (cols + 1);
    for (let k = 0; k < cols; k++) {
      if (uSpan >= 0) {
        idx.push(a + k, a + k + 1, b + k);
        idx.push(a + k + 1, b + k + 1, b + k);
      } else {
        idx.push(a + k, b + k, a + k + 1);
        idx.push(a + k + 1, b + k, b + k + 1);
      }
    }
  }
  const geo = new THREE.BufferGeometry();
  geo.setAttribute('position', new THREE.BufferAttribute(pos, 3));
  geo.setAttribute('normal', new THREE.BufferAttribute(nor, 3));
  geo.setAttribute('uv', new THREE.BufferAttribute(uv, 2));
  if (col) geo.setAttribute('color', new THREE.BufferAttribute(col, 3));
  geo.setIndex(idx);
  geo.computeBoundingSphere();
  return geo;
}

/* ---------- alternate path (shortcuts) ----------------------------------- */

class AltPath {
  constructor(def) {
    this.def = def;
    const pts = def.pts.map(p => new THREE.Vector3(p[0], p[1], p[2]));
    const curve = new THREE.CatmullRomCurve3(pts, false, 'catmullrom', .5);
    const M = this.M = 220;
    this.pos = new Float32Array(M * 3);
    this.right = new Float32Array(M * 3);
    this.t = new Float32Array(M);
    const v = new THREE.Vector3(), tan = new THREE.Vector3();
    let len = 0, prev = null;
    for (let i = 0; i < M; i++) {
      const t = i / (M - 1);
      curve.getPoint(t, v);
      curve.getTangent(t, tan);
      this.pos[i * 3] = v.x; this.pos[i * 3 + 1] = v.y; this.pos[i * 3 + 2] = v.z;
      const rl = Math.hypot(-tan.z, tan.x) || 1;
      this.right[i * 3] = -tan.z / rl; this.right[i * 3 + 2] = tan.x / rl;
      this.t[i] = t;
      if (prev) len += v.distanceTo(prev);
      prev = v.clone();
    }
    this.length = len;
    this.width = def.width;
    this.curve = curve;
  }
  /** Nearest point: returns {d (lateral dist), t, y, i} or null when far away. */
  query(x, z, out) {
    let bd = 1e18, bi = -1, bt = 0;
    for (let i = 0; i < this.M - 1; i++) {
      const ax = this.pos[i * 3], az = this.pos[i * 3 + 2];
      const bx = this.pos[i * 3 + 3], bz = this.pos[i * 3 + 5];
      const ex = bx - ax, ez = bz - az;
      const l2 = ex * ex + ez * ez || 1;
      let t = clamp01(((x - ax) * ex + (z - az) * ez) / l2);
      const px = ax + ex * t, pz = az + ez * t;
      const d = (x - px) * (x - px) + (z - pz) * (z - pz);
      if (d < bd) { bd = d; bi = i; bt = t; }
    }
    out.d = Math.sqrt(bd);
    out.i = bi;
    out.t = (bi + bt) / (this.M - 1);
    out.y = lerp(this.pos[bi * 3 + 1], this.pos[bi * 3 + 4], bt);
    return out;
  }
}

/* ---------- decoration meshes (all from primitives) ---------------------- */

/**
 * Fold a multi-part prop into one geometry with baked vertex colours, so each
 * scenery type costs a single instanced draw call instead of one per part.
 * (A palm was seven draw calls per chunk before this.)
 */
function mergeParts(parts) {
  let vTotal = 0, iTotal = 0;
  parts.forEach(([g]) => {
    if (!g.attributes.normal) g.computeVertexNormals();
    vTotal += g.attributes.position.count;
    iTotal += g.index ? g.index.count : g.attributes.position.count;
  });
  const pos = new Float32Array(vTotal * 3);
  const nor = new Float32Array(vTotal * 3);
  const col = new Float32Array(vTotal * 3);
  const idx = vTotal > 65000 ? new Uint32Array(iTotal) : new Uint16Array(iTotal);
  const c = new THREE.Color();
  let vo = 0, io = 0;
  parts.forEach(([g, m]) => {
    const p = g.attributes.position, n = g.attributes.normal;
    c.copy(m.color);
    // emissive parts survive the merge as brighter vertex colour
    if (m.emissive) c.add(_c1.copy(m.emissive).multiplyScalar(1.4));
    for (let i = 0; i < p.count; i++) {
      const o = (vo + i) * 3;
      pos[o] = p.getX(i); pos[o + 1] = p.getY(i); pos[o + 2] = p.getZ(i);
      nor[o] = n.getX(i); nor[o + 1] = n.getY(i); nor[o + 2] = n.getZ(i);
      col[o] = c.r; col[o + 1] = c.g; col[o + 2] = c.b;
    }
    const gi = g.index, cnt = gi ? gi.count : p.count;
    for (let i = 0; i < cnt; i++) idx[io + i] = (gi ? gi.getX(i) : i) + vo;
    vo += p.count; io += cnt;
  });
  const geo = new THREE.BufferGeometry();
  geo.setAttribute('position', new THREE.BufferAttribute(pos, 3));
  geo.setAttribute('normal', new THREE.BufferAttribute(nor, 3));
  geo.setAttribute('color', new THREE.BufferAttribute(col, 3));
  geo.setIndex(new THREE.BufferAttribute(idx, 1));
  geo.computeBoundingSphere();
  return geo;
}

const DecorLib = {
  _cache: {},
  get(kind, env) {
    const key = kind + '_' + (env.ground || 0);
    if (this._cache[key]) return this._cache[key];
    const parts = this._build(kind, env);
    const made = {
      geo: mergeParts(parts),
      mat: new THREE.MeshLambertMaterial({ vertexColors: true })
    };
    this._cache[key] = made;
    return made;
  },
  clear() { this._cache = {}; },

  _build(kind, env) {
    const parts = [];
    // Lambert has no flatShading in r128 — faceted scenery uses Phong instead.
    const M = (c, opts) => {
      opts = opts || {};
      if (opts.flatShading) return new THREE.MeshPhongMaterial(Object.assign({ color: c, shininess: 6, specular: 0x111111 }, opts));
      return new THREE.MeshLambertMaterial(Object.assign({ color: c }, opts));
    };
    switch (kind) {
      case 'rock': {
        const g = new THREE.IcosahedronGeometry(1, 0);
        const p = g.attributes.position;
        const rng = makeRng(12);
        for (let i = 0; i < p.count; i++) {
          p.setXYZ(i, p.getX(i) * (.6 + rng() * .8), p.getY(i) * (.5 + rng() * .6), p.getZ(i) * (.6 + rng() * .8));
        }
        g.computeVertexNormals();
        parts.push([g, M(shade(env.ground, 1.05), { flatShading: true })]);
        break;
      }
      case 'mesa': {
        const g = new THREE.CylinderGeometry(6, 9, 16, 7, 1);
        g.translate(0, 8, 0);
        parts.push([g, M(shade(env.ground, .92), { flatShading: true })]);
        const cap = new THREE.CylinderGeometry(6.4, 6, 2.4, 7, 1);
        cap.translate(0, 17, 0);
        parts.push([cap, M(shade(env.ground, 1.25), { flatShading: true })]);
        break;
      }
      case 'cactus': {
        const g = new THREE.CylinderGeometry(.5, .58, 4, 7);
        g.translate(0, 2.4, 0);
        parts.push([g, M(0x4e7a3a, { flatShading: true })]);
        const arm = new THREE.CylinderGeometry(.3, .3, 1.8, 6);
        arm.rotateZ(Math.PI / 2); arm.translate(.9, 2.6, 0);
        parts.push([arm, M(0x467033, { flatShading: true })]);
        break;
      }
      case 'pine': {
        const t = new THREE.CylinderGeometry(.24, .34, 2.2, 5); t.translate(0, 1.1, 0);
        parts.push([t, M(0x3d2d24, { flatShading: true })]);
        for (let i = 0; i < 3; i++) {
          const c = new THREE.ConeGeometry(2.1 - i * .5, 3 - i * .5, 7);
          c.translate(0, 2.4 + i * 1.5, 0);
          parts.push([c, M(shade(0x2f5f4a, 1 + i * .12), { flatShading: true })]);
        }
        break;
      }
      case 'palm': {
        const t = new THREE.CylinderGeometry(.2, .34, 6, 6);
        t.translate(0, 3, 0); t.rotateZ(.12);
        parts.push([t, M(0x8a6b45, { flatShading: true })]);
        for (let i = 0; i < 6; i++) {
          const f = new THREE.ConeGeometry(.55, 3.4, 4);
          f.rotateX(-Math.PI / 2.3); f.translate(0, 6.1, 1.5);
          f.rotateY(i * TAU / 6);
          parts.push([f, M(shade(0x3f8f5a, .9 + i * .04), { flatShading: true })]);
        }
        break;
      }
      case 'crystal': {
        for (let i = 0; i < 3; i++) {
          const c = new THREE.ConeGeometry(.8 - i * .18, 4.5 - i * .9, 5);
          c.translate((i - 1) * .9, (4.5 - i * .9) / 2, (i % 2) * .7);
          c.rotateZ((i - 1) * .18);
          parts.push([c, new THREE.MeshPhongMaterial({
            color: 0x6f8fff, emissive: 0x2a3aff, shininess: 60, specular: 0x8899ff,
            transparent: true, opacity: .82, flatShading: true
          })]);
        }
        break;
      }
      case 'coralArch': {
        const g = new THREE.TorusGeometry(4.2, .85, 5, 10, Math.PI);
        g.translate(0, 0, 0);
        parts.push([g, M(0xff7fa8, { flatShading: true })]);
        const g2 = new THREE.TorusGeometry(2.6, .5, 5, 9, Math.PI);
        g2.translate(1.6, 0, .8);
        parts.push([g2, M(0xffc27f, { flatShading: true })]);
        break;
      }
      case 'chimney': {
        const g = new THREE.CylinderGeometry(1.5, 2.4, 22, 8, 1, true);
        g.translate(0, 11, 0);
        parts.push([g, new THREE.MeshPhongMaterial({ color: 0x4b3630, side: THREE.DoubleSide, flatShading: true, shininess: 4 })]);
        const r = new THREE.TorusGeometry(1.7, .26, 4, 8); r.rotateX(Math.PI / 2); r.translate(0, 20, 0);
        parts.push([r, M(0x8a4b2a)]);
        const r2 = new THREE.TorusGeometry(2.1, .26, 4, 8); r2.rotateX(Math.PI / 2); r2.translate(0, 8, 0);
        parts.push([r2, M(0x8a4b2a)]);
        break;
      }
      case 'pipe': {
        const g = new THREE.CylinderGeometry(.7, .7, 12, 7);
        g.rotateZ(Math.PI / 2); g.translate(0, 3.2, 0);
        parts.push([g, M(0x6b5348, { flatShading: true })]);
        const leg = new THREE.BoxGeometry(.5, 3.2, .5); leg.translate(-4.6, 1.6, 0);
        parts.push([leg, M(0x4a3a33)]);
        const leg2 = leg.clone(); leg2.translate(9.2, 0, 0);
        parts.push([leg2, M(0x4a3a33)]);
        break;
      }
      case 'buoy': {
        const g = new THREE.ConeGeometry(.9, 2.4, 7); g.translate(0, 1.2, 0);
        parts.push([g, M(0xff5a3c, { emissive: 0x501000 })]);
        const b = new THREE.SphereGeometry(.42, 7, 5); b.translate(0, 2.7, 0);
        parts.push([b, new THREE.MeshBasicMaterial({ color: 0xfff0a0 })]);
        break;
      }
      case 'islet': {
        const g = new THREE.ConeGeometry(11, 9, 8); g.translate(0, 2.5, 0);
        parts.push([g, M(0x2f7a63, { flatShading: true })]);
        const s = new THREE.CylinderGeometry(13, 15, 2.2, 8); s.translate(0, -1, 0);
        parts.push([s, M(0xe8d9a8, { flatShading: true })]);
        break;
      }
      case 'berg': {
        const g = new THREE.ConeGeometry(9, 18, 6); g.translate(0, 6, 0);
        parts.push([g, M(0xc8e4ff, { flatShading: true })]);
        const g2 = new THREE.ConeGeometry(5.5, 11, 5); g2.translate(7, 3.5, 3);
        parts.push([g2, M(0xa8ccf0, { flatShading: true })]);
        break;
      }
      case 'lavaPool': {
        const g = new THREE.CircleGeometry(7, 10); g.rotateX(-Math.PI / 2);
        parts.push([g, new THREE.MeshBasicMaterial({ color: 0xff5a12 })]);
        const r = new THREE.TorusGeometry(7, .8, 4, 10); r.rotateX(Math.PI / 2);
        parts.push([r, M(0x2a1512, { flatShading: true })]);
        break;
      }
      case 'lantern': {
        const p = new THREE.CylinderGeometry(.16, .22, 5.2, 5); p.translate(0, 2.6, 0);
        parts.push([p, M(0x2b3550)]);
        const b = new THREE.OctahedronGeometry(.7, 0); b.translate(0, 5.4, 0);
        parts.push([b, new THREE.MeshBasicMaterial({ color: 0xbfd8ff })]);
        break;
      }
      case 'balloon': {
        const g = new THREE.SphereGeometry(3.2, 9, 7); g.scale(1, 1.25, 1); g.translate(0, 22, 0);
        parts.push([g, M(0xff6f4a, { emissive: 0x3a1000 })]);
        const b = new THREE.BoxGeometry(1.6, 1.2, 1.6); b.translate(0, 17.4, 0);
        parts.push([b, M(0x6b4a33)]);
        break;
      }
      case 'sign': {
        const p = new THREE.CylinderGeometry(.16, .16, 4, 5); p.translate(0, 2, 0);
        parts.push([p, M(0x9aa3b2)]);
        const b = new THREE.BoxGeometry(3.4, 1.5, .16); b.translate(0, 4.4, 0);
        parts.push([b, new THREE.MeshLambertMaterial({ color: 0xf2f2f2, emissive: 0x222222 })]);
        break;
      }
    }
    return parts;
  }
};

/* ---------- kart-visible marker meshes ----------------------------------- */

function boostPadMaterial(color) {
  return new THREE.ShaderMaterial({
    uniforms: { uTime: { value: 0 }, uColor: { value: new THREE.Color(color) } },
    transparent: true, depthWrite: false, side: THREE.DoubleSide,
    blending: THREE.AdditiveBlending,
    vertexShader: `
      varying vec2 vUv;
      void main(){ vUv = uv; gl_Position = projectionMatrix * modelViewMatrix * vec4(position,1.0); }`,
    fragmentShader: `
      uniform float uTime; uniform vec3 uColor; varying vec2 vUv;
      void main(){
        // scrolling chevrons that read from a long way off
        float v = fract(vUv.y * 3.0 - uTime * 1.6);
        float chev = smoothstep(0.5, 0.0, abs(vUv.x - 0.5) * 2.0 - v * 0.9);
        float band = smoothstep(0.0, 0.25, v) * smoothstep(1.0, 0.55, v);
        float edge = smoothstep(0.0, 0.08, vUv.x) * smoothstep(1.0, 0.92, vUv.x);
        float a = (chev * band * 1.5 + band * 0.25) * edge;
        gl_FragColor = vec4(uColor * (1.2 + band), a * 0.95);
      }`
  });
}

function energyMaterial(color, speed, alpha) {
  return new THREE.ShaderMaterial({
    uniforms: { uTime: { value: 0 }, uColor: { value: new THREE.Color(color) }, uSpeed: { value: speed || 1 }, uA: { value: alpha == null ? .8 : alpha } },
    transparent: true, depthWrite: false, side: THREE.DoubleSide, blending: THREE.AdditiveBlending,
    vertexShader: `varying vec2 vUv; varying vec3 vN; varying vec3 vP;
      void main(){ vUv=uv; vN=normalize(normalMatrix*normal); vec4 mv=modelViewMatrix*vec4(position,1.0); vP=mv.xyz;
        gl_Position=projectionMatrix*mv; }`,
    fragmentShader: `uniform float uTime; uniform vec3 uColor; uniform float uSpeed; uniform float uA;
      varying vec2 vUv; varying vec3 vN; varying vec3 vP;
      void main(){
        float f = 1.0 - abs(dot(normalize(-vP), vN));
        float pulse = 0.6 + 0.4*sin(uTime*uSpeed*3.0 + vUv.y*10.0);
        gl_FragColor = vec4(uColor*(0.7+f*1.6)*pulse, (0.25 + f*0.75)*uA);
      }`
  });
}
