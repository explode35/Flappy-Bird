import * as THREE from 'three';
import { DecalGeometry } from 'three/examples/jsm/geometries/DecalGeometry.js';
import { ihash, vnoise, fbm, ridge, worley, clamp01, smoothstep, mix } from './Noise.js';
import { clamp, lerp } from '../core/Contracts.js';

/**
 * Visual effects: impacts, tracers, muzzle flash, casings, explosions, decals.
 *
 * One instanced quad mesh runs every particle. Spawn writes constants
 * (position, velocity, age, size, atlas index, colour ramp) into instance
 * attributes and the vertex shader integrates the motion, so the CPU touches a
 * particle exactly once — at spawn — instead of every frame.
 *
 * Everything is pooled. Nothing here allocates during play.
 */

const MAX_PARTICLES = 4000;
const MAX_TRACERS = 64;
const MAX_SHELLS = 48;

const _v = new THREE.Vector3();
const _v2 = new THREE.Vector3();
const _v3 = new THREE.Vector3();
const _q = new THREE.Quaternion();
const _m = new THREE.Matrix4();
const _c = new THREE.Color();
const _up = new THREE.Vector3(0, 1, 0);

/* ========================================================================== */
/*  Procedural sprite atlas (4x4)                                             */
/* ========================================================================== */

const ATLAS = {
  smoke: 0, spark: 1, dust: 2, debris: 3,
  blood: 4, fire: 5, ring: 6, splash: 7,
};

function buildAtlas(size = 512) {
  const cell = size / 4;
  const cv = document.createElement('canvas');
  cv.width = cv.height = size;
  const g = cv.getContext('2d');
  g.clearRect(0, 0, size, size);

  const at = (i) => [(i % 4) * cell, Math.floor(i / 4) * cell];

  // --- soft smoke puff: fbm-modulated radial falloff ----------------------
  {
    const [ox, oy] = at(ATLAS.smoke);
    const img = g.createImageData(cell, cell);
    for (let y = 0; y < cell; y++) {
      for (let x = 0; x < cell; x++) {
        const u = (x / cell - 0.5) * 2, v = (y / cell - 0.5) * 2;
        const r = Math.hypot(u, v);
        const n = fbm(x * 0.05, y * 0.05, 3, 5) * 0.55 + 0.45;
        let a = clamp01(1 - r) * n;
        a = a * a * 1.6;
        const i = (y * cell + x) * 4;
        img.data[i] = img.data[i + 1] = img.data[i + 2] = 255;
        img.data[i + 3] = clamp01(a) * 255;
      }
    }
    g.putImageData(img, ox, oy);
  }

  // --- spark: a hot streak with a bright head ------------------------------
  {
    const [ox, oy] = at(ATLAS.spark);
    const img = g.createImageData(cell, cell);
    for (let y = 0; y < cell; y++) {
      for (let x = 0; x < cell; x++) {
        const u = x / cell, v = (y / cell - 0.5) * 2;
        // Tapered along X, tight in Y — the shader orients this along velocity.
        const width = 0.06 + (1 - u) * 0.20;
        const a = clamp01(1 - Math.abs(v) / width) * Math.pow(1 - u, 0.6);
        const i = (y * cell + x) * 4;
        img.data[i] = 255;
        img.data[i + 1] = 200 + 55 * a;
        img.data[i + 2] = 120 * a;
        img.data[i + 3] = clamp01(a * 1.4) * 255;
      }
    }
    g.putImageData(img, ox, oy);
  }

  // --- dust: broad, flat, noisy -------------------------------------------
  {
    const [ox, oy] = at(ATLAS.dust);
    const img = g.createImageData(cell, cell);
    for (let y = 0; y < cell; y++) {
      for (let x = 0; x < cell; x++) {
        const u = (x / cell - 0.5) * 2, v = (y / cell - 0.5) * 2;
        const r = Math.hypot(u, v);
        const n = fbm(x * 0.08 + 40, y * 0.08, 4, 11) * 0.7 + 0.3;
        const a = Math.pow(clamp01(1 - r), 1.6) * n;
        const i = (y * cell + x) * 4;
        img.data[i] = img.data[i + 1] = img.data[i + 2] = 255;
        img.data[i + 3] = clamp01(a) * 255;
      }
    }
    g.putImageData(img, ox, oy);
  }

  // --- debris chunk: an irregular solid silhouette -------------------------
  {
    const [ox, oy] = at(ATLAS.debris);
    const img = g.createImageData(cell, cell);
    for (let y = 0; y < cell; y++) {
      for (let x = 0; x < cell; x++) {
        const u = (x / cell - 0.5) * 2, v = (y / cell - 0.5) * 2;
        const ang = Math.atan2(v, u);
        const r = Math.hypot(u, v);
        const edge = 0.55 + 0.25 * vnoise(Math.cos(ang) * 2 + 5, Math.sin(ang) * 2, 3);
        const a = r < edge ? 1 : 0;
        const shade = 0.55 + 0.45 * vnoise(x * 0.2, y * 0.2, 7);
        const i = (y * cell + x) * 4;
        img.data[i] = img.data[i + 1] = img.data[i + 2] = shade * 255;
        img.data[i + 3] = a * 255;
      }
    }
    g.putImageData(img, ox, oy);
  }

  // --- blood droplet -------------------------------------------------------
  {
    const [ox, oy] = at(ATLAS.blood);
    const img = g.createImageData(cell, cell);
    for (let y = 0; y < cell; y++) {
      for (let x = 0; x < cell; x++) {
        const u = (x / cell - 0.5) * 2, v = (y / cell - 0.5) * 2;
        const r = Math.hypot(u * 1.3, v);
        const a = Math.pow(clamp01(1 - r), 0.8);
        const i = (y * cell + x) * 4;
        img.data[i] = 255; img.data[i + 1] = 40; img.data[i + 2] = 30;
        img.data[i + 3] = clamp01(a * 1.5) * 255;
      }
    }
    g.putImageData(img, ox, oy);
  }

  // --- fire wisp -----------------------------------------------------------
  {
    const [ox, oy] = at(ATLAS.fire);
    const img = g.createImageData(cell, cell);
    for (let y = 0; y < cell; y++) {
      for (let x = 0; x < cell; x++) {
        const u = (x / cell - 0.5) * 2, v = (y / cell - 0.5) * 2;
        const r = Math.hypot(u, v * 0.8);
        const n = fbm(x * 0.09, y * 0.09 - 20, 4, 3) * 0.6 + 0.4;
        const a = Math.pow(clamp01(1 - r), 1.2) * n;
        const i = (y * cell + x) * 4;
        img.data[i] = 255;
        img.data[i + 1] = 150 + 80 * a;
        img.data[i + 2] = 40 * a;
        img.data[i + 3] = clamp01(a * 1.8) * 255;
      }
    }
    g.putImageData(img, ox, oy);
  }

  // --- shockwave ring ------------------------------------------------------
  {
    const [ox, oy] = at(ATLAS.ring);
    const img = g.createImageData(cell, cell);
    for (let y = 0; y < cell; y++) {
      for (let x = 0; x < cell; x++) {
        const u = (x / cell - 0.5) * 2, v = (y / cell - 0.5) * 2;
        const r = Math.hypot(u, v);
        const a = Math.exp(-Math.pow((r - 0.78) / 0.13, 2)) * (0.7 + 0.3 * vnoise(x * 0.1, y * 0.1, 9));
        const i = (y * cell + x) * 4;
        img.data[i] = img.data[i + 1] = img.data[i + 2] = 255;
        img.data[i + 3] = clamp01(a) * 255;
      }
    }
    g.putImageData(img, ox, oy);
  }

  // --- splash --------------------------------------------------------------
  {
    const [ox, oy] = at(ATLAS.splash);
    const img = g.createImageData(cell, cell);
    for (let y = 0; y < cell; y++) {
      for (let x = 0; x < cell; x++) {
        const u = (x / cell - 0.5) * 2, v = (y / cell - 0.5) * 2;
        const r = Math.hypot(u, v);
        const spikes = 0.6 + 0.4 * Math.sin(Math.atan2(v, u) * 9);
        const a = clamp01(1 - r / (0.5 + 0.5 * spikes));
        const i = (y * cell + x) * 4;
        img.data[i] = 220; img.data[i + 1] = 235; img.data[i + 2] = 255;
        img.data[i + 3] = clamp01(a) * 255;
      }
    }
    g.putImageData(img, ox, oy);
  }

  const tex = new THREE.CanvasTexture(cv);
  tex.colorSpace = THREE.SRGBColorSpace;
  tex.minFilter = THREE.LinearMipmapLinearFilter;
  tex.generateMipmaps = true;
  tex.needsUpdate = true;
  return tex;
}

