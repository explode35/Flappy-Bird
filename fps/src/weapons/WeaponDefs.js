/**
 * Weapon data tables.
 *
 * Recoil patterns are *deterministic* per-shot [pitchDeg, yawDeg] offsets in
 * the CoD/CS tradition: the player can learn and counter them. A small random
 * component is layered on top (`randPitch`/`randYaw`) so the pattern reads as
 * organic without becoming unlearnable. When a burst runs past the end of the
 * table the last entries loop, which is what real long-mag sprays feel like.
 *
 * Sign convention: +pitch = muzzle climbs (camera looks up), +yaw = right.
 */

/** Build an M4-style pattern: hard vertical climb, right drift after shot 8. */
function m4Pattern() {
  const p = [];
  for (let i = 0; i < 30; i++) {
    // Vertical: big first-shot snap, settles into a steady climb, tapers late.
    let pitch;
    if (i === 0) pitch = 0.42;
    else if (i < 4) pitch = 0.40 + i * 0.035;
    else if (i < 10) pitch = 0.50 - (i - 4) * 0.012;
    else pitch = 0.40 - Math.min(0.10, (i - 10) * 0.006);
    // Horizontal: dead straight for 8, then a committed right drift with a
    // shallow left correction around shot 18 (classic AR spray shape).
    let yaw = 0;
    if (i >= 8 && i < 18) yaw = 0.055 + (i - 8) * 0.028;
    else if (i >= 18 && i < 24) yaw = 0.30 - (i - 18) * 0.075;
    else if (i >= 24) yaw = -0.14 + (i - 24) * 0.035;
    p.push([pitch, yaw]);
  }
  return p;
}

/** MP5: faster, looser, whippier — smaller per-shot but a wandering horizontal. */
function mp5Pattern() {
  const p = [];
  for (let i = 0; i < 30; i++) {
    let pitch = i === 0 ? 0.30 : 0.30 + Math.min(0.09, i * 0.010);
    if (i > 14) pitch = 0.36 - (i - 14) * 0.004;
    const yaw = Math.sin(i * 0.62) * (0.05 + Math.min(0.16, i * 0.013))
      + (i > 11 ? -0.035 * (i - 11) * 0.35 : 0);
    p.push([pitch, yaw]);
  }
  return p;
}

/** 1911: heavy single shots, mild alternating yaw from the shooter's grip. */
function pistolPattern() {
  const p = [];
  for (let i = 0; i < 12; i++) {
    p.push([0.66 + (i % 3) * 0.05, (i % 2 ? 0.09 : -0.07)]);
  }
  return p;
}

const DEG = Math.PI / 180;

/** Convert a degree pattern table to radians once, at module load. */
function toRad(pat) { return pat.map(([a, b]) => [a * DEG, b * DEG]); }

