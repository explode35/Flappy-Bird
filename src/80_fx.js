/* ============================================================================
   FX — pooled GPU particles, a hand-rolled post chain (bloom / chromatic
   aberration / speed lines / vignette), and the chase camera.
   ========================================================================= */

const PARTICLE_VS = `
  attribute float aSize;
  attribute float aAlpha;
  attribute vec3 aColor;
  varying vec3 vColor; varying float vAlpha;
  void main(){
    vColor = aColor; vAlpha = aAlpha;
    vec4 mv = modelViewMatrix * vec4(position, 1.0);
    gl_PointSize = aSize * (320.0 / max(-mv.z, 1.0));
    gl_Position = projectionMatrix * mv;
  }`;
const PARTICLE_FS = `
  uniform sampler2D uMap;
  varying vec3 vColor; varying float vAlpha;
  void main(){
    vec4 t = texture2D(uMap, gl_PointCoord);
    gl_FragColor = vec4(vColor, t.a * vAlpha);
    if (gl_FragColor.a < 0.01) discard;
  }`;

class ParticleGroup {
  constructor(count, sprite, additive) {
    this.count = count;
    const g = new THREE.BufferGeometry();
    this.pos = new Float32Array(count * 3);
    this.col = new Float32Array(count * 3);
    this.size = new Float32Array(count);
    this.alpha = new Float32Array(count);
    for (let i = 0; i < count; i++) this.pos[i * 3 + 1] = -9999;
    g.setAttribute('position', new THREE.BufferAttribute(this.pos, 3).setUsage(THREE.DynamicDrawUsage));
    g.setAttribute('aColor', new THREE.BufferAttribute(this.col, 3).setUsage(THREE.DynamicDrawUsage));
    g.setAttribute('aSize', new THREE.BufferAttribute(this.size, 1).setUsage(THREE.DynamicDrawUsage));
    g.setAttribute('aAlpha', new THREE.BufferAttribute(this.alpha, 1).setUsage(THREE.DynamicDrawUsage));
    g.setDrawRange(0, count);
    g.boundingSphere = new THREE.Sphere(new THREE.Vector3(), 1e6);
    this.geo = g;
    this.mat = new THREE.ShaderMaterial({
      uniforms: { uMap: { value: sprite } },
      vertexShader: PARTICLE_VS, fragmentShader: PARTICLE_FS,
      transparent: true, depthWrite: false,
      blending: additive ? THREE.AdditiveBlending : THREE.NormalBlending
    });
    this.points = new THREE.Points(g, this.mat);
    this.points.frustumCulled = false;
    this.points.renderOrder = additive ? 12 : 10;

    // particle state (structure of arrays keeps the update loop allocation-free)
    this.vx = new Float32Array(count); this.vy = new Float32Array(count); this.vz = new Float32Array(count);
    this.life = new Float32Array(count); this.maxLife = new Float32Array(count);
    this.grav = new Float32Array(count); this.drag = new Float32Array(count);
    this.size0 = new Float32Array(count); this.size1 = new Float32Array(count);
    this.a0 = new Float32Array(count);
    this.cursor = 0;
    this.active = 0;
  }

  emit(x, y, z, vx, vy, vz, colorHex, life, s0, s1, grav, drag, alpha) {
    const i = this.cursor;
    this.cursor = (this.cursor + 1) % this.count;
    this.pos[i * 3] = x; this.pos[i * 3 + 1] = y; this.pos[i * 3 + 2] = z;
    this.vx[i] = vx; this.vy[i] = vy; this.vz[i] = vz;
    _c0.setHex(colorHex);
    this.col[i * 3] = _c0.r; this.col[i * 3 + 1] = _c0.g; this.col[i * 3 + 2] = _c0.b;
    this.life[i] = life; this.maxLife[i] = life;
    this.size0[i] = s0; this.size1[i] = s1;
    this.grav[i] = grav; this.drag[i] = drag;
    this.a0[i] = alpha == null ? 1 : alpha;
    this.size[i] = s0;
    this.alpha[i] = this.a0[i];
  }

