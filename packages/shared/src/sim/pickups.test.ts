import { describe, expect, it } from 'vitest';
import { BOT_PROFILES, PICKUPS, RARITY, TRAINING_RACK, WEAPONS } from '../balance';
import { FOUNDRY } from '../scenes/foundry';
import { validateScene } from '../scenes/validate';
import { BotBrain } from './bot';
import { mulberry32 } from './rng';
import { addBot, createTraining } from './training';
import { CombatSim, floorSlot, rollPad, type Actor, type ActorInput, type CombatEvent } from './sim';
import { DT, anglesTo, eyeOf, flatWorld, inputOf, one, run, spawnAt, SPAWN } from './testkit';

const PAD = { x: 5, y: 0, z: 0, pair: 0 };
const PAD2 = { x: -5, y: 0, z: 0, pair: 0 };

/** One player standing on the first pad of a tiny arena with two pads. */
function arena(seed = 1) {
  const sim = new CombatSim(flatWorld(), [SPAWN, spawnAt(40, 40)], seed, [PAD, PAD2]);
  const you = sim.addActor({ id: 'you', kind: 'player', name: 'You', spawn: spawnAt(PAD.x, PAD.z), loadout: ['vanguard'] });
  you.hp.protectT = 0;
  return { sim, you };
}
const wait = (sim: CombatSim, secs: number, o: Partial<ActorInput> = {}): void => run(sim, Math.round(secs * 60), () => one('you', inputOf(o)));
const evs = (sim: CombatSim, into: CombatEvent[]): void => { into.push(...sim.drainEvents()); };

describe('pad rolls', () => {
  it('are deterministic per seed, and mirrored pads roll the same item', () => {
    expect(rollPad(7, 2, 3)).toEqual(rollPad(7, 2, 3));
    const a = arena(5);
    wait(a.sim, PICKUPS.firstSpawnSec + 0.1, {});
    const pads = a.sim.pickups.filter((p) => p.kind === 'pad');
    expect(pads[0]!.state?.id ?? 'x').toBeDefined();
    const s2 = new CombatSim(flatWorld(), [SPAWN], 5, [PAD, PAD2]);
    run(s2, 200, () => new Map());
    const [p1, p2] = s2.pickups;
    expect([p1!.state!.id, p1!.state!.rarity]).toEqual([p2!.state!.id, p2!.state!.rarity]);
  });
  it('follow the 60/30/10 rarity weights and cover every weapon', () => {
    const counts = [0, 0, 0], ids = new Set<string>();
    const N = 6000;
    for (let i = 0; i < N; i++) { const r = rollPad(1, i, 0); counts[r.rarity]!++; ids.add(r.id); }
    RARITY.forEach((r, i) => expect(Math.abs(counts[i]! / N - r.weight / 100)).toBeLessThan(0.03));
    expect(ids.size).toBe(5);
  });
  it('appear after the first-spawn delay and respawn 25 s after being taken with a fresh roll', () => {
    const { sim, you } = arena(3);
    sim.step(DT, one('you', inputOf()));
    expect(floorSlot(you)).toBe(-1);
    wait(sim, PICKUPS.firstSpawnSec - 0.2);
    expect(sim.pickups[0]!.state).toBeNull();
    wait(sim, 0.4);
    expect(floorSlot(you)).toBe(1); // stood on the pad: picked up automatically
    const pad = sim.pickups[0]!;
    expect(pad.state).toBeNull();
    you.body.pos.x = 30; you.body.pos.z = 30; // walk away
    wait(sim, PICKUPS.padRespawnSec - 1);
    expect(pad.state).toBeNull();
    wait(sim, 1.3);
    expect(pad.state).not.toBeNull();
    expect(pad.cycle).toBe(1);
  });
});

