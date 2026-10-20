import { describe, expect, it } from 'vitest';
import { BOT_PROFILES, type BotLevel } from '../balance';
import { BotBrain } from './bot';
import { CombatSim, type ActorInput } from './sim';
import { DT, box, flatSim, spawnAt } from './testkit';
import { PLAYER_ID, addBot, createTraining } from './training';

/** Bot vs a motionless target. Returns seconds until the first kill (or Infinity) and the bot's stats. */
function duelStill(level: BotLevel, seed: number, dist = 15, secs = 30, ...walls: ReturnType<typeof box>[]) {
  const sim = flatSim(seed, [spawnAt(0, 0)], ...walls);
  const target = sim.addActor({ id: 'target', kind: 'player', name: 'T', spawn: spawnAt(0, 0) });
  const bot = sim.addActor({ id: 'bot', kind: 'bot', name: 'B', spawn: spawnAt(0, -dist), loadout: ['vanguard'] });
  const brain = new BotBrain(BOT_PROFILES[level], seed * 31 + 7, 0);
  let firstKill = Infinity;
  const ev: string[] = [];
  for (let i = 0; i < secs * 60; i++) {
    sim.step(DT, new Map<string, ActorInput>([['bot', brain.think(bot, [target], sim.world, DT)]]));
    for (const e of sim.drainEvents()) { ev.push(e.type); if (e.type === 'kill' && firstKill === Infinity) firstKill = sim.time; }
  }
  return { firstKill, bot, target, ev, sim };
}

describe('bot', () => {
  it('kills a stationary target in the open at every difficulty', () => {
    for (const level of ['easy', 'medium', 'hard'] as const) {
      const r = duelStill(level, 1);
      expect(r.firstKill).toBeLessThan(20);
      expect(r.bot.stats.kills).toBeGreaterThanOrEqual(1);
    }
  });
  it('is fair: it misses sometimes, never hits 100% of shots', () => {
    const r = duelStill('medium', 2);
    expect(r.bot.stats.shotsFired).toBeGreaterThan(10);
    expect(r.bot.stats.shotsHit / r.bot.stats.shotsFired).toBeLessThan(0.98);
  });
  it('harder bots kill faster on average (10 seeds)', () => {
    const mean = (level: BotLevel): number => {
      let s = 0;
      for (let seed = 1; seed <= 10; seed++) s += Math.min(duelStill(level, seed, 15, 40).firstKill, 40);
      return s / 10;
    };
    const easy = mean('easy'), medium = mean('medium'), hard = mean('hard');
    expect(hard).toBeLessThan(medium);
    expect(medium).toBeLessThan(easy);
  });
  it('reacts after its reaction delay: no shots in the first reactionSec of seeing the target', () => {
    const sim = flatSim(1);
    const target = sim.addActor({ id: 'target', kind: 'player', name: 'T', spawn: spawnAt(0, 0) });
    const bot = sim.addActor({ id: 'bot', kind: 'bot', name: 'B', spawn: spawnAt(0, -15), loadout: ['vanguard'] });
    const brain = new BotBrain(BOT_PROFILES.hard, 5, 0);
    const n = Math.floor(BOT_PROFILES.hard.reactionSec * 60) - 1;
    for (let i = 0; i < n; i++) sim.step(DT, new Map([['bot', brain.think(bot, [target], sim.world, DT)]]));
    expect(bot.stats.shotsFired).toBe(0);
  });
  it('never fires without line of sight', () => {
    const wall = box(-100, 0, -8, 100, 12, -7); // endless wall between them
    const r = duelStill('hard', 3, 15, 15, wall);
    expect(r.bot.stats.shotsFired).toBe(0);
    expect(r.bot.body.pos.z).toBeLessThan(-7);
  });
  it('reloads on its own when the magazine runs dry', () => {
    const r = duelStill('easy', 4, 28, 40); // long range = lots of missed shots
    expect(r.ev.includes('reloadStart')).toBe(true);
    expect(r.ev.includes('reloadDone')).toBe(true);
  });
  it('is idle (and harmless) while dead', () => {
    const sim = flatSim(1);
    const target = sim.addActor({ id: 'target', kind: 'player', name: 'T', spawn: spawnAt(0, 0) });
    const bot = sim.addActor({ id: 'bot', kind: 'bot', name: 'B', spawn: spawnAt(0, -10), loadout: ['vanguard'] });
    const brain = new BotBrain(BOT_PROFILES.medium, 1, 0);
    bot.hp.alive = false; bot.hp.respawnT = 99;
    const inp = brain.think(bot, [target], sim.world, DT);
    expect([inp.fire, inp.moveX, inp.moveZ, inp.jump]).toEqual([false, 0, 0, false]);
  });
});