  update(dt) {
    const n = this.count;
    let live = 0;
    for (let i = 0; i < n; i++) {
      if (this.life[i] <= 0) { if (this.alpha[i] !== 0) { this.alpha[i] = 0; } continue; }
      this.life[i] -= dt;
      const t = 1 - clamp01(this.life[i] / this.maxLife[i]);
      const d = Math.exp(-this.drag[i] * dt);
      this.vx[i] *= d; this.vz[i] *= d;
      this.vy[i] = this.vy[i] * d + this.grav[i] * dt;
      this.pos[i * 3] += this.vx[i] * dt;
      this.pos[i * 3 + 1] += this.vy[i] * dt;
      this.pos[i * 3 + 2] += this.vz[i] * dt;
      this.size[i] = lerp(this.size0[i], this.size1[i], t);
      this.alpha[i] = this.a0[i] * (1 - t * t);
      if (this.life[i] <= 0) this.alpha[i] = 0;
      live++;
    }
    this.active = live;
    this.geo.attributes.position.needsUpdate = true;
    this.geo.attributes.aColor.needsUpdate = true;
    this.geo.attributes.aSize.needsUpdate = true;
    this.geo.attributes.aAlpha.needsUpdate = true;
  }
  clear() {
    for (let i = 0; i < this.count; i++) { this.life[i] = 0; this.alpha[i] = 0; }
  }
}

class FX {
  constructor(scene, quality) {
    this.scene = scene;
    const n = quality === 'low' ? 900 : 2600;
    this.spark = new ParticleGroup(n, makeSpriteTexture('spark'), true);
    this.glow = new ParticleGroup(Math.floor(n * .55), makeSpriteTexture('soft'), true);
    this.smoke = new ParticleGroup(Math.floor(n * .7), makeSpriteTexture('smoke'), false);
    scene.add(this.spark.points, this.glow.points, this.smoke.points);
    this._trailAcc = 0;

    // pooled impact rings
    const ringGeo = new THREE.RingGeometry(.6, 1, 24);
    ringGeo.rotateX(-Math.PI / 2);
    this.rings = new Pool(() => {
      const m = new THREE.Mesh(ringGeo, new THREE.MeshBasicMaterial({
        color: 0xffffff, transparent: true, opacity: 1, blending: THREE.AdditiveBlending,
        depthWrite: false, side: THREE.DoubleSide
      }));
      m.visible = false;
      scene.add(m);
      return { obj: m, life: 0, max: 1, scale: 1, _alive: false };
    }, 12);
  }

  update(dt) {
    this.spark.update(dt);
    this.glow.update(dt);
    this.smoke.update(dt);
    this.rings.forEach(r => {
      r.life -= dt;
      if (r.life <= 0) { r._alive = false; r.obj.visible = false; return; }
      const t = 1 - r.life / r.max;
      r.obj.scale.setScalar(lerp(1, r.scale, t * (2 - t)));
      r.obj.material.opacity = (1 - t) * .85;
    });
  }
  clear() { this.spark.clear(); this.glow.clear(); this.smoke.clear(); this.rings.releaseAll(); this.rings.forEach(r => r.obj.visible = false); }

  /* ---- named effects ---- */
  ring(pos, color, scale, life) {
    const r = this.rings.get();
    r.obj.visible = true;
    r.obj.position.copy(pos);
    r.obj.position.y += .4;
    r.obj.scale.setScalar(1);
    r.obj.material.color.setHex(color);
    r.life = life || .5; r.max = r.life; r.scale = scale || 8;
  }

  burst(pos, color, count, speed) {
    for (let i = 0; i < count; i++) {
      const a = Math.random() * TAU, e = Math.random() * 1.2;
      const sp = speed * (.4 + Math.random() * .8);
      this.spark.emit(pos.x, pos.y, pos.z,
        Math.cos(a) * sp * Math.cos(e), Math.sin(e) * sp, Math.sin(a) * sp * Math.cos(e),
        color, .35 + Math.random() * .4, 1.6, .2, -12, 1.4, 1);
    }
  }

