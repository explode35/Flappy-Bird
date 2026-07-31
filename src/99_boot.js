/* ============================================================================
   BOOT
   ========================================================================= */

Input.init();

// Web Audio needs a gesture; grab the first one we see, whatever it is.
const _wake = () => { Audio.init(); Audio.resume(); };
window.addEventListener('pointerdown', _wake, { once: false });
window.addEventListener('keydown', _wake, { once: false });

const app = new App();
window.NITRO = app;
// A handle on the internals: handy for tuning from the console
// (NITRO_LAB.K holds every physics constant in the game).
window.NITRO_LAB = {
  K, TRACKS, CHARACTERS, ITEMS, ITEM_TABLE, SURF, SURFACES,
  Audio, Input, Race, Kart, Track, TrackPath, AIDriver, FX
};

const loading = document.getElementById('loading');
if (loading) loading.remove();

let _last = performance.now();
function loop(now) {
  const dt = Math.min(0.05, Math.max(0.0005, (now - _last) / 1000));
  _last = now;
  try {
    app.frame(dt);
  } catch (err) {
    console.error(err);
    // one bad frame shouldn't take the whole game down
  }
  requestAnimationFrame(loop);
}
requestAnimationFrame(loop);
