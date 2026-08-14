import * as THREE from 'three';
import { Sky as SkyMesh } from 'three/examples/jsm/objects/Sky.js';
import { HeightFog } from './atmos/HeightFog.js';
import { Dust } from './atmos/Dust.js';
import { glowSprite, streakSprite, ghostSprite } from './atmos/Textures.js';
import { damp, clamp, smoothstep } from '../core/Contracts.js';

/**
 * Sky, sun, image-based lighting and atmosphere.
 *
 * All values come from ART_DIRECTION.md §2 — an 8.5° dusk sun at 118° azimuth,
 * warm key against cool ambient. The environment map is a PMREM of the physical
 * sky, which is what makes metal and shadowed surfaces read correctly; a flat
 * AmbientLight would flatten everything.
 */

const SUN_ELEVATION = 8.5;
const SUN_AZIMUTH = 118;
const SUN_COLOR = 0xffd2a1;
// The art bible asks for 4.2. Running at 2.75 with the ambient unchanged is
// most of why nothing in the map reads as being in shadow: a surface in the
// shade of a cornice still receives the whole sky dome, so the shadow term is
// drowned rather than missing.
const SUN_INTENSITY = 4.2;
const FILL_COLOR = 0x5c6a7a;
// The fill was 12x weaker than the sun, which left every shaded face lit by
// the environment alone — and the environment's lower hemisphere was warm
// brown, so shade came out warm grey instead of the bible's cool #5c6a7a.
//
// 0.95 fixed the hue and cost the shadows: the fill comes from above as well
// as from the anti-sun side, so it lands on upward-facing surfaces, which is
// exactly where a cast shadow needs to be dark. scripts/probe-shadow.mjs
// measures the trade — at the 14_cornice camera, killing all ambient takes
// the ground from 53% to 77% of pixels below the dark threshold. 0.5 keeps
// most of the colour separation (it is still 2.3x the old value) and gives
// the shadow term room to read.
const FILL_INTENSITY = 0.5;
const SHADOW_EXTENT = 55;      // metres covered by the sun's ortho frustum
const EXPOSURE_BASE = 0.58;    // matches Engine's initial toneMappingExposure
const EXPOSURE_SQUINT = 0.55;  // how far down exposure goes staring at the sun

const _v = new THREE.Vector3();
const _center = new THREE.Vector3();
const _camDir = new THREE.Vector3();
const _sunPos = new THREE.Vector3();

export class Sky {
  constructor(ctx) {
    this.ctx = ctx;
    this.sunDirection = new THREE.Vector3();
    this._exposure = EXPOSURE_BASE;
    this.timeOfDay = 0.5;
    this._flare = 0;
    this._occTimer = 0;
    this._occluded = 0;
  }