/** Bullet-hole decal atlas: 2x2 variants, albedo in RGB with a hole in alpha. */
function buildHoleAtlas(size = 256) {
  const cell = size / 2;
  const cv = document.createElement('canvas');
  cv.width = cv.height = size;
  const g = cv.getContext('2d');
  for (let k = 0; k < 4; k++) {
    const ox = (k % 2) * cell, oy = Math.floor(k / 2) * cell;
    const img = g.createImageData(cell, cell);
    for (let y = 0; y < cell; y++) {
      for (let x = 0; x < cell; x++) {
        const u = (x / cell - 0.5) * 2, v = (y / cell - 0.5) * 2;
        const ang = Math.atan2(v, u);
        const r = Math.hypot(u, v);
        // Irregular rim: the crater lip is what makes it read as an impact.
        const wob = 0.20 + 0.06 * vnoise(Math.cos(ang) * 3 + k * 9, Math.sin(ang) * 3, 21 + k);
        const hole = smoothstep(wob + 0.05, wob - 0.02, r);
        const rim = Math.exp(-Math.pow((r - wob * 1.9) / (wob * 1.5), 2));
        const spall = Math.pow(clamp01(1 - r), 2.2) * (0.4 + 0.6 * fbm(x * 0.12 + k * 30, y * 0.12, 4, 5));
        const dark = clamp01(hole * 1.2);
        const light = clamp01(rim * 0.5 + spall * 0.35);
        const a = clamp01(hole + rim * 0.75 + spall * 0.6);
        const i = (y * cell + x) * 4;
        const c = clamp01(0.55 + light - dark);
        img.data[i] = c * 215;
        img.data[i + 1] = c * 210;
        img.data[i + 2] = c * 200;
        img.data[i + 3] = a * 255;
      }
    }
    g.putImageData(img, ox, oy);
  }
  const tex = new THREE.CanvasTexture(cv);
  tex.colorSpace = THREE.SRGBColorSpace;
  tex.needsUpdate = true;
  return tex;
}

