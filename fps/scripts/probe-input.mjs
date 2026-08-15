/**
 * Drive real input events into the running game and check what actually moves.
 *
 * Bug report from a real machine: forward and back work, strafe does not, jump
 * does not, firing does not, and the weapon HUD is fine. Those three failing
 * things do not share a code path in any obvious way, so this stops guessing
 * and measures. It dispatches genuine keydown/keyup and mousedown events the
 * way a browser would, holds them for a number of frames, and reports what
 * changed in the player and weapon state.
 *
 *   node scripts/probe-input.mjs
 */
import { chromium } from 'playwright';
import { createServer } from 'vite';
import { readFileSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');

// Static half of the check: the runtime half cannot see this, because the
// probe forces input.locked itself in order to test anything at all.
const mainSrc = readFileSync(resolve(root, 'src/main.js'), 'utf8');
const hasLockCall = /requestLock\s*\(/.test(mainSrc);
const server = await createServer({ root, server: { port: 5231, host: '127.0.0.1' }, logLevel: 'error' });
await server.listen();
const browser = await chromium.launch({
  executablePath: '/opt/pw-browsers/chromium-1194/chrome-linux/chrome',
  args: ['--use-gl=angle', '--use-angle=swiftshader', '--enable-unsafe-swiftshader', '--no-sandbox'],
});
const page = await browser.newPage({ viewport: { width: 640, height: 360 } });
page.setDefaultTimeout(240000);

const errors = [];
page.on('pageerror', (e) => errors.push(`[pageerror] ${e.message}\n${(e.stack || '').split('\n').slice(0, 4).join('\n')}`));
page.on('console', (m) => { if (m.type() === 'error') errors.push(`[console.error] ${m.text()}`); });

await page.goto('http://127.0.0.1:5231/?quality=low', { waitUntil: 'load' });
await page.waitForFunction(() => !!window.__game, { timeout: 220000 });
await page.waitForFunction(() => window.__game.engine.frame > 30, { timeout: 220000 }).catch(() => {});
await page.waitForTimeout(2500);

// Pointer lock cannot be granted headlessly, and Player gates look/intent on
// input.locked. Force it, which is exactly the state a real player is in after
// clicking the canvas.
await page.evaluate(() => {
  const { ctx } = window.__game;
  ctx.input.locked = true;
  ctx.player.dead = false;
  ctx.player.frozen = false;
});

/** Put the player back on the spawn pad and let them settle. */
const respawn = () => page.evaluate(async () => {
  const { ctx } = window.__game;
  const p = ctx.player;
  if (p.respawn) p.respawn();
  else {
    const s = ctx.level.spawnPoint;
    p.capsule.start.set(s.x, s.y + 0.32, s.z);
    p.capsule.end.set(s.x, s.y + 0.32 + 1.04, s.z);
    p.velocity.set(0, 0, 0);
  }
  for (let i = 0; i < 20; i++) await new Promise((r) => requestAnimationFrame(r));
  return { y: +p.capsule.start.y.toFixed(2), isGrounded: p.isGrounded };
});

/**
 * Hold a key for n frames and report what the player did, in the player's own
 * frame of reference: `fwd` is metres gained along the look direction, `right`
 * is metres gained to the player's right. Distance alone cannot tell a strafe
 * from a strafe in the wrong direction.
 */
const testKey = (code, frames = 40) => page.evaluate(async ({ code, frames }) => {
  const { ctx } = window.__game;
  const p = ctx.player;
  const before = p.capsule.start.clone();
  const yaw = p.yaw;
  const fwd = { x: -Math.sin(yaw), z: -Math.cos(yaw) };
  // True right-hand basis, independent of whatever the player is using.
  const right = { x: Math.cos(yaw), z: -Math.sin(yaw) };

  window.dispatchEvent(new KeyboardEvent('keydown', { code, bubbles: true }));
  const keySeen = ctx.input.down(code);
  let peakSpeed = 0, peakUp = 0;
  for (let i = 0; i < frames; i++) {
    await new Promise((r) => requestAnimationFrame(r));
    peakSpeed = Math.max(peakSpeed, Math.hypot(p.velocity.x, p.velocity.z));
    peakUp = Math.max(peakUp, p.velocity.y);
  }
  window.dispatchEvent(new KeyboardEvent('keyup', { code, bubbles: true }));
  const d = p.capsule.start.clone().sub(before);
  return {
    fwd: +(d.x * fwd.x + d.z * fwd.z).toFixed(2),
    right: +(d.x * right.x + d.z * right.z).toFixed(2),
    dy: +d.y.toFixed(2),
    peakSpeed: +peakSpeed.toFixed(2),
    peakUp: +peakUp.toFixed(2),
    isGrounded: p.isGrounded,
    keySeen,
  };
}, { code, frames });

const testFire = (frames = 30) => page.evaluate(async ({ frames }) => {
  const { ctx } = window.__game;
  const w = ctx.weapons;
  const before = w.current ? (w.current.ammo ?? -1) : -1;
  let shots = 0;
  const off = ctx.bus.on ? ctx.bus.on('weapon:fire', () => { shots++; }) : null;
  window.dispatchEvent(new MouseEvent('mousedown', { button: 0, bubbles: true }));
  for (let i = 0; i < frames; i++) await new Promise((r) => requestAnimationFrame(r));
  window.dispatchEvent(new MouseEvent('mouseup', { button: 0, bubbles: true }));
  if (typeof off === 'function') off();
  return {
    shots,
    ammoBefore: before,
    ammoAfter: w.current ? (w.current.ammo ?? -1) : -1,
    mouseSeen: ctx.input.mDown(0),
    hasCurrent: !!w.current,
    weaponName: w.current?.name ?? w.current?.id ?? 'none',
  };
}, { frames });

console.log('--- baseline (no input, 50 frames) ---');
console.log(JSON.stringify(await respawn()));
const idle = await testKey('KeyZ', 50);   // a key nothing binds
console.log(`idle  fwd=${idle.fwd} right=${idle.right} dy=${idle.dy} grounded=${idle.isGrounded}`);

console.log('--- movement (fwd/right are in the player\'s own frame) ---');
const moves = {};
for (const code of ['KeyW', 'KeyS', 'KeyA', 'KeyD']) {
  await respawn();
  const r = await testKey(code);
  moves[code] = r;
  console.log(`${code}  fwd=${String(r.fwd).padStart(6)} right=${String(r.right).padStart(6)} dy=${String(r.dy).padStart(6)}` +
    `  peakSpeed=${String(r.peakSpeed).padStart(5)}  grounded=${r.isGrounded}  keySeen=${r.keySeen}`);
}

console.log('--- jump ---');
await respawn();
const j = await testKey('Space', 45);
console.log(`Space dy=${j.dy} peakUp=${j.peakUp} groundedAfter=${j.isGrounded} keySeen=${j.keySeen}`);

console.log('--- fire ---');
await respawn();
const f = await testFire();
console.log(`mouse0 shots=${f.shots} ammo ${f.ammoBefore}->${f.ammoAfter} mouseSeen=${f.mouseSeen} weapon=${f.weaponName}`);

// ---------------------------------------------------------------------------
//  The real flow. The checks above force input.locked directly, which skips
//  every piece of wiring between clicking the menu and being able to shoot —
//  and "left click does nothing" was reported from a session that had gone
//  through that wiring. Emit the lock the way the browser would and try again.
// ---------------------------------------------------------------------------
console.log('--- fire through the real menu wiring ---');
const wired = await page.evaluate(async () => {
  const { ctx, engine } = window.__game;
  // Undo the shortcut the probe took at the top.
  ctx.input.locked = false;
  ctx.bus.emit('input:unlock', {});
  for (let i = 0; i < 5; i++) await new Promise((r) => requestAnimationFrame(r));
  const pausedAfterUnlock = engine.paused;

  // Now the click: this is what main.js's mousedown handler does, followed by
  // what the browser does when it grants the lock.
  document.dispatchEvent(new MouseEvent('mousedown', { button: 0, bubbles: true }));
  ctx.input.locked = true;
  ctx.bus.emit('input:lock', {});
  for (let i = 0; i < 10; i++) await new Promise((r) => requestAnimationFrame(r));

  let shots = 0;
  const off = ctx.bus.on('weapon:fire', () => { shots++; });
  window.dispatchEvent(new MouseEvent('mousedown', { button: 0, bubbles: true }));
  for (let i = 0; i < 30; i++) await new Promise((r) => requestAnimationFrame(r));
  window.dispatchEvent(new MouseEvent('mouseup', { button: 0, bubbles: true }));
  if (typeof off === 'function') off();

  const w = ctx.weapons;
  return {
    pausedAfterUnlock,
    pausedNow: engine.paused,
    locked: ctx.input.locked,
    menuHidden: document.querySelector('.menu')?.classList.contains('hidden') ?? null,
    swapping: w._swapping, reloading: w._reloading,
    sprinting: ctx.player.isSprinting,
    shots,
  };
});
console.log(`  paused after unlock=${wired.pausedAfterUnlock}  paused now=${wired.pausedNow}  ` +
  `locked=${wired.locked}  menuHidden=${wired.menuHidden}`);
console.log(`  swapping=${wired.swapping} reloading=${wired.reloading} sprinting=${wired.sprinting}  ` +
  `shots=${wired.shots}`);

console.log('--- fire from a bound key ---');
const keyFire = await page.evaluate(async () => {
  const { ctx } = window.__game;
  ctx.input.rebind('fire', 'Space');
  ctx.input.rebind('jump', 'KeyJ');
  let shots = 0;
  const off = ctx.bus.on('weapon:fire', () => { shots++; });
  window.dispatchEvent(new KeyboardEvent('keydown', { code: 'Space', bubbles: true }));
  for (let i = 0; i < 25; i++) await new Promise((r) => requestAnimationFrame(r));
  window.dispatchEvent(new KeyboardEvent('keyup', { code: 'Space', bubbles: true }));
  if (typeof off === 'function') off();
  return { shots, fireBind: ctx.input.bindings.fire.join(','), jumpBind: ctx.input.bindings.jump.join(',') };
});
console.log(`  fire bound to ${keyFire.fireBind}, jump to ${keyFire.jumpBind} -> shots=${keyFire.shots}`);

// ---------------------------------------------------------------------------
//  Assertions. This is the regression test the project did not have: thirteen
//  physics cases covering the capsule, and nothing joining a key press to the
//  player. Pointer lock going unrequested for the life of the project is
//  exactly the kind of thing an integration check catches and a unit test
//  never will.
// ---------------------------------------------------------------------------
const fails = [];
const check = (name, ok, detail) => {
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? '  ' + detail : ''}`);
  if (!ok) fails.push(name);
};

console.log('--- checks ---');
check('idle player rests, does not drift or fall',
  Math.abs(idle.dy) < 0.05 && Math.abs(idle.fwd) < 0.05 && Math.abs(idle.right) < 0.05,
  `dy=${idle.dy} fwd=${idle.fwd} right=${idle.right}`);
check('W walks forward', moves.KeyW.fwd > 2 && Math.abs(moves.KeyW.right) < 1, `fwd=${moves.KeyW.fwd}`);
check('S walks back', moves.KeyS.fwd < -1 && Math.abs(moves.KeyS.right) < 1, `fwd=${moves.KeyS.fwd}`);
// Direction matters, not just magnitude: strafing was mirrored for the whole
// life of the project and every "did it move" check would have passed.
check('A strafes LEFT', moves.KeyA.right < -1 && Math.abs(moves.KeyA.fwd) < 1, `right=${moves.KeyA.right}`);
check('D strafes RIGHT', moves.KeyD.right > 1 && Math.abs(moves.KeyD.fwd) < 1, `right=${moves.KeyD.right}`);
check('Space jumps', j.peakUp > 2, `peakUp=${j.peakUp}`);
check('mouse fires', f.shots > 0, `shots=${f.shots}`);
check('pointer lock is requested somewhere', hasLockCall, hasLockCall ? '' : 'Input.requestLock() has no call sites');
check('mouse fires after going through the menu wiring', wired.shots > 0, `shots=${wired.shots}, paused=${wired.pausedNow}`);
check('unlock pauses, lock unpauses', wired.pausedAfterUnlock === true && wired.pausedNow === false,
  `unlock->${wired.pausedAfterUnlock}, lock->${wired.pausedNow}`);
check('a key bound to fire shoots', keyFire.shots > 0, `shots=${keyFire.shots}`);

console.log('--- state ---');
console.log(await page.evaluate(() => {
  const { ctx, engine } = window.__game;
  const p = ctx.player;
  return JSON.stringify({
    paused: engine.paused, locked: ctx.input.locked,
    dead: p.dead, frozen: p.frozen, grounded: p.grounded,
    health: p.health, y: +p.capsule.start.y.toFixed(2),
    systems: engine.systems.length,
  });
}));

if (errors.length) {
  console.log(`\n--- ${errors.length} page errors (first 5) ---`);
  console.log([...new Set(errors)].slice(0, 5).join('\n'));
} else {
  console.log('\nno page errors');
}

await browser.close();
await server.close();

if (fails.length) {
  console.log(`\n${fails.length} FAILED: ${fails.join(', ')}`);
  process.exit(1);
}
console.log('\nall input checks passed');