  async init() {
    const { ctx } = this;
    const scene = ctx.scene;

    this._computeSunDirection(SUN_ELEVATION, SUN_AZIMUTH);

    // ---- physical sky -----------------------------------------------------
    const sky = new SkyMesh();
    sky.scale.setScalar(6000);
    sky.name = 'sky';
    const u = sky.material.uniforms;
    // The Mie terms are the whole of the "looking at the sun destroys the
    // frame" problem. mieDirectionalG 0.86 is a very tight forward-scatter
    // lobe and 0.007 is a lot of aerosol to put behind it, so the aureole
    // around an 8.5-degree sun covered a third of the screen at a radiance no
    // tonemap can bring back. Smaller lobe, less of it.
    u.turbidity.value = 4.2;
    u.rayleigh.value = 2.4;
    u.mieCoefficient.value = 0.0032;
    u.mieDirectionalG.value = 0.74;
    _sunPos.copy(this.sunDirection).multiplyScalar(1000);
    u.sunPosition.value.copy(_sunPos);
    scene.add(sky);
    this.skyMesh = sky;

    // ---- IBL --------------------------------------------------------------
    // One PMREM bake of the sky. The sun is fixed, so this never needs redoing.
    const pmrem = new THREE.PMREMGenerator(ctx.renderer);
    pmrem.compileEquirectangularShader();
    const envScene = new THREE.Scene();
    const skyClone = new SkyMesh();
    skyClone.scale.setScalar(100);
    const cu = skyClone.material.uniforms;
    cu.turbidity.value = u.turbidity.value;
    cu.rayleigh.value = u.rayleigh.value;
    cu.mieCoefficient.value = u.mieCoefficient.value;
    cu.mieDirectionalG.value = u.mieDirectionalG.value;
    cu.sunPosition.value.copy(_sunPos);
    envScene.add(skyClone);
    // A large dim ground plane so the lower hemisphere isn't pure black —
    // without it, everything below the horizon line loses its bounce light.
    const ground = new THREE.Mesh(
      new THREE.SphereGeometry(90, 16, 8, 0, Math.PI * 2, Math.PI / 2, Math.PI / 2),
      new THREE.MeshBasicMaterial({ color: 0x3d4652, side: THREE.BackSide })
    );
    envScene.add(ground);

    // PMREMGenerator renders cube faces through its own viewport/scissor and
    // does not reliably restore them. Snapshot and put them back afterwards —
    // a leaked scissor rectangle silently truncates every subsequent frame.
    const _vp = new THREE.Vector4();
    const _sc = new THREE.Vector4();
    ctx.renderer.getViewport(_vp);
    ctx.renderer.getScissor(_sc);
    const _scTest = ctx.renderer.getScissorTest();

    const envRT = pmrem.fromScene(envScene, 0.02);

    ctx.renderer.setViewport(_vp);
    ctx.renderer.setScissor(_sc);
    ctx.renderer.setScissorTest(_scTest);
    ctx.renderer.setRenderTarget(null);
    scene.environment = envRT.texture;
    scene.environmentIntensity = 0.17;
    this.envRT = envRT;
    skyClone.geometry.dispose();
    skyClone.material.dispose();
    ground.geometry.dispose();
    ground.material.dispose();
    pmrem.dispose();

    // ---- sun --------------------------------------------------------------
    const sun = new THREE.DirectionalLight(SUN_COLOR, SUN_INTENSITY);
    sun.name = 'sun';
    sun.castShadow = ctx.quality.shadows;
    const size = ctx.quality.shadowSize;
    sun.shadow.mapSize.set(size, size);
    sun.shadow.bias = -0.0008;
    sun.shadow.normalBias = 0.02;
    sun.shadow.radius = 3;
    const sc = sun.shadow.camera;
    sc.near = 0.5; sc.far = SHADOW_EXTENT * 3.2;
    sc.left = -SHADOW_EXTENT; sc.right = SHADOW_EXTENT;
    sc.top = SHADOW_EXTENT; sc.bottom = -SHADOW_EXTENT;
    sc.updateProjectionMatrix();
    scene.add(sun);
    scene.add(sun.target);
    this.sunLight = sun;
    this._texelSize = (SHADOW_EXTENT * 2) / size;

    // ---- fill -------------------------------------------------------------
    // Bounce from the sky-opposite side so shadow detail survives.
    const fill = new THREE.DirectionalLight(FILL_COLOR, FILL_INTENSITY);
    fill.position.copy(this.sunDirection).multiplyScalar(-40);
    fill.position.y = Math.abs(fill.position.y) + 25;
    scene.add(fill);
    this.fillLight = fill;

    // ---- height fog -------------------------------------------------------
    this.fog = new HeightFog(scene);
    this.fog.setSunDirection(this.sunDirection);
    // three still needs *a* fog object present for the chunks to be included.
    scene.fog = new THREE.FogExp2(0x8fa3b8, 0.012);

    // ---- airborne particulate --------------------------------------------
    if (ctx.quality.tier >= 1) {
      this.dust = new Dust({
        count: Math.round(1200 * ctx.quality.particles),
        radius: 24,
        rand: ctx.rand,
      });
      this.dust.setSunDirection(this.sunDirection);
      scene.add(this.dust.points);
    }

    this._buildFlare();
  }

  _computeSunDirection(elevDeg, azimDeg) {
    const phi = THREE.MathUtils.degToRad(90 - elevDeg);
    const theta = THREE.MathUtils.degToRad(azimDeg);
    this.sunDirection.setFromSphericalCoords(1, phi, theta).normalize();
  }

  /**
   * Lens flare: a soft glow that grows as you look into the sun, an anamorphic
   * streak, and two ghosts. Deliberately restrained — the bloom pass does most
   * of the work, this just gives it something to bloom.
   */
  _buildFlare() {
    const grp = new THREE.Group();
    grp.name = 'sunflare';
    grp.frustumCulled = false;
    const mk = (tex, size, color, opacity) => {
      const m = new THREE.Mesh(
        new THREE.PlaneGeometry(size, size),
        new THREE.MeshBasicMaterial({
          map: tex, color, transparent: true, opacity,
          blending: THREE.AdditiveBlending, depthWrite: false, depthTest: false,
          toneMapped: false, fog: false,
        })
      );
      m.frustumCulled = false;
      return m;
    };
    this.flareGlow = mk(glowSprite(128, 3.4, 0.0), 0.42, 0xffd9b0, 1);
    this.flareStreak = mk(streakSprite(512, 64), 0.7, 0xffc48c, 0.30);
    this.flareStreak.scale.set(6, 0.5, 1);
    this.flareGhostA = mk(ghostSprite(128, 6), 0.22, 0x9ec4ff, 0.28);
    this.flareGhostB = mk(ghostSprite(128, 5), 0.14, 0xffb27a, 0.22);
    grp.add(this.flareGlow, this.flareStreak, this.flareGhostA, this.flareGhostB);
    grp.visible = false;
    this.ctx.viewScene.add(grp);   // drawn with the viewmodel, always on top
    this.flare = grp;
  }

