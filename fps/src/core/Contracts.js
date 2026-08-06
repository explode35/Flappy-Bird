/**
 * ============================================================================
 *  SHARED CONTRACTS — read this before touching any system file.
 * ============================================================================
 *
 *  Every system is a class with this shape:
 *
 *      export class Foo {
 *        constructor(ctx) { this.ctx = ctx; }
 *        async init() {}            // build meshes / decode assets. May be async.
 *        update(dt, t) {}           // per-frame, dt in seconds (clamped <= 1/20)
 *        dispose() {}
 *      }
 *
 *  Systems NEVER import each other. They communicate exclusively through
 *  `ctx.bus` events and the read-only fields on `ctx`.
 *
 * ----------------------------------------------------------------------------
 *  ctx (the Context object)
 * ----------------------------------------------------------------------------
 *  ctx.renderer      THREE.WebGLRenderer
 *  ctx.scene         THREE.Scene   — the world. Everything solid lives here.
 *  ctx.camera        THREE.PerspectiveCamera — the world/eye camera.
 *  ctx.viewScene     THREE.Scene   — viewmodel-only scene, rendered after the
 *                                    world with a cleared depth buffer so the
 *                                    gun never clips into walls.
 *  ctx.viewCamera    THREE.PerspectiveCamera — separate FOV for the viewmodel.
 *  ctx.input         Input         — see core/Input.js
 *  ctx.bus           Bus           — see core/Bus.js
 *  ctx.physics       Physics       — see physics/Physics.js  (set by Engine)
 *  ctx.materials     Materials     — see render/Materials.js (set by Engine)
 *  ctx.audio         Audio         — see audio/Audio.js      (set by Engine)
 *  ctx.fx            Effects       — see fx/Effects.js       (set by Engine)
 *  ctx.level         Level         — see world/Level.js      (set by Engine)
 *  ctx.player        Player        — see player/Player.js    (set by Engine)
 *  ctx.quality       QualitySettings — { shadows, ssao, bloom, decals, particles }
 *  ctx.rand          (seed:number)=>()=>number  deterministic PRNG factory
 *
 * ----------------------------------------------------------------------------
 *  Physics API  (implemented in physics/Physics.js)
 * ----------------------------------------------------------------------------
 *  addStatic(object3D)                Register level geometry for collision.
 *  build()                            Build the BVH. Call once after all statics.
 *  raycast(origin, dir, maxDist, opt) -> Hit|null
 *        Hit = { point:Vec3, normal:Vec3, distance:number,
 *                object:Object3D, surface:SurfaceType, isEnemy:boolean,
 *                enemy?:object, bone?:string }
 *        opt = { skipEnemies?:bool, skipWorld?:bool, ignore?:Object3D[] }
 *  moveCapsule(capsule, delta, out)   Slide-and-collide a capsule.
 *        capsule = { start:Vec3, end:Vec3, radius:number }  (world space, mutated)
 *        out     = { grounded:bool, groundNormal:Vec3, hitWall:bool, steppedUp:bool }
 *  sphereOverlap(center, radius)      -> Object3D[]  (broadphase, for explosions)
 *  registerHitbox(enemy, object3D, boneName, damageMul)
 *  unregisterEnemy(enemy)
 *
 *  SurfaceType: 'concrete'|'metal'|'wood'|'dirt'|'sand'|'glass'|'flesh'|'water'|'foliage'
 *
 * ----------------------------------------------------------------------------
 *  Materials API (implemented in render/Materials.js)
 * ----------------------------------------------------------------------------
 *  get(name)             -> THREE.MeshStandardMaterial (cached, procedural PBR)
 *  getTiled(name, sx,sy) -> variant with UV repeat (cached per repeat)
 *  surfaceOf(material)   -> SurfaceType
 *  Names: concrete, concreteWall, brick, plaster, asphalt, sand, gravel,
 *         metalPanel, rustMetal, gunmetal, polymer, wood, plywood, crate,
 *         tileFloor, glass, foliage, canvasTarp, sandbag, corrugated
 *
 * ----------------------------------------------------------------------------
 *  Event catalogue (ctx.bus)
 * ----------------------------------------------------------------------------
 *  'weapon:fire'      { origin:Vec3, dir:Vec3, weapon:string, silenced:bool }
 *  'weapon:changed'   { name, mag, reserve, icon }
 *  'weapon:reload'    { name, phase:'start'|'end' }
 *  'ammo:changed'     { mag, reserve }
 *  'impact'           { point:Vec3, normal:Vec3, surface:SurfaceType, dir:Vec3 }
 *  'tracer'           { from:Vec3, to:Vec3, speed:number }
 *  'hit:enemy'        { enemy, point:Vec3, normal:Vec3, damage, headshot:bool, dir:Vec3 }
 *  'enemy:death'      { enemy, point:Vec3, dir:Vec3, headshot:bool }
 *  'enemy:spawn'      { enemy }
 *  'enemy:fire'       { enemy, origin:Vec3, dir:Vec3 }
 *  'player:damage'    { amount:number, fromDir:Vec3, source }
 *  'player:heal'      { amount:number }
 *  'player:death'     {}
 *  'player:land'      { speed:number, surface:SurfaceType }
 *  'player:step'      { surface:SurfaceType, running:bool }
 *  'explosion'        { point:Vec3, radius:number, damage:number }
 *  'shake'            { amount:number, duration:number }
 *  'score'            { points:number, label:string }
 *  'objective'        { text:string }
 *  'game:start' | 'game:over' | 'game:pause' | 'game:resume'
 *
 * ----------------------------------------------------------------------------
 *  Rules
 * ----------------------------------------------------------------------------
 *  1. NO external asset files. No .gltf, .png, .mp3, no CDN fetches. Every
 *     texture, mesh and sound is generated procedurally in code. The build must
 *     run fully offline.
 *  2. Only dependencies: three, three-mesh-bvh. Nothing else.
 *  3. Never call renderer.render() outside core/Engine.js.
 *  4. Allocate no per-frame garbage in update(): hoist temp vectors to module
 *     scope or `this`. 60fps is a hard requirement.
 *  5. Respect ctx.quality flags so low-end machines degrade instead of dying.
 * ============================================================================
 */

export const SURFACES = /** @type {const} */ ([
  'concrete', 'metal', 'wood', 'dirt', 'sand', 'glass', 'flesh', 'water', 'foliage',
]);

/** Mulberry32 — small deterministic PRNG. */
export function rand(seed = 1) {
  let a = seed >>> 0;
  return function () {
    a |= 0; a = (a + 0x6D2B79F5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

export const clamp = (v, a, b) => (v < a ? a : v > b ? b : v);
export const lerp = (a, b, t) => a + (b - a) * t;
/** Framerate-independent exponential smoothing. */
export const damp = (a, b, lambda, dt) => lerp(a, b, 1 - Math.exp(-lambda * dt));
export const smoothstep = (e0, e1, x) => {
  const t = clamp((x - e0) / (e1 - e0), 0, 1);
  return t * t * (3 - 2 * t);
};
