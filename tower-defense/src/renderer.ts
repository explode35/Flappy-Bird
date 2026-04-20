import { GameState, Tile, Enemy, Tower, Projectile, Point } from './types';
import { TILE_SIZE } from './mapData';

const TILE_COLORS: Record<string, string> = {
  path: '#8B7355',
  buildable: '#2d5016',
  empty: '#1a1a2e',
  start: '#10b981',
  end: '#ef4444',
};

function drawGrid(ctx: CanvasRenderingContext2D, grid: Tile[][], hoveredTile: { r: number; c: number } | null, placingTower: boolean) {
  for (const row of grid) {
    for (const tile of row) {
      const x = tile.col * TILE_SIZE;
      const y = tile.row * TILE_SIZE;
      ctx.fillStyle = TILE_COLORS[tile.type] ?? '#1a1a2e';
      ctx.fillRect(x, y, TILE_SIZE, TILE_SIZE);

      // grid lines
      ctx.strokeStyle = 'rgba(255,255,255,0.05)';
      ctx.strokeRect(x, y, TILE_SIZE, TILE_SIZE);

      // hover highlight for buildable
      if (
        placingTower &&
        tile.type === 'buildable' &&
        hoveredTile &&
        hoveredTile.r === tile.row &&
        hoveredTile.c === tile.col
      ) {
        ctx.fillStyle = 'rgba(74, 222, 128, 0.4)';
        ctx.fillRect(x, y, TILE_SIZE, TILE_SIZE);
      }
    }
  }
}

function drawPath(ctx: CanvasRenderingContext2D, path: Point[]) {
  if (path.length < 2) return;
  ctx.beginPath();
  ctx.moveTo(path[0].x, path[0].y);
  for (let i = 1; i < path.length; i++) ctx.lineTo(path[i].x, path[i].y);
  ctx.strokeStyle = 'rgba(255,255,255,0.1)';
  ctx.lineWidth = 2;
  ctx.stroke();
}

function drawEnemies(ctx: CanvasRenderingContext2D, enemies: Enemy[]) {
  for (const e of enemies) {
    // shadow
    ctx.save();
    ctx.shadowColor = e.color;
    ctx.shadowBlur = 8;
    ctx.beginPath();
    ctx.arc(e.x, e.y, e.radius, 0, Math.PI * 2);
    ctx.fillStyle = e.color;
    ctx.fill();
    ctx.restore();

    // HP bar
    const barW = e.radius * 2.5;
    const barH = 4;
    const bx = e.x - barW / 2;
    const by = e.y - e.radius - 8;
    ctx.fillStyle = '#333';
    ctx.fillRect(bx, by, barW, barH);
    ctx.fillStyle = e.hp / e.maxHp > 0.5 ? '#4ade80' : e.hp / e.maxHp > 0.25 ? '#facc15' : '#ef4444';
    ctx.fillRect(bx, by, barW * (e.hp / e.maxHp), barH);
  }
}

function drawTowers(ctx: CanvasRenderingContext2D, towers: Tower[], selectedTowerId: number | null) {
  for (const t of towers) {
    const x = t.col * TILE_SIZE;
    const y = t.row * TILE_SIZE;
    const pad = 6;

    ctx.save();
    ctx.shadowColor = t.color;
    ctx.shadowBlur = 10;
    ctx.fillStyle = '#1e3a2f';
    ctx.fillRect(x + pad, y + pad, TILE_SIZE - pad * 2, TILE_SIZE - pad * 2);
    ctx.strokeStyle = t.color;
    ctx.lineWidth = 2;
    ctx.strokeRect(x + pad, y + pad, TILE_SIZE - pad * 2, TILE_SIZE - pad * 2);
    ctx.restore();

    ctx.fillStyle = t.color;
    ctx.font = 'bold 18px system-ui';
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.fillText(t.label, t.x, t.y);

    // show range when selected or hovered
    if (selectedTowerId === t.id) {
      ctx.beginPath();
      ctx.arc(t.x, t.y, t.range, 0, Math.PI * 2);
      ctx.strokeStyle = 'rgba(74, 222, 128, 0.3)';
      ctx.lineWidth = 1;
      ctx.setLineDash([4, 4]);
      ctx.stroke();
      ctx.setLineDash([]);
    }
  }
}

function drawProjectiles(ctx: CanvasRenderingContext2D, projectiles: Projectile[]) {
  for (const p of projectiles) {
    ctx.beginPath();
    ctx.arc(p.x, p.y, 4, 0, Math.PI * 2);
    ctx.fillStyle = p.color;
    ctx.fill();
    ctx.shadowColor = p.color;
    ctx.shadowBlur = 6;
  }
}

export function renderFrame(
  ctx: CanvasRenderingContext2D,
  state: GameState,
  hoveredTile: { r: number; c: number } | null,
  selectedTowerId: number | null
) {
  const canvas = ctx.canvas;
  ctx.clearRect(0, 0, canvas.width, canvas.height);
  drawGrid(ctx, state.grid, hoveredTile, state.placingTower);
  drawPath(ctx, state.path);
  drawTowers(ctx, state.towers, selectedTowerId);
  drawProjectiles(ctx, state.projectiles);
  drawEnemies(ctx, state.enemies);

  // Game Over overlay
  if (state.gameOver) {
    ctx.fillStyle = 'rgba(0,0,0,0.65)';
    ctx.fillRect(0, 0, canvas.width, canvas.height);
    ctx.fillStyle = '#ef4444';
    ctx.font = 'bold 48px system-ui';
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.fillText('GAME OVER', canvas.width / 2, canvas.height / 2 - 24);
    ctx.fillStyle = '#ccc';
    ctx.font = '24px system-ui';
    ctx.fillText(`Score: ${state.score}`, canvas.width / 2, canvas.height / 2 + 24);
  }
}
