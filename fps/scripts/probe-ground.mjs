/**
 * Where does the floor go?
 *
 * Walking forward from the spawn pad ends with the player airborne, and in one
 * run 6.5 m lower than they started. That is not the screenshot harness and it
 * is not enemies blocking the way — it reproduces on an empty map. This walks
 * the player forward in small steps and reports height and grounded state at
 * each one, then raycasts straight down along the same line so the geometry
 * can be compared against what the controller actually did.
 *
 *   node scripts/probe-ground.mjs
 */
import { chromium } from 'playwright';
import { createServer } from 'vite';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const server = await createServer({ root, server: { port: 5241, host: '127.0.0.1' }, logLevel: 'error' });
await server.listen();
const browser = await chromium.launch({
  executablePath: '/opt/pw-browsers/chromium-1194/chrome-linux/chrome',
  args: ['--use-gl=angle', '--use-angle=swiftshader', '--enable-unsafe-swiftshader', '--no-sandbox'],
});
const page = await browser.newPage({ viewport: { width: 640, height: 360 } });
page.setDefaultTimeout(240000);
page.on('pageerror', (e) => console.log('[pageerror]', e.message));

await page.goto('http://127.0.0.1:5241/?quality=low', { waitUntil: 'load' });
await page.waitForFunction(() => !!window.__game, { timeout: 220000 });
await page.waitForFunction(() => window.__game.engine.frame > 30, { timeout: 220000 }).catch(() => {});
await page.waitForTimeout(2000);

const info = await page.evaluate(() => {
  const { ctx } = window.__game;
  const s = ctx.level.spawnPoint;
  return { spawn: [s.x, s.y, s.z], bounds: [ctx.level.bounds.min.y, ctx.level.bounds.max.y] };
});
console.log(`spawn ${info.spawn.join(', ')}   level y bounds ${info.bounds.join(' .. ')}`);

// --- what the geometry says ------------------------------------------------
console.log('\nraycast straight down every 2 m along -Z from the spawn:');
const rays = await page.evaluate(() => {
  const { ctx, THREE } = window.__game;
  const s = ctx.level.spawnPoint;
  const out = [];
  for (let d = 0; d <= 24; d += 2) {
    const from = new THREE.Vector3(s.x, s.y + 3, s.z - d);
    const hit = ctx.physics.raycast
      ? ctx.physics.raycast(from, new THREE.Vector3(0, -1, 0), 12)
      : null;
    out.push({ d, y: hit ? +hit.point.y.toFixed(3) : null, surf: hit?.surface ?? '-' });
  }
  return out;
});
for (const r of rays) {
  console.log(`  z-${String(r.d).padStart(2)}   ground y=${r.y === null ? 'NONE' : String(r.y).padStart(7)}   ${r.surf}`);
}

// --- what the controller does ----------------------------------------------
console.log('\nwalking forward, 8 frames per step:');
const walk = await page.evaluate(async () => {
  const { ctx } = window.__game;
  const p = ctx.player;
  ctx.input.locked = true;
  ctx.enemies?.clearAll?.();
  p.respawn?.();
  p.yaw = 0; p.pitch = 0;
  for (let i = 0; i < 20; i++) await new Promise((r) => requestAnimationFrame(r));

  const rows = [];
  window.dispatchEvent(new KeyboardEvent('keydown', { code: 'KeyW', bubbles: true }));
  for (let step = 0; step < 12; step++) {
    for (let i = 0; i < 8; i++) await new Promise((r) => requestAnimationFrame(r));
    rows.push({
      step,
      x: +p.capsule.start.x.toFixed(2),
      y: +p.capsule.start.y.toFixed(3),
      z: +p.capsule.start.z.toFixed(2),
      vy: +p.velocity.y.toFixed(2),
      grounded: p.isGrounded,
    });
  }
  window.dispatchEvent(new KeyboardEvent('keyup', { code: 'KeyW', bubbles: true }));
  return rows;
});
for (const r of walk) {
  console.log(`  step ${String(r.step).padStart(2)}  pos ${String(r.x).padStart(6)}, ` +
    `${String(r.y).padStart(7)}, ${String(r.z).padStart(6)}   vy=${String(r.vy).padStart(6)}  grounded=${r.grounded}`);
}

await browser.close();
await server.close();
