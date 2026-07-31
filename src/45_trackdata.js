/* ============================================================================
   SURFACES + TRACK DEFINITIONS
   Every circuit is a closed spline plus a declarative list of features and
   scenery. The builder in the next section turns this into geometry.
   ========================================================================= */

const SURF = { ROAD: 0, DIRT: 1, GRASS: 2, SAND: 3, ICE: 4, BOOST: 5, METAL: 6, VOID: 7 };

/* grip     : lateral grip multiplier (how hard the tyres bite sideways)
   drag     : extra rolling resistance per second
   top      : top-speed multiplier
   shake    : camera shake amplitude while on this surface
   dust     : particle colour kicked up by the wheels
   rate     : particle emission scale                                       */
const SURFACES = [
  { name: 'road', grip: 1.00, drag: 0.00, top: 1.00, shake: 0.00, dust: 0x9aa3b2, rate: 0.0 },
  { name: 'dirt', grip: 0.74, drag: 0.85, top: 0.74, shake: 0.55, dust: 0xb08551, rate: 1.0 },
  { name: 'grass', grip: 0.68, drag: 1.15, top: 0.68, shake: 0.42, dust: 0x6f9b4a, rate: 0.85 },
  { name: 'sand', grip: 0.60, drag: 1.55, top: 0.60, shake: 0.72, dust: 0xe0c48b, rate: 1.35 },
  { name: 'ice', grip: 0.34, drag: -0.12, top: 1.00, shake: 0.10, dust: 0xcfe8ff, rate: 0.5 },
  { name: 'boost', grip: 1.05, drag: -0.30, top: 1.00, shake: 0.00, dust: 0x66e0ff, rate: 0.0 },
  { name: 'metal', grip: 0.95, drag: 0.05, top: 1.00, shake: 0.06, dust: 0xb9c4d6, rate: 0.0 },
  { name: 'void', grip: 0.30, drag: 2.40, top: 0.40, shake: 1.00, dust: 0x8899aa, rate: 1.2 }
];

const SCALES = {
  minor: [0, 2, 3, 5, 7, 8, 10],
  dorian: [0, 2, 3, 5, 7, 9, 10],
  phryg: [0, 1, 3, 5, 7, 8, 10],
  lydian: [0, 2, 4, 6, 7, 9, 11],
  major: [0, 2, 4, 5, 7, 9, 11]
};

