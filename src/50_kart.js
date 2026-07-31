/* ============================================================================
   RACERS — original cast, procedural kart models, and the driving model.
   Stats are 1..5 and map onto real physics constants below.
   ========================================================================= */

const CHARACTERS = [
  { id: 'nova', name: 'Nova Kestrel', role: 'All-round', color: 0x35d6ff, accent: 0x0b3550, style: 'wedge', speed: 4, accel: 4, handling: 4, weight: 3, quip: 'Reads a corner a lap early.' },
  { id: 'bramble', name: 'Rell Bramblejack', role: 'Bruiser', color: 0x7bc043, accent: 0x1e3a12, style: 'tank', speed: 5, accel: 2, handling: 2, weight: 5, quip: 'Enters the corner. Leaves with it.' },
  { id: 'sable', name: 'Sable Vex', role: 'Top speed', color: 0xff4fbf, accent: 0x46083a, style: 'dart', speed: 5, accel: 3, handling: 2, weight: 3, quip: 'Only interested in the long straight.' },
  { id: 'pip', name: 'Pip Quark', role: 'Featherweight', color: 0xffd23f, accent: 0x4a3505, style: 'pod', speed: 2, accel: 5, handling: 5, weight: 1, quip: 'Small target, enormous opinions.' },
  { id: 'marisol', name: 'Marisol Dune', role: 'Cornering', color: 0xff8a3c, accent: 0x4a2208, style: 'buggy', speed: 3, accel: 4, handling: 5, weight: 2, quip: 'Grew up racing dry riverbeds.' },
  { id: 'grit', name: 'Grit Bolder', role: 'Heavyweight', color: 0xc0522d, accent: 0x3a1508, style: 'tank', speed: 5, accel: 1, handling: 3, weight: 5, quip: 'Takes a while. Arrives anyway.' },
  { id: 'echo', name: 'Echo Rill', role: 'Technician', color: 0x9b6bff, accent: 0x2a1055, style: 'pod', speed: 3, accel: 5, handling: 4, weight: 2, quip: 'Charges a drift like a battery.' },
  { id: 'fothom', name: 'Captain Fothom', role: 'Veteran', color: 0x2fb8a0, accent: 0x08322c, style: 'buggy', speed: 4, accel: 3, handling: 3, weight: 4, quip: 'Forty seasons. Still hates lap one.' }
];

/* Tuning constants — the whole game feel lives in this block. */
const K = {
  topBase: 43.5, topPerSpeed: 2.6,      // m/s
  accelBase: 13.0, accelPerAccel: 3.4,  // m/s^2 at zero speed
  accelCurve: 1.75,                     // how fast accel falls off toward top speed
  brakeForce: 34,
  reverseTop: 12,
  coastDrag: 0.55,
  rollDrag: 0.016,                      // quadratic-ish drag coefficient
  steerBase: 1.62, steerPerHandling: 0.17,
  steerHighSpeed: 0.44,                 // steering authority left at top speed
  yawAccel: 12.5,                       // how fast yaw rate approaches target
  gripBase: 12.0, gripPerHandling: 1.35,
  driftGrip: 0.30,                      // fraction of grip kept while drifting
  driftYawBase: 0.92,                   // rad/s the kart rotates just from drifting
  driftYawSteer: 1.02,                  // extra from steering inside/outside
  driftSteerMin: -0.95,                 // full outside steer nearly cancels the rotation
  driftScrub: 0.155,                    // speed lost per m/s of sideways slip
  driftMinSpeed: 15,
  driftEnterSteer: 0.16,
  hopVel: 5.4,
  gravity: 27.0,
  glideGravity: 8.5,
  chargeTiers: [0.82, 1.95, 3.25],
  boostDur: [0.42, 0.62, 1.00, 1.55],   // index 0 = hop-landing micro boost
  boostTop: [1.06, 1.13, 1.22, 1.34],
  boostImpulse: [1.8, 3.6, 5.6, 8.2],
  boostAccelMul: 2.4,
  padBoostDur: 1.05, padBoostTop: 1.28,
  landPenalty: 0.11,                    // speed lost on a badly timed landing
  landWindow: 0.22,                     // seconds before touchdown to press hop
  spinTime: 1.00,
  spinSpeedKeep: 0.50,
  squashTime: 1.15,
  bumpRestitution: 0.34,
  wallBounce: 0.42, wallSpeedKeep: 0.74,
  rideHeight: 0.62
};

function statsOf(ch) {
  return {
    top: K.topBase + ch.speed * K.topPerSpeed,
    accel: K.accelBase + ch.accel * K.accelPerAccel,
    steer: K.steerBase + ch.handling * K.steerPerHandling,
    grip: K.gripBase + ch.handling * K.gripPerHandling,
    mass: 0.72 + ch.weight * 0.14,
    weight: ch.weight
  };
}

/* ---------- kart model -------------------------------------------------- */

