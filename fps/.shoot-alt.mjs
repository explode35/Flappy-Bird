/**
 * Alternate capture harness (scratchpad, not part of the repo).
 *
 * The repo harness uses page.screenshot(), which goes through the browser
 * compositor. Under SwiftShader that path returns a black / truncated canvas.
 * This one reads the pixels back inside the page, in a rAF callback that is
 * queued AFTER the engine's own loop callback, so the drawing buffer is still
 * live and no compositor is involved.
 *
 *   node shoot2.mjs <outDir> [--shots=a,b] [--width=] [--height=] [--wait=]
 */
import { chromium } from 'playwright';
import { createServer } from 'vite';
import { mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { resolve } from 'node:path';

const root = '/home/user/Flappy-Bird/fps';
const outDir = resolve(process.argv[2] || '/home/user/Flappy-Bird/.review/alt');
const arg = (k, d) => {
  const m = process.argv.find((a) => a.startsWith(`--${k}=`));
  return m ? m.split('=').slice(1).join('=') : d;
};
const settleMs = Number(arg('wait', 2500));
const quality = arg('quality', 'low');
const VW = Number(arg('width', 1280));
const VH = Number(arg('height', 720));

const SHOTS = [
  { id: '01_spawn',        pos: [0, 1.68, 34],     look: [0, 1.5, 0],       fov: 80 },
  { id: '02_plaza_long',   pos: [1, 1.68, 22],     look: [-2, 2.2, -26],    fov: 80 },
  { id: '03_market_lane',  pos: [-24, 1.68, 10],   look: [-22, 1.6, -18],   fov: 80 },
  { id: '04_harbour',      pos: [27, 1.68, 6],     look: [30, 2.0, -22],    fov: 80 },
  { id: '05_interior',     pos: [-14, 1.55, -6],   look: [-2, 1.5, -10],    fov: 80 },
  { id: '06_rooftop',      pos: [-18, 8.6, -14],   look: [4, 1.2, -4],      fov: 80 },
  { id: '07_backlit',      pos: [-6, 1.68, -30],   look: [10, 6.0, 12],     fov: 80 },
  { id: '08_closeup',      pos: [-9, 1.45, 3],     look: [-9.9, 1.3, 1.2],  fov: 62 },
  // extra facade-review vantages
  { id: '11_facade_w',     pos: [-3, 2.2, -14],    look: [-11, 3.6, -12],   fov: 70 },
  { id: '12_facade_n',     pos: [-2, 1.9, -12],    look: [-2, 4.4, -22],    fov: 75 },
  { id: '13_market_face',  pos: [-24, 1.8, 4],     look: [-31, 4.0, 6],     fov: 75 },
  { id: '14_apart_e',      pos: [-2, 2.0, 8],      look: [-8, 4.2, 8],      fov: 75 },
];

const wanted = arg('shots', '').split(',').filter(Boolean);
const shots = wanted.length ? SHOTS.filter((s) => wanted.some((w) => s.id.includes(w))) : SHOTS;

rmSync(outDir, { recursive: true, force: true });
mkdirSync(outDir, { recursive: true });

const server = await createServer({ root, server: { port: 5207, host: '127.0.0.1' }, logLevel: 'error' });
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
const page = await browser.newPage({ viewport: { width: VW, height: VH } });
page.setDefaultTimeout(180000);

const logs = [];
page.on('console', (m) => logs.push(`[${m.type()}] ${m.text()}`));
page.on('pageerror', (e) => logs.push(`[pageerror] ${e.message}\n${e.stack || ''}`));

await page.goto(`http://127.0.0.1:5207/?quality=${quality}`, { waitUntil: 'load' });

const booted = await page
  .waitForFunction(() => !!window.__game || !!document.querySelector('pre'), { timeout: 120000 })
  .then(() => true).catch(() => false);
await page.waitForTimeout(settleMs);
if (!booted || (await page.evaluate(() => !window.__game))) {
  writeFileSync(resolve(outDir, 'log.txt'), logs.join('\n'));
  console.log('BOOT FAILURE');
  console.log(logs.slice(-40).join('\n'));
  await browser.close(); await server.close();
  process.exit(1);
}

await page.waitForFunction(() => window.__game && window.__game.engine.frame > 25, { timeout: 120000 }).catch(() => {});
await page.waitForTimeout(settleMs);

for (const s of shots) {
  await page.evaluate((shot) => {
    const { ctx, engine } = window.__game;
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
    if (ctx.weapons?.forceADS) ctx.weapons.forceADS(!!shot.ads);
  }, s);

  // Read the drawing buffer from inside a rAF queued after the engine's own
  // loop callback, so the buffer has been drawn this frame but not presented.
  const dataUrl = await page.evaluate(async () => {
    const canvas = window.__game.ctx.renderer.domElement;
    for (let i = 0; i < 4; i++) await new Promise((r) => requestAnimationFrame(r));
    return await new Promise((resolve) => {
      requestAnimationFrame(() => {
        // queued during frame N -> runs in frame N+1, after the engine's loop
        // callback (registered earlier) has already rendered.
        resolve(canvas.toDataURL('image/png'));
      });
    });
  });
  const b64 = dataUrl.split(',')[1];
  writeFileSync(resolve(outDir, `${s.id}.png`), Buffer.from(b64, 'base64'));
  process.stdout.write(`shot ${s.id}\n`);
}

const stats = await page.evaluate(() => {
  const { ctx, engine } = window.__game;
  const i = ctx.renderer.info;
  return {
    fps: Math.round(engine._fpsAvg),
    calls: i.render.calls, triangles: i.render.triangles,
    levelTris: ctx.level?.stats?.tris ?? null,
    levelDraws: ctx.level?.stats?.drawCalls ?? null,
    solids: ctx.level?.builder?.solids?.length ?? null,
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
