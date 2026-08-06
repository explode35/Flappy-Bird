/**
 * Viewmodel material set.
 *
 * Everything is derived from `ctx.materials` (gunmetal / polymer / metalPanel)
 * so the weapon shares the world's procedural PBR maps, then upgraded to
 * MeshPhysicalMaterial where the viewmodel needs response the world doesn't:
 * anisotropic brushed-metal highlights on machined aluminium, clearcoat on
 * parkerised steel, real transmission on the optic glass.
 *
 * The gun is a third of the screen at all times — it gets the good materials.
 */
import * as THREE from 'three';

function srcOf(ctx, name) {
  try {
    const m = ctx.materials && ctx.materials.get ? ctx.materials.get(name) : null;
    return m && m.isMaterial ? m : null;
  } catch { return null; }
}

/** Copy the procedural map set off a world material onto a viewmodel one. */
function inheritMaps(dst, src, repeat) {
  if (!src) return dst;
  const keys = ['map', 'normalMap', 'roughnessMap', 'metalnessMap', 'aoMap', 'bumpMap'];
  for (const k of keys) {
    const t = src[k];
    if (!t || !t.isTexture) continue;
    const c = t.clone();
    c.needsUpdate = true;
    c.wrapS = c.wrapT = THREE.RepeatWrapping;
    if (repeat) c.repeat.set(repeat[0], repeat[1]);
    c.anisotropy = 8;
    dst[k] = c;
  }
  if (src.normalScale && dst.normalScale) dst.normalScale.copy(src.normalScale);
  return dst;
}

