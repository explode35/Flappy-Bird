import * as THREE from 'three';

/**
 * ============================================================================
 *  Exponential HEIGHT fog with sun-direction-dependent inscattering.
 * ============================================================================
 *
 *  Three's FogExp2 is distance-only and colour-constant, which reads as a flat
 *  grey wash. Real dusk haze does two things FogExp2 cannot:
 *
 *    1. It *pools*. Density falls off exponentially with altitude, so a street
 *       is milky at ground level and clear at roof level. That vertical
 *       gradient is most of what sells "this is a big outdoor space".
 *    2. It *scatters directionally*. Looking into the sun the haze glows warm
 *       (#c9b9a4) and lifts; looking away from it the haze goes cold and blue
 *       (#8fa3b8). Rotating 180 degrees should visibly change the air colour.
 *
 *  Implementation: we replace the four built-in fog ShaderChunks globally, so
 *  *every* material three compiles from here on gets the height-fog code path
 *  (including materials owned by other systems). The chunk declares its own
 *  uniforms; a material that was never patched simply gets the GL default of
 *  zero for them, which evaluates to "no fog" instead of a compile error.
 *  `patch()` then walks the scene and hands each fog-enabled material the
 *  *shared* uniform objects via onBeforeCompile, so a single JS write updates
 *  every material at once with zero per-frame traversal.
 *
 *  Analytic optical depth for density d(y) = density * exp(-falloff * y):
 *
 *      od = dist * density * (e^(-b*y0) - e^(-b*y1)) / (b * (y1 - y0))
 *
 *  which degenerates to `dist * density * e^(-b*y0)` for a horizontal ray.
 * ----------------------------------------------------------------------------
 */

const FOG_PARS_VERTEX = /* glsl */`
#ifdef USE_FOG
	varying vec3 vHFWorldPos;
#endif
`;

// mvPosition exists in every stock three vertex shader that includes
// <fog_vertex> (verified across basic/lambert/phong/physical/toon/matcap/
// points/sprite/shadow/linedashed). Reconstructing the world position from it
// instead of from `transformed` keeps sprites and points working, since those
// two never declare `transformed`.
//   world = cameraPosition + transpose(mat3(viewMatrix)) * viewPos
// and `v * M` is `transpose(M) * v`, so no transpose() call is needed.
const FOG_VERTEX = /* glsl */`
#ifdef USE_FOG
	vHFWorldPos = cameraPosition + ( mvPosition.xyz * mat3( viewMatrix ) );
#endif
`;

const FOG_PARS_FRAGMENT = /* glsl */`
#ifdef USE_FOG
	varying vec3 vHFWorldPos;

	uniform vec3  hfSunDir;      // normalised, world -> sun
	uniform vec3  hfColorSun;    // inscatter colour looking INTO the sun
	uniform vec3  hfColorAway;   // inscatter colour looking away from it
	uniform vec4  hfParams;      // x density, y height falloff, z base height, w max opacity
	uniform vec4  hfParams2;     // x glow gain, y glow exponent, z phase mix, w start distance

	float hfOpticalDepth( vec3 wp, vec3 cam, float dist ) {
		float b  = hfParams.y;
		float y0 = cam.y - hfParams.z;
		float y1 = wp.y  - hfParams.z;
		float dy = y1 - y0;
		float e0 = exp( - b * y0 );
		float od;
		if ( abs( dy ) > 0.05 ) {
			od = hfParams.x * dist * ( e0 - exp( - b * y1 ) ) / ( b * dy );
		} else {
			od = hfParams.x * dist * e0;
		}
		return max( od, 0.0 );
	}
#endif
`;

const FOG_FRAGMENT = /* glsl */`
#ifdef USE_FOG
	{
		vec3  hfV    = vHFWorldPos - cameraPosition;
		float hfDist = max( length( hfV ) - hfParams2.w, 0.0 );
		vec3  hfDir  = hfV / max( length( hfV ), 1e-4 );

		float hfOD     = hfOpticalDepth( vHFWorldPos, cameraPosition, hfDist );
		float hfFactor = ( 1.0 - exp( - hfOD ) ) * hfParams.w;

		// Directional inscattering. cosT > 0 means we are looking toward the sun.
		float cosT   = dot( hfDir, hfSunDir );
		float broad  = pow( clamp( cosT * 0.5 + 0.5, 0.0, 1.0 ), hfParams2.z );
		vec3  hfCol  = mix( hfColorAway, hfColorSun, broad );

		// Tight forward-scatter lobe: the bright bloom of air right around the sun.
		float glow = pow( clamp( cosT, 0.0, 1.0 ), hfParams2.y );
		hfCol += hfColorSun * glow * hfParams2.x;

		gl_FragColor.rgb = mix( gl_FragColor.rgb, hfCol, clamp( hfFactor, 0.0, 1.0 ) );
	}
#endif
`;

let _chunksInstalled = false;

