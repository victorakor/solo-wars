import { COMBAT, PICKUPS, RARITY, TRAINING_RACK, WEAPONS, type WeaponId } from '../balance';
import type { CollisionWorld, Vec3 } from '../collision';
import type { PadDef } from '../scenes/foundry';
import {
  canShoot, eyeHeightOf, heightOf, newPlayer, stepPlayer, type MoveInput, type PlayerState,
} from '../movement';
import {
  applyDamage, creditKiller, forceKill, newHealth, newStats, pickSpawn, type Health, type SpawnPoint, type Stats,
} from './combat';
import type { HitTarget } from './hitboxes';
import { resolveShot, type PelletKind } from './hitscan';
import { shotRng } from './rng';
import {
  cancelReload, currentSpreadDeg, equipWeapon, kickRecoil, motionOf, newRecoil, newWeapon, recoverRecoil,
  resetRecoil, startReload, stepHolstered, stepWeapon, tryFire, type Recoil, type WeaponState,
} from './weapons';

export type ActorKind = 'player' | 'bot' | 'dummy';

/**
 * One tick of intent for any actor, human or bot (spec 17: bots use the same input pipeline).
 * `yaw`/`pitch` are the raw look angles without recoil. `aimYaw`/`aimPitch`, when present, are the
 * raw angles to fire along (camera convergence) and default to `yaw`/`pitch`.
 */
export interface ActorInput extends MoveInput {
  fire: boolean;
  firePressed: boolean;
  reload: boolean;
  /** Rack index to switch to, or null. */
  slot: number | null;
  /** E: swap with the pickup you are standing on (walking over one into an empty slot is automatic). */
  interact: boolean;
  /** X: drop the floor weapon. */
  drop: boolean;
  aimYaw?: number;
  aimPitch?: number;
}

export const idleInput = (): ActorInput => ({
  moveX: 0, moveZ: 0, yaw: 0, pitch: 0, jump: false, sprint: false, crouch: false, dodge: false, ads: false,
  fire: false, firePressed: false, reload: false, slot: null, interact: false, drop: false,
});
const IDLE_INPUT: Readonly<ActorInput> = Object.freeze(idleInput());

export interface ActorOptions {
  id: string;
  kind: ActorKind;
  name: string;
  spawn: SpawnPoint;
  /** Weapon rack, first entry equipped. Defaults to the full training rack. */
  loadout?: readonly WeaponId[];
  infiniteReserve?: boolean;
}

export interface Actor {
  id: string;
  kind: ActorKind;
  name: string;
  /** Unique per sim; used to separate rng streams between shooters. */
  index: number;
  body: PlayerState;
  /** Feet position at the start of the last tick, for render interpolation. */
  prev: Vec3;
  hp: Health;
  stats: Stats;
  rack: WeaponState[];
  slot: number;
  recoil: Recoil;
  shotCounter: number;
  /** Last raw look angles received. */
  view: { yaw: number; pitch: number };
  home: SpawnPoint;
  loadout: readonly WeaponId[];
  infiniteReserve: boolean;
  scratch: MoveInput;
  /** Short lockout after a pickup, swap or drop. */
  pickupCd: number;
  /** Id of the pickup in reach right now (for the HUD prompt), or null. */
  nearPickup: number | null;
}

/** Index of the floor-weapon slot if one is held, else -1. Slots before it are the permanent loadout. */
export const floorSlot = (a: Actor): number => (a.rack.length > a.loadout.length ? a.loadout.length : -1);

/** A weapon lying on the floor: a pad (respawns) or a drop (despawns). `state` is null while a pad is empty. */
export interface Pickup {
  id: number;
  kind: 'pad' | 'drop';
  x: number; y: number; z: number;
  state: WeaponState | null;
  /** Pads: seconds until the next roll appears. */
  respawnT: number;
  /** Drops: seconds until it despawns. */
  despawnT: number;
  /** Mirrored pads share a pair and so roll the same item. -1 for drops. */
  pair: number;
  cycle: number;
  /** The actor index that just dropped this and must walk away before it can take it back. */
  blockIndex: number | null;
}

