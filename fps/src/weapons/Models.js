import * as THREE from 'three';
import {
  box, plainBox, taperBox, cyl, cylY, cylX, sphere, torusZ, lathe, tube,
  roundedRectPath, roundedHole, extrude, slottedPlate, picatinny, knurlBand,
  stipplePatch, screwX, place, PartSet, countTris,
} from './GeomKit.js';

/**
 * Procedural weapon viewmodels.
 *
 * Convention: the weapon is built at the origin with the muzzle pointing along
 * -Z (three's forward). Anchors are empty Object3Ds the system reads:
 *
 *   muzzle     where the flash and the first tracer vertex live
 *   sight      the point that must land on screen centre when aiming
 *   eject      shell casing spawn
 *   magWell    where a dropped magazine is released from
 *   boltGroup  animated back/forward on each shot
 *   chargeGroup charging handle, pulled on an empty reload
 *   magGroup   the magazine itself, hidden mid-reload
 *
 * Detail level matters here more than anywhere else in the project: the gun
 * occupies a third of the screen at all times, so a low-poly silhouette or a
 * missing charging handle is the first thing anyone notices.
 */

function anchor(parent, name, x, y, z) {
  const o = new THREE.Object3D();
  o.name = name;
  o.position.set(x, y, z);
  parent.add(o);
  return o;
}

/* ========================================================================== */
/*  Shared sub-assemblies                                                      */
/* ========================================================================== */

/** Red-dot optic: housing, glass, hood, adjustment turrets, mount. */
function redDot(root, mats, { y = 0.052, z = -0.03, scale = 1 } = {}) {
  const g = new THREE.Group();
  g.name = 'optic';
  const S = new PartSet();

  // Mount base + picatinny clamp
  S.add(place(box(0.030 * scale, 0.014 * scale, 0.060 * scale), 0, -0.020 * scale, 0), 'metal');
  S.add(place(box(0.036 * scale, 0.008 * scale, 0.020 * scale), 0, -0.026 * scale, 0.014 * scale), 'metal');
  S.add(place(screwX(0.0035 * scale, 0.040 * scale), 0, -0.026 * scale, 0.014 * scale), 'steel');

  // Tube body — open both ends, with a hood over the front
  const body = tube(0.0165 * scale, 0.0135 * scale, 0.062 * scale, 20);
  S.add(place(body, 0, 0, 0), 'optic');
  const hood = tube(0.0182 * scale, 0.0158 * scale, 0.016 * scale, 20);
  S.add(place(hood, 0, 0, -0.036 * scale), 'optic');

  // Turrets
  S.add(place(cylY(0.0075 * scale, 0.0085 * scale, 0.016 * scale, 10), 0, 0.016 * scale, 0.012 * scale), 'optic');
  S.add(place(knurlBand(0.0075 * scale, 0.010 * scale, 2, 12, 0.0006 * scale, 'y'), 0, 0.021 * scale, 0.012 * scale), 'optic');
  S.add(place(cylX(0.0075 * scale, 0.0085 * scale, 0.016 * scale, 10), 0.016 * scale, 0, 0.012 * scale), 'optic');

  S.build(g, mats, 'optic');

  // Glass element: a real transmissive disc, slightly tinted and tilted.
  const glass = new THREE.Mesh(
    new THREE.CircleGeometry(0.0135 * scale, 20),
    mats.glass
  );
  glass.position.set(0, 0, -0.028 * scale);
  glass.rotation.y = Math.PI;
  glass.renderOrder = 2;
  glass.frustumCulled = false;
  g.add(glass);

  // The dot itself: additive, only visible near the sight line. The system
  // fades it by view angle so it does not float over the world when hip-firing.
  const dotMat = new THREE.SpriteMaterial({
    color: 0xff3322, transparent: true, opacity: 0,
    blending: THREE.AdditiveBlending, depthTest: false, depthWrite: false,
    toneMapped: false, sizeAttenuation: false,
  });
  const dot = new THREE.Sprite(dotMat);
  dot.scale.set(0.0045, 0.0045, 1);
  dot.position.set(0, 0, -0.02 * scale);
  dot.renderOrder = 3;
  dot.frustumCulled = false;
  g.add(dot);
  g.userData.dot = dot;

  g.position.set(0, y, z);
  root.add(g);
  return g;
}

