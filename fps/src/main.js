import { Engine } from './core/Engine.js';
import { Materials } from './render/Materials.js';
import { Sky } from './render/Sky.js';
import { Physics } from './physics/Physics.js';
import { Level } from './world/Level.js';
import { Player } from './player/Player.js';
import { Weapons } from './weapons/Weapons.js';
import { Effects } from './fx/Effects.js';
import { Enemies } from './ai/Enemies.js';
import { HUD } from './ui/HUD.js';
import { Audio } from './audio/Audio.js';
import { Director } from './game/Director.js';

async function boot() {
  const canvas = document.getElementById('c');
  const engine = new Engine(canvas);
  const ctx = engine.ctx;

  // Order matters: later systems read ctx fields set by earlier ones.
  ctx.materials = engine.add(new Materials(ctx));
  ctx.sky       = engine.add(new Sky(ctx));
  ctx.physics   = engine.add(new Physics(ctx));
  ctx.level     = engine.add(new Level(ctx));
  ctx.audio     = engine.add(new Audio(ctx));
  ctx.fx        = engine.add(new Effects(ctx));
  ctx.player    = engine.add(new Player(ctx));
  ctx.weapons   = engine.add(new Weapons(ctx));
  ctx.enemies   = engine.add(new Enemies(ctx));
  ctx.director  = engine.add(new Director(ctx));
  ctx.hud       = engine.add(new HUD(ctx));

  await engine.initAll();

  // Level geometry is registered during Level.init(); freeze the BVH now.
  ctx.physics.build();

  engine.start();
  window.__game = { engine, ctx };   // debug handle for the visual-review harness
  document.body.classList.add('ready');
}

boot().catch((err) => {
  console.error(err);
  const el = document.createElement('pre');
  el.style.cssText = 'position:fixed;inset:0;padding:24px;color:#f66;background:#111;font:13px monospace;z-index:9999;white-space:pre-wrap;overflow:auto';
  el.textContent = 'BOOT FAILURE\n\n' + (err && err.stack || err);
  document.body.appendChild(el);
});
