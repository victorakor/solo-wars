import { describe, expect, it } from 'vitest';
import { CollisionWorld, FOUNDRY, MOVE, clonePlayer, newPlayer, stepPlayer, validateScene,
  type Box, type MoveInput, type PlayerState } from './index';

const DT = 1 / 60;
const bx = (x0: number, y0: number, z0: number, x1: number, y1: number, z1: number): Box =>
  ({ min: { x: x0, y: y0, z: z0 }, max: { x: x1, y: y1, z: z1 } });
const floor = bx(-50, -1, -50, 50, 0, 50);
const idle = (o: Partial<MoveInput> = {}): MoveInput =>
  ({ moveX: 0, moveZ: 0, yaw: 0, pitch: 0, jump: false, sprint: false, crouch: false, dodge: false, ads: false, ...o });
const run = (s: PlayerState, i: Partial<MoveInput>, secs: number, w: CollisionWorld): void => {
  for (let t = 0; t < Math.round(secs / DT); t++) stepPlayer(s, idle(i), DT, w);
};
const settle = (w: CollisionWorld, x = 0, z = 0): PlayerState => { const s = newPlayer(x, 0.5, z); run(s, {}, 0.5, w); return s; };

describe('movement', () => {
  it('lands on the floor and reports grounded', () => {
    const s = settle(new CollisionWorld([floor]));
    expect(s.pos.y).toBeCloseTo(0, 5); expect(s.onGround).toBe(true);
  });
  it('walks at 5 m/s, sprints at 7.5, crouches at 2.5', () => {
    const w = new CollisionWorld([floor]);
    for (const [i, v] of [[{ moveZ: 1 }, 5], [{ moveZ: 1, sprint: true }, 7.5], [{ moveZ: 1, crouch: true }, 2.5]] as const) {
      const s = settle(w); run(s, i, 1, w);
      expect(Math.hypot(s.vel.x, s.vel.z)).toBeCloseTo(v, 1);
    }
  });
  it('reaches full speed in ~0.12 s', () => {
    const w = new CollisionWorld([floor]); const s = settle(w); run(s, { moveZ: 1 }, 0.13, w);
    expect(Math.hypot(s.vel.x, s.vel.z)).toBeGreaterThan(4.9);
  });
  it('is deterministic for identical inputs', () => {
    const w = new CollisionWorld(FOUNDRY.boxes);
    const go = (): PlayerState => { const s = newPlayer(-24, 0.2, 0); for (let i = 0; i < 600; i++)
      stepPlayer(s, idle({ moveZ: 1, moveX: i % 90 < 45 ? 1 : -1, yaw: i * 0.01, jump: i % 70 === 0, dodge: i % 200 === 0 }), DT, w); return s; };
    expect(go()).toEqual(go());
  });
  it('cannot run through a wall at sprint speed', () => {
    const w = new CollisionWorld([floor, bx(-5, 0, -10.2, 5, 5, -10)]);
    const s = settle(w); run(s, { moveZ: 1, sprint: true }, 4, w);
    expect(s.pos.z).toBeGreaterThanOrEqual(-10 + MOVE.radius - 1e-3);
  });
  it('slides along a wall when moving diagonally into it', () => {
    const w = new CollisionWorld([floor, bx(-30, 0, -10.2, 30, 5, -10)]);
    const s = settle(w); s.pos.z = -9.4; run(s, { moveZ: 1, moveX: 1 }, 1, w);
    expect(s.pos.x).toBeGreaterThan(3);
  });
  it('steps up a 0.4 m step but not a 0.5 m ledge', () => {
    const w = new CollisionWorld([floor, bx(-5, 0, -6, 5, 0.4, -3), bx(-5, 0, -12, 5, 0.5, -9)]);
    const s = settle(w); run(s, { moveZ: 1 }, 1.2, w);
    expect(s.pos.y).toBeCloseTo(0.4, 3);
    const s2 = settle(w, 0, -7.5); run(s2, { moveZ: 1 }, 1.2, w);
    expect(s2.pos.y).toBeLessThan(0.45); expect(s2.pos.z).toBeGreaterThan(-9 + 0.3);
  });
  it('jump clears 1.0 m but not 1.2 m obstacles', () => {
    const w = new CollisionWorld([floor, bx(-5, 0, -3.5, 5, 1.0, -3), bx(-5, 0, -9.5, 5, 1.2, -9)]);
    const a = settle(w); a.pos.z = -2; let top = 0;
    for (let i = 0; i < 90; i++) { stepPlayer(a, idle({ moveZ: 1, jump: i === 0 }), DT, w); top = Math.max(top, a.pos.y); }
    expect(a.pos.z).toBeLessThan(-4); expect(top).toBeGreaterThan(1.0);
    const c = settle(w); c.pos.z = -7.5; run(c, { moveZ: 1, jump: true }, 1.5, w);
    expect(c.pos.z).toBeGreaterThan(-9 + 0.39);
  });
  it('stays crouched under a low ceiling and stands once clear', () => {
    const w = new CollisionWorld([floor, bx(-5, 1.4, -5, 5, 3, 5)]);
    const s = settle(w, 8, 0); run(s, { crouch: true, moveX: -1 }, 1.8, w);
    expect(s.pos.x).toBeLessThan(4); run(s, {}, 0.3, w);
    expect(s.crouched).toBe(true); // released crouch but no headroom
    run(s, { crouch: true, moveX: 1 }, 2.5, w); run(s, {}, 0.2, w);
    expect(s.pos.x).toBeGreaterThan(5.4); expect(s.crouched).toBe(false);
  });
  it('rolls for 0.45 s at 5.5 m/s with a 2 s cooldown', () => {
    const w = new CollisionWorld([floor]); const s = settle(w); const z0 = s.pos.z;
    stepPlayer(s, idle({ moveZ: 1, dodge: true }), DT, w);
    run(s, { moveZ: 1 }, 0.5, w);
    expect(z0 - s.pos.z).toBeGreaterThan(2.2);
    expect(s.rollT).toBe(0);
    const y = clonePlayer(s); stepPlayer(y, idle({ dodge: true }), DT, w); expect(y.rollT).toBe(0);
    run(s, {}, 1.6, w); stepPlayer(s, idle({ dodge: true }), DT, w); expect(s.rollT).toBeGreaterThan(0);
  });
  it('rolls backward with no input', () => {
    const w = new CollisionWorld([floor]); const s = settle(w);
    stepPlayer(s, idle({ dodge: true }), DT, w); run(s, {}, 0.3, w); expect(s.pos.z).toBeGreaterThan(1);
  });
  it('drains stamina, blocks restart below 15, regenerates after 1 s', () => {
    const w = new CollisionWorld([floor]); const s = settle(w);
    run(s, { moveZ: 1, sprint: true }, 6, w);
    expect(s.stamina).toBe(0); expect(s.sprinting).toBe(false);
    s.stamina = 10; run(s, { moveZ: 1, sprint: true }, 0.1, w); expect(s.sprinting).toBe(false);
    s.stamina = 0; run(s, {}, 1.0 + 2, w); expect(s.stamina).toBeGreaterThan(25);
  });
});