/* ========================================================================== */
/*  Surface response table                                                     */
/* ========================================================================== */

const SURFACE_FX = {
  concrete: { dust: 0xb9b1a2, sparks: 0,  chips: 0xa8a091, n: 14, spread: 0.55, puff: 1.0 },
  metal:    { dust: 0x8a8a8a, sparks: 16, chips: 0xb0b0b0, n: 5,  spread: 0.35, puff: 0.4 },
  wood:     { dust: 0x8a6a44, sparks: 0,  chips: 0x6d4e33, n: 12, spread: 0.5,  puff: 0.7 },
  dirt:     { dust: 0x8b7a5e, sparks: 0,  chips: 0x6a5c46, n: 18, spread: 0.7,  puff: 1.35 },
  sand:     { dust: 0xc0ad8a, sparks: 0,  chips: 0x9c8a6c, n: 20, spread: 0.75, puff: 1.5 },
  glass:    { dust: 0xcfe0ea, sparks: 3,  chips: 0xdfeaf2, n: 16, spread: 0.6,  puff: 0.3 },
  flesh:    { dust: 0x8a1410, sparks: 0,  chips: 0x6a0d0a, n: 16, spread: 0.45, puff: 0.2 },
  foliage:  { dust: 0x5a6a3a, sparks: 0,  chips: 0x4a5734, n: 10, spread: 0.6,  puff: 0.3 },
  water:    { dust: 0xa8c4d8, sparks: 0,  chips: 0xc8dcea, n: 20, spread: 0.5,  puff: 0.8 },
};

/* ========================================================================== */

export class Effects {
  constructor(ctx) {
    this.ctx = ctx;
    this.max = Math.max(600, Math.floor(MAX_PARTICLES * (ctx.quality.particles || 1)));
    this.head = 0;
    this.time = 0;
    this.decals = [];
    this.maxDecals = ctx.quality.decals || 96;
    this.tracers = [];
    this.shells = [];
    this._lights = [];
  }

  async init() {
    const { ctx } = this;
    this.atlas = buildAtlas(512);
    this.holes = buildHoleAtlas(256);
    this._buildParticles();
    this._buildTracers();
    this._buildShells();
    this._buildMuzzle();
    this._bind();
  }

  // -------------------------------------------------------------------------

  _buildParticles() {
    const n = this.max;
    const geo = new THREE.InstancedBufferGeometry();
    const quad = new THREE.PlaneGeometry(1, 1);
    geo.index = quad.index;
    geo.attributes.position = quad.attributes.position;
    geo.attributes.uv = quad.attributes.uv;

    this.pPos = new Float32Array(n * 3);
    this.pVel = new Float32Array(n * 3);
    this.pData = new Float32Array(n * 4);   // birth, life, size0, size1
    this.pMisc = new Float32Array(n * 4);   // atlasIndex, drag, gravity, rotation
    this.pCol0 = new Float32Array(n * 3);
    this.pCol1 = new Float32Array(n * 3);
    this.pFlags = new Float32Array(n);      // 0 = billboard, 1 = velocity-aligned streak

    const A = (name, arr, size) => {
      const a = new THREE.InstancedBufferAttribute(arr, size);
      a.setUsage(THREE.DynamicDrawUsage);
      geo.setAttribute(name, a);
      return a;
    };
    this.aPos = A('iPos', this.pPos, 3);
    this.aVel = A('iVel', this.pVel, 3);
    this.aData = A('iData', this.pData, 4);
    this.aMisc = A('iMisc', this.pMisc, 4);
    this.aCol0 = A('iCol0', this.pCol0, 3);
    this.aCol1 = A('iCol1', this.pCol1, 3);
    this.aFlags = A('iFlags', this.pFlags, 1);
    geo.instanceCount = n;
    // Particles are all over the map; a fixed huge sphere beats reculling.
    geo.boundingSphere = new THREE.Sphere(new THREE.Vector3(), 1e5);

    const mat = new THREE.ShaderMaterial({
      transparent: true,
      depthWrite: false,
      depthTest: true,
      blending: THREE.NormalBlending,
      uniforms: {
        uMap: { value: this.atlas },
        uTime: { value: 0 },
        uFogColor: { value: new THREE.Color(0x9fb0bf) },
      },
      vertexShader: /* glsl */`
        attribute vec3 iPos, iVel, iCol0, iCol1;
        attribute vec4 iData, iMisc;
        attribute float iFlags;
        uniform float uTime;
        varying vec2 vUv;
        varying vec3 vCol;
        varying float vAlpha;
        varying float vAdditive;

        void main() {
          float age = uTime - iData.x;
          float life = iData.y;
          float t = age / life;
          if (age < 0.0 || t > 1.0) {
            gl_Position = vec4(2.0, 2.0, 2.0, 1.0);   // cull offscreen
            return;
          }

          // Integrate with exponential drag, analytically — no CPU stepping.
          float drag = iMisc.y;
          float k = drag > 0.001 ? (1.0 - exp(-drag * age)) / drag : age;
          vec3 pos = iPos + iVel * k;
          pos.y -= 0.5 * iMisc.z * age * age;

          float size = mix(iData.z, iData.w, t);
          vAlpha = (1.0 - t) * (1.0 - t);
          vCol = mix(iCol0, iCol1, t);
          vAdditive = step(0.5, iFlags);

          // Atlas cell
          float idx = iMisc.x;
          vec2 cell = vec2(mod(idx, 4.0), floor(idx / 4.0));
          vUv = (uv + cell) * 0.25;

          vec4 mv = modelViewMatrix * vec4(pos, 1.0);
          vec2 corner = position.xy * size;

          if (iFlags > 1.5) {
            // Velocity-aligned streak: stretch along the screen-space velocity.
            vec3 vWorld = iVel * exp(-drag * age);
            vec4 mvB = modelViewMatrix * vec4(pos + vWorld * 0.012, 1.0);
            vec2 dir = mvB.xy - mv.xy;
            float l = length(dir);
            if (l > 1e-5) {
              dir /= l;
              vec2 perp = vec2(-dir.y, dir.x);
              float stretch = size * (1.0 + min(l * 26.0, 7.0));
              corner = dir * position.x * stretch + perp * position.y * size * 0.5;
            }
          } else {
            float rot = iMisc.w + age * 0.7;
            float c = cos(rot), s = sin(rot);
            corner = vec2(corner.x * c - corner.y * s, corner.x * s + corner.y * c);
          }

          mv.xy += corner;
          gl_Position = projectionMatrix * mv;
        }
      `,
      fragmentShader: /* glsl */`
        uniform sampler2D uMap;
        varying vec2 vUv;
        varying vec3 vCol;
        varying float vAlpha;
        varying float vAdditive;
        void main() {
          vec4 tex = texture2D(uMap, vUv);
          float a = tex.a * vAlpha;
          if (a < 0.004) discard;
          vec3 c = tex.rgb * vCol;
          // Additive particles (sparks, fire) pre-multiply so they blend hot.
          gl_FragColor = vec4(c * (1.0 + vAdditive * 2.5), a);
        }
      `,
    });

    this.points = new THREE.Mesh(geo, mat);
    this.points.frustumCulled = false;
    this.points.renderOrder = 10;
    this.points.name = 'fx.particles';
    this.ctx.scene.add(this.points);
    this.pMat = mat;
  }

