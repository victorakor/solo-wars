import { NET, PICKUPS, SIM, WEAPONS, type WeaponId } from '../balance';
import { CollisionWorld } from '../collision';
import type { PickupInfo, Roster, RosterEntry, Welcome } from '../protocol';
import { NET_MSG } from '../protocol';
import type { SceneDef } from '../scenes/foundry';
import { CombatSim, type Actor, type ActorInput, type CombatEvent, type Pickup } from '../sim/sim';
import { newWeapon } from '../sim/weapons';
import { ClockSync, LossMeter } from './clock';
import {
  decodeEvents, decodeSnapshot, encodeInputBatch, NO_ACTOR, seqNewer, type WireEvent, type WireInput, type WireItem,
} from './codec';
import { RemoteTrack } from './interpolation';
import { Predictor } from './prediction';
import { weaponFromItem } from './state';

export type NetStatus = 'connecting' | 'connected' | 'reconnecting';

export interface NetClientHooks {
  /** Transport send. Binary payloads are Uint8Array, control payloads are plain objects. */
  send(type: string, payload: Uint8Array | object, reliable: boolean): void;
}

const DT = 1 / SIM.tickHz;
const actorKey = (wireId: number): string => `a${wireId}`;

/** Normalises whatever the transport hands over (Uint8Array, Buffer, ArrayBuffer, number[]) into bytes. */
export function asBytes(data: unknown): Uint8Array | null {
  if (data instanceof Uint8Array) return data;
  if (data instanceof ArrayBuffer) return new Uint8Array(data);
  if (Array.isArray(data) && data.every((n) => typeof n === 'number')) return Uint8Array.from(data as number[]);
  return null;
}

/**
 * Everything a client needs to play on a server-authoritative room, with no DOM and no transport: it is driven
 * by `tick` (60 Hz, local input), `handle` (messages from the server) and `update` (every rendered frame).
 *
 * It keeps a mirror CombatSim with `authority = false`. The local player is stepped by the very same shared code
 * the server runs (prediction); other players are overwritten each frame from interpolated snapshots; floor pickups
 * follow server events. The renderer and HUD read the mirror exactly as they would read a local match.
 */
export class NetClient {
  readonly sim: CombatSim;
  readonly me: Actor;
  readonly predictor: Predictor;
  readonly clock = new ClockSync();
  readonly loss = new LossMeter();
  status: NetStatus = 'connecting';
  matchState: { state: string; who: number; secs: number } = { state: 'waiting', who: 0, secs: 0 };
  /** False until the first snapshot places the local player; draw nothing before that. */
  get ready(): boolean {
    return this.lastOwnTick >= 0;
  }

  /** Wall-clock (client ms) of the newest snapshot. */
  lastSnapshotAt = -1;
  snapshotsReceived = 0;
  bytesIn = 0;
  bytesOut = 0;

  private tracks = new Map<number, RemoteTrack>();
  private byWire = new Map<number, Actor>();
  private recent: WireInput[] = [];
  private ticks = 0;
  private lastOwnTick = -1;
  private nextPing = 0;
  private pingsSent = 0;
  private wireEvents: CombatEvent[] = [];
  private hits = 0;

  constructor(welcome: Welcome, scene: SceneDef, private hooks: NetClientHooks, startNow: number) {
    this.sim = new CombatSim(new CollisionWorld(scene.boxes), scene.spawns, welcome.seed, []);
    this.sim.authority = false;
    for (const r of welcome.roster) this.addRemote(r);
    const me = this.byWire.get(welcome.you);
    if (!me) throw new Error('welcome did not include the local player');
    this.me = me;
    this.predictor = new Predictor(this.sim, me);
    this.setPickups(welcome.pickups);
    this.clock.offsetMs = welcome.serverTime - startNow; // good enough until the first pong
    this.nextPing = startNow;
  }

  get rttMs(): number {
    return this.clock.rttMs;
  }

  get lossPct(): number {
    return this.loss.lossPct;
  }

  /** A warning to show the player, or null. */
  get warning(): 'rtt' | 'loss' | null {
    if (this.clock.ready && this.clock.rttMs > NET.warnRttMs) return 'rtt';
    if (this.loss.lossPct > NET.warnLossPct) return 'loss';
    return null;
  }

  // --- local input (60 Hz) --------------------------------------------------------

  /** Predict one input now and, every other tick (30 Hz), send the last three. */
  tick(raw: ActorInput, now: number): WireInput {
    const p = this.me.body.pos, prev = this.me.prev;
    prev.x = p.x; prev.y = p.y; prev.z = p.z;
    const q = this.predictor.predict(raw);
    this.recent.push(q);
    if (this.recent.length > NET.inputRedundancy) this.recent.shift();
    this.ticks++;
    if (this.ticks % (SIM.tickHz / SIM.inputSendHz) === 0) {
      const buf = encodeInputBatch({ serverTimeEst: Math.max(0, Math.round(this.clock.serverNow(now))), inputs: this.recent.slice() });
      this.bytesOut += buf.length;
      this.hooks.send(NET_MSG.INPUT, buf, false);
    }
    return q;
  }

