import * as THREE from 'three';
import { WorldBuilder, Piece, trs } from './geom/piece.js';
import { chamferBox } from './geom/chamfer.js';
import {
  building, wall, floor, stairs, railing, parapet, pillar, awning, cable,
  curb, skirting, drainpipe, STOREY,
} from './geom/kit.js';
import * as P from './props/props.js';
import { LAYOUT } from './geom/layout.js';

/**
 * HARBOUR — a Mediterranean coastal town block at dusk.
 *
 * Three-lane skeleton (ART_DIRECTION and standard competitive layout):
 *   Lane A (x < -12)  covered market street — tight, close quarters
 *   Lane B (centre)   open plaza — long sightlines, cover every ~6 m
 *   Lane C (x > 12)   harbour front — vertical, containers and a crane
 *
 * The map is declared as data in geom/layout.js and built by the passes below.
 * After the base pass, automated trim/clutter/AO passes run over the result —
 * ART_DIRECTION §6 calls bare wall-floor junctions an instant fail, so that
 * rule is enforced programmatically rather than by hand-placing skirting.
 */

const _m = new THREE.Matrix4();
const _v = new THREE.Vector3();
const _down = new THREE.Vector3(0, -1, 0);

export class Level {
  constructor(ctx) {
    this.ctx = ctx;
    this.progress = 0;
    this.rng = ctx.rand(20260806);
    this.bounds = new THREE.Box3(
      new THREE.Vector3(-48, -2, -46),
      new THREE.Vector3(48, 30, 46)
    );
    this.spawnPoint = new THREE.Vector3(0, 0.1, 33);
    this.spawnPoints = [];
    this.coverPoints = [];
    this.navGrid = null;
    this.group = null;
  }

  async init() {
    const t0 = performance.now();
    const mats = this.ctx.materials;
    const b = new WorldBuilder((name) => mats.get(name), this.rng);
    this.builder = b;

    const yieldTick = async (p) => { this.progress = p; await new Promise((r) => setTimeout(r, 0)); };

    this._ground(b);            await yieldTick(0.1);
    this._buildings(b);         await yieldTick(0.35);
    this._market(b);            await yieldTick(0.5);
    this._plaza(b);             await yieldTick(0.62);
    this._harbour(b);           await yieldTick(0.74);
    this._trimPass(b);          await yieldTick(0.8);
    this._clutterPass(b);       await yieldTick(0.86);
    this._backdrop(b);          await yieldTick(0.9);

    const { group } = b.finish('harbour');
    this.group = group;
    this.ctx.scene.add(group);

    // Collision proxy: plain boxes, invisible, far cheaper than the bevelled art.
    const { group: colGroup, meshes: colMeshes } = b.buildColliders();
    this.ctx.scene.add(colGroup);
    for (const m of colMeshes) this.ctx.physics.addStatic(m);
    this.collisionGroup = colGroup;

    // Build the BVH now: the nav and cover passes below raycast against it.
    this.ctx.physics.build();

    this.ctx.sky?.patchFog?.(this.ctx.scene);

    await yieldTick(0.95);
    this._buildNav(b);
    this._buildCover(b);
    this.progress = 1;

    this.stats = b.stats;
    console.log(
      `[level] ${Math.round(b.stats.tris / 1000)}k tris, ${b.stats.drawCalls} draws, ` +
      `${b.stats.instances} instances, ${b.solids.length} solids, ${Math.round(performance.now() - t0)}ms`
    );
  }

  // -------------------------------------------------------------------------
  //  Terrain
  // -------------------------------------------------------------------------

  _ground(b) {
    // Plaza asphalt, market paving, harbour concrete, and the sea.
    for (const g of LAYOUT.ground) {
      const geo = chamferBox(g.w, 0.4, g.d, { uvScale: g.uv ?? 2, chamfer: 0.05 });
      geo.translate(g.x, (g.y ?? 0) - 0.2, g.z);
      b.push(g.mat, geo);
      b.solid(g.x, (g.y ?? 0) - 0.2, g.z, g.w * 0.5, 0.2, g.d * 0.5, g.mat);
    }

    // Sea: a large flat plane below the quay. Deliberately simple — it is only
    // ever seen at a grazing angle past the sea wall.
    const sea = new THREE.Mesh(
      new THREE.PlaneGeometry(400, 400),
      new THREE.MeshStandardMaterial({
        color: 0x2c4356, roughness: 0.09, metalness: 0.1,
        envMapIntensity: 1.6,
      })
    );
    sea.rotation.x = -Math.PI / 2;
    sea.position.set(60, -2.2, -6);
    sea.receiveShadow = false;
    sea.name = 'sea';
    this.ctx.scene.add(sea);
    this.sea = sea;
  }