  /**
   * Spawn one particle. Writes into the ring buffer and flags the attribute
   * range dirty; the shader does the rest.
   */
  spawn(o) {
    const i = this.head;
    this.head = (this.head + 1) % this.max;
    const i3 = i * 3, i4 = i * 4;
    this.pPos[i3] = o.x; this.pPos[i3 + 1] = o.y; this.pPos[i3 + 2] = o.z;
    this.pVel[i3] = o.vx; this.pVel[i3 + 1] = o.vy; this.pVel[i3 + 2] = o.vz;
    this.pData[i4] = this.time;
    this.pData[i4 + 1] = o.life;
    this.pData[i4 + 2] = o.size0;
    this.pData[i4 + 3] = o.size1;
    this.pMisc[i4] = o.atlas;
    this.pMisc[i4 + 1] = o.drag ?? 1.5;
    this.pMisc[i4 + 2] = o.gravity ?? 0;
    this.pMisc[i4 + 3] = Math.random() * 6.28;
    _c.setHex(o.c0); this.pCol0[i3] = _c.r; this.pCol0[i3 + 1] = _c.g; this.pCol0[i3 + 2] = _c.b;
    _c.setHex(o.c1); this.pCol1[i3] = _c.r; this.pCol1[i3 + 1] = _c.g; this.pCol1[i3 + 2] = _c.b;
    this.pFlags[i] = o.flags ?? 0;
    this._dirty = true;
  }

  // -------------------------------------------------------------------------

  _buildTracers() {
    const geo = new THREE.PlaneGeometry(1, 1);
    const mat = new THREE.MeshBasicMaterial({
      color: 0xffd08a, transparent: true, opacity: 0.9,
      blending: THREE.AdditiveBlending, depthWrite: false, toneMapped: false, fog: false,
    });
    this.tracerMesh = new THREE.InstancedMesh(geo, mat, MAX_TRACERS);
    this.tracerMesh.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
    this.tracerMesh.frustumCulled = false;
    this.tracerMesh.count = 0;
    this.tracerMesh.name = 'fx.tracers';
    this.ctx.scene.add(this.tracerMesh);
  }

  _buildShells() {
    const geo = new THREE.CylinderGeometry(0.0045, 0.0050, 0.019, 7);
    geo.rotateZ(Math.PI / 2);
    const mat = new THREE.MeshStandardMaterial({ color: 0xb08d3a, metalness: 1, roughness: 0.34 });
    this.shellMesh = new THREE.InstancedMesh(geo, mat, MAX_SHELLS);
    this.shellMesh.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
    this.shellMesh.frustumCulled = false;
    this.shellMesh.castShadow = false;
    this.shellMesh.count = 0;
    this.shellMesh.name = 'fx.shells';
    this.ctx.scene.add(this.shellMesh);
    for (let i = 0; i < MAX_SHELLS; i++) {
      this.shells.push({
        alive: false, pos: new THREE.Vector3(), vel: new THREE.Vector3(),
        spin: new THREE.Vector3(), rot: new THREE.Euler(), life: 0, resting: false,
      });
    }
  }

