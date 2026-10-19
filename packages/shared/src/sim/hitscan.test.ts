import { describe, expect, it } from 'vitest';
import { COMBAT, WEAPONS, type WeaponId } from '../balance';
import { rayTarget, raySphere, rayVerticalCapsule, type HitTarget } from './hitboxes';
import { convergeAim, hasLineOfSight, resolveShot, type ShotParams } from './hitscan';
import { anglesTo, box, flatWorld } from './testkit';

const stand = (id: string, x: number, z: number, alive = true): HitTarget => ({ id, pos: { x, y: 0, z }, height: 1.8, eye: 1.6, alive });
const crouch = (x: number, z: number): HitTarget => ({ id: 'c', pos: { x, y: 0, z }, height: 1.2, eye: 1.05, alive: true });
const FWD = { x: 0, y: 0, z: -1 };
const EYE = { x: 0, y: 1.6, z: 0 };

describe('hitboxes', () => {
  it('ray vs sphere: hit, miss, behind, inside', () => {
    expect(raySphere({ x: 0, y: 0, z: 0 }, FWD, 0, 0, -5, 1)).toBeCloseTo(4, 9);
    expect(raySphere({ x: 3, y: 0, z: 0 }, FWD, 0, 0, -5, 1)).toBeNull();
    expect(raySphere({ x: 0, y: 0, z: 0 }, FWD, 0, 0, 5, 1)).toBeNull();
    expect(raySphere({ x: 0, y: 0, z: -5 }, FWD, 0, 0, -5, 1)).toBe(0);
  });
  it('body capsule: radius 0.4 laterally, caps round the ends, inside returns 0', () => {
    const t = stand('a', 0, -10);
    const at = (x: number, y: number): number | null => rayVerticalCapsule({ x, y, z: 0 }, FWD, 0, -10, 0.4, 1.4, 0.4);
    expect(at(0, 1.0)).toBeCloseTo(9.6, 6);
    expect(at(0.39, 1.0)).not.toBeNull();
    expect(at(0.41, 1.0)).toBeNull();
    expect(at(0, -0.1)).toBeNull(); // under the feet
    expect(at(0, 0.1)).not.toBeNull(); // rounded bottom cap
    expect(at(0, 1.78)).not.toBeNull(); // rounded top cap
    expect(at(0, 1.85)).toBeNull();
    expect(rayVerticalCapsule({ x: 0, y: 1, z: -10 }, FWD, 0, -10, 0.4, 1.4, 0.4)).toBe(0);
    expect(t.height).toBe(1.8);
  });
  it('head sphere (r 0.22 at eye height) wins over the body, from the front and from the side', () => {
    const t = stand('a', 0, -10);
    const front = rayTarget({ x: 0, y: 1.6, z: 0 }, FWD, 50, t)!;
    expect(front.head).toBe(true);
    expect(front.t).toBeCloseTo(9.78, 6);
    const side = rayTarget({ x: 10, y: 1.6, z: -10 }, { x: -1, y: 0, z: 0 }, 50, t)!;
    expect(side.head).toBe(true); // body capsule is entered first at 0.4 m, but the head still counts
    const chest = rayTarget({ x: 0, y: 1.0, z: 0 }, FWD, 50, t)!;
    expect(chest.head).toBe(false);
    expect(rayTarget({ x: 0, y: 1.95, z: 0 }, FWD, 50, t)).toBeNull(); // over the head
    const down = rayTarget({ x: 0, y: 5, z: -10 }, { x: 0, y: -1, z: 0 }, 50, t)!;
    expect(down.head).toBe(true);
    expect(down.t).toBeCloseTo(5 - 1.82, 6);
  });
  it('respects maxDist and crouched hitboxes', () => {
    const t = stand('a', 0, -10);
    expect(rayTarget({ x: 0, y: 1.0, z: 0 }, FWD, 9, t)).toBeNull();
    expect(rayTarget({ x: 0, y: 1.5, z: 0 }, FWD, 50, stand('s', 0, -10))).not.toBeNull();
    expect(rayTarget({ x: 0, y: 1.5, z: 0 }, FWD, 50, crouch(0, -10))).toBeNull(); // crouched: lower
    expect(rayTarget({ x: 0, y: 1.05, z: 0 }, FWD, 50, crouch(0, -10))!.head).toBe(true);
  });
});

