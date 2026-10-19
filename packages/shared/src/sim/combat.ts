import { COMBAT, MOVE } from '../balance';
import type { CollisionWorld, Vec3 } from '../collision';
import type { SceneDef } from '../scenes/foundry';
import { hasLineOfSight } from './hitscan';

export type SpawnPoint = SceneDef['spawns'][number];

/** Per-player match statistics (spec 8.4). */
export interface Stats {
  kills: number;
  deaths: number;
  damageDealt: number;
  damageTaken: number;
  shotsFired: number;
  shotsHit: number;
  headshots: number;
  pickups: number;
  streak: number;
  bestStreak: number;
}

export const newStats = (): Stats => ({
  kills: 0, deaths: 0, damageDealt: 0, damageTaken: 0, shotsFired: 0, shotsHit: 0,
  headshots: 0, pickups: 0, streak: 0, bestStreak: 0,
});

export interface Health {
  hp: number;
  alive: boolean;
  /** Counts down while dead; at 0 the actor respawns. */
  respawnT: number;
  /** Invulnerable while > 0. Ends early when the actor fires. */
  protectT: number;
  lastDamager: string | null;
  lastDamagerT: number;
}

export const newHealth = (protectSec = 0): Health => ({
  hp: COMBAT.maxHealth, alive: true, respawnT: 0, protectT: protectSec, lastDamager: null, lastDamagerT: -Infinity,
});

export interface DamageOutcome {
  /** Health actually removed (overkill is not counted). */
  dealt: number;
  killed: boolean;
}

/** Applies damage. Dead or spawn-protected targets take none. Sets the respawn timer on death. */
export function applyDamage(h: Health, amount: number, attackerId: string | null, now: number): DamageOutcome {
  if (!h.alive || h.protectT > 0 || !(amount > 0)) return { dealt: 0, killed: false };
  const dealt = Math.min(amount, h.hp);
  h.hp -= dealt;
  if (attackerId !== null) { h.lastDamager = attackerId; h.lastDamagerT = now; }
  if (h.hp <= 0) {
    h.hp = 0; h.alive = false; h.respawnT = COMBAT.respawnSec;
    return { dealt, killed: true };
  }
  return { dealt, killed: false };
}

/** Kills regardless of protection (out of bounds, future kill volumes). */
export function forceKill(h: Health): void {
  h.hp = 0; h.alive = false; h.respawnT = COMBAT.respawnSec; h.protectT = 0;
}

/** Who gets the kill: the direct attacker, else the last damager within the credit window. */
export function creditKiller(h: Health, directId: string | null, now: number): string | null {
  if (directId !== null) return directId;
  if (h.lastDamager !== null && now - h.lastDamagerT <= COMBAT.killCreditSec) return h.lastDamager;
  return null;
}

/**
 * Spawn choice (spec 5.3): among the scene's spawn points take the one farthest from the nearest
 * opponent that has no line of sight to any opponent; if none qualifies take the farthest overall.
 */
export function pickSpawn(world: CollisionWorld, spawns: readonly SpawnPoint[], opponentEyes: readonly Vec3[]): SpawnPoint {
  const first = spawns[0];
  if (!first) throw new Error('scene has no spawn points');
  if (opponentEyes.length === 0) return first;
  let bestHidden: SpawnPoint | null = null, bestHiddenD = -1;
  let bestAny: SpawnPoint = first, bestAnyD = -1;
  for (const s of spawns) {
    const eye = { x: s.x, y: s.y + MOVE.eyeStand, z: s.z };
    let nearest = Infinity, seen = false;
    for (const o of opponentEyes) {
      nearest = Math.min(nearest, Math.hypot(o.x - eye.x, o.y - eye.y, o.z - eye.z));
      if (!seen && hasLineOfSight(world, o, eye)) seen = true;
    }
    if (nearest > bestAnyD) { bestAnyD = nearest; bestAny = s; }
    if (!seen && nearest > bestHiddenD) { bestHiddenD = nearest; bestHidden = s; }
  }
  return bestHidden ?? bestAny;
}
