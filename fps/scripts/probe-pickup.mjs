/**
 * Can the player actually collect anything?
 *
 * The crates render — one is visible as an orange marker in a captured frame —
 * but collection has never been observed happening in a live session, and
 * "it's on screen" is not "it works". Two separate questions, and they fail
 * differently:
 *
 *   1. Does the collection logic fire and change player state? (teleport onto
 *      a crate, check reserve / health actually moved)
 *   2. Can a player on foot reach one? (walk in with real movement and real
 *      collision from a few metres out)
 *
 * A crate embedded in a wall passes (1) and fails (2), which is exactly the
 * kind of thing that survives a screenshot.
 *
 *   node scripts/probe-pickup.mjs
 */
import { chromium } from 'playwright';
import { createServer } from 'vite';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const server = await createServer({ root, server: { port: 5247, host: '127.0.0.1' }, logLevel: 'error' });
await server.listen();
const browser = await chromium.launch({
  executablePath: '/opt/pw-browsers/chromium-1194/chrome-linux/chrome',
  args: ['--use-gl=angle', '--use-angle=swiftshader', '--enable-unsafe-swiftshader', '--no-sandbox'],
});
const page = await browser.newPage({ viewport: { width: 480, height: 270 } });
page.setDefaultTimeout(240000);

const errs = [];
page.on('pageerror', (e) => errs.push(`[pageerror] ${e.message}`));
page.on('console', (m) => { if (m.type() === 'error') errs.push(`[console] ${m.text()}`); });

await page.goto('http://127.0.0.1:5247/?quality=low&capture=1', { waitUntil: 'load' });
await page.waitForFunction(() => !!window.__game, { timeout: 220000 });
await page.waitForFunction(() => window.__game.engine.frame > 30, { timeout: 220000 }).catch(() => {});
await page.waitForTimeout(1500);

const report = await page.evaluate(async () => {
  const { ctx } = window.__game;
  const lines = [];
  const fail = [];
  const frame = () => new Promise((r) => requestAnimationFrame(r));
  const wait = async (n) => { for (let i = 0; i < n; i++) await frame(); };

  ctx.enemies?.clearAll?.();
  ctx.player.respawn?.();
  ctx.input.locked = true;
  ctx.bus.emit('input:lock', {});
  await wait(10);

  const pk = ctx.pickups;
  if (!pk) { fail.push('ctx.pickups is not registered'); return { lines, fail }; }
  const items = pk.items || [];
  lines.push(`placed: ${items.length} (${items.filter((i) => i.kind === 'ammo').length} ammo, ${items.filter((i) => i.kind === 'health').length} health)`);
  if (!items.length) { fail.push('no pickups placed'); return { lines, fail }; }

  const P = ctx.player;
  // `weapons.ammo` is a getter for the *current* weapon's {mag, reserve};
  // `weapons.state` is the per-weapon map. Iterating the getter would walk
  // {mag, reserve} as if they were weapon ids.
  const reserve = () => ctx.weapons?.ammo?.reserve ?? -1;
  const drain = () => {
    for (const st of Object.values(ctx.weapons?.state || {})) if (st) st.reserve = 0;
  };

  // ---- (1) does collection change player state? ------------------------
  const ammo = items.find((i) => i.kind === 'ammo');
  const health = items.find((i) => i.kind === 'health');

  if (ammo) {
    drain();
    const before = reserve();
    P.teleport(ammo.home.x, ammo.home.y - 0.34, ammo.home.z);
    await wait(6);
    const after = reserve();
    lines.push(`ammo crate: reserve ${before} -> ${after}, hidden=${!ammo.mesh.visible}, cooldown=${ammo.taken.toFixed?.(1) ?? ammo.taken}`);
    if (!(after > before)) fail.push('walking onto an ammo crate did not raise the reserve');
    if (ammo.mesh.visible) fail.push('collected ammo crate is still visible');
  }

  if (health) {
    P.health = Math.min(P.health, P.maxHealth * 0.4);
    const before = P.health;
    P.teleport(health.home.x, health.home.y - 0.34, health.home.z);
    await wait(6);
    const after = P.health;
    lines.push(`health crate: health ${before.toFixed(0)} -> ${after.toFixed(0)}, hidden=${!health.mesh.visible}`);
    if (!(after > before)) fail.push('walking onto a health crate did not raise health');
    if (health.mesh.visible) fail.push('collected health crate is still visible');
  }

  // ---- (2) can you reach one on foot? ----------------------------------
  // Pick a crate that is still up, drop the player 3.5 m away on the side
  // facing map centre, aim at it, and hold forward. Real movement, real
  // collision — if geometry is in the way this is where it shows.
  const live = items.filter((i) => i.taken <= 0);
  let walked = null;
  for (const it of live.slice(0, 4)) {
    const h = it.home;
    const away = Math.hypot(h.x, h.z) || 1;
    const sx = h.x + (h.x / away) * 3.5;
    const sz = h.z + (h.z / away) * 3.5;
    P.teleport(sx, h.y - 0.34, sz);
    P.yaw = Math.atan2(-(h.x - sx), -(h.z - sz));       // fwd = (-sin yaw, 0, -cos yaw)
    P.health = Math.min(P.health, P.maxHealth * 0.4);
    drain();
    await wait(4);
    const startD = Math.hypot(P.capsule.start.x - h.x, P.capsule.start.z - h.z);
    ctx.input.keys.add('KeyW');
    let got = false;
    for (let i = 0; i < 150 && !got; i++) { await frame(); got = !it.mesh.visible; }
    ctx.input.keys.delete('KeyW');
    const endD = Math.hypot(P.capsule.start.x - h.x, P.capsule.start.z - h.z);
    walked = { kind: it.kind, startD: startD.toFixed(2), endD: endD.toFixed(2), got };
    lines.push(`walk to ${it.kind}: ${startD.toFixed(2)} m -> ${endD.toFixed(2)} m, collected=${got}`);
    if (got) break;
  }
  if (!walked?.got) fail.push('could not reach any crate on foot from 3.5 m away');

  // ---- respawn --------------------------------------------------------
  const taken = items.find((i) => i.taken > 0);
  if (taken) {
    const t0 = taken.taken;
    taken.taken = 0.05;
    await wait(20);
    lines.push(`respawn: cooldown was ${t0.toFixed(1)} s, visible again=${taken.mesh.visible}`);
    if (!taken.mesh.visible) fail.push('a crate never came back after its cooldown');
  }

  return { lines, fail };
});

for (const l of report.lines) console.log(l);
if (report.fail.length) {
  console.log(`\n${report.fail.length} FAILURES:`);
  for (const f of report.fail) console.log(`  - ${f}`);
} else {
  console.log('\nall pickup checks passed');
}
if (errs.length) console.log(`\nerrors:\n` + [...new Set(errs)].slice(0, 5).join('\n'));

await browser.close();
await server.close();
process.exit(report.fail.length ? 1 : 0);
