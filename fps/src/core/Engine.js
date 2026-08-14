import * as THREE from 'three';
import { EffectComposer } from 'three/examples/jsm/postprocessing/EffectComposer.js';
import { RenderPass } from 'three/examples/jsm/postprocessing/RenderPass.js';
import { UnrealBloomPass } from 'three/examples/jsm/postprocessing/UnrealBloomPass.js';
import { GTAOPass } from 'three/examples/jsm/postprocessing/GTAOPass.js';
import { OutputPass } from 'three/examples/jsm/postprocessing/OutputPass.js';
import { ShaderPass } from 'three/examples/jsm/postprocessing/ShaderPass.js';
import { SMAAPass } from 'three/examples/jsm/postprocessing/SMAAPass.js';
import { Bus } from './Bus.js';
import { Input } from './Input.js';
import { rand, clamp } from './Contracts.js';
import { FinalGradeShader } from '../render/FinalGradeShader.js';

/** Detect a sane quality tier from the GPU string + screen size. */
function detectQuality() {
  // Explicit override wins: ?quality=low|medium|high. Used by the screenshot
  // harness (software GL cannot carry the High tier) and by anyone whose GPU
  // the sniffing below gets wrong.
  const forced = new URLSearchParams(location.search).get('quality');
  if (forced) {
    const i = ['low', 'medium', 'high'].indexOf(forced.toLowerCase());
    if (i >= 0) return i;
  }
  let tier = 2; // 0 low, 1 medium, 2 high
  try {
    const c = document.createElement('canvas');
    const gl = c.getContext('webgl2') || c.getContext('webgl');
    const dbg = gl && gl.getExtension('WEBGL_debug_renderer_info');
    const r = dbg ? String(gl.getParameter(dbg.UNMASKED_RENDERER_WEBGL)) : '';
    if (/SwiftShader|llvmpipe|Software|Mesa OffScreen/i.test(r)) tier = 1;
    if (/Intel.*(HD|UHD) Graphics (5|6)/i.test(r)) tier = 1;
  } catch { /* ignore */ }
  if (navigator.hardwareConcurrency && navigator.hardwareConcurrency <= 4) tier = Math.min(tier, 1);
  return tier;
}

const QUALITY = [
  // texRes is deliberately not tied to the rest of the tier: generating
  // textures is a one-off CPU cost paid behind the loading screen, not a
  // per-frame GPU cost. Only genuinely memory-constrained machines want 256,
  // and at 256 every surface degenerates into the same coarse speckle.
  { name: 'Low',    shadowSize: 1024, shadows: true,  ssao: false, bloom: true,  smaa: false, dpr: 1.0,  decals: 48,  particles: 0.4, motionBlur: false, sssShadow: false, texRes: 384, practicals: 3 },
  { name: 'Medium', shadowSize: 2048, shadows: true,  ssao: true,  bloom: true,  smaa: true,  dpr: 1.25, decals: 96,  particles: 0.7, motionBlur: true,  sssShadow: false, texRes: 512, practicals: 5 },
  { name: 'High',   shadowSize: 4096, shadows: true,  ssao: true,  bloom: true,  smaa: true,  dpr: 1.5,  decals: 192, particles: 1.0, motionBlur: true,  sssShadow: true,  texRes: 512, practicals: 8 },
];

export class Engine {
  constructor(canvas) {
    this.canvas = canvas;
    this.tier = detectQuality();
    this.quality = { ...QUALITY[this.tier], tier: this.tier };

    const renderer = new THREE.WebGLRenderer({
      canvas,
      antialias: false,          // SMAA handles it in post
      powerPreference: 'high-performance',
      stencil: false,
      depth: true,
      alpha: false,
      // The WebGL back buffer is invalidated once it has been presented, so an
      // out-of-frame reader (a screenshot tool, canvas.toDataURL) gets black or
      // a stale partial tile. Opt in only when something is capturing: it
      // forces an extra buffer copy every frame and is not free.
      preserveDrawingBuffer: new URLSearchParams(location.search).has('capture'),
    });
    renderer.setPixelRatio(Math.min(window.devicePixelRatio, this.quality.dpr));
    renderer.outputColorSpace = THREE.SRGBColorSpace;
    renderer.toneMapping = THREE.NoToneMapping;   // done in OutputPass
    renderer.shadowMap.enabled = this.quality.shadows;
    renderer.shadowMap.type = THREE.PCFSoftShadowMap;
    renderer.shadowMap.autoUpdate = true;
    renderer.info.autoReset = false;
    this.renderer = renderer;

    this.scene = new THREE.Scene();
    this.viewScene = new THREE.Scene();

    const aspect = window.innerWidth / window.innerHeight;
    this.camera = new THREE.PerspectiveCamera(80, aspect, 0.05, 900);
    this.viewCamera = new THREE.PerspectiveCamera(55, aspect, 0.008, 12);

    this.bus = new Bus();
    this.input = new Input(canvas, this.bus);
    this.clock = new THREE.Clock();
    this.systems = [];
    this.paused = false;
    this.time = 0;
    this.frame = 0;

    this.ctx = {
      renderer, scene: this.scene, camera: this.camera,
      viewScene: this.viewScene, viewCamera: this.viewCamera,
      bus: this.bus, input: this.input, quality: this.quality, rand,
      engine: this,
    };

    this._buildPipeline();
    this._bindResize();

    // Frame-time smoothed FPS for the dynamic-resolution governor.
    this._fpsAvg = 60;
    this._dprScale = 1;
  }