function buildKart(ch) {
  const g = new THREE.Group();
  const body = new THREE.Group();
  g.add(body);

  const paint = new THREE.MeshStandardMaterial({ color: ch.color, roughness: .38, metalness: .45 });
  const dark = new THREE.MeshStandardMaterial({ color: ch.accent, roughness: .55, metalness: .35 });
  const trim = new THREE.MeshStandardMaterial({ color: 0xe8eef8, roughness: .3, metalness: .6 });
  const glass = new THREE.MeshStandardMaterial({ color: 0x102030, roughness: .1, metalness: .9, transparent: true, opacity: .78 });
  const rubber = new THREE.MeshStandardMaterial({ color: 0x15171c, roughness: .95, metalness: 0 });
  const glow = new THREE.MeshBasicMaterial({ color: shade(ch.color, 1.6) });

  // Chassis pieces are collected and merged into one mesh at the end: eight
  // karts at twenty draw calls each was the single biggest cost in the frame.
  const chassis = [];
  const _m4 = new THREE.Matrix4(), _qq = new THREE.Quaternion(), _ee = new THREE.Euler(), _one = new THREE.Vector3(1, 1, 1);
  const bake = (geo, mat, x, y, z, rx, ry, rz, into) => {
    const g = geo.clone();
    _ee.set(rx || 0, ry || 0, rz || 0);
    _qq.setFromEuler(_ee);
    _m4.compose(_v0.set(x || 0, y || 0, z || 0), _qq, _one);
    g.applyMatrix4(_m4);
    (into || chassis).push([g, mat]);
    return g;
  };
  const add = bake;

  // --- chassis silhouettes differ per style so the field reads at a glance
  if (ch.style === 'wedge') {
    const hull = new THREE.BoxGeometry(2.5, .62, 4.3);
    const p = hull.attributes.position;
    for (let i = 0; i < p.count; i++) {          // taper the nose into a wedge
      const z = p.getZ(i);
      if (z > 1) { p.setX(i, p.getX(i) * .62); p.setY(i, p.getY(i) * .55 - .1); }
    }
    hull.computeVertexNormals();
    add(hull, paint, 0, .78, 0);
    add(new THREE.BoxGeometry(2.1, .34, 1.5), dark, 0, 1.12, -.6);
    add(new THREE.BoxGeometry(2.6, .12, .9), trim, 0, 1.42, -1.85);
    add(new THREE.BoxGeometry(.16, .5, .5), dark, -.95, 1.16, -1.85);
    add(new THREE.BoxGeometry(.16, .5, .5), dark, .95, 1.16, -1.85);
  } else if (ch.style === 'tank') {
    add(new THREE.BoxGeometry(2.9, .95, 4.2), paint, 0, .9, 0);
    add(new THREE.BoxGeometry(3.15, .3, 1.6), dark, 0, .62, .9);
    add(new THREE.BoxGeometry(2.2, .5, 1.2), dark, 0, 1.45, -.5);
    add(new THREE.CylinderGeometry(.22, .3, 1.5, 6), trim, -1.1, 1.5, -1.2, 0, 0, .25);
    add(new THREE.CylinderGeometry(.22, .3, 1.5, 6), trim, 1.1, 1.5, -1.2, 0, 0, -.25);
    add(new THREE.BoxGeometry(3.1, .2, .7), trim, 0, 1.62, -1.9);
  } else if (ch.style === 'dart') {
    const hull = new THREE.CylinderGeometry(.62, .5, 4.6, 8);
    hull.rotateX(Math.PI / 2);
    add(hull, paint, 0, .86, .1);
    add(new THREE.ConeGeometry(.62, 1.5, 8), paint, 0, .86, 2.6, Math.PI / 2);
    add(new THREE.BoxGeometry(2.7, .1, 1.1), dark, 0, .86, -.4);
    add(new THREE.BoxGeometry(2.5, .5, .12), trim, 0, 1.6, -2.0);
    add(new THREE.BoxGeometry(.12, .55, .5), dark, -1.1, 1.35, -1.95);
    add(new THREE.BoxGeometry(.12, .55, .5), dark, 1.1, 1.35, -1.95);
  } else if (ch.style === 'pod') {
    const s = new THREE.SphereGeometry(1.25, 12, 9);
    s.scale(1, .78, 1.5);
    add(s, paint, 0, .95, 0);
    add(new THREE.TorusGeometry(1.15, .16, 6, 14), trim, 0, .95, 0, Math.PI / 2);
    add(new THREE.SphereGeometry(.6, 10, 8), glass, 0, 1.32, -.15);
    add(new THREE.BoxGeometry(.16, .8, 1.0), dark, -1.15, 1.2, -1.1, .2);
    add(new THREE.BoxGeometry(.16, .8, 1.0), dark, 1.15, 1.2, -1.1, .2);
  } else { // buggy
    add(new THREE.BoxGeometry(2.4, .55, 3.9), paint, 0, .8, 0);
    add(new THREE.BoxGeometry(2.0, .7, 1.6), dark, 0, 1.2, -.5);
    // roll cage
    const bar = new THREE.CylinderGeometry(.09, .09, 1.5, 6);
    add(bar, trim, -.95, 1.5, -.9, 0, 0, .18);
    add(bar, trim, .95, 1.5, -.9, 0, 0, -.18);
    const top = new THREE.CylinderGeometry(.09, .09, 2.0, 6);
    add(top, trim, 0, 2.2, -.9, 0, 0, Math.PI / 2);
    add(new THREE.BoxGeometry(2.7, .14, .8), trim, 0, 1.75, -2.0);
    add(new THREE.BoxGeometry(1.5, .3, .7), dark, 0, .72, 2.0);
  }

  // --- merge the chassis into a single draw
  const chassisMesh = new THREE.Mesh(mergeParts(chassis),
    new THREE.MeshStandardMaterial({ vertexColors: true, roughness: .42, metalness: .42 }));
  chassisMesh.castShadow = true;
  body.add(chassisMesh);

  // --- driver (also merged; the group still leans and turns as a unit)
  const suit = new THREE.MeshStandardMaterial({ color: shade(ch.accent, 1.9), roughness: .6 });
  const helmet = new THREE.MeshStandardMaterial({ color: ch.color, roughness: .35, metalness: .3 });
  const driverParts = [];
  bake(new THREE.CylinderGeometry(.3, .38, .92, 8), suit, 0, 0, 0, 0, 0, 0, driverParts);
  bake(new THREE.SphereGeometry(.33, 10, 8), helmet, 0, .68, 0, 0, 0, 0, driverParts);
  bake(new THREE.SphereGeometry(.335, 10, 8, 0, Math.PI, Math.PI * .28, Math.PI * .34), glass,
    0, .68, 0, 0, Math.PI, 0, driverParts);
  const armGeo = new THREE.CylinderGeometry(.1, .1, .62, 6);
  bake(armGeo, suit, -.36, .18, .3, -1.05, 0, .25, driverParts);
  bake(armGeo, suit, .36, .18, .3, -1.05, 0, -.25, driverParts);
  bake(new THREE.TorusGeometry(.3, .06, 5, 10), dark, 0, .14, .7, -.9, 0, 0, driverParts);
  const driver = new THREE.Group();
  driver.position.set(0, 1.28, -.35);
  const driverMesh = new THREE.Mesh(mergeParts(driverParts),
    new THREE.MeshStandardMaterial({ vertexColors: true, roughness: .55, metalness: .2 }));
  driverMesh.castShadow = true;
  driver.add(driverMesh);
  body.add(driver);

  // --- wheels
  const wr = ch.style === 'tank' ? .62 : .55;
  const wheelGeo = new THREE.CylinderGeometry(wr, wr, .48, 12);
  wheelGeo.rotateZ(Math.PI / 2);
  const rimGeo = new THREE.CylinderGeometry(wr * .55, wr * .55, .5, 8);
  rimGeo.rotateZ(Math.PI / 2);
  const wheelParts = [];
  wheelParts.push([wheelGeo, rubber], [rimGeo, trim]);
  const mergedWheel = mergeParts(wheelParts);
  const wheelMat = new THREE.MeshStandardMaterial({ vertexColors: true, roughness: .8, metalness: .2 });
  const wx = ch.style === 'tank' ? 1.52 : 1.35, wz = 1.42;
  const wheels = [];
  [[-wx, 1], [wx, 1], [-wx, -1], [wx, -1]].forEach(([x, zs]) => {
    const w = new THREE.Group();
    const t = new THREE.Mesh(mergedWheel, wheelMat);
    t.castShadow = true;
    w.add(t);
    w.position.set(x, wr, zs * wz);
    body.add(w);
    wheels.push(w);
  });

  // --- tail light (kept separate: it changes colour under boost)
  const tail = new THREE.Mesh(new THREE.BoxGeometry(1.7, .12, .06), glow);
  tail.position.set(0, 1.05, -2.16);
  body.add(tail);
  // exhaust anchors are empties — the FX system only needs their world position
  const exL = new THREE.Object3D(); exL.position.set(-.55, .8, -2.15);
  const exR = new THREE.Object3D(); exR.position.set(.55, .8, -2.15);
  body.add(exL, exR);

  // --- attachments
  const shield = new THREE.Mesh(new THREE.SphereGeometry(2.7, 16, 12), new THREE.ShaderMaterial({
    transparent: true, depthWrite: false, side: THREE.DoubleSide, blending: THREE.AdditiveBlending,
    uniforms: { uTime: { value: 0 }, uColor: { value: new THREE.Color(0x66ddff) } },
    vertexShader: `varying vec3 vN; varying vec3 vP; varying vec3 vL;
      void main(){ vN=normalize(normalMatrix*normal); vec4 mv=modelViewMatrix*vec4(position,1.0);
        vP=mv.xyz; vL=position; gl_Position=projectionMatrix*mv; }`,
    fragmentShader: `uniform float uTime; uniform vec3 uColor; varying vec3 vN; varying vec3 vP; varying vec3 vL;
      void main(){
        float f=pow(1.0-abs(dot(normalize(-vP),vN)),2.2);
        float hex=sin(vL.x*7.0+uTime*2.0)*sin(vL.y*7.0-uTime*1.3)*sin(vL.z*7.0+uTime*1.7);
        float a=f*0.85+max(hex,0.0)*0.16;
        gl_FragColor=vec4(uColor*(0.8+f*1.8), a*0.75);
      }`
  }));
  shield.visible = false;
  shield.position.y = 1.1;
  g.add(shield);

  const glider = new THREE.Group();
  const wingMat = new THREE.MeshStandardMaterial({ color: ch.color, roughness: .5, metalness: .2, side: THREE.DoubleSide, transparent: true, opacity: .9 });
  const wing = new THREE.Mesh(new THREE.PlaneGeometry(7.5, 2.6, 4, 2), wingMat);
  wing.rotation.x = -Math.PI / 2 + .22;
  wing.position.set(0, 3.1, -.4);
  const strut1 = new THREE.Mesh(new THREE.CylinderGeometry(.06, .06, 2.2, 5), trim);
  strut1.position.set(-.8, 2.1, -.3); strut1.rotation.z = .3;
  const strut2 = strut1.clone(); strut2.position.x = .8; strut2.rotation.z = -.3;
  glider.add(wing, strut1, strut2);
  glider.visible = false;
  g.add(glider);

  g.userData = { body, wheels, driver, shield, glider, tail, exL, exR, chassisMesh };
  return g;
}

