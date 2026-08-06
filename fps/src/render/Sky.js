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
const SUN_INTENSITY = 2.75;
const FILL_COLOR = 0x5c6a7a;
const FILL_INTENSITY = 0.22;
const SHADOW_EXTENT = 55;      // metres covered by the sun's ortho frustum

const _v = new THREE.Vector3();
const _center = new THREE.Vector3();
const _camDir = new THREE.Vector3();
const _sunPos = new THREE.Vector3();

export class Sky {
  constructor(ctx) {
    this.ctx = ctx;
    this.sunDirection = new THREE.Vector3();
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
    u.turbidity.value = 5.5;
    u.rayleigh.value = 2.2;
    u.mieCoefficient.value = 0.007;
    u.mieDirectionalG.value = 0.86;
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
      new THREE.MeshBasicMaterial({ color: 0x4a4237, side: THREE.BackSide })
    );
    envScene.add(ground);

    const envRT = pmrem.fromScene(envScene, 0.02);
    scene.environment = envRT.texture;
    scene.environmentIntensity = 0.5;
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
  patchFog(root) { this.fog?.patch(root); }

  dispose() {
    this.envRT?.dispose();
    this.dust?.dispose();
  }
}
