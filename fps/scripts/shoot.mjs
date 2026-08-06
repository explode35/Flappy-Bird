/**
 * Visual review harness.
 *
 * Boots the real game in headless Chromium, drives the camera to a set of
 * scripted vantage points, and writes 1920x1080 PNGs plus a console/error log.
 * This is the ground truth the art-direction critique loop runs against —
 * it screenshots the shipping build, not a mock.
 *
 *   node scripts/shoot.mjs [outDir] [--shots=a,b,c] [--wait=ms]
 */
import { chromium } from 'playwright';
import { createServer } from 'vite';
import { mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const outDir = resolve(process.argv[2] || resolve(root, '../.review/latest'));
const arg = (k, d) => {
  const m = process.argv.find((a) => a.startsWith(`--${k}=`));
  return m ? m.split('=').slice(1).join('=') : d;
};
const settleMs = Number(arg('wait', 2500));
// Software GL cannot carry the High tier at 1080p. The harness judges art
// direction, not performance, so drop the tier and keep the frames coming.
const quality = arg('quality', 'low');

/**
 * Camera vantage points. `pos` is the eye, `look` the target.
 * These deliberately cover the composition cases the AAA checklist cares
 * about: a long lane, a tight interior, a silhouette shot, a vertical shot.
 */
const SHOTS = [
  { id: '01_spawn',        pos: [0, 1.68, 34],     look: [0, 1.5, 0],       fov: 80 },
  { id: '02_plaza_long',   pos: [1, 1.68, 22],     look: [-2, 2.2, -26],    fov: 80 },
  { id: '03_market_lane',  pos: [-24, 1.68, 10],   look: [-22, 1.6, -18],   fov: 80 },
  { id: '04_harbour',      pos: [27, 1.68, 6],     look: [30, 2.0, -22],    fov: 80 },
  { id: '05_interior',     pos: [-14, 1.55, -6],   look: [-2, 1.5, -10],    fov: 80 },
  { id: '06_rooftop',      pos: [-18, 8.6, -14],   look: [4, 1.2, -4],      fov: 80 },
  { id: '07_backlit',      pos: [-6, 1.68, -30],   look: [10, 6.0, 12],     fov: 80 },
  { id: '08_closeup',      pos: [-9, 1.45, 3],     look: [-9.9, 1.3, 1.2],  fov: 62 },
  { id: '09_ads',          pos: [0, 1.68, 18],     look: [0, 1.7, -30],     fov: 62, ads: true },
  { id: '10_combat',       pos: [4, 1.68, 12],     look: [-6, 1.6, -14],    fov: 80, combat: true },
];

const wanted = arg('shots', '').split(',').filter(Boolean);
const shots = wanted.length ? SHOTS.filter((s) => wanted.some((w) => s.id.includes(w))) : SHOTS;

rmSync(outDir, { recursive: true, force: true });
mkdirSync(outDir, { recursive: true });

const server = await createServer({ root, server: { port: 5199, host: '127.0.0.1' }, logLevel: 'error' });
await server.listen();

const browser = await chromium.launch({
  executablePath: process.env.PW_CHROMIUM || '/opt/pw-browsers/chromium-1194/chrome-linux/chrome',
  args: [
    '--use-gl=angle', '--use-angle=swiftshader',
    '--enable-unsafe-swiftshader',
    '--disable-gpu-sandbox', '--no-sandbox',
    '--force-device-scale-factor=1',
  ],
});
const page = await browser.newPage({ viewport: { width: 1920, height: 1080 } });
page.setDefaultTimeout(120000);

const logs = [];
page.on('console', (m) => logs.push(`[${m.type()}] ${m.text()}`));
page.on('pageerror', (e) => logs.push(`[pageerror] ${e.message}\n${e.stack || ''}`));

await page.goto(`http://127.0.0.1:5199/?quality=${quality}`, { waitUntil: 'load' });

// Wait for boot: either the game handle appears or a boot failure is rendered.
const booted = await page
  .waitForFunction(() => !!window.__game || !!document.querySelector('pre'), { timeout: 90000 })
  .then(() => true)
  .catch(() => false);

await page.waitForTimeout(settleMs);

const failed = await page.evaluate(() => !window.__game);
if (!booted || failed) {
  const shotPath = resolve(outDir, '00_BOOT_FAILURE.png');
  await page.screenshot({ path: shotPath });
  writeFileSync(resolve(outDir, 'log.txt'), logs.join('\n'));
  console.log('BOOT FAILURE — see 00_BOOT_FAILURE.png and log.txt');
  console.log(logs.slice(-40).join('\n'));
  await browser.close(); await server.close();
  process.exit(1);
}

// Let the world settle: materials generate, level builds, shadows converge.
await page.waitForFunction(() => {
  const g = window.__game;
  return g && g.engine.frame > 25;
}, { timeout: 90000 }).catch(() => {});
await page.waitForTimeout(settleMs);

try {
for (const s of shots) {
  await page.evaluate((shot) => {
    const { ctx, engine } = window.__game;
    // Freeze gameplay systems so the camera stays where we put it.
    engine.paused = true;
    if (ctx.player) ctx.player.frozen = true;
    const cam = ctx.camera;
    cam.fov = shot.fov;
    cam.position.set(...shot.pos);
    cam.lookAt(...shot.look);
    cam.updateProjectionMatrix();
    cam.updateMatrixWorld(true);
    if (ctx.viewCamera) {
      ctx.viewCamera.quaternion.copy(cam.quaternion);
      ctx.viewCamera.updateMatrixWorld(true);
    }
    if (shot.ads && ctx.weapons?.forceADS) ctx.weapons.forceADS(true);
    else if (ctx.weapons?.forceADS) ctx.weapons.forceADS(false);
    if (shot.combat && ctx.director?.debugSpawnWave) ctx.director.debugSpawnWave(6);
  }, s);

  // Several frames so shadow maps, TAA-ish accumulation and lazy loads resolve.
  await page.waitForTimeout(900);
  await page.screenshot({ path: resolve(outDir, `${s.id}.png`), animations: 'disabled', caret: 'hide' });
  process.stdout.write(`shot ${s.id}\n`);
}

} catch (err) {
  writeFileSync(resolve(outDir, "log.txt"), logs.join("\n") + "\n\nHARNESS ERROR: " + err.message);
  console.log("HARNESS ERROR: " + err.message);
  console.log(logs.slice(-30).join("\n"));
  await browser.close(); await server.close();
  process.exit(1);
}

const stats = await page.evaluate(() => {
  const { ctx, engine } = window.__game;
  const i = ctx.renderer.info;
  return {
    fps: Math.round(engine._fpsAvg),
    calls: i.render.calls, triangles: i.render.triangles,
    programs: i.programs?.length ?? 0,
    textures: i.memory.textures, geometries: i.memory.geometries,
    tier: engine.quality.name,
  };
});

writeFileSync(resolve(outDir, 'log.txt'), logs.join('\n'));
writeFileSync(resolve(outDir, 'stats.json'), JSON.stringify(stats, null, 2));
console.log('\nstats:', JSON.stringify(stats));
const errs = logs.filter((l) => l.startsWith('[error]') || l.startsWith('[pageerror]'));
if (errs.length) console.log(`\n${errs.length} errors:\n` + errs.slice(0, 20).join('\n'));

await browser.close();
await server.close();