  _buildMuzzle() {
    const g = new THREE.Group();
    g.name = 'fx.muzzle';
    g.visible = false;
    const star = new THREE.Mesh(
      new THREE.PlaneGeometry(0.30, 0.30),
      new THREE.MeshBasicMaterial({
        map: this.atlas, transparent: true, blending: THREE.AdditiveBlending,
        depthWrite: false, depthTest: false, toneMapped: false, fog: false,
        color: 0xffd9a0,
      })
    );
    // Point the star cell of the atlas at the flash quad.
    star.geometry.attributes.uv.array.set([0.25, 0.75, 0.5, 0.75, 0.25, 0.5, 0.5, 0.5]);
    star.renderOrder = 12;
    const glow = new THREE.Mesh(
      new THREE.PlaneGeometry(0.5, 0.5),
      new THREE.MeshBasicMaterial({
        map: this.atlas, transparent: true, blending: THREE.AdditiveBlending,
        depthWrite: false, depthTest: false, toneMapped: false, fog: false, color: 0xff9a4a,
      })
    );
    glow.geometry.attributes.uv.array.set([0.0, 1.0, 0.25, 1.0, 0.0, 0.75, 0.25, 0.75]);
    glow.renderOrder = 11;
    g.add(glow, star);
    this.muzzleGroup = g;
    this.muzzleStar = star;
    this.muzzleGlow = glow;
    // On the camera, for the same reason the weapon rig is: the muzzle anchor
    // it tracks is now in camera space.
    this.ctx.viewCamera.add(g);

    this.muzzleLight = new THREE.PointLight(0xffb060, 0, 14, 2);
    this.muzzleLight.castShadow = false;
    this.ctx.scene.add(this.muzzleLight);
    this._muzzleT = -1;

    // A pool of short-lived point lights for impacts and explosions.
    for (let i = 0; i < 4; i++) {
      const l = new THREE.PointLight(0xffffff, 0, 20, 2);
      l.visible = false;
      this.ctx.scene.add(l);
      this._lights.push({ light: l, t: -1, dur: 0, peak: 0 });
    }
  }

  _flashLight(pos, color, peak, dur) {
    let slot = this._lights.find((l) => l.t < 0) || this._lights[0];
    slot.light.position.copy(pos);
    slot.light.color.setHex(color);
    slot.light.visible = true;
    slot.t = 0; slot.dur = dur; slot.peak = peak;
  }

  // -------------------------------------------------------------------------

  _bind() {
    const bus = this.ctx.bus;
    bus.on('impact', (e) => this.impact(e));
    bus.on('hit:enemy', (e) => this.impact({ point: e.point, normal: e.normal, surface: 'flesh', dir: e.dir }));
    bus.on('enemy:death', (e) => this.deathPuff(e));
    bus.on('tracer', (e) => this.tracer(e));
    bus.on('weapon:fire', (e) => this.muzzleFlash(e));
    bus.on('shell', (e) => this.shell(e));
    bus.on('explosion', (e) => this.explosion(e));
    bus.on('grenade:bounce', () => {});
    bus.on('player:step', (e) => this.footDust(e));
  }

  // -------------------------------------------------------------------------
  //  Effects
  // -------------------------------------------------------------------------

  impact(e) {
    const s = SURFACE_FX[e.surface] || SURFACE_FX.concrete;
    const p = e.point, n = e.normal;
    const q = this.ctx.quality.particles;

    // Debris cone about the surface normal, biased back along the bullet.
    const count = Math.max(3, Math.round(s.n * q));
    for (let i = 0; i < count; i++) {
      _v.set(
        n.x + (Math.random() - 0.5) * s.spread * 2,
        n.y + (Math.random() - 0.5) * s.spread * 2,
        n.z + (Math.random() - 0.5) * s.spread * 2
      ).normalize().multiplyScalar(1.4 + Math.random() * 3.2);
      const isChip = i % 3 === 0;
      this.spawn({
        x: p.x + n.x * 0.02, y: p.y + n.y * 0.02, z: p.z + n.z * 0.02,
        vx: _v.x, vy: _v.y, vz: _v.z,
        life: isChip ? 0.55 + Math.random() * 0.5 : 0.35 + Math.random() * 0.3,
        size0: isChip ? 0.012 + Math.random() * 0.02 : 0.03,
        size1: isChip ? 0.008 : 0.09,
        atlas: isChip ? ATLAS.debris : ATLAS.dust,
        drag: isChip ? 0.8 : 4.5,
        gravity: isChip ? 9.0 : 0.6,
        c0: isChip ? s.chips : s.dust,
        c1: isChip ? s.chips : s.dust,
      });
    }

    // Lingering puff
    const puffs = Math.max(1, Math.round(3 * s.puff * q));
    for (let i = 0; i < puffs; i++) {
      this.spawn({
        x: p.x + n.x * 0.06 + (Math.random() - 0.5) * 0.08,
        y: p.y + n.y * 0.06 + (Math.random() - 0.5) * 0.08,
        z: p.z + n.z * 0.06 + (Math.random() - 0.5) * 0.08,
        vx: n.x * 0.7, vy: n.y * 0.7 + 0.35, vz: n.z * 0.7,
        life: 0.9 + Math.random() * 0.8,
        size0: 0.10 * s.puff, size1: 0.55 * s.puff,
        atlas: ATLAS.smoke, drag: 3.2, gravity: -0.25,
        c0: s.dust, c1: s.dust,
      });
    }

    // Sparks: additive, velocity-aligned streaks.
    for (let i = 0; i < Math.round(s.sparks * q); i++) {
      _v.set(
        n.x + (Math.random() - 0.5) * 1.5,
        n.y + (Math.random() - 0.5) * 1.5,
        n.z + (Math.random() - 0.5) * 1.5
      ).normalize().multiplyScalar(4 + Math.random() * 9);
      this.spawn({
        x: p.x, y: p.y, z: p.z, vx: _v.x, vy: _v.y, vz: _v.z,
        life: 0.22 + Math.random() * 0.35,
        size0: 0.016, size1: 0.004,
        atlas: ATLAS.spark, drag: 1.2, gravity: 11,
        c0: 0xffd090, c1: 0xff4008, flags: 2,
      });
    }

    if (s.sparks > 0) this._flashLight(p, 0xffa040, 3.5, 0.07);
    if (e.surface !== 'flesh') this.decal(p, n, e.dir);
    else this.bloodDecal(p, n);
  }

