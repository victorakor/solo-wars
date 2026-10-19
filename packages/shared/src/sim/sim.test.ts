import { describe, expect, it } from 'vitest';
import { COMBAT, WEAPONS, type WeaponId } from '../balance';
import { CombatSim, type Actor, type ActorInput, type CombatEvent } from './sim';
import { DT, anglesTo, eyeOf, flatSim, inputOf, one, run, spawnAt, box } from './testkit';

/** Player at the origin facing -Z with a dummy straight ahead. Returns helpers to aim like the camera does. */
function range(dist = 10, seed = 1, spawns = [spawnAt(0, 0)], ...walls: ReturnType<typeof box>[]) {
  const sim = flatSim(seed, spawns, ...walls);
  const you = sim.addActor({ id: 'you', kind: 'player', name: 'You', spawn: spawnAt(0, 0) });
  const dummy = sim.addActor({ id: 'd', kind: 'dummy', name: 'D', spawn: spawnAt(0, -dist) });
  run(sim, 30, () => new Map()); // settle on the floor
  const events: CombatEvent[] = [];
  /** One tick holding fire at `at`, with raw aim that cancels the recoil kick like a steady hand would. */
  const shoot = (at: { x: number; y: number; z: number }, o: Partial<ActorInput> = {}): void => {
    const a = anglesTo(eyeOf(you), at);
    sim.step(DT, one('you', inputOf({ fire: true, firePressed: true, ads: true, yaw: a.yaw, pitch: a.pitch,
      aimYaw: a.yaw - you.recoil.yaw, aimPitch: a.pitch - you.recoil.pitch, ...o })));
    events.push(...sim.drainEvents());
  };
  const idle = (ticks: number, o: Partial<ActorInput> = {}): void => {
    for (let i = 0; i < ticks; i++) { sim.step(DT, one('you', inputOf(o))); events.push(...sim.drainEvents()); }
  };
  const chest = (d: Actor) => ({ x: d.body.pos.x, y: d.body.pos.y + 1.0, z: d.body.pos.z });
  const head = (d: Actor) => ({ x: d.body.pos.x, y: d.body.pos.y + 1.6, z: d.body.pos.z });
  return { sim, you, dummy, events, shoot, idle, chest, head };
}
const select = (r: ReturnType<typeof range>, id: WeaponId): void => {
  r.idle(1, { slot: r.you.rack.findIndex((w) => w.id === id) });
  r.idle(60); // finish equipping
};
const hits = (e: CombatEvent[]) => e.filter((x): x is Extract<CombatEvent, { type: 'hit' }> => x.type === 'hit');

