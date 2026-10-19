/** Deterministic randomness shared by client and server (spec 8.1: spread comes from seed + shotId). */
export type Rng = () => number;

/** mulberry32: tiny, fast, 32-bit PRNG. Returns floats in [0, 1). */
export function mulberry32(seed: number): Rng {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** Mixes integers into one well-distributed 32-bit seed. */
export function mixSeed(...parts: number[]): number {
  let h = 0x9e3779b9;
  for (const p of parts) {
    h = Math.imul(h ^ (p | 0), 0x85ebca6b);
    h ^= h >>> 13;
    h = Math.imul(h, 0xc2b2ae35);
    h ^= h >>> 16;
  }
  return h >>> 0;
}

/** RNG for one shot. `salt` separates shooters (and purposes) that share a shotId. */
export const shotRng = (matchSeed: number, shotId: number, salt = 0): Rng =>
  mulberry32(mixSeed(matchSeed, shotId, salt));