  deathPuff(e) {
    const p = e.point;
    for (let i = 0; i < Math.round(10 * this.ctx.quality.particles); i++) {
      _v.set(Math.random() - 0.5, Math.random() * 0.6, Math.random() - 0.5).normalize().multiplyScalar(1.5);
      this.spawn({
        x: p.x, y: p.y, z: p.z, vx: _v.x, vy: _v.y, vz: _v.z,
        life: 0.9, size0: 0.06, size1: 0.3, atlas: ATLAS.blood,
        drag: 3, gravity: 3, c0: 0x8a1410, c1: 0x3a0806,
      });
    }
  }

  footDust(e) {
    if (!e.running) return;
    const p = this.ctx.player?.feetPosition;
    if (!p) return;
    this.spawn({
      x: p.x, y: p.y + 0.03, z: p.z,
      vx: (Math.random() - 0.5) * 0.4, vy: 0.3, vz: (Math.random() - 0.5) * 0.4,
      life: 0.6, size0: 0.06, size1: 0.3, atlas: ATLAS.dust,
      drag: 4, gravity: -0.2,
      c0: (SURFACE_FX[e.surface] || SURFACE_FX.concrete).dust,
      c1: (SURFACE_FX[e.surface] || SURFACE_FX.concrete).dust,
    });
  }

  tracer(e) {
    if (this.tracers.length >= MAX_TRACERS) this.tracers.shift();
    this.tracers.push({
      from: e.from.clone(), to: e.to.clone(),
      dist: e.from.distanceTo(e.to),
      t: 0, speed: e.speed || 600,
    });
  }

  muzzleFlash(e) {
    this._muzzleT = 0;
    this._muzzleScale = 0.75 + Math.random() * 0.6;
    this._muzzleRot = Math.random() * Math.PI * 2;
    this.muzzleLight.position.copy(e.origin);
    // Smoke from the muzzle, accumulating under sustained fire.
    for (let i = 0; i < Math.round(2 * this.ctx.quality.particles); i++) {
      _v.copy(e.dir).multiplyScalar(2.2 + Math.random() * 1.5);
      this.spawn({
        x: e.origin.x, y: e.origin.y, z: e.origin.z,
        vx: _v.x + (Math.random() - 0.5), vy: _v.y + 0.5, vz: _v.z + (Math.random() - 0.5),
        life: 0.5 + Math.random() * 0.5,
        size0: 0.04, size1: 0.30, atlas: ATLAS.smoke,
        drag: 5, gravity: -0.4, c0: 0xb0a89c, c1: 0x8a8378,
      });
    }
  }

  shell(e) {
    const s = this.shells.find((x) => !x.alive);
    if (!s) return;
    s.alive = true; s.resting = false; s.life = 8;
    s.pos.copy(e.position);
    s.vel.copy(e.velocity);
    s.spin.set((Math.random() - 0.5) * 26, (Math.random() - 0.5) * 22, (Math.random() - 0.5) * 30);
    s.rot.set(Math.random() * 6, Math.random() * 6, Math.random() * 6);
  }

