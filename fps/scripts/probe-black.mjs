import { chromium } from 'playwright';
import { createServer } from 'vite';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const server = await createServer({ root, server: { port: 5213, host: '127.0.0.1' }, logLevel: 'error' });
await server.listen();
const browser = await chromium.launch({
  executablePath: '/opt/pw-browsers/chromium-1194/chrome-linux/chrome',
  args: ['--use-gl=angle','--use-angle=swiftshader','--enable-unsafe-swiftshader','--no-sandbox'],
});
const page = await browser.newPage({ viewport: { width: 640, height: 360 } });
page.setDefaultTimeout(240000);
await page.goto('http://127.0.0.1:5213/?quality=low&capture=1', { waitUntil: 'load' });
await page.waitForFunction(() => !!window.__game, { timeout: 220000 });
await page.waitForFunction(() => window.__game.engine.frame > 25, { timeout: 220000 }).catch(()=>{});
await page.waitForTimeout(2000);

const sample = async (label, pos, look, tweak) => {
  await page.evaluate(({ pos, look, tweak }) => {
    const { ctx, engine } = window.__game;
    engine.paused = true;
    if (ctx.player) ctx.player.frozen = true;
    ctx.camera.position.set(...pos);
    ctx.camera.lookAt(...look);
    ctx.camera.updateMatrixWorld(true);
    if (tweak === 'nofog') { ctx.scene.fog = null; ctx.sky?.fog?.setFogParams?.({ density: 0 }); }
    if (tweak === 'nograde') {
      const u = engine.grade.uniforms;
      u.uVignette.value = 0; u.uDamage.value = 0; u.uLowHealth.value = 0;
      u.uGain.value.set(1,1,1); u.uLift.value.set(0,0,0); u.uContrast.value = 1;
    }
  }, { pos, look, tweak });
  await page.evaluate(async () => { for (let i=0;i<6;i++) await new Promise(r=>requestAnimationFrame(r)); });
  const r = await page.evaluate(() => {
    const c = document.querySelector('canvas');
    const gl = window.__game.ctx.renderer.getContext();
    const grid = [];
    for (const [fx, fy] of [[0.5,0.5],[0.5,0.15],[0.5,0.85],[0.15,0.5],[0.85,0.5]]) {
      const px = new Uint8Array(4);
      gl.readPixels(Math.floor(c.width*fx), Math.floor(c.height*fy), 1, 1, gl.RGBA, gl.UNSIGNED_BYTE, px);
      grid.push(`${px[0]},${px[1]},${px[2]}`);
    }
    const f = window.__game.ctx.scene.fog;
    const u = window.__game.engine.grade.uniforms;
    return { grid, fog: f ? `${f.constructor.name} d=${f.density??''}` : 'none',
      exposure: window.__game.ctx.renderer.toneMappingExposure,
      grade: `vig=${u.uVignette.value} dmg=${u.uDamage.value.toFixed(2)} low=${u.uLowHealth.value.toFixed(2)} flash=${u.uFlash.value.toFixed(2)}`,
      visible: window.__game.ctx.scene.children.filter(o=>o.visible).length };
  });
  console.log(`${label.padEnd(22)} centre/top/bot/left/right = ${r.grid.join(' | ')}`);
  console.log(`  fog=${r.fog} exp=${r.exposure} ${r.grade} sceneChildren=${r.visible}`);
};

await sample('probe-cam (worked)', [4,1.68,12], [-6,1.6,-14]);
await sample('01_spawn', [0,1.68,34], [0,1.5,0]);
await sample('01_spawn nofog', [0,1.68,34], [0,1.5,0], 'nofog');
await sample('01_spawn nograde', [0,1.68,34], [0,1.5,0], 'nograde');
await browser.close(); await server.close();
