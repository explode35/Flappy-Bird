/**
 * ============================================================================
 *  AIMath — shared scratch math for the enemy systems.
 * ============================================================================
 *  Everything here is allocation-free at runtime: every temporary is hoisted to
 *  module scope. Callers must never hold a reference to a returned scratch
 *  object across a call to another helper in this file.
 * ============================================================================
 */
import * as THREE from 'three';
import { clamp, lerp, damp, smoothstep } from '../core/Contracts.js';

export { clamp, lerp, damp, smoothstep };

export const TAU = Math.PI * 2;
export const DEG = Math.PI / 180;

/* -------------------------------------------------------------------------- */
/* Scratch pool                                                               */
/* -------------------------------------------------------------------------- */
const _a = new THREE.Vector3();
const _b = new THREE.Vector3();
const _c = new THREE.Vector3();
const _d = new THREE.Vector3();
const _qa = new THREE.Quaternion();
const _qb = new THREE.Quaternion();
const _qc = new THREE.Quaternion();
const _ea = new THREE.Euler();

/** A tiny ring of Vector3s callers can borrow for a single expression. */
const _ring = [];
for (let i = 0; i < 16; i++) _ring.push(new THREE.Vector3());
let _ringHead = 0;
export function v3() {
  const v = _ring[_ringHead];
  _ringHead = (_ringHead + 1) & 15;
  return v;
}

/* -------------------------------------------------------------------------- */
/* Angles                                                                     */
/* -------------------------------------------------------------------------- */

/** Wrap to (-PI, PI]. */
export function wrapPi(a) {
  a = (a + Math.PI) % TAU;
  if (a < 0) a += TAU;
  return a - Math.PI;
}

/** Shortest signed delta from a to b. */
export function angleDelta(a, b) { return wrapPi(b - a); }

/** Frame-rate independent approach of an angle, respecting wraparound. */
export function dampAngle(a, b, lambda, dt) {
  return a + angleDelta(a, b) * (1 - Math.exp(-lambda * dt));
}

/** Yaw (rotation about +Y) that points +Z down the given world direction. */
export function yawOf(dx, dz) { return Math.atan2(dx, dz); }

/* -------------------------------------------------------------------------- */
/* Noise — cheap value noise for organic jitter (breathing, sway, aim wander)  */
/* -------------------------------------------------------------------------- */
const NOISE_N = 256;
const NOISE = new Float32Array(NOISE_N);
{
  let s = 0x2f6e2b1 >>> 0;
  for (let i = 0; i < NOISE_N; i++) {
    s = (s + 0x6D2B79F5) | 0;
    let t = Math.imul(s ^ (s >>> 15), 1 | s);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    NOISE[i] = ((t ^ (t >>> 14)) >>> 0) / 4294967296 * 2 - 1;
  }
}
/** Smooth 1D value noise in [-1,1], period NOISE_N. */
export function noise1(x) {
  const xi = Math.floor(x);
  const f = x - xi;
  const i0 = ((xi % NOISE_N) + NOISE_N) % NOISE_N;
  const i1 = (i0 + 1) % NOISE_N;
  const u = f * f * (3 - 2 * f);
  return NOISE[i0] + (NOISE[i1] - NOISE[i0]) * u;
}
/** Two-octave version, still cheap. */
export function fbm1(x) { return noise1(x) * 0.66 + noise1(x * 2.17 + 31.7) * 0.34; }

/* -------------------------------------------------------------------------- */
/* Two-bone IK                                                                */
/* -------------------------------------------------------------------------- */

/**
 * Analytic two-bone IK.
 * @param {THREE.Vector3} rootPos   world position of the chain root (shoulder/hip)
 * @param {THREE.Vector3} targetPos world position the end effector should reach
 * @param {number} l1               length of the upper segment
 * @param {number} l2               length of the lower segment
 * @param {THREE.Vector3} poleDir   world direction the mid joint should bend toward
 * @param {THREE.Vector3} outMid    receives the mid-joint (elbow/knee) world position
 * @param {THREE.Vector3} outEnd    receives the (possibly clamped) end position
 */