/** Seeded pad roll: weapon uniform over the firearms, rarity 60/30/10. Same (seed, pair, cycle) gives the same item. */
export function rollPad(seed: number, pair: number, cycle: number): { id: WeaponId; rarity: number } {
  const rng = shotRng(seed, pair * 1000 + cycle, 0x70ad);
  const id = TRAINING_RACK[Math.floor(rng() * TRAINING_RACK.length)]!;
  let r = rng() * 100, rarity = RARITY.length - 1;
  for (let i = 0; i < RARITY.length; i++) {
    if (r < RARITY[i]!.weight) { rarity = i; break; }
    r -= RARITY[i]!.weight;
  }
  return { id, rarity };
}

export interface PelletEvent {
  point: Vec3;
  kind: PelletKind;
}

export type CombatEvent =
  | { type: 'shot'; actor: string; weapon: WeaponId; origin: Vec3; pellets: PelletEvent[] }
  | {
      type: 'hit'; shooter: string; victim: string; weapon: WeaponId; damage: number; head: boolean;
      dist: number; falloff: number; killed: boolean;
    }
  | { type: 'damage'; victim: string; attacker: string | null; /** Horizontal unit vector from victim towards attacker. */ dirX: number; dirZ: number; amount: number }
  | { type: 'kill'; killer: string | null; victim: string; weapon: WeaponId | null; head: boolean }
  | { type: 'dry' | 'reloadStart' | 'reloadDone' | 'equip' | 'weaponEmpty'; actor: string }
  | { type: 'pickup'; actor: string; weapon: WeaponId; rarity: number }
  | { type: 'respawn'; actor: string; yaw: number };

const clamp = (v: number, lo: number, hi: number): number => Math.max(lo, Math.min(hi, v));

/** Deterministic combat world: movement, weapons, damage, death and respawn for any number of actors. */
export class CombatSim {
  readonly actors: Actor[] = [];
  time = 0;
  readonly pickups: Pickup[] = [];
  private events: CombatEvent[] = [];
  private nextIndex = 0;
  private nextPickupId = 0;

  constructor(
    readonly world: CollisionWorld,
    readonly spawns: readonly SpawnPoint[],
    readonly seed: number,
    pads: readonly PadDef[] = [],
  ) {
    for (const p of pads)
      this.pickups.push({
        id: this.nextPickupId++, kind: 'pad', x: p.x, y: p.y, z: p.z, state: null,
        respawnT: PICKUPS.firstSpawnSec, despawnT: 0, pair: p.pair, cycle: 0, blockIndex: null,
      });
  }

  addActor(o: ActorOptions): Actor {
    const loadout = o.loadout && o.loadout.length > 0 ? o.loadout : o.kind === 'dummy' ? (['sidearm'] as const) : TRAINING_RACK;
    const infinite = o.infiniteReserve ?? true;
    const a: Actor = {
      id: o.id, kind: o.kind, name: o.name, index: this.nextIndex++,
      body: newPlayer(o.spawn.x, o.spawn.y + 0.05, o.spawn.z),
      prev: { x: o.spawn.x, y: o.spawn.y + 0.05, z: o.spawn.z },
      hp: newHealth(o.kind === 'dummy' ? 0 : COMBAT.spawnProtectSec),
      stats: newStats(),
      rack: loadout.map((id) => newWeapon(id, infinite)),
      slot: 0, recoil: newRecoil(), shotCounter: 0,
      view: { yaw: o.spawn.yaw, pitch: 0 },
      home: o.spawn, loadout, infiniteReserve: infinite,
      scratch: { moveX: 0, moveZ: 0, yaw: 0, pitch: 0, jump: false, sprint: false, crouch: false, dodge: false, ads: false },
      pickupCd: 0, nearPickup: null,
    };
    this.actors.push(a);
    return a;
  }

  removeActor(id: string): void {
    const i = this.actors.findIndex((a) => a.id === id);
    if (i >= 0) this.actors.splice(i, 1);
  }

  actor(id: string): Actor | undefined {
    return this.actors.find((a) => a.id === id);
  }

  hitTarget(a: Actor): HitTarget {
    return { id: a.id, pos: a.body.pos, height: heightOf(a.body), eye: eyeHeightOf(a.body), alive: a.hp.alive };
  }

