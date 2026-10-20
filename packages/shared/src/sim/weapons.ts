import { COMBAT, DEG, RARITY, WEAPONS, type WeaponDef, type WeaponId } from '../balance';
import type { Vec3 } from '../collision';
import type { PlayerState } from '../movement';
import type { Rng } from './rng';

/** Per-weapon runtime state. `reserve` is Infinity for unlimited ammo. */
export interface WeaponState {
  id: WeaponId;
  mag: number;
  /** Magazine capacity. Rare and Epic floor weapons carry bigger magazines than the base definition. */
  magSize: number;
  /** 0 Common, 1 Rare, 2 Epic. */
  rarity: number;
  /** Damage multiplier from rarity. */
  dmgMult: number;
  reserve: number;
  /** Seconds until the next shot is allowed. Slightly negative values carry over so rpm is exact. */
  cooldown: number;
  reloading: boolean;
  /** Time left on the current reload (or current shell for per-shell reloads). */
  reloadT: number;
  equipT: number;
  /** Aim-down-sights progress 0..1. */
  adsT: number;
  /** Remaining life of a buffered trigger press. */
  buffer: number;
}

export type FireResult = 'fired' | 'dry' | 'blocked' | 'idle';
export type WeaponEvent = 'reloadDone' | 'shellLoaded' | null;

export function newWeapon(id: WeaponId, infiniteReserve = false, rarity = 0): WeaponState {
  const def = WEAPONS[id];
  const r = RARITY[rarity] ?? RARITY[0];
  const reserve = infiniteReserve || def.reserveAmmo === null ? Infinity : def.reserveAmmo;
  const magSize = Math.round(def.magSize * r.mag);
  return { id, mag: magSize, magSize, rarity, dmgMult: r.dmg, reserve, cooldown: 0, reloading: false, reloadT: 0, equipT: 0, adsT: 0, buffer: 0 };
}

export function cancelReload(ws: WeaponState): void {
  ws.reloading = false;
  ws.reloadT = 0;
}

/** Starts equipping: blocks firing and reloading for `equipSec` and drops any reload or ADS. */
export function equipWeapon(ws: WeaponState, def: WeaponDef): void {
  ws.equipT = def.equipSec;
  ws.adsT = 0;
  ws.buffer = 0;
  cancelReload(ws);
}

/** Returns true when a reload actually started. */
export function startReload(ws: WeaponState, def: WeaponDef): boolean {
  if (ws.reloading || ws.equipT > 0 || ws.mag >= ws.magSize || ws.reserve <= 0) return false;
  ws.reloading = true;
  ws.reloadT = def.reloadSec;
  return true;
}

/** Advances timers of a holstered weapon (only the fire cooldown keeps running, so swapping is no exploit). */
export function stepHolstered(ws: WeaponState, dt: number): void {
  ws.cooldown = Math.max(-dt, ws.cooldown - dt);
  ws.buffer = 0;
  ws.adsT = 0;
}

/** Advances the equipped weapon: cooldown, equip, ADS and reload progress. */
export function stepWeapon(ws: WeaponState, def: WeaponDef, dt: number, wantAds: boolean): WeaponEvent {
  ws.cooldown = Math.max(-dt, ws.cooldown - dt);
  ws.buffer = Math.max(0, ws.buffer - dt);
  if (ws.equipT > 0) ws.equipT = Math.max(0, ws.equipT - dt);
  const k = dt / def.adsSeconds;
  ws.adsT = wantAds ? Math.min(1, ws.adsT + k) : Math.max(0, ws.adsT - k);
  if (!ws.reloading) return null;
  ws.reloadT -= dt;
  if (ws.reloadT > 0) return null;
  if (def.reloadPerShell) {
    ws.mag += 1;
    ws.reserve -= 1;
    if (ws.mag < ws.magSize && ws.reserve > 0) {
      ws.reloadT += def.reloadSec;
      return 'shellLoaded';
    }
  } else {
    const take = Math.min(ws.magSize - ws.mag, ws.reserve);
    ws.mag += take;
    ws.reserve -= take;
  }
  cancelReload(ws);
  return 'reloadDone';
}

/**
 * Trigger logic for one tick. `pressed` is the press edge, `held` the level.
 * Auto weapons fire while held. Everything else needs a fresh press, with a short buffer so a press
 * landing just before the cooldown ends still counts. An empty trigger pull clicks and starts a reload.
 */
export function tryFire(ws: WeaponState, def: WeaponDef, pressed: boolean, held: boolean, canShoot: boolean): FireResult {
  const auto = def.fireMode === 'auto';
  if (pressed && !auto) ws.buffer = COMBAT.fireBufferSec;
  const want = auto ? held || pressed : pressed || ws.buffer > 0;
  if (!want) return 'idle';
  if (!canShoot || ws.equipT > 0) return 'blocked';
  if (ws.reloading) {
    if (def.reloadPerShell && ws.mag > 0) cancelReload(ws); // shotguns can interrupt a reload
    else return 'blocked';
  }
  if (ws.cooldown > 0) return 'blocked';
  if (ws.mag <= 0) {
    ws.buffer = 0;
    startReload(ws, def);
    ws.cooldown = Math.max(ws.cooldown, COMBAT.dryClickSec);
    return 'dry';
  }
  ws.mag -= 1;
  ws.buffer = 0;
  ws.cooldown += 60 / def.rpm;
  return 'fired';
}

