import { TileType, Tile, Point } from './types';

// 0=buildable, 1=path, S=start, E=end, X=empty/decoration
const MAP_LAYOUT: string[] = [
  'XXXX0000000000000X',
  'S111000000000000XX',
  'X001000000000000XX',
  'X001000000000000XX',
  'X001111111100000XX',
  'X000000000100000XX',
  'X000000000100000XX',
  'X000000000111110EX',
  'X000000000000000XX',
  'X000000000000000XX',
  'X000000000000000XX',
  'XXXXXXXXXXXXXXXXXX',
];

export const COLS = MAP_LAYOUT[0].length;
export const ROWS = MAP_LAYOUT.length;
export const TILE_SIZE = 48;

export function buildGrid(): Tile[][] {
  return MAP_LAYOUT.map((row, r) =>
    row.split('').map((ch, c) => {
      let type: TileType = 'empty';
      if (ch === '1') type = 'path';
      else if (ch === '0') type = 'buildable';
      else if (ch === 'S') type = 'start';
      else if (ch === 'E') type = 'end';
      return { type, row: r, col: c };
    })
  );
}

// Return waypoints (col, row) of the path in order, tracing from S to E
function tracePathWaypoints(): { r: number; c: number }[] {
  const grid = MAP_LAYOUT;
  const rows = grid.length;
  const cols = grid[0].length;

  // Find start
  let sr = -1, sc = -1;
  for (let r = 0; r < rows; r++) {
    for (let c = 0; c < cols; c++) {
      if (grid[r][c] === 'S') { sr = r; sc = c; }
    }
  }

  const visited = Array.from({ length: rows }, () => new Array(cols).fill(false));
  const waypoints: { r: number; c: number }[] = [{ r: sr, c: sc }];
  visited[sr][sc] = true;

  const dirs = [[0, 1], [1, 0], [0, -1], [-1, 0]];
  let current = { r: sr, c: sc };

  // eslint-disable-next-line no-constant-condition
  while (true) {
    const ch = grid[current.r][current.c];
    if (ch === 'E') break;

    let moved = false;
    for (const [dr, dc] of dirs) {
      const nr = current.r + dr;
      const nc = current.c + dc;
      if (nr < 0 || nr >= rows || nc < 0 || nc >= cols) continue;
      if (visited[nr][nc]) continue;
      const nch = grid[nr][nc];
      if (nch === '1' || nch === 'E') {
        visited[nr][nc] = true;
        waypoints.push({ r: nr, c: nc });
        current = { r: nr, c: nc };
        moved = true;
        break;
      }
    }
    if (!moved) break;
  }

  return waypoints;
}

export function buildPath(): Point[] {
  const waypoints = tracePathWaypoints();
  return waypoints.map(({ r, c }) => ({
    x: c * TILE_SIZE + TILE_SIZE / 2,
    y: r * TILE_SIZE + TILE_SIZE / 2,
  }));
}