/* ---------- the driving model ------------------------------------------- */

class Kart {
  constructor(ch, track, index) {
    this.ch = ch;
    this.stats = statsOf(ch);
    this.track = track;
    this.index = index;
    this.isPlayer = false;
    this.playerIdx = -1;

    this.obj = buildKart(ch);
    this.pos = new THREE.Vector3();
    this.vel = new THREE.Vector3();
    this.yaw = 0;
    this.yawVel = 0;
    this.vy = 0;

    this.grounded = true;
    this.airTime = 0;
    this.hopArmed = 0;
    this.hopTimer = 0;

    this.drifting = false;
    this.driftDir = 0;
    this.driftCharge = 0;
    this.driftTier = 0;
    this.driftPending = 0;
    this.lastSteer = 0;
    this.wiggle = 0;

    this.boostTime = 0;
    this.boostTier = 0;
    this.boostTop = 1;

    this.spinTime = 0;
    this.squashTime = 0;
    this.stunTime = 0;
    this.stallTime = 0;
    this.stormTime = 0;
    this.invuln = 0;
    this.itemCharges = 0;
    this.itemHeld = false;

    this.surf = SURF.ROAD;
    this.surfInfo = Object.assign({}, SQ);
    this.hint = -1;
    this.s = 0; this.u = 0;
    this.lap = 0;
    this.progress = 0;      // lap + prog(s), the single sort key for positions
    this.lastProgress = 0;
    this.position = index + 1;
    this.finished = false;
    this.finishTime = 0;
    this.lapTimes = [];
    this.lapStart = 0;
    this.wrongWay = false;
    this.offTrackTime = 0;
    this.respawnTimer = 0;
    this.rescueS = 0;

    this.item = null;
    this.itemHeld = false;
    this.itemRolling = 0;
    this.shield = 0;
    this.trailingItem = null;

    this.rubber = 1;
    this.engineVoice = null;
    this.driftVoice = null;
    this.wheelSpin = 0;
    this.visualRoll = 0;
    this.visualPitch = 0;
    this.squash = 1;
    this.gliding = false;
    this.lastCollide = 0;
    this.speedKmh = 0;
    this.slip = 0;
    this.boostFlash = 0;
  }

