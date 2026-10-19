import type { Vec3 } from '../collision';
import { HITBOX } from '../balance';

/** What a ray can hit: a standing or crouched player at a given position. */
export interface HitTarget {
  id: string;
  /** Feet position. */
  pos: Vec3;
  /** Current capsule height (1.8 standing, 1.2 crouched or rolling). */
  height: number;
  /** Current eye height; the head sphere is centred here. */
  eye: number;
  alive: boolean;
}

/** Entry distance of a unit-direction ray into a sphere, 0 if the origin is inside, else null. */
export function raySphere(o: Vec3, d: Vec3, cx: number, cy: number, cz: number, r: number): number | null {
  const ox = o.x - cx, oy = o.y - cy, oz = o.z - cz;
  const c = ox * ox + oy * oy + oz * oz - r * r;
  if (c <= 0) return 0;
  const b = ox * d.x + oy * d.y + oz * d.z;
  if (b > 0) return null; // pointing away
  const disc = b * b - c;
  if (disc < 0) return null;
  return -b - Math.sqrt(disc);
}

/**
 * Entry distance of a unit-direction ray into a vertical capsule whose end-cap sphere centres are at
 * (cx, yLo, cz) and (cx, yHi, cz). 0 if the origin is inside, else null.
 */
export function rayVerticalCapsule(
  o: Vec3, d: Vec3, cx: number, cz: number, yLo: number, yHi: number, r: number,
): number | null {
  const ox = o.x - cx, oz = o.z - cz;
  const rr = r * r;
  const inXZ = ox * ox + oz * oz <= rr;
  if (inXZ && o.y >= yLo && o.y <= yHi) return 0;
  let best = Infinity;
  const a = d.x * d.x + d.z * d.z;
  if (a > 1e-12) {
    const c = ox * ox + oz * oz - rr;
    const b = ox * d.x + oz * d.z;
    if (c > 0 && b < 0) {
      const disc = b * b - a * c;
      if (disc >= 0) {
        const t = (-b - Math.sqrt(disc)) / a;
        const y = o.y + t * d.y;
        if (t >= 0 && y >= yLo && y <= yHi) best = t;
      }
    }
  }
  const lo = raySphere(o, d, cx, yLo, cz, r);
  if (lo !== null && (lo === 0 || o.y + lo * d.y <= yLo)) best = Math.min(best, lo);
  const hi = raySphere(o, d, cx, yHi, cz, r);
  if (hi !== null && (hi === 0 || o.y + hi * d.y >= yHi)) best = Math.min(best, hi);
  return best === Infinity ? null : best;
}

export interface TargetHit {
  /** Distance along the ray. */
  t: number;
  head: boolean;
}

/**
 * Tests a unit-direction ray against a target's hitboxes up to `maxDist` (spec 5.1).
 * The head sphere takes priority: any ray that touches it is a headshot, because the sphere sits
 * inside the body capsule and a body-first rule would make side-on headshots impossible.
 */
export function rayTarget(o: Vec3, d: Vec3, maxDist: number, t: HitTarget): TargetHit | null {
  const head = raySphere(o, d, t.pos.x, t.pos.y + t.eye, t.pos.z, HITBOX.headRadius);
  if (head !== null && head <= maxDist) return { t: head, head: true };
  const r = HITBOX.bodyRadius;
  const body = rayVerticalCapsule(o, d, t.pos.x, t.pos.z, t.pos.y + r, t.pos.y + t.height - r, r);
  if (body !== null && body <= maxDist) return { t: body, head: false };
  return null;
}
