import { chromium } from 'playwright';
import { createServer } from 'vite';
const server = await createServer({ root: new URL('..', import.meta.url).pathname, server: { port: 5211, host: '127.0.0.1' }, logLevel: 'error' });
await server.listen();
const browser = await chromium.launch({
  executablePath: '/opt/pw-browsers/chromium-1194/chrome-linux/chrome',
  args: ['--use-gl=angle','--use-angle=swiftshader','--enable-unsafe-swiftshader','--no-sandbox','--force-device-scale-factor=1'],
});
const page = await browser.newPage({ viewport: { width: 1920, height: 1080 } });
page.setDefaultTimeout(180000);
await page.goto('http://127.0.0.1:5211/?quality=low', { waitUntil: 'load' });
await page.waitForFunction(() => !!window.__game, { timeout: 150000 });
await page.waitForFunction(() => window.__game.engine.frame > 20, { timeout: 150000 }).catch(()=>{});
const r = await page.evaluate(() => {
  const { ctx, engine } = window.__game;
  const gl = ctx.renderer.getContext();
  const c = ctx.renderer.domElement;
  const vp = new (window.__game.ctx.camera.constructor.prototype.constructor === Function ? Object : Object)();
  const size = ctx.renderer.getSize(new (Object.getPrototypeOf(ctx.camera.position).constructor)());
  const comp = engine.composer;
  return {
    canvas: { w: c.width, h: c.height, clientW: c.clientWidth, clientH: c.clientHeight },
    rendererSize: { w: size.x, h: size.y }, pixelRatio: ctx.renderer.getPixelRatio(),
    glDrawingBuffer: { w: gl.drawingBufferWidth, h: gl.drawingBufferHeight },
    glViewport: Array.from(gl.getParameter(gl.VIEWPORT)),
    glScissorBox: Array.from(gl.getParameter(gl.SCISSOR_BOX)),
    glScissorEnabled: gl.getParameter(gl.SCISSOR_TEST),
    composer: { w: comp._width, h: comp._height, pr: comp._pixelRatio,
                rt1: [comp.renderTarget1.width, comp.renderTarget1.height],
                rt2: [comp.renderTarget2.width, comp.renderTarget2.height] },
    innerW: window.innerWidth, innerH: window.innerHeight, dpr: window.devicePixelRatio,
    passes: comp.passes.map(p => p.constructor.name),
  };
});
console.log(JSON.stringify(r, null, 2));
await browser.close(); await server.close();