export function solveTwoBone(rootPos, targetPos, l1, l2, poleDir, outMid, outEnd) {
  const dir = _a.subVectors(targetPos, rootPos);
  let dist = dir.length();
  const maxD = (l1 + l2) * 0.995;
  const minD = Math.abs(l1 - l2) * 1.02 + 1e-3;
  if (dist < 1e-5) { dir.set(0, -1, 0); dist = 1e-5; }
  else dir.multiplyScalar(1 / dist);
  const cd = clamp(dist, minD, maxD);
  outEnd.copy(rootPos).addScaledVector(dir, cd);

  // Cosine rule: projection of the mid joint along the root->target axis.
  const along = clamp((l1 * l1 + cd * cd - l2 * l2) / (2 * cd), -l1, l1);
  const h = Math.sqrt(Math.max(0, l1 * l1 - along * along));

  // Orthogonalise the pole against the chain axis.
  const orth = _b.copy(poleDir).addScaledVector(dir, -poleDir.dot(dir));
  if (orth.lengthSq() < 1e-8) {
    orth.set(0, 1, 0).addScaledVector(dir, -dir.y);
    if (orth.lengthSq() < 1e-8) orth.set(1, 0, 0).addScaledVector(dir, -dir.x);
  }
  orth.normalize();

  outMid.copy(rootPos).addScaledVector(dir, along).addScaledVector(orth, h);
}

/* -------------------------------------------------------------------------- */
/* Bone orientation helpers                                                   */
/* -------------------------------------------------------------------------- */
/*
 * The soldier rig is authored with *identity* bind rotations: every bone's
 * world rotation in the bind pose is the identity, and the bone's direction is
 * baked into its child offsets. That makes these two helpers exact:
 *
 *   worldRot(bone) = qDelta,  where qDelta maps bindDir -> desiredDir
 *   localRot(bone) = inverse(parentWorldRot) * qDelta
 */

/**
 * Rotate a bone so its bind direction points along `worldDir`.
 * Requires the parent chain's world matrices to be current.
 * @param {number} twist extra roll about worldDir, radians
 */
export function aimBone(bone, bindDir, worldDir, twist) {
  _c.copy(worldDir);
  const l = _c.length();
  if (l < 1e-6) return;
  _c.multiplyScalar(1 / l);
  _qa.setFromUnitVectors(bindDir, _c);
  if (twist) { _qb.setFromAxisAngle(_c, twist); _qa.premultiply(_qb); }
  if (bone.parent) {
    bone.parent.getWorldQuaternion(_qb).invert();
    bone.quaternion.copy(_qb).multiply(_qa);
  } else {
    bone.quaternion.copy(_qa);
  }
}

/** Same as aimBone but blends toward the aimed rotation by `w`. */
export function aimBoneBlend(bone, bindDir, worldDir, twist, w) {
  if (w >= 0.999) return aimBone(bone, bindDir, worldDir, twist);
  if (w <= 0.001) return;
  _qc.copy(bone.quaternion);
  aimBone(bone, bindDir, worldDir, twist);
  bone.quaternion.slerpQuaternions(_qc, bone.quaternion, w);
}

/** Set a bone's world rotation directly (used by the ragdoll mapper). */
export function setBoneWorldQuat(bone, q) {
  if (bone.parent) {
    bone.parent.getWorldQuaternion(_qb).invert();
    bone.quaternion.copy(_qb).multiply(q);
  } else bone.quaternion.copy(q);
}

/* -------------------------------------------------------------------------- */
/* Pose buffers                                                               */
/* -------------------------------------------------------------------------- */
/*
 * A "pose" is a flat Float32Array: 4 floats of quaternion per bone, followed by
 * 3 floats of root translation offset. Poses are blended with nlerp, which is
 * indistinguishable from slerp at the small angular deltas we use and much
 * cheaper.
 */

