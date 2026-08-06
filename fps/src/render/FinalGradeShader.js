import * as THREE from 'three';

/**
 * Final display pass: directional motion blur, chromatic aberration, film grain,
 * bloom-safe contrast/lift/gain grade, vignette, damage flash, and a light
 * unsharp mask to restore the micro-contrast that SMAA softens.
 *
 * Runs after tone mapping, so all maths here is in display-referred sRGB.
 */
export const FinalGradeShader = {
  name: 'FinalGradeShader',
  uniforms: {
    tDiffuse:    { value: null },
    uResolution: { value: new THREE.Vector2(1, 1) },
    uTime:       { value: 0 },
    uVignette:   { value: 0.42 },
    uGrain:      { value: 0.035 },
    uCA:         { value: 0.32 },
    uSharpen:    { value: 0.35 },
    uMotion:     { value: new THREE.Vector2(0, 0) },  // screen-space px, from camera delta
    uDamage:     { value: 0 },                        // 0..1 red pulse on the edges
    uFlash:      { value: 0 },                        // 0..1 white-out (flashbang / muzzle)
    uLowHealth:  { value: 0 },                        // 0..1 desaturate + pulse
    uLift:       { value: new THREE.Vector3(0.006, 0.008, 0.016) },
    uGain:       { value: new THREE.Vector3(1.035, 1.005, 0.972) },
    uContrast:   { value: 1.075 },
    uSaturation: { value: 1.06 },
    uScope:      { value: 0 },                        // 0..1 scope vignette + edge blur
  },
  vertexShader: /* glsl */`
    varying vec2 vUv;
    void main() {
      vUv = uv;
      gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
    }
  `,
  fragmentShader: /* glsl */`
    precision highp float;

    uniform sampler2D tDiffuse;
    uniform vec2  uResolution;
    uniform float uTime;
    uniform float uVignette;
    uniform float uGrain;
    uniform float uCA;
    uniform float uSharpen;
    uniform vec2  uMotion;
    uniform float uDamage;
    uniform float uFlash;
    uniform float uLowHealth;
    uniform vec3  uLift;
    uniform vec3  uGain;
    uniform float uContrast;
    uniform float uSaturation;
    uniform float uScope;
    varying vec2 vUv;

    float hash13(vec3 p) {
      p = fract(p * 0.1031);
      p += dot(p, p.yzx + 33.33);
      return fract((p.x + p.y) * p.z);
    }

    // Interleaved-gradient noise: cheap, temporally stable dither pattern.
    float ign(vec2 p) {
      return fract(52.9829189 * fract(dot(p, vec2(0.06711056, 0.00583715))));
    }

    void main() {
      vec2 uv = vUv;
      vec2 px = 1.0 / uResolution;
      vec2 centered = uv - 0.5;
      float r2 = dot(centered, centered);

      // ---- camera motion blur (8 taps along the screen-space velocity) -----
      vec2 mv = uMotion * px;
      float mlen = length(uMotion);
      vec3 col;
      if (mlen > 0.35) {
        float jitter = ign(gl_FragCoord.xy + uTime * 61.0);
        col = vec3(0.0);
        float wsum = 0.0;
        for (int i = 0; i < 8; i++) {
          float t = ((float(i) + jitter) / 8.0 - 0.5);
          float w = 1.0 - abs(t) * 1.2;
          col += texture2D(tDiffuse, uv + mv * t).rgb * w;
          wsum += w;
        }
        col /= wsum;
      } else {
        col = texture2D(tDiffuse, uv).rgb;
      }

      // ---- chromatic aberration, lens-correct (grows toward the edges) -----
      float caAmt = uCA * (0.0016 + uScope * 0.004);
      if (caAmt > 0.0) {
        vec2 dir = centered * r2 * caAmt * 4.0;
        col.r = texture2D(tDiffuse, uv + dir).r;
        col.b = texture2D(tDiffuse, uv - dir).b;
      }

      // ---- unsharp mask -----------------------------------------------------
      if (uSharpen > 0.0) {
        vec3 blur =
          texture2D(tDiffuse, uv + vec2( px.x,  0.0)).rgb +
          texture2D(tDiffuse, uv + vec2(-px.x,  0.0)).rgb +
          texture2D(tDiffuse, uv + vec2( 0.0,  px.y)).rgb +
          texture2D(tDiffuse, uv + vec2( 0.0, -px.y)).rgb;
        blur *= 0.25;
        col += (col - blur) * uSharpen;
      }

      // ---- grade: lift / gain / contrast / saturation -----------------------
      col = col * uGain + uLift;
      col = (col - 0.5) * uContrast + 0.5;
      float luma = dot(col, vec3(0.2126, 0.7152, 0.0722));
      col = mix(vec3(luma), col, uSaturation);

      // ---- low-health: desaturate and pull toward a cold, dim look ---------
      if (uLowHealth > 0.0) {
        float pulse = 0.5 + 0.5 * sin(uTime * 4.2);
        float k = uLowHealth * (0.55 + 0.45 * pulse);
        col = mix(col, vec3(luma) * vec3(0.86, 0.9, 1.06), k * 0.7);
      }

      // ---- vignette ---------------------------------------------------------
      float vig = 1.0 - uVignette * smoothstep(0.16, 0.78, r2);
      col *= vig;

      // ---- scope: heavy black surround + edge softness ----------------------
      if (uScope > 0.0) {
        float d = length(centered * vec2(uResolution.x / uResolution.y, 1.0));
        float mask = smoothstep(0.44, 0.40, d);
        col = mix(col * 0.02, col, mix(1.0, mask, uScope));
      }

      // ---- damage: red rim that bleeds inward ------------------------------
      if (uDamage > 0.0) {
        float rim = smoothstep(0.06, 0.42, r2);
        col = mix(col, vec3(0.62, 0.03, 0.02), rim * uDamage * 0.85);
      }

      // ---- film grain, luminance-weighted so shadows stay cleaner ----------
      float g = hash13(vec3(gl_FragCoord.xy, floor(uTime * 24.0))) - 0.5;
      col += g * uGrain * (0.35 + 0.65 * (1.0 - luma));

      // ---- flash ------------------------------------------------------------
      col = mix(col, vec3(1.0), clamp(uFlash, 0.0, 1.0));

      gl_FragColor = vec4(max(col, 0.0), 1.0);
    }
  `,
};