  /** Everything `except` could shoot at. */
  targetsFor(except: Actor | null): HitTarget[] {
    const out: HitTarget[] = [];
    for (const a of this.actors) if (a !== except && a.hp.alive) out.push(this.hitTarget(a));
    return out;
  }

  /** Returns and clears the events produced since the last call. */
  drainEvents(): CombatEvent[] {
    const e = this.events;
    this.events = [];
    return e;
  }

  /** Brings a dead or alive actor back at full health at the given spawn. */
  private resetActor(a: Actor, spawn: SpawnPoint): void {
    a.body = newPlayer(spawn.x, spawn.y + 0.05, spawn.z);
    a.prev.x = a.body.pos.x; a.prev.y = a.body.pos.y; a.prev.z = a.body.pos.z;
    a.hp = newHealth(a.kind === 'dummy' ? 0 : COMBAT.spawnProtectSec);
    a.rack = a.loadout.map((id) => newWeapon(id, a.infiniteReserve));
    a.slot = 0;
    resetRecoil(a.recoil);
    a.pickupCd = 0; a.nearPickup = null;
    a.view.yaw = spawn.yaw; a.view.pitch = 0;
  }

  step(dt: number, inputs: ReadonlyMap<string, ActorInput>): void {
    this.time += dt;
    for (const a of this.actors) { a.prev.x = a.body.pos.x; a.prev.y = a.body.pos.y; a.prev.z = a.body.pos.z; }
    this.tickPickups(dt);
    for (const a of this.actors) {
      if (!a.hp.alive) {
        a.hp.respawnT -= dt;
        if (a.hp.respawnT <= 0) this.respawn(a);
        continue;
      }
      this.stepAlive(a, inputs.get(a.id) ?? IDLE_INPUT, dt);
    }
  }

  private respawn(a: Actor): void {
    let spawn = a.home;
    if (a.kind !== 'dummy') {
      const eyes: Vec3[] = [];
      for (const o of this.actors)
        if (o !== a && o.kind !== 'dummy' && o.hp.alive)
          eyes.push({ x: o.body.pos.x, y: o.body.pos.y + eyeHeightOf(o.body), z: o.body.pos.z });
      spawn = pickSpawn(this.world, this.spawns, eyes);
    }
    this.resetActor(a, spawn);
    this.events.push({ type: 'respawn', actor: a.id, yaw: spawn.yaw });
  }

  private stepAlive(a: Actor, inp: Readonly<ActorInput>, dt: number): void {
    if (a.kind === 'dummy') { // dummies only settle onto the floor and take damage
      stepPlayer(a.body, a.scratch, dt, this.world);
      return;
    }
    if (inp.slot !== null && inp.slot !== a.slot && inp.slot >= 0 && inp.slot < a.rack.length) {
      a.slot = inp.slot;
      const next = a.rack[a.slot]!;
      equipWeapon(next, WEAPONS[next.id]);
      this.events.push({ type: 'equip', actor: a.id });
    }
    const ws = a.rack[a.slot]!;
    const def = WEAPONS[ws.id];

    const m = a.scratch;
    m.moveX = inp.moveX; m.moveZ = inp.moveZ; m.yaw = inp.yaw; m.pitch = inp.pitch;
    m.jump = inp.jump; m.sprint = inp.sprint; m.crouch = inp.crouch; m.dodge = inp.dodge; m.ads = inp.ads;
    m.speedMult = def.moveSpeedMult;
    stepPlayer(a.body, m, dt, this.world);
    a.view.yaw = inp.yaw; a.view.pitch = inp.pitch;

    if (a.body.pos.y < COMBAT.killY) {
      forceKill(a.hp);
      this.registerKill(a, null, null, false);
      return;
    }

    for (let i = 0; i < a.rack.length; i++) if (i !== a.slot) stepHolstered(a.rack[i]!, dt);
    const ev = stepWeapon(ws, def, dt, inp.ads && canShoot(a.body));
    if (ev === 'reloadDone') this.events.push({ type: 'reloadDone', actor: a.id });
    recoverRecoil(a.recoil, def, dt);
    if (a.hp.protectT > 0) a.hp.protectT = Math.max(0, a.hp.protectT - dt);

    if (inp.reload && startReload(ws, def)) this.events.push({ type: 'reloadStart', actor: a.id });

    const fr = tryFire(ws, def, inp.firePressed, inp.fire, canShoot(a.body));
    if (fr === 'dry') {
      this.events.push({ type: 'dry', actor: a.id });
      if (ws.reloading) this.events.push({ type: 'reloadStart', actor: a.id });
    } else if (fr === 'fired') this.fire(a, ws, inp);

    this.stepPickups(a, inp, dt);
    this.reapEmptyFloorWeapon(a);
  }

