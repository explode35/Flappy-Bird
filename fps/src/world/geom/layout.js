/**
 * HARBOUR — map layout data.
 *
 * Declarative on purpose: the builders in kit.js and props.js turn this into
 * geometry, so tuning the map is editing numbers here rather than surgery on
 * mesh code. Coordinates are metres, +Z is toward the player spawn, the sea is
 * to the +X side.
 *
 *   Lane A (market)  x ≈ -31 .. -17
 *   Lane B (plaza)   x ≈ -12 .. +12
 *   Lane C (harbour) x ≈ +14 .. +34
 *
 * Building storeys are 3.2 m (ART_DIRECTION §4), so roof heights are 3.2 × n.
 */

const S = 3.2;

export const LAYOUT = {
  nav: { min: [-40, -40], max: [40, 40] },

  // --- ground plates -------------------------------------------------------
  ground: [
    { x: 0,   z: 4,   w: 26, d: 76, mat: 'asphalt',   uv: 2.4 },   // plaza + approach
    { x: -24, z: 0,   w: 22, d: 64, mat: 'concrete',  uv: 2.2 },   // market street
    { x: 22,  z: -2,  w: 26, d: 70, mat: 'concrete',  uv: 2.4 },   // quay
    { x: 36,  z: 8,   w: 10, d: 40, mat: 'gravel',    uv: 1.8 },   // yard
    { x: -37, z: -8,  w: 14, d: 44, mat: 'gravel',    uv: 1.8 },   // back alley
    { x: 0,   z: -36, w: 80, d: 16, mat: 'asphalt',   uv: 2.4 },   // cross street
  ],

  // --- buildings -----------------------------------------------------------
  // side: 'n' = -Z face, 's' = +Z, 'w' = -X, 'e' = +X. `at` is 0..1 along it.
  buildings: [
    // Market row, west side of Lane A
    { x: -37, z: 14,  w: 12, d: 14, storeys: 2, wall: 'plaster', commercial: true, role: 'shop',
      doors: [{ side: 'e', at: 0.5 }], windows: [
        { side: 'e', at: 0.2 }, { side: 'e', at: 0.8 },
        { side: 'e', at: 0.3, storey: 1 }, { side: 'e', at: 0.7, storey: 1 },
        { side: 's', at: 0.5, storey: 1 }] },
    { x: -37, z: -6,  w: 12, d: 16, storeys: 2, wall: 'brick', role: 'apartment',
      doors: [{ side: 'e', at: 0.35 }], windows: [
        { side: 'e', at: 0.7 }, { side: 'e', at: 0.25, storey: 1 }, { side: 'e', at: 0.75, storey: 1 }] },

    // Market row, east side (backs onto the plaza) — this is the two-storey
    // apartment with the balcony over the plaza.
    { x: -14, z: 10, w: 13, d: 18, storeys: 2, wall: 'plaster', floor: 'tileFloor', commercial: true, role: 'shop',
      roofStair: { x: -8.0, z: 19.5, ry: 0 },
      balconies: [{ x: -7.2, y: S, z: 4.0, w: 4.2, ry: 0 }],
      doors: [{ side: 'w', at: 0.5 }, { side: 'e', at: 0.6 }],
      windows: [
        { side: 'e', at: 0.25 }, { side: 'e', at: 0.3, storey: 1 }, { side: 'e', at: 0.8, storey: 1 },
        { side: 'w', at: 0.25 }, { side: 'w', at: 0.75 },
        { side: 's', at: 0.5 }, { side: 'n', at: 0.5, storey: 1 }] },

    // Café on the plaza's west edge (interior shot 05 lives here)
    { x: -14, z: -10, w: 13, d: 16, storeys: 1, wall: 'plaster', floor: 'tileFloor', commercial: true, role: 'cafe',
      doors: [{ side: 'e', at: 0.5 }, { side: 'n', at: 0.5 }],
      windows: [{ side: 'e', at: 0.18, w: 1.8, h: 1.6, sill: 0.85 },
                { side: 'e', at: 0.82, w: 1.8, h: 1.6, sill: 0.85 },
                { side: 's', at: 0.5, w: 1.6, h: 1.4, sill: 0.9 }] },

    // Plaza north side
    { x: -2, z: -28, w: 18, d: 12, storeys: 3, wall: 'plaster', role: 'apartment',
      roofStair: { x: 6.6, z: -22.5, ry: Math.PI },
      balconies: [{ x: -4, y: S, z: -22.2, w: 5, ry: Math.PI }, { x: 4, y: S * 2, z: -22.2, w: 5, ry: Math.PI }],
      doors: [{ side: 's', at: 0.5 }],
      windows: [
        { side: 's', at: 0.2 }, { side: 's', at: 0.8 },
        { side: 's', at: 0.25, storey: 1 }, { side: 's', at: 0.75, storey: 1 },
        { side: 's', at: 0.25, storey: 2 }, { side: 's', at: 0.75, storey: 2 }] },

    // Garage / workshop on the plaza's east edge
    { x: 16, z: 14, w: 12, d: 12, storeys: 1, wall: 'concreteWall', floor: 'concrete', role: 'garage',
      doors: [{ side: 'w', at: 0.5 }],
      windows: [{ side: 'w', at: 0.2, w: 1.6 }, { side: 'n', at: 0.5, w: 1.6 }] },

    // Harbour warehouse — big shed with the catwalk ring
    { x: 22, z: -18, w: 20, d: 18, storeys: 2, wall: 'corrugated', floor: 'concrete', role: 'warehouse',
      doors: [{ side: 'w', at: 0.3 }, { side: 's', at: 0.5 }],
      windows: [{ side: 'w', at: 0.7, w: 2.0, h: 1.4, sill: 1.9 },
                { side: 'n', at: 0.5, w: 2.4, h: 1.4, sill: 1.9 },
                { side: 'e', at: 0.5, w: 2.4, h: 1.4, sill: 1.9 }] },
  ],

  fountain: { x: -1, z: -4 },

  // --- plaza and lane cover -------------------------------------------------
  // Rhythm target: something to break line of sight roughly every 6 m.
  cover: [
    { type: 'car',     x: 4.5,   z: 16,  ry: 0.35 },
    { type: 'car',     x: -5.5,  z: -16, ry: -1.9 },
    { type: 'car',     x: 8.0,   z: -30, ry: 1.5 },
    { type: 'sandbag', x: -7.5,  z: 8,   ry: 0.1 },
    { type: 'sandbag', x: 7.0,   z: 2,   ry: 1.57 },
    { type: 'sandbag', x: 1.5,   z: -18, ry: 0 },
    { type: 'sandbag', x: 18,    z: 2,   ry: 1.57 },
    { type: 'jersey',  x: -3,    z: 24,  ry: 0 },
    { type: 'jersey',  x: 3,     z: 24,  ry: 0 },
    { type: 'jersey',  x: 9.5,   z: -8,  ry: 1.2 },
    { type: 'jersey',  x: -9.5,  z: -24, ry: 0.3 },
    { type: 'planter', x: -6,    z: 0 },
    { type: 'planter', x: 5,     z: -10 },
    { type: 'planter', x: -6,    z: -10 },
    { type: 'planter', x: 5,     z: 0 },
    { type: 'palm',    x: -9,    z: 12 },
    { type: 'palm',    x: 9,     z: 10 },
    { type: 'palm',    x: -10,   z: -20 },
    { type: 'crate',   x: -20,   z: -14, n: 2 },
    { type: 'crate',   x: -22,   z: 2,   n: 3 },
    { type: 'crate',   x: 15,    z: -6,  n: 2 },
    { type: 'crate',   x: 27,    z: 12,  n: 3 },
    { type: 'crate',   x: 30,    z: -26, n: 2 },
    { type: 'barrel',  x: -19,   z: -12 },
    { type: 'barrel',  x: -19.8, z: -13 },
    { type: 'barrel',  x: 16.5,  z: 8 },
    { type: 'barrel',  x: 17.4,  z: 8.7 },
    { type: 'barrel',  x: 29,    z: -6 },
    { type: 'barrel',  x: 29.8,  z: -5.2 },
    { type: 'barrel',  x: -30,   z: 22 },
    { type: 'tyres',   x: 14,    z: 9 },
    { type: 'tyres',   x: 31,    z: 4 },
    { type: 'tyres',   x: -21,   z: 20 },
    { type: 'pallet',  x: 25,    z: 6 },
    { type: 'pallet',  x: -18,   z: 8 },
    { type: 'pallet',  x: 20,    z: -6 },
    { type: 'cafe',    x: -6.5,  z: -6.5 },
    { type: 'cafe',    x: -6.5,  z: -13 },
    { type: 'cafe',    x: -16,   z: -4 },
    { type: 'shelf',   x: -18.5, z: -14, ry: 1.57 },
    { type: 'shelf',   x: 26,    z: -22, ry: 0 },
  ],

  stalls: [
    { x: -21, z: 16 }, { x: -27, z: 12 }, { x: -21, z: 6 },
    { x: -27, z: 0 }, { x: -21, z: -4 }, { x: -27, z: -10 },
    { x: -21, z: -18 }, { x: -27, z: -22 }, { x: -21, z: -26 },
  ],

  awnings: [
    { x: -30.6, z: 14, y: 2.9, ry: -Math.PI / 2 },
    { x: -30.6, z: 8,  y: 2.7, ry: -Math.PI / 2 },
    { x: -30.6, z: -4, y: 2.9, ry: -Math.PI / 2 },
    { x: -30.6, z: -10, y: 2.7, ry: -Math.PI / 2 },
    { x: -17.6, z: 6,  y: 2.8, ry: Math.PI / 2 },
    { x: -17.6, z: 14, y: 2.9, ry: Math.PI / 2 },
    { x: -7.4,  z: -6, y: 2.85, ry: Math.PI / 2 },
  ],

  streetlights: [
    { x: -11.5, z: 20 }, { x: 11.5, z: 20, ry: Math.PI },
    { x: -11.5, z: 4 },  { x: 11.5, z: 4, ry: Math.PI },
    { x: -11.5, z: -14 }, { x: 11.5, z: -14, ry: Math.PI },
    { x: 14, z: -32, ry: -1.57 }, { x: 32, z: 16, ry: 1.57 },
    { x: -32, z: -28, ry: 1.57 },
  ],

  kerbs: [
    { x: -13, z: 10, len: 60, ry: Math.PI / 2 },
    { x: 13,  z: 10, len: 60, ry: Math.PI / 2 },
    { x: -13, z: -26, len: 20, ry: Math.PI / 2 },
    { x: 13,  z: -26, len: 20, ry: Math.PI / 2 },
    { x: 0,   z: 40, len: 26 },
  ],

  containers: [
    { x: 30, z: -14, ry: 0 },
    { x: 30, z: -14, ry: 0, y: 2.59 },
    { x: 30, z: -6.5, ry: 0.04 },
    { x: 34, z: 22, ry: 1.57 },
    { x: 34, z: 28, ry: 1.57 },
    { x: 34, z: 25, ry: 1.57, y: 2.59 },
    { x: 17, z: -34, ry: 0.02 },
    { x: 25, z: -34, ry: -0.03 },
    { x: 21, z: -34, ry: 0, y: 2.59 },
  ],

  harbour: {
    seaWallX: 38,
    crane: { x: 33, z: -30, ry: -0.4 },
    boat: { x: 42, z: 4, ry: 0.06, y: -1.2 },
    warehouse: { x: 22, z: -18, w: 20, d: 18, deckY: 3.35, stairX: -7.5, stairZ: 7.0, stairRy: 0 },
  },

  roofProps: [
    { type: 'ac', x: -12, z: 6,  y: S * 2 },
    { type: 'ac', x: -16, z: 12, y: S * 2 },
    { type: 'ac', x: -35, z: 16, y: S * 2 },
    { type: 'ac', x: -35, z: -4, y: S * 2 },
    { type: 'ac', x: -6,  z: -26, y: S * 3 },
    { type: 'ac', x: 2,   z: -30, y: S * 3 },
    { type: 'ac', x: 19,  z: -16, y: S * 2 },
    { type: 'ac', x: 14,  z: 12, y: S },
    { type: 'dish', x: -11, z: 14, y: S * 2, ry: 2.2 },
    { type: 'dish', x: -38, z: -2, y: S * 2, ry: 1.1 },
    { type: 'dish', x: 3,   z: -25, y: S * 3, ry: -0.7 },
    { type: 'dish', x: 25,  z: -22, y: S * 2, ry: 0.4 },
  ],

  // Overhead cable runs — cheap, and they do a lot for a lived-in silhouette.
  cables: [
    { a: [-31, 6.6, 20], b: [-17.5, 6.4, 16], sag: 1.1 },
    { a: [-31, 6.6, 2],  b: [-17.5, 6.3, -2], sag: 1.2 },
    { a: [-31, 6.5, -14], b: [-17.5, 6.4, -10], sag: 1.0 },
    { a: [-17.5, 6.5, 4], b: [-11, 9.6, -22], sag: 2.4 },
    { a: [-11, 9.5, -22], b: [10, 9.4, -22], sag: 1.8 },
    { a: [-12, 6.4, 18], b: [-12, 6.4, 2], sag: 0.9 },
    { a: [10, 9.5, -24], b: [21, 6.7, -10], sag: 2.0 },
    { a: [-35, 6.5, 20], b: [-35, 6.5, 2], sag: 1.0 },
  ],

  drainpipes: [
    { x: -30.7, z: 20.4, h: 6.3 }, { x: -30.7, z: 1.6, h: 6.3 },
    { x: -17.7, z: 18.6, h: 6.3 }, { x: -17.7, z: 1.6, h: 6.3 },
    { x: -7.3,  z: 18.6, h: 6.3 }, { x: -7.3,  z: -17.6, h: 3.1 },
    { x: -10.8, z: -21.7, h: 9.5 }, { x: 6.8, z: -21.7, h: 9.5 },
    { x: 11.7,  z: -12.6, h: 6.3 }, { x: 31.7, z: -26.7, h: 6.3 },
  ],
};
