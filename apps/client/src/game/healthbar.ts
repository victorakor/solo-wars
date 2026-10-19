import * as THREE from 'three';

const bgMat = new THREE.MeshBasicMaterial({ color: 0x000000, transparent: true, opacity: 0.55, depthTest: false });
const fgMat = new THREE.MeshBasicMaterial({ color: 0x6fe07a, depthTest: false });
const lowMat = new THREE.MeshBasicMaterial({ color: 0xe0584a, depthTest: false });

/** Camera-facing health bar floating above a target. */
export class HealthBar {
  readonly root = new THREE.Group();
  private fill: THREE.Mesh;
  constructor(width = 0.9) {
    const bg = new THREE.Mesh(new THREE.PlaneGeometry(width + 0.04, 0.1), bgMat);
    const geo = new THREE.PlaneGeometry(width, 0.07); geo.translate(width / 2, 0, 0); // scale from the left edge
    this.fill = new THREE.Mesh(geo, fgMat);
    this.fill.position.set(-width / 2, 0, 0.001);
    bg.renderOrder = 10; this.fill.renderOrder = 11;
    this.root.add(bg, this.fill);
  }
  update(pos: THREE.Vector3, frac: number, camera: THREE.Camera, visible: boolean): void {
    this.root.visible = visible;
    if (!visible) return;
    this.root.position.copy(pos);
    this.root.quaternion.copy(camera.quaternion);
    const f = Math.max(0.001, Math.min(1, frac));
    this.fill.scale.x = f;
    this.fill.material = f < 0.3 ? lowMat : fgMat;
  }
}