  get speed() { return this._vLong || 0; }

  reset(slot) {
    this.pos.copy(slot.pos);
    this.pos.y += K.rideHeight;
    this.yaw = slot.yaw;
    this.vel.set(0, 0, 0);
    this.vy = 0; this.yawVel = 0;
    this._vLong = 0;
    this.lap = 0; this.progress = 0; this.lastProgress = 0;
    this.finished = false; this.finishTime = 0;
    this.lapTimes.length = 0;
    this.drifting = false; this.driftCharge = 0; this.driftTier = 0;
    this.boostTime = 0; this.spinTime = 0; this.squashTime = 0;
    this.item = null; this.shield = 0; this.trailingItem = null;
    this.hint = -1;
    this.obj.position.copy(this.pos);
    this.obj.rotation.set(0, this.yaw, 0);
    this.track.query(this.pos.x, this.pos.y, this.pos.z, -1, this.surfInfo);
    this.hint = this.surfInfo.i;
    this.s = this.surfInfo.s;
    // The grid sits *behind* the start line, so progress starts near 1.0.
    // Seeding lastProgress with it is what makes the first crossing count as
    // the start of lap 1 rather than as a lap run backwards.
    this.lastProgress = this.track.prog(this.s);
    this.progress = this.lastProgress;
    this.rescueS = this.s;
  }

