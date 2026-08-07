/**
 * Where does the black come from?
 *
 * probe-ab.mjs showed the canvas itself is genuinely black at some cameras and
 * bright at others, and that it is not a readback artefact (a 2D drawImage of
 * the canvas agrees with gl.readPixels). So something in the render produces
 * black. This walks the pipeline for each camera and reports:
 *
 *   calls/tris  — did the world pass draw anything at all?
 *   composer    — what the shipping pipeline puts on screen
 *   direct      — renderer.render(scene, camera) straight to the canvas
 *   noGtao      — composer with the GTAO pass disabled
 *   noBloom     — composer with the bloom pass disabled
 *
 * `direct` bright + `composer` black isolates it to post. `direct` black too
 * isolates it to the scene or the camera.
 */
import { chromium } from 'playwright';
import { createServer } from 'vite';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const server = await createServer({ root, server: { port: 5219, host: '127.0.0.1' }, logLevel: 'error' });
await server.listen();
const browser = await chromium.launch({
  executablePath: '/opt/pw-browsers/chromium-1194/chrome-linux/chrome',
  args: ['--use-gl=angle', '--use-angle=swiftshader', '--enable-unsafe-swiftshader', '--no-sandbox'],
});
const page = await browser.newPage({ viewport: { width: 640, height: 360 } });
page.setDefaultTimeout(240000);
page.on('pageerror', (e) => console.log('[pageerror]', e.message));
await page.goto('http://127.0.0.1:5219/?quality=low&capture=1', { waitUntil: 'load' });
await page.waitForFunction(() => !!window.__game, { timeout: 220000 });
await page.waitForFunction(() => window.__game.engine.frame > 25, { timeout: 220000 }).catch(() => {});
await page.waitForTimeout(2000);

await page.evaluate(() => {
  const { engine } = window.__game;
  // Sample the canvas without going through a 2D context every time.
  window.__mean = () => {
    const c = document.querySelector('canvas');
    const gl = window.__game.ctx.renderer.getContext();
    const w = c.width, h = c.height;
    const px = new Uint8Array(w * h * 4);
    gl.readPixels(0, 0, w, h, gl.RGBA, gl.UNSIGNED_BYTE, px);
    let s = 0;
    for (let i = 0; i < px.length; i += 4 * 37) s += (px[i] + px[i + 1] + px[i + 2]) / 3;
    return Math.round(s / Math.ceil(px.length / (4 * 37)));
  };
  window.__raf = (n = 6) => new Promise((res) => {
    let i = 0;
    const step = () => (++i >= n ? res() : requestAnimationFrame(step));
    requestAnimationFrame(step);
  });
  window.__passes = engine.composer.passes;
});

const CAMS = [
  ['01_spawn', [0, 1.68, 34], [0, 1.5, 0]],
  ['08_closeup', [-9, 1.45, 3], [-9.9, 1.3, 1.2]],
  ['02_plaza', [1, 1.68, 22], [-2, 2.2, -26]],
  ['05_interior', [-14, 1.55, -6], [-2, 1.5, -10]],
];

for (const [id, pos, look] of CAMS) {
  const r = await page.evaluate(async ({ pos, look }) => {
    const { ctx, engine } = window.__game;
    const cam = ctx.camera;
    engine.paused = true;
    if (ctx.player) ctx.player.frozen = true;
    cam.fov = 80;
    cam.position.set(...pos);
    cam.lookAt(...look);
    cam.updateProjectionMatrix();
    cam.updateMatrixWorld(true);

    await window.__raf(6);
    const composer = window.__mean();
    const info = ctx.renderer.info.render;
    const calls = info.calls, tris = info.triangles;

    // Direct render to the canvas, same task, then read before the engine's
    // next frame can overwrite it.
    const rd = ctx.renderer;
    rd.setRenderTarget(null);
    rd.clear(true, true, true);
    rd.render(ctx.scene, cam);
    const direct = window.__mean();

    const gtao = engine.gtao, bloom = engine.bloom;
    let noGtao = -1, noBloom = -1;
    if (gtao) { gtao.enabled = false; await window.__raf(4); noGtao = window.__mean(); gtao.enabled = true; }
    if (bloom) { bloom.enabled = false; await window.__raf(4); noBloom = window.__mean(); bloom.enabled = true; }

    return {
      calls, tris, composer, direct, noGtao, noBloom,
      near: cam.near, far: cam.far, fov: cam.fov, aspect: +cam.aspect.toFixed(3),
      passes: engine.composer.passes.map((p) => p.constructor.name).join('>'),
      dpr: ctx.renderer.getPixelRatio(),
    };
  }, { pos, look });
  console.log(
    `${id.padEnd(12)} calls=${String(r.calls).padStart(4)} tris=${String(r.tris).padStart(7)} ` +
    `composer=${String(r.composer).padStart(3)} direct=${String(r.direct).padStart(3)} ` +
    `noGtao=${String(r.noGtao).padStart(3)} noBloom=${String(r.noBloom).padStart(3)} ` +
    `near=${r.near} far=${r.far} dpr=${r.dpr}`
  );
}
console.log('passes:', await page.evaluate(() => window.__game.engine.composer.passes.map((p) => p.constructor.name).join(' > ')));

await browser.close();
await server.close();