  _buildPipeline() {
    const w = window.innerWidth, h = window.innerHeight;
    const target = new THREE.WebGLRenderTarget(w, h, {
      type: THREE.HalfFloatType,
      colorSpace: THREE.LinearSRGBColorSpace,
      samples: 0,
      depthBuffer: true,
    });
    const composer = new EffectComposer(this.renderer, target);
    composer.setPixelRatio(this.renderer.getPixelRatio());
    composer.setSize(w, h);

    const worldPass = new RenderPass(this.scene, this.camera);
    composer.addPass(worldPass);

    if (this.quality.ssao) {
      const gtao = new GTAOPass(this.scene, this.camera, w, h);
      gtao.output = GTAOPass.OUTPUT.Default;
      gtao.updateGtaoMaterial({
        radius: 0.42,
        distanceExponent: 1.4,
        thickness: 0.6,
        scale: 1.15,
        samples: this.tier >= 2 ? 16 : 8,
        distanceFallOff: 1.0,
        screenSpaceRadius: false,
      });
      gtao.updatePdMaterial({ lumaPhi: 8, depthPhi: 2.2, normalPhi: 3.6, radius: 3, rings: 2, samples: 8 });
      composer.addPass(gtao);
      this.gtao = gtao;
    }

    // Viewmodel: same buffer, depth cleared, so the weapon never intersects walls.
    const viewPass = new RenderPass(this.viewScene, this.viewCamera);
    viewPass.clear = false;
    viewPass.clearDepth = true;
    composer.addPass(viewPass);

    if (this.quality.bloom) {
      // Threshold was 0.92 against a physical sky whose near-sun radiance is
      // enormous, so any view within ~50 degrees of the sun pushed most of the
      // frame over the line and the mip chain smeared it into a cream veil —
      // it brightened ground three metres from the camera, where there is no
      // fog to speak of. Higher threshold, less strength, tighter radius.
      const bloom = new UnrealBloomPass(new THREE.Vector2(w, h), 0.26, 0.4, 1.5);
      composer.addPass(bloom);
      this.bloom = bloom;
    }

    const output = new OutputPass();
    this.renderer.toneMapping = THREE.AgXToneMapping;
    // 0.72 was set against a much dimmer sun (2.75). At the bible's 4.2 it
    // clips the top end, and AgX cannot recover what arrives already white.
    this.renderer.toneMappingExposure = 0.58;
    composer.addPass(output);

    if (this.quality.smaa) composer.addPass(new SMAAPass(w, h));

    const grade = new ShaderPass(FinalGradeShader);
    grade.uniforms.uResolution.value.set(w, h);
    grade.renderToScreen = true;
    composer.addPass(grade);
    this.grade = grade;

    this.composer = composer;
  }

  _bindResize() {
    const onResize = () => {
      const w = window.innerWidth, h = window.innerHeight;
      this.camera.aspect = w / h; this.camera.updateProjectionMatrix();
      this.viewCamera.aspect = w / h; this.viewCamera.updateProjectionMatrix();
      this.renderer.setSize(w, h, false);
      this.composer.setSize(w, h);
      this.grade.uniforms.uResolution.value.set(w, h);
      if (this.gtao) this.gtao.setSize(w, h);
      this.bus.emit('resize', { w, h });
    };
    window.addEventListener('resize', onResize);
    onResize();
  }

  add(system) { this.systems.push(system); return system; }

  async initAll() {
    for (const s of this.systems) if (s.init) await s.init();
  }

  start() {
    let last = performance.now();
    const loop = (now) => {
      this._raf = requestAnimationFrame(loop);
      let dt = (now - last) / 1000;
      last = now;
      if (dt > 0.1) dt = 0.1;         // don't let a stall teleport the world
      this.time += dt;
      this.frame++;
      this._fpsAvg += ((1 / Math.max(dt, 1e-4)) - this._fpsAvg) * 0.05;
      this.tick(dt);
    };
    this._raf = requestAnimationFrame(loop);
  }

  tick(dt) {
    this.input.poll();
    const sdt = this.paused ? 0 : dt;
    for (let i = 0; i < this.systems.length; i++) {
      const s = this.systems[i];
      if (s.update) s.update(s.alwaysUpdate ? dt : sdt, this.time);
    }
    this.renderer.info.reset();
    this.composer.render(dt);
    this.input.endFrame();
    this._governor(dt);
  }

  /** Dynamic resolution: keeps frame time under budget on weak GPUs. */
  _governor() {
    // Give the FPS average time to mean something before acting on it, and
    // leave the resolution alone while paused — a menu is not a perf sample.
    if (this.frame < 120 || this.paused) return;
    if (this.frame % 45 !== 0) return;
    const targetLo = 52, targetHi = 58;
    let s = this._dprScale;
    if (this._fpsAvg < targetLo && s > 0.62) s -= 0.08;
    else if (this._fpsAvg > targetHi && s < 1) s += 0.04;
    else return;
    this._dprScale = clamp(s, 0.62, 1);

    const w = window.innerWidth, h = window.innerHeight;
    const dpr = Math.min(window.devicePixelRatio, this.quality.dpr) * this._dprScale;
    this.renderer.setPixelRatio(dpr);
    this.renderer.setSize(w, h, false);
    this.composer.setPixelRatio(dpr);
    // setPixelRatio alone leaves the composer's targets sized for the previous
    // ratio for one frame, which renders the scene into a corner of an
    // otherwise black buffer. Resize them explicitly.
    this.composer.setSize(w, h);
    if (this.gtao) this.gtao.setSize(w, h);
    this.grade.uniforms.uResolution.value.set(w, h);
  }
}
