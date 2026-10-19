import { COMBAT, type WeaponDef } from '../balance';
import type { CollisionWorld, Vec3 } from '../collision';
import { rayTarget, type HitTarget } from './hitboxes';
import { shotRng } from './rng';
import { bulletDamage, damageFalloff, shotDirections } from './weapons';

export interface ShotParams {
  /** Eye position of the shooter. */
  origin: Vec3;
  yaw: number;
  pitch: number;
  spreadDeg: number;
  /** Match seed; with shotId (and salt) it fully determines spread. */
  seed: number;
  shotId: number;
  /** Separates shooters that happen to share a shotId. */
  salt?: number;
  /** Rarity or other external damage multiplier. */
  damageMult?: number;
}

export type PelletKind = 'miss' | 'world' | 'body' | 'head';

export interface PelletResult {
  kind: PelletKind;
  /** Distance travelled (maxRange for a miss). */
  dist: number;
  point: Vec3;
  targetId: string | null;
  damage: number;
  /** Falloff multiplier applied at `dist`. */
  falloff: number;
}

export interface ShotResult {
  pellets: PelletResult[];
}

/**
 * Server-side style hitscan (spec 8.1 steps 2, 4, 5): spread from the seeded rng, nearest static
 * geometry first, then head sphere and body capsule of each live target. The nearest thing wins, no penetration.
 */
export function resolveShot(
  world: CollisionWorld, def: WeaponDef, p: ShotParams, targets: readonly HitTarget[],
): ShotResult {
  const rng = shotRng(p.seed, p.shotId, p.salt ?? 0);
  const dirs = shotDirections(p.yaw, p.pitch, p.spreadDeg, def, rng);
  const o = p.origin;
  const pellets: PelletResult[] = [];
  for (const d of dirs) {
    const wall = world.raycast(o, d, COMBAT.maxRange);
    let dist = wall ?? COMBAT.maxRange;
    let kind: PelletKind = wall === null ? 'miss' : 'world';
    let targetId: string | null = null;
    let head = false;
    for (const t of targets) {
      if (!t.alive) continue;
      const h = rayTarget(o, d, dist, t);
      if (h && h.t <= dist) { dist = h.t; kind = h.head ? 'head' : 'body'; targetId = t.id; head = h.head; }
    }
    pellets.push({
      kind, dist, targetId,
      point: { x: o.x + d.x * dist, y: o.y + d.y * dist, z: o.z + d.z * dist },
      damage: targetId === null ? 0 : bulletDamage(def, dist, head, p.damageMult),
      falloff: damageFalloff(def, dist),
    });
  }
  return { pellets };
}

/** True when nothing static blocks the straight line between two points. */
export function hasLineOfSight(world: CollisionWorld, from: Vec3, to: Vec3): boolean {
  const dx = to.x - from.x, dy = to.y - from.y, dz = to.z - from.z;
  const len = Math.hypot(dx, dy, dz);
  if (len < 1e-6) return true;
  return world.raycast(from, { x: dx / len, y: dy / len, z: dz / len }, len - 0.01) === null;
}

/**
 * Over-the-shoulder cameras sit beside and behind the player, so a bullet fired from the eye parallel
 * to the camera would miss whatever the crosshair is on. This finds what the camera ray hits (world or
 * a target) and returns the yaw/pitch that sends a bullet from the eye through that same point.
 */
export function convergeAim(
  world: CollisionWorld, camPos: Vec3, camDir: Vec3, eye: Vec3, targets: readonly HitTarget[],
): { yaw: number; pitch: number } {
  let t = world.raycast(camPos, camDir, COMBAT.maxRange) ?? COMBAT.maxRange;
  for (const tg of targets) {
    if (!tg.alive) continue;
    const h = rayTarget(camPos, camDir, t, tg);
    if (h && h.t < t) t = h.t;
  }
  // never converge on a point beside or behind the eye
  const ahead = (eye.x - camPos.x) * camDir.x + (eye.y - camPos.y) * camDir.y + (eye.z - camPos.z) * camDir.z;
  t = Math.max(t, ahead + 2);
  const dx = camPos.x + camDir.x * t - eye.x, dy = camPos.y + camDir.y * t - eye.y, dz = camPos.z + camDir.z * t - eye.z;
  return { yaw: Math.atan2(-dx, -dz), pitch: Math.atan2(dy, Math.hypot(dx, dz)) };
}