describe('picking up', () => {
  it('walking over a pad into an empty floor slot picks it up, equips it, and counts it', () => {
    const { sim, you } = arena(2);
    const ev: CombatEvent[] = [];
    wait(sim, PICKUPS.firstSpawnSec + 0.3); evs(sim, ev);
    expect(you.rack).toHaveLength(2);
    expect(you.slot).toBe(1);
    expect(you.stats.pickups).toBe(1);
    expect(ev.some((e) => e.type === 'pickup' && e.actor === 'you')).toBe(true);
    const f = you.rack[1]!, def = WEAPONS[f.id];
    expect(f.reserve).toBe(def.reserveAmmo); // floor ammo is limited, not unlimited
    expect(you.rack[0]!.reserve).toBe(Infinity); // the loadout weapon always is
  });
  it('needs you to be within 1.5 m', () => {
    const { sim, you } = arena(2);
    you.body.pos.x = PAD.x + 1.8;
    wait(sim, PICKUPS.firstSpawnSec + 0.5);
    expect(floorSlot(you)).toBe(-1);
    expect(you.nearPickup).toBeNull();
    you.body.pos.x = PAD.x + 1.2;
    wait(sim, 0.2);
    expect(floorSlot(you)).toBe(1);
  });
  it('with the slot full it shows a prompt and only swaps on E; the old weapon drops at your feet', () => {
    const { sim, you } = arena(4);
    wait(sim, PICKUPS.firstSpawnSec + 0.3);
    const first = you.rack[1]!.id;
    you.rack[1]!.mag = 3; // distinguish it
    you.body.pos.x = PAD2.x; you.body.pos.z = PAD2.z;
    wait(sim, 0.6);
    expect(you.nearPickup).not.toBeNull(); // prompt available
    expect(you.rack[1]!.mag).toBe(3); // still the first weapon: no automatic swap
    const second = sim.pickups.find((p) => p.id === you.nearPickup)!.state!.id;
    sim.step(DT, one('you', inputOf({ interact: true })));
    expect(you.rack).toHaveLength(2);
    expect(you.rack[1]!.id).toBe(second);
    const drop = sim.pickups.find((p) => p.kind === 'drop')!;
    expect(drop.state!.id).toBe(first);
    expect(drop.state!.mag).toBe(3); // keeps its remaining ammo
    expect(drop.despawnT).toBeLessThanOrEqual(PICKUPS.dropDespawnSec);
  });
  it('cannot instantly take a dropped weapon back while standing on it', () => {
    const { sim, you } = arena(4);
    wait(sim, PICKUPS.firstSpawnSec + 0.3);
    wait(sim, PICKUPS.cooldownSec + 0.1); // the short post-pickup lockout must pass first
    sim.step(DT, one('you', inputOf({ drop: true })));
    expect(floorSlot(you)).toBe(-1);
    expect(you.slot).toBe(0);
    wait(sim, 2);
    expect(floorSlot(you)).toBe(-1); // still standing on it: not re-taken
    you.body.pos.x = 20;
    wait(sim, 0.3);
    you.body.pos.x = PAD.x;
    wait(sim, 0.6);
    expect(floorSlot(you)).toBe(1); // after leaving and coming back it can be taken
  });
  it('drops despawn after 15 s', () => {
    const { sim, you } = arena(4);
    wait(sim, PICKUPS.firstSpawnSec + 0.3);
    wait(sim, PICKUPS.cooldownSec + 0.1);
    sim.step(DT, one('you', inputOf({ drop: true })));
    you.body.pos.x = 30;
    expect(sim.pickups.some((p) => p.kind === 'drop')).toBe(true);
    wait(sim, PICKUPS.dropDespawnSec + 0.5);
    expect(sim.pickups.some((p) => p.kind === 'drop')).toBe(false);
  });
  it('dead actors and dummies do not pick up', () => {
    const { sim, you } = arena(4);
    const d = sim.addActor({ id: 'd', kind: 'dummy', name: 'D', spawn: spawnAt(PAD2.x, PAD2.z) });
    you.hp.alive = false; you.hp.respawnT = 99;
    wait(sim, PICKUPS.firstSpawnSec + 1);
    expect(floorSlot(you)).toBe(-1);
    expect(d.rack).toHaveLength(1);
    expect(sim.pickups.every((p) => p.state !== null)).toBe(true);
  });
});