  explosion(e) {
    const p = e.point;
    const q = this.ctx.quality.particles;
    this._flashLight(p, 0xfff0c0, 60, 0.55);
    this.ctx.bus.emit('shake', { amount: 0.85, duration: 0.5 });

    // Fireball core
    for (let i = 0; i < Math.round(26 * q); i++) {
      _v.set(Math.random() - 0.5, Math.random() - 0.3, Math.random() - 0.5).normalize()
        .multiplyScalar(3 + Math.random() * 9);
      this.spawn({
        x: p.x, y: p.y, z: p.z, vx: _v.x, vy: _v.y, vz: _v.z,
        life: 0.35 + Math.random() * 0.4, size0: 0.4, size1: 1.5,
        atlas: ATLAS.fire, drag: 3.5, gravity: -3,
        c0: 0xfff4d0, c1: 0xd04000, flags: 2,
      });
    }
    // Smoke column
    for (let i = 0; i < Math.round(24 * q); i++) {
      _v.set(Math.random() - 0.5, Math.random() * 0.9, Math.random() - 0.5).normalize()
        .multiplyScalar(1.5 + Math.random() * 4);
      this.spawn({
        x: p.x, y: p.y + 0.2, z: p.z, vx: _v.x, vy: _v.y + 1.2, vz: _v.z,
        life: 1.8 + Math.random() * 1.8, size0: 0.5, size1: 3.6,
        atlas: ATLAS.smoke, drag: 1.4, gravity: -0.8,
        c0: 0x5a5248, c1: 0x2a2724,
      });
    }
    // Ground-hugging dust shockwave
    for (let i = 0; i < Math.round(20 * q); i++) {
      const a = (i / 20) * Math.PI * 2;
      this.spawn({
        x: p.x, y: p.y + 0.1, z: p.z,
        vx: Math.cos(a) * 11, vy: 0.4, vz: Math.sin(a) * 11,
        life: 0.9, size0: 0.3, size1: 2.4, atlas: ATLAS.dust,
        drag: 4.5, gravity: 0.2, c0: 0xbdb2a0, c1: 0x9c9384,
      });
    }
    // Debris
    for (let i = 0; i < Math.round(18 * q); i++) {
      _v.set(Math.random() - 0.5, Math.random() * 1.2, Math.random() - 0.5).normalize()
        .multiplyScalar(6 + Math.random() * 12);
      this.spawn({
        x: p.x, y: p.y, z: p.z, vx: _v.x, vy: _v.y, vz: _v.z,
        life: 1.4, size0: 0.05, size1: 0.03, atlas: ATLAS.debris,
        drag: 0.4, gravity: 15, c0: 0x6a655c, c1: 0x4a463f,
      });
    }
    this.scorch(p);
  }

  // -------------------------------------------------------------------------
  //  Decals
  // -------------------------------------------------------------------------

  _decalMaterial(map, opacity, color) {
    return new THREE.MeshStandardMaterial({
      map, transparent: true, opacity,
      depthTest: true, depthWrite: false,
      polygonOffset: true, polygonOffsetFactor: -4, polygonOffsetUnits: -4,
      roughness: 0.9, metalness: 0,
      color: color ?? 0xffffff,
    });
  }

  /**
   * Project a decal onto the world. DecalGeometry clips against the target
   * mesh, so holes wrap around corners instead of floating in mid-air.
   */
  decal(point, normal, dir, opts = {}) {
    const target = this.ctx.physics?.collider;
    if (!target) return;
    const size = opts.size ?? (0.10 + Math.random() * 0.06);

    // Orient the decal box to face along the surface normal, with random roll.
    _v.copy(point).addScaledVector(normal, 0.01);
    _m.lookAt(_v, _v2.copy(_v).add(normal), _up);
    _q.setFromRotationMatrix(_m);
    const roll = new THREE.Quaternion().setFromAxisAngle(normal, Math.random() * Math.PI * 2);
    _q.premultiply(roll);
    const euler = new THREE.Euler().setFromQuaternion(_q);

    let geo;
    try {
      geo = new DecalGeometry(target, _v, euler, _v3.set(size, size, 0.25));
    } catch { return; }
    if (!geo.attributes.position || geo.attributes.position.count === 0) { geo.dispose(); return; }

    if (!this._holeMat) this._holeMat = this._decalMaterial(this.holes, 0.95);
    const mesh = new THREE.Mesh(geo, opts.material || this._holeMat);
    mesh.renderOrder = 4;
    mesh.receiveShadow = false;
    this.ctx.scene.add(mesh);
    this._pushDecal(mesh, opts.life ?? 45);
  }

  bloodDecal(point, normal) {
    if (!this._bloodMat) this._bloodMat = this._decalMaterial(this.holes, 0.85, 0x5a0a06);
    this.decal(point, normal, null, { material: this._bloodMat, size: 0.22 + Math.random() * 0.2, life: 30 });
  }

  scorch(point) {
    if (!this._scorchMat) this._scorchMat = this._decalMaterial(this.holes, 0.8, 0x1a1714);
    _v.set(0, 1, 0);
    this.decal(point, _v, null, { material: this._scorchMat, size: 3.2, life: 60 });
  }

  _pushDecal(mesh, life) {
    this.decals.push({ mesh, life, max: life });
    while (this.decals.length > this.maxDecals) {
      const old = this.decals.shift();
      old.mesh.removeFromParent();
      old.mesh.geometry.dispose();
    }
  }

  // -------------------------------------------------------------------------

  update(dt, time) {
    this.time = time;
    this.pMat.uniforms.uTime.value = time;

    if (this._dirty) {
      for (const a of [this.aPos, this.aVel, this.aData, this.aMisc, this.aCol0, this.aCol1, this.aFlags]) {
        a.needsUpdate = true;
      }
      this._dirty = false;
    }

    this._updateTracers(dt);
    this._updateShells(dt);
    this._updateMuzzle(dt);
    this._updateLights(dt);
    this._updateDecals(dt);
  }

