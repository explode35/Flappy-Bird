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

### The capture problem, and what it actually was

Captures came back black or truncated for a long time, and a lot of work was
done, undone and redone on the strength of black PNGs. It was two separate
faults stacked on each other, and both are now fixed in `scripts/shoot.mjs`.

**Fault one: the canvas element.** `page.screenshot()` cannot capture the
SwiftShader WebGL surface at all — it returns black. `canvas.toDataURL()` and
`drawImage()` into a 2D context are better but still return black some of the
time. The harness now does a whole-buffer `gl.readPixels` and encodes the PNG
in Node with `pngjs`, touching the canvas element only to read its dimensions.

**Fault two: the task boundary.** Rendering in one JS task and reading the
pixels in the next produces black frames. `scripts/probe-diag.mjs`, which
renders and reads inside a single `page.evaluate`, has never produced one;
every script that split the two has. The harness now re-aims and re-grabs when
a frame reads as pure black, which clears it within a couple of attempts.
Driving `composer.render()` from inside the evaluate also clears it, but kills
the page within a few calls, so retries it is.

**And a third thing that looked like the same bug but was not:** shipping the
frame out as one 1.2 MB base64 payload over CDP loses the page outright. It
goes out in 45-row bands now.

Two corrections I owe the record. I claimed at one point that GL was genuinely
black at certain cameras and went looking for a scene bug; `probe-black.mjs`
read `210,200,178` at that exact camera and disproved it. Then I claimed the
scene was simply fine and the probes were reliable; that was also too strong —
the black is real in the buffer, it is just produced by the read path rather
than by the scene. There is still no known camera-dependent rendering bug.

Six further hypotheses were tested and eliminated with evidence along the way:
dynamic-resolution governor, camera placement, partially-rasterised snapshot,
leaked `PMREMGenerator` viewport/scissor, canvas backing-store vs CSS size
mismatch, and `preserveDrawingBuffer` alone. Two defensive fixes made while
chasing it — an explicit composer resize in the governor, and viewport/scissor
restore around PMREM — are correct on their own merits and were kept.

Known weakest areas, in the order I would fix them:

1. **No skinned characters.** Soldiers are jointed rigid segments. It reads
   fine at 15 m+ and poorly up close. This is now the largest single gap.
2. **Interior lighting is one bounce short.** Rooms are furnished now
   (`src/world/interior/fitout.js`) and carry their own practicals from a
   pooled set of point lights, but there is no GI, so wall faces away from a
   window or a bulb fall off to near-black in a way real rooms do not.
3. **Facade detail is applied and only partly reviewed.** `building()` drives
   window rhythm, surrounds, glazing, shutters, balconettes, string courses,
   cornices, quoins and shopfronts. Only the interior shots have been looked
   at against it so far.
4. **No LOD or occlusion culling.** The whole map draws every frame. Fine at
   this scale, would not be at four times the size.
5. **Weapon animation is procedural throughout.** Reloads read as a sequence of
   part motions rather than a performance; real keyframed hands would be a
   large step up.
