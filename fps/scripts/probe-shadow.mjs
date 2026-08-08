/**
 * Are the sun's shadows contributing anything outdoors?
 *
 * The review says no cast shadows appear anywhere in the exterior across two
 * sweeps, with an 8.5 degree sun and 6-10 m buildings that should be laying
 * 40 m shadows down the plaza. Eyeballing a 640x360 frame cannot separate
 * "the shadow term is drowned by ambient" from "nothing is being rendered
 * into the shadow map". This measures it: same camera, shadows on and off.
 *
 * If the two means match to within a fraction of a percent, no shadow is
 * reaching the frame at all and the problem is the shadow pass. If they
 * differ but the frame still looks flat, the shadows are there and the
 * ambient ratio is burying them.
 */
import { chromium } from 'playwright';
import { createServer } from 'vite';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const server = await createServer({ root, server: { port: 5223, host: '127.0.0.1' }, logLevel: 'error' });
await server.listen();
const browser = await chromium.launch({
  executablePath: '/opt/pw-browsers/chromium-1194/chrome-linux/chrome',
  args: ['--use-gl=angle', '--use-angle=swiftshader', '--enable-unsafe-swiftshader', '--no-sandbox'],
});
const page = await browser.newPage({ viewport: { width: 640, height: 360 } });
page.setDefaultTimeout(240000);
page.on('pageerror', (e) => console.log('[pageerror]', e.message));
await page.goto('http://127.0.0.1:5223/?quality=medium&capture=1', { waitUntil: 'load' });
await page.waitForFunction(() => !!window.__game, { timeout: 220000 });
await page.waitForFunction(() => window.__game.engine.frame > 25, { timeout: 220000 }).catch(() => {});
await page.waitForTimeout(2500);

const CAMS = [
  ['10_combat', [4, 1.68, 12], [-6, 1.6, -14]],
  ['14_cornice', [-2.0, 1.68, 18], [-7.5, 3.4, 4]],
];

for (const [id, pos, look] of CAMS) {
  for (const mode of ['shadows-on', 'shadows-off', 'no-ambient']) {
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

      const sun = ctx.sky.sunLight, fill = ctx.sky.fillLight;
      sun.castShadow = mode !== 'shadows-off';
      // Strip everything that could be burying the shadow, so the third row
      // isolates the shadow term on its own.
      if (mode === 'no-ambient') {
        fill.intensity = 0;
        ctx.scene.environmentIntensity = 0.02;
      } else {
        fill.intensity = 0.95;
        ctx.scene.environmentIntensity = 0.26;
      }

      for (let i = 0; i < 8; i++) await new Promise((res) => requestAnimationFrame(res));
      const c = document.querySelector('canvas');
      const gl = ctx.renderer.getContext();
      const px = new Uint8Array(c.width * c.height * 4);
      gl.readPixels(0, 0, c.width, c.height, gl.RGBA, gl.UNSIGNED_BYTE, px);
      // Sample the bottom third only: that is the ground plane, which is where
      // a 40 m cast shadow would land.
      let sum = 0, n = 0, lo = 0;
      const rowStart = 0, rowEnd = Math.floor(c.height / 3) * c.width * 4;
      for (let i = rowStart; i < rowEnd; i += 4 * 17) {
        const v = (px[i] + px[i + 1] + px[i + 2]) / 3;
        sum += v; n++;
        if (v < 60) lo++;
      }
      const sm = sun.shadow.map;
      return {
        ground: Math.round(sum / n),
        darkPct: Math.round((lo / n) * 100),
        mapSize: sm ? `${sm.width}x${sm.height}` : 'NONE',
        sunDir: [ctx.sky.sunDirection.x, ctx.sky.sunDirection.y, ctx.sky.sunDirection.z]
          .map((v) => v.toFixed(2)).join(','),
        lightY: +sun.position.y.toFixed(1),
        camNear: sun.shadow.camera.near, camFar: sun.shadow.camera.far,
        extent: sun.shadow.camera.right,
        autoUpdate: ctx.renderer.shadowMap.autoUpdate,
        enabled: ctx.renderer.shadowMap.enabled,
      };
    }, { pos, look, mode });
    console.log(
      `${id.padEnd(11)} ${mode.padEnd(12)} groundMean=${String(r.ground).padStart(3)} dark<60=${String(r.darkPct).padStart(3)}%  ` +
      `map=${r.mapSize} lightY=${r.lightY} near=${r.camNear} far=${r.camFar} extent=${r.extent} sun=(${r.sunDir}) on=${r.enabled}`
    );
  }
}

await browser.close();
await server.close();