  explode(pos, color) {
    this.burst(pos, color, 30, 17);
    this.burst(pos, 0xffffff, 10, 9);
    for (let i = 0; i < 12; i++) {
      const a = Math.random() * TAU;
      this.smoke.emit(pos.x, pos.y, pos.z,
        Math.cos(a) * 5, 2 + Math.random() * 4, Math.sin(a) * 5,
        0x554455, .9 + Math.random() * .6, 2.2, 7, 1.5, .9, .5);
    }
    this.ring(pos, color, 14, .45);
  }

  boostRing(kart) {
    this.ring(kart.pos, shade(kart.ch.color, 1.5), 11, .4);
  }

  trail(pos, color, dt) {
    this._trailAcc += dt;
    if (this._trailAcc < .012) return;
    this._trailAcc = 0;
    this.glow.emit(pos.x, pos.y, pos.z, rand(-1.5, 1.5), rand(0, 2), rand(-1.5, 1.5),
      color, .35, 2.4, .3, 3, 2, .8);
  }

  /**
   * Emission budget helper: turns a per-second rate into a whole number of
   * particles this frame, carrying the fraction so the rate is frame-rate
   * independent instead of "however many times update() happened to run".
   */
  _budget(obj, key, perSec, dt) {
    const c = (obj[key] || 0) + perSec * dt;
    const n = Math.min(6, Math.floor(c));
    obj[key] = c - Math.floor(c);
    return n;
  }

  /** Wheel dust / skid smoke for a kart on a given surface. */
  wheels(kart, sd, dt, intensity) {
    if (sd.rate <= 0 && !kart.drifting) return;
    const o = kart.obj.userData;
    const n = this._budget(kart, '_dustAcc', sd.rate * intensity * 34, dt);
    for (let i = 0; i < n; i++) {
      const w = o.wheels[2 + (i & 1)];
      w.getWorldPosition(_v4);
      this.smoke.emit(_v4.x, _v4.y - .2, _v4.z,
        rand(-2.5, 2.5) - kart.vel.x * .12, rand(1.4, 4.2), rand(-2.5, 2.5) - kart.vel.z * .12,
        sd.dust, .55 + Math.random() * .5, 1.1, 5.5 + Math.random() * 3, 2.2, 1.1, .5);
    }
  }

  /** Drift sparks, tinted by charge tier — the tier's colour is the whole tell. */
  driftSparks(kart, tier, dt) {
    const o = kart.obj.userData;
    const col = [0xffffff, 0x4fc3ff, 0xff9d3c, 0xc86bff][tier];
    const n = this._budget(kart, '_sparkAcc', 26 + tier * 26, dt);
    const back = -Math.sin(kart.yaw), backz = -Math.cos(kart.yaw);
    for (let i = 0; i < n; i++) {
      const w = o.wheels[2 + (i & 1)];
      w.getWorldPosition(_v4);
      this.spark.emit(_v4.x, _v4.y - .25, _v4.z,
        back * rand(3, 12) + rand(-4, 4), rand(1.5, 6.5), backz * rand(3, 12) + rand(-4, 4),
        col, .22 + Math.random() * .26, .8 + tier * .28, .1, -22, 2.4, .9);
    }
    if (tier >= 2) {
      const g = this._budget(kart, '_glowAcc', 10 + tier * 6, dt);
      for (let i = 0; i < g; i++) {
        o.wheels[2 + (i & 1)].getWorldPosition(_v4);
        this.glow.emit(_v4.x, _v4.y - .1, _v4.z, rand(-2, 2), rand(1, 3), rand(-2, 2),
          col, .3, 2.0 + tier * .5, .4, 2, 2.4, .45);
      }
    }
  }

