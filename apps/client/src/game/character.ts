import * as THREE from 'three';
import { MOVE, type PlayerState } from '@arena/shared';

const part = (w: number, h: number, d: number, color: number, y: number): THREE.Mesh => {
  const geo = new THREE.BoxGeometry(w, h, d); geo.translate(0, y, 0);
  const m = new THREE.Mesh(geo, new THREE.MeshStandardMaterial({ color, roughness: 0.7 }));
  m.castShadow = true; return m;
};

/** Procedural humanoid. Origin at feet; faces -Z. */
export class Character {
  readonly root = new THREE.Group();
  private body = new THREE.Group(); private hips = new THREE.Group(); private torso = new THREE.Group();
  private head: THREE.Mesh; private arms: THREE.Group[] = []; private legs: THREE.Group[] = [];
  private phase = 0; private crouchK = 0; private rollAngle = 0;
  constructor(primary = 0x2f6fb5, secondary = 0xe8b04a) {
    this.root.add(this.body); this.body.add(this.hips); this.hips.position.y = 0.9;
    this.hips.add(this.torso);
    this.torso.add(part(0.56, 0.62, 0.3, primary, 0.31));
    this.head = part(0.26, 0.28, 0.26, secondary, 0); this.head.position.y = 0.92; this.torso.add(this.head);
    for (const s of [-1, 1]) {
      const arm = new THREE.Group(); arm.position.set(s * 0.37, 0.58, 0);
      arm.add(part(0.14, 0.58, 0.14, secondary, -0.28)); this.torso.add(arm); this.arms.push(arm);
      const leg = new THREE.Group(); leg.position.set(s * 0.15, 0, 0);
      leg.add(part(0.2, 0.9, 0.2, primary, -0.45)); this.hips.add(leg); this.legs.push(leg);
    }
  }
  /** Poses the model from sim state. `yaw` is aim yaw; `speed` is horizontal speed. */
  update(s: PlayerState, yaw: number, dt: number): void {
    const speed = Math.hypot(s.vel.x, s.vel.z);
    this.root.position.set(s.pos.x, s.pos.y, s.pos.z);
    const rolling = s.rollT > 0;
    let face = yaw;
    if (rolling) face = Math.atan2(-s.rollDirX, -s.rollDirZ);
    else if (speed > 0.5) { // lean model toward travel while keeping it readable
      const t = Math.atan2(-s.vel.x, -s.vel.z); let d = t - yaw; d = Math.atan2(Math.sin(d), Math.cos(d)); face = yaw + d * 0.35;
    }
    this.root.rotation.y = face;
    this.phase += dt * (3 + speed * 1.6);
    const k = Math.min(1, speed / MOVE.sprint);
    const swing = s.onGround ? Math.sin(this.phase) * 0.9 * k : 0.7;
    this.legs[0]!.rotation.x = swing; this.legs[1]!.rotation.x = s.onGround ? -swing : -0.4;
    this.arms[0]!.rotation.x = -swing * 0.8; this.arms[1]!.rotation.x = swing * 0.8;
    this.crouchK += ((s.crouched ? 1 : 0) - this.crouchK) * Math.min(1, dt * 14);
    this.hips.position.y = 0.9 - this.crouchK * 0.32;
    this.torso.rotation.x = this.crouchK * 0.35 + (s.sprinting ? 0.2 : 0);
    if (!s.onGround) { this.arms[0]!.rotation.x = -2.3; this.arms[1]!.rotation.x = -2.3; }
    // roll tumble about the body centre
    const target = rolling ? (1 - s.rollT / MOVE.roll.duration) * Math.PI * 2 : 0;
    this.rollAngle = target; this.body.position.y = rolling ? 0.4 : 0;
    this.body.rotation.x = -this.rollAngle;
    if (rolling) { this.legs[0]!.rotation.x = this.legs[1]!.rotation.x = 1.4; }
  }
}