describe('firing at a dummy', () => {
  it('Vanguard body shots: 5 hits kill, stats and events are exact', () => {
    const r = range(10); select(r, 'vanguard'); r.idle(30, { ads: true });
    for (let i = 0; i < 60 && r.dummy.hp.alive; i++) r.shoot(r.chest(r.dummy));
    const h = hits(r.events);
    expect(h).toHaveLength(5);
    expect(h.every((x) => Math.abs(x.damage - 20) < 1e-9 && !x.head)).toBe(true);
    expect(h[4]!.killed).toBe(true);
    expect(r.dummy.hp.alive).toBe(false);
    expect(r.you.stats).toMatchObject({ shotsFired: 5, shotsHit: 5, headshots: 0, kills: 1, damageDealt: 100, streak: 1 });
    expect(r.dummy.stats.deaths).toBe(1);
    expect(r.events.filter((e) => e.type === 'kill')).toHaveLength(1);
  });
  it('headshots do 1.5x with the Vanguard: 4 shots, 30/30/30/10 (overkill not counted)', () => {
    const r = range(10); select(r, 'vanguard'); r.idle(30, { ads: true });
    for (let i = 0; i < 60 && r.dummy.hp.alive; i++) r.shoot(r.head(r.dummy));
    const h = hits(r.events);
    expect(h.map((x) => Math.round(x.damage * 1000) / 1000)).toEqual([30, 30, 30, 10]);
    expect(h.every((x) => x.head)).toBe(true);
    expect(r.you.stats.headshots).toBe(4);
    expect(r.you.stats.damageDealt).toBeCloseTo(100, 9);
    const kill = r.events.find((e) => e.type === 'kill');
    expect(kill).toEqual({ type: 'kill', killer: 'you', victim: 'd', weapon: 'vanguard', head: true });
  });
  it('time to kill follows rpm: Sidearm needs 5 shots at 360 rpm = 4 intervals', () => {
    const r = range(10); select(r, 'sidearm'); r.idle(20, { ads: true });
    const t: number[] = [];
    for (let i = 0; i < 120 && r.dummy.hp.alive; i++) { r.shoot(r.chest(r.dummy)); for (const e of r.events.splice(0)) if (e.type === 'hit') t.push(r.sim.time); }
    expect(t).toHaveLength(5);
    expect(t[4]! - t[0]!).toBeGreaterThan(4 * (60 / 360) - 2 * DT);
    expect(t[4]! - t[0]!).toBeLessThan(4 * (60 / 360) + 2 * DT);
  });
  it('Longshot: headshot one-shots, body shot leaves 5 HP and the bolt delays the follow-up', () => {
    const r = range(40); select(r, 'longshot'); r.idle(30, { ads: true });
    r.shoot(r.head(r.dummy));
    expect(r.dummy.hp.alive).toBe(false);
    expect(hits(r.events)[0]!.damage).toBeCloseTo(100, 9); // 150 capped at remaining health
    const r2 = range(40); select(r2, 'longshot'); r2.idle(30, { ads: true });
    r2.shoot(r2.chest(r2.dummy));
    expect(r2.dummy.hp.hp).toBeCloseTo(5, 6);
    const before = r2.you.stats.shotsFired;
    for (let i = 0; i < 60; i++) r2.shoot(r2.chest(r2.dummy)); // 1 s: still cycling the bolt
    expect(r2.you.stats.shotsFired).toBe(before);
    for (let i = 0; i < 40; i++) r2.shoot(r2.chest(r2.dummy));
    expect(r2.dummy.hp.alive).toBe(false);
  });
  it('falloff at 44 m: Sidearm body shot does 22 x falloff', () => {
    const r = range(44); select(r, 'sidearm'); r.idle(20, { ads: true });
    r.shoot(r.chest(r.dummy));
    const h = hits(r.events)[0]!;
    expect(h.dist).toBeGreaterThan(43.5); // front of the capsule, 0.4 m short of centre
    expect(h.dist).toBeLessThan(44);
    expect(h.falloff).toBeCloseTo(1 - 0.4 * ((h.dist - 25) / 30), 6);
    expect(h.damage).toBeCloseTo(22 * h.falloff, 6);
  });
  it('Breaker at 3 m does 72 in one pull; at 30 m only a fraction of pellets connect', () => {
    const near = range(3); select(near, 'breaker'); near.idle(30, { ads: true });
    near.shoot(near.chest(near.dummy));
    expect(hits(near.events)[0]!.damage).toBeCloseTo(72, 6);
    expect(near.you.stats.shotsFired).toBe(1);
    const far = range(30); select(far, 'breaker'); far.idle(30, { ads: true });
    far.shoot(far.chest(far.dummy));
    const dmg = hits(far.events)[0]?.damage ?? 0;
    expect(dmg).toBeLessThan(72 * 0.2 * 0.7);
  });
  it('hip fire is less accurate than ADS (Rattler at 25 m)', () => {
    const acc = (ads: boolean): number => {
      const r = range(25, 3); select(r, 'rattler'); r.idle(30, { ads });
      let fired = 0;
      for (let i = 0; i < 600; i++) { r.shoot(r.chest(r.dummy), { ads }); if (!r.dummy.hp.alive) { r.idle(200, { ads }); } fired = r.you.stats.shotsFired; }
      return r.you.stats.shotsHit / Math.max(1, fired);
    };
    expect(acc(true)).toBeGreaterThan(acc(false) + 0.1);
  });
  it('recoil kicks up while firing and recovers after', () => {
    const r = range(25); select(r, 'rattler'); r.idle(30, { ads: true });
    for (let i = 0; i < 30; i++) r.shoot({ x: 0, y: 1, z: -25 });
    expect(r.you.recoil.pitch).toBeGreaterThan(0.03);
    r.idle(180);
    expect(r.you.recoil.pitch).toBe(0);
  });
});