  /** Exhaust / boost flame from the tail pipes. */
  exhaust(kart, dt, boosting) {
    const o = kart.obj.userData;
    const arr = [o.exL, o.exR];
    const bx = -Math.sin(kart.yaw), bz = -Math.cos(kart.yaw);
    if (boosting) {
      const n = this._budget(kart, '_exAcc', 46, dt);
      for (let i = 0; i < n; i++) {
        arr[i & 1].getWorldPosition(_v4);
        this.spark.emit(_v4.x, _v4.y, _v4.z,
          bx * rand(10, 26) + rand(-2, 2), rand(-.5, 2), bz * rand(10, 26) + rand(-2, 2),
          (i & 2) ? 0xfff0a0 : shade(kart.ch.color, 1.5), .16 + Math.random() * .2, 1.5, .25, 1, 3, .75);
      }
      const g = this._budget(kart, '_exGlowAcc', 14, dt);
      for (let i = 0; i < g; i++) {
        arr[i & 1].getWorldPosition(_v4);
        this.glow.emit(_v4.x, _v4.y, _v4.z, bx * 6, 1, bz * 6, 0x9fdcff, .26, 2.2, .5, 2, 2.5, .32);
      }
    } else {
      const n = this._budget(kart, '_exAcc', 9, dt);
      for (let i = 0; i < n; i++) {
        arr[i & 1].getWorldPosition(_v4);
        this.smoke.emit(_v4.x, _v4.y, _v4.z, bx * rand(2, 6) + rand(-1, 1), rand(.6, 2), bz * rand(2, 6) + rand(-1, 1),
          0x8a8f9c, .5, .6, 2.6, .8, 1.6, .16);
      }
    }
  }
}

/* ========================================================================== */
/*  POST PROCESSING                                                            */
/* ========================================================================== */

const QUAD_VS = `varying vec2 vUv; void main(){ vUv = uv; gl_Position = vec4(position.xy, 0.0, 1.0); }`;