export function buildGunMaterials(ctx) {
  const gunmetalSrc = srcOf(ctx, 'gunmetal');
  const polymerSrc = srcOf(ctx, 'polymer');
  const panelSrc = srcOf(ctx, 'metalPanel');

  const anisoRot = Math.PI * 0.5; // brush direction runs along the barrel

  // --- Parkerised receiver / machined aluminium -------------------------
  const metal = new THREE.MeshPhysicalMaterial({
    color: 0x4a4c50,
    roughness: 0.44,
    metalness: 1.0,
    anisotropy: 0.55,
    anisotropyRotation: anisoRot,
    clearcoat: 0.18,
    clearcoatRoughness: 0.55,
    envMapIntensity: 1.15,
    emissive: 0x0a0c10,
    emissiveIntensity: 0.55,
  });
  inheritMaps(metal, gunmetalSrc, [3, 3]);
  metal.name = 'vm_metal';

  // --- Blued / nitrided steel: barrel, bolt, pins -----------------------
  const steel = new THREE.MeshPhysicalMaterial({
    color: 0x2a2c31,
    roughness: 0.28,
    metalness: 1.0,
    anisotropy: 0.72,
    anisotropyRotation: anisoRot,
    clearcoat: 0.3,
    clearcoatRoughness: 0.3,
    envMapIntensity: 1.35,
    emissive: 0x090b0f,
    emissiveIntensity: 0.5,
  });
  inheritMaps(steel, gunmetalSrc, [5, 5]);
  steel.name = 'vm_steel';

  // --- Worn / edge-lit metal for muzzle devices and gas blocks ----------
  const hotMetal = new THREE.MeshPhysicalMaterial({
    color: 0x1d1e21,
    roughness: 0.52,
    metalness: 1.0,
    anisotropy: 0.4,
    anisotropyRotation: anisoRot,
    envMapIntensity: 1.0,
    emissive: 0x160c06,
    emissiveIntensity: 0.7,
  });
  inheritMaps(hotMetal, panelSrc, [4, 4]);
  hotMetal.name = 'vm_hotmetal';

  // --- Reinforced polymer: grip, stock, handguard furniture, magazine ---
  const polymer = new THREE.MeshPhysicalMaterial({
    color: 0x35383a,
    roughness: 0.72,
    metalness: 0.0,
    sheen: 0.25,
    sheenRoughness: 0.8,
    sheenColor: new THREE.Color(0x6a6f72),
    clearcoat: 0.08,
    clearcoatRoughness: 0.85,
    envMapIntensity: 0.85,
  });
  inheritMaps(polymer, polymerSrc, [3, 3]);
  polymer.name = 'vm_polymer';

  // --- Flat dark rubber: grip inserts, buttpad, cheek rest --------------
  const rubber = new THREE.MeshPhysicalMaterial({
    color: 0x1b1d1e,
    roughness: 0.92,
    metalness: 0.0,
    sheen: 0.35,
    sheenRoughness: 0.95,
    envMapIntensity: 0.5,
  });
  inheritMaps(rubber, polymerSrc, [6, 6]);
  rubber.name = 'vm_rubber';

  // --- Optic body: hard-anodised matte black ----------------------------
  const optic = new THREE.MeshPhysicalMaterial({
    color: 0x1a1b1d,
    roughness: 0.55,
    metalness: 0.9,
    clearcoat: 0.25,
    clearcoatRoughness: 0.45,
    envMapIntensity: 1.0,
  });
  inheritMaps(optic, gunmetalSrc, [6, 6]);
  optic.name = 'vm_optic';

  // --- Optic glass: physical transmission with the classic red-dot AR coat
  const glass = new THREE.MeshPhysicalMaterial({
    color: 0xbcd6e8,
    roughness: 0.045,
    metalness: 0.0,
    transmission: 0.92,
    thickness: 0.004,
    ior: 1.52,
    transparent: true,
    opacity: 1.0,
    clearcoat: 1.0,
    clearcoatRoughness: 0.02,
    envMapIntensity: 1.6,
    specularIntensity: 1.0,
    attenuationColor: new THREE.Color(0x6fa4c8),
    attenuationDistance: 0.05,
    side: THREE.DoubleSide,
    depthWrite: false,
  });
  glass.name = 'vm_glass';

  // --- Brass: cartridges visible in the mag, ejected casings ------------
  const brass = new THREE.MeshPhysicalMaterial({
    color: 0xb08a3c,
    roughness: 0.24,
    metalness: 1.0,
    anisotropy: 0.35,
    clearcoat: 0.4,
    clearcoatRoughness: 0.2,
    envMapIntensity: 1.5,
  });
  brass.name = 'vm_brass';

  const copper = new THREE.MeshPhysicalMaterial({
    color: 0x8d5a32,
    roughness: 0.35,
    metalness: 1.0,
    envMapIntensity: 1.2,
  });
  copper.name = 'vm_copper';

  // --- Gloves: cordura + goatskin palm ----------------------------------
  const glove = new THREE.MeshPhysicalMaterial({
    color: 0x2e2b26,
    roughness: 0.88,
    metalness: 0.0,
    sheen: 0.5,
    sheenRoughness: 0.75,
    sheenColor: new THREE.Color(0x6b6152),
    envMapIntensity: 0.7,
  });
  inheritMaps(glove, polymerSrc, [8, 8]);
  glove.name = 'vm_glove';

  const gloveGrip = new THREE.MeshPhysicalMaterial({
    color: 0x181614,
    roughness: 0.95,
    metalness: 0.0,
    sheen: 0.2,
    envMapIntensity: 0.4,
  });
  gloveGrip.name = 'vm_glovegrip';

  // --- Sleeve: multicam-ish dusty fatigue fabric ------------------------
  const sleeve = new THREE.MeshPhysicalMaterial({
    color: 0x5c5847,
    roughness: 0.95,
    metalness: 0.0,
    sheen: 0.6,
    sheenRoughness: 0.9,
    sheenColor: new THREE.Color(0x8b8570),
    envMapIntensity: 0.6,
  });
  inheritMaps(sleeve, polymerSrc, [10, 10]);
  sleeve.name = 'vm_sleeve';

  // --- Grenade body: olive drab painted steel ---------------------------
  const olive = new THREE.MeshPhysicalMaterial({
    color: 0x3d4429,
    roughness: 0.62,
    metalness: 0.55,
    clearcoat: 0.15,
    clearcoatRoughness: 0.6,
    envMapIntensity: 0.9,
  });
  inheritMaps(olive, panelSrc, [3, 3]);
  olive.name = 'vm_olive';

  const safetyRed = new THREE.MeshPhysicalMaterial({
    color: 0x8e2418,
    roughness: 0.55,
    metalness: 0.2,
    emissive: 0x220604,
    emissiveIntensity: 0.6,
  });
  safetyRed.name = 'vm_safety';

  // --- White paint for selector / sight markings ------------------------
  const paint = new THREE.MeshPhysicalMaterial({
    color: 0xc9c3b4,
    roughness: 0.6,
    metalness: 0.0,
    emissive: 0x1a1a18,
    emissiveIntensity: 0.4,
  });
  paint.name = 'vm_paint';

  // --- Tritium / fibre-optic sight inserts ------------------------------
  const tritium = new THREE.MeshStandardMaterial({
    color: 0x0d1a10,
    roughness: 0.3,
    metalness: 0,
    emissive: 0x2fbf6a,
    emissiveIntensity: 2.4,
  });
  tritium.name = 'vm_tritium';

  const mats = {
    metal, steel, hotMetal, polymer, rubber, optic, glass, brass, copper,
    glove, gloveGrip, sleeve, olive, safetyRed, paint, tritium,
  };
  mats._all = Object.values(mats).filter((m) => m && m.isMaterial);
  return mats;
}

export function disposeGunMaterials(mats) {
  if (!mats || !mats._all) return;
  for (const m of mats._all) {
    for (const k of ['map', 'normalMap', 'roughnessMap', 'metalnessMap', 'aoMap', 'bumpMap']) {
      if (m[k] && m[k].isTexture) m[k].dispose();
    }
    m.dispose();
  }
}
