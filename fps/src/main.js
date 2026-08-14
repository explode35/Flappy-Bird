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

  // Pointer lock. `Input.requestLock()` has existed since the input system was
  // written and nothing ever called it, so `input.locked` stayed false for the
  // whole session — and that one flag gates look, jump, sprint, crouch, slide,
  // lean, firing, aiming, reloading, weapon switching and grenades, plus the
  // audio graph, which only starts on the first lock. What was left was
  // walking, in silence. Browsers only grant the lock inside a user gesture,
  // so it has to hang off a real click.
  const grabPointer = () => {
    if (ctx.input.locked || ctx.player?.dead) return;
    ctx.input.requestLock();
  };
  // On the document, not the canvas: the pause and loading screens sit over it
  // with pointer-events enabled, and clicking them has to get you back in.
  document.addEventListener('mousedown', grabPointer);

  // Escape drops the lock (the browser does that itself, we cannot stop it),
  // which raises the pause screen. The simulation has to stop with it —
  // otherwise the enemies keep shooting at a player who is reading a menu.
  ctx.bus.on('input:unlock', () => { if (engine.frame > 120) engine.paused = true; });
  ctx.bus.on('input:lock', () => { engine.paused = false; });
}

boot().catch((err) => {
  console.error(err);
  const el = document.createElement('pre');
  el.style.cssText = 'position:fixed;inset:0;padding:24px;color:#f66;background:#111;font:13px monospace;z-index:9999;white-space:pre-wrap;overflow:auto';
  el.textContent = 'BOOT FAILURE\n\n' + (err && err.stack || err);
  document.body.appendChild(el);
});
