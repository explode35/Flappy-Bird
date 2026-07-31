# NITRO CIRCUIT

An original arcade kart racer that runs in a browser from a single file.

**Play it:** open `nitro-circuit.html`. That's the whole thing — no server, no build,
no network. Three.js r128 is inlined into the file, and every asset (geometry,
texture, particle, sound, music) is generated in code at runtime.

```
W A S D / arrows   steer + throttle + brake
Space              hop, hold to drift
Shift              item — hold to trail it behind you as a shield, release to fire
                   (hold brake while releasing a Bolt Dart to throw it backwards)
R                  respawn      Esc  pause      M  mute      F  fps overlay
```

Gamepads work too: stick/d-pad steers, A accelerates, B brakes, X or RB drifts,
LB or Y for items. In split-screen, player one is **WASD + Space + LShift** and
player two is **arrows + / + .** (`,` to respawn).

## What's in it

**Four circuits**, each a closed Catmull-Rom spline with its own palette, surface
set and signature gimmick:

| Circuit | Environment | Gimmick |
|---|---|---|
| Sunspire Flats | desert plateau, dusk | the **Gulch Cut** — a dirt shortcut across a ravine you have to jump |
| Coral Verge | reef causeway over open water | the **Shell Barrel** — a 46° banked wall you can only hold at speed |
| Ember Foundry | volcanic smelter | geyser vents that **relocate every lap** |
| Aurora Loop | polar night on black ice | a **glide** section, and lit boost lanes that swap sides each lap |

**Eight racers** with distinct stat spreads (speed / accel / handling / weight) and
visually distinct karts built from primitives — wedge, tank, dart, pod, buggy.

**Modes:** single race, Grand Prix (all four circuits, 15-11-9-7-5-3-2-1 points,
running standings), Time Trial with a saved ghost, and two-player split-screen with
a viewport split that merges into one shared camera when both players are close.

**Items** (7) distributed by race position — leaders draw defensive and minor items,
back-markers draw the catch-up hardware: Bolt Dart, Tri-Dart, Seeker Orb, Slick Gel,
Aegis Ring, Turbo Cell, and the rare screen-scrambling Ion Storm.

## The drift-boost chain

The core mechanic. Tap Space to hop, steer while holding it to enter a drift, and
the charge climbs through three tiers — **blue → orange → purple** — each with its
own spark colour and rising audio cue. Release for a boost proportional to the tier.

Charge rate depends on steering *into* the drift, plus a bonus for rapid
counter-steer wiggling, so tier 2 falls out of a normal corner and tier 3 needs a
long sweeper or deliberate work. Sliding sideways scrubs speed (`K.driftScrub`),
which is what stops "drift in a straight line to farm boosts" from being optimal.

Measured in the headless harness, best lap with drifting vs. the same driver with
drifting disabled:

| Circuit | drifting | no drifting | gain |
|---|---|---|---|
| Sunspire Flats | 35.70s | 38.62s | −2.9s |
| Coral Verge | 30.78s | 33.82s | −3.0s |
| Ember Foundry | 38.80s | 40.50s | −1.7s |
| Aurora Loop | 35.33s | 38.92s | −3.6s |

## Notes on the systems

**Physics.** Velocity is decomposed into longitudinal and lateral components each
frame. Acceleration follows a curve toward a top speed that varies with surface,
boost and character; steering authority falls to 44% at top speed; lateral grip is
a damping rate that drops to 30% while drifting. Banking is derived from track
curvature, and gravity along the bank fights the cornering load — on steep sections
speed pins you to the wall and lifting off drops you down it.

**Everything hangs off one spline.** `TrackPath` resamples the circuit to 1400
equal-arc-length points and precomputes tangents, banked frames, curvature, a
racing line and a per-point target speed. Road geometry, surface queries, lap
validation, respawn points, AI lines, projectile guidance and the minimap all read
from that single structure.

**AI.** Opponents run the player's physics with no cheat forces. Steering is pure
pursuit that produces a *desired yaw rate*, which is then inverted through whichever
steering model the kart is currently using — that's what lets them hold a drift
instead of spiralling into the apex. They brake off the precomputed line speed, drift
and wiggle-charge like a player, and make occasional brief mistakes. Catch-up
assistance is limited to item luck and a ±5% top-speed band that scales with the gap
to the leader (`Race._rubberBand`).

**Performance.** 276→~200 draw calls per view and ~65-80k triangles; the simulation
itself costs about 0.3 ms/frame. Scenery is merged per prop type and drawn as
instanced meshes per chunk, particles and projectiles are pooled with no runtime
allocation, and resolution scales adaptively if the frame budget slips.

Open the console and poke at `NITRO_LAB.K` to retune the driving model live — every
physics constant in the game is in that one object.

## Repository layout

`nitro-circuit.html` is the deliverable and is self-contained. It's assembled from
readable chunks so the source is navigable:

```
src/10_util.js        math, RNG, pooling, procedural texture helpers
src/20_audio.js       Web Audio: engines, SFX, ambience, per-track music
src/30_input.js       keyboard (two layouts) + gamepad
src/40_spline.js      TrackPath — the spine of everything
src/45_trackdata.js   surfaces + the four circuit definitions
src/48_trackbuild.js  textures, ribbon builder, scenery library
src/49_track.js       Track: geometry assembly + the surface query
src/50_kart.js        characters, kart models, the driving model
src/60_ai.js          AI drivers
src/70_items.js       item boxes, distribution, projectiles, hazards
src/80_fx.js          particles, post-processing, chase camera
src/90_hud.js         per-player HUD and minimap
src/92_race.js        race loop, positions, laps, split-screen, rendering
src/95_app.js         menus, modes, Grand Prix, main loop
./build.sh            cats the chunks together and inlines vendor/three.min.js
```

Run `./build.sh` after editing anything in `src/`.

Three.js is MIT licensed; `vendor/three.min.js` keeps its licence banner.
Everything else here is original — the cast, circuits, items and music are invented
for this project.