const TRACKS = [
  /* ------------------------------------------------------------------ 1 */
  {
    id: 'sunspire',
    name: 'Sunspire Flats',
    blurb: 'Wide desert plateau with a mile-long right sweeper. The Gulch Cut saves two seconds — if you clear the gap.',
    gimmick: 'Split path',
    accent: 0xffb347,
    points: [
      [0, 0, 0, 13], [152, 0, -14, 13], [274, 3, 38, 12], [334, 7, 152, 11.5],
      [314, 9, 268, 11], [214, 6, 344, 10], [92, 3, 360, 9.5], [-26, 2, 322, 10.5],
      [-100, 1, 240, 11.5], [-134, 0, 140, 12], [-166, 2, 38, 12], [-126, 4, -64, 12],
      [-22, 1, -76, 13]
    ],
    pathOpts: { autoBank: 11, maxBank: 12 },
    shoulder: SURF.SAND, shoulderW: 9, outer: SURF.SAND,
    road: { color: 0x4a4550, line: 0xf3e6c8, tex: 'asphalt', kerb: [0xd94f4f, 0xf2f2f2] },
    barrier: { style: 'rock', color: 0xb07a4a, height: 2.2 },
    env: {
      skyTop: 0x1d3f86, skyMid: 0xd98a4c, skyBot: 0xf5c286, sunCol: 0xffeec4, sunDir: [-.45, .55, .3],
      sunInt: 0.95, ambCol: 0xd8a678, ambInt: .34, rim: 0xff6a2c, rimInt: .42,
      fog: 0xd9a878, fogNear: 300, fogFar: 1350, ground: 0x9c7444, star: 0
    },
    decor: [
      { kind: 'mesa', count: 34, u: [70, 280], scale: [1.1, 3.0] },
      { kind: 'rock', count: 150, u: [16, 120], scale: [.5, 2.2] },
      { kind: 'cactus', count: 110, u: [14, 90], scale: [.7, 1.5] },
      { kind: 'sign', count: 18, u: [13, 17], scale: [1, 1] },
      { kind: 'balloon', count: 10, u: [30, 90], scale: [1, 1.8] }
    ],
    features: {
      boosts: [[.07, .10, -.55, .05], [.335, .365, .1, .75], [.70, .73, -.7, -.05], [.955, .98, -.3, .35]],
      ramps: [[.475, .495, 9.5], [.815, .833, 8]],
      shortcut: {
        name: 'Gulch Cut',
        pts: [[306, 9, 276], [210, 7, 278], [110, 5, 276], [10, 4, 268], [-92, 3, 246]],
        width: 7, surf: SURF.DIRT, gap: [.43, .56], gapPower: 11.5, floor: -18,
        boost: [.60, .68]
      }
    },
    music: { bpm: 128, root: 98, scale: SCALES.dorian, prog: [[0, 2, 4], [3, 5, 0], [5, 0, 2], [4, 6, 1]] },
    ambience: { wind: .5, crowd: .22, windFc: 460 }
  },

  /* ------------------------------------------------------------------ 2 */
  {
    id: 'coral',
    name: 'Coral Verge',
    blurb: 'A reef causeway over open water. The Shell Barrel banks past vertical — carry speed or slide off the wall.',
    gimmick: 'Wall ride',
    accent: 0x35e6c8,
    points: [
      [0, 6, 0, 13], [132, 7, -32, 12.5], [252, 10, 8, 11.5], [302, 14, 122, 10.5],
      [272, 17, 232, 10], [172, 12, 302, 10.5], [42, 8, 312, 11.5], [-72, 6, 252, 12],
      [-122, 5, 152, 12.5], [-152, 7, 50, 12], [-126, 9, -42, 12], [-52, 7, -58, 12.5]
    ],
    pathOpts: { autoBank: 13, maxBank: 15, bankOverrides: [[.30, .43, 46]] },
    shoulder: SURF.GRASS, shoulderW: 8.5, outer: SURF.SAND,
    road: { color: 0x5b6b78, line: 0xeafcff, tex: 'coral', kerb: [0x1fb9d6, 0xf6ffff] },
    barrier: { style: 'reef', color: 0xff7fa8, height: 1.7 },
    water: { level: 0.0, color: 0x1a6f8f, deep: 0x07374f },
    env: {
      skyTop: 0x0a3e78, skyMid: 0x3fa8cf, skyBot: 0xaee4f2, sunCol: 0xfff6e8, sunDir: [.4, .62, -.35],
      sunInt: 0.92, ambCol: 0x6bb8e0, ambInt: .38, rim: 0x2ad0b4, rimInt: .5,
      fog: 0x86c4dc, fogNear: 340, fogFar: 1450, ground: 0x1d6b7e, star: 0
    },
    decor: [
      { kind: 'coralArch', count: 22, u: [20, 90], scale: [1, 2.4] },
      { kind: 'palm', count: 120, u: [14, 70], scale: [.8, 1.6] },
      { kind: 'buoy', count: 46, u: [24, 120], scale: [.8, 1.4] },
      { kind: 'sign', count: 16, u: [12, 15], scale: [1, 1] },
      { kind: 'islet', count: 22, u: [120, 290], scale: [1, 3] }
    ],
    features: {
      boosts: [[.135, .165, -.2, .6], [.455, .485, -.7, -.1], [.60, .625, .05, .7], [.86, .885, -.5, .2]],
      ramps: [[.225, .243, 8.5], [.695, .713, 9.5]],
      tunnel: [.30, .43]
    },
    music: { bpm: 118, root: 110, scale: SCALES.lydian, prog: [[0, 2, 4], [4, 6, 1], [3, 5, 0], [0, 2, 4]] },
    ambience: { wind: .42, crowd: .26, windFc: 700 }
  },

  /* ------------------------------------------------------------------ 3 */
  {
    id: 'ember',
    name: 'Ember Foundry',
    blurb: 'A working smelter built on a caldera. Geyser vents relocate every lap — never learn the line, read the light.',
    gimmick: 'Shifting hazards',
    accent: 0xff5a2b,
    points: [
      [0, 0, 0, 12], [128, 2, -18, 11.5], [232, 6, 30, 10.5], [286, 10, 128, 10],
      [246, 12, 224, 9.5], [148, 9, 268, 9], [40, 6, 286, 10], [-64, 4, 246, 10.5],
      [-92, 3, 154, 11], [-58, 4, 66, 10], [-126, 6, 6, 10.5], [-142, 4, -84, 11],
      [-42, 1, -102, 12]
    ],
    pathOpts: { autoBank: 10, maxBank: 12 },
    shoulder: SURF.DIRT, shoulderW: 7, outer: SURF.DIRT,
    road: { color: 0x3a3d47, line: 0xffc44a, tex: 'metal', kerb: [0xff8b2b, 0x2b2b32] },
    barrier: { style: 'girder', color: 0x8a4b2a, height: 2.4 },
    env: {
      skyTop: 0x140a12, skyMid: 0x53190f, skyBot: 0xb8401f, sunCol: 0xffa868, sunDir: [-.3, .5, -.55],
      sunInt: .72, ambCol: 0xc2482a, ambInt: .34, rim: 0xff3c14, rimInt: .72,
      fog: 0x351410, fogNear: 200, fogFar: 1050, ground: 0x2c1a18, star: 0
    },
    decor: [
      { kind: 'chimney', count: 30, u: [26, 140], scale: [1, 2.4] },
      { kind: 'pipe', count: 70, u: [16, 70], scale: [.8, 1.8] },
      { kind: 'rock', count: 120, u: [14, 110], scale: [.5, 1.8] },
      { kind: 'sign', count: 16, u: [12, 15], scale: [1, 1] },
      { kind: 'lavaPool', count: 26, u: [40, 190], scale: [1, 3] }
    ],
    features: {
      boosts: [[.05, .078, -.6, 0], [.29, .318, .05, .65], [.545, .572, -.65, -.05], [.79, .818, -.2, .5]],
      ramps: [[.155, .172, 8.5], [.415, .432, 9], [.63, .647, 8]],
      geysers: 9
    },
    music: { bpm: 148, root: 82.41, scale: SCALES.phryg, prog: [[0, 2, 4], [1, 3, 5], [0, 2, 4], [6, 1, 3]] },
    ambience: { wind: .32, crowd: .18, windFc: 300 }
  },

  /* ------------------------------------------------------------------ 4 */
  {
    id: 'aurora',
    name: 'Aurora Loop',
    blurb: 'Polar night on black ice. The Skyfall ramp launches you into a glide, and the lit lanes swap sides each lap.',
    gimmick: 'Glide + shifting lanes',
    accent: 0x8f7bff,
    points: [
      [0, 4, 0, 13], [140, 4, -26, 12.5], [258, 8, 26, 12], [316, 16, 138, 11],
      [292, 26, 250, 10.5], [188, 18, 326, 10], [58, 10, 344, 11], [-66, 8, 296, 11.5],
      [-128, 6, 200, 12], [-158, 6, 96, 12], [-176, 8, -10, 11.5], [-118, 8, -96, 11.5],
      [-16, 5, -104, 13]
    ],
    pathOpts: { autoBank: 12, maxBank: 14 },
    shoulder: SURF.ICE, shoulderW: 8, outer: SURF.ICE,
    road: { color: 0x2e3a55, line: 0xbfe4ff, tex: 'ice', kerb: [0x6f7bff, 0xe8f4ff] },
    barrier: { style: 'crystal', color: 0x7fa8ff, height: 2.2 },
    env: {
      skyTop: 0x02030c, skyMid: 0x08152f, skyBot: 0x0e2c47, sunCol: 0x9cbcff, sunDir: [.3, .45, .5],
      sunInt: .58, ambCol: 0x35509c, ambInt: .34, rim: 0x8f7bff, rimInt: .78,
      fog: 0x081026, fogNear: 250, fogFar: 1250, ground: 0x14213a, star: 1, aurora: 1
    },
    decor: [
      { kind: 'crystal', count: 130, u: [16, 130], scale: [.7, 2.6] },
      { kind: 'pine', count: 150, u: [18, 120], scale: [.8, 1.8] },
      { kind: 'berg', count: 26, u: [80, 285], scale: [1, 3] },
      { kind: 'sign', count: 16, u: [13, 16], scale: [1, 1] },
      { kind: 'lantern', count: 40, u: [14, 20], scale: [1, 1] }
    ],
    features: {
      boosts: [[.10, .128, -.55, .05], [.38, .41, .05, .65], [.635, .663, -.65, -.05], [.955, .98, -.25, .45]],
      ramps: [[.245, .268, 13.5]],
      glide: [[.245, .335]],
      laneSwap: [[.50, .60], [.72, .80]]
    },
    music: { bpm: 136, root: 116.54, scale: SCALES.minor, prog: [[0, 2, 4], [5, 0, 2], [3, 5, 0], [4, 6, 1]] },
    ambience: { wind: .62, crowd: .14, windFc: 380 }
  }
];

const TRACK_BY_ID = {};
TRACKS.forEach(t => TRACK_BY_ID[t.id] = t);
