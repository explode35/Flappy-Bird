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
import { readFileSync } from 'node:fs';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');

/**
 * Name the cache-key fields instead of eyeballing a string diff.
 *
 * Six diagnoses of this bug were read off a truncated key window and all six
 * were wrong. three.js builds the key as
 *
 *     shaderID, ...getProgramCacheKeyParameters, booleanMask,
 *     renderer.outputColorSpace, customProgramCacheKey
 *
 * so token[0] is the shader id and token[1 + i] is parameters[i], in the push
 * order of getProgramCacheKeyParameters. That order is scraped straight out of
 * the installed three.js rather than hardcoded, so it cannot drift out of date.
 * Confirmed against a real key: srgb-linear,306,1024,uv lines up with
 * outputColorSpace, envMapMode, envMapCubeUVHeight, mapUv.
 *
 * customProgramCacheKey is last and can itself contain commas, so fields are
 * only labelled up to the boolean mask and the rest is reported verbatim.
 */
const KEY_FIELDS = (() => {
  const src = readFileSync(resolve(root, 'node_modules/three/src/renderers/webgl/WebGLPrograms.js'), 'utf8');
  const i = src.indexOf('function getProgramCacheKeyParameters');
  const j = src.indexOf('\n\t}', i);
  const params = [...src.slice(i, j).matchAll(/array\.push\(\s*parameters\.(\w+)/g)].map((m) => m[1]);
  // getProgramCacheKeyBooleans pushes _programLayers.mask twice -- three.js
  // needs more than 32 boolean slots, so there are two mask words, not one.
  const k = src.indexOf('function getProgramCacheKeyBooleans');
  const masks = [...src.slice(k, src.indexOf('\n\t}', k)).matchAll(/array\.push\(\s*_programLayers\.mask/g)];
  return [...params, ...masks.map((_, n) => `booleanMask${n + 1}`), 'outputColorSpace'];
})();

/**
 * Index of parameters[0] within the token list.
 *
 * The key starts with the shader id, then a variable number of tokens for
 * material.defines (a name and a value per define), so counting from token 0
 * silently mislabels every material that carries defines -- which is how a
 * `shadowMapType` difference got reported as `numClippingPlanes` in a project
 * that sets no clipping planes anywhere. parameters[0] is `precision`, whose
 * value is one of three known strings, so anchor on that instead.
 */
function paramBase(tokens) {
  const at = tokens.findIndex((t) => t === 'highp' || t === 'mediump' || t === 'lowp');
  return at === -1 ? 1 : at;
}

function labelledDiff(a, b) {
  const ta = a.split(','), tb = b.split(',');
  const base = paramBase(ta.length >= tb.length ? ta : tb);
  const out = [];
  for (let i = 0; i < Math.max(ta.length, tb.length); i++) {
    if (ta[i] === tb[i]) continue;
    const f = i - base;
    const name = i < base ? (i === 0 ? 'shaderID' : `define[${i}]`)
      : KEY_FIELDS[f] ?? 'customProgramCacheKey';
    if (name === 'customProgramCacheKey' && out.some((o) => o.startsWith('customProgramCacheKey'))) continue;
    const clip = (s) => (s === undefined ? '(absent)' : s.length > 60 ? `${s.slice(0, 60)}…` : s);
    out.push(`${name}: ${clip(ta[i])}  ->  ${clip(tb[i])}`);
  }
  return out;
}
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

const { out: rows, added, diffs, spawned } = await page.evaluate(async () => {
  const { ctx, engine } = window.__game;
  ctx.enemies?.clearAll?.();
  ctx.player.respawn?.();
  ctx.input.locked = true;
  ctx.bus.emit('input:lock', {});          // the real path: starts audio too
  for (let i = 0; i < 20; i++) await new Promise((r) => requestAnimationFrame(r));

  const c = document.querySelector('canvas');
  const gl = ctx.renderer.getContext();
  // NOT called per frame. gl.readPixels forces the pipeline to finish, which
  // on software GL costs the better part of a second — the first version of
  // this probe sampled eight pixels every frame and flagged every frame in the
  // run as a stall, including the idle ones. The instrument was the stall.
  // Timing is collected with no readback at all; brightness is sampled only at
  // a handful of checkpoints, and those frames are excluded from the timings.
  const sample = () => {
    let sum = 0;
    for (let i = 0; i < 8; i++) {
      const p = new Uint8Array(4);
      gl.readPixels((c.width * (i + 1) / 9) | 0, c.height >> 1, 1, 1, gl.RGBA, gl.UNSIGNED_BYTE, p);
      sum += (p[0] + p[1] + p[2]) / 3;
    }
    return Math.round(sum / 8);
  };

  const out = [];
  let last = performance.now();
  // `probe` frames take a brightness reading and are marked so the timing
  // summary can drop them; every other frame is pure timing.
  const step = async (label, probeIt) => {
    await new Promise((r) => requestAnimationFrame(r));
    const now = performance.now();
    const ms = Math.round(now - last);
    const row = {
      label, ms, probed: !!probeIt,
      programs: ctx.renderer.info.programs?.length ?? 0,
      dpr: +ctx.renderer.getPixelRatio().toFixed(2),
      calls: ctx.renderer.info.render.calls,
      mean: probeIt ? sample() : null,
    };
    out.push(row);
    last = performance.now();   // exclude the readback from the next delta
  };

  // Snapshot exactly which programs exist before the trigger, so the ones
  // that appear during the burst can be named rather than guessed at. Three
  // guesses at these have now been wrong.
  // Full key, not a 140-char slice: the truncated version made the two new
  // programs look identical to each other and to what was already there,
  // which is worse than useless.
  const progKey = (pr) => String(pr.cacheKey || pr.name || '?');
  // Walk both scenes and ask the renderer which program each material is
  // actually using, so a new key can be named instead of inferred from a
  // diff. Four inferences from the key alone have now been wrong.
  const owners = (keys) => {
    const want = new Set(keys);
    const found = [];
    const visit = (root, tag) => root?.traverse?.((o) => {
      const mats = Array.isArray(o.material) ? o.material : o.material ? [o.material] : [];
      for (const m of mats) {
        const p = ctx.renderer.properties.get(m);
        const cur = p?.currentProgram;
        const all = cur ? [cur] : [];
        if (p?.programs) for (const v of p.programs.values()) all.push(v);
        for (const pr of all) {
          if (!want.has(progKey(pr))) continue;
          const chain = [];
          for (let n = o; n && chain.length < 5; n = n.parent) chain.push(n.name || n.type);
          const maps = ['map', 'normalMap', 'roughnessMap', 'metalnessMap', 'aoMap', 'emissiveMap', 'alphaMap']
            .filter((k) => m[k]);
          const attrs = Object.keys(o.geometry?.attributes || {}).join('+');
          found.push(
            `${tag}: ${chain.join(' < ')} | ${m.type}${m.name ? ` "${m.name}"` : ''} ` +
            `maps=[${maps.join(',') || 'none'}] transparent=${m.transparent} ` +
            `attrs=[${attrs}] tris=${(o.geometry?.index?.count || o.geometry?.attributes?.position?.count || 0) / 3 | 0}`
          );
          return;
        }
      }
    });
    visit(ctx.scene, 'scene');
    visit(ctx.viewScene, 'view');
    return [...new Set(found)];
  };
  const beforeKeys = (ctx.renderer.info.programs || []).map(progKey);
  const before = new Set(beforeKeys);

  // Also record what appears in the scene graph during the burst. The program
  // owner search finds a material; this finds the object that brought it.
  const census = () => {
    const m = new Map();
    ctx.scene.traverse((o) => { if (o.isMesh) m.set(o.uuid, o.name || o.type); });
    return m;
  };
  const sceneBefore = census();

  for (let i = 0; i < 14; i++) await step('idle', i === 12);
  window.dispatchEvent(new MouseEvent('mousedown', { button: 0, bubbles: true }));
  for (let i = 0; i < 30; i++) await step('FIRING', i === 2 || i === 14 || i === 28);
  window.dispatchEvent(new MouseEvent('mouseup', { button: 0, bubbles: true }));
  for (let i = 0; i < 45; i++) await step('after', i === 2 || i === 20 || i === 43);

  const added = (ctx.renderer.info.programs || []).map(progKey).filter((k) => !before.has(k));
  // For each new key, find the pre-existing key it most closely resembles and
  // report where they first diverge. That names the define that flipped.
  const diffs = added.map((k) => {
    let best = null, bestAt = -1;
    for (const b of beforeKeys) {
      let i = 0;
      while (i < k.length && i < b.length && k[i] === b[i]) i++;
      if (i > bestAt) { bestAt = i; best = b; }
    }
    return {
      at: bestAt,
      key: k,
      nearest: best || '',
      newTail: k.slice(Math.max(0, bestAt - 40), bestAt + 60),
      oldTail: best ? best.slice(Math.max(0, bestAt - 40), bestAt + 60) : '',
      name: (ctx.renderer.info.programs || []).find((p) => progKey(p) === k)?.name || '?',
      owners: owners([k]),
    };
  });
  const spawned = [];
  {
    const after = census();
    const tally = new Map();
    for (const [uuid, name] of after) {
      if (sceneBefore.has(uuid)) continue;
      tally.set(name, (tally.get(name) || 0) + 1);
    }
    for (const [name, n] of tally) spawned.push(`${name} x${n}`);
  }
  return { out, added, diffs, spawned };
});

console.log('phase    frame   ms   mean  programs  dpr   calls');
let prevPrograms = rows[0].programs;
for (let i = 0; i < rows.length; i++) {
  const r = rows[i];
  const grew = r.programs > prevPrograms ? `  +${r.programs - prevPrograms} SHADERS` : '';
  prevPrograms = r.programs;
  if (r.probed || grew || r.ms > 200 || i < 2) {
    const dark = r.mean !== null && r.mean < 6 ? '  <-- BLACK' : '';
    console.log(
      `${r.label.padEnd(8)} ${String(i).padStart(3)}  ${String(r.ms).padStart(5)}  ` +
      `${r.mean === null ? '   -' : String(r.mean).padStart(4)}  ${String(r.programs).padStart(6)}  ` +
      `${String(r.dpr).padStart(4)}  ${String(r.calls).padStart(5)}${grew}${dark}`
    );
  }
}

const idle = rows.filter((r) => r.label === 'idle');
const fire = rows.filter((r) => r.label === 'FIRING');
const after = rows.filter((r) => r.label === 'after');
// Drop the frames that took a brightness reading: readPixels is a full
// pipeline sync and would dominate any timing it appears in.
const clean = (a) => a.filter((r) => !r.probed);
const avg = (a) => Math.round(clean(a).reduce((s, r) => s + r.ms, 0) / Math.max(1, clean(a).length));
const worst = (a) => Math.max(...clean(a).map((r) => r.ms));
console.log(`\nidle   avg ${avg(idle)} ms, worst ${worst(idle)} ms`);
console.log(`firing avg ${avg(fire)} ms, worst ${worst(fire)} ms`);
console.log(`after  avg ${avg(after)} ms, worst ${worst(after)} ms`);
const probed = rows.filter((r) => r.probed);
console.log(`brightness checkpoints: ${probed.map((r) => `${r.label}=${r.mean}`).join('  ')}`);
console.log(`slowest non-probe frame: ${Math.max(...clean(rows).map((r) => r.ms))} ms`);
console.log(`dpr range: ${Math.min(...rows.map((r) => r.dpr))} .. ${Math.max(...rows.map((r) => r.dpr))}`);
console.log(`shader programs: ${rows[0].programs} -> ${rows[rows.length - 1].programs}`);
if (added.length) {
  console.log(`\nprograms compiled during the burst (${added.length}):`);
  for (let i = 0; i < added.length; i++) {
    const d = diffs[i];
    console.log(`  --- new program ${i + 1} (${d.name}), diverges from the nearest existing key at char ${d.at}`);
    const named = labelledDiff(d.nearest, d.key);
    console.log(`      differs from the nearest existing program in ${named.length} field(s):`);
    for (const n of named) console.log(`        ${n}`);
    console.log(`      used by : ${d.owners.length ? d.owners.join('\n                ') : '(no live object still holds it)'}`);
  }
} else {
  console.log('\nno programs compiled during the burst');
}
if (added.length === 2) {
  console.log('\nthe two new programs differ from each other in:');
  for (const n of labelledDiff(diffs[0].key, diffs[1].key)) console.log(`  ${n}`);
}
console.log(`\nmeshes added to the scene during the burst: ${spawned.length ? spawned.join(', ') : '(none)'}`);
if (errs.length) console.log(`\n${errs.length} errors:\n` + [...new Set(errs)].slice(0, 4).join('\n'));

await browser.close();
await server.close();