/** Backup iron sights, folded up. */
function ironSights(S, { front = -0.30, rear = 0.02, y = 0.045 } = {}) {
  // Front post in a protective wing
  S.add(place(box(0.0035, 0.020, 0.004), 0, y + 0.004, front), 'steel');
  for (const sx of [-1, 1]) {
    S.add(place(box(0.0030, 0.024, 0.006), sx * 0.010, y + 0.006, front), 'steel');
  }
  S.add(place(box(0.024, 0.005, 0.010), 0, y - 0.006, front), 'metal');
  // Rear aperture
  S.add(place(box(0.026, 0.006, 0.012), 0, y - 0.004, rear), 'metal');
  for (const sx of [-1, 1]) {
    S.add(place(box(0.0045, 0.018, 0.008), sx * 0.008, y + 0.006, rear), 'steel');
  }
}

/**
 * Gloved hands and forearms. Blocky is acceptable — silhouette and material
 * carry it — but they must be posed *onto* the grip and handguard, because
 * hands floating near a weapon is worse than no hands at all.
 */
function hands(root, mats, { gripPos, foregripPos, gripRot = 0 } = {}) {
  const g = new THREE.Group();
  g.name = 'hands';
  const S = new PartSet();

  const makeHand = (px, py, pz, rx, ry, rz, mirror) => {
    const m = mirror ? -1 : 1;
    // Palm
    S.add(place(taperBox(0.052, 0.088, 0.044, 0.086, 0.052), px, py, pz, rx, ry, rz), 'glove');
    // Fingers wrapping forward — four segments reads as a grip at this scale.
    for (let i = 0; i < 4; i++) {
      const fo = (i - 1.5) * 0.018;
      S.add(place(box(0.015, 0.015, 0.046), px + m * 0.020, py - 0.008 + fo * 0.15, pz - 0.028 + fo * 0.1,
        rx + 0.5, ry, rz), 'gloveGrip');
    }
    // Thumb across the back
    S.add(place(box(0.017, 0.040, 0.017), px - m * 0.024, py + 0.010, pz - 0.010, rx, ry, rz + m * 0.5), 'glove');
    // Knuckle pad — the detail that makes it read as a tactical glove
    S.add(place(box(0.048, 0.010, 0.038), px + m * 0.006, py + 0.030, pz - 0.014, rx, ry, rz), 'gloveGrip');
    // Forearm + cuff, angled back out of frame
    S.add(place(cyl(0.040, 0.049, 0.30, 12), px - m * 0.01, py - 0.02, pz + 0.19, -0.28, m * 0.16, 0), 'sleeve');
    S.add(place(cyl(0.047, 0.047, 0.030, 12), px - m * 0.01, py - 0.008, pz + 0.055, -0.28, m * 0.16, 0), 'gloveGrip');
  };

  if (gripPos) makeHand(gripPos[0] + 0.012, gripPos[1] - 0.028, gripPos[2] + 0.012, 0.32, 0, gripRot, false);
  if (foregripPos) makeHand(foregripPos[0] - 0.010, foregripPos[1] - 0.040, foregripPos[2], 0.22, 0, -0.25, true);

  S.build(g, mats, 'hands');
  root.add(g);
  return g;
}

/* ========================================================================== */
/*  M4A1 carbine                                                               */
/* ========================================================================== */

