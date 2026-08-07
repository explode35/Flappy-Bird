import * as THREE from 'three';

/**
 * ============================================================================
 *  sheet.js — the flat-card substrate every interior lighting effect is built on
 * ============================================================================
 *
 *  Interiors are lit with three kinds of unlit card, and all three are the same
 *  thing geometrically: a soft-edged mesh whose *vertex colour* carries the
 *  effect and whose blend mode decides what that colour means.
 *
 *    additive  — light shafts, sun splashes.  colour = light added (HDR, may
 *                exceed 1; the pipeline renders to a half-float target and
 *                tone-maps later, so >1 is not just legal, it is the point).
 *    multiply  — contact shadows, corner grime, the ceiling gloom cage.
 *                colour = what the surface underneath is multiplied by, so
 *                white is a no-op and the edges of every card must reach white.
 *    emissive  — bulbs and tubes. Plain unlit colour, above the bloom
 *                threshold (0.92) so the bloom pass gives them a halo.
 *
 *  A Sheet accumulates many cards into ONE buffer, so an entire building's
 *  worth of shafts costs a single draw call. There is no per-frame work here:
 *  everything is baked at level build time and never touched again.
 * ============================================================================
 */

const _p = new THREE.Vector3();

export class Sheet {
  constructor(name = 'sheet') {
    this.name = name;
    this.pos = [];
    this.col = [];
    this.idx = [];
  }

  get vertexCount() { return this.pos.length / 3; }
  get isEmpty() { return this.idx.length === 0; }

  vertex(p, c) {
    this.pos.push(p.x, p.y, p.z);
    this.col.push(c[0], c[1], c[2]);
    return this.vertexCount - 1;
  }

  /**
   * An (nu+1)x(nv+1) vertex lattice. `sample(u, v, outPos, outCol)` fills a
   * Vector3 and a 3-array; both are reused, so the callback must not keep them.
   */
  grid(nu, nv, sample) {
    const base = this.vertexCount;
    const c = [0, 0, 0];
    for (let j = 0; j <= nv; j++) {
      for (let i = 0; i <= nu; i++) {
        sample(i / nu, j / nv, _p, c);
        this.vertex(_p, c);
      }
    }
    const row = nu + 1;
    for (let j = 0; j < nv; j++) {
      for (let i = 0; i < nu; i++) {
        const a = base + j * row + i;
        this.idx.push(a, a + row, a + 1, a + 1, a + row, a + row + 1);
      }
    }
    return this;
  }

  /**
   * A radial fan — the shape of every contact shadow. `sample(angle01, r01,
   * outPos, outCol)`. Built as a true fan rather than a collapsed grid so the
   * centre is one vertex and there are no degenerate triangles.
   */
  disc(seg, rings, sample) {
    const c = [0, 0, 0];
    sample(0, 0, _p, c);
    const centre = this.vertex(_p, c);
    const base = this.vertexCount;
    for (let j = 1; j <= rings; j++) {
      for (let i = 0; i < seg; i++) {
        sample(i / seg, j / rings, _p, c);
        this.vertex(_p, c);
      }
    }
    for (let i = 0; i < seg; i++) {
      this.idx.push(centre, base + i, base + ((i + 1) % seg));
    }
    for (let j = 1; j < rings; j++) {
      for (let i = 0; i < seg; i++) {
        const i2 = (i + 1) % seg;
        const a = base + (j - 1) * seg + i, b = base + (j - 1) * seg + i2;
        const d = base + j * seg + i, e = base + j * seg + i2;
        this.idx.push(a, d, b, b, d, e);
      }
    }
    return this;
  }

  /** Finished mesh, or null if nothing was ever added. */
  mesh(material, renderOrder = 0) {
    if (this.isEmpty) return null;
    const g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.Float32BufferAttribute(this.pos, 3));
    g.setAttribute('color', new THREE.Float32BufferAttribute(this.col, 3));
    g.setIndex(this.idx);
    g.computeBoundingSphere();
    const m = new THREE.Mesh(g, material);
    m.name = this.name;
    m.renderOrder = renderOrder;
    m.castShadow = false;
    m.receiveShadow = false;
    m.matrixAutoUpdate = false;
    m.updateMatrix();
    return m;
  }
}

/* -------------------------------------------------------------------------- */
/*  Materials. One instance of each is shared by every interior.               */
/* -------------------------------------------------------------------------- */

/**
 * `fog: false` on all three is deliberate and load-bearing: HeightFog.patch()
 * skips materials that opt out, and mixing a fog colour into an additive card
 * would make it glow grey instead of adding light.
 */
export function additiveMaterial() {
  return new THREE.MeshBasicMaterial({
    color: 0xffffff, vertexColors: true, transparent: true,
    blending: THREE.AdditiveBlending, depthWrite: false, depthTest: true,
    side: THREE.DoubleSide, fog: false,
  });
}

/**
 * MultiplyBlending is dst*src, so `opacity` does nothing — strength has to be
 * baked into the vertex colour as a lerp from white. That is what makes these
 * safe: a card can only ever darken, never brighten, and a card whose rim is
 * white has an invisible edge.
 */
export function multiplyMaterial() {
  return new THREE.MeshBasicMaterial({
    color: 0xffffff, vertexColors: true, transparent: true,
    blending: THREE.MultiplyBlending, depthWrite: false, depthTest: true,
    side: THREE.DoubleSide, fog: false,
  });
}

export function emissiveMaterial() {
  return new THREE.MeshBasicMaterial({
    color: 0xffffff, vertexColors: true, fog: false, side: THREE.FrontSide,
  });
}

/**
 * Merge a list of geometries that carry only position+colour into one mesh.
 * Used for bulbs and tubes, which are real (if tiny) solids rather than cards.
 */
export function emissiveGeometry(geo, color) {
  geo.deleteAttribute('uv');
  geo.deleteAttribute('normal');
  const n = geo.attributes.position.count;
  const c = new Float32Array(n * 3);
  for (let i = 0; i < n; i++) { c[i * 3] = color[0]; c[i * 3 + 1] = color[1]; c[i * 3 + 2] = color[2]; }
  geo.setAttribute('color', new THREE.BufferAttribute(c, 3));
  return geo;
}

/** Smooth 0..1 ramp with a flat top — the profile of a soft-edged light card. */
export function feather(t, edge = 0.16) {
  const d = Math.min(t, 1 - t) / edge;
  if (d >= 1) return 1;
  const x = Math.max(d, 0);
  return x * x * (3 - 2 * x);
}