describe('resolveShot', () => {
  const world = flatWorld();
  const def = (id: WeaponId) => WEAPONS[id];
  const shot = (to: { x: number; y: number; z: number }, extra: Partial<ShotParams> = {}): ShotParams => {
    const a = anglesTo(EYE, to);
    return { origin: EYE, yaw: a.yaw, pitch: a.pitch, spreadDeg: 0, seed: 1, shotId: 1, ...extra };
  };

  it('body and head damage per weapon match the table (no spread, 10 m)', () => {
    for (const id of ['sidearm', 'rattler', 'vanguard', 'longshot'] as const) {
      const body = resolveShot(world, def(id), shot({ x: 0, y: 1.0, z: -10 }), [stand('t', 0, -10)]).pellets[0]!;
      const head = resolveShot(world, def(id), shot({ x: 0, y: 1.6, z: -10 }), [stand('t', 0, -10)]).pellets[0]!;
      expect(body.kind).toBe('body');
      expect(head.kind).toBe('head');
      expect(body.damage).toBeCloseTo(def(id).damage, 9);
      expect(head.damage).toBeCloseTo(def(id).damage * def(id).headMult, 9);
      expect(body.targetId).toBe('t');
    }
    const ls = resolveShot(world, def('longshot'), shot({ x: 0, y: 1.6, z: -10 }), [stand('t', 0, -10)]).pellets[0]!;
    expect(ls.damage).toBeCloseTo(150, 6);
  });
  it('applies distance falloff using the real hit distance', () => {
    const r = resolveShot(world, def('vanguard'), shot({ x: 0, y: 1.0, z: -50 }), [stand('t', 0, -50)]).pellets[0]!;
    expect(r.dist).toBeCloseTo(49.6, 1);
    expect(r.falloff).toBeCloseTo(1 - 0.35 * ((49.6 - 30) / 40), 2);
    expect(r.damage).toBeCloseTo(20 * r.falloff, 9);
  });
  it('static geometry blocks the shot', () => {
    const w = flatWorld(box(-5, 0, -6, 5, 6, -5));
    const r = resolveShot(w, def('vanguard'), shot({ x: 0, y: 1.0, z: -10 }), [stand('t', 0, -10)]).pellets[0]!;
    expect(r.kind).toBe('world');
    expect(r.targetId).toBeNull();
    expect(r.damage).toBe(0);
    expect(r.point.z).toBeCloseTo(-5, 6); // stopped at the wall face (slant distance is slightly over 5)
  });
  it('the nearest target wins and there is no penetration', () => {
    const r = resolveShot(world, def('vanguard'), shot({ x: 0, y: 1.0, z: -8 }), [stand('far', 0, -20), stand('near', 0, -8)]).pellets[0]!;
    expect(r.targetId).toBe('near');
  });
  it('dead targets are ignored', () => {
    const r = resolveShot(world, def('vanguard'), shot({ x: 0, y: 1.0, z: -8 }), [stand('dead', 0, -8, false), stand('far', 0, -20)]).pellets[0]!;
    expect(r.targetId).toBe('far');
  });
  it('a ray that hits nothing is a miss out to max range', () => {
    const r = resolveShot(world, def('vanguard'), { origin: EYE, yaw: 0, pitch: 0.5, spreadDeg: 0, seed: 1, shotId: 1 }, []).pellets[0]!;
    expect(r.kind).toBe('miss');
    expect(r.dist).toBe(COMBAT.maxRange);
    expect(r.damage).toBe(0);
  });
  it('shotgun at point blank lands all 8 pellets for 72; at range most pellets miss and each is weak', () => {
    const near = resolveShot(world, def('breaker'), shot({ x: 0, y: 1.0, z: -3 }), [stand('t', 0, -3)]);
    expect(near.pellets.filter((p) => p.targetId === 't')).toHaveLength(8);
    expect(near.pellets.reduce((s, p) => s + p.damage, 0)).toBeCloseTo(72, 6);
    let hits = 0;
    const N = 200;
    for (let i = 0; i < N; i++) {
      const far = resolveShot(world, def('breaker'), shot({ x: 0, y: 1.0, z: -25 }, { shotId: i }), [stand('t', 0, -25)]);
      for (const p of far.pellets) if (p.targetId) { hits++; expect(p.damage).toBeCloseTo(9 * 0.2 * (p.kind === 'head' ? 1.3 : 1), 9); }
    }
    expect(hits / N).toBeGreaterThan(0.2);
    expect(hits / N).toBeLessThan(3); // out of 8 pellets
  });
  it('is deterministic per (seed, shotId, salt)', () => {
    const p = shot({ x: 0, y: 1, z: -20 }, { spreadDeg: 3, shotId: 9 });
    const t = [stand('t', 0, -20)];
    expect(resolveShot(world, def('vanguard'), p, t)).toEqual(resolveShot(world, def('vanguard'), p, t));
    expect(resolveShot(world, def('vanguard'), { ...p, shotId: 10 }, t)).not.toEqual(resolveShot(world, def('vanguard'), p, t));
    expect(resolveShot(world, def('vanguard'), { ...p, salt: 1 }, t)).not.toEqual(resolveShot(world, def('vanguard'), p, t));
  });
  it('spread keeps every bullet inside its cone at the target distance', () => {
    const spread = 2, dist = 20;
    let maxDev = 0;
    for (let i = 0; i < 500; i++) {
      const r = resolveShot(world, def('vanguard'), { origin: EYE, yaw: 0, pitch: 0, spreadDeg: spread, seed: 4, shotId: i }, []).pellets[0]!;
      const k = dist / -(r.point.z - EYE.z);
      maxDev = Math.max(maxDev, Math.hypot((r.point.x - EYE.x) * k, (r.point.y - EYE.y) * k));
    }
    expect(maxDev).toBeLessThanOrEqual(dist * Math.tan((spread * Math.PI) / 180) + 1e-6);
    expect(maxDev).toBeGreaterThan(dist * Math.tan((spread * Math.PI) / 180) * 0.9);
  });
});