export function buildM4(mats) {
  const root = new THREE.Group();
  root.name = 'm4';
  const S = new PartSet();

  // ---- upper receiver ------------------------------------------------------
  S.add(place(box(0.038, 0.046, 0.200), 0, 0.020, -0.020), 'metal');
  S.add(place(box(0.030, 0.014, 0.196), 0, 0.046, -0.020), 'metal');   // flat-top rail base
  S.add(place(picatinny(0.190, 1), 0, 0.055, -0.020), 'metal');
  // Forward assist + brass deflector
  S.add(place(cyl(0.008, 0.008, 0.024, 10), 0.021, 0.020, 0.052), 'metal');
  S.add(place(taperBox(0.020, 0.030, 0.008, 0.024, 0.034), 0.024, 0.026, 0.030), 'metal');

  // Ejection port with a hinged dust cover
  const port = new THREE.Group();
  port.name = 'ejectPort';
  const pS = new PartSet();
  pS.add(place(box(0.006, 0.030, 0.052), 0.020, 0.022, 0.024), 'metal');
  pS.build(port, mats, 'port');
  root.add(port);
  S.add(place(box(0.004, 0.026, 0.048), 0.0195, 0.022, 0.024, 0, 0, 0), 'steel');

  // ---- lower receiver ------------------------------------------------------
  S.add(place(box(0.034, 0.036, 0.140), 0, -0.010, 0.010), 'metal');
  S.add(place(box(0.030, 0.030, 0.052), 0, -0.026, -0.014), 'metal');  // magwell
  S.add(place(taperBox(0.032, 0.034, 0.030, 0.032, 0.050), 0, -0.030, -0.016), 'metal');

  // Trigger guard + trigger
  S.add(place(box(0.020, 0.005, 0.046), 0, -0.044, 0.022), 'metal');
  S.add(place(box(0.006, 0.024, 0.005), 0, -0.034, 0.043), 'metal');
  S.add(place(box(0.005, 0.020, 0.008), 0, -0.032, 0.020), 'steel');
  // Magazine release, safety selector, bolt catch
  S.add(place(cylX(0.006, 0.006, 0.014, 8), 0.020, -0.008, 0.006), 'metal');
  S.add(place(cylX(0.007, 0.007, 0.030, 8), 0, -0.006, 0.034), 'metal');
  S.add(place(box(0.008, 0.014, 0.020), -0.020, -0.006, 0.034), 'safetyRed');
  S.add(place(box(0.006, 0.020, 0.026), -0.019, -0.012, 0.004), 'metal');

  // ---- pistol grip (stippled) ---------------------------------------------
  S.add(place(taperBox(0.030, 0.034, 0.026, 0.030, 0.100), 0, -0.070, 0.058, 0.30), 'polymer');
  S.add(place(stipplePatch(0.026, 0.070, 5, 12, 0.0012), 0, -0.070, 0.040, 0.30), 'rubber');
  S.add(place(box(0.032, 0.008, 0.030), 0, -0.114, 0.070, 0.30), 'polymer');

  // ---- stock ---------------------------------------------------------------
  S.add(place(cyl(0.016, 0.016, 0.150, 12), 0, 0.014, 0.150), 'metal');       // buffer tube
  S.add(place(box(0.040, 0.052, 0.110), 0, 0.008, 0.170), 'polymer');
  S.add(place(taperBox(0.042, 0.056, 0.038, 0.030, 0.030), 0, 0.004, 0.232), 'rubber'); // butt pad
  S.add(place(box(0.044, 0.010, 0.058), 0, -0.020, 0.166), 'polymer');        // cheek shelf
  for (let i = 0; i < 5; i++) {                                               // adjustment notches
    S.add(place(box(0.018, 0.004, 0.005), 0, -0.002, 0.120 + i * 0.018), 'metal');
  }

  // ---- handguard -----------------------------------------------------------
  const HG_Z = -0.150, HG_LEN = 0.230;
  S.add(place(tube(0.026, 0.021, HG_LEN, 16), 0, 0.020, HG_Z), 'metal');
  S.add(place(picatinny(HG_LEN - 0.02, 1), 0, 0.047, HG_Z), 'metal');
  // Vent slots around the handguard — the detail that reads as an M-LOK rail
  for (let r = 0; r < 6; r++) {
    const a = (r / 6) * Math.PI * 2 + 0.5;
    if (Math.abs(a - Math.PI * 1.5) < 0.5) continue;   // skip the top rail
    for (let i = 0; i < 5; i++) {
      S.add(place(box(0.006, 0.003, 0.026),
        Math.cos(a) * 0.024, 0.020 + Math.sin(a) * 0.024, HG_Z - 0.085 + i * 0.040,
        0, 0, a), 'steel');
    }
  }
  // Angled foregrip
  S.add(place(taperBox(0.024, 0.028, 0.020, 0.024, 0.072), 0, -0.020, HG_Z - 0.030, -0.42), 'polymer');
  S.add(place(stipplePatch(0.020, 0.050, 4, 9, 0.001), 0, -0.030, HG_Z - 0.036, -0.42), 'rubber');

  // ---- barrel, gas block, muzzle ------------------------------------------
  S.add(place(cyl(0.0092, 0.0105, 0.330, 14), 0, 0.020, -0.190), 'steel');
  S.add(place(box(0.020, 0.026, 0.030), 0, 0.026, -0.256), 'steel');          // gas block
  S.add(place(cyl(0.0042, 0.0042, 0.150, 8), 0, 0.036, -0.210), 'steel');     // gas tube
  // Flash hider with real ports
  S.add(place(cyl(0.0125, 0.0125, 0.052, 14), 0, 0.020, -0.352), 'hotMetal');
  S.add(place(cyl(0.0100, 0.0125, 0.012, 14), 0, 0.020, -0.322), 'hotMetal');
  for (let i = 0; i < 5; i++) {
    const a = -Math.PI * 0.5 + (i - 2) * 0.5;
    S.add(place(box(0.004, 0.010, 0.030),
      Math.cos(a) * 0.011, 0.020 + Math.sin(a) * 0.011, -0.356, 0, 0, a), 'steel');
  }
  S.add(place(knurlBand(0.0126, 0.010, 2, 16, 0.0004), 0, 0.020, -0.330), 'steel');

  // Sling loops
  S.add(place(torusZ(0.010, 0.0022, 6, 12), -0.020, 0.006, 0.116), 'steel');
  S.add(place(torusZ(0.009, 0.0022, 6, 12), -0.024, 0.020, -0.246), 'steel');

  ironSights(S, { front: -0.256, rear: 0.062, y: 0.048 });
  const tris = S.build(root, mats, 'm4');

  // ---- animated sub-groups -------------------------------------------------
  const bolt = new THREE.Group(); bolt.name = 'bolt';
  const bS = new PartSet();
  bS.add(place(cyl(0.0155, 0.0155, 0.070, 12), 0, 0.022, 0.016), 'steel');
  bS.add(place(box(0.010, 0.010, 0.030), 0.014, 0.030, 0.030), 'steel');
  bS.build(bolt, mats, 'bolt');
  root.add(bolt);

  const charge = new THREE.Group(); charge.name = 'charge';
  const cS = new PartSet();
  cS.add(place(box(0.052, 0.012, 0.016), 0, 0.040, 0.108), 'metal');
  cS.add(place(box(0.014, 0.014, 0.060), 0, 0.040, 0.082), 'metal');
  for (const sx of [-1, 1]) cS.add(place(box(0.012, 0.014, 0.020), sx * 0.024, 0.040, 0.112), 'metal');
  cS.build(charge, mats, 'charge');
  root.add(charge);

  const mag = new THREE.Group(); mag.name = 'mag';
  const mS = new PartSet();
  mS.add(place(taperBox(0.026, 0.028, 0.024, 0.026, 0.180), 0, -0.120, -0.006, 0.10), 'polymer');
  mS.add(place(box(0.030, 0.010, 0.030), 0, -0.208, 0.004), 'polymer');
  for (let i = 0; i < 6; i++) mS.add(place(box(0.027, 0.003, 0.026), 0, -0.060 - i * 0.026, -0.004), 'polymer');
  mS.build(mag, mats, 'mag');
  root.add(mag);

  const anchors = {
    muzzle: anchor(root, 'muzzle', 0, 0.020, -0.380),
    sight: anchor(root, 'sight', 0, 0.104, -0.030),      // centre of the red dot
    eject: anchor(root, 'eject', 0.028, 0.022, 0.024),
    magWell: anchor(root, 'magWell', 0, -0.060, -0.010),
  };
  redDot(root, mats, { y: 0.104, z: -0.030, scale: 1.0 });
  hands(root, mats, { gripPos: [0, -0.070, 0.058], foregripPos: [0, -0.020, HG_Z - 0.030], gripRot: 0.3 });

  root.userData = { anchors, bolt, charge, mag, port, tris: countTris(root) };
  return root;
}