class PostFX {
  constructor(renderer, quality) {
    this.renderer = renderer;
    this.quality = quality;
    this.scene = new THREE.Scene();
    this.cam = new THREE.OrthographicCamera(-1, 1, 1, -1, 0, 1);
    const g = new THREE.PlaneGeometry(2, 2);
    this.quad = new THREE.Mesh(g, null);
    this.quad.frustumCulled = false;
    this.scene.add(this.quad);

    const rtOpt = { minFilter: THREE.LinearFilter, magFilter: THREE.LinearFilter, format: THREE.RGBAFormat, depthBuffer: true, stencilBuffer: false };
    this.rtScene = new THREE.WebGLRenderTarget(2, 2, rtOpt);
    this.rtA = new THREE.WebGLRenderTarget(2, 2, { minFilter: THREE.LinearFilter, magFilter: THREE.LinearFilter, format: THREE.RGBAFormat, depthBuffer: false });
    this.rtB = new THREE.WebGLRenderTarget(2, 2, { minFilter: THREE.LinearFilter, magFilter: THREE.LinearFilter, format: THREE.RGBAFormat, depthBuffer: false });

    this.matBright = new THREE.ShaderMaterial({
      uniforms: { tDiffuse: { value: null }, uThreshold: { value: .62 }, uSoft: { value: .35 } },
      vertexShader: QUAD_VS,
      fragmentShader: `
        uniform sampler2D tDiffuse; uniform float uThreshold, uSoft; varying vec2 vUv;
        void main(){
          vec3 c = texture2D(tDiffuse, vUv).rgb;
          float l = dot(c, vec3(0.2126,0.7152,0.0722));
          float k = smoothstep(uThreshold, uThreshold + uSoft, l);
          gl_FragColor = vec4(c * k, 1.0);
        }`
    });

    this.matBlur = new THREE.ShaderMaterial({
      uniforms: { tDiffuse: { value: null }, uDir: { value: new THREE.Vector2(1, 0) }, uRes: { value: new THREE.Vector2(1, 1) } },
      vertexShader: QUAD_VS,
      fragmentShader: `
        uniform sampler2D tDiffuse; uniform vec2 uDir; uniform vec2 uRes; varying vec2 vUv;
        void main(){
          vec2 px = uDir / uRes;
          vec3 s = texture2D(tDiffuse, vUv).rgb * 0.227027;
          s += texture2D(tDiffuse, vUv + px*1.3846).rgb * 0.316216;
          s += texture2D(tDiffuse, vUv - px*1.3846).rgb * 0.316216;
          s += texture2D(tDiffuse, vUv + px*3.2308).rgb * 0.070270;
          s += texture2D(tDiffuse, vUv - px*3.2308).rgb * 0.070270;
          gl_FragColor = vec4(s, 1.0);
        }`
    });

    this.matComposite = new THREE.ShaderMaterial({
      uniforms: {
        tDiffuse: { value: null }, tBloom: { value: null },
        uBloom: { value: 1.0 }, uChroma: { value: 0.0 }, uVignette: { value: 0.42 },
        uSpeed: { value: 0.0 }, uTime: { value: 0.0 }, uStorm: { value: 0.0 },
        uFlash: { value: new THREE.Vector3(0, 0, 0) }, uSat: { value: 1.06 },
        uAspect: { value: 1.0 }, uExposure: { value: 1.0 }
      },
      vertexShader: QUAD_VS,
      fragmentShader: `
        uniform sampler2D tDiffuse, tBloom;
        uniform float uBloom, uChroma, uVignette, uSpeed, uTime, uStorm, uSat, uAspect, uExposure;
        uniform vec3 uFlash;
        varying vec2 vUv;
        float hash(vec2 p){ return fract(sin(dot(p, vec2(41.3,289.1)))*43758.5453); }
        void main(){
          vec2 uv = vUv;
          vec2 c = uv - 0.5;
          float r2 = dot(c, c);

          // ion-storm: the screen buckles and the colours invert in waves
          if(uStorm > 0.001){
            uv += vec2(sin(uv.y*22.0 + uTime*9.0), cos(uv.x*18.0 - uTime*7.0)) * 0.016 * uStorm;
          }

          // chromatic aberration grows toward the edges and with speed
          float ca = uChroma * (0.25 + r2 * 1.5);
          vec2 dir = normalize(c + 1e-5);
          vec3 col;
          col.r = texture2D(tDiffuse, uv - dir * ca).r;
          col.g = texture2D(tDiffuse, uv).g;
          col.b = texture2D(tDiffuse, uv + dir * ca).b;

          vec3 bloom = texture2D(tBloom, uv).rgb;
          col += bloom * uBloom;

          // radial speed lines
          if(uSpeed > 0.001){
            float ang = atan(c.y * uAspect, c.x);
            float lines = hash(vec2(floor(ang * 34.0), 3.0));
            float streak = smoothstep(0.16, 0.5, r2) * step(0.72, lines);
            float flick = 0.6 + 0.4 * sin(uTime * 40.0 + lines * 90.0);
            col += vec3(0.85, 0.94, 1.0) * streak * uSpeed * 0.5 * flick;
            col *= 1.0 - smoothstep(0.1, 0.62, r2) * uSpeed * 0.28;
          }

          if(uStorm > 0.001){
            float band = step(0.5, fract(uv.y*9.0 - uTime*1.7));
            col = mix(col, vec3(1.0) - col, band * uStorm * 0.85);
            col *= mix(1.0, 0.55, uStorm);
            col += vec3(0.45,0.25,0.8) * uStorm * 0.28;
          }

          col += uFlash;

          // vignette + gentle saturation lift
          float vig = smoothstep(0.85, 0.18, r2 * (1.0 + uVignette));
          col *= mix(1.0, vig, uVignette);
          float lum = dot(col, vec3(0.2126,0.7152,0.0722));
          col = mix(vec3(lum), col, uSat);

          // ACES-style filmic curve, then encode to sRGB for display. Without
          // the encode everything reads as flat, milky linear light.
          col *= uExposure;
          col = clamp((col * (2.51 * col + 0.03)) / (col * (2.43 * col + 0.59) + 0.14), 0.0, 1.0);
          col = pow(col, vec3(1.0 / 2.2));
          gl_FragColor = vec4(col, 1.0);
        }`
    });
  }

