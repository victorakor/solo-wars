import * as THREE from 'three';
import type { SceneDef } from '@arena/shared';

const COLORS: Record<string, number> = {
  floor: 0x3a3630, wall: 0x4a4540, container: 0x9a4a2a, crate: 0x8a6a3a, pipe: 0x6a7078,
  stair: 0x6d655c, catwalk: 0x58606a, bridge: 0x58606a, rail: 0xc99a2e, pillar: 0x50555c,
};
export function buildScene(def: SceneDef, scene: THREE.Scene): void {
  scene.background = new THREE.Color(0x1a1410);
  scene.fog = new THREE.Fog(0x1a1410, 30, 90);
  scene.add(new THREE.HemisphereLight(0xffc890, 0x4a3a2c, 1.7));
  const sun = new THREE.DirectionalLight(0xffb060, 1.6);
  sun.position.set(-14, 26, 10); sun.castShadow = true;
  sun.shadow.mapSize.set(2048, 2048);
  Object.assign(sun.shadow.camera, { left: -34, right: 34, top: 26, bottom: -26, near: 1, far: 70 });
  scene.add(sun);
  for (const [x, z] of [[-14, -8], [14, 8], [0, 0]] as const) {
    const l = new THREE.PointLight(0xff9a40, 60, 26, 1.6); l.position.set(x, 8, z); scene.add(l);
  }
  const mats = new Map<string, THREE.MeshStandardMaterial>();
  for (const b of def.boxes) {
    const kind = b.kind ?? 'wall';
    if (!mats.has(kind)) mats.set(kind, new THREE.MeshStandardMaterial({ color: COLORS[kind] ?? 0x777777, roughness: 0.85, metalness: kind === 'rail' ? 0.4 : 0.1 }));
    const m = new THREE.Mesh(new THREE.BoxGeometry(b.max.x - b.min.x, b.max.y - b.min.y, b.max.z - b.min.z), mats.get(kind));
    m.position.set((b.min.x + b.max.x) / 2, (b.min.y + b.max.y) / 2, (b.min.z + b.max.z) / 2);
    m.castShadow = kind !== 'floor'; m.receiveShadow = true;
    scene.add(m);
  }
}
