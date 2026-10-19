import { BOT_PROFILES, type BotLevel } from '../balance';
import { CollisionWorld } from '../collision';
import { FOUNDRY, type SceneDef } from '../scenes/foundry';
import { pickSpawn } from './combat';
import { CombatSim, type Actor } from './sim';
import { eyeHeightOf } from '../movement';

export const PLAYER_ID = 'you';
export const BOT_ID = 'bot';

/** Dummies stand on the clear lane z = 0, facing the player spawn at x = -24, at these distances. */
export const DUMMY_DISTANCES = [5, 15, 30, 44] as const;

export interface Training {
  sim: CombatSim;
  player: Actor;
  scene: SceneDef;
}

/** Foundry training range: the player, stationary dummies at known distances, and (on demand) a bot. */
export function createTraining(seed: number, infiniteReserve = true, scene: SceneDef = FOUNDRY): Training {
  const sim = new CombatSim(new CollisionWorld(scene.boxes), scene.spawns, seed);
  const sp = scene.spawns[0]!;
  const player = sim.addActor({ id: PLAYER_ID, kind: 'player', name: 'You', spawn: sp, infiniteReserve });
  for (const d of DUMMY_DISTANCES)
    sim.addActor({ id: `dummy-${d}`, kind: 'dummy', name: `Dummy ${d} m`, spawn: { x: sp.x + d, y: 0, z: sp.z, yaw: Math.PI / 2 } });
  return { sim, player, scene };
}

/** Adds the practice bot at the spawn farthest from, and hidden from, the player. */
export function addBot(t: Training, level: BotLevel, infiniteReserve = true): Actor {
  const p = t.player;
  const eye = { x: p.body.pos.x, y: p.body.pos.y + eyeHeightOf(p.body), z: p.body.pos.z };
  const spawn = pickSpawn(t.sim.world, t.sim.spawns, [eye]);
  return t.sim.addActor({
    id: BOT_ID, kind: 'bot', name: `Bot (${level})`, spawn,
    loadout: [BOT_PROFILES[level].weapon], infiniteReserve,
  });
}
