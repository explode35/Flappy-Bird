export type TileType = 'path' | 'buildable' | 'empty' | 'start' | 'end';

export interface Tile {
  type: TileType;
  row: number;
  col: number;
}

export interface Point {
  x: number;
  y: number;
}

export interface Enemy {
  id: number;
  x: number;
  y: number;
  hp: number;
  maxHp: number;
  speed: number;
  pathIndex: number;
  progress: number; // 0..1 between current and next waypoint
  reward: number;
  radius: number;
  color: string;
  dead: boolean;
  reachedEnd: boolean;
}

export interface Tower {
  id: number;
  row: number;
  col: number;
  x: number;
  y: number;
  range: number;
  damage: number;
  fireRate: number; // shots per second
  lastShot: number; // timestamp ms
  color: string;
  label: string;
}

export interface Projectile {
  id: number;
  x: number;
  y: number;
  targetId: number;
  speed: number;
  damage: number;
  color: string;
  dead: boolean;
}

export interface GameState {
  grid: Tile[][];
  path: Point[];       // world coords of each waypoint center
  enemies: Enemy[];
  towers: Tower[];
  projectiles: Projectile[];
  gold: number;
  lives: number;
  wave: number;
  waveActive: boolean;
  score: number;
  gameOver: boolean;
  placingTower: boolean;
}