  // -------------------------------------------------------------------------
  //  Architecture
  // -------------------------------------------------------------------------

  _buildings(b) {
    const rng = this.rng;
    for (const spec of LAYOUT.buildings) {
      const piece = building({
        w: spec.w, d: spec.d, storeys: spec.storeys,
        matWall: spec.wall || 'plaster',
        matRoof: 'concrete', matTrim: 'concrete',
        interiorFloor: spec.floor || 'tileFloor',
        doors: spec.doors || [], windows: spec.windows || [],
        rng,
      });
      _m.makeRotationY(spec.ry || 0);
      _m.setPosition(spec.x, spec.y || 0, spec.z);
      b.place(piece, _m);

      // Exterior stair to the roof, where the layout asks for one.
      if (spec.roofStair) {
        const st = new Piece();
        const flights = spec.storeys;
        for (let f = 0; f < flights; f++) {
          stairs(st, 'concrete', {
            x: 0, y: f * STOREY, z: -f * 2.9, steps: 19, width: 1.5,
            rise: STOREY / 19, run: 0.28,
          });
          railing(st, 'gunmetal', { x: -0.82, y: f * STOREY + 1.2, z: -f * 2.9 - 2.6, len: 5.3, ry: Math.PI / 2 });
        }
        const s = spec.roofStair;
        _m.makeRotationY(s.ry || 0);
        _m.setPosition(s.x, 0, s.z);
        b.place(st, _m);
      }

      // Balconies overlooking the plaza.
      for (const bal of spec.balconies || []) {
        const bp = new Piece();
        floor(bp, 'concrete', { x: 0, y: 0, z: 0, w: bal.w, d: 1.5, thick: 0.2, uvScale: 1.5 });
        railing(bp, 'gunmetal', { x: 0, y: 0, z: 0.72, len: bal.w });
        railing(bp, 'gunmetal', { x: -bal.w * 0.5, y: 0, z: 0, len: 1.5, ry: Math.PI / 2 });
        railing(bp, 'gunmetal', { x: bal.w * 0.5, y: 0, z: 0, len: 1.5, ry: Math.PI / 2 });
        _m.makeRotationY(bal.ry || 0);
        _m.setPosition(bal.x, bal.y, bal.z);
        b.place(bp, _m);
      }
    }
  }

  _market(b) {
    const rng = this.rng;
    const r = (a, c) => a + rng() * (c - a);

    for (const s of LAYOUT.stalls) {
      b.instance('stall', () => P.marketStall(rng), trs(s.x, 0, s.z, s.ry ?? r(-0.2, 0.2)), { tint: 0.1 });
    }
    // Hanging cloth strung across the lane — the signature market read.
    for (let i = 0; i < 9; i++) {
      const z = 16 - i * 4.2;
      const p = new Piece();
      P.laundry(rng, 6.5).parts.forEach((pt) => p.add(pt.mat, pt.geo, true));
      _m.makeRotationY(r(-0.1, 0.1));
      _m.setPosition(-24 + r(-1.2, 1.2), 4.6, z);
      b.place(p, _m, { collide: false, decor: true });
      cable(p, 'gunmetal', new THREE.Vector3(-31, 5.0, z), new THREE.Vector3(-17, 4.8, z), { sag: 0.55 });
    }
    for (const a of LAYOUT.awnings) {
      const p = new Piece();
      awning(p, 'canvasTarp', 'gunmetal', { x: 0, y: 0, z: 0, w: a.w ?? 3.4, depth: 1.5, ry: 0, rng });
      _m.makeRotationY(a.ry || 0);
      _m.setPosition(a.x, a.y ?? 2.8, a.z);
      b.place(p, _m, { collide: false, decor: true });
    }
  }