  private tickPickups(dt: number): void {
    for (let i = this.pickups.length - 1; i >= 0; i--) {
      const p = this.pickups[i]!;
      if (p.kind === 'drop') {
        p.despawnT -= dt;
        if (p.despawnT <= 0) this.pickups.splice(i, 1);
      } else if (p.state === null) {
        p.respawnT -= dt;
        if (p.respawnT <= 0) {
          const r = rollPad(this.seed, p.pair, p.cycle);
          p.state = newWeapon(r.id, false, r.rarity);
        }
      }
    }
  }

  /** Walk-over pickup into an empty floor slot, E to swap when occupied, X to drop. */
  private stepPickups(a: Actor, inp: Readonly<ActorInput>, dt: number): void {
    a.pickupCd = Math.max(0, a.pickupCd - dt);
    const idx = a.loadout.length;
    if (inp.drop && a.pickupCd <= 0 && a.rack.length > idx) {
      const w = a.rack.splice(idx, 1)[0]!;
      if (a.slot >= idx) { a.slot = 0; equipWeapon(a.rack[0]!, WEAPONS[a.rack[0]!.id]); }
      this.dropWeapon(a, w, true);
      a.pickupCd = PICKUPS.cooldownSec;
    }
    a.nearPickup = null;
    let best: Pickup | null = null, bestD = Infinity;
    for (const p of this.pickups) {
      if (!p.state) continue;
      const d = Math.hypot(p.x - a.body.pos.x, p.z - a.body.pos.z);
      if (p.blockIndex === a.index) { if (d > PICKUPS.radius) p.blockIndex = null; else continue; }
      if (d <= PICKUPS.radius && Math.abs(p.y - a.body.pos.y) <= 2 && d < bestD) { best = p; bestD = d; }
    }
    if (!best) return;
    a.nearPickup = best.id;
    if (a.pickupCd > 0) return;
    if (a.rack.length <= idx) this.takePickup(a, best);
    else if (inp.interact) {
      const old = a.rack[idx]!;
      this.takePickup(a, best);
      this.dropWeapon(a, old, true);
    }
  }

  private takePickup(a: Actor, p: Pickup): void {
    const ws = p.state!;
    p.state = null;
    if (p.kind === 'pad') { p.respawnT = PICKUPS.padRespawnSec; p.cycle++; }
    else this.pickups.splice(this.pickups.indexOf(p), 1);
    const idx = a.loadout.length;
    a.rack[idx] = ws;
    a.slot = idx;
    equipWeapon(ws, WEAPONS[ws.id]);
    a.stats.pickups++;
    a.pickupCd = PICKUPS.cooldownSec;
    this.events.push({ type: 'pickup', actor: a.id, weapon: ws.id, rarity: ws.rarity });
  }

  private dropWeapon(a: Actor, ws: WeaponState, blockOwner: boolean): void {
    cancelReload(ws); ws.adsT = 0; ws.buffer = 0;
    const drops = this.pickups.filter((p) => p.kind === 'drop');
    if (drops.length >= PICKUPS.maxDrops) this.pickups.splice(this.pickups.indexOf(drops[0]!), 1);
    this.pickups.push({
      id: this.nextPickupId++, kind: 'drop', x: a.body.pos.x, y: a.body.pos.y, z: a.body.pos.z, state: ws,
      respawnT: 0, despawnT: PICKUPS.dropDespawnSec, pair: -1, cycle: 0, blockIndex: blockOwner ? a.index : null,
    });
  }