describe('floor weapons', () => {
  it('run dry and vanish, falling back to your loadout weapon', () => {
    const { sim, you } = arena(2);
    wait(sim, PICKUPS.firstSpawnSec + 0.3);
    const ev: CombatEvent[] = [];
    const f = you.rack[1]!;
    f.mag = 2; f.reserve = 0;
    for (let i = 0; i < 90; i++) { sim.step(DT, one('you', inputOf({ fire: true, firePressed: true }))); evs(sim, ev); }
    expect(you.rack).toHaveLength(1);
    expect(you.slot).toBe(0);
    expect(ev.some((e) => e.type === 'weaponEmpty')).toBe(true);
    expect(you.rack[0]!.mag).toBeGreaterThan(0);
  });
  it('reload from limited reserve and never refill', () => {
    const { sim, you } = arena(2);
    wait(sim, PICKUPS.firstSpawnSec + 0.3);
    const f = you.rack[1]!, def = WEAPONS[f.id];
    const total = f.mag + f.reserve;
    wait(sim, 0.6);
    f.mag = 0; // empty magazine, reserve intact
    const reserveBefore = f.reserve;
    sim.step(DT, one('you', inputOf({ reload: true })));
    wait(sim, def.reloadSec * (def.reloadPerShell ? f.magSize : 1) + 0.5);
    expect(f.mag + f.reserve).toBe(reserveBefore); // bullets only move from reserve to magazine
    expect(f.mag + f.reserve).toBeLessThan(total);
  });
  it('rarity scales damage and magazine (Epic: x1.3 damage, +20% magazine)', () => {
    const sim = new CombatSim(flatWorld(), [SPAWN], 1);
    const you = sim.addActor({ id: 'you', kind: 'player', name: 'You', spawn: spawnAt(0, 0), loadout: ['vanguard'] });
    const foe = sim.addActor({ id: 'foe', kind: 'dummy', name: 'F', spawn: spawnAt(0, -10) });
    you.hp.protectT = 0;
    run(sim, 20, () => new Map());
    const epic = you.rack[0]!; // make the loadout weapon an Epic: x1.3 damage, +20% magazine
    epic.rarity = 2; epic.dmgMult = RARITY[2].dmg; epic.magSize = Math.round(30 * RARITY[2].mag); epic.mag = epic.magSize;
    expect(epic.magSize).toBe(36);
    const a = anglesTo(eyeOf(you), { x: 0, y: 1, z: -10 });
    const hits: number[] = [];
    for (let i = 0; i < 4; i++) {
      sim.step(DT, one('you', inputOf({ fire: true, firePressed: true, ads: true, yaw: a.yaw, pitch: a.pitch, aimYaw: a.yaw - you.recoil.yaw, aimPitch: a.pitch - you.recoil.pitch })));
      for (const e of sim.drainEvents()) if (e.type === 'hit') hits.push(e.damage);
    }
    expect(hits.length).toBeGreaterThan(0);
    expect(hits[0]).toBeCloseTo(20 * 1.3, 6);
    expect(foe.hp.hp).toBeLessThan(100);
  });
});

describe('drop on death', () => {
  function duel() {
    const sim = new CombatSim(flatWorld(), [SPAWN, spawnAt(60, 60)], 9, [PAD]);
    const you = sim.addActor({ id: 'you', kind: 'player', name: 'You', spawn: spawnAt(PAD.x, PAD.z), loadout: ['vanguard'] });
    const foe = sim.addActor({ id: 'foe', kind: 'bot', name: 'Foe', spawn: spawnAt(PAD.x, PAD.z - 10), loadout: ['vanguard'] });
    run(sim, 200, () => new Map());
    return { sim, you, foe };
  }
  const killYou = (sim: CombatSim, you: Actor, foe: Actor): void => {
    for (let i = 0; i < 120 && you.hp.alive; i++) {
      const a = anglesTo(eyeOf(foe), { x: you.body.pos.x, y: you.body.pos.y + 1, z: you.body.pos.z });
      sim.step(DT, new Map([['foe', inputOf({ fire: true, firePressed: true, ads: true, yaw: a.yaw, pitch: a.pitch, aimYaw: a.yaw - foe.recoil.yaw, aimPitch: a.pitch - foe.recoil.pitch })], ['you', inputOf()]]));
    }
  };
  it('your floor weapon drops where you die with its remaining ammo, and is lost on respawn', () => {
    const { sim, you, foe } = duel();
    expect(floorSlot(you)).toBe(1);
    const f = you.rack[1]!; f.mag = 5; f.reserve = 7;
    const id = f.id;
    killYou(sim, you, foe);
    expect(you.hp.alive).toBe(false);
    const drop = sim.pickups.find((p) => p.kind === 'drop')!;
    expect([drop.state!.id, drop.state!.mag, drop.state!.reserve]).toEqual([id, 5, 7]);
    expect(Math.hypot(drop.x - you.body.pos.x, drop.z - you.body.pos.z)).toBeLessThan(0.01);
    expect(drop.blockIndex).toBeNull(); // anyone, including the killer, can take it
    run(sim, 200, () => new Map());
    expect(you.hp.alive).toBe(true);
    expect(floorSlot(you)).toBe(-1); // the floor weapon is gone, the loadout weapon is back and full
    expect(you.rack[0]!.mag).toBe(30);
  });
  it('the dead keep a valid selected weapon (regression: slot pointed at the dropped floor weapon and froze the client)', () => {
    const { sim, you, foe } = duel();
    expect(you.slot).toBe(1); // holding the floor weapon when killed
    killYou(sim, you, foe);
    expect(you.hp.alive).toBe(false);
    expect(you.rack[you.slot]).toBeDefined();
    expect(you.slot).toBe(0);
  });
  it('another player can pick the dropped weapon up', () => {
    const { sim, you, foe } = duel();
    killYou(sim, you, foe);
    const drop = sim.pickups.find((p) => p.kind === 'drop')!;
    foe.body.pos.x = drop.x; foe.body.pos.z = drop.z;
    run(sim, 30, () => new Map());
    expect(floorSlot(foe)).toBe(1);
  });
});

