/**
 * What happens to the frame when you pull the trigger?
 *
 * Reported: firing makes the game glitch, go black for a few seconds, then
 * run jumpy. Three candidate causes with very different fixes — a shader
 * compile stall the first time each effect material is used, a NaN getting
 * into the HDR buffer and being spread over the whole frame by bloom (which is
 * exactly what the viewmodel anisotropy bug did), or the dynamic-resolution
 * governor thrashing after a frame-time spike.
 *
 * They are trivial to tell apart if you measure instead of guess: sample
 * per-frame delta time, screen brightness, program count and the governor's
 * scale, before, during and after a burst.
 *
 *   node scripts/probe-fire.mjs
 */
import { chromium } from 'playwright';
import { createServer } from 'vite';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const server = await createServer({ root, server: { port: 5243, host: '127.0.0.1' }, logLevel: 'error' });
await server.listen();
const browser = await chromium.launch({
  executablePath: '/opt/pw-browsers/chromium-1194/chrome-linux/chrome',
  args: ['--use-gl=angle', '--use-angle=swiftshader', '--enable-unsafe-swiftshader', '--no-sandbox'],
});
const page = await browser.newPage({ viewport: { width: 640, height: 360 } });
page.setDefaultTimeout(240000);

const errs = [];
page.on('pageerror', (e) => errs.push(`[pageerror] ${e.message}`));
page.on('console', (m) => { if (m.type() === 'error') errs.push(`[console] ${m.text()}`); });

await page.goto('http://127.0.0.1:5243/?quality=medium&capture=1', { waitUntil: 'load' });
await page.waitForFunction(() => !!window.__game, { timeout: 220000 });
await page.waitForFunction(() => window.__game.engine.frame > 30, { timeout: 220000 }).catch(() => {});
await page.waitForTimeout(2500);

const rows = await page.evaluate(async () => {
  const { ctx, engine } = window.__game;
  ctx.enemies?.clearAll?.();
  ctx.player.respawn?.();
  ctx.input.locked = true;
  ctx.bus.emit('input:lock', {});          // the real path: starts audio too
  for (let i = 0; i < 20; i++) await new Promise((r) => requestAnimationFrame(r));

  const c = document.querySelector('canvas');
  const gl = ctx.renderer.getContext();
  // Small sample: this runs every frame, so it must not itself be the stall.
  const sample = () => {
    const px = new Uint8Array(4 * 64);
    let sum = 0;
    for (let i = 0; i < 8; i++) {
      const p = new Uint8Array(4);
      gl.readPixels((c.width * (i + 1) / 9) | 0, c.height >> 1, 1, 1, gl.RGBA, gl.UNSIGNED_BYTE, p);
      sum += (p[0] + p[1] + p[2]) / 3;
    }
    void px;
    return Math.round(sum / 8);
  };

  const out = [];
  let last = performance.now();
  const step = async (label) => {
    await new Promise((r) => requestAnimationFrame(r));
    const now = performance.now();
    const dt = now - last;
    last = now;
    out.push({
      label,
      ms: Math.round(dt),
      mean: sample(),
      programs: ctx.renderer.info.programs?.length ?? 0,
      dpr: +ctx.renderer.getPixelRatio().toFixed(2),
      calls: ctx.renderer.info.render.calls,
    });
  };

  for (let i = 0; i < 12; i++) await step('idle');
  window.dispatchEvent(new MouseEvent('mousedown', { button: 0, bubbles: true }));
  for (let i = 0; i < 30; i++) await step('FIRING');
  window.dispatchEvent(new MouseEvent('mouseup', { button: 0, bubbles: true }));
  for (let i = 0; i < 45; i++) await step('after');
  return out;
});

console.log('phase    frame   ms   mean  programs  dpr   calls');
let prevPrograms = rows[0].programs;
for (let i = 0; i < rows.length; i++) {
  const r = rows[i];
  const grew = r.programs > prevPrograms ? `  +${r.programs - prevPrograms} SHADERS` : '';
  prevPrograms = r.programs;
  const slow = r.ms > 120 ? '  <-- STALL' : '';
  const dark = r.mean < 6 ? '  <-- BLACK' : '';
  console.log(
    `${r.label.padEnd(8)} ${String(i).padStart(3)}  ${String(r.ms).padStart(4)}  ` +
    `${String(r.mean).padStart(4)}  ${String(r.programs).padStart(6)}  ${String(r.dpr).padStart(4)}  ` +
    `${String(r.calls).padStart(5)}${grew}${slow}${dark}`
  );
}

const idle = rows.filter((r) => r.label === 'idle');
const fire = rows.filter((r) => r.label === 'FIRING');
const after = rows.filter((r) => r.label === 'after');
const avg = (a) => Math.round(a.reduce((s, r) => s + r.ms, 0) / Math.max(1, a.length));
const worst = (a) => Math.max(...a.map((r) => r.ms));
console.log(`\nidle   avg ${avg(idle)} ms, worst ${worst(idle)} ms`);
console.log(`firing avg ${avg(fire)} ms, worst ${worst(fire)} ms`);
console.log(`after  avg ${avg(after)} ms, worst ${worst(after)} ms`);
console.log(`black frames: ${rows.filter((r) => r.mean < 6).length} of ${rows.length}`);
console.log(`shader programs: ${rows[0].programs} -> ${rows[rows.length - 1].programs}`);
if (errs.length) console.log(`\n${errs.length} errors:\n` + [...new Set(errs)].slice(0, 4).join('\n'));

await browser.close();
await server.close();