  _plaza(b) {
    const rng = this.rng;
    const r = (a, c) => a + rng() * (c - a);

    // Dry fountain at the plaza centre — the focal point of the long sightline.
    const f = new Piece();
    const basinR = 3.1;
    for (let i = 0; i < 16; i++) {
      const a0 = (i / 16) * Math.PI * 2;
      const seg = chamferBox(1.24, 0.62, 0.42, { uvScale: 0.8, chamfer: 0.035, ao: 0.3 });
      seg.rotateY(-a0);
      seg.translate(Math.cos(a0) * basinR, 0.31, Math.sin(a0) * basinR);
      f.add('concrete', seg);
      f.solid(Math.cos(a0) * basinR, 0.31, Math.sin(a0) * basinR, 0.62, 0.31, 0.24, 'concrete', -a0);
    }
    floor(f, 'tileFloor', { x: 0, y: 0.06, z: 0, w: basinR * 1.85, d: basinR * 1.85, thick: 0.1, uvScale: 1.2 });
    pillar(f, 'concrete', { x: 0, y: 0.06, z: 0, height: 1.5, r: 0.34, round: true });
    const bowl = chamferBox(1.7, 0.24, 1.7, { uvScale: 0.6, chamfer: 0.06 });
    bowl.translate(0, 1.7, 0);
    f.add('concrete', bowl);
    f.solid(0, 1.7, 0, 0.85, 0.12, 0.85, 'concrete');
    _m.identity(); _m.setPosition(LAYOUT.fountain.x, 0, LAYOUT.fountain.z);
    b.place(f, _m);

    for (const c of LAYOUT.cover) {
      const t = c.type;
      if (t === 'sandbag') {
        b.instance('sandbagWall', () => P.sandbagWall(rng, 2.6), trs(c.x, 0, c.z, c.ry || 0), { tint: 0.08 });
      } else if (t === 'jersey') {
        b.instance('jersey', () => P.jerseyBarrier(), trs(c.x, 0, c.z, c.ry || 0), { tint: 0.07 });
      } else if (t === 'crate') {
        const n = c.n ?? 2;
        for (let i = 0; i < n; i++) {
          b.instance('crate', () => P.crate(rng),
            trs(c.x + r(-0.35, 0.35), i * 0.8, c.z + r(-0.35, 0.35), r(0, 6.28)), { tint: 0.1 });
        }
      } else if (t === 'barrel') {
        b.instance('barrel', () => P.barrel(rng), trs(c.x, 0, c.z, r(0, 6.28)), { tint: 0.12 });
      } else if (t === 'planter') {
        b.instance('planter', () => P.planter(rng), trs(c.x, 0, c.z, r(0, 6.28)), { tint: 0.09 });
      } else if (t === 'car') {
        b.instance('car', () => P.burntCar(rng), trs(c.x, 0, c.z, c.ry || 0), { tint: 0.11 });
      } else if (t === 'tyres') {
        b.instance('tyres', () => P.tyreStack(rng, 3), trs(c.x, 0, c.z, r(0, 6.28)), { tint: 0.1 });
      } else if (t === 'pallet') {
        b.instance('pallet', () => P.pallet(), trs(c.x, 0, c.z, r(0, 6.28)), { tint: 0.1 });
      } else if (t === 'palm') {
        b.instance('palm', () => P.palm(rng), trs(c.x, 0, c.z, r(0, 6.28)), { tint: 0.12 });
      } else if (t === 'cafe') {
        b.instance('cafe', () => P.cafeSet(rng), trs(c.x, 0, c.z, r(0, 6.28)), { tint: 0.08 });
      } else if (t === 'shelf') {
        b.instance('shelf', () => P.shelf(rng), trs(c.x, 0, c.z, c.ry || 0), { tint: 0.08 });
      }
    }

    for (const l of LAYOUT.streetlights) {
      b.instance('lamp', () => P.streetlight(), trs(l.x, 0, l.z, l.ry || 0), { tint: 0.05 });
    }
  }

