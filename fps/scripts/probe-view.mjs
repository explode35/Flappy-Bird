/**
 * Isolates the last difference between the harness and the probes.
 *
 * probe-diag.mjs renders 01_spawn at 187. shoot.mjs renders the same camera,
 * same viewport, same quality, at 0. The only things shoot.mjs does that the
 * probe does not are copying the world camera's rotation onto the viewmodel
 * camera and calling weapons.forceADS(false). This applies them one at a time.
 */
import { chromium } from 'playwright';
import { createServer } from 'vite';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const server = await createServer({ root, server: { port: 5221, host: '127.0.0.1' }, logLevel: 'error' });
await server.listen();
const browser = await chromium.launch({
  executablePath: '/opt/pw-browsers/chromium-1194/chrome-linux/chrome',
  args: ['--use-gl=angle', '--use-angle=swiftshader', '--enable-unsafe-swiftshader', '--no-sandbox'],
});
const page = await browser.newPage({ viewport: { width: 640, height: 360 } });
page.setDefaultTimeout(240000);
page.on('pageerror', (e) => console.log('[pageerror]', e.message));
await page.goto('http://127.0.0.1:5221/?quality=low&capture=1', { waitUntil: 'load' });
await page.waitForFunction(() => !!window.__game, { timeout: 220000 });
await page.waitForFunction(() => window.__game.engine.frame > 25, { timeout: 220000 }).catch(() => {});
await page.waitForTimeout(2000);

const CAMS = [
  ['01_spawn', [0, 1.68, 34], [0, 1.5, 0]],
  ['05_interior', [-14, 1.55, -6], [-2, 1.5, -10]],
];
const MODES = ['plain', 'viewcam', 'ads', 'both'];

for (const [id, pos, look] of CAMS) {
  for (const mode of MODES) {
    const r = await page.evaluate(async ({ pos, look, mode }) => {
      const { ctx, engine } = window.__game;
      const cam = ctx.camera;
      engine.paused = true;
      if (ctx.player) ctx.player.frozen = true;
      cam.fov = 80;
      cam.position.set(...pos);
      cam.lookAt(...look);
      cam.updateProjectionMatrix();
      cam.updateMatrixWorld(true);
      if ((mode === 'viewcam' || mode === 'both') && ctx.viewCamera) {
        ctx.viewCamera.quaternion.copy(cam.quaternion);
        ctx.viewCamera.updateMatrixWorld(true);
      }
      if ((mode === 'ads' || mode === 'both') && ctx.weapons?.forceADS) ctx.weapons.forceADS(false);

      for (let i = 0; i < 6; i++) await new Promise((res) => requestAnimationFrame(res));
      const c = document.querySelector('canvas');
      const gl = ctx.renderer.getContext();
      const px = new Uint8Array(c.width * c.height * 4);
      gl.readPixels(0, 0, c.width, c.height, gl.RGBA, gl.UNSIGNED_BYTE, px);
      let sum = 0, n = 0;
      for (let i = 0; i < px.length; i += 4 * 31, n++) sum += (px[i] + px[i + 1] + px[i + 2]) / 3;
      const vc = ctx.viewCamera;
      return {
        mean: Math.round(sum / n),
        viewChildren: ctx.viewScene?.children.length ?? -1,
        vcPos: vc ? [vc.position.x, vc.position.y, vc.position.z].map((v) => +v.toFixed(2)).join(',') : '-',
        vcFov: vc?.fov, vcNear: vc?.near, vcFar: vc?.far,
      };
    }, { pos, look, mode });
    console.log(`${id.padEnd(12)} ${mode.padEnd(8)} mean=${String(r.mean).padStart(3)}  ` +
      `viewScene=${r.viewChildren} viewCam pos=${r.vcPos} fov=${r.vcFov} near=${r.vcNear} far=${r.vcFar}`);
  }
  // Reset between cameras so a sticky state does not carry over.
  await page.evaluate(() => {
    const { ctx } = window.__game;
    if (ctx.viewCamera) { ctx.viewCamera.quaternion.identity(); ctx.viewCamera.updateMatrixWorld(true); }
  });
}

await browser.close();
await server.close();