  /** Interpolate the whole rig to a different hour. Kept for completeness. */
  setTimeOfDay(t) {
    this.timeOfDay = clamp(t, 0, 1);
    const elev = THREE.MathUtils.lerp(2, 62, Math.sin(this.timeOfDay * Math.PI));
    this._computeSunDirection(elev, SUN_AZIMUTH);
    _sunPos.copy(this.sunDirection).multiplyScalar(1000);
    this.skyMesh.material.uniforms.sunPosition.value.copy(_sunPos);
    this.fog.setSunDirection(this.sunDirection);
    this.dust?.setSunDirection(this.sunDirection);
  }

  setFogParams(p) { this.fog?.setFogParams(p); }

  update(dt, t) {
    const { ctx } = this;
    const cam = ctx.camera;

    // ---- shadow frustum follows the player, snapped to texel increments ----
    // Without the snap, shadow edges crawl and shimmer as you walk. This is
    // the single most important detail in a moving-frustum shadow setup.
    if (this.sunLight?.castShadow) {
      cam.getWorldDirection(_camDir);
      _center.copy(cam.position).addScaledVector(_camDir, SHADOW_EXTENT * 0.42);
      _center.y = 0;
      const ts = this._texelSize;
      _center.x = Math.round(_center.x / ts) * ts;
      _center.z = Math.round(_center.z / ts) * ts;

      this.sunLight.target.position.copy(_center);
      this.sunLight.target.updateMatrixWorld();
      this.sunLight.position.copy(_center).addScaledVector(this.sunDirection, SHADOW_EXTENT * 1.8);
      this.sunLight.updateMatrixWorld();
      this.sunLight.shadow.camera.updateProjectionMatrix();
    }

    this._adaptExposure(dt, cam);

    if (this.fog) this.fog.update();
    if (this.dust) this.dust.update(dt, cam.position);

    this._updateFlare(dt, t);
  }

  _updateFlare(dt, t) {
    if (!this.flare) return;
    const { ctx } = this;
    const cam = ctx.camera;
    cam.getWorldDirection(_camDir);
    const facing = _camDir.dot(this.sunDirection);

    // Only pay for the occlusion ray when the sun is plausibly on screen.
    let target = 0;
    if (facing > 0.35) {
      this._occTimer -= dt;
      if (this._occTimer <= 0) {
        this._occTimer = 0.1;
        const hit = ctx.physics?.raycast?.(cam.position, this.sunDirection, 400, { skipEnemies: true });
        this._occluded = hit ? 1 : 0;
      }
      target = smoothstep(0.35, 0.92, facing) * (1 - this._occluded);
    } else {
      this._occluded = 0;
    }
    this._flare = damp(this._flare, target, 7, dt);

    if (this._flare < 0.004) { this.flare.visible = false; return; }
    this.flare.visible = true;

    // Position the flare group in view space along the sun direction.
    _v.copy(this.sunDirection).applyQuaternion(ctx.viewCamera.quaternion.clone().invert());
    const dist = 5;
    const s = dist / Math.max(_v.z === 0 ? 1e-3 : Math.abs(_v.z), 1e-3);
    this.flare.position.set(_v.x * s, _v.y * s, -dist);
    this.flare.lookAt(0, 0, 0);

    const f = this._flare;
    this.flareGlow.material.opacity = f * 0.34;
    this.flareGlow.scale.setScalar(0.9 + f * 0.4);
    this.flareStreak.material.opacity = f * 0.18;
    // Ghosts sit on the opposite side of frame centre, as real lens ghosts do.
    this.flareGhostA.position.set(-this.flare.position.x * 0.06, -this.flare.position.y * 0.06, 0.02);
    this.flareGhostB.position.set(-this.flare.position.x * 0.11, -this.flare.position.y * 0.11, 0.03);
    this.flareGhostA.material.opacity = f * 0.10;
    this.flareGhostB.material.opacity = f * 0.08;
  }

  /** Level calls this after building so every new material gets fog. */
  /**
   * Squint. Looking within about fifty degrees of a low sun put the frame
   * somewhere no tonemap could bring it back from — a player reported it as
   * simply "the sun is too bright", which it was.
   *
   * This is not histogram auto-exposure. Reading back the composed buffer to
   * measure luminance means a pipeline stall every time, and the thing that
   * actually blows out here is known ahead of time: it is the sun, and we know
   * exactly where the sun is. So exposure is driven straight off the angle
   * between the view and the sun, and damped over about a third of a second so
   * it reads as an eye adjusting rather than as a slider moving.
   */
  _adaptExposure(dt, cam) {
    cam.getWorldDirection(_camDir);
    const facing = Math.max(0, _camDir.dot(this.sunDirection));
    // ^6 keeps the compensation off entirely until you are genuinely looking
    // into it — glancing across the sky should not dim the world.
    const glare = Math.pow(facing, 6);
    const target = EXPOSURE_BASE * (1 - glare * EXPOSURE_SQUINT);
    const k = 1 - Math.exp(-dt * 4.5);
    this._exposure += (target - this._exposure) * (dt > 0 ? k : 1);
    this.ctx.renderer.toneMappingExposure = this._exposure;
  }

  patchFog(root) { this.fog?.patch(root); }

  dispose() {
    this.envRT?.dispose();
    this.dust?.dispose();
  }
}