describe('bot is mobile and aggressive', () => {
  /** Two bots of the same level in the open for 30 s; returns what bot A tried to do. */
  function openFight(level: BotLevel) {
    const sim = flatSim(3);
    const A = sim.addActor({ id: 'A', kind: 'bot', name: 'A', spawn: spawnAt(0, 0), loadout: ['vanguard'] });
    const B = sim.addActor({ id: 'B', kind: 'bot', name: 'B', spawn: spawnAt(0, -18), loadout: ['vanguard'] });
    const bA = new BotBrain(BOT_PROFILES[level], 5, 0), bB = new BotBrain(BOT_PROFILES[level], 9, 0);
    let flips = 0, last = 0, dodges = 0, jumps = 0;
    for (let i = 0; i < 60 * 30; i++) {
      const ia = bA.think(A, [B], sim.world, DT);
      if (ia.moveX !== 0) { if (last !== 0 && ia.moveX !== last) flips++; last = ia.moveX; }
      if (ia.dodge) dodges++;
      if (ia.jump) jumps++;
      sim.step(DT, new Map<string, ActorInput>([['A', ia], ['B', bB.think(B, [A], sim.world, DT)]]));
      sim.drainEvents();
    }
    return { flips, dodges, jumps, shots: A.stats.shotsFired + B.stats.shotsFired };
  }
  it('strafes and keeps changing direction during a fight (not a straight line)', () => {
    for (const level of ['easy', 'medium', 'hard'] as const) {
      const r = openFight(level);
      expect(r.flips).toBeGreaterThanOrEqual(6);
      expect(r.shots).toBeGreaterThan(20);
    }
  });
  it('rolls away when shot, and the harder bots jump-strafe', () => {
    expect(openFight('medium').dodges).toBeGreaterThanOrEqual(1);
    expect(openFight('hard').dodges).toBeGreaterThanOrEqual(1);
    expect(openFight('hard').jumps).toBeGreaterThanOrEqual(1);
    expect(openFight('easy').jumps).toBe(0);
  });
  it('hunts a target hidden behind Foundry cover and opens fire within 20 s (it may grab a floor weapon first)', () => {
    for (const level of ['easy', 'medium', 'hard'] as const) {
      for (let seed = 1; seed <= 6; seed++) {
        const t = createTraining(seed);
        const bot = addBot(t, level);
        const brain = new BotBrain(BOT_PROFILES[level], seed, bot.view.yaw);
        let opened = Infinity;
        for (let i = 0; i < 60 * 25 && opened === Infinity; i++) {
          t.sim.step(DT, new Map([[bot.id, brain.think(bot, [t.player], t.sim.world, DT, t.sim.pickups)]]));
          t.sim.drainEvents();
          t.player.hp.hp = 100; // the target just stands there
          if (bot.stats.shotsFired > 0) opened = t.sim.time;
        }
        expect(opened).toBeLessThan(20);
      }
    }
  });
});

describe('bot vs bot on Foundry (soak)', () => {
  it('finds, fights and kills over 2 simulated minutes without leaving the map or producing NaN', () => {
    for (const seed of [1, 2, 3]) {
      const t = createTraining(seed);
      t.sim.removeActor(PLAYER_ID);
      for (const a of [...t.sim.actors]) if (a.kind === 'dummy') t.sim.removeActor(a.id);
      const A = t.sim.addActor({ id: 'A', kind: 'bot', name: 'A', spawn: t.scene.spawns[0]!, loadout: ['vanguard'] });
      const B = t.sim.addActor({ id: 'B', kind: 'bot', name: 'B', spawn: t.scene.spawns[1]!, loadout: ['vanguard'] });
      const bA = new BotBrain(BOT_PROFILES.medium, seed, A.view.yaw), bB = new BotBrain(BOT_PROFILES.medium, seed + 100, B.view.yaw);
      for (let i = 0; i < 120 * 60; i++) {
        t.sim.step(DT, new Map<string, ActorInput>([['A', bA.think(A, [B], t.sim.world, DT)], ['B', bB.think(B, [A], t.sim.world, DT)]]));
        t.sim.drainEvents();
        for (const a of [A, B]) {
          const p = a.body.pos;
          if (!Number.isFinite(p.x + p.y + p.z)) throw new Error(`NaN position seed ${seed}`);
          if (Math.abs(p.x) > 30 || Math.abs(p.z) > 22 || p.y < -1) throw new Error(`out of bounds seed ${seed}: ${p.x},${p.y},${p.z}`);
        }
      }
      expect(A.stats.kills + B.stats.kills).toBeGreaterThanOrEqual(4);
    }
  });
});

