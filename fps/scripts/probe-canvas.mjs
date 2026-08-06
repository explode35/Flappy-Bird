import { chromium } from 'playwright';
import { createServer } from 'vite';
import { writeFileSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const server = await createServer({ root, server: { port: 5212, host: '127.0.0.1' }, logLevel: 'error' });
await server.listen();
const browser = await chromium.launch({
  executablePath: '/opt/pw-browsers/chromium-1194/chrome-linux/chrome',
  args: ['--use-gl=angle','--use-angle=swiftshader','--enable-unsafe-swiftshader','--no-sandbox','--force-device-scale-factor=1'],
});
const page = await browser.newPage({ viewport: { width: 1280, height: 720 } });
page.setDefaultTimeout(200000);
await page.goto('http://127.0.0.1:5212/?quality=low&capture=1', { waitUntil: 'load' });
await page.waitForFunction(() => !!window.__game, { timeout: 180000 });
await page.waitForFunction(() => window.__game.engine.frame > 25, { timeout: 180000 }).catch(()=>{});
await page.waitForTimeout(3000);

// Put the camera somewhere with plenty in front of it.
await page.evaluate(() => {
  const { ctx, engine } = window.__game;
  engine.paused = true;
  if (ctx.player) ctx.player.frozen = true;
  ctx.camera.position.set(4, 1.68, 12);
  ctx.camera.lookAt(-6, 1.6, -14);
  ctx.camera.updateMatrixWorld(true);
});
await page.evaluate(async () => { for (let i=0;i<6;i++) await new Promise(r=>requestAnimationFrame(r)); });

const r = await page.evaluate(() => {
  const c = document.querySelector('canvas');
  const url = c.toDataURL('image/png');
  // Sample the GL buffer directly too.
  const gl = window.__game.ctx.renderer.getContext();
  const px = new Uint8Array(4 * 16);
  gl.readPixels(c.width/2 - 2, c.height/2 - 2, 4, 4, gl.RGBA, gl.UNSIGNED_BYTE, px);
  // Which DOM nodes actually cover screen centre?
  const stack = document.elementsFromPoint(window.innerWidth/2, window.innerHeight/2)
    .map(e => `${e.tagName}.${e.className||''}`);
  const ui = document.getElementById('ui');
  const covering = [...ui.querySelectorAll('*')].filter(e => {
    const s = getComputedStyle(e); const b = e.getBoundingClientRect();
    return s.display !== 'none' && +s.opacity > 0.5 && b.width > window.innerWidth*0.8 && b.height > window.innerHeight*0.8;
  }).map(e => `${e.className} op=${getComputedStyle(e).opacity} bg=${getComputedStyle(e).backgroundColor}`);
  return { dataUrl: url, glCentrePixels: Array.from(px.slice(0,12)), stack, covering,
           canvasW: c.width, canvasH: c.height };
});
console.log('GL centre pixels RGB:', r.glCentrePixels.join(','));
console.log('canvas backing:', r.canvasW, 'x', r.canvasH);
console.log('elementsFromPoint(centre):', JSON.stringify(r.stack));
console.log('full-screen opaque #ui children:', JSON.stringify(r.covering, null, 1));
writeFileSync(resolve(root, '../.review/canvas-direct.png'), Buffer.from(r.dataUrl.split(',')[1], 'base64'));
console.log('wrote .review/canvas-direct.png');
await page.screenshot({ path: resolve(root, '../.review/page-shot.png') });
await browser.close(); await server.close();