describe('player rules', () => {
  it('cannot fire while sprinting or in sprint recovery', () => {
    const r = range(10); select(r, 'vanguard');
    for (let i = 0; i < 30; i++) r.sim.step(DT, one('you', inputOf({ moveZ: 1, sprint: true, fire: true, firePressed: true })));
    expect(r.you.body.sprinting).toBe(true);
    expect(r.you.stats.shotsFired).toBe(0);
    expect(r.you.rack[r.you.slot]!.mag).toBe(30);
  });
  it('reloads on request: takes reloadSec, emits start and done', () => {
    const r = range(10); select(r, 'vanguard');
    r.shoot(r.chest(r.dummy)); r.idle(20);
    const ws = r.you.rack[r.you.slot]!;
    expect(ws.mag).toBe(29);
    r.idle(1, { reload: true });
    expect(ws.reloading).toBe(true);
    r.idle(Math.round(WEAPONS.vanguard.reloadSec * 60) - 4);
    expect(ws.reloading).toBe(true);
    r.idle(10);
    expect([ws.reloading, ws.mag]).toEqual([false, 30]);
    expect(r.events.some((e) => e.type === 'reloadStart')).toBe(true);
    expect(r.events.some((e) => e.type === 'reloadDone')).toBe(true);
  });
  it('limited (floor) reserve runs dry and stops firing', () => {
    const sim = flatSim(1);
    const you = sim.addActor({ id: 'you', kind: 'player', name: 'You', spawn: spawnAt(0, 0), loadout: ['sidearm'], infiniteReserve: false });
    run(sim, 10, () => new Map());
    for (let i = 0; i < 60 * 40; i++)
      sim.step(DT, one('you', inputOf({ fire: true, firePressed: true, reload: you.rack[0]!.mag === 0 })));
    expect(you.stats.shotsFired).toBe(12 + 48);
    expect([you.rack[0]!.mag, you.rack[0]!.reserve]).toEqual([0, 0]);
  });
  it('weapon switching takes equipSec and blocks fire meanwhile', () => {
    const r = range(10);
    r.idle(1, { slot: 4 });
    expect(r.you.slot).toBe(4);
    r.shoot(r.chest(r.dummy)); r.shoot(r.chest(r.dummy));
    expect(r.you.stats.shotsFired).toBe(0);
    r.idle(60);
    r.shoot(r.chest(r.dummy));
    expect(r.you.stats.shotsFired).toBe(1);
    r.idle(1, { slot: 99 });
    expect(r.you.slot).toBe(4);
  });
  it('weapon weight slows movement (Longshot x0.85)', () => {
    const speedWith = (slot: number): number => {
      const r = range(60); r.idle(1, { slot }); r.idle(90, { moveZ: 1 });
      return Math.hypot(r.you.body.vel.x, r.you.body.vel.z);
    };
    expect(speedWith(0)).toBeCloseTo(5.0, 1);
    expect(speedWith(4)).toBeCloseTo(5.0 * 0.85, 1);
  });
});