  // --- messages from the server ---------------------------------------------------

  handle(type: string, data: unknown, now: number): void {
    if (type === NET_MSG.SNAPSHOT) this.onSnapshot(data, now);
    else if (type === NET_MSG.EVENTS) this.onEvents(data);
    else if (type === NET_MSG.PONG) this.onPong(data, now);
    else if (type === NET_MSG.ROSTER) this.applyRoster(data as Roster);
  }

  private onSnapshot(data: unknown, now: number): void {
    const bytes = asBytes(data);
    if (!bytes) return;
    let snap;
    try { snap = decodeSnapshot(bytes); } catch { return; } // a corrupt packet is dropped, never fatal
    this.bytesIn += bytes.length;
    this.loss.onTick(snap.tick);
    this.lastSnapshotAt = now;
    this.snapshotsReceived++;
    for (const a of snap.actors) {
      let t = this.tracks.get(a.id);
      if (!t) { t = new RemoteTrack(); this.tracks.set(a.id, t); }
      t.push(snap.serverTime, a);
    }
    if (snap.own && (this.lastOwnTick < 0 || seqNewer(snap.tick, this.lastOwnTick))) {
      this.lastOwnTick = snap.tick;
      this.predictor.reconcile(snap.ack, snap.own);
    }
    if (this.status !== 'connected') this.status = 'connected';
  }

  private onPong(data: unknown, now: number): void {
    const d = data as { t?: unknown; serverTime?: unknown } | null;
    if (!d || typeof d.t !== 'number' || typeof d.serverTime !== 'number') return;
    this.clock.addSample(d.t, d.serverTime, now);
  }

  private onEvents(data: unknown): void {
    const bytes = asBytes(data);
    if (!bytes) return;
    let events: WireEvent[];
    try { events = decodeEvents(bytes); } catch { return; }
    this.bytesIn += bytes.length;
    for (const e of events) this.applyWireEvent(e);
  }

  private idOf(wire: number): string | null {
    return wire === NO_ACTOR ? null : actorKey(wire);
  }

  private applyWireEvent(e: WireEvent): void {
    const meWire = this.me.index;
    switch (e.t) {
      case 'shot':
        if (e.actor === meWire) break; // our own shots were shown the moment we fired
        this.wireEvents.push({ type: 'shot', actor: actorKey(e.actor), weapon: e.weapon, shotId: e.shotId, origin: e.origin, pellets: e.pellets });
        break;
      case 'hit': {
        this.hits++;
        const w = this.me.rack[this.me.slot];
        this.wireEvents.push({
          type: 'hit', shooter: this.me.id, victim: actorKey(e.victim), weapon: w?.id ?? 'sidearm', damage: e.damage,
          head: e.head, dist: e.dist, falloff: e.falloff, killed: e.killed,
        });
        break;
      }
      case 'dmg':
        this.wireEvents.push({ type: 'damage', victim: this.me.id, attacker: this.idOf(e.attacker), dirX: e.dirX, dirZ: e.dirZ, amount: e.amount });
        break;
      case 'kill':
        this.wireEvents.push({ type: 'kill', killer: this.idOf(e.killer), victim: actorKey(e.victim), weapon: e.weapon, head: e.head });
        break;
      case 'pickup':
        this.wireEvents.push({ type: 'pickup', actor: actorKey(e.actor), weapon: e.weapon, rarity: e.rarity });
        break;
      case 'respawn': {
        this.wireEvents.push({ type: 'respawn', actor: actorKey(e.actor), yaw: e.yaw });
        this.tracks.get(e.actor)?.clear(); // never blend a remote player across its teleport
        break;
      }
      case 'note':
        if (e.actor === meWire && e.kind === 'weaponEmpty') this.wireEvents.push({ type: 'weaponEmpty', actor: this.me.id });
        break;
      case 'stats': {
        const a = this.byWire.get(e.actor);
        if (a) Object.assign(a.stats, e.stats);
        break;
      }
      case 'pad': {
        const p = this.sim.pickups.find((q) => q.id === e.id);
        if (p) p.state = e.item ? weaponFromItem(e.item) : null;
        break;
      }
      case 'drop':
        this.sim.pickups.push(this.makePickup(e.id, 'drop', e.x, e.y, e.z, e.item));
        break;
      case 'dropGone': {
        const i = this.sim.pickups.findIndex((q) => q.id === e.id);
        if (i >= 0) this.sim.pickups.splice(i, 1);
        break;
      }
      case 'match':
        this.matchState = { state: e.state, who: e.who, secs: e.secs };
        break;
    }
  }

  // --- roster and pickups -----------------------------------------------------------

