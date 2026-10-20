import * as THREE from 'three';
import { RARITY, WEAPONS, type Pickup } from '@arena/shared';
import { buildWeaponModel } from './weaponModel';

interface PickupView {
  root: THREE.Group;
  ring: THREE.Mesh;
  beam: THREE.Mesh;
  holder: THREE.Group | null;
  gunId: string | null;
  rarity: number;
  phase: number;
}

const ringGeo = new THREE.RingGeometry(0.65, 0.85, 32);
const beamGeo = new THREE.CylinderGeometry(0.06, 0.06, 5, 8, 1, true);
const emptyMat = new THREE.MeshBasicMaterial({ color: 0x66707a, transparent: true, opacity: 0.5, side: THREE.DoubleSide, depthWrite: false });
const ringMats = RARITY.map((r) => new THREE.MeshBasicMaterial({ color: r.color, transparent: true, opacity: 0.85, side: THREE.DoubleSide, depthWrite: false }));
const beamMats = RARITY.map((r) => new THREE.MeshBasicMaterial({ color: r.color, transparent: true, opacity: 0.28, side: THREE.DoubleSide, depthWrite: false }));

function disposeGroup(g: THREE.Object3D): void {
  g.traverse((o: THREE.Object3D) => { if (o instanceof THREE.Mesh) o.geometry.dispose(); });
}

/**
 * Draws every pickup in the sim: a ring on the pad (grey while empty), and while stocked a spinning gun
 * with a beam in its rarity colour (white Common, blue Rare, purple Epic) so it can be spotted across the arena.
 */
export class PickupViews {
  private views = new Map<number, PickupView>();
  constructor(private scene: THREE.Scene) {}

  update(pickups: readonly Pickup[], dt: number, time: number): void {
    const live = new Set<number>();
    for (const p of pickups) {
      live.add(p.id);
      let v = this.views.get(p.id);
      if (!v) {
        const root = new THREE.Group();
        root.position.set(p.x, p.y, p.z);
        const ring = new THREE.Mesh(ringGeo, emptyMat);
        ring.rotation.x = -Math.PI / 2; ring.position.y = 0.03;
        const beam = new THREE.Mesh(beamGeo, beamMats[0]);
        beam.position.y = 2.5;
        root.add(ring, beam);
        this.scene.add(root);
        v = { root, ring, beam, holder: null, gunId: null, rarity: -1, phase: p.id * 1.7 };
        this.views.set(p.id, v);
      }
      const s = p.state;
      v.beam.visible = s !== null;
      if (!s) {
        v.ring.material = emptyMat;
        if (v.holder) { v.root.remove(v.holder); disposeGroup(v.holder); v.holder = null; v.gunId = null; }
        continue;
      }
      if (v.rarity !== s.rarity) { v.rarity = s.rarity; v.ring.material = ringMats[s.rarity] ?? ringMats[0]!; v.beam.material = beamMats[s.rarity] ?? beamMats[0]!; }
      if (v.gunId !== s.id) {
        if (v.holder) { v.root.remove(v.holder); disposeGroup(v.holder); }
        const m = buildWeaponModel(WEAPONS[s.id].modelId);
        m.group.position.z = 0.25; // centre the gun on its spin axis
        m.group.scale.setScalar(1.5);
        v.holder = new THREE.Group();
        v.holder.add(m.group);
        v.root.add(v.holder);
        v.gunId = s.id;
      }
      v.holder!.rotation.y += dt * 1.6;
      v.holder!.position.y = 1.0 + Math.sin(time * 2 + v.phase) * 0.1;
    }
    for (const [id, v] of this.views)
      if (!live.has(id)) { this.scene.remove(v.root); disposeGroup(v.root); this.views.delete(id); }
  }

  clear(): void {
    for (const v of this.views.values()) { this.scene.remove(v.root); disposeGroup(v.root); }
    this.views.clear();
  }
}