/* ========================================================================== */
/*  MP5A5 submachine gun                                                       */
/* ========================================================================== */

export function buildMP5(mats) {
  const root = new THREE.Group();
  root.name = 'mp5';
  const S = new PartSet();

  // Receiver — the MP5's stamped tube with its distinctive ribs
  S.add(place(cyl(0.021, 0.021, 0.230, 16), 0, 0.020, -0.030), 'metal');
  S.add(place(box(0.036, 0.030, 0.230), 0, 0.014, -0.030), 'metal');
  for (let i = 0; i < 7; i++) S.add(place(box(0.044, 0.004, 0.006), 0, 0.030, -0.120 + i * 0.030), 'metal');

  // Cocking tube along the left, with the famous HK slap handle
  S.add(place(cyl(0.011, 0.011, 0.240, 10), -0.026, 0.036, -0.100), 'metal');
  // Lower / grip frame
  S.add(place(box(0.032, 0.034, 0.130), 0, -0.008, 0.030), 'polymer');
  S.add(place(box(0.020, 0.005, 0.044), 0, -0.038, 0.036), 'polymer');
  S.add(place(box(0.005, 0.019, 0.008), 0, -0.028, 0.036), 'steel');
  S.add(place(taperBox(0.030, 0.032, 0.026, 0.028, 0.098), 0, -0.062, 0.062, 0.26), 'polymer');
  S.add(place(stipplePatch(0.024, 0.066, 5, 11, 0.0011), 0, -0.062, 0.046, 0.26), 'rubber');
  S.add(place(box(0.036, 0.020, 0.036), -0.020, -0.004, 0.048), 'polymer');   // selector housing
  S.add(place(cylX(0.007, 0.007, 0.036, 8), 0, -0.004, 0.052), 'metal');

  // Magazine — curved 30-round stick
  const mag = new THREE.Group(); mag.name = 'mag';
  const mS = new PartSet();
  for (let i = 0; i < 6; i++) {
    const t = i / 5;
    mS.add(place(box(0.024, 0.034, 0.028), 0, -0.052 - i * 0.032, -0.030 - t * t * 0.030, t * 0.10), 'metal');
  }
  mS.add(place(box(0.028, 0.010, 0.032), 0, -0.244, -0.086), 'polymer');
  mS.build(mag, mats, 'mag');
  root.add(mag);
  S.add(place(box(0.030, 0.036, 0.040), 0, -0.026, -0.026), 'metal');   // magwell

  // Handguard
  S.add(place(taperBox(0.042, 0.040, 0.036, 0.034, 0.170), 0, 0.010, -0.170), 'polymer');
  for (let i = 0; i < 4; i++) S.add(place(box(0.046, 0.004, 0.008), 0, -0.008, -0.220 + i * 0.032), 'polymer');
  S.add(place(picatinny(0.130, 0.9), 0, 0.040, -0.060), 'metal');

  // Barrel + tri-lug muzzle
  S.add(place(cyl(0.0080, 0.0090, 0.150, 12), 0, 0.020, -0.278), 'steel');
  S.add(place(cyl(0.0125, 0.0125, 0.030, 14), 0, 0.020, -0.344), 'hotMetal');
  for (let i = 0; i < 3; i++) {
    const a = (i / 3) * Math.PI * 2;
    S.add(place(box(0.006, 0.010, 0.018), Math.cos(a) * 0.012, 0.020 + Math.sin(a) * 0.012, -0.340, 0, 0, a), 'steel');
  }

  // Retractable stock
  S.add(place(cyl(0.010, 0.010, 0.180, 10), -0.022, 0.014, 0.150), 'metal');
  S.add(place(cyl(0.010, 0.010, 0.180, 10), 0.022, 0.014, 0.150), 'metal');
  S.add(place(box(0.060, 0.040, 0.028), 0, 0.014, 0.238), 'rubber');

  // Drum rear sight + hooded front post
  S.add(place(cyl(0.016, 0.016, 0.014, 12), 0, 0.046, 0.058), 'metal');
  S.add(place(tube(0.013, 0.010, 0.026, 12), 0, 0.046, -0.244), 'metal');
  S.add(place(box(0.003, 0.014, 0.003), 0, 0.044, -0.244), 'steel');

  const tris = S.build(root, mats, 'mp5');

  const bolt = new THREE.Group(); bolt.name = 'bolt';
  const bS = new PartSet();
  bS.add(place(box(0.026, 0.014, 0.030), -0.030, 0.036, -0.196), 'metal');   // charging handle
  bS.add(place(cyl(0.010, 0.010, 0.040, 10), -0.026, 0.036, -0.190), 'steel');
  bS.build(bolt, mats, 'bolt');
  root.add(bolt);

  const charge = new THREE.Group(); charge.name = 'charge'; root.add(charge);
  const port = new THREE.Group(); port.name = 'port'; root.add(port);

  const anchors = {
    muzzle: anchor(root, 'muzzle', 0, 0.020, -0.362),
    sight: anchor(root, 'sight', 0, 0.100, -0.040),
    eject: anchor(root, 'eject', 0.026, 0.026, -0.060),
    magWell: anchor(root, 'magWell', 0, -0.050, -0.030),
  };
  redDot(root, mats, { y: 0.100, z: -0.040, scale: 0.95 });
  hands(root, mats, { gripPos: [0, -0.062, 0.062], foregripPos: [0, -0.014, -0.180], gripRot: 0.26 });

  root.userData = { anchors, bolt, charge, mag, port, tris: countTris(root) };
  return root;
}