  /** A floor weapon with an empty magazine and no reserve disappears and you fall back to your loadout weapon. */
  private reapEmptyFloorWeapon(a: Actor): void {
    const idx = a.loadout.length;
    const f = a.rack[idx];
    if (!f || f.mag > 0 || f.reserve > 0) return;
    a.rack.splice(idx, 1);
    if (a.slot >= idx) { a.slot = 0; equipWeapon(a.rack[0]!, WEAPONS[a.rack[0]!.id]); }
    this.events.push({ type: 'weaponEmpty', actor: a.id });
  }

  private fire(a: Actor, ws: WeaponState, inp: Readonly<ActorInput>): void {
    const def = WEAPONS[ws.id];
    a.hp.protectT = 0; // firing ends spawn protection
    a.shotCounter++;
    const shotId = a.shotCounter;
    const yaw = (inp.aimYaw ?? inp.yaw) + a.recoil.yaw;
    const pitch = clamp((inp.aimPitch ?? inp.pitch) + a.recoil.pitch, -1.5, 1.5);
    const origin = { x: a.body.pos.x, y: a.body.pos.y + eyeHeightOf(a.body), z: a.body.pos.z };
    const spread = currentSpreadDeg(def, ws.adsT, motionOf(a.body));
    const res = resolveShot(
      this.world, def, { origin, yaw, pitch, spreadDeg: spread, seed: this.seed, shotId, salt: a.index, damageMult: ws.dmgMult },
      this.targetsFor(a),
    );
    a.stats.shotsFired++;

    // one hit event per victim per trigger pull (shotgun pellets are summed)
    const groups = new Map<string, { damage: number; head: boolean; dist: number; falloff: number }>();
    for (const p of res.pellets) {
      if (p.targetId === null) continue;
      const g = groups.get(p.targetId);
      if (g) { g.damage += p.damage; g.head ||= p.kind === 'head'; if (p.dist < g.dist) { g.dist = p.dist; g.falloff = p.falloff; } }
      else groups.set(p.targetId, { damage: p.damage, head: p.kind === 'head', dist: p.dist, falloff: p.falloff });
    }
    this.events.push({ type: 'shot', actor: a.id, weapon: def.id, origin, pellets: res.pellets.map((p) => ({ point: p.point, kind: p.kind })) });
    let anyHead = false;
    for (const [victimId, g] of groups) {
      const v = this.actor(victimId);
      if (!v) continue;
      const out = applyDamage(v.hp, g.damage, a.id, this.time);
      a.stats.damageDealt += out.dealt;
      v.stats.damageTaken += out.dealt;
      anyHead ||= g.head;
      this.events.push({
        type: 'hit', shooter: a.id, victim: v.id, weapon: def.id, damage: out.dealt, head: g.head,
        dist: g.dist, falloff: g.falloff, killed: out.killed,
      });
      if (out.dealt > 0) {
        const dx = a.body.pos.x - v.body.pos.x, dz = a.body.pos.z - v.body.pos.z, len = Math.hypot(dx, dz) || 1;
        this.events.push({ type: 'damage', victim: v.id, attacker: a.id, dirX: dx / len, dirZ: dz / len, amount: out.dealt });
      }
      if (out.killed) this.registerKill(v, a, def.id, g.head);
    }
    if (groups.size > 0) a.stats.shotsHit++;
    if (anyHead) a.stats.headshots++;
    kickRecoil(a.recoil, def, shotRng(this.seed, shotId, a.index * 2 + 1));
  }

  private registerKill(victim: Actor, direct: Actor | null, weapon: WeaponId | null, head: boolean): void {
    victim.stats.deaths++;
    victim.stats.streak = 0;
    for (const w of victim.rack) { cancelReload(w); w.adsT = 0; }
    const fi = victim.loadout.length;
    if (PICKUPS.dropOnDeath && victim.rack.length > fi) this.dropWeapon(victim, victim.rack.splice(fi, 1)[0]!, false);
    resetRecoil(victim.recoil);
    const killerId = creditKiller(victim.hp, direct?.id ?? null, this.time);
    const killer = killerId === null ? undefined : this.actor(killerId);
    if (killer && killer !== victim) {
      killer.stats.kills++;
      killer.stats.streak++;
      killer.stats.bestStreak = Math.max(killer.stats.bestStreak, killer.stats.streak);
    }
    this.events.push({ type: 'kill', killer: killer?.id ?? null, victim: victim.id, weapon, head });
  }
}
