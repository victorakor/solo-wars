import { CollisionWorld } from '../collision';
import { MOVE } from '../balance';
import type { SceneDef } from './foundry';

/** Returns a list of problems; empty means the scene is valid. */
export function validateScene(s: SceneDef): string[] {
  const errs: string[] = [];
  s.boxes.forEach((bx, i) => {
    for (const a of ['x', 'y', 'z'] as const)
      if (!(bx.min[a] < bx.max[a])) errs.push(`box ${i} (${bx.kind}) has non-positive extent on ${a}`);
  });
  const w = new CollisionWorld(s.boxes);
  s.spawns.forEach((p, i) => {
    const hit = w.query({ x: p.x - MOVE.radius, y: p.y, z: p.z - MOVE.radius },
      { x: p.x + MOVE.radius, y: p.y + MOVE.heightStand, z: p.z + MOVE.radius });
    if (hit.length) errs.push(`spawn ${i} intersects geometry`);
  });
  if (s.spawns.length < 2) errs.push('need at least 2 spawns');
  return errs;
}
