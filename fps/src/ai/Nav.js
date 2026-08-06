import * as THREE from 'three';

/**
 * A* over the level's walkability grid, with string-pulling.
 *
 * The raw grid path is a staircase of 0.75 m steps; walking it directly looks
 * like a Roomba. Shortcutting the waypoints against grid visibility turns it
 * back into the straight lines a person would actually walk.
 */

const NEIGHBOURS = [
  [1, 0, 1], [-1, 0, 1], [0, 1, 1], [0, -1, 1],
  [1, 1, 1.4142], [1, -1, 1.4142], [-1, 1, 1.4142], [-1, -1, 1.4142],
];

// Reused across calls: pathfinding runs often enough that per-call allocation
// of these would be a real cost.
let _g = null, _f = null, _from = null, _open = null, _closed = null, _cap = 0;

function ensure(n) {
  if (_cap >= n) return;
  _cap = n;
  _g = new Float32Array(n);
  _f = new Float32Array(n);
  _from = new Int32Array(n);
  _closed = new Uint8Array(n);
  _open = new Int32Array(n);
}

/** Bresenham-ish walkability check between two cells. */
function gridVisible(grid, i0, j0, i1, j1) {
  let di = Math.abs(i1 - i0), dj = Math.abs(j1 - j0);
  let si = i0 < i1 ? 1 : -1, sj = j0 < j1 ? 1 : -1;
  let err = di - dj;
  let i = i0, j = j0;
  let guard = 0;
  while (guard++ < 4096) {
    if (!grid.walkable(i, j)) return false;
    if (i === i1 && j === j1) return true;
    const e2 = 2 * err;
    if (e2 > -dj) { err -= dj; i += si; }
    if (e2 < di) { err += di; j += sj; }
  }
  return false;
}

/** Nearest walkable cell to (i, j) within `r` rings — spawns drift sometimes. */
function snap(grid, i, j, r = 4) {
  if (grid.walkable(i, j)) return [i, j];
  for (let ring = 1; ring <= r; ring++) {
    for (let di = -ring; di <= ring; di++) {
      for (let dj = -ring; dj <= ring; dj++) {
        if (Math.abs(di) !== ring && Math.abs(dj) !== ring) continue;
        if (grid.walkable(i + di, j + dj)) return [i + di, j + dj];
      }
    }
  }
  return null;
}

/**
 * @returns {THREE.Vector3[]|null} smoothed waypoints, or null if unreachable.
 */
export function findPath(grid, fromVec, toVec, maxNodes = 2600) {
  const { nx, nz, cell, min } = grid;
  const n = nx * nz;
  ensure(n);

  const c0 = snap(grid, Math.floor((fromVec.x - min[0]) / cell), Math.floor((fromVec.z - min[1]) / cell));
  const c1 = snap(grid, Math.floor((toVec.x - min[0]) / cell), Math.floor((toVec.z - min[1]) / cell), 6);
  if (!c0 || !c1) return null;
  const start = c0[1] * nx + c0[0];
  const goal = c1[1] * nx + c1[0];
  if (start === goal) return [toVec.clone()];

  _g.fill(Infinity, 0, n);
  _closed.fill(0, 0, n);
  _from.fill(-1, 0, n);

  const h = (idx) => {
    const i = idx % nx, j = (idx / nx) | 0;
    return Math.hypot(i - c1[0], j - c1[1]);
  };

  let openLen = 0;
  _g[start] = 0;
  _f[start] = h(start);
  _open[openLen++] = start;

  let expanded = 0;
  while (openLen > 0 && expanded++ < maxNodes) {
    // Linear scan for the best node. The open set stays small on a grid this
    // size, and a linear scan beats heap bookkeeping here.
    let bi = 0;
    for (let k = 1; k < openLen; k++) if (_f[_open[k]] < _f[_open[bi]]) bi = k;
    const cur = _open[bi];
    _open[bi] = _open[--openLen];

    if (cur === goal) return rebuild(grid, _from, start, goal, toVec);
    _closed[cur] = 1;

    const ci = cur % nx, cj = (cur / nx) | 0;
    for (const [di, dj, w] of NEIGHBOURS) {
      const ni = ci + di, nj = cj + dj;
      if (!grid.walkable(ni, nj)) continue;
      // Do not cut diagonally through a corner gap.
      if (di && dj && (!grid.walkable(ci + di, cj) || !grid.walkable(ci, cj + dj))) continue;
      const idx = nj * nx + ni;
      if (_closed[idx]) continue;
      const tentative = _g[cur] + w;
      if (tentative >= _g[idx]) continue;
      _g[idx] = tentative;
      _f[idx] = tentative + h(idx) * 1.05;   // slight weighting: faster, still good
      _from[idx] = cur;
      let inOpen = false;
      for (let k = 0; k < openLen; k++) if (_open[k] === idx) { inOpen = true; break; }
      if (!inOpen && openLen < _open.length) _open[openLen++] = idx;
    }
  }
  return null;
}

function rebuild(grid, from, start, goal, toVec) {
  const { nx, cell, min } = grid;
  const cells = [];
  let cur = goal;
  let guard = 0;
  while (cur !== -1 && guard++ < 8192) {
    cells.push(cur);
    if (cur === start) break;
    cur = from[cur];
  }
  cells.reverse();

  // String-pull: keep a waypoint only when the line to the next one is blocked.
  const out = [];
  let anchor = 0;
  for (let i = 2; i < cells.length; i++) {
    const a = cells[anchor], b = cells[i];
    if (!gridVisible(grid, a % nx, (a / nx) | 0, b % nx, (b / nx) | 0)) {
      const k = cells[i - 1];
      out.push(cellVec(grid, k));
      anchor = i - 1;
    }
  }
  out.push(toVec.clone());
  return out;
}

function cellVec(grid, idx) {
  const i = idx % grid.nx, j = (idx / grid.nx) | 0;
  return grid.cellToWorld(i, j, new THREE.Vector3());
}