  _harbour(b) {
    const rng = this.rng;
    const r = (a, c) => a + rng() * (c - a);

    // Sea wall along the quay edge.
    const sw = new Piece();
    for (let i = 0; i < 22; i++) {
      const z = -34 + i * 3.2;
      const blk = chamferBox(1.1, 1.15, 3.18, { uvScale: 1.2, chamfer: 0.045, ao: 0.25 });
      blk.translate(0, 0.575, z);
      sw.add('concrete', blk);
      sw.solid(0, 0.575, z, 0.55, 0.575, 1.59, 'concrete');
      if (i % 4 === 1) {
        const bollard = chamferBox(0.26, 0.5, 0.26, { uvScale: 0.3, chamfer: 0.05 });
        bollard.translate(-0.75, 1.4, z);
        sw.add('rustMetal', bollard, true);
        sw.solid(-0.75, 1.4, z, 0.14, 0.25, 0.14, 'rustMetal');
      }
    }
    _m.identity(); _m.setPosition(LAYOUT.harbour.seaWallX, 0, 0);
    b.place(sw, _m);

    for (const c of LAYOUT.containers) {
      b.instance('container', () => P.container(rng), trs(c.x, c.y || 0, c.z, c.ry || 0), { tint: 0.14 });
    }
    _m.makeRotationY(LAYOUT.harbour.crane.ry || 0);
    _m.setPosition(LAYOUT.harbour.crane.x, 0, LAYOUT.harbour.crane.z);
    b.place(P.crane(), _m);

    _m.makeRotationY(LAYOUT.harbour.boat.ry || 0);
    _m.setPosition(LAYOUT.harbour.boat.x, LAYOUT.harbour.boat.y ?? -1.1, LAYOUT.harbour.boat.z);
    b.place(P.fishingBoat(rng), _m);

    // Warehouse catwalk ring inside the big shed.
    const wh = LAYOUT.harbour.warehouse;
    if (wh) {
      const cw = new Piece();
      for (const s of [[0, -wh.d * 0.5 + 1.0, 0, wh.w - 2], [0, wh.d * 0.5 - 1.0, 0, wh.w - 2]]) {
        const g = P.catwalk(s[3]);
        _m.makeRotationY(s[2]); _m.setPosition(s[0], wh.deckY, s[1]);
        cw.stamp(g, _m);
      }
      const side = P.catwalk(wh.d - 2);
      _m.makeRotationY(Math.PI / 2); _m.setPosition(-wh.w * 0.5 + 1.0, wh.deckY, 0);
      cw.stamp(side, _m);
      _m.identity(); _m.setPosition(wh.x, 0, wh.z);
      b.place(cw, _m);

      const st = new Piece();
      stairs(st, 'metalPanel', {
        x: 0, y: 0, z: 0, steps: Math.round(wh.deckY / 0.17), width: 1.3,
        rise: 0.17, run: 0.28, ry: Math.PI,
      });
      _m.makeRotationY(wh.stairRy || 0);
      _m.setPosition(wh.x + (wh.stairX ?? 0), 0, wh.z + (wh.stairZ ?? 0));
      b.place(st, _m);
    }
  }

  // -------------------------------------------------------------------------
  //  Automated passes
  // -------------------------------------------------------------------------

  /**
   * Trim pass. Walks every collision solid that reaches the ground and lays a
   * kerb/skirting strip along its longest horizontal face. This is what stops
   * the map reading as untextured boxes meeting an untextured floor.
   */
  _trimPass(b) {
    const trim = new Piece();
    let n = 0;
    for (const s of b.solids.slice()) {
      const [cx, cy, cz] = s.c;
      const [hx, hy, hz] = s.h;
      const base = cy - hy;
      if (base < -0.05 || base > 0.25) continue;       // only ground-meeting walls
      if (hy < 0.9) continue;                          // not low cover
      if (hx < 0.4 && hz < 0.4) continue;              // not a post
      const alongX = hx >= hz;
      const len = (alongX ? hx : hz) * 2;
      if (len < 1.2) continue;
      for (const sgn of [-1, 1]) {
        skirting(trim, 'concrete', {
          x: cx + (alongX ? 0 : sgn * (hx + 0.06)),
          y: base,
          z: cz + (alongX ? sgn * (hz + 0.06) : 0),
          len, height: 0.16, depth: 0.13,
          ry: (alongX ? 0 : Math.PI / 2) + s.ry,
        });
        n++;
      }
      if (n > 260) break;                              // hard budget
    }
    b.place(trim, null, { collide: false, decor: true });

    // Street kerbs along the declared lane edges.
    const kerbs = new Piece();
    for (const k of LAYOUT.kerbs) {
      curb(kerbs, 'concrete', { x: k.x, y: 0, z: k.z, len: k.len, ry: k.ry || 0 });
    }
    b.place(kerbs, null);
  }

