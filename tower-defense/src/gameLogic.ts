import { Enemy, Tower, Projectile, Point, GameState } from './types';
import { TILE_SIZE } from './mapData';

let nextId = 1;
const getId = () => nextId++;

export const TOWER_COST = 50;
export const TOWER_SELL_VALUE = 25;

export function createEnemy(path: Point[], wave: number): Enemy {
  const hp = 60 + wave * 30;
  return {
    id: getId(),
    x: path[0].x,
    y: path[0].y,
    hp,
    maxHp: hp,
    speed: 60 + wave * 5, // px/sec
    pathIndex: 0,
    progress: 0,
    reward: 10 + wave * 2,
    radius: 10,
    color: `hsl(${(wave * 47) % 360}, 80%, 55%)`,
    dead: false,
    reachedEnd: false,
  };
}

export function createTower(row: number, col: number): Tower {
  return {
    id: getId(),
    row,
    col,
    x: col * TILE_SIZE + TILE_SIZE / 2,
    y: row * TILE_SIZE + TILE_SIZE / 2,
    range: 120,
    damage: 20,
    fireRate: 1.5,
    lastShot: 0,
    color: '#4ade80',
    label: 'B',
  };
}

function dist(ax: number, ay: number, bx: number, by: number) {
  const dx = ax - bx, dy = ay - by;
  return Math.sqrt(dx * dx + dy * dy);
}

function moveEnemies(enemies: Enemy[], path: Point[], dt: number): void {
  for (const e of enemies) {
    if (e.dead || e.reachedEnd) continue;
    let remaining = e.speed * dt;
    while (remaining > 0 && e.pathIndex < path.length - 1) {
      const from = path[e.pathIndex];
      const to = path[e.pathIndex + 1];
      const segLen = dist(from.x, from.y, to.x, to.y);
      const alreadyTraveled = e.progress * segLen;
      const canTravel = Math.min(remaining, segLen - alreadyTraveled);
      e.progress += canTravel / segLen;
      remaining -= canTravel;
      if (e.progress >= 1) {
        e.pathIndex++;
        e.progress = 0;
        if (e.pathIndex >= path.length - 1) {
          e.reachedEnd = true;
          e.x = path[path.length - 1].x;
          e.y = path[path.length - 1].y;
          break;
        }
      }
    }
    if (!e.reachedEnd) {
      const from = path[e.pathIndex];
      const to = path[Math.min(e.pathIndex + 1, path.length - 1)];
      e.x = from.x + (to.x - from.x) * e.progress;
      e.y = from.y + (to.y - from.y) * e.progress;
    }
  }
}

function towersShoot(
  towers: Tower[],
  enemies: Enemy[],
  projectiles: Projectile[],
  now: number
): void {
  for (const tower of towers) {
    const cooldown = 1000 / tower.fireRate;
    if (now - tower.lastShot < cooldown) continue;

    // find nearest live enemy in range
    let nearest: Enemy | null = null;
    let nearestDist = Infinity;
    for (const e of enemies) {
      if (e.dead || e.reachedEnd) continue;
      const d = dist(tower.x, tower.y, e.x, e.y);
      if (d <= tower.range && d < nearestDist) {
        nearest = e;
        nearestDist = d;
      }
    }
    if (nearest) {
      tower.lastShot = now;
      projectiles.push({
        id: getId(),
        x: tower.x,
        y: tower.y,
        targetId: nearest.id,
        speed: 280,
        damage: tower.damage,
        color: '#facc15',
        dead: false,
      });
    }
  }
}

function moveProjectiles(
  projectiles: Projectile[],
  enemies: Enemy[],
  dt: number
): number {
  let goldEarned = 0;
  const enemyMap = new Map<number, Enemy>(enemies.map(e => [e.id, e]));

  for (const p of projectiles) {
    if (p.dead) continue;
    const target = enemyMap.get(p.targetId);
    if (!target || target.dead || target.reachedEnd) {
      p.dead = true;
      continue;
    }
    const d = dist(p.x, p.y, target.x, target.y);
    const step = p.speed * dt;
    if (d <= step) {
      // hit
      target.hp -= p.damage;
      p.dead = true;
      if (target.hp <= 0) {
        target.dead = true;
        goldEarned += target.reward;
      }
    } else {
      p.x += ((target.x - p.x) / d) * step;
      p.y += ((target.y - p.y) / d) * step;
    }
  }
  return goldEarned;
}

export function tickGame(state: GameState, dt: number, now: number): Partial<GameState> {
  if (state.gameOver || !state.waveActive) return {};

  // Clone mutable arrays
  const enemies = state.enemies.map(e => ({ ...e }));
  const towers = state.towers.map(t => ({ ...t }));
  const projectiles = state.projectiles.map(p => ({ ...p }));

  moveEnemies(enemies, state.path, dt);
  towersShoot(towers, enemies, projectiles, now);
  const goldEarned = moveProjectiles(projectiles, enemies, dt);

  // Check enemies that reached end
  let livesLost = 0;
  for (const e of enemies) {
    if (e.reachedEnd && !e.dead) {
      e.dead = true; // remove from field
      livesLost++;
    }
  }

  const lives = Math.max(0, state.lives - livesLost);
  const gold = state.gold + goldEarned;
  const score = state.score + goldEarned;

  const liveEnemies = enemies.filter(e => !e.dead);
  const waveActive = liveEnemies.length > 0;

  const gameOver = lives <= 0;

  return {
    enemies: enemies.filter(e => !e.dead),
    towers,
    projectiles: projectiles.filter(p => !p.dead),
    gold,
    lives,
    score,
    waveActive,
    gameOver,
  };
}

export function spawnWave(wave: number, path: Point[]): Enemy[] {
  const count = 8 + wave * 4;
  const enemies: Enemy[] = [];
  for (let i = 0; i < count; i++) {
    const e = createEnemy(path, wave);
    // Stagger spawn positions so they don't all start at same point
    // We'll handle staggered timing in the spawner component
    e.id = getId();
    enemies.push(e);
  }
  return enemies;
}
