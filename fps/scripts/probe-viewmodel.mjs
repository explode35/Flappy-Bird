/**
 * Look at the gun.
 *
 * The viewmodel was never once rendered into a frame anybody inspected. It was
 * parented into the wrong node, and once that was fixed it turned out to be
 * framed wrong as well — a full-size rifle sitting 0.335 m from a 55-degree
 * camera is around two and a half screen-heights tall, which is why weapon 1
 * blacked the screen out: the player was inside the receiver.
 *
 * This equips each weapon in turn, measures its bounding box in camera space,
 * works out what fraction of the frame it covers, and writes a PNG of each so
 * the framing can actually be judged rather than assumed.
 *
 *   node scripts/probe-viewmodel.mjs [outDir]
 */
import { chromium } from 'playwright';
import { createServer } from 'vite';
import { PNG } from 'pngjs';
import { mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const outDir = resolve(process.argv[2] || resolve(root, '../.review/viewmodel'));
rmSync(outDir, { recursive: true, force: true });
mkdirSync(outDir, { recursive: true });

function encodePng({ w, h, bands }) {
  const src = Buffer.concat(bands.map((b) => Buffer.from(b, 'base64')));
  const png = new PNG({ width: w, height: h });
  const stride = w * 4;
  for (let y = 0; y < h; y++) src.copy(png.data, y * stride, (h - 1 - y) * stride, (h - y) * stride);
  return PNG.sync.write(png);
}

const server = await createServer({ root, server: { port: 5237, host: '127.0.0.1' }, logLevel: 'error' });
await server.listen();
const browser = await chromium.launch({
  executablePath: '/opt/pw-browsers/chromium-1194/chrome-linux/chrome',
  args: ['--use-gl=angle', '--use-angle=swiftshader', '--enable-unsafe-swiftshader', '--no-sandbox'],
});
const page = await browser.newPage({ viewport: { width: 640, height: 360 } });
page.setDefaultTimeout(240000);
page.on('pageerror', (e) => console.log('[pageerror]', e.message));

await page.goto('http://127.0.0.1:5237/?quality=medium&capture=1', { waitUntil: 'load' });
await page.waitForFunction(() => !!window.__game, { timeout: 220000 });
await page.waitForFunction(() => window.__game.engine.frame > 30, { timeout: 220000 }).catch(() => {});
await page.waitForTimeout(2500);

// A stable outdoor camera looking away from the sun, so the viewmodel is the
// only thing that changes between shots.
await page.evaluate(() => {
  const { ctx } = window.__game;
  ctx.input.locked = true;
  ctx.player.frozen = false;
  ctx.player.dead = false;
  // Down the plaza from the spawn pad, so there is a lit town behind the gun.
  ctx.player.yaw = 0.15;
  ctx.player.pitch = -0.04;
});

const aim = () => page.evaluate(() => {
  const { ctx } = window.__game;
  ctx.player.yaw = 0.15;
  ctx.player.pitch = -0.04;
  ctx.camera.updateMatrixWorld(true);
});

const grabOnce = () => page.evaluate(async () => {
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

/**
 * Same retry the screenshot harness needs: a frame read across a task boundary
 * comes back pure black some of the time on this container's software GL. All
 * three weapons came back black on the first pass here and it had nothing to
 * do with the weapons.
 */
const grab = async () => {
  let p = await grabOnce();
  for (let i = 1; i < 4 && p.mean === 0; i++) {
    process.stdout.write(`  black frame, retry ${i}\n`);
    await aim();
    await page.waitForTimeout(250);
    p = await grabOnce();
  }
  return p;
};

const bands = async (probe) => {
  const out = [];
  for (let y0 = 0; y0 < probe.h; y0 += 45) {
    out.push(await page.evaluate(({ y0, w, h }) => {
      const px = window.__frame;
      const rows = Math.min(45, h - y0);
      const slice = px.subarray(y0 * w * 4, (y0 + rows) * w * 4);
      let bin = '';
      for (let i = 0; i < slice.length; i += 0x8000) bin += String.fromCharCode.apply(null, slice.subarray(i, i + 0x8000));
      return btoa(bin);
    }, { y0, w: probe.w, h: probe.h }));
  }
  return out;
};

console.log('slot  weapon   size(m) LxHxD        centre in camera space      screen coverage');
for (let slot = 0; slot < 3; slot++) {
  const info = await page.evaluate(async (slot) => {
    const { ctx } = window.__game;
    const w = ctx.weapons;
    w._equip(slot, true);
    for (let i = 0; i < 8; i++) await new Promise((r) => requestAnimationFrame(r));

    const id = w.slots[slot];
    const model = w.models[id];
    const cam = ctx.viewCamera;
    cam.updateMatrixWorld(true);
    model.updateWorldMatrix(true, true);

    // Bounding box of the visible model, expressed in the view camera's space.
    const box = new window.__game.THREE.Box3().setFromObject(model);
    const size = box.getSize(new window.__game.THREE.Vector3());
    const centre = box.getCenter(new window.__game.THREE.Vector3());
    cam.worldToLocal(centre);

    // How much of the frame does it cover? Project the eight corners.
    const min = box.min, max = box.max;
    let x0 = 1e9, x1 = -1e9, y0 = 1e9, y1 = -1e9;
    for (const cx of [min.x, max.x]) for (const cy of [min.y, max.y]) for (const cz of [min.z, max.z]) {
      const v = new window.__game.THREE.Vector3(cx, cy, cz).project(cam);
      x0 = Math.min(x0, v.x); x1 = Math.max(x1, v.x);
      y0 = Math.min(y0, v.y); y1 = Math.max(y1, v.y);
    }
    return {
      id, name: w.def.name,
      size: [size.x, size.y, size.z].map((v) => +v.toFixed(3)),
      centre: [centre.x, centre.y, centre.z].map((v) => +v.toFixed(3)),
      // NDC spans 2 units, so half the projected span is the fraction covered.
      coverW: +((x1 - x0) / 2).toFixed(2),
      coverH: +((y1 - y0) / 2).toFixed(2),
      nearest: +(-Math.max(-1e9, centre.z)).toFixed(3),
    };
  }, slot);

  const probe = await grab();
  writeFileSync(resolve(outDir, `${slot + 1}_${info.id}.png`), encodePng({ ...probe, bands: await bands(probe) }));
  if (probe.mean === 0) {
    console.log('  !! still black after retries — this one is real');
    // Decisive: is the weapon covering the lens, or is the black coming from
    // somewhere else entirely? Hide the rig and look again.
    const noRig = await page.evaluate(async () => {
      const { ctx } = window.__game;
      ctx.weapons.rig.visible = false;
      for (let i = 0; i < 8; i++) await new Promise((r) => requestAnimationFrame(r));
      const c = document.querySelector('canvas');
      const gl = ctx.renderer.getContext();
      const px = new Uint8Array(c.width * c.height * 4);
      gl.readPixels(0, 0, c.width, c.height, gl.RGBA, gl.UNSIGNED_BYTE, px);
      let sum = 0, n = 0;
      for (let i = 0; i < px.length; i += 4 * 31, n++) sum += (px[i] + px[i + 1] + px[i + 2]) / 3;
      ctx.weapons.rig.visible = true;
      const info = ctx.renderer.info.render;
      return { mean: Math.round(sum / n), calls: info.calls, tris: info.triangles };
    });
    console.log(`     with rig hidden: mean=${noRig.mean}  (calls=${noRig.calls} tris=${noRig.tris})`);
    console.log(noRig.mean > 0
      ? '     => the viewmodel is what is blacking the frame'
      : '     => NOT the viewmodel; the world pass itself is black here');

    if (noRig.mean > 0) {
      // Bisect: hide one mesh at a time and see which one's absence brings the
      // frame back. Correlating properties of the failing weapons has produced
      // two wrong answers now (optics, then transmission), so stop reasoning
      // about what the culprit might be and just find it.
      const culprit = await page.evaluate(async () => {
        const { ctx } = window.__game;
        const meshes = [];
        ctx.weapons.rig.traverseVisible((o) => { if (o.isMesh || o.isSprite) meshes.push(o); });
        const read = () => {
          const c = document.querySelector('canvas');
          const gl = ctx.renderer.getContext();
          const px = new Uint8Array(c.width * c.height * 4);
          gl.readPixels(0, 0, c.width, c.height, gl.RGBA, gl.UNSIGNED_BYTE, px);
          let sum = 0, n = 0;
          for (let i = 0; i < px.length; i += 4 * 61, n++) sum += (px[i] + px[i + 1] + px[i + 2]) / 3;
          return Math.round(sum / n);
        };
        const found = [];
        for (const m of meshes) {
          m.visible = false;
          for (let i = 0; i < 5; i++) await new Promise((r) => requestAnimationFrame(r));
          const mean = read();
          m.visible = true;
          if (mean > 4) {
            found.push({
              name: m.name || m.parent?.name || '(unnamed)',
              mat: m.material?.name || m.material?.type || '?',
              kind: m.isSprite ? 'Sprite' : 'Mesh',
              mean,
            });
          }
        }
        return { total: meshes.length, found };
      });
      console.log(`     bisect: ${culprit.total} visible nodes tested`);
      if (!culprit.found.length) {
        console.log('       no single node is responsible — it is cumulative or state');
      } else {
        for (const f of culprit.found) {
          console.log(`       hiding ${f.kind} ${String(f.name).padEnd(16)} ${f.mat.padEnd(18)} -> mean ${f.mean}`);
        }
      }
    }

    if (false) {
      // Which node? The equipped model measures small, so something else under
      // the rig is large. Walk every visible mesh and report the worst.
      const worst = await page.evaluate(() => {
        const { ctx, THREE } = window.__game;
        const cam = ctx.viewCamera;
        cam.updateMatrixWorld(true);
        ctx.weapons.rig.updateWorldMatrix(true, true);
        const rows = [];
        ctx.weapons.rig.traverseVisible((o) => {
          if (!o.isMesh || !o.geometry) return;
          const box = new THREE.Box3().setFromObject(o);
          if (!isFinite(box.min.x)) return;
          let x0 = 1e9, x1 = -1e9, y0 = 1e9, y1 = -1e9, nearest = 1e9;
          for (const cx of [box.min.x, box.max.x])
            for (const cy of [box.min.y, box.max.y])
              for (const cz of [box.min.z, box.max.z]) {
                const v = new THREE.Vector3(cx, cy, cz);
                const local = cam.worldToLocal(v.clone());
                nearest = Math.min(nearest, -local.z);
                const p = v.project(cam);
                x0 = Math.min(x0, p.x); x1 = Math.max(x1, p.x);
                y0 = Math.min(y0, p.y); y1 = Math.max(y1, p.y);
              }
          rows.push({
            name: o.name || o.parent?.name || '(unnamed)',
            mat: o.material?.name || o.material?.type || '?',
            w: +((x1 - x0) / 2).toFixed(2), h: +((y1 - y0) / 2).toFixed(2),
            near: +nearest.toFixed(3),
          });
        });
        rows.sort((a, b) => (b.w * b.h) - (a.w * a.h));
        return rows.slice(0, 6);
      });
      console.log('     largest visible meshes in the rig:');
      for (const r of worst) {
        console.log(`       ${String(r.name).padEnd(18)} ${r.mat.padEnd(20)} ` +
          `${(r.w * 100).toFixed(0)}% x ${(r.h * 100).toFixed(0)}%  nearest z=${r.near}`);
      }
    }
  }
  console.log(
    `${slot + 1}     ${info.name.padEnd(7)} ${info.size.join(' x ').padEnd(22)} ` +
    `(${info.centre.join(', ')})`.padEnd(28) +
    ` ${(info.coverW * 100).toFixed(0)}% wide x ${(info.coverH * 100).toFixed(0)}% tall`
  );
}

await browser.close();
await server.close();
console.log(`\nframes in ${outDir}`);
