import * as THREE from 'three';
import { Physics } from '../src/physics/Physics.js';

const ctx = { materials: { surfaceOf: () => 'concrete' } };
const p = new Physics(ctx);
const add = (g, x, y, z, rx = 0) => {
  const m = new THREE.Mesh(g, new THREE.MeshBasicMaterial());
  m.position.set(x, y, z); m.rotation.x = rx; m.updateMatrixWorld(true);
  p.addStatic(m);
};
add(new THREE.BoxGeometry(80, 1, 80), 0, -0.5, 0);              // ground y=0
add(new THREE.BoxGeometry(4, 0.3, 4), 6, 0.15, 0);              // 0.30 step
add(new THREE.BoxGeometry(4, 0.9, 4), 14, 0.45, 0);             // 0.90 ledge (too tall)
for (let i = 0; i < 8; i++) add(new THREE.BoxGeometry(2, 0.17, 0.28), -6, 0.085 + i * 0.17, -i * 0.28); // stairs
{ const g = new THREE.BoxGeometry(9, 0.3, 6); const m = new THREE.Mesh(g, new THREE.MeshBasicMaterial());
  m.position.set(22, 1.6, 0); m.rotation.z = THREE.MathUtils.degToRad(40); m.updateMatrixWorld(true); p.addStatic(m); } // 40deg ramp
add(new THREE.BoxGeometry(0.4, 4, 12), 0, 2, -20);              // wall A
add(new THREE.BoxGeometry(12, 4, 0.4), 6, 2, -26);              // wall B (corner w/ A)
p.build();

const R = 0.32, H = 1.80;
const mk = (x, y, z) => ({ start: new THREE.Vector3(x, y + R, z), end: new THREE.Vector3(x, y + H - R, z), radius: R });
const feet = (c) => c.start.y - R;
const out = { grounded: false, groundNormal: new THREE.Vector3(), hitWall: false, steppedUp: false };
const d = new THREE.Vector3();
let pass = 0, fail = 0;
const chk = (name, ok, info = '') => { (ok ? pass++ : fail++); console.log(`${ok ? 'PASS' : 'FAIL'}  ${name} ${info}`); };

// walk onto the 0.30 step (the step spans x 4..8, so check the peak, not the end)
let c = mk(3.0, 0.02, 0);
let peak = 0;
for (let i = 0; i < 100; i++) { d.set(0.05, -0.02, 0); p.moveCapsule(c, d, out); peak = Math.max(peak, feet(c)); }
chk('climbs 0.30m step', peak > 0.28 && c.start.x > 6, `peak=${peak.toFixed(3)} x=${c.start.x.toFixed(2)}`);

// blocked by 0.90 ledge
c = mk(11.0, 0.02, 0);
for (let i = 0; i < 140; i++) { d.set(0.05, -0.02, 0); p.moveCapsule(c, d, out); }
chk('blocked by 0.90m ledge', feet(c) < 0.2 && c.start.x < 13.6, `feet=${feet(c).toFixed(3)} x=${c.start.x.toFixed(2)}`);

// stairs: 8 x 0.17m risers spanning z 0.14 .. -2.10. Measure the ascent only.
c = mk(-6, 0.02, 0.6);
let prevY = feet(c), maxJump = 0, backSteps = 0;
while (c.start.z > -2.05) {
  d.set(0, -0.02, -0.02); p.moveCapsule(c, d, out);
  const y = feet(c); const dy = y - prevY;
  if (dy < -0.012) backSteps++;                 // a real drop, not float noise
  maxJump = Math.max(maxJump, Math.abs(dy)); prevY = y;
}
const topY = feet(c);
chk('stairs: climbs full flight', topY > 1.30 && topY < 1.45, `topY=${topY.toFixed(3)} (expect ~1.36)`);
chk('stairs: smooth, no jitter', maxJump < 0.20 && backSteps < 4, `maxStep=${maxJump.toFixed(3)} drops=${backSteps}`);

// ...and back down without launching off the edge
let maxAir = 0;
for (let i = 0; i < 130; i++) {
  d.set(0, -0.03, 0.02); p.moveCapsule(c, d, out);
  if (!out.grounded) maxAir++;
}
chk('stairs: descends glued to the steps', maxAir < 26, `airborneFrames=${maxAir} finalY=${feet(c).toFixed(2)}`);

// corner slide, no sticking
c = mk(3, 0.02, -22);
const x0 = c.start.x;
for (let i = 0; i < 200; i++) { d.set(0.04, -0.02, -0.04); p.moveCapsule(c, d, out); }
chk('slides along corner', c.start.x > x0 + 1.0 && c.start.z > -26, `x=${c.start.x.toFixed(2)} z=${c.start.z.toFixed(2)}`);

// no tunnelling at 30 m/s: charge the 0.4m-thin wall A (x=0, spans z -26..-14)
c = mk(-5, 0.02, -20);
for (let i = 0; i < 40; i++) { d.set(0.5, 0, 0); p.moveCapsule(c, d, out); }
chk('no tunnelling @30m/s', c.start.x < -0.15, `x=${c.start.x.toFixed(2)}`);

// 40deg ramp is walkable, and reports a sloped ground normal
c = mk(24, 3, 0);
for (let i = 0; i < 60; i++) { d.set(0, -0.06, 0); p.moveCapsule(c, d, out); }
const onRamp = out.grounded && out.groundNormal.y < 0.99;
const rampNormalY = out.groundNormal.y;
for (let i = 0; i < 160; i++) { d.set(-0.04, -0.03, 0); p.moveCapsule(c, d, out); }
chk('walks up 40deg ramp', onRamp && feet(c) > 0.5, `rampNormalY=${rampNormalY.toFixed(3)} feet=${feet(c).toFixed(2)}`);

// grounded flag + rest height on flat ground
c = mk(0, 3, 5);
for (let i = 0; i < 200; i++) { d.set(0, -0.05, 0); p.moveCapsule(c, d, out); }
chk('rests on ground, grounded=true', out.grounded && Math.abs(feet(c)) < 0.02, `feet=${feet(c).toFixed(4)}`);

// raycast surface classification + LOS
const hit = p.raycast(new THREE.Vector3(0, 5, 5), new THREE.Vector3(0, -1, 0), 20, {});
chk('raycast hits ground', !!hit && Math.abs(hit.point.y) < 0.02 && hit.surface === 'concrete', hit ? `y=${hit.point.y.toFixed(3)} surf=${hit.surface}` : 'null');
chk('lineOfSight blocked by wall', p.lineOfSight(new THREE.Vector3(-3, 1.6, -20), new THREE.Vector3(3, 1.6, -20)) === false);
chk('lineOfSight clear in open', p.lineOfSight(new THREE.Vector3(-3, 1.6, 5), new THREE.Vector3(3, 1.6, 5)) === true);

// NaN guard
chk('no NaN', Number.isFinite(c.start.x + c.start.y + c.start.z));
console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