  /* ---- helpers ---- */
  forward(out) { return out.set(Math.sin(this.yaw), 0, Math.cos(this.yaw)); }
  rightVec(out) { return out.set(Math.cos(this.yaw), 0, -Math.sin(this.yaw)); }

  /** Current top speed including boosts, surface and rubber-banding. */
  topSpeed() {
    const sd = SURFACES[this.surf];
    return this.stats.top * sd.top * this.boostTop * this.rubber;
  }

  applyBoost(tier, opt) {
    const dur = K.boostDur[tier], top = K.boostTop[tier];
    if (this.boostTime > dur && this.boostTier >= tier && !opt) return;
    this.boostTime = Math.max(this.boostTime, dur);
    this.boostTier = Math.max(this.boostTier, tier);
    this.boostTop = Math.max(this.boostTop, top);
    this._vLong = Math.max(this._vLong, 0) + K.boostImpulse[tier];
    this.boostFlash = 1;
  }
  padBoost() {
    this.boostTime = Math.max(this.boostTime, K.padBoostDur);
    this.boostTop = Math.max(this.boostTop, K.padBoostTop);
    this.boostTier = Math.max(this.boostTier, 2);
    this._vLong = Math.max(this._vLong, this.stats.top * .75);
    this.boostFlash = 1;
  }

  spinOut(force) {
    if (this.invuln > 0 && !force) return false;
    if (this.shield > 0) { this.shield = 0; return false; }
    // a held item eats the hit — that is the whole point of trailing one
    if (this.itemHeld && this.item) {
      this.item = null; this.itemCharges = 0; this.itemHeld = false;
      this.invuln = .8;
      return false;
    }
    this.spinTime = K.spinTime;
    this.drifting = false; this.driftCharge = 0; this.driftTier = 0;
    this.boostTime = 0; this.boostTop = 1;
    this._vLong *= K.spinSpeedKeep;
    this.invuln = 1.6;
    return true;
  }
  squashOut() {
    if (this.invuln > 0) return false;
    if (this.shield > 0) { this.shield = 0; return false; }
    this.squashTime = K.squashTime;
    this.drifting = false; this.driftCharge = 0;
    this.boostTime = 0; this.boostTop = 1;
    this._vLong = 0;
    this.vel.multiplyScalar(.1);
    this.invuln = 1.8;
    return true;
  }