  private addRemote(r: RosterEntry): void {
    if (this.byWire.has(r.id)) return;
    const a = this.sim.addActor({
      id: actorKey(r.id), kind: r.kind, name: r.name, index: r.id, spawn: { x: 0, y: 0, z: 0, yaw: 0 }, loadout: ['sidearm'],
    });
    this.byWire.set(r.id, a);
  }

  applyRoster(r: Roster): void {
    const ids = new Set(r.roster.map((x) => x.id));
    for (const e of r.roster) this.addRemote(e);
    for (const [id, a] of [...this.byWire]) {
      if (ids.has(id) || a === this.me) continue;
      this.sim.removeActor(a.id);
      this.byWire.delete(id);
      this.tracks.delete(id);
    }
  }

  private makePickup(id: number, kind: 'pad' | 'drop', x: number, y: number, z: number, item: WireItem | null): Pickup {
    return {
      id, kind, x, y, z, state: item ? weaponFromItem(item) : null, respawnT: 0,
      despawnT: PICKUPS.dropDespawnSec, pair: -1, cycle: 0, blockIndex: null,
    };
  }

  private setPickups(list: PickupInfo[]): void {
    this.sim.pickups.length = 0;
    for (const p of list) {
      const item = p.item && p.item.weapon in WEAPONS ? { ...p.item, weapon: p.item.weapon as WeaponId } : null;
      this.sim.pickups.push(this.makePickup(p.id, p.kind, p.x, p.y, p.z, item));
    }
  }

  /** After a reconnect the server sends a fresh welcome: drop stale interpolation and pickup state. */
  resync(welcome: Welcome, now: number): void {
    this.applyRoster({ roster: welcome.roster });
    this.setPickups(welcome.pickups);
    for (const t of this.tracks.values()) t.clear();
    this.lastOwnTick = -1;
    this.lastSnapshotAt = now;
    this.status = 'connected';
  }

  // --- per frame ---------------------------------------------------------------------

  /** Server clock (ms) of the moment currently being drawn for remote players. */
  renderTime(now: number): number {
    return this.clock.serverNow(now) - SIM.interpDelayMs;
  }

  update(now: number, dtSec: number): void {
    this.predictor.decay(dtSec);
    this.pingIfDue(now);
    const rt = this.renderTime(now);
    for (const [wire, a] of this.byWire) {
      if (a === this.me) continue;
      const s = this.tracks.get(wire)?.sample(rt);
      if (!s) continue;
      const b = a.body;
      b.pos.x = s.x; b.pos.y = s.y; b.pos.z = s.z; b.vel.x = s.vx; b.vel.y = s.vy; b.vel.z = s.vz;
      a.prev.x = s.x; a.prev.y = s.y; a.prev.z = s.z;
      b.onGround = s.onGround; b.crouched = s.crouched; b.sprinting = s.sprinting; b.stamina = s.stamina;
      b.rollT = s.rolling ? 0.2 : 0;
      const sp = Math.hypot(s.vx, s.vz);
      if (sp > 0.1) { b.rollDirX = s.vx / sp; b.rollDirZ = s.vz / sp; }
      a.view.yaw = s.yaw; a.view.pitch = s.pitch;
      a.hp.hp = s.hp; a.hp.alive = s.alive; a.hp.protectT = s.protectedNow ? 1 : 0;
      const id = s.weapon as WeaponId;
      let w = a.rack[0];
      if (!w || w.id !== id || w.rarity !== s.rarity) { w = newWeapon(id, true, s.rarity); a.rack = [w]; a.slot = 0; }
      w.mag = s.mag; w.reloading = s.reloading; w.adsT = s.ads ? 1 : 0;
    }
    this.updateNearPickup();
    if (this.lastSnapshotAt >= 0) this.status = now - this.lastSnapshotAt > NET.silenceMs ? 'reconnecting' : 'connected';
  }

  private pingIfDue(now: number): void {
    if (now < this.nextPing) return;
    this.hooks.send(NET_MSG.PING, { t: now }, false);
    this.pingsSent++;
    this.nextPing = now + (this.pingsSent < 5 ? 200 : NET.pingIntervalMs); // a quick burst at start to lock the clock
  }

  private updateNearPickup(): void {
    const me = this.me;
    let best: Pickup | null = null, bestD = Infinity;
    for (const p of this.sim.pickups) {
      if (!p.state) continue;
      const d = Math.hypot(p.x - me.body.pos.x, p.z - me.body.pos.z);
      if (d <= PICKUPS.radius && Math.abs(p.y - me.body.pos.y) <= 2 && d < bestD) { best = p; bestD = d; }
    }
    me.nearPickup = me.hp.alive && best ? best.id : null;
  }

  /** Locally predicted events for our own actor, followed by server-confirmed ones (hits, damage, kills, pickups...). */
  drainEvents(): CombatEvent[] {
    const out = this.sim.drainEvents();
    if (this.wireEvents.length) { out.push(...this.wireEvents); this.wireEvents = []; }
    return out;
  }

  /** Delta of one tick, for tests that need the same constant the client predicts with. */
  static readonly DT = DT;
}
