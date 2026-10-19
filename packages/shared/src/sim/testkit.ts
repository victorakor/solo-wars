import { CollisionWorld, type Box, type Vec3 } from '../collision';
import type { SpawnPoint } from './combat';
import { CombatSim, idleInput, type Actor, type ActorInput } from './sim';

/** Helpers shared by the combat tests. Not imported by shipped code. */
export const DT = 1 / 60;
export const box = (x0: number, y0: number, z0: number, x1: number, y1: number, z1: number): Box =>
  ({ min: { x: x0, y: y0, z: z0 }, max: { x: x1, y: y1, z: z1 } });

export const FLOOR = box(-100, -1, -100, 100, 0, 100);
export const flatWorld = (...extra: Box[]): CollisionWorld => new CollisionWorld([FLOOR, ...extra]);
export const SPAWN: SpawnPoint = { x: 0, y: 0, z: 0, yaw: 0 };
export const spawnAt = (x: number, z: number, yaw = 0): SpawnPoint => ({ x, y: 0, z, yaw });

export const inputOf = (o: Partial<ActorInput> = {}): ActorInput => ({ ...idleInput(), ...o });

/** Raw yaw/pitch from an eye position to a point, matching the sim's convention (forward = -Z at yaw 0). */
export function anglesTo(eye: Vec3, to: Vec3): { yaw: number; pitch: number } {
  const dx = to.x - eye.x, dy = to.y - eye.y, dz = to.z - eye.z;
  return { yaw: Math.atan2(-dx, -dz), pitch: Math.atan2(dy, Math.hypot(dx, dz)) };
}

/** Eye position of an actor right now. */
export const eyeOf = (a: Actor): Vec3 => ({ x: a.body.pos.x, y: a.body.pos.y + (a.body.crouched ? 1.05 : 1.6), z: a.body.pos.z });

/** Flat open arena with a floor from -100..100. */
export function flatSim(seed = 1, spawns: SpawnPoint[] = [SPAWN], ...walls: Box[]): CombatSim {
  return new CombatSim(flatWorld(...walls), spawns, seed);
}

/** Runs `ticks` steps; `inputFor` is called every tick and may return a different input per actor. */
export function run(sim: CombatSim, ticks: number, inputFor: (tick: number) => Map<string, ActorInput>): void {
  for (let i = 0; i < ticks; i++) sim.step(DT, inputFor(i));
}

export const one = (id: string, inp: ActorInput): Map<string, ActorInput> => new Map([[id, inp]]);