  /* ---- main integration ---- */
  update(dt, ctl, race) {
    const T = this.track;
    const stats = this.stats;

    // ---------- surface ----------
    const q = T.query(this.pos.x, this.pos.y, this.pos.z, this.hint, this.surfInfo);
    this.hint = q.i;
    this.s = q.s;
    this.u = q.u;
    this.surf = q.surf;
    const sd = SURFACES[q.surf];

    // ---------- state timers ----------
    if (this.boostTime > 0) {
      this.boostTime -= dt;
      if (this.boostTime <= 0) { this.boostTime = 0; this.boostTier = 0; this.boostTop = 1; }
    }
    if (this.spinTime > 0) this.spinTime -= dt;
    if (this.squashTime > 0) this.squashTime -= dt;
    if (this.invuln > 0) this.invuln -= dt;
    if (this.itemRolling > 0) this.itemRolling -= dt;
    this.boostFlash = Math.max(0, this.boostFlash - dt * 3.2);

    const disabled = this.spinTime > 0 || this.squashTime > 0 || race.phase === 'countdown' && race.countdown > 0.02;
    const noControl = this.spinTime > 0 || this.squashTime > 0;

    // ---------- decompose velocity ----------
    const fwd = this.forward(_v0), rgt = this.rightVec(_v1);
    let vLong = this.vel.dot(fwd);
    let vLat = this.vel.dot(rgt);
    this._vLong = vLong;

    let throttle = ctl.throttle, brake = ctl.brake;
    if (noControl) { throttle = 0; brake = 0; }
    if (this.stallTime > 0) { this.stallTime -= dt; throttle = 0; }
    if (race.phase === 'countdown') {
      // launch-boost window: hold throttle as the last light drops
      brake = 0;
      if (race.countdown > 0.0) throttle = 0;
    }

    // ---------- longitudinal ----------
    const top = this.topSpeed();
    if (throttle > 0) {
      const f = clamp01(Math.abs(vLong) / Math.max(1, top));
      const curve = Math.pow(1 - f, K.accelCurve);
      const boostMul = this.boostTime > 0 ? K.boostAccelMul : 1;
      vLong += stats.accel * curve * throttle * boostMul * dt;
      if (this.boostTime > 0 && vLong < top) vLong = Math.min(top, vLong + 22 * dt);
    }
    if (brake > 0) {
      if (vLong > 0.4) vLong -= K.brakeForce * brake * dt;
      else vLong = Math.max(-K.reverseTop, vLong - stats.accel * .55 * brake * dt);
    }
    if (throttle <= 0 && brake <= 0) vLong -= sign(vLong) * K.coastDrag * dt * (1 + Math.abs(vLong) * .05);
    // drag + surface resistance
    vLong -= vLong * Math.abs(vLong) * K.rollDrag * dt * .06;
    if (sd.drag !== 0) vLong -= sign(vLong) * sd.drag * dt * (2.2 + Math.abs(vLong) * .11);
    // hard cap (a boost can exceed the base top speed but not forever)
    const hardTop = top * 1.02;
    if (vLong > hardTop) vLong = damp(vLong, hardTop, 3.4, dt);
    if (vLong < -K.reverseTop) vLong = -K.reverseTop;

    // ---------- drift state machine ----------
    const canDrift = Math.abs(vLong) > K.driftMinSpeed && !noControl && race.phase !== 'countdown';
    if (!noControl) {
      if (ctl.driftHit && this.grounded && !this.drifting) {
        this.vy = K.hopVel;
        this.grounded = false;
        this.hopTimer = .001;
        this.driftPending = canDrift ? .45 : 0;
        this.hopArmed = 1;
        if (this.onHop) this.onHop();
      }
      if (this.driftPending > 0) {
        this.driftPending -= dt;
        if (Math.abs(ctl.steer) > K.driftEnterSteer && ctl.drift && this.grounded && canDrift) {
          this.drifting = true;
          this.driftDir = sign(ctl.steer);
          this.driftCharge = 0;
          this.driftTier = 0;
          this.driftPending = 0;
        }
      }
      if (this.drifting) {
        if (!ctl.drift || Math.abs(vLong) < K.driftMinSpeed * .72 || this.squashTime > 0) {
          // release: convert charge into a boost
          if (this.driftTier > 0) {
            this.applyBoost(this.driftTier);
            if (this.onDriftRelease) this.onDriftRelease(this.driftTier);
          }
          this.drifting = false;
          this.driftCharge = 0;
          this.driftTier = 0;
        } else {
          // charge rate: steering into the drift charges fastest, and rapid
          // counter-steer "wiggling" adds a bonus so tier 3 is reachable with skill
          const into = clamp01(ctl.steer * this.driftDir);
          const dSteer = Math.abs(ctl.steer - this.lastSteer) / Math.max(dt, 1e-3);
          this.wiggle = damp(this.wiggle, clamp01(dSteer * .12), 6, dt);
          const speedF = clamp(Math.abs(vLong) / (stats.top * .7), .55, 1.15);
          const rate = (0.62 + into * 0.46 + this.wiggle * 0.34) * speedF;
          this.driftCharge += rate * dt;
          let tier = 0;
          for (let i = 0; i < 3; i++) if (this.driftCharge >= K.chargeTiers[i]) tier = i + 1;
          if (tier !== this.driftTier) {
            this.driftTier = tier;
            if (this.onDriftTier) this.onDriftTier(tier);
          }
        }
      }
    } else if (this.drifting) {
      this.drifting = false; this.driftCharge = 0; this.driftTier = 0;
    }
    this.lastSteer = ctl.steer;

    // ---------- steering ----------
    const speedFrac = clamp01(Math.abs(vLong) / Math.max(1, stats.top));
    const authority = lerp(1, K.steerHighSpeed, speedFrac * speedFrac);
    let targetYawVel;
    if (this.drifting) {
      // inside steer tightens, outside steer opens the drift out
      const into = ctl.steer * this.driftDir;
      targetYawVel = this.driftDir * (K.driftYawBase + K.driftYawSteer * clamp(into, K.driftSteerMin, 1)) * lerp(.72, 1.12, speedFrac);
    } else {
      targetYawVel = ctl.steer * stats.steer * authority;
      if (Math.abs(vLong) < 1.2) targetYawVel *= Math.abs(vLong) / 1.2;
      if (vLong < 0) targetYawVel *= -1;
    }
    if (noControl) targetYawVel = 0;
    if (this.spinTime > 0) targetYawVel = 9.5 * Math.min(1, this.spinTime / K.spinTime + .25);
    if (!this.grounded) targetYawVel *= this.gliding ? .85 : .55;
    this.yawVel = damp(this.yawVel, targetYawVel, K.yawAccel, dt);
    this.yaw += this.yawVel * dt;

    // ---------- lateral grip ----------
    let grip = stats.grip * sd.grip;
    if (this.drifting) grip *= K.driftGrip;
    if (!this.grounded) grip *= .12;
    const bankAbs = Math.abs(Math.sin(q.bank));
    grip *= 1 + bankAbs * .55;
    const newLat = damp(vLat, 0, grip, dt);
    this.slip = damp(this.slip, Math.abs(vLat) / 12, 8, dt);
    // tyre scrub: sliding sideways costs forward speed. This is what stops
    // "drift in a straight line to farm boosts" from being optimal.
    if (this.grounded) vLong -= Math.abs(vLat) * K.driftScrub * dt * (this.drifting ? 1 : .45);
    vLat = newLat;

    // ---------- rebuild world velocity ----------
    this.forward(_v0); this.rightVec(_v1);
    this.vel.set(0, 0, 0)
      .addScaledVector(_v0, vLong)
      .addScaledVector(_v1, vLat);

    // ---------- track-frame forces (bank gravity + cornering load) ----------
    if (this.grounded) {
      const rx = q.rx, ry = q.ry, rz = q.rz;
      const rl = Math.hypot(rx, rz) || 1e-4;
      // Gravity pulls you down the banking — but on steep sections speed pins
      // you to the wall. Carry pace and you ride it; lift off and you slide.
      const steep = smoothstep(deg(24), deg(44), Math.abs(q.bank));
      const pin = lerp(1, .16, steep * clamp01(Math.abs(vLong) / (stats.top * .62)));
      let latAcc = -K.gravity * Math.sin(q.bank) * pin;
      // ...and cornering throws you up it. Balance = wall riding.
      latAcc += -q.curv * vLong * vLong * (0.22 + 0.78 * bankAbs);
      this.vel.x += (rx / rl) * latAcc * dt;
      this.vel.z += (rz / rl) * latAcc * dt;
    }

    // ---------- vertical ----------
    this.gliding = q.glide && !this.grounded;
    const surfaceY = q.height + K.rideHeight;
    if (!this.grounded) {
      this.airTime += dt;
      this.vy -= (this.gliding ? K.glideGravity : K.gravity) * dt;
      if (this.gliding) {
        this.vy = Math.max(this.vy, -9);
        // gliders keep speed
        vLong = Math.max(vLong, vLong * (1 - .04 * dt));
      }
      this.pos.y += this.vy * dt;
      if (this.hopTimer > 0) this.hopTimer += dt;
      if (this.pos.y <= surfaceY && this.vy <= 0) {
        // ---- landing ----
        this.grounded = true;
        const fall = -this.vy;
        this.pos.y = surfaceY;
        this.vy = 0;
        const cleanHop = ctl.drift && this.airTime > .08;
        if (this.airTime > .25 && !cleanHop) {
          const pen = clamp01(fall / 26) * K.landPenalty + .02;
          vLong *= (1 - pen);
          if (this.onLand) this.onLand(fall, false);
        } else if (cleanHop && this.airTime > .3) {
          this.applyBoost(0);
          if (this.onLand) this.onLand(fall, true);
        } else if (this.onLand) this.onLand(fall, false);
        this.airTime = 0;
        this.hopTimer = 0;
      }
    } else {
      this.airTime = 0;
      const dy = surfaceY - this.pos.y;
      if (dy > 0.6 + Math.abs(vLong) * .06) {
        // surface came up sharply (ramp) — ride it
        this.pos.y = surfaceY;
      } else if (dy < -0.35) {
        this.grounded = false;
        this.vy = 0;
      } else {
        this.pos.y = damp(this.pos.y, surfaceY, 26, dt);
      }
    }

    // ramp lip launch
    if (this._lastRamp >= 0 && q.ramp < 0 && this.grounded && vLong > 8) {
      const r = T.ramps[this._lastRamp];
      this.grounded = false;
      this.vy = r.power * clamp(vLong / (stats.top * .85), .45, 1.15);
      this.airTime = 0;
      if (this.onLaunch) this.onLaunch();
    }
    this._lastRamp = q.ramp;

    // ---------- integrate position ----------
    this.pos.x += this.vel.x * dt;
    this.pos.z += this.vel.z * dt;
    this._vLong = vLong;

    // ---------- walls ----------
    if (q.wall !== 0 && this.grounded) {
      const push = Math.abs(q.wall);
      const nx = -sign(q.wall) * q.rx, nz = -sign(q.wall) * q.rz;
      const nl = Math.hypot(nx, nz) || 1;
      this.pos.x += (nx / nl) * push;
      this.pos.z += (nz / nl) * push;
      const vn = this.vel.x * (nx / nl) + this.vel.z * (nz / nl);
      if (vn < 0) {
        this.vel.x -= (nx / nl) * vn * (1 + K.wallBounce);
        this.vel.z -= (nz / nl) * vn * (1 + K.wallBounce);
        const impact = -vn;
        if (impact > 6) {
          this._vLong *= K.wallSpeedKeep;
          if (this.drifting && impact > 12) { this.drifting = false; this.driftCharge = 0; this.driftTier = 0; }
          if (this.onWall) this.onWall(impact);
        }
      }
    }

    // ---------- boost pads ----------
    if (q.boost && this.grounded) {
      if (!this._onPad) { this.padBoost(); if (this.onPad) this.onPad(); }
      this._onPad = true;
    } else this._onPad = false;

    // ---------- off-track rescue ----------
    const belowWorld = this.pos.y < q.height - 25 || q.fell && this.pos.y < q.height + 1;
    if (belowWorld) {
      this.respawnTimer += dt;
      if (this.respawnTimer > .35) this.doRespawn();
    } else {
      this.respawnTimer = 0;
      if (q.onRoad) this.rescueS = this.s;
    }
    if (ctl.reset) this.doRespawn();

    // ---------- lap tracking ----------
    const p = T.prog(this.s);
    const dp = p - this.lastProgress;
    if (dp < -0.5) {                        // crossed the line forwards
      this.lap++;
      if (this.onLap) this.onLap(this.lap);
    } else if (dp > 0.5) {                  // crossed it backwards
      this.lap--;
      // un-record the split we just banked, or the next lap reads as a 2s lap
      if (this.lapTimes.length) this.lapStart -= this.lapTimes.pop();
    }
    this.lastProgress = p;
    this.progress = this.lap + p;
    // wrong-way detection using the path tangent
    const dot = _v0.set(Math.sin(this.yaw), 0, Math.cos(this.yaw)).dot(_v1.set(q.tx, 0, q.tz));
    this.wrongWay = dot < -0.35 && Math.abs(vLong) > 4 && !noControl;

    this.speedKmh = Math.abs(vLong) * 3.6;

    this._updateVisual(dt, q, sd);
  }