  _updateTracers(dt) {
    const cam = this.ctx.camera;
    let n = 0;
    for (let i = this.tracers.length - 1; i >= 0; i--) {
      const t = this.tracers[i];
      t.t += dt;
      const travelled = t.t * t.speed;
      if (travelled > t.dist + 2) { this.tracers.splice(i, 1); continue; }
      if (n >= MAX_TRACERS) continue;

      // A short bright segment moving from muzzle to impact.
      const headD = Math.min(travelled, t.dist);
      const tailD = Math.max(0, headD - 5.5);
      _v.lerpVectors(t.from, t.to, headD / t.dist);
      _v2.lerpVectors(t.from, t.to, tailD / t.dist);
      const len = _v.distanceTo(_v2);
      if (len < 0.01) continue;
      _v3.addVectors(_v, _v2).multiplyScalar(0.5);

      // Billboard the quad about its own axis so it always faces the camera.
      const axis = _v.clone().sub(_v2).normalize();
      const toCam = cam.position.clone().sub(_v3).normalize();
      const side = axis.clone().cross(toCam).normalize();
      const up2 = side.clone().cross(axis).normalize();
      _m.makeBasis(side, axis, up2);
      _m.setPosition(_v3);
      _m.scale(_v.set(0.035, len, 1));
      this.tracerMesh.setMatrixAt(n++, _m);
    }
    this.tracerMesh.count = n;
    if (n) this.tracerMesh.instanceMatrix.needsUpdate = true;
  }

  _updateShells(dt) {
    const phys = this.ctx.physics;
    let n = 0;
    for (const s of this.shells) {
      if (!s.alive) continue;
      s.life -= dt;
      if (s.life <= 0) { s.alive = false; continue; }
      if (!s.resting) {
        s.vel.y -= 16 * dt;
        _v.copy(s.vel).multiplyScalar(dt);
        const d = _v.length();
        if (d > 1e-5 && phys?.raycast) {
          _v2.copy(_v).multiplyScalar(1 / d);
          const hit = phys.raycast(s.pos, _v2, d + 0.01, { skipEnemies: true });
          if (hit) {
            s.pos.copy(hit.point).addScaledVector(hit.normal, 0.006);
            const vn = hit.normal.dot(s.vel);
            s.vel.addScaledVector(hit.normal, -1.35 * vn).multiplyScalar(0.42);
            s.spin.multiplyScalar(0.5);
            this.ctx.bus.emit('shell:bounce', { point: s.pos.clone(), speed: Math.abs(vn) });
            if (s.vel.lengthSq() < 0.35) { s.resting = true; s.vel.set(0, 0, 0); }
          } else s.pos.add(_v);
        } else s.pos.add(_v);
        s.rot.x += s.spin.x * dt; s.rot.y += s.spin.y * dt; s.rot.z += s.spin.z * dt;
      }
      if (n < MAX_SHELLS) {
        _q.setFromEuler(s.rot);
        _m.compose(s.pos, _q, _v.set(1, 1, 1));
        // Fade out by shrinking in the last second, so they never pop.
        if (s.life < 1) _m.scale(_v.setScalar(s.life));
        this.shellMesh.setMatrixAt(n++, _m);
      }
    }
    this.shellMesh.count = n;
    if (n) this.shellMesh.instanceMatrix.needsUpdate = true;
  }

  _updateMuzzle(dt) {
    if (this._muzzleT < 0) {
      this.muzzleGroup.visible = false;
      this.muzzleLight.intensity = 0;
      return;
    }
    this._muzzleT += dt;
    const DUR = 0.045;
    const t = this._muzzleT / DUR;
    if (t >= 1) { this._muzzleT = -1; return; }

    const weapons = this.ctx.weapons;
    const model = weapons?.models?.[weapons.slots[weapons.index]];
    const muzzle = model?.userData?.anchors?.muzzle;
    if (!muzzle) { this._muzzleT = -1; return; }

    this.muzzleGroup.visible = true;
    // The muzzle anchor and the flash are both children of the view camera
    // now, so the anchor's world transform converts straight into the flash's
    // parent space, and the flash needs no rotation of its own.
    muzzle.updateWorldMatrix(true, false);
    _v.setFromMatrixPosition(muzzle.matrixWorld);
    this.ctx.viewCamera.worldToLocal(_v);
    this.muzzleGroup.position.copy(_v);
    this.muzzleGroup.quaternion.identity();

    const fade = 1 - t;
    const s = this._muzzleScale * (0.7 + fade * 0.5);
    this.muzzleStar.scale.setScalar(s);
    this.muzzleStar.rotation.z = this._muzzleRot;
    this.muzzleStar.material.opacity = fade;
    this.muzzleGlow.scale.setScalar(s * 1.7);
    this.muzzleGlow.material.opacity = fade * 0.7;

    muzzle.getWorldPosition(_v);
    this.muzzleLight.intensity = fade * 26;
  }

  _updateLights(dt) {
    for (const l of this._lights) {
      if (l.t < 0) continue;
      l.t += dt;
      const k = 1 - l.t / l.dur;
      if (k <= 0) { l.t = -1; l.light.visible = false; l.light.intensity = 0; continue; }
      l.light.intensity = l.peak * k * k;
    }
  }

  _updateDecals(dt) {
    for (let i = this.decals.length - 1; i >= 0; i--) {
      const d = this.decals[i];
      d.life -= dt;
      if (d.life <= 0) {
        d.mesh.removeFromParent();
        d.mesh.geometry.dispose();
        this.decals.splice(i, 1);
      } else if (d.life < 3) {
        // Shared materials, so fade with the mesh's own opacity override.
        d.mesh.material.opacity = Math.min(d.mesh.material.opacity, 0.95 * (d.life / 3));
      }
    }
  }
}