export function makePose(boneCount) {
  const p = new Float32Array(boneCount * 4 + 3);
  for (let i = 0; i < boneCount; i++) p[i * 4 + 3] = 1;
  return p;
}

export function poseIdentity(pose, boneCount) {
  for (let i = 0; i < boneCount; i++) {
    const o = i * 4;
    pose[o] = 0; pose[o + 1] = 0; pose[o + 2] = 0; pose[o + 3] = 1;
  }
  const r = boneCount * 4;
  pose[r] = 0; pose[r + 1] = 0; pose[r + 2] = 0;
}

/** Write an XYZ-euler rotation into a pose slot. */
export function poseSetEuler(pose, i, x, y, z) {
  // Inlined THREE.Quaternion.setFromEuler for XYZ order.
  const c1 = Math.cos(x * 0.5), c2 = Math.cos(y * 0.5), c3 = Math.cos(z * 0.5);
  const s1 = Math.sin(x * 0.5), s2 = Math.sin(y * 0.5), s3 = Math.sin(z * 0.5);
  const o = i * 4;
  pose[o]     = s1 * c2 * c3 + c1 * s2 * s3;
  pose[o + 1] = c1 * s2 * c3 - s1 * c2 * s3;
  pose[o + 2] = c1 * c2 * s3 + s1 * s2 * c3;
  pose[o + 3] = c1 * c2 * c3 - s1 * s2 * s3;
}

/** dst = nlerp(dst, src, w), including the root offset. */
export function poseBlend(dst, src, w, boneCount) {
  if (w <= 0) return;
  if (w >= 1) { dst.set(src); return; }
  for (let i = 0; i < boneCount; i++) {
    const o = i * 4;
    let bx = src[o], by = src[o + 1], bz = src[o + 2], bw = src[o + 3];
    const ax = dst[o], ay = dst[o + 1], az = dst[o + 2], aw = dst[o + 3];
    // Take the short way round.
    if (ax * bx + ay * by + az * bz + aw * bw < 0) { bx = -bx; by = -by; bz = -bz; bw = -bw; }
    let x = ax + (bx - ax) * w, y = ay + (by - ay) * w;
    let z = az + (bz - az) * w, ww = aw + (bw - aw) * w;
    const il = 1 / Math.sqrt(x * x + y * y + z * z + ww * ww);
    dst[o] = x * il; dst[o + 1] = y * il; dst[o + 2] = z * il; dst[o + 3] = ww * il;
  }
  const r = boneCount * 4;
  dst[r] += (src[r] - dst[r]) * w;
  dst[r + 1] += (src[r + 1] - dst[r + 1]) * w;
  dst[r + 2] += (src[r + 2] - dst[r + 2]) * w;
}

/** Apply a pose onto a bone array. */
export function poseApply(pose, bones, boneCount, rootBone) {
  for (let i = 0; i < boneCount; i++) {
    const o = i * 4;
    const q = bones[i].quaternion;
    q.set(pose[o], pose[o + 1], pose[o + 2], pose[o + 3]);
  }
  if (rootBone) {
    const r = boneCount * 4;
    rootBone.position.set(pose[r], pose[r + 1], pose[r + 2]);
  }
}

/* -------------------------------------------------------------------------- */
/* Misc                                                                       */
/* -------------------------------------------------------------------------- */

/** Squared XZ distance — used everywhere in the AI, so keep it inlineable. */
export function dist2XZ(ax, az, bx, bz) {
  const dx = ax - bx, dz = az - bz;
  return dx * dx + dz * dz;
}

/** Random point on a disc, written into out (uses supplied rng). */
export function randDisc(rng, radius, out, y) {
  const a = rng() * TAU;
  const r = Math.sqrt(rng()) * radius;
  out.set(Math.cos(a) * r, y || 0, Math.sin(a) * r);
  return out;
}

/** Gaussian-ish sample in [-1,1] (sum of three uniforms). */
export function gauss(rng) { return (rng() + rng() + rng()) * (2 / 3) - 1; }

export const scratch = { _a, _b, _c, _d, _qa, _qb, _qc, _ea };
