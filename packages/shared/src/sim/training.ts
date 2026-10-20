import { type BotLevel, type WeaponId } from '../balance';
import { CollisionWorld } from '../collision';
import { FOUNDRY, type SceneDef } from '../scenes/foundry';
import { eyeHeightOf } from '../movement';
import { pickSpawn } from './combat';
import { mixSeed, mulberry32 } from './rng';
import { CombatSim, type Actor } from './sim';

export const PLAYER_ID = 'you';

/** Dummies (tests and benchmarks only) stand on the clear lane z = 0, facing the player spawn at x = -24. */
export const DUMMY_DISTANCES = [5, 15, 30, 44] as const;

/** What bots may carry as their loadout weapon; weighted towards the all-rounders. */
const BOT_WEAPONS: readonly WeaponId[] = ['rattler', 'vanguard', 'vanguard', 'sidearm', 'breaker', 'longshot'];

export interface Training {
  sim: CombatSim;
  player: Actor;
  scene: SceneDef;
  seed: number;
  /** Counts bots ever added, for unique ids and names. */
  botSeq: number;
}

export interface TrainingOptions {
  /** Your loadout weapon (slot 1, unlimited reserve). */
  weapon?: WeaponId;
  /** Stationary targets on the centre lane. Off by default: the range is a free-for-all against bots. */
  dummies?: boolean;
}

/** Foundry free-for-all: the player alone at first; add bots with `addBot`. Floor pads are live. */
export function createTraining(seed: number, opts: TrainingOptions = {}, scene: SceneDef = FOUNDRY): Training {
  const sim = new CombatSim(new CollisionWorld(scene.boxes), scene.spawns, seed, scene.pads);
  const sp = scene.spawns[0]!;
  const player = sim.addActor({ id: PLAYER_ID, kind: 'player', name: 'You', spawn: sp, loadout: [opts.weapon ?? 'vanguard'] });
  if (opts.dummies)
    for (const d of DUMMY_DISTANCES)
      sim.addActor({ id: `dummy-${d}`, kind: 'dummy', name: `Dummy ${d} m`, spawn: { x: sp.x + d, y: 0, z: sp.z, yaw: Math.PI / 2 } });
  return { sim, player, scene, seed, botSeq: 0 };
}

/**
 * Adds one bot at the spawn farthest from, and hidden from, everyone alive. Each bot gets its own loadout
 * weapon (random unless given) and fights everybody, including other bots.
 */
export function addBot(t: Training, level: BotLevel, weapon?: WeaponId): Actor {
  const n = ++t.botSeq;
  const eyes = t.sim.actors
    .filter((a) => a.kind !== 'dummy' && a.hp.alive)
    .map((a) => ({ x: a.body.pos.x, y: a.body.pos.y + eyeHeightOf(a.body), z: a.body.pos.z }));
  const spawn = pickSpawn(t.sim.world, t.sim.spawns, eyes);
  const w = weapon ?? BOT_WEAPONS[Math.floor(mulberry32(mixSeed(t.seed, n))() * BOT_WEAPONS.length)]!;
  return t.sim.addActor({ id: `bot-${n}`, kind: 'bot', name: `Bot ${n} (${level})`, spawn, loadout: [w] });
}