  setSize(w, h, dpr) {
    w = Math.max(2, Math.floor(w * dpr)); h = Math.max(2, Math.floor(h * dpr));
    if (this._w === w && this._h === h) return;
    this._w = w; this._h = h;
    this.rtScene.setSize(w, h);
    const div = this.quality === 'low' ? 4 : 3;
    this.bw = Math.max(2, Math.floor(w / div));
    this.bh = Math.max(2, Math.floor(h / div));
    this.rtA.setSize(this.bw, this.bh);
    this.rtB.setSize(this.bw, this.bh);
  }

  /** Render `scene` from `camera` and composite into the current framebuffer rect. */
  render(scene, camera, params, rect) {
    const r = this.renderer;
    const u = this.matComposite.uniforms;

    r.setRenderTarget(this.rtScene);
    r.setViewport(0, 0, this._w, this._h);
    r.setScissorTest(false);
    r.clear(true, true, true);
    r.render(scene, camera);

    if (params.bloom > 0.001) {
      // bright pass
      this.quad.material = this.matBright;
      this.matBright.uniforms.tDiffuse.value = this.rtScene.texture;
      this.matBright.uniforms.uThreshold.value = params.threshold;
      r.setRenderTarget(this.rtA);
      r.setViewport(0, 0, this.bw, this.bh);
      r.render(this.scene, this.cam);

      // separable blur, two passes
      this.quad.material = this.matBlur;
      this.matBlur.uniforms.uRes.value.set(this.bw, this.bh);
      const passes = this.quality === 'low' ? 1 : 2;
      for (let i = 0; i < passes; i++) {
        this.matBlur.uniforms.tDiffuse.value = this.rtA.texture;
        this.matBlur.uniforms.uDir.value.set(1 + i * 1.4, 0);
        r.setRenderTarget(this.rtB); r.render(this.scene, this.cam);
        this.matBlur.uniforms.tDiffuse.value = this.rtB.texture;
        this.matBlur.uniforms.uDir.value.set(0, 1 + i * 1.4);
        r.setRenderTarget(this.rtA); r.render(this.scene, this.cam);
      }
    }

    // composite to the screen
    this.quad.material = this.matComposite;
    u.tDiffuse.value = this.rtScene.texture;
    u.tBloom.value = this.rtA.texture;
    u.uBloom.value = params.bloom;
    u.uChroma.value = params.chroma;
    u.uVignette.value = params.vignette;
    u.uSpeed.value = params.speed;
    u.uStorm.value = params.storm;
    u.uTime.value = params.time;
    u.uSat.value = params.sat;
    u.uAspect.value = rect.w / Math.max(1, rect.h);
    u.uExposure.value = params.exposure;
    u.uFlash.value.set(params.flash[0], params.flash[1], params.flash[2]);

    r.setRenderTarget(null);
    r.setViewport(rect.x, rect.y, rect.w, rect.h);
    r.setScissor(rect.x, rect.y, rect.w, rect.h);
    r.setScissorTest(true);
    r.render(this.scene, this.cam);
  }

  dispose() {
    this.rtScene.dispose(); this.rtA.dispose(); this.rtB.dispose();
  }
}

/* ========================================================================== */
/*  CHASE CAMERA                                                               */
/* ========================================================================== */

class ChaseCam {
  constructor(aspect) {
    this.cam = new THREE.PerspectiveCamera(66, aspect, 0.4, 3000);
    this.pos = new THREE.Vector3();
    this.look = new THREE.Vector3();
    this.shake = 0;
    this.shakeT = 0;
    this.fov = 66;
    this.roll = 0;
    this.orbit = 0;
    this.mode = 'chase';
    this._first = true;
  }

  addShake(a) { this.shake = Math.min(1.6, this.shake + a); }