describe('line of sight', () => {
  it('is blocked by walls and open otherwise', () => {
    const w = flatWorld(box(-5, 0, -6, 5, 6, -5));
    expect(hasLineOfSight(w, { x: 0, y: 1.6, z: 0 }, { x: 0, y: 1.6, z: -10 })).toBe(false);
    expect(hasLineOfSight(w, { x: 0, y: 1.6, z: 0 }, { x: 20, y: 1.6, z: -10 })).toBe(true);
    expect(hasLineOfSight(w, EYE, EYE)).toBe(true);
  });
});

describe('over-the-shoulder aim convergence', () => {
  const world = flatWorld(box(-50, 0, -31, 50, 10, -30));
  // camera 0.75 m to the right and 3.4 m behind the eye, looking straight ahead
  const cam = { x: 0.75, y: 1.8, z: 3.4 };

  it('a bullet fired parallel to the camera misses the crosshair target, a converged one hits', () => {
    const target = stand('t', 0.75, -20); // exactly under the crosshair
    const parallel = resolveShot(world, WEAPONS.vanguard, { origin: EYE, yaw: 0, pitch: 0, spreadDeg: 0, seed: 1, shotId: 1 }, [target]);
    expect(parallel.pellets[0]!.targetId).toBeNull();
    const a = convergeAim(world, cam, FWD, EYE, [target]);
    const conv = resolveShot(world, WEAPONS.vanguard, { origin: EYE, yaw: a.yaw, pitch: a.pitch, spreadDeg: 0, seed: 1, shotId: 1 }, [target]);
    expect(conv.pellets[0]!.targetId).toBe('t');
  });
  it('converges on world geometry too: the bullet lands where the camera ray does', () => {
    const a = convergeAim(world, cam, FWD, EYE, []);
    const r = resolveShot(world, WEAPONS.vanguard, { origin: EYE, yaw: a.yaw, pitch: a.pitch, spreadDeg: 0, seed: 1, shotId: 1 }, []).pellets[0]!;
    expect(r.kind).toBe('world');
    expect(r.point.x).toBeCloseTo(0.75, 3);
    expect(r.point.y).toBeCloseTo(1.8, 3);
  });
  it('picks the target in front of a far wall, not the wall behind it', () => {
    const target = stand('t', 0.75, -8);
    const a = convergeAim(world, cam, FWD, EYE, [target]);
    expect(resolveShot(world, WEAPONS.vanguard, { origin: EYE, yaw: a.yaw, pitch: a.pitch, spreadDeg: 0, seed: 1, shotId: 1 }, [target]).pellets[0]!.targetId).toBe('t');
  });
  it('never converges on a point beside or behind the eye', () => {
    const wall = flatWorld(box(-5, 0, 3.0, 5, 5, 3.1)); // camera ray hits this 0.4 m after leaving the camera
    const a = convergeAim(wall, cam, FWD, EYE, []);
    expect(Number.isFinite(a.yaw) && Number.isFinite(a.pitch)).toBe(true);
    const dz = -Math.cos(a.yaw) * Math.cos(a.pitch);
    expect(dz).toBeLessThan(0); // still aiming forward
  });
});
