import { RARITY, WEAPONS } from '../balance';
import type { Actor } from '../sim/sim';
import { newWeapon, type WeaponState } from '../sim/weapons';
import type { OwnBody, OwnCombat, OwnWeapon, RemoteState, WireItem } from './codec';

const clamp = (v: number, lo: number, hi: number): number => Math.max(lo, Math.min(hi, v));

/** Server side: the body fields the owner needs to rewind its prediction. */
export function ownBodyOf(a: Actor): OwnBody {
  const b = a.body;
  return {
    pos: { ...b.pos }, vel: { ...b.vel }, onGround: b.onGround, crouched: b.crouched, sprinting: b.sprinting,
    stamina: b.stamina, sinceSprint: b.sinceSprint, sprintRecover: b.sprintRecover,
    rollT: b.rollT, rollCd: b.rollCd, rollDirX: b.rollDirX, rollDirZ: b.rollDirZ,
  };
}

export function ownCombatOf(a: Actor): OwnCombat {
  return {
    hp: a.hp.hp, alive: a.hp.alive, protectT: a.hp.protectT, respawnT: a.hp.respawnT, slot: a.slot, shotCounter: a.shotCounter,
    recoil: { pitch: a.recoil.pitch, yaw: a.recoil.yaw, hold: a.recoil.hold },
    rack: a.rack.map((w) => ({
      id: w.id, rarity: w.rarity, mag: w.mag, magSize: w.magSize, reserve: w.reserve, cooldown: w.cooldown,
      reloading: w.reloading, reloadT: w.reloadT, equipT: w.equipT, adsT: w.adsT, buffer: w.buffer,
    })),
  };
}

/** Client side: overwrite the predicted body with the server's. */
export function applyOwnBody(a: Actor, o: OwnBody): void {
  const b = a.body;
  b.pos.x = o.pos.x; b.pos.y = o.pos.y; b.pos.z = o.pos.z;
  b.vel.x = o.vel.x; b.vel.y = o.vel.y; b.vel.z = o.vel.z;
  b.onGround = o.onGround; b.crouched = o.crouched; b.sprinting = o.sprinting;
  b.stamina = o.stamina; b.sinceSprint = o.sinceSprint; b.sprintRecover = o.sprintRecover;
  b.rollT = o.rollT; b.rollCd = o.rollCd; b.rollDirX = o.rollDirX; b.rollDirZ = o.rollDirZ;
}

export function weaponFromOwn(o: OwnWeapon): WeaponState {
  return {
    id: o.id, mag: o.mag, magSize: o.magSize, rarity: o.rarity, dmgMult: RARITY[o.rarity]?.dmg ?? 1, reserve: o.reserve,
    cooldown: o.cooldown, reloading: o.reloading, reloadT: o.reloadT, equipT: o.equipT, adsT: o.adsT, buffer: o.buffer,
  };
}

export function applyOwnCombat(a: Actor, c: OwnCombat): void {
  a.hp.hp = c.hp; a.hp.alive = c.alive; a.hp.protectT = c.protectT; a.hp.respawnT = c.respawnT;
  a.shotCounter = c.shotCounter;
  a.recoil.pitch = c.recoil.pitch; a.recoil.yaw = c.recoil.yaw; a.recoil.hold = c.recoil.hold;
  a.rack = c.rack.map(weaponFromOwn);
  if (a.rack.length === 0) a.rack = [newWeapon('sidearm', true)]; // never leave the client without a weapon to draw
  a.slot = clamp(c.slot, 0, a.rack.length - 1);
  a.loadout = [a.rack[0]!.id];
}

/** Server side: what other players see of an actor. `slow` adds the rarely-changing fields. */
export function remoteOf(a: Actor, slow: boolean): RemoteState {
  const b = a.body;
  const w = a.rack[a.slot] ?? a.rack[0]!;
  const s: RemoteState = {
    id: a.index, x: b.pos.x, y: b.pos.y, z: b.pos.z, vx: b.vel.x, vy: b.vel.y, vz: b.vel.z, yaw: a.view.yaw, pitch: a.view.pitch,
    onGround: b.onGround, crouched: b.crouched, sprinting: b.sprinting, rolling: b.rollT > 0, alive: a.hp.alive,
    reloading: w.reloading, ads: w.adsT > 0.5, protectedNow: a.hp.protectT > 0,
  };
  if (slow) { s.hp = a.hp.hp; s.weapon = w.id; s.rarity = w.rarity; s.mag = w.mag; s.stamina = b.stamina; }
  return s;
}

/** Floor weapon state for a pickup the client mirrors. */
export function weaponFromItem(it: WireItem): WeaponState {
  const w = newWeapon(it.weapon, false, it.rarity);
  w.mag = it.mag;
  w.reserve = it.reserve;
  return w;
}

export const itemOf = (w: WeaponState): WireItem => ({ weapon: w.id, rarity: w.rarity, mag: w.mag, reserve: w.reserve });

/** Display name helper used by tests and logs. */
export const weaponName = (id: string): string => (id in WEAPONS ? WEAPONS[id as keyof typeof WEAPONS].name : id);
