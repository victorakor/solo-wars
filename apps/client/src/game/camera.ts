import type { CollisionWorld, Vec3, WeaponDef } from '@arena/shared';

export interface CameraRig {
  pos: Vec3;
  /** Unit look direction. */
  dir: Vec3;
}

export const CAMERA = { back: 3.4, side: 0.75, lift: 0.2, adsBack: 1.8, adsSide: 0.45, baseFovDeg: 80 } as const;

const lerp = (a: number, b: number, t: number): number => a + (b - a) * t;

/**
 * Over-the-shoulder camera: behind and beside the eye, pulled in by geometry, tighter while aiming.
 * `pitch` and `yaw` already include recoil. Writes into `out` to avoid per-frame allocation.
 */
export function computeCamera(
  world: CollisionWorld, feet: Vec3, eye: number, yaw: number, pitch: number, adsT: number, out: CameraRig,
): CameraRig {
  const cp = Math.cos(pitch), sp = Math.sin(pitch), sy = Math.sin(yaw), cy = Math.cos(yaw);
  const dx = -sy * cp, dy = sp, dz = -cy * cp;
  const rx = cy, rz = -sy;
  const px = feet.x, py = feet.y + eye, pz = feet.z;
  const back = lerp(CAMERA.back, CAMERA.adsBack, adsT), side = lerp(CAMERA.side, CAMERA.adsSide, adsT);
  let vx = -dx * back + rx * side, vy = -dy * back + CAMERA.lift, vz = -dz * back + rz * side;
  const len = Math.hypot(vx, vy, vz);
  vx /= len; vy /= len; vz /= len;
  const hit = world.raycast({ x: px, y: py, z: pz }, { x: vx, y: vy, z: vz }, len + 0.3);
  const d = hit === null ? len : Math.max(0.4, hit - 0.3);
  out.pos.x = px + vx * d; out.pos.y = py + vy * d; out.pos.z = pz + vz * d;
  out.dir.x = dx; out.dir.y = dy; out.dir.z = dz;
  return out;
}

export const newRig = (): CameraRig => ({ pos: { x: 0, y: 0, z: 0 }, dir: { x: 0, y: 0, z: -1 } });

/** Vertical FOV in degrees while aiming: adsFovMult is a magnification (0.25 = 4x), applied to the view tangent. */
export function fovDeg(def: WeaponDef | null, adsT: number): number {
  const mult = def ? lerp(1, def.adsFovMult, adsT) : 1;
  return (2 * Math.atan(Math.tan((CAMERA.baseFovDeg * Math.PI) / 360) * mult) * 180) / Math.PI;
}
