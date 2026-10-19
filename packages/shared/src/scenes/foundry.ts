import type { Box } from '../collision';

export interface SceneDef {
  id: string; name: string; bounds: { x: number; z: number };
  boxes: Box[]; spawns: { x: number; y: number; z: number; yaw: number }[];
}
const b = (kind: string, x0: number, y0: number, z0: number, x1: number, y1: number, z1: number): Box =>
  ({ kind, min: { x: x0, y: y0, z: z0 }, max: { x: x1, y: y1, z: z1 } });

/** Foundry blockout: 56 x 40 m. Walkable surfaces: floor, catwalks and bridge at y=4, stairs at 4 corners. */
function build(): Box[] {
  const o: Box[] = [
    b('floor', -29, -1, -21, 29, 0, 21),
    b('wall', -29, 0, -21, 29, 12, -20), b('wall', -29, 0, 20, 29, 12, 21),
    b('wall', -29, 0, -21, -28, 12, 21), b('wall', 28, 0, -21, 29, 12, 21),
    b('bridge', -1.5, 3.6, -15, 1.5, 4, 15),
    b('rail', -1.5, 4, -15, -1.4, 5.1, 15), b('rail', 1.4, 4, -15, 1.5, 5.1, 15),
  ];
  for (const sz of [1, -1]) {
    const z0 = sz > 0 ? 15 : -19, z1 = z0 + 4;
    o.push(b('catwalk', -22.5, 3.6, z0, 22.5, 4, z1));
    const ri = sz > 0 ? 15 : -15; // inner rail with a gap at the bridge
    o.push(b('rail', -22.5, 4, ri - 0.1, -1.5, 5.1, ri + 0.1), b('rail', 1.5, 4, ri - 0.1, 22.5, 5.1, ri + 0.1));
    for (const px of [-22, -12, 12, 22]) o.push(b('pillar', px - 0.3, 0, (sz > 0 ? 17 : -17) - 0.3, px + 0.3, 3.6, (sz > 0 ? 17 : -17) + 0.3));
    for (const sx of [1, -1]) // 10 steps of 0.4 m, run 0.55 m, from wall to catwalk end
      for (let i = 0; i < 10; i++) {
        const x0 = 28 - 0.55 * (i + 1), zA = sz > 0 ? 15.5 : -18.5;
        o.push(sx > 0 ? b('stair', x0, 0, zA, 28, 0.4 * (i + 1), zA + 3) : b('stair', -28, 0, zA, -x0, 0.4 * (i + 1), zA + 3));
      }
  }
  o.push(
    b('container', -11, 0, -5.2, -5, 2.6, -2.8), b('container', -10.5, 2.6, -4.8, -6, 5.2, -3.2),
    b('container', 5, 0, 2.8, 11, 2.6, 5.2), b('container', 6, 2.6, 3.2, 10.5, 5.2, 4.8),
    b('container', -1.2, 0, -12, 1.2, 2.6, -6), b('container', -1.2, 0, 6, 1.2, 2.6, 12),
    b('container', -18, 0, 4, -15.6, 2.6, 10), b('container', 15.6, 0, -10, 18, 2.6, -4),
    b('crate', -4.6, 0, 7.4, -3.4, 0.9, 8.6), b('crate', 3.4, 0, -8.6, 4.6, 0.9, -7.4),
    b('crate', -20, 0, -8, -18.8, 1.2, -6.8), b('crate', 18.8, 0, 6.8, 20, 1.2, 8),
    b('pipe', 11, 0, -11, 17, 0.5, -10.5), b('pipe', -17, 0, 10.5, -11, 0.5, 11),
  );
  return o;
}
export const FOUNDRY: SceneDef = {
  id: 'foundry', name: 'Foundry', bounds: { x: 28, z: 20 }, boxes: build(),
  spawns: [{ x: -24, y: 0, z: 0, yaw: -Math.PI / 2 }, { x: 24, y: 0, z: 0, yaw: Math.PI / 2 }],
};
