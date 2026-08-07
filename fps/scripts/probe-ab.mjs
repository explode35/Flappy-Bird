/**
 * A/B diagnostic for the black-capture failure.
 *
 * Two runs of shoot.mjs and one run of probe-black.mjs disagree about the same
 * camera: the harness writes a pure-black PNG at 01_spawn while probe-black
 * reads 210,200,178 there. The two differ in exactly two ways — the harness
 * also sets fov/updateProjectionMatrix/viewCamera/forceADS, and it reads inside
 * the same evaluate as the rAF wait instead of a following one. This isolates
 * which of those two matters.
 */
import { chromium } from 'playwright';
import { createServer } from 'vite';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const server = await createServer({ root, server: { port: 5217, host: '127.0.0.1' }, logLevel: 'error' });
await server.listen();
const browser = await chromium.launch({
  executablePath: '/opt/pw-browsers/chromium-1194/chrome-linux/chrome',
  args: ['--use-gl=angle', '--use-angle=swiftshader', '--enable-unsafe-swiftshader', '--no-sandbox'],
});
const page = await browser.newPage({ viewport: { width: 640, height: 360 } });
page.setDefaultTimeout(240000);
page.on('pageerror', (e) => console.log('[pageerror]', e.message));
await page.goto('http://127.0.0.1:5217/?quality=low&capture=1', { waitUntil: 'load' });
await page.waitForFunction(() => !!window.__game, { timeout: 220000 });
await page.waitForFunction(() => window.__game.engine.frame > 25, { timeout: 220000 }).catch(() => {});
await page.waitForTimeout(2000);

const CAMS = [
  ['01_spawn',   [0, 1.68, 34],   [0, 1.5, 0]],
  ['08_closeup', [-9, 1.45, 3],   [-9.9, 1.3, 1.2]],
  ['05_interior', [-14, 1.55, -6], [-2, 1.5, -10]],
];

// `full` replays everything shoot.mjs does to the camera; `bare` replays only
// what probe-black does. If the means differ, the extra setup is the culprit.
const setup = async (pos, look, mode) => {
  await page.evaluate(({ pos, look, mode }) => {
    const { ctx, engine } = window.__game;
    engine.paused = true;
    if (ctx.player) ctx.player.frozen = true;
    const cam = ctx.camera;
    cam.position.set(...pos);
    cam.lookAt(...look);
    if (mode === 'full') {
      cam.fov = 80;
      cam.updateProjectionMatrix();
    }
    cam.updateMatrixWorld(true);
    if (mode === 'full') {
      if (ctx.viewCamera) {
        ctx.viewCamera.quaternion.copy(cam.quaternion);
        ctx.viewCamera.updateMatrixWorld(true);
      }
      ctx.weapons?.forceADS?.(false);
    }
  }, { pos, look, mode });
};

// Read A: inside the same evaluate as the rAF wait (what shoot.mjs does).
const readInline = () => page.evaluate(async () => {
  const raf = () => new Promise((r) => requestAnimationFrame(r));
  for (let i = 0; i < 6; i++) await raf();
  const c = document.querySelector('canvas');
  const gl = window.__game.ctx.renderer.getContext();
  const px = new Uint8Array(4);
  gl.readPixels(c.width >> 1, c.height >> 1, 1, 1, gl.RGBA, gl.UNSIGNED_BYTE, px);
  return Math.round((px[0] + px[1] + px[2]) / 3);
});

// Read B: a following evaluate, i.e. a separate task (what probe-black does).
const readSplit = async () => {
  await page.evaluate(async () => {
    const raf = () => new Promise((r) => requestAnimationFrame(r));
    for (let i = 0; i < 6; i++) await raf();
  });
  return page.evaluate(() => {
    const c = document.querySelector('canvas');
    const gl = window.__game.ctx.renderer.getContext();
    const px = new Uint8Array(4);
    gl.readPixels(c.width >> 1, c.height >> 1, 1, 1, gl.RGBA, gl.UNSIGNED_BYTE, px);
    return Math.round((px[0] + px[1] + px[2]) / 3);
  });
};

// Read C: split, and also report what toDataURL sees, since the PNG is what
// actually matters and it may disagree with readPixels.
const readUrlMean = () => page.evaluate(() => {
  const c = document.querySelector('canvas');
  const t = document.createElement('canvas');
  t.width = 64; t.height = 36;
  const g = t.getContext('2d');
  g.drawImage(c, 0, 0, 64, 36);
  const d = g.getImageData(0, 0, 64, 36).data;
  let s = 0;
  for (let i = 0; i < d.length; i += 4) s += (d[i] + d[i + 1] + d[i + 2]) / 3;
  return Math.round(s / (d.length / 4));
});

for (const [id, pos, look] of CAMS) {
  for (const mode of ['bare', 'full']) {
    await setup(pos, look, mode);
    const a = await readInline();
    await setup(pos, look, mode);
    const b = await readSplit();
    const c = await readUrlMean();
    console.log(`${id.padEnd(12)} ${mode.padEnd(5)}  inline=${String(a).padStart(3)}  split=${String(b).padStart(3)}  canvasMean=${String(c).padStart(3)}`);
  }
}

await browser.close();
await server.close();