  update(kart, dt, opts) {
    const cam = this.cam;
    const speedFrac = clamp01(Math.abs(kart.speed) / kart.stats.top);
    const boosting = kart.boostTime > 0;

    // ideal camera pose: behind and above, pulled back with speed
    const dist = lerp(9.4, 12.6, speedFrac) + (boosting ? 1.4 : 0);
    const height = lerp(4.0, 5.0, speedFrac);
    let yaw = kart.yaw;
    if (opts.look) yaw += Math.PI;
    // trail the drift: the camera hangs behind the kart's rotation a little
    if (kart.drifting) yaw += kart.driftDir * .22;

    _v0.set(Math.sin(yaw), 0, Math.cos(yaw));
    _v1.copy(kart.pos).addScaledVector(_v0, -dist);
    _v1.y += height;

    // pre-race flyby: a wide, slowly swinging shot that settles into the chase
    if (opts.intro > 0.001) {
      this.introA = (this.introA || 0) + dt * .55;
      const ang = yaw + Math.PI * .78 + this.introA * .5;
      _v3.set(kart.pos.x + Math.sin(ang) * 22, kart.pos.y + 11 + opts.intro * 8, kart.pos.z + Math.cos(ang) * 22);
      _v1.lerp(_v3, opts.intro);
    }

    const follow = this._first ? 1 : 1 - Math.exp(-(kart.grounded ? 8.5 : 4.5) * dt);
    this.pos.lerp(_v1, follow);
    if (this._first) { this.pos.copy(_v1); this._first = false; }

    // look slightly ahead of the kart, and into the drift
    _v2.copy(kart.pos).addScaledVector(_v0, 8 + speedFrac * 7);
    _v2.y += 1.6;
    if (kart.drifting) _v2.addScaledVector(_v1.set(-Math.cos(kart.yaw), 0, Math.sin(kart.yaw)), kart.driftDir * 3.2);
    if (opts.intro > 0.001) _v2.lerp(_v4.copy(kart.pos).setY(kart.pos.y + 1.2), opts.intro);
    this.look.lerp(_v2, this._first ? 1 : 1 - Math.exp(-11 * dt));

    // shake
    this.shakeT += dt;
    this.shake = Math.max(0, this.shake - dt * 2.1);
    const sh = this.shake + (opts.surfShake || 0);
    let sx = 0, sy = 0;
    if (sh > 0.001) {
      sx = Math.sin(this.shakeT * 47.3) * Math.sin(this.shakeT * 23.1) * sh * .55;
      sy = Math.cos(this.shakeT * 39.7) * Math.sin(this.shakeT * 17.9) * sh * .45;
    }

    cam.position.copy(this.pos);
    cam.position.x += sx; cam.position.y += sy;
    cam.up.set(0, 1, 0);
    cam.lookAt(this.look);

    // roll into drifts and banking
    const targetRoll = -kart.yawVel * .055 + (kart.drifting ? kart.driftDir * .055 : 0)
      + clamp((kart._bankLean || 0) * .5, -.34, .34);
    this.roll = damp(this.roll, targetRoll, 6, dt);
    cam.rotateZ(this.roll + sx * .02);

    // FOV: widens with speed, punches out on a boost
    const targetFov = 64 + speedFrac * 12 + (boosting ? 9 : 0) + (opts.fovBias || 0);
    this.fov = damp(this.fov, targetFov, boosting ? 9 : 5, dt);
    if (Math.abs(cam.fov - this.fov) > .01) { cam.fov = this.fov; cam.updateProjectionMatrix(); }
  }

  /** Smooth orbit used on the results screen. */
  orbitAround(target, dt, radius, height) {
    this.orbit += dt * .28;
    const cam = this.cam;
    cam.position.set(
      target.x + Math.sin(this.orbit) * radius,
      target.y + height,
      target.z + Math.cos(this.orbit) * radius
    );
    cam.up.set(0, 1, 0);
    cam.lookAt(target.x, target.y + 1.2, target.z);
    if (Math.abs(cam.fov - 52) > .01) { cam.fov = damp(cam.fov, 52, 3, dt); cam.updateProjectionMatrix(); }
  }
}
