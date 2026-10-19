import { COMBAT, TRAINING_RACK, WEAPONS, type WeaponId } from '../balance';
import type { CollisionWorld, Vec3 } from '../collision';
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
  aimYaw?: number;
  aimPitch?: number;
}

export const idleInput = (): ActorInput => ({
  moveX: 0, moveZ: 0, yaw: 0, pitch: 0, jump: false, sprint: false, crouch: false, dodge: false, ads: false,
  fire: false, firePressed: false, reload: false, slot: null,
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
  | { type: 'dry' | 'reloadStart' | 'reloadDone' | 'equip'; actor: string }
  | { type: 'respawn'; actor: string; yaw: number };

const clamp = (v: number, lo: number, hi: number): number => Math.max(lo, Math.min(hi, v));

/** Deterministic combat world: movement, weapons, damage, death and respawn for any number of actors. */
export class CombatSim {
  readonly actors: Actor[] = [];
  time = 0;
  private events: CombatEvent[] = [];
  private nextIndex = 0;

  constructor(
    readonly world: CollisionWorld,
    readonly spawns: readonly SpawnPoint[],
    readonly seed: number,
  ) {}

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

  /** Refills ammo on every weapon; `infinite` switches between unlimited and floor-pickup reserves. */
  restock(a: Actor, infinite: boolean): void {
    a.infiniteReserve = infinite;
    a.rack = a.loadout.map((id) => newWeapon(id, infinite));
    a.slot = 0;
    resetRecoil(a.recoil);
  }

  /** Brings a dead or alive actor back at full health at the given spawn. */
  private resetActor(a: Actor, spawn: SpawnPoint): void {
    a.body = newPlayer(spawn.x, spawn.y + 0.05, spawn.z);
    a.prev.x = a.body.pos.x; a.prev.y = a.body.pos.y; a.prev.z = a.body.pos.z;
    a.hp = newHealth(a.kind === 'dummy' ? 0 : COMBAT.spawnProtectSec);
    a.rack = a.loadout.map((id) => newWeapon(id, a.infiniteReserve));
    a.slot = 0;
    resetRecoil(a.recoil);
    a.view.yaw = spawn.yaw; a.view.pitch = 0;
  }

  step(dt: number, inputs: ReadonlyMap<string, ActorInput>): void {
    this.time += dt;
    for (const a of this.actors) { a.prev.x = a.body.pos.x; a.prev.y = a.body.pos.y; a.prev.z = a.body.pos.z; }
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
      this.world, def, { origin, yaw, pitch, spreadDeg: spread, seed: this.seed, shotId, salt: a.index },
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
