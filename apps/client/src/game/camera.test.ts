import { describe, expect, it } from 'vitest';
import { CollisionWorld, WEAPONS, convergeAim, resolveShot, type HitTarget } from '@arena/shared';
import { computeCamera, fovDeg, newRig, CAMERA } from './camera';

const floor = { min: { x: -100, y: -1, z: -100 }, max: { x: 100, y: 0, z: 100 } };
const open = new CollisionWorld([floor]);
const feet = { x: 0, y: 0, z: 0 };

describe('camera rig', () => {
  it('sits behind and to the right of the eye, looking along the aim', () => {
    const rig = computeCamera(open, feet, 1.6, 0, 0, 0, newRig());
    expect(rig.pos.x).toBeCloseTo(CAMERA.side, 6);
    expect(rig.pos.z).toBeCloseTo(CAMERA.back, 6);
    expect(rig.dir).toEqual({ x: -0, y: 0, z: -1 });
  });
  it('tightens while aiming', () => {
    const hip = computeCamera(open, feet, 1.6, 0, 0, 0, newRig()).pos.z;
    const ads = computeCamera(open, feet, 1.6, 0, 0, 1, newRig()).pos.z;
    expect(ads).toBeLessThan(hip);
    expect(ads).toBeCloseTo(CAMERA.adsBack, 6);
  });
  it('is pulled in by a wall behind the player', () => {
    const wall = new CollisionWorld([floor, { min: { x: -5, y: 0, z: 1 }, max: { x: 5, y: 8, z: 1.5 } }]);
    const rig = computeCamera(wall, feet, 1.6, 0, 0, 0, newRig());
    expect(rig.pos.z).toBeLessThan(1.1);
  });
  it('zoom: Longshot scope is 4x, others modest, none when not aiming', () => {
    expect(fovDeg(WEAPONS.longshot, 0)).toBeCloseTo(CAMERA.baseFovDeg, 9);
    const t = Math.tan((CAMERA.baseFovDeg * Math.PI) / 360);
    expect(Math.tan((fovDeg(WEAPONS.longshot, 1) * Math.PI) / 360)).toBeCloseTo(t / 4, 9);
    expect(fovDeg(null, 1)).toBeCloseTo(CAMERA.baseFovDeg, 9);
    expect(fovDeg(WEAPONS.vanguard, 1)).toBeLessThan(CAMERA.baseFovDeg);
  });
  it('end to end: the bullet goes where the crosshair points, at any yaw', () => {
    for (const yaw of [0, 0.7, -1.9, 3.0]) {
      const rig = computeCamera(open, feet, 1.6, yaw, -0.037, 0, newRig()); // crosshair at roughly chest height 18 m out
      // put a target exactly under the crosshair, 18 m along the camera ray
      const t = (18 + CAMERA.back) / Math.hypot(rig.dir.x, rig.dir.z);
      const tx = rig.pos.x + rig.dir.x * t, tz = rig.pos.z + rig.dir.z * t;
      const target: HitTarget = { id: 't', pos: { x: tx, y: 0, z: tz }, height: 1.8, eye: 1.6, alive: true };
      const eye = { x: 0, y: 1.6, z: 0 };
      const a = convergeAim(open, rig.pos, rig.dir, eye, [target]);
      const r = resolveShot(open, WEAPONS.vanguard, { origin: eye, yaw: a.yaw, pitch: a.pitch, spreadDeg: 0, seed: 1, shotId: 1 }, [target]);
      expect(r.pellets[0]!.targetId).toBe('t');
    }
  });
});