describe('Foundry pads', () => {
  it('scene validates with pads', () => {
    expect(validateScene(FOUNDRY)).toEqual([]);
  });
});

describe('state invariants under chaos', () => {
  it('random inputs plus bots for 3 minutes never leave an actor with an invalid weapon, ammo or slot', () => {
    for (const seed of [1, 2, 3]) {
      const t = createTraining(seed);
      const bots = [addBot(t, 'hard'), addBot(t, 'medium'), addBot(t, 'hard'), addBot(t, 'easy')];
      const brains = new Map(bots.map((b, i) => [b.id, new BotBrain(BOT_PROFILES.hard, seed * 10 + i, b.view.yaw)]));
      const rng = mulberry32(seed);
      for (let i = 0; i < 180 * 60; i++) {
        const inputs = new Map<string, ActorInput>();
        for (const b of bots) inputs.set(b.id, brains.get(b.id)!.think(b, t.sim.actors, t.sim.world, DT, t.sim.pickups));
        // a flailing human: random movement, fire, reload, swap, drop, slot changes and weapon choices
        const r = () => rng() < 0.05;
        inputs.set('you', inputOf({
          moveX: Math.round(rng() * 2 - 1), moveZ: Math.round(rng() * 2 - 1), yaw: rng() * 6.28, jump: r(), sprint: r(), crouch: r(), dodge: r(),
          fire: rng() < 0.5, firePressed: rng() < 0.3, reload: r(), interact: rng() < 0.1, drop: rng() < 0.02, ads: r(),
          slot: rng() < 0.1 ? Math.floor(rng() * 4) : null,
        }));
        if (!t.player.hp.alive && rng() < 0.02) t.player.loadout = [TRAINING_RACK[Math.floor(rng() * 5)]!];
        t.sim.step(DT, inputs);
        t.sim.drainEvents();
        for (const a of t.sim.actors) {
          const w = a.rack[a.slot];
          if (!w) throw new Error(`seed ${seed} tick ${i}: ${a.name} has no weapon in slot ${a.slot} (rack ${a.rack.length}, alive ${a.hp.alive})`);
          if (a.rack.length > a.loadout.length + 1) throw new Error(`seed ${seed}: ${a.name} has ${a.rack.length} weapons`);
          for (const x of a.rack) if (x.mag < 0 || x.mag > x.magSize || x.reserve < 0 || Number.isNaN(x.reserve)) throw new Error(`seed ${seed}: bad ammo ${x.id} ${x.mag}/${x.reserve}`);
          if (a.nearPickup !== null && !t.sim.pickups.some((p) => p.id === a.nearPickup && p.state !== null)) throw new Error(`seed ${seed}: ${a.name} is near a pickup that is gone or empty`);
          const p = a.body.pos;
          if (!Number.isFinite(p.x + p.y + p.z) || p.y < -1) throw new Error(`seed ${seed}: ${a.name} bad position`);
        }
      }
    }
  });
});