  doRespawn() {
    const r = this.track.respawnAt(this.rescueS || this.s, 0);
    this.pos.copy(r.pos);
    this.pos.y += K.rideHeight;
    this.yaw = r.yaw;
    this.vel.set(0, 0, 0);
    this.vy = 0;
    this._vLong = 6;
    this.yawVel = 0;
    this.grounded = false;
    this.drifting = false; this.driftCharge = 0; this.driftTier = 0;
    this.boostTime = 0; this.boostTop = 1;
    this.spinTime = 0; this.squashTime = 0;
    this.invuln = 1.2;
    this.respawnTimer = 0;
    this.hint = -1;
    if (this.onRespawn) this.onRespawn();
  }

  /* ---- visuals: lean, squash, wheels, attachments ---- */
  _updateVisual(dt, q, sd) {
    const o = this.obj, ud = o.userData;
    o.position.copy(this.pos);

    // body yaw includes the drift slip angle so the kart visibly sideslips
    const slipYaw = this.drifting ? -this.driftDir * lerp(.16, .46, clamp01(this.driftCharge / 2.6)) : 0;
    ud.body.rotation.y = damp(ud.body.rotation.y, slipYaw, 9, dt);

    // lean into the turn + squat under acceleration
    const targetRoll = clamp(-this.yawVel * .16 - (this.drifting ? this.driftDir * .1 : 0), -.34, .34);
    this.visualRoll = damp(this.visualRoll, targetRoll, 8, dt);
    const accelPitch = clamp((this.boostTime > 0 ? -.09 : 0) + this.yawVel * 0, -.2, .2);
    this.visualPitch = damp(this.visualPitch, accelPitch + (this.grounded ? 0 : -.06), 6, dt);

    // align to the banked surface when grounded
    const targetBank = this.grounded ? q.bank : 0;
    this._bankLean = damp(this._bankLean || 0, targetBank, 7, dt);

    o.rotation.set(0, 0, 0);
    o.rotation.order = 'YXZ';
    o.rotation.y = this.yaw;
    o.rotation.x = this.visualPitch;
    o.rotation.z = this.visualRoll + this._bankLean;

    // suspension squash on landing / boost
    const targetSquash = this.squashTime > 0 ? .35 : (this.airTime > 0 ? 1.04 : 1);
    this.squash = damp(this.squash, targetSquash, 12, dt);
    ud.body.scale.set(1 / Math.sqrt(this.squash), this.squash, 1 / Math.sqrt(this.squash));

    // wheels
    this.wheelSpin += this._vLong * dt * 1.9;
    const steerVis = clamp(this.drifting ? this.driftDir * .45 + this.lastSteer * .2 : this.lastSteer * .48, -.6, .6);
    for (let i = 0; i < 4; i++) {
      const w = ud.wheels[i];
      w.rotation.x = this.wheelSpin;
      if (i >= 2) w.rotation.y = 0; else w.rotation.y = steerVis;
    }
    ud.driver.rotation.z = -steerVis * .18;
    ud.driver.rotation.y = steerVis * .22;

    // tail light brightens under braking / boost
    ud.tail.material.color.setHex(this.boostTime > 0 ? 0x9ff2ff : 0xff3a2a);

    // attachments
    ud.shield.visible = this.shield > 0;
    if (this.shield > 0) ud.shield.material.uniforms.uTime.value += dt;
    ud.glider.visible = this.gliding;
    if (this.gliding) {
      ud.glider.rotation.z = damp(ud.glider.rotation.z, -this.lastSteer * .2, 5, dt);
    }
  }
}