describe('Foundry', () => {
  const w = new CollisionWorld(FOUNDRY.boxes);
  it('passes scene validation', () => expect(validateScene(FOUNDRY)).toEqual([]));
  it('walks up the stairs onto the catwalk and across the bridge', () => {
    const s = settle(w, 27, 17); run(s, { moveZ: 1, yaw: Math.PI / 2 }, 4.5, w);
    expect(s.pos.y).toBeCloseTo(4, 2); expect(s.pos.x).toBeLessThan(22.5);
    run(s, { moveZ: 1, yaw: Math.PI / 2 }, 2.5, w); // reach the bridge x=0 row, turn onto it
    s.pos.x = 0; s.pos.z = 16; run(s, { moveZ: 1, yaw: 0 }, 3.5, w);
    expect(s.pos.y).toBeCloseTo(4, 2); expect(s.pos.z).toBeLessThan(5);
  });
  it('10-minute randomised run never clips or leaves the arena', () => {
    let seed = 1337; const rnd = (): number => ((seed = (seed * 1664525 + 1013904223) >>> 0) / 2 ** 32);
    const s = newPlayer(-24, 0.2, 0); let inp = idle(); let overlaps = 0, minY = 0;
    for (let t = 0; t < 60 * 600; t++) {
      if (t % 20 === 0) inp = idle({ moveX: Math.round(rnd() * 2 - 1), moveZ: Math.round(rnd() * 2 - 1),
        yaw: rnd() * 6.28, sprint: rnd() < 0.5, crouch: rnd() < 0.15, jump: rnd() < 0.3, dodge: rnd() < 0.2 });
      stepPlayer(s, { ...inp, jump: inp.jump && t % 20 === 0, dodge: inp.dodge && t % 20 === 0 }, DT, w);
      const h = s.crouched ? MOVE.heightCrouch : MOVE.heightStand;
      const hit = w.query({ x: s.pos.x - 0.4, y: s.pos.y, z: s.pos.z - 0.4 }, { x: s.pos.x + 0.4, y: s.pos.y + h, z: s.pos.z + 0.4 });
      if (hit.length) overlaps++;
      minY = Math.min(minY, s.pos.y);
      if (Math.abs(s.pos.x) > 28 || Math.abs(s.pos.z) > 20 || !Number.isFinite(s.pos.x)) throw new Error(`escaped at t=${t}`);
    }
    expect(overlaps).toBe(0); expect(minY).toBeGreaterThan(-0.01);
  });
  it('raycast hits geometry and respects max distance', () => {
    expect(w.raycast({ x: -24, y: 1, z: 0 }, { x: -1, y: 0, z: 0 }, 10)).toBeCloseTo(4, 3);
    expect(w.raycast({ x: -24, y: 1, z: 0 }, { x: -1, y: 0, z: 0 }, 2)).toBeNull();
  });
});