describe('free-for-all', () => {
  /** A passive player (stands still) plus `n` bots of mixed levels, for `secs` seconds. */
  function melee(seed: number, n: number, secs: number) {
    const t = createTraining(seed);
    const levels = ['easy', 'medium', 'hard'] as const;
    const bots = Array.from({ length: n }, (_, i) => addBot(t, levels[i % 3]!));
    const brains = new Map(bots.map((b, i) => [b.id, new BotBrain(BOT_PROFILES[levels[i % 3]!], seed * 100 + i, b.view.yaw)]));
    for (let i = 0; i < secs * 60; i++) {
      const inputs = new Map<string, ActorInput>();
      for (const b of bots) inputs.set(b.id, brains.get(b.id)!.think(b, t.sim.actors, t.sim.world, DT, t.sim.pickups));
      t.sim.step(DT, inputs);
      t.sim.drainEvents();
      for (const a of t.sim.actors) {
        const p = a.body.pos;
        if (!Number.isFinite(p.x + p.y + p.z)) throw new Error(`NaN position seed ${seed}`);
        if (Math.abs(p.x) > 30 || Math.abs(p.z) > 22 || p.y < -1) throw new Error(`out of bounds seed ${seed}: ${p.x},${p.y},${p.z}`);
      }
    }
    return { t, bots };
  }
  it('five bots fight each other and the player: kills spread around, weapons get picked up, nobody leaves the map', () => {
    for (const seed of [1, 2]) {
      const { t, bots } = melee(seed, 5, 180);
      const botKills = bots.reduce((s, b) => s + b.stats.kills, 0);
      expect(botKills).toBeGreaterThanOrEqual(8);
      expect(bots.filter((b) => b.stats.deaths > 0).length).toBeGreaterThanOrEqual(3); // they kill each other, not just one victim
      expect(bots.every((b) => b.stats.shotsFired > 0)).toBe(true);
      expect(bots.reduce((s, b) => s + b.stats.pickups, 0)).toBeGreaterThanOrEqual(3); // they go and get floor weapons
      expect(t.player.stats.damageTaken).toBeGreaterThan(0); // and they come for the player too
    }
  });
  it('bots switch between their two weapons by range', () => {
    const t = createTraining(3);
    const bot = addBot(t, 'hard', 'vanguard');
    const foe = addBot(t, 'easy', 'rattler');
    // give the first bot a Breaker as its floor weapon and see whether it ever selects it
    bot.rack.push(JSON.parse(JSON.stringify({ ...bot.rack[0]!, id: 'breaker', mag: 6, magSize: 6, reserve: 24 })));
    const brain = new BotBrain(BOT_PROFILES.hard, 8, bot.view.yaw), brain2 = new BotBrain(BOT_PROFILES.easy, 9, foe.view.yaw);
    const used = new Set<string>();
    for (let i = 0; i < 60 * 120; i++) {
      t.sim.step(DT, new Map([[bot.id, brain.think(bot, t.sim.actors, t.sim.world, DT, t.sim.pickups)], [foe.id, brain2.think(foe, t.sim.actors, t.sim.world, DT, t.sim.pickups)]]));
      t.sim.drainEvents();
      if (bot.hp.alive && bot.rack.length > 1) used.add(bot.rack[bot.slot]!.id);
    }
    expect(used.has('breaker')).toBe(true);
  });
});

describe('training setup', () => {
  it('adds bots one at a time at a hidden far spawn, each with its own loadout weapon', () => {
    const t = createTraining(1);
    const bot = addBot(t, 'medium', 'vanguard');
    expect(bot.id).toBe('bot-1');
    expect(bot.rack.map((w) => w.id)).toEqual(['vanguard']);
    const second = addBot(t, 'hard');
    expect(second.id).toBe('bot-2');
    expect(t.sim.actors.filter((a) => a.kind === 'bot')).toHaveLength(2);
    const picks = new Set(Array.from({ length: 12 }, () => addBot(t, 'easy').rack[0]!.id));
    expect(picks.size).toBeGreaterThan(1); // random weapons, not all the same
    expect(Math.hypot(bot.body.pos.x - t.player.body.pos.x, bot.body.pos.z - t.player.body.pos.z)).toBeGreaterThan(30);
  });
  it('a CombatSim can be driven without any brain (idle inputs)', () => {
    const sim: CombatSim = flatSim(1);
    sim.addActor({ id: 'x', kind: 'bot', name: 'x', spawn: spawnAt(0, 0) });
    for (let i = 0; i < 60; i++) sim.step(DT, new Map());
    expect(sim.actors).toHaveLength(1);
  });
});