/** Swap three's fog chunks for the height-fog ones. Idempotent, global. */
export function installFogChunks() {
  if (_chunksInstalled) return;
  THREE.ShaderChunk.fog_pars_vertex = FOG_PARS_VERTEX;
  THREE.ShaderChunk.fog_vertex = FOG_VERTEX;
  THREE.ShaderChunk.fog_pars_fragment = FOG_PARS_FRAGMENT;
  THREE.ShaderChunk.fog_fragment = FOG_FRAGMENT;
  _chunksInstalled = true;
}

export class HeightFog {
  /**
   * @param {THREE.Scene} scene
   */
  constructor(scene) {
    installFogChunks();
    this.scene = scene;

    // Shared uniform objects. Every patched material references THESE, so a
    // write here is instantly visible everywhere.
    this.uniforms = {
      hfSunDir:    { value: new THREE.Vector3(0.4, 0.15, -0.9).normalize() },
      hfColorSun:  { value: new THREE.Color().setHex(0xc9b9a4, THREE.SRGBColorSpace) },
      hfColorAway: { value: new THREE.Color().setHex(0x8fa3b8, THREE.SRGBColorSpace) },
      hfParams:    { value: new THREE.Vector4(0.012, 0.055, 0.0, 1.0) },
      hfParams2:   { value: new THREE.Vector4(0.55, 9.0, 2.2, 1.5) },
    };

    // Art bible values, kept in one place so setFogParams() can round-trip them.
    this.params = {
      density: 0.012,
      heightFalloff: 0.055,
      baseHeight: 0.0,
      maxOpacity: 1.0,
      sunColor: 0xc9b9a4,
      awayColor: 0x8fa3b8,
      sunGain: 1.35,     // multiplies the sun-side colour (HDR lift)
      awayGain: 0.92,
      glowGain: 0.55,
      glowExponent: 9.0,
      phaseMix: 2.2,
      startDistance: 1.5,
    };
    this._applyParams();

    // Carrier fog: materials only compile the fog code path when scene.fog is
    // set. The FogExp2 values themselves are never read by our chunks.
    scene.fog = new THREE.FogExp2(this.params.awayColor, 0.0001);

    this._patched = new WeakSet();
    this._sweepCountdown = 0;
    this.patchedCount = 0;
  }

  _applyParams() {
    const p = this.params, u = this.uniforms;
    u.hfParams.value.set(p.density, p.heightFalloff, p.baseHeight, p.maxOpacity);
    u.hfParams2.value.set(p.glowGain, p.glowExponent, p.phaseMix, p.startDistance);
    u.hfColorSun.value.setHex(p.sunColor, THREE.SRGBColorSpace).multiplyScalar(p.sunGain);
    u.hfColorAway.value.setHex(p.awayColor, THREE.SRGBColorSpace).multiplyScalar(p.awayGain);
  }

  /**
   * Public tuning hook.
   * @param {object} p partial of {density, heightFalloff, baseHeight, maxOpacity,
   *   sunColor, awayColor, sunGain, awayGain, glowGain, glowExponent, phaseMix,
   *   startDistance}
   */
  setFogParams(p = {}) {
    Object.assign(this.params, p);
    this._applyParams();
    if (this.scene.fog) this.scene.fog.color.setHex(this.params.awayColor, THREE.SRGBColorSpace);
    return this.params;
  }

  setSunDirection(v) { this.uniforms.hfSunDir.value.copy(v).normalize(); }

  /** Hand one material the shared uniforms. Safe to call repeatedly. */
  patchMaterial(mat) {
    if (!mat || mat.fog !== true || this._patched.has(mat)) return false;
    this._patched.add(mat);
    const uniforms = this.uniforms;
    const prev = mat.onBeforeCompile;
    mat.onBeforeCompile = function (shader, renderer) {
      if (prev) prev.call(this, shader, renderer);
      Object.assign(shader.uniforms, uniforms);
    };
    // Two materials with identical parameters share a compiled program, so a
    // patched material must not inherit an unpatched one's program.
    const prevKey = mat.customProgramCacheKey;
    mat.customProgramCacheKey = function () {
      return 'hfog|' + (prevKey ? prevKey.call(this) : '');
    };
    mat.needsUpdate = true;
    this.patchedCount++;
    return true;
  }

  /** Walk a subtree (default: the whole scene) and patch every material found. */
  patch(root = this.scene) {
    let n = 0;
    root.traverse((o) => {
      const m = o.material;
      if (!m) return;
      if (Array.isArray(m)) { for (const mm of m) if (this.patchMaterial(mm)) n++; }
      else if (this.patchMaterial(m)) n++;
    });
    return n;
  }

  /**
   * Cheap safety net: systems build geometry at arbitrary times and there is no
   * 'level:built' event in the contract, so we re-sweep a few times a second.
   * A traverse of a few thousand nodes costs microseconds and the WeakSet makes
   * re-patching a no-op.
   */
  update() {
    if (--this._sweepCountdown > 0) return;
    this._sweepCountdown = 20;
    this.patch();
  }

  dispose() { /* chunks stay installed for the lifetime of the page */ }
}
