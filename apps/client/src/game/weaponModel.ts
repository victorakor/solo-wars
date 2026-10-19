import * as THREE from 'three';

export interface WeaponModel {
  group: THREE.Group;
  /** Barrel tip; muzzle flash and tracers start here. */
  muzzle: THREE.Object3D;
}

type Part = [w: number, h: number, d: number, x: number, y: number, z: number, color: number];

const DARK = 0x2a2d31, MID = 0x555b63;

/** Box-built guns. Origin at the grip, barrel along -Z. Replaced by proper models in Phase 8. */
const MODELS: Record<string, { parts: Part[]; muzzleZ: number }> = {
  sidearm: { muzzleZ: -0.24, parts: [[0.07, 0.09, 0.26, 0, 0, -0.1, DARK], [0.06, 0.14, 0.07, 0, -0.1, 0.02, MID]] },
  rattler: {
    muzzleZ: -0.48,
    parts: [[0.08, 0.11, 0.4, 0, 0, -0.15, DARK], [0.06, 0.2, 0.07, 0, -0.14, -0.08, MID], [0.04, 0.04, 0.12, 0, 0.01, -0.42, MID]],
  },
  vanguard: {
    muzzleZ: -0.56,
    parts: [[0.08, 0.11, 0.62, 0, 0, -0.22, DARK], [0.06, 0.12, 0.22, 0, -0.01, 0.24, MID], [0.06, 0.18, 0.08, 0, -0.14, -0.12, MID], [0.04, 0.05, 0.1, 0, 0.08, -0.2, 0x8a4a2a]],
  },
  breaker: {
    muzzleZ: -0.63,
    parts: [[0.09, 0.1, 0.7, 0, 0, -0.25, DARK], [0.11, 0.07, 0.22, 0, -0.07, -0.35, 0x8a6a3a], [0.06, 0.12, 0.22, 0, -0.02, 0.22, MID]],
  },
  longshot: {
    muzzleZ: -0.82,
    parts: [[0.07, 0.1, 0.95, 0, 0, -0.3, DARK], [0.06, 0.06, 0.3, 0, 0.09, -0.25, 0x1a1c1f], [0.06, 0.13, 0.25, 0, -0.02, 0.28, MID]],
  },
};

const mats = new Map<number, THREE.MeshStandardMaterial>();
const mat = (c: number): THREE.MeshStandardMaterial => {
  let m = mats.get(c);
  if (!m) { m = new THREE.MeshStandardMaterial({ color: c, roughness: 0.6, metalness: 0.3 }); mats.set(c, m); }
  return m;
};

export function buildWeaponModel(modelId: string): WeaponModel {
  const def = MODELS[modelId] ?? MODELS.sidearm!;
  const group = new THREE.Group();
  for (const [w, h, d, x, y, z, c] of def.parts) {
    const m = new THREE.Mesh(new THREE.BoxGeometry(w, h, d), mat(c));
    m.position.set(x, y, z); m.castShadow = true; group.add(m);
  }
  const muzzle = new THREE.Object3D();
  muzzle.position.set(0, 0.01, def.muzzleZ);
  group.add(muzzle);
  return { group, muzzle };
}