  /**
   * Clutter pass: rubble at wall bases and debris scatter. Ankle-height, no
   * collision, purely to break up the floor-meets-wall line.
   */
  _clutterPass(b) {
    const rng = this.rng;
    let placed = 0;
    for (const s of b.solids.slice()) {
      if (placed > 90) break;
      const [cx, cy, cz] = s.c;
      const [hx, hy, hz] = s.h;
      if (cy - hy > 0.25 || hy < 1.2) continue;
      if (rng() > 0.34) continue;
      const alongX = hx >= hz;
      const t = (rng() - 0.5) * 2;
      const px = cx + (alongX ? t * hx : Math.sign(t) * (hx + 0.5));
      const pz = cz + (alongX ? Math.sign(t) * (hz + 0.5) : t * hz);
      if (Math.abs(px) > 46 || Math.abs(pz) > 44) continue;
      b.instance('rubble', () => P.rubble(rng, 1), trs(px, 0, pz, rng() * 6.28), { collide: false, decor: true, tint: 0.12 });
      placed++;
    }

    // Rooftop dressing: AC units, dishes, and cables strung between roofs.
    for (const rf of LAYOUT.roofProps) {
      if (rf.type === 'ac') b.instance('ac', () => P.acUnit(rng), trs(rf.x, rf.y, rf.z, rf.ry || 0), { tint: 0.08 });
      else if (rf.type === 'dish') b.instance('dish', () => P.satDish(rng), trs(rf.x, rf.y, rf.z, rf.ry || 0), { tint: 0.06 });
    }
    const cables = new Piece();
    for (const c of LAYOUT.cables) {
      cable(cables, 'gunmetal',
        new THREE.Vector3(c.a[0], c.a[1], c.a[2]),
        new THREE.Vector3(c.b[0], c.b[1], c.b[2]),
        { sag: c.sag ?? 0.9, radius: 0.022 });
    }
    b.place(cables, null, { collide: false, decor: true });

    // Drainpipes down facades.
    const pipes = new Piece();
    for (const d of LAYOUT.drainpipes) {
      drainpipe(pipes, 'rustMetal', { x: d.x, y: 0, z: d.z, height: d.h ?? 6.4 });
    }
    b.place(pipes, null);
  }

  /** Distant town silhouette and headland so the horizon is never bare sky. */
  _backdrop(b) {
    const rng = this.rng;
    const bd = new Piece();
    for (let i = 0; i < 46; i++) {
      const a = (i / 46) * Math.PI * 2;
      const dist = 150 + rng() * 130;
      const x = Math.cos(a) * dist, z = Math.sin(a) * dist;
      if (x > 70 && Math.abs(z) < 120) continue;      // keep the sea open
      const h = 6 + rng() * 26;
      const g = chamferBox(10 + rng() * 26, h, 10 + rng() * 22, { uvScale: 8, chamfer: 0.4 });
      g.rotateY(rng() * 3);
      g.translate(x, h * 0.5 - 4, z);
      bd.add('plaster', g);
    }
    // Headland across the water.
    for (let i = 0; i < 7; i++) {
      const h = 22 + rng() * 34;
      const g = chamferBox(70 + rng() * 60, h, 40, { uvScale: 12, chamfer: 1 });
      g.translate(200 + i * 40, h * 0.4 - 10, -180 + i * 66);
      bd.add('sand', g);
    }
    b.place(bd, null, { collide: false, decor: true });
  }

  // -------------------------------------------------------------------------
  //  Navigation and cover data (consumed by the AI)
  // -------------------------------------------------------------------------

