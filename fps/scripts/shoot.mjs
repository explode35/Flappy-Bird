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
import { PNG } from 'pngjs';
import { mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

/** GL hands back bottom-up RGBA; PNG wants top-down. */
function encodePng({ w, h, bands }) {
  const src = Buffer.concat(bands.map((b) => Buffer.from(b, 'base64')));
  const png = new PNG({ width: w, height: h });
  const stride = w * 4;
  for (let y = 0; y < h; y++) src.copy(png.data, y * stride, (h - 1 - y) * stride, (h - y) * stride);
  return PNG.sync.write(png);
}

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
// Viewport size. Headless SwiftShader truncates large captures (see README),
// so the default is deliberately small enough to come back whole.
const VW = Number(arg('width', 640));
const VH = Number(arg('height', 360));
// Also save a page-level screenshot showing the DOM HUD over the (unreliable)
// composited canvas. Useful only for reviewing HUD layout.
const withHud = process.argv.includes('--hud');

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
  // Was at (-6,-30), which is inside the three-storey block on the plaza's
  // north side — the "backlit exterior" shot has been an interior all along.
  { id: '07_backlit',      pos: [-4, 1.68, -16],   look: [20, 4.5, 8],      fov: 80 },
  { id: '08_closeup',      pos: [-9, 1.45, 3],     look: [-9.9, 1.3, 1.2],  fov: 62 },
  { id: '09_ads',          pos: [0, 1.68, 18],     look: [0, 1.7, -30],     fov: 62, ads: true },
  { id: '10_combat',       pos: [4, 1.68, 12],     look: [-6, 1.6, -14],    fov: 80, combat: true },
  // Facade detail. The set above is all interiors and long lanes and points at
  // none of the window/surround/quoin/cornice work, which is most of what the
  // buildings are made of.
  { id: '11_facade',       pos: [-2.0, 1.68, -10], look: [-7.5, 2.6, -10],  fov: 62 },
  { id: '12_window',       pos: [-5.4, 1.75, -13.2], look: [-7.5, 1.75, -13.2], fov: 55 },
  { id: '13_corner',       pos: [-4.5, 1.68, 0.5], look: [-7.5, 3.0, -1.6], fov: 62 },
  { id: '14_cornice',      pos: [-2.0, 1.68, 18],  look: [-7.5, 3.4, 4],    fov: 70 },
  // Square on to the run of vertical fins that shows along the ground floor of
  // this frontage in 02 and 14. At an oblique angle they are unidentifiable;
  // this is close enough and flat enough to name them.
  { id: '15_finrun',       pos: [-4.5, 1.60, 12],  look: [-7.5, 1.60, 12],  fov: 70 },
  { id: '16_finrun_wide',  pos: [-3.0, 2.40, 12],  look: [-7.5, 1.60, 6],   fov: 80 },
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
const page = await browser.newPage({ viewport: { width: VW, height: VH } });
page.setDefaultTimeout(120000);

const logs = [];
page.on('console', (m) => logs.push(`[${m.type()}] ${m.text()}`));
page.on('pageerror', (e) => logs.push(`[pageerror] ${e.message}\n${e.stack || ''}`));
page.on('crash', () => { logs.push('[crash] renderer process died'); console.log('[crash] renderer process died'); });

// `capture` turns on preserveDrawingBuffer — without it page.screenshot()
// reads an already-presented buffer and returns black.
await page.goto(`http://127.0.0.1:5199/?quality=${quality}&capture=1`, { waitUntil: 'load' });

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

/** Point the cameras at a shot and freeze the world there. */
const aim = (s) => page.evaluate((shot) => {
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
  // Deliberately does NOT touch ctx.viewCamera. The viewmodel camera lives in
  // view space and the weapon is authored against it; copying the world
  // camera's rotation onto it double-applies the rotation, and every run that
  // did so lost most of its frames to black. probe-view.mjs isolates it:
  // 187 at 01_spawn without the copy, 0 with it.
  if (shot.ads && ctx.weapons?.forceADS) ctx.weapons.forceADS(true);
  else if (ctx.weapons?.forceADS) ctx.weapons.forceADS(false);
  if (shot.combat && ctx.director?.debugSpawnWave) ctx.director.debugSpawnWave(6);
}, s);

/**
 * Read the frame the engine's own rAF just produced. Deliberately does no
 * rendering of its own: driving composer.render() from inside the evaluate
 * kills the page on this container's SwiftShader within a few calls.
 */
const grab = () => page.evaluate(async () => {
  const raf = () => new Promise((r) => requestAnimationFrame(r));
  for (let i = 0; i < 6; i++) await raf();
  const c = document.querySelector('canvas');
  const gl = window.__game.ctx.renderer.getContext();
  const w = c.width, h = c.height;
  const px = new Uint8Array(w * h * 4);
  gl.readPixels(0, 0, w, h, gl.RGBA, gl.UNSIGNED_BYTE, px);
  window.__frame = px;
  let sum = 0;
  for (let i = 0; i < px.length; i += 4 * 31) sum += (px[i] + px[i + 1] + px[i + 2]) / 3;
  return { w, h, mean: Math.round(sum / Math.ceil(px.length / (4 * 31))) };
});

try {
for (const s of shots) {
  process.stdout.write(`> ${s.id} setup\n`);
  await aim(s);

  // Capture by reading the GL back buffer directly and encoding the PNG in
  // Node. Everything that goes through the canvas element — page.screenshot(),
  // canvas.toDataURL(), drawImage() into a 2D context — comes back black on
  // this container's SwiftShader some of the time, deterministically enough to
  // have cost a day of chasing a scene bug that did not exist. A whole-buffer
  // gl.readPixels in the tick right after a completed render is the one path
  // that has never lied: scripts/probe-diag.mjs got a plausible image mean out
  // of it at four cameras that the toDataURL path called pure black.
  // Read the frame once into a page-side buffer, then ship it out in bands.
  // One 1.2 MB base64 payload over CDP was enough to lose the page on this
  // container; 45-row slices are not.
  process.stdout.write('> readback\n');
  // Some frames come back pure black. It is not the scene — the same camera
  // reads bright on the next attempt, and probe-diag.mjs, which renders and
  // reads inside one evaluate, has never seen it. Re-aim and try again rather
  // than reason from a black PNG; four attempts has always been enough.
  let probe = await grab();
  for (let attempt = 1; attempt < 4 && probe.mean === 0; attempt++) {
    process.stdout.write(`  black frame, retry ${attempt}\n`);
    await aim(s);
    await page.waitForTimeout(250);
    probe = await grab();
  }

  process.stdout.write(`> banding ${probe.w}x${probe.h}\n`);
  const BAND = 45;
  const bands = [];
  for (let y0 = 0; y0 < probe.h; y0 += BAND) {
    bands.push(await page.evaluate(({ y0, band, w, h }) => {
      const px = window.__frame;
      const rows = Math.min(band, h - y0);
      const slice = px.subarray(y0 * w * 4, (y0 + rows) * w * 4);
      let bin = '';
      const CH = 0x8000;
      for (let i = 0; i < slice.length; i += CH) bin += String.fromCharCode.apply(null, slice.subarray(i, i + CH));
      return btoa(bin);
    }, { y0, band: BAND, w: probe.w, h: probe.h }));
  }
  await page.evaluate(() => { window.__frame = null; });

  writeFileSync(resolve(outDir, `${s.id}.png`), encodePng({ ...probe, bands }));
  process.stdout.write(`  image mean=${probe.mean}\n`);

  // The DOM HUD composites fine, so grab it separately when asked for.
  if (withHud) {
    await page.screenshot({ path: resolve(outDir, `${s.id}_hud.png`), animations: 'disabled', caret: 'hide' });
  }
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
