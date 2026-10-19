export interface Vec3 { x: number; y: number; z: number }
export interface Box { min: Vec3; max: Vec3; kind?: string }

const CELL = 4;
const TOL = 1e-6;

/** Static AABB world with a uniform XZ grid for broadphase. */
export class CollisionWorld {
  private grid = new Map<number, number[]>();
  private stamp: Int32Array;
  private tick = 0;
  constructor(public readonly boxes: readonly Box[]) {
    this.stamp = new Int32Array(boxes.length);
    boxes.forEach((b, i) => {
      for (let cx = Math.floor(b.min.x / CELL); cx <= Math.floor(b.max.x / CELL); cx++)
        for (let cz = Math.floor(b.min.z / CELL); cz <= Math.floor(b.max.z / CELL); cz++) {
          const k = cx * 100003 + cz;
          const arr = this.grid.get(k);
          if (arr) arr.push(i); else this.grid.set(k, [i]);
        }
    });
  }
  /** Boxes strictly overlapping the AABB (touching does not count). */
  query(min: Vec3, max: Vec3, out: Box[] = []): Box[] {
    out.length = 0;
    this.tick++;
    for (let cx = Math.floor(min.x / CELL); cx <= Math.floor(max.x / CELL); cx++)
      for (let cz = Math.floor(min.z / CELL); cz <= Math.floor(max.z / CELL); cz++) {
        const arr = this.grid.get(cx * 100003 + cz);
        if (!arr) continue;
        for (const i of arr) {
          if (this.stamp[i] === this.tick) continue;
          this.stamp[i] = this.tick;
          const b = this.boxes[i]!;
          if (min.x < b.max.x - TOL && max.x > b.min.x + TOL && min.y < b.max.y - TOL &&
              max.y > b.min.y + TOL && min.z < b.max.z - TOL && max.z > b.min.z + TOL) out.push(b);
        }
      }
    return out;
  }
  /** Ray vs all boxes (slab method). Returns nearest hit distance or null. */
  raycast(o: Vec3, d: Vec3, maxDist: number): number | null {
    let best = maxDist, hit = false;
    for (const b of this.boxes) {
      let t0 = 0, t1 = best;
      for (const a of ['x', 'y', 'z'] as const) {
        if (Math.abs(d[a]) < 1e-9) { if (o[a] < b.min[a] || o[a] > b.max[a]) { t1 = -1; break; } continue; }
        let ta = (b.min[a] - o[a]) / d[a], tb = (b.max[a] - o[a]) / d[a];
        if (ta > tb) [ta, tb] = [tb, ta];
        t0 = Math.max(t0, ta); t1 = Math.min(t1, tb);
        if (t0 > t1) break;
      }
      if (t0 <= t1 && t1 >= 0) { best = t0; hit = true; }
    }
    return hit ? best : null;
  }
}
