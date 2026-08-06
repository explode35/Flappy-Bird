# OPERATION BLACKOUT

A first-person shooter built in Three.js. Everything you see and hear is
generated in code at load time — there is not a single texture, model, or audio
file in this repository. It runs fully offline.

```bash
cd fps
npm install
npm run dev          # http://127.0.0.1:5173
```

Click to lock the pointer. `WASD` move, `Shift` sprint (double-tap for tactical
sprint), `Ctrl`/`C` crouch, sprint+crouch to slide, `Space` jump and mantle,
`Q`/`E` lean, `1`/`2`/`3` weapons, `R` reload, `G` grenade, `F` inspect,
right mouse to aim.

## What is here

| Area | Notes |
|---|---|
| **Renderer** | HDR pipeline: GTAO → viewmodel pass → bloom → AgX tonemap → SMAA → grade. The grade pass does camera motion blur, chromatic aberration, film grain, vignette, unsharp mask and the damage/low-health treatment. Dynamic resolution governor keeps frame time in budget. |
| **Materials** | 19 procedural PBR surfaces. Each generates albedo, a Sobel-derived tangent normal, and an ORM pack from a shared noise/layer toolkit (tileable fBm, Worley, edge wear, grime gradients, brick/plank/tile lattices). A shared detail normal is blended into every material with reoriented normal mapping. |
| **Lighting** | Physical dusk sky, PMREM environment for IBL, a single sun with a texel-snapped shadow frustum that follows the player, custom exponential height fog with sun-direction inscattering, airborne dust, occlusion-tested lens flare. |
| **Physics** | One merged BVH over the whole static world with a per-triangle surface table. Capsule controller with iterative depenetration, displacement-based blocked detection, step-up with bisection landing, and ground snapping. Analytic sphere hitboxes for enemies. |
| **Level** | HARBOUR — a three-lane Mediterranean town block built from declarative layout data: market street, plaza, harbour front, four interiors, roof access. Automated trim, clutter and backdrop passes. Generates its own nav grid, cover points and spawn points. |
| **Player** | Accel/friction movement with air control, coyote time, jump buffering, slide, mantle, lean. The camera is composed from independent additive layers (bob, land dip, sprint cant, strafe roll, trauma shake, breathing, recoil) and is framerate-independent. |
| **Weapons** | M4, MP5 and 1911 viewmodels built from beveled primitives with working bolt, charging handle, magazine and red-dot sub-groups. Deterministic recoil patterns, spread that responds to movement and stance, hitscan ballistics with material penetration and damage falloff, physics-driven grenades. |
| **FX** | One instanced particle system whose motion is integrated in the vertex shader. Surface-specific impacts, projected decals that wrap corners, velocity-aligned tracers, muzzle flash with a real light, bouncing shell casings, layered explosions. |
| **AI** | Procedurally-built soldiers with gait-phased locomotion, spine/shoulder aim IK, and verlet-ragdoll death. A* over the nav grid with string-pulling, cover scoring, and a squad throttle that caps how many enemies fire at once. |
| **Audio** | WebAudio synthesis only. Gunshots are layered transient + body + crack + sub + action + tail with a per-weapon spectral signature. HRTF panning, distance-dependent air absorption, raycast occlusion, and four reverb zones chosen by probing the space. |
| **Game** | Wave survival with a calm/build/peak/relief pacing curve, out-of-view spawn selection, scoring, death and respawn. |

## Testing and review

```bash
node tests/physics.test.mjs        # 13 capsule-controller / raycast cases
node scripts/shoot.mjs out/        # boots the real game headless, writes 10 PNGs
node scripts/check.mjs <file>      # syntax/import check for one module
```

`scripts/shoot.mjs` is the visual review harness. It runs the shipping build in
headless Chromium, drives the camera to ten scripted vantage points, and writes
1920×1080 screenshots plus a console log and renderer stats. Screenshot review
against `ART_DIRECTION.md` §8 is how the lighting, exposure and texture-scale
problems in this project were actually found.

## Art direction

`ART_DIRECTION.md` is the binding document — lighting values, palette, scale
table, material standard, and the eight-point checklist a shot has to pass. If
something in the game contradicts it, the game is wrong.

## A note on the review harness in this environment

The harness renders through SwiftShader (software GL). That is fine for judging
art direction on the static level — which is how the exposure, normal-strength
and texture-scale problems in this project were found — but it cannot boot the
full scene with AI, particles and post at an interactive rate. Pass
`--quality=low` (the default) and expect minutes per run, or point
`PW_CHROMIUM` at a browser with real GPU access.

## Honest status

This is a substantial, working game with a coherent art direction, but it is not
Call of Duty and no amount of iteration in this format would make it so. A
modern CoD ships thousands of person-years of authored art, photogrammetry,
mocap, and a bespoke engine. This is procedural geometry and procedural
textures in a browser.

### Open bug: truncated frames in the review harness

Screenshots taken through `scripts/shoot.mjs` under SwiftShader render the
world into a vertical strip down the left of the frame (~430 px of 1920) with
the rest black. The DOM HUD composites correctly on top, so it is the WebGL
canvas that is truncated, not an overlay.

What I established:

* It is **not** the dynamic-resolution governor. At the Low tier the governor
  never fires (`dpr` is already at its cap), and the strip is byte-identical
  before and after I made the governor resize the composer targets explicitly.
  That change is still correct — `setPixelRatio` on the renderer and composer
  should be paired with an explicit resize — but it does not cause this.
* It is **not** camera placement. The same camera position renders the full
  frame in some runs and a strip in others.
* It is **not** a partially-rasterised snapshot. Making the harness wait eight
  completed rAF ticks before capturing produced a byte-identical strip, so the
  frame is fully settled and still truncated.
* The strip is full-height with a hard vertical edge, and the width is stable
  at ~430 px of 1920 across every run — it is deterministic, not a race.

`Sky.init` now snapshots and restores the renderer viewport, scissor and
scissor-test around `PMREMGenerator.fromScene`, which is correct practice
regardless — PMREM renders cube faces through its own viewport and a leaked
scissor rectangle would truncate every later frame exactly like this. Whether
that is *this* bug is unverified; the confirming capture did not finish.

The remaining untested lead is a canvas backing-store vs CSS size mismatch at
first layout. I have not reproduced this outside the software-GL harness, so
it may not affect real GPU playback — but I have not confirmed that either.

Known weakest areas, in the order I would fix them:

1. **Building facades are under-detailed.** Windows are sparse and there is no
   real architectural moulding. The kit supports it; the layout data does not
   use it enough yet.
2. **No skinned characters.** Soldiers are jointed rigid segments. It reads fine
   at 15 m+ and poorly up close.
3. **Interiors are thin.** The four enterable spaces have furniture but no
   authored lighting of their own, so they read flat compared to outdoors.
4. **No LOD or occlusion culling.** The whole map draws every frame. Fine at
   this scale, would not be at four times the size.
5. **Weapon animation is procedural throughout.** Reloads read as a sequence of
   part motions rather than a performance; real keyframed hands would be a
   large step up.
