# OPERATION BLACKOUT — Art Direction Bible

Every system must obey this document. Consistency is what separates AAA from
"a bunch of good-looking parts". When in doubt, match these numbers exactly.

## 1. The pitch

**Dusk raid on a Mediterranean coastal town.** Low sun, long raking shadows,
dust and salt haze in the air, warm stone against cold sky. Think *Modern
Warfare* — grounded, grubby, photographic. Not stylised. Not neon. Not clean.

## 2. Lighting model

| Element | Value |
|---|---|
| Sun elevation | 8.5° above horizon |
| Sun azimuth | 118° (comes from behind-left of the spawn, rakes across the main street) |
| Sun colour | `#ffd2a1` intensity 4.2 (physical units, `useLegacyLights` off) |
| Sky/ambient | PMREM from a physical sky — never a flat `AmbientLight` |
| Shadow bias | `-0.0008`, normalBias `0.02`, radius 3 |
| Exposure | 1.05, AgX tone mapping |
| Fog | Exponential height fog, colour `#c9b9a4` near the sun, `#8fa3b8` away from it, density 0.012, height falloff 0.055 |

Key contrast rule: **shadows are cool, lights are warm.** Ambient bounce in
shadow should read around `#5c6a7a`, direct light around `#ffcf9c`. If a
screenshot looks monochrome-grey, the grade has failed.

## 3. Palette

```
Stone / plaster    #cbbba4  #b0a08a  #8f8271
Warm accent        #c4763a  #8f4a22   (rust, terracotta, sun-bleached paint)
Cool shadow        #4a5a6b  #33404f
Foliage            #6b7b4a  #4a5734   (dry, dusty — never saturated green)
Metal              #6e6f72 base, roughness 0.35–0.6
Sky zenith         #4e7fb3
Danger / UI accent #ff5a3c
Friendly / UI base #cfe4ef at 82% opacity
```

Saturation discipline: nothing in the world exceeds ~55% HSL saturation. All
the colour punch comes from the sun, the grade, and muzzle flashes.

## 4. Scale and proportion (non-negotiable — this is what makes level art read)

- Eye height standing **1.68 m**, crouched **1.05 m**, capsule radius **0.32 m**.
- Door openings **2.05 m** tall, **0.92 m** wide.
- Standard floor-to-floor **3.2 m**. Balcony rail **1.05 m**.
- Waist-high cover **1.05 m**. Chest-high **1.35 m**. Full cover **2.2 m**+.
- Street lane width **7.5 m** minimum for a 3-lane map.
- Stair riser **0.17 m**, tread **0.28 m**.
- Crate 0.8 m cube. Sandbag 0.55 × 0.35 × 0.28 m. Barrel Ø0.58 × 0.88 m.

## 5. Material standard

Every surface needs **at least** albedo + normal + roughness. AO where it
helps. No flat-colour `MeshStandardMaterial` in the world — a single untextured
surface reads as "student project" instantly.

- Texel density target: **512 px / metre** on hero surfaces, 256 on floors.
- Every tiling material gets a **detail normal** at 8–16× the base tiling to
  kill the "smooth plastic at close range" look.
- Roughness is never constant. Minimum ±0.12 variation across a surface.
- Add **edge wear**: lighter albedo + lower roughness on convex edges.
- Add **grime gradients**: darker, rougher toward the ground and in corners.
- Anisotropy 8 (or renderer max) on all world textures.

## 6. Geometry standard

- **No untrimmed 90° corners.** Every wall/floor junction gets a skirting,
  moulding, pipe, or debris pile. Bare corners are the #1 amateur tell.
- **Silhouette breakup:** every building needs AC units, cables, awnings,
  satellite dishes, laundry lines, drainpipes, chipped parapets.
- **Vertical layering:** ground clutter, mid-height detail, roofline detail.
- Bevel or chamfer anything the player gets within 2 m of.
- Repeated props must be randomised: rotation, scale ±8%, albedo tint ±6%.

## 7. Camera and feel

- World FOV **80°** hip / **62°** ADS (interpolated, plus a 1.06× ADS zoom).
- Viewmodel FOV **55°**, rendered in its own pass with cleared depth.
- Head bob amplitude 0.024 m vertical / 0.018 m lateral at run speed. Subtle.
- Every action gets camera feedback: firing kicks, landing dips, sprinting rolls.
- Motion blur is **camera-velocity driven only**, max 14 px.

## 8. The AAA checklist — a shot is not done until all of these are true

1. Three distinct depth layers are visible (foreground occluder, midground
   action space, background silhouette).
2. There is at least one strong light/shadow boundary in frame.
3. No surface larger than 2 m² is a single untextured colour.
4. Atmospheric haze visibly separates near from far.
5. Contact shadows / AO darken every object-to-ground junction.
6. There is dirt, wear, or damage visible on any surface within 3 m.
7. The frame has a clear focal point and the composition leads the eye to it.
8. Nothing z-fights, nothing floats, nothing intersects wrongly.