export const WEAPONS = {
  m4: {
    id: 'm4',
    name: 'M4A1',
    icon: 'rifle',
    slot: 0,
    kind: 'rifle',
    auto: true,
    rpm: 720,
    magSize: 30,
    reserve: 210,
    maxReserve: 300,
    // Damage falloff
    dmgNear: 33, dmgFar: 21, distNear: 26, distFar: 62,
    penetration: 0.62,          // 0..1 material-thickness budget
    // Spread (radians)
    spreadBase: 0.0042,
    spreadAds: 0.0010,
    spreadMax: 0.062,
    spreadPerShot: 0.0034,
    spreadDecay: 5.2,
    spreadMove: 0.020,
    spreadJump: 0.045,
    spreadCrouch: 0.55,
    // Recoil
    pattern: toRad(m4Pattern()),
    randPitch: 0.055 * DEG * 2.0,
    randYaw: 0.075 * DEG * 2.0,
    recoilRecover: 0.70,
    recoilRecoverRate: 7.5,
    kickBack: 0.026,            // metres the rig translates on Z
    kickUp: 0.115,              // radians the rig pitches up
    kickRoll: 0.055,
    kickFreq: 46,
    kickDamp: 15,
    // Timing (seconds)
    reloadTactical: 2.10,
    reloadEmpty: 2.80,
    adsIn: 0.240, adsOut: 0.190,
    swapTime: 0.55,
    tracerSpeed: 620,
    tracerEvery: 3,
    muzzleFlash: 1.0,
    shellSize: [0.0057, 0.0450],
    silenced: false,
    fovAds: 62,
  },

  mp5: {
    id: 'mp5',
    name: 'MP5A5',
    icon: 'smg',
    slot: 1,
    kind: 'smg',
    auto: true,
    rpm: 800,
    magSize: 30,
    reserve: 240,
    maxReserve: 330,
    dmgNear: 26, dmgFar: 13, distNear: 15, distFar: 38,
    penetration: 0.34,
    spreadBase: 0.0058,
    spreadAds: 0.0018,
    spreadMax: 0.075,
    spreadPerShot: 0.0040,
    spreadDecay: 6.4,
    spreadMove: 0.014,
    spreadJump: 0.040,
    spreadCrouch: 0.60,
    pattern: toRad(mp5Pattern()),
    randPitch: 0.070 * DEG * 2.0,
    randYaw: 0.110 * DEG * 2.0,
    recoilRecover: 0.70,
    recoilRecoverRate: 9.0,
    kickBack: 0.019,
    kickUp: 0.088,
    kickRoll: 0.070,
    kickFreq: 54,
    kickDamp: 17,
    reloadTactical: 2.10,
    reloadEmpty: 2.80,
    adsIn: 0.240, adsOut: 0.190,
    swapTime: 0.55,
    tracerSpeed: 400,
    tracerEvery: 4,
    muzzleFlash: 0.82,
    shellSize: [0.0056, 0.0300],
    silenced: false,
    fovAds: 64,
  },

  m1911: {
    id: 'm1911',
    name: 'M1911',
    icon: 'pistol',
    slot: 2,
    kind: 'pistol',
    auto: false,
    rpm: 350,                   // semi, capped by the trigger reset
    magSize: 7,
    reserve: 56,
    maxReserve: 84,
    dmgNear: 42, dmgFar: 24, distNear: 12, distFar: 34,
    penetration: 0.28,
    spreadBase: 0.0050,
    spreadAds: 0.0012,
    spreadMax: 0.055,
    spreadPerShot: 0.0090,
    spreadDecay: 7.5,
    spreadMove: 0.016,
    spreadJump: 0.038,
    spreadCrouch: 0.55,
    pattern: toRad(pistolPattern()),
    randPitch: 0.090 * DEG * 2.0,
    randYaw: 0.120 * DEG * 2.0,
    recoilRecover: 0.70,
    recoilRecoverRate: 8.0,
    kickBack: 0.030,
    kickUp: 0.155,
    kickRoll: 0.040,
    kickFreq: 40,
    kickDamp: 13,
    reloadTactical: 2.10,
    reloadEmpty: 2.80,
    adsIn: 0.220, adsOut: 0.175,
    swapTime: 0.48,
    tracerSpeed: 340,
    tracerEvery: 5,
    muzzleFlash: 0.9,
    shellSize: [0.0114, 0.0227],
    silenced: false,
    fovAds: 68,
  },
};

export const GRENADE = {
  id: 'frag',
  name: 'M67 Frag',
  icon: 'grenade',
  count: 3,
  maxCount: 4,
  cook: 3.0,
  radius: 7.0,
  damage: 135,
  throwSpeed: 15.5,
  lobSpeed: 7.0,
  gravity: 9.81 * 1.9,
  restitution: 0.32,
  friction: 0.62,
  radiusBody: 0.032,
  throwTime: 0.85,
  pullTime: 0.28,
};

export const ORDER = ['m4', 'mp5', 'm1911'];