describe('health, death and respawn', () => {
  it('a dummy respawns after 3 s at full health in the same place', () => {
    const r = range(10); select(r, 'longshot'); r.idle(20, { ads: true });
    r.shoot(r.head(r.dummy));
    expect(r.dummy.hp.alive).toBe(false);
    const home = { ...r.dummy.body.pos };
    r.idle(Math.round(COMBAT.respawnSec * 60) - 6);
    expect(r.dummy.hp.alive).toBe(false);
    r.idle(10);
    expect(r.dummy.hp.alive).toBe(true);
    expect(r.dummy.hp.hp).toBe(100);
    expect(Math.abs(r.dummy.body.pos.x - home.x) + Math.abs(r.dummy.body.pos.z - home.z)).toBeLessThan(1e-6);
    expect(r.events.some((e) => e.type === 'respawn' && e.actor === 'd')).toBe(true);
  });
  it('dead actors are not targets: shots pass through to the next one', () => {
    const sim = flatSim(1);
    const you = sim.addActor({ id: 'you', kind: 'player', name: 'You', spawn: spawnAt(0, 0) });
    const near = sim.addActor({ id: 'near', kind: 'dummy', name: 'n', spawn: spawnAt(0, -5) });
    const far = sim.addActor({ id: 'far', kind: 'dummy', name: 'f', spawn: spawnAt(0, -15) });
    run(sim, 20, () => new Map());
    near.hp.alive = false; near.hp.respawnT = 99;
    const a = anglesTo(eyeOf(you), { x: 0, y: 1, z: -15 });
    for (let i = 0; i < 4; i++) sim.step(DT, one('you', inputOf({ fire: true, firePressed: true, yaw: a.yaw, pitch: a.pitch, ads: true })));
    expect(far.hp.hp).toBeLessThan(100);
  });
  const duel = () => {
    const sim = flatSim(5, [spawnAt(0, 0), spawnAt(60, 60), spawnAt(-60, -60)]);
    const you = sim.addActor({ id: 'you', kind: 'player', name: 'You', spawn: spawnAt(0, 0) });
    const foe = sim.addActor({ id: 'foe', kind: 'bot', name: 'Foe', spawn: spawnAt(0, -10), loadout: ['vanguard'] });
    run(sim, 150, () => new Map()); // spawn protection (2 s) expires
    return { sim, you, foe };
  };
  const foeShoots = (sim: CombatSim, you: Actor, foe: Actor, ticks: number): void => {
    for (let i = 0; i < ticks && you.hp.alive; i++) {
      const a = anglesTo(eyeOf(foe), { x: you.body.pos.x, y: you.body.pos.y + 1, z: you.body.pos.z });
      sim.step(DT, one('foe', inputOf({ fire: true, firePressed: true, ads: true, yaw: a.yaw, pitch: a.pitch, aimYaw: a.yaw - foe.recoil.yaw, aimPitch: a.pitch - foe.recoil.pitch })));
    }
  };
  it('the player dies at 0 HP, loses stats correctly, and respawns hidden from the opponent after 3 s', () => {
    const { sim, you, foe } = duel();
    foeShoots(sim, you, foe, 60);
    expect(you.hp.alive).toBe(false);
    expect(you.stats.deaths).toBe(1);
    expect(foe.stats).toMatchObject({ kills: 1, streak: 1, bestStreak: 1 });
    const kill = sim.drainEvents().find((e) => e.type === 'kill');
    expect(kill).toMatchObject({ killer: 'foe', victim: 'you', weapon: 'vanguard' });
    run(sim, 170, () => new Map());
    expect(you.hp.alive).toBe(false);
    run(sim, 20, () => new Map());
    expect(you.hp.alive).toBe(true);
    expect(you.hp.hp).toBe(100);
    expect(you.hp.protectT).toBeGreaterThan(1.5);
    expect(Math.hypot(you.body.pos.x - foe.body.pos.x, you.body.pos.z - foe.body.pos.z)).toBeGreaterThan(50); // far spawn
    expect(you.stats.deaths).toBe(1); // stats survive respawn
  });
  it('spawn protection blocks damage for 2 s, and ends early when the protected player fires', () => {
    const sim = flatSim(2);
    const you = sim.addActor({ id: 'you', kind: 'player', name: 'You', spawn: spawnAt(0, 0) });
    const foe = sim.addActor({ id: 'foe', kind: 'bot', name: 'Foe', spawn: spawnAt(0, -10), loadout: ['vanguard'] });
    run(sim, 5, () => new Map());
    foeShoots(sim, you, foe, 40);
    expect(you.hp.hp).toBe(100);
    expect(foe.stats.shotsHit).toBeGreaterThan(0);
    expect(foe.stats.damageDealt).toBe(0);
    run(sim, 100, () => new Map()); // let protection and foe cooldown expire
    const sim2 = flatSim(2);
    const you2 = sim2.addActor({ id: 'you', kind: 'player', name: 'You', spawn: spawnAt(0, 0) });
    const foe2 = sim2.addActor({ id: 'foe', kind: 'bot', name: 'Foe', spawn: spawnAt(0, -10), loadout: ['vanguard'] });
    run(sim2, 5, () => new Map());
    sim2.step(DT, one('you', inputOf({ fire: true, firePressed: true })));
    expect(you2.hp.protectT).toBe(0);
    foeShoots(sim2, you2, foe2, 20);
    expect(you2.hp.hp).toBeLessThan(100);
  });
  it('streaks build on kills and reset on death; bestStreak is kept', () => {
    const { sim, you, foe } = duel();
    for (let k = 0; k < 2; k++) {
      foeShoots(sim, you, foe, 60);
      run(sim, 200, () => new Map()); // respawn and protection
      you.body.pos.x = 0; you.body.pos.z = 0; you.body.pos.y = 0.05; // respawn lands far away; bring the duel back
      foe.hp.protectT = 0; you.hp.protectT = 0;
    }
    expect(foe.stats).toMatchObject({ kills: 2, streak: 2, bestStreak: 2 });
    // now the player kills the foe back: foe streak resets, best stays
    for (let i = 0; i < 120 && foe.hp.alive; i++) {
      const a = anglesTo(eyeOf(you), { x: foe.body.pos.x, y: foe.body.pos.y + 1, z: foe.body.pos.z });
      sim.step(DT, one('you', inputOf({ fire: true, firePressed: true, ads: true, slot: 2, yaw: a.yaw, pitch: a.pitch, aimYaw: a.yaw - you.recoil.yaw, aimPitch: a.pitch - you.recoil.pitch })));
    }
    expect(foe.hp.alive).toBe(false);
    expect(foe.stats.streak).toBe(0);
    expect(foe.stats.bestStreak).toBe(2);
  });
  it('falling out of the world kills, crediting the last damager within 5 s only', () => {
    const { sim, you, foe } = duel();
    foeShoots(sim, you, foe, 8);
    expect(you.hp.alive).toBe(true);
    you.body.pos.y = COMBAT.killY - 1;
    sim.step(DT, new Map());
    expect(you.hp.alive).toBe(false);
    expect(foe.stats.kills).toBe(1);
    const { sim: s2, you: y2, foe: f2 } = duel();
    foeShoots(s2, y2, f2, 8);
    run(s2, 60 * 6, () => new Map());
    y2.body.pos.y = COMBAT.killY - 1;
    s2.step(DT, new Map());
    expect(y2.hp.alive).toBe(false);
    expect(f2.stats.kills).toBe(0);
  });
  it('damage events point from the victim towards the attacker', () => {
    const { sim, you, foe } = duel();
    sim.drainEvents();
    foeShoots(sim, you, foe, 5);
    const d = sim.drainEvents().find((e) => e.type === 'damage');
    expect(d).toMatchObject({ victim: 'you', attacker: 'foe' });
    if (d?.type === 'damage') { expect(d.dirZ).toBeCloseTo(-1, 6); expect(d.dirX).toBeCloseTo(0, 6); }
  });
  it('dummies never move or shoot', () => {
    const r = range(10);
    const p0 = { ...r.dummy.body.pos };
    r.idle(300);
    expect(r.dummy.body.pos).toEqual(p0);
    expect(r.dummy.stats.shotsFired).toBe(0);
  });
});

describe('determinism', () => {
  it('same seed and inputs give identical results; a different seed changes spread', () => {
    const play = (seed: number): string => {
      const r = range(25, seed); select(r, 'rattler');
      for (let i = 0; i < 400; i++) r.shoot(r.chest(r.dummy), { ads: false, moveX: i % 80 < 40 ? 1 : -1 });
      return JSON.stringify([r.you.stats, r.you.body.pos, r.dummy.hp.hp, r.you.recoil]);
    };
    expect(play(7)).toBe(play(7));
    expect(play(7)).not.toBe(play(8));
  });
});
