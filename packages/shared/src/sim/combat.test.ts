import { describe, expect, it } from 'vitest';
import { COMBAT } from '../balance';
import { FOUNDRY } from '../scenes/foundry';
import { validateScene } from '../scenes/validate';
import { CollisionWorld } from '../collision';
import { applyDamage, creditKiller, forceKill, newHealth, pickSpawn } from './combat';
import { box, flatWorld, spawnAt } from './testkit';
import { DUMMY_DISTANCES, createTraining } from './training';
import { hasLineOfSight } from './hitscan';

describe('applyDamage', () => {
  it('reduces health, records the damager, and caps overkill', () => {
    const h = newHealth();
    expect(applyDamage(h, 30, 'a', 1)).toEqual({ dealt: 30, killed: false });
    expect(h.hp).toBe(70);
    expect([h.lastDamager, h.lastDamagerT]).toEqual(['a', 1]);
    h.hp = 10;
    expect(applyDamage(h, 25, 'a', 2)).toEqual({ dealt: 10, killed: true });
    expect([h.hp, h.alive, h.respawnT]).toEqual([0, false, COMBAT.respawnSec]);
  });
  it('ignores dead, protected and non-positive damage', () => {
    const dead = newHealth(); forceKill(dead);
    expect(applyDamage(dead, 50, 'a', 0).dealt).toBe(0);
    const prot = newHealth(2);
    expect(applyDamage(prot, 50, 'a', 0)).toEqual({ dealt: 0, killed: false });
    expect(prot.hp).toBe(100);
    expect(applyDamage(newHealth(), 0, 'a', 0).dealt).toBe(0);
    expect(applyDamage(newHealth(), -5, 'a', 0).dealt).toBe(0);
  });
  it('has no passive regeneration and starts at 100', () => {
    expect(newHealth().hp).toBe(100);
    expect(COMBAT.maxHealth).toBe(100);
  });
});

describe('kill credit', () => {
  it('goes to the direct attacker, else the last damager within 5 s, else nobody', () => {
    const h = newHealth();
    applyDamage(h, 10, 'a', 10);
    expect(creditKiller(h, 'b', 11)).toBe('b');
    expect(creditKiller(h, null, 14.9)).toBe('a');
    expect(creditKiller(h, null, 15.1)).toBeNull();
    expect(creditKiller(newHealth(), null, 0)).toBeNull();
  });
});

describe('spawn selection', () => {
  it('prefers the farthest spawn with no line of sight to the opponent', () => {
    // wall at x=-10..-9 hides spawn A (x=-30) from the opponent at x=0; B (x=40) is farther but visible
    const w = flatWorld(box(-10, 0, -50, -9, 5, 50));
    const A = spawnAt(-30, 0), B = spawnAt(40, 0), C = spawnAt(-5, 20);
    expect(pickSpawn(w, [B, C, A], [{ x: 0, y: 1.6, z: 0 }])).toBe(A);
  });
  it('falls back to the farthest spawn when all are visible, and to the first with no opponent', () => {
    const w = flatWorld();
    const A = spawnAt(5, 0), B = spawnAt(30, 0), C = spawnAt(-10, 0);
    expect(pickSpawn(w, [A, B, C], [{ x: 0, y: 1.6, z: 0 }])).toBe(B);
    expect(pickSpawn(w, [A, B, C], [])).toBe(A);
  });
  it('uses the nearest opponent for distance when several are present', () => {
    const w = flatWorld();
    const A = spawnAt(-30, 0), B = spawnAt(30, 0);
    const picked = pickSpawn(w, [A, B], [{ x: -28, y: 1.6, z: 0 }, { x: 0, y: 1.6, z: 0 }]);
    expect(picked).toBe(B);
  });
  it('throws on a scene with no spawns', () => {
    expect(() => pickSpawn(flatWorld(), [], [])).toThrow();
  });
});

describe('Foundry training range', () => {
  it('has six valid, point-symmetric spawns', () => {
    expect(validateScene(FOUNDRY)).toEqual([]);
    expect(FOUNDRY.spawns).toHaveLength(6);
    for (const s of FOUNDRY.spawns)
      expect(FOUNDRY.spawns.some((m) => Math.abs(m.x + s.x) < 1e-9 && Math.abs(m.z + s.z) < 1e-9)).toBe(true);
  });
  it('spawns face the middle of the arena', () => {
    for (const s of FOUNDRY.spawns) {
      const fx = -Math.sin(s.yaw), fz = -Math.cos(s.yaw);
      expect(fx * -s.x + fz * -s.z).toBeGreaterThan(0);
    }
  });
  it('dummies stand clear of geometry, at the stated distances, in line of sight of the player', () => {
    const t = createTraining(1);
    const w = new CollisionWorld(FOUNDRY.boxes);
    expect(t.sim.actors).toHaveLength(1 + DUMMY_DISTANCES.length);
    const eye = { x: t.player.body.pos.x, y: 1.6, z: t.player.body.pos.z };
    for (const d of DUMMY_DISTANCES) {
      const a = t.sim.actor(`dummy-${d}`)!;
      expect(Math.abs(a.body.pos.x - t.player.body.pos.x - d)).toBeLessThan(1e-9);
      expect(w.query({ x: a.body.pos.x - 0.4, y: 0.05, z: a.body.pos.z - 0.4 }, { x: a.body.pos.x + 0.4, y: 1.8, z: a.body.pos.z + 0.4 })).toHaveLength(0);
      expect(hasLineOfSight(w, eye, { x: a.body.pos.x, y: 1.0, z: a.body.pos.z })).toBe(true);
    }
  });
});
