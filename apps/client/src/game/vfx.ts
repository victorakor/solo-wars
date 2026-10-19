import * as THREE from 'three';
import type { Vec3 } from '@arena/shared';

const TRACER_LIFE = 0.07;

/** Pooled bullet tracers (thin stretched boxes) and spark bursts. Nothing is allocated after construction. */
class Sparks {
  private pos: Float32Array; private vel: Float32Array; private life: Float32Array;
  private geo = new THREE.BufferGeometry();
  readonly points: THREE.Points;
  private next = 0;
  constructor(private cap: number, color: number, size: number) {
    this.pos = new Float32Array(cap * 3).fill(-1000);
    this.vel = new Float32Array(cap * 3);
    this.life = new Float32Array(cap);
    this.geo.setAttribute('position', new THREE.BufferAttribute(this.pos, 3));
    this.points = new THREE.Points(this.geo, new THREE.PointsMaterial({ color, size, sizeAttenuation: true, transparent: true, depthWrite: false }));
    this.points.frustumCulled = false;
  }
  burst(p: Vec3, n: number, speed: number): void {
    for (let k = 0; k < n; k++) {
      const i = this.next; this.next = (this.next + 1) % this.cap;
      const a = Math.random() * Math.PI * 2, u = Math.random() * 2 - 1, r = Math.sqrt(1 - u * u), s = speed * (0.4 + Math.random() * 0.6);
      this.pos[i * 3] = p.x; this.pos[i * 3 + 1] = p.y; this.pos[i * 3 + 2] = p.z;
      this.vel[i * 3] = Math.cos(a) * r * s; this.vel[i * 3 + 1] = Math.abs(u) * s + 1; this.vel[i * 3 + 2] = Math.sin(a) * r * s;
      this.life[i] = 0.2 + Math.random() * 0.2;
    }
  }
  update(dt: number): void {
    for (let i = 0; i < this.cap; i++) {
      if (this.life[i]! <= 0) continue;
      this.life[i]! -= dt;
      if (this.life[i]! <= 0) { this.pos[i * 3 + 1] = -1000; continue; }
      this.vel[i * 3 + 1]! -= 14 * dt;
      this.pos[i * 3]! += this.vel[i * 3]! * dt; this.pos[i * 3 + 1]! += this.vel[i * 3 + 1]! * dt; this.pos[i * 3 + 2]! += this.vel[i * 3 + 2]! * dt;
    }
    (this.geo.getAttribute('position') as THREE.BufferAttribute).needsUpdate = true;
  }
}

export class Vfx {
  private tracers: THREE.Mesh[] = []; private tracerLife: Float32Array;
  private nextTracer = 0;
  private world = new Sparks(160, 0xffd9a0, 0.12);
  private hit = new Sparks(160, 0x7fe8ff, 0.14);
  private target = new THREE.Vector3();

  constructor(scene: THREE.Scene, tracerCount = 48) {
    const geo = new THREE.BoxGeometry(0.035, 0.035, 1); geo.translate(0, 0, 0.5); // grows along +Z from its origin
    const mat = new THREE.MeshBasicMaterial({ color: 0xffe9a8 });
    this.tracerLife = new Float32Array(tracerCount);
    for (let i = 0; i < tracerCount; i++) {
      const m = new THREE.Mesh(geo, mat); m.visible = false; m.frustumCulled = false; scene.add(m); this.tracers.push(m);
    }
    scene.add(this.world.points, this.hit.points);
  }

  tracer(from: THREE.Vector3, to: Vec3): void {
    const i = this.nextTracer; this.nextTracer = (this.nextTracer + 1) % this.tracers.length;
    const m = this.tracers[i]!;
    this.target.set(to.x, to.y, to.z);
    m.position.copy(from); m.lookAt(this.target); // +Z of a mesh points at the target
    m.scale.set(1, 1, from.distanceTo(this.target));
    m.visible = true; this.tracerLife[i] = TRACER_LIFE;
  }

  impact(p: Vec3, onTarget: boolean): void {
    if (onTarget) this.hit.burst(p, 10, 5); else this.world.burst(p, 8, 6);
  }

  update(dt: number): void {
    for (let i = 0; i < this.tracers.length; i++) {
      if (this.tracerLife[i]! <= 0) continue;
      this.tracerLife[i]! -= dt;
      const m = this.tracers[i]!;
      if (this.tracerLife[i]! <= 0) { m.visible = false; continue; }
      const k = this.tracerLife[i]! / TRACER_LIFE;
      m.scale.x = m.scale.y = k;
    }
    this.world.update(dt); this.hit.update(dt);
  }
}
