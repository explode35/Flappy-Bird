import * as THREE from 'three';
import { glowSprite } from './Textures.js';

/**
 * Airborne particulate — the salt/dust haze that makes a sunbeam visible.
 *
 * A single `Points` cloud that follows the camera. Motes are seeded at fixed
 * world positions inside a cube of half-size R; the vertex shader wraps them
 * modulo 2R around the camera, so a mote only ever teleports at the far edge of
 * the box where it is already faded out. Drift, sway and wrap all happen on the
 * GPU: zero CPU work per frame, zero garbage.
 *
 * The alpha is heavily weighted by how *backlit* the mote is (how close the
 * view ray to it is to the sun direction). Motes between you and the sun blaze;
 * motes with the sun behind you are almost invisible. That single term is what
 * makes the field read as "light in the air" rather than "snow".
 */

const VERT = /* glsl */`
  uniform vec3  uAnchor;
  uniform vec3  uSunDir;
  uniform vec3  uWind;
  uniform float uTime;
  uniform float uRadius;
  uniform float uSize;
  uniform float uBacklitFloor;
  uniform float uBacklitPow;

  attribute float aPhase;
  attribute float aScale;

  varying float vAlpha;

  void main() {
    float R = uRadius;

    // Slow drift + a lazy per-mote sway so the field never looks like a lattice.
    vec3 seed = position;
    vec3 drift = uWind * uTime;
    drift.x += sin( uTime * 0.21 + aPhase * 6.2831 ) * 0.55;
    drift.y += sin( uTime * 0.13 + aPhase * 12.566 ) * 0.42;
    drift.z += cos( uTime * 0.17 + aPhase * 9.4248 ) * 0.55;

    vec3 rel = seed + drift - uAnchor;
    rel = mod( rel + R, 2.0 * R ) - R;            // wrap into [-R, R]
    vec3 world = uAnchor + rel;

    vec4 mvPosition = viewMatrix * vec4( world, 1.0 );
    gl_Position = projectionMatrix * mvPosition;

    float dist = max( - mvPosition.z, 0.001 );
    gl_PointSize = clamp( uSize * aScale * ( 12.0 / dist ), 0.6, 14.0 );

    // --- alpha -------------------------------------------------------------
    // 1. backlit: is the sun behind this mote from where we stand?
    vec3 toMote = normalize( world - cameraPosition );
    float backlit = dot( toMote, uSunDir );
    float lit = mix( uBacklitFloor, 1.0, pow( clamp( backlit, 0.0, 1.0 ), uBacklitPow ) );

    // 2. fade at the box boundary so wrapping is invisible
    vec3 n = abs( rel ) / R;
    float edge = 1.0 - smoothstep( 0.62, 0.99, max( n.x, max( n.y, n.z ) ) );

    // 3. don't let motes crowd the near plane / the muzzle
    float near = smoothstep( 0.35, 1.6, dist );

    // 4. thin out with altitude the way real dust does
    float alt = exp( - max( world.y, 0.0 ) * 0.06 );

    // 5. gentle scintillation
    float twinkle = 0.72 + 0.28 * sin( uTime * 1.7 + aPhase * 30.0 );

    vAlpha = lit * edge * near * alt * twinkle;
  }
`;

const FRAG = /* glsl */`
  uniform sampler2D uMap;
  uniform vec3  uColor;
  uniform float uOpacity;
  varying float vAlpha;

  void main() {
    float a = texture2D( uMap, gl_PointCoord ).a;
    if ( a < 0.004 ) discard;
    gl_FragColor = vec4( uColor * ( a * vAlpha * uOpacity ), 1.0 );
  }
`;

export class Dust {
  /**
   * @param {object} opts
   * @param {number} opts.count       mote count (already quality-scaled)
   * @param {number} opts.radius      half-size of the follow cube, metres
   * @param {THREE.Color|number} opts.color
   * @param {(seed:number)=>()=>number} opts.rand
   */
  constructor(opts = {}) {
    const count = Math.max(0, opts.count | 0);
    this.count = count;
    this.radius = opts.radius ?? 22;

    const rnd = (opts.rand || (() => Math.random))(0x0a7m0 | 0);
    const pos = new Float32Array(count * 3);
    const phase = new Float32Array(count);
    const scale = new Float32Array(count);
    const R = this.radius;
    for (let i = 0; i < count; i++) {
      pos[i * 3 + 0] = (rnd() * 2 - 1) * R;
      pos[i * 3 + 1] = (rnd() * 2 - 1) * R;
      pos[i * 3 + 2] = (rnd() * 2 - 1) * R;
      phase[i] = rnd();
      // Heavy tail of tiny motes, a handful of big lazy ones.
      const r = rnd();
      scale[i] = 0.45 + r * r * r * 2.4;
    }

    const geo = new THREE.BufferGeometry();
    geo.setAttribute('position', new THREE.BufferAttribute(pos, 3));
    geo.setAttribute('aPhase', new THREE.BufferAttribute(phase, 1));
    geo.setAttribute('aScale', new THREE.BufferAttribute(scale, 1));
    geo.boundingSphere = new THREE.Sphere(new THREE.Vector3(), 1e6);

    this.uniforms = {
      uMap:          { value: glowSprite(64, 2.2, 0.35) },
      uAnchor:       { value: new THREE.Vector3() },
      uSunDir:       { value: new THREE.Vector3(0, 1, 0) },
      uWind:         { value: new THREE.Vector3(0.18, 0.045, -0.11) },
      uTime:         { value: 0 },
      uRadius:       { value: R },
      uSize:         { value: opts.size ?? 34 },
      uColor:        { value: new THREE.Color().setHex(opts.color ?? 0xffd8b4, THREE.SRGBColorSpace) },
      uOpacity:      { value: opts.opacity ?? 0.55 },
      uBacklitFloor: { value: 0.055 },
      uBacklitPow:   { value: 3.4 },
    };

    const mat = new THREE.ShaderMaterial({
      uniforms: this.uniforms,
      vertexShader: VERT,
      fragmentShader: FRAG,
      transparent: true,
      depthWrite: false,
      depthTest: true,
      blending: THREE.AdditiveBlending,
      fog: false,
    });

    this.points = new THREE.Points(geo, mat);
    this.points.name = 'atmos.dust';
    this.points.frustumCulled = false;
    this.points.renderOrder = 12;
    this.points.matrixAutoUpdate = false;
    this.points.visible = count > 0;
  }

  get object() { return this.points; }

  setSunDirection(v) { this.uniforms.uSunDir.value.copy(v); }

  /** @param {number} dt @param {THREE.Vector3} anchor world point to follow */
  update(dt, anchor) {
    if (!this.points.visible) return;
    this.uniforms.uTime.value += dt;
    this.uniforms.uAnchor.value.copy(anchor);
  }

  dispose() {
    this.points.geometry.dispose();
    this.points.material.dispose();
  }
}