  _buildNav(b) {
    const cell = 0.75;
    const min = LAYOUT.nav.min, max = LAYOUT.nav.max;
    const nx = Math.ceil((max[0] - min[0]) / cell);
    const nz = Math.ceil((max[1] - min[1]) / cell);
    const walk = new Uint8Array(nx * nz);
    const height = new Float32Array(nx * nz);
    const phys = this.ctx.physics;

    for (let j = 0; j < nz; j++) {
      for (let i = 0; i < nx; i++) {
        const x = min[0] + (i + 0.5) * cell;
        const z = min[1] + (j + 0.5) * cell;
        _v.set(x, 22, z);
        const hit = phys.raycast(_v, _down, 40, { skipEnemies: true });
        if (!hit) continue;
        const y = hit.point.y;
        if (y < -1.5 || y > 3.0) continue;             // ground floor only
        if (hit.normal.y < 0.7) continue;              // too steep
        // Headroom: a soldier needs ~1.9 m of clear space.
        _v.set(x, y + 0.15, z);
        const up = phys.raycast(_v, new THREE.Vector3(0, 1, 0), 1.9, { skipEnemies: true });
        if (up) continue;
        walk[j * nx + i] = 1;
        height[j * nx + i] = y;
      }
    }

    this.navGrid = {
      nx, nz, cell, min, walk, height,
      worldToCell(x, z, out) {
        out = out || {};
        out.i = Math.floor((x - min[0]) / cell);
        out.j = Math.floor((z - min[1]) / cell);
        return out;
      },
      cellToWorld(i, j, out) {
        out = out || new THREE.Vector3();
        out.set(min[0] + (i + 0.5) * cell, height[j * nx + i] || 0, min[1] + (j + 0.5) * cell);
        return out;
      },
      walkable(i, j) {
        return i >= 0 && j >= 0 && i < nx && j < nz && walk[j * nx + i] === 1;
      },
    };

    let count = 0;
    for (let k = 0; k < walk.length; k++) count += walk[k];
    console.log(`[level] nav ${nx}x${nz}, ${count} walkable cells`);

    // Enemy spawn points: walkable cells far from the player spawn, spread out.
    const cand = [];
    for (let j = 0; j < nz; j += 3) {
      for (let i = 0; i < nx; i += 3) {
        if (!walk[j * nx + i]) continue;
        const x = min[0] + (i + 0.5) * cell, z = min[1] + (j + 0.5) * cell;
        const d = Math.hypot(x - this.spawnPoint.x, z - this.spawnPoint.z);
        if (d < 18) continue;
        cand.push(new THREE.Vector3(x, height[j * nx + i] + 0.05, z));
      }
    }
    // Thin them so spawns are never on top of each other.
    this.spawnPoints = [];
    for (const c of cand) {
      let ok = true;
      for (const s of this.spawnPoints) if (s.distanceToSquared(c) < 36) { ok = false; break; }
      if (ok) this.spawnPoints.push(c);
    }
    console.log(`[level] ${this.spawnPoints.length} enemy spawn points`);
  }

  /**
   * Cover points: sample around every waist-to-chest-height solid, keeping the
   * spots that actually have the obstacle between them and the open map.
   */
  _buildCover(b) {
    const out = [];
    for (const s of b.solids) {
      const [cx, cy, cz] = s.c;
      const [hx, hy, hz] = s.h;
      const top = cy + hy;
      if (top < 0.7 || top > 2.4) continue;            // usable cover height only
      if (hx < 0.3 && hz < 0.3) continue;
      const along = hx >= hz ? 'x' : 'z';
      const half = along === 'x' ? hx : hz;
      const off = (along === 'x' ? hz : hx) + 0.55;
      const n = Math.max(1, Math.floor(half / 0.9));
      for (let i = 0; i < n; i++) {
        const t = n === 1 ? 0 : (i / (n - 1) - 0.5) * 2 * (half - 0.3);
        for (const sgn of [-1, 1]) {
          const px = cx + (along === 'x' ? t : sgn * off);
          const pz = cz + (along === 'x' ? sgn * off : t);
          if (!this._isWalkable(px, pz)) continue;
          out.push({
            pos: new THREE.Vector3(px, cy - hy, pz),
            normal: new THREE.Vector3(along === 'x' ? 0 : sgn, 0, along === 'x' ? sgn : 0),
            height: top,
            claimedBy: null,
          });
        }
      }
      if (out.length > 400) break;
    }
    this.coverPoints = out;
    console.log(`[level] ${out.length} cover points`);
  }

  _isWalkable(x, z) {
    const g = this.navGrid;
    if (!g) return true;
    const i = Math.floor((x - g.min[0]) / g.cell);
    const j = Math.floor((z - g.min[1]) / g.cell);
    return g.walkable(i, j);
  }

  update() { /* the level is static */ }
}