/* ========================================================================== */
/*  M1911 pistol                                                               */
/* ========================================================================== */

export function build1911(mats) {
  const root = new THREE.Group();
  root.name = 'm1911';
  const S = new PartSet();

  // Frame
  S.add(place(box(0.026, 0.030, 0.150), 0, -0.010, -0.020), 'metal');
  S.add(place(box(0.018, 0.005, 0.040), 0, -0.032, 0.006), 'metal');   // trigger guard
  S.add(place(box(0.005, 0.018, 0.006), 0, -0.024, 0.020), 'steel');
  // Grip with checkered panels
  S.add(place(taperBox(0.028, 0.032, 0.026, 0.030, 0.100), 0, -0.058, 0.044, 0.28), 'metal');
  for (const sx of [-1, 1]) {
    S.add(place(box(0.005, 0.070, 0.030), sx * 0.015, -0.058, 0.042, 0.28), 'polymer');
    S.add(place(stipplePatch(0.026, 0.062, 5, 10, 0.0011), sx * 0.017, -0.058, 0.042, 0.28, sx * Math.PI * 0.5), 'rubber');
  }
  S.add(place(box(0.030, 0.010, 0.028), 0, -0.104, 0.052, 0.28), 'metal');
  // Beavertail + hammer + thumb safety
  S.add(place(taperBox(0.024, 0.020, 0.018, 0.010, 0.034), 0, 0.006, 0.070, -0.35), 'metal');
  S.add(place(box(0.008, 0.024, 0.010), 0, 0.014, 0.082, -0.30), 'steel');
  S.add(place(box(0.006, 0.010, 0.026), -0.016, 0.000, 0.054), 'steel');

  // ---- slide (animated) ----------------------------------------------------
  const slide = new THREE.Group(); slide.name = 'bolt';
  const sS = new PartSet();
  sS.add(place(box(0.028, 0.030, 0.190), 0, 0.020, -0.040), 'steel');
  sS.add(place(cyl(0.0125, 0.0125, 0.185, 14), 0, 0.026, -0.040), 'steel');
  // Cocking serrations
  for (let i = 0; i < 8; i++) {
    sS.add(place(box(0.030, 0.020, 0.003), 0, 0.018, 0.028 - i * 0.006), 'metal');
  }
  // Ejection port
  sS.add(place(box(0.006, 0.014, 0.032), 0.014, 0.026, -0.014), 'metal');
  // Sights
  sS.add(place(box(0.016, 0.008, 0.006), 0, 0.040, 0.046), 'steel');
  sS.add(place(box(0.004, 0.008, 0.004), 0, 0.040, -0.116), 'steel');
  for (const sx of [-1, 1]) sS.add(place(sphere(0.0016, 6, 5), sx * 0.005, 0.041, 0.046), 'tritium');
  sS.add(place(sphere(0.0016, 6, 5), 0, 0.041, -0.116), 'tritium');
  sS.build(slide, mats, 'slide');
  root.add(slide);

  // Barrel bushing + recoil plug
  S.add(place(tube(0.0135, 0.0100, 0.014, 14), 0, 0.026, -0.132), 'metal');

  const mag = new THREE.Group(); mag.name = 'mag';
  const mS = new PartSet();
  mS.add(place(box(0.022, 0.096, 0.028), 0, -0.062, 0.044, 0.28), 'metal');
  mS.add(place(box(0.026, 0.008, 0.032), 0, -0.110, 0.052, 0.28), 'metal');
  mS.build(mag, mats, 'mag');
  root.add(mag);

  const tris = S.build(root, mats, 'm1911');
  const charge = new THREE.Group(); root.add(charge);
  const port = new THREE.Group(); root.add(port);

  const anchors = {
    muzzle: anchor(root, 'muzzle', 0, 0.026, -0.140),
    sight: anchor(root, 'sight', 0, 0.045, -0.116),
    eject: anchor(root, 'eject', 0.022, 0.026, -0.014),
    magWell: anchor(root, 'magWell', 0, -0.040, 0.040),
  };
  hands(root, mats, { gripPos: [0, -0.058, 0.044], foregripPos: [-0.030, -0.052, 0.030], gripRot: 0.28 });

  root.userData = { anchors, bolt: slide, charge, mag, port, tris: countTris(root) };
  return root;
}

/** A loose magazine prop, dropped during reloads. */
export function buildLooseMag(mats, kind) {
  const g = new THREE.Group();
  const S = new PartSet();
  if (kind === 'm1911') {
    S.add(place(box(0.022, 0.096, 0.028), 0, 0, 0), 'metal');
  } else if (kind === 'mp5') {
    for (let i = 0; i < 6; i++) S.add(place(box(0.024, 0.034, 0.028), 0, -i * 0.032, -Math.pow(i / 5, 2) * 0.030), 'metal');
  } else {
    S.add(place(taperBox(0.026, 0.028, 0.024, 0.026, 0.180), 0, 0, 0), 'polymer');
  }
  S.build(g, mats, 'loosemag');
  return g;
}

export const BUILDERS = { m4: buildM4, mp5: buildMP5, m1911: build1911 };