// --- damage ---------------------------------------------------------------

/** Linear damage multiplier between falloffStart (1.0) and falloffEnd (minDamageMult). */
export function damageFalloff(def: WeaponDef, dist: number): number {
  if (dist <= def.falloffStart) return 1;
  if (dist >= def.falloffEnd) return def.minDamageMult;
  const k = (dist - def.falloffStart) / (def.falloffEnd - def.falloffStart);
  return 1 + (def.minDamageMult - 1) * k;
}

/** Damage of one bullet or pellet: base x falloff x head multiplier x external multiplier (rarity). */
export function bulletDamage(def: WeaponDef, dist: number, head: boolean, mult = 1): number {
  return def.damage * damageFalloff(def, dist) * (head ? def.headMult : 1) * mult;
}

// --- spread ---------------------------------------------------------------

export interface Motion {
  speed: number;
  onGround: boolean;
  crouched: boolean;
}

export function motionOf(s: PlayerState): Motion {
  return { speed: Math.hypot(s.vel.x, s.vel.z), onGround: s.onGround, crouched: s.crouched };
}

/** Cone half-angle (degrees) of the aim spread right now. Also drives the HUD crosshair size. */
export function currentSpreadDeg(def: WeaponDef, adsT: number, m: Motion): number {
  const base = def.spreadHip + (def.spreadAds - def.spreadHip) * adsT;
  const S = COMBAT.spread;
  let mult = 1;
  if (!m.onGround) mult = S.airMult;
  else {
    if (m.speed > S.movingSpeed) mult *= S.moveMult;
    if (m.crouched) mult *= S.crouchMult;
  }
  return base * mult;
}

export const forwardOf = (yaw: number, pitch: number): Vec3 => {
  const cp = Math.cos(pitch);
  return { x: -Math.sin(yaw) * cp, y: Math.sin(pitch), z: -Math.cos(yaw) * cp };
};

/** Uniform sample inside a disc of the given radius. */
function disc(rng: Rng, radius: number): [number, number] {
  const r = radius * Math.sqrt(rng());
  const a = rng() * Math.PI * 2;
  return [r * Math.cos(a), r * Math.sin(a)];
}

/**
 * One unit direction per pellet. The aim spread is sampled once per trigger pull (all pellets share
 * the shifted centre); each pellet then adds its own pelletSpread. Draw order is fixed so client and
 * server agree for the same rng.
 */
export function shotDirections(yaw: number, pitch: number, spreadDeg: number, def: WeaponDef, rng: Rng): Vec3[] {
  const f = forwardOf(yaw, pitch);
  const right = { x: Math.cos(yaw), y: 0, z: -Math.sin(yaw) };
  const up = { x: right.y * f.z - right.z * f.y, y: right.z * f.x - right.x * f.z, z: right.x * f.y - right.y * f.x };
  const [u0, v0] = disc(rng, Math.tan(spreadDeg * DEG));
  const out: Vec3[] = [];
  for (let i = 0; i < def.pellets; i++) {
    let u = u0, v = v0;
    if (def.pelletSpread > 0) {
      const [pu, pv] = disc(rng, Math.tan(def.pelletSpread * DEG));
      u += pu; v += pv;
    }
    const x = f.x + right.x * u + up.x * v, y = f.y + right.y * u + up.y * v, z = f.z + right.z * u + up.z * v;
    const len = Math.hypot(x, y, z);
    out.push({ x: x / len, y: y / len, z: z / len });
  }
  return out;
}

// --- recoil ---------------------------------------------------------------

/** View kick in radians, added to the player's own aim when firing and shown by the camera. */
export interface Recoil {
  pitch: number;
  yaw: number;
  /** Seconds before recovery starts. */
  hold: number;
}

export const newRecoil = (): Recoil => ({ pitch: 0, yaw: 0, hold: 0 });

export function resetRecoil(r: Recoil): void {
  r.pitch = 0; r.yaw = 0; r.hold = 0;
}

export function kickRecoil(r: Recoil, def: WeaponDef, rng: Rng): void {
  const C = COMBAT.recoil;
  r.pitch = Math.min(C.maxPitchDeg * DEG, r.pitch + def.recoilPitch * DEG);
  const yaw = r.yaw + (rng() * 2 - 1) * def.recoilYaw * DEG;
  r.yaw = Math.max(-C.maxYawDeg * DEG, Math.min(C.maxYawDeg * DEG, yaw));
  r.hold = Math.max(C.holdMinSec, 75 / def.rpm);
}

export function recoverRecoil(r: Recoil, def: WeaponDef, dt: number): void {
  if (r.hold > 0) { r.hold -= dt; return; }
  const step = def.recoilRecovery * DEG * dt;
  r.pitch = Math.max(0, r.pitch - step);
  r.yaw = r.yaw > 0 ? Math.max(0, r.yaw - step) : Math.min(0, r.yaw + step);
}
