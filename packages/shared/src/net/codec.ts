import { WEAPONS, type WeaponId } from '../balance';
import type { Vec3 } from '../collision';
import type { PelletKind } from '../sim/hitscan';
import type { ActorInput } from '../sim/sim';

/** Binary wire format (see docs/PROTOCOL.md). Little-endian. Every decoder bounds-checks and throws CodecError. */
export class CodecError extends Error {}

const TAU = Math.PI * 2;
const clamp = (v: number, lo: number, hi: number): number => Math.max(lo, Math.min(hi, v));
const wrapPi = (a: number): number => Math.atan2(Math.sin(a), Math.cos(a));

export const MSG_TYPE = { INPUT: 1, SNAPSHOT: 2, EVENTS: 3 } as const;
export const NO_ACTOR = 0xff;

// --- byte io ----------------------------------------------------------------

class Writer {
  private buf = new Uint8Array(256);
  private dv = new DataView(this.buf.buffer);
  private o = 0;
  private ensure(n: number): void {
    if (this.o + n <= this.buf.length) return;
    const nb = new Uint8Array(Math.max(this.buf.length * 2, this.o + n));
    nb.set(this.buf);
    this.buf = nb;
    this.dv = new DataView(nb.buffer);
  }
  u8(v: number): void { this.ensure(1); this.dv.setUint8(this.o, v); this.o += 1; }
  i8(v: number): void { this.ensure(1); this.dv.setInt8(this.o, v); this.o += 1; }
  u16(v: number): void { this.ensure(2); this.dv.setUint16(this.o, v, true); this.o += 2; }
  i16(v: number): void { this.ensure(2); this.dv.setInt16(this.o, v, true); this.o += 2; }
  u32(v: number): void { this.ensure(4); this.dv.setUint32(this.o, v >>> 0, true); this.o += 4; }
  f32(v: number): void { this.ensure(4); this.dv.setFloat32(this.o, v, true); this.o += 4; }
  finish(): Uint8Array { return this.buf.slice(0, this.o); }
}

class Reader {
  private dv: DataView;
  private o = 0;
  constructor(private b: Uint8Array) { this.dv = new DataView(b.buffer, b.byteOffset, b.byteLength); }
  private need(n: number): void { if (this.o + n > this.b.byteLength) throw new CodecError('truncated message'); }
  u8(): number { this.need(1); const v = this.dv.getUint8(this.o); this.o += 1; return v; }
  i8(): number { this.need(1); const v = this.dv.getInt8(this.o); this.o += 1; return v; }
  u16(): number { this.need(2); const v = this.dv.getUint16(this.o, true); this.o += 2; return v; }
  i16(): number { this.need(2); const v = this.dv.getInt16(this.o, true); this.o += 2; return v; }
  u32(): number { this.need(4); const v = this.dv.getUint32(this.o, true); this.o += 4; return v; }
  f32(): number {
    this.need(4);
    const v = this.dv.getFloat32(this.o, true);
    this.o += 4;
    if (!Number.isFinite(v)) throw new CodecError('non-finite float');
    return v;
  }
  done(): void { if (this.o !== this.b.byteLength) throw new CodecError('trailing bytes'); }
}

// --- ids and sequence numbers -------------------------------------------------

export const WEAPON_ORDER = Object.keys(WEAPONS) as WeaponId[];
export const weaponCode = (id: WeaponId): number => WEAPON_ORDER.indexOf(id);
export function weaponFromCode(c: number): WeaponId {
  const id = WEAPON_ORDER[c];
  if (!id) throw new CodecError(`bad weapon code ${c}`);
  return id;
}

/** True when 16-bit sequence number `a` is newer than `b` (wraparound safe). */
export const seqNewer = (a: number, b: number): boolean => a !== b && ((a - b) & 0xffff) < 0x8000;

// --- quantisation (shared: the client predicts with exactly the values the server will decode) -----

const qYaw = (y: number): number => { let w = y % TAU; if (w < 0) w += TAU; return Math.round((w / TAU) * 65536) & 0xffff; };
const dqYaw = (u: number): number => (u / 65536) * TAU;
const qPitch = (p: number): number => Math.round((clamp(p, -Math.PI / 2, Math.PI / 2) / (Math.PI / 2)) * 32767);
// `+ 0` turns -0 into +0 so the client's quantised value is bit-identical to what the server decodes
const dqPitch = (i: number): number => (i / 32767) * (Math.PI / 2) + 0;
const qMove = (v: number): number => Math.round(clamp(v, -1, 1) * 127);
const dqMove = (i: number): number => i / 127 + 0;
// Aim deltas (how far the converged aim is from the view) are small, so they pack into 12 bits each: +-0.6 rad
// in steps of 0.017 degrees, which is under 6 cm at 200 m.
const AIM_RANGE = 0.6;
const qDelta = (d: number): number => Math.round((clamp(d, -AIM_RANGE, AIM_RANGE) / AIM_RANGE) * 2047);
const dqDelta = (i: number): number => (i / 2047) * AIM_RANGE + 0;

/** One input as sent over the wire: sequence number plus the action flags and quantised aim. */
export interface WireInput extends ActorInput {
  seq: number;
}

const F = {
  jump: 1 << 0, sprint: 1 << 1, crouch: 1 << 2, dodge: 1 << 3, ads: 1 << 4, fire: 1 << 5, firePressed: 1 << 6,
  reload: 1 << 7, interact: 1 << 8, drop: 1 << 9, hasAim: 1 << 10, hasSlot: 1 << 11,
} as const;

/**
 * Rounds an input to what survives the wire. The client must simulate with the returned value (not the
 * raw one) so its prediction matches what the server decodes bit for bit.
 */
export function quantizeInput(inp: ActorInput, seq: number): WireInput {
  const yaw = dqYaw(qYaw(inp.yaw));
  const pitch = dqPitch(qPitch(inp.pitch));
  const out: WireInput = {
    seq: seq & 0xffff,
    moveX: dqMove(qMove(inp.moveX)), moveZ: dqMove(qMove(inp.moveZ)), yaw, pitch,
    jump: inp.jump, sprint: inp.sprint, crouch: inp.crouch, dodge: inp.dodge, ads: inp.ads,
    fire: inp.fire, firePressed: inp.firePressed, reload: inp.reload, interact: inp.interact, drop: inp.drop,
    slot: inp.slot !== null && inp.slot >= 0 && inp.slot <= 7 ? Math.floor(inp.slot) : null,
  };
  // aim only matters on the tick a shot leaves the barrel, so it is only sent with inputs that pull the trigger
  if ((inp.fire || inp.firePressed) && inp.aimYaw !== undefined && inp.aimPitch !== undefined) {
    out.aimYaw = yaw + dqDelta(qDelta(wrapPi(inp.aimYaw - inp.yaw)));
    out.aimPitch = pitch + dqDelta(qDelta(inp.aimPitch - inp.pitch));
  }
  return out;
}

/** Writes two signed 12-bit values into 3 bytes. */
function write12x2(w: Writer, a: number, b: number): void {
  const x = a & 0xfff, y = b & 0xfff;
  w.u8(x & 0xff); w.u8(((x >> 8) & 0xf) | ((y & 0xf) << 4)); w.u8((y >> 4) & 0xff);
}
function read12x2(r: Reader): [number, number] {
  const b0 = r.u8(), b1 = r.u8(), b2 = r.u8();
  const x = b0 | ((b1 & 0xf) << 8), y = ((b1 >> 4) & 0xf) | (b2 << 4);
  return [x >= 0x800 ? x - 0x1000 : x, y >= 0x800 ? y - 0x1000 : y];
}

function writeInput(w: Writer, i: WireInput): void {
  const hasAim = i.aimYaw !== undefined && i.aimPitch !== undefined;
  let f = 0;
  if (i.jump) f |= F.jump;
  if (i.sprint) f |= F.sprint;
  if (i.crouch) f |= F.crouch;
  if (i.dodge) f |= F.dodge;
  if (i.ads) f |= F.ads;
  if (i.fire) f |= F.fire;
  if (i.firePressed) f |= F.firePressed;
  if (i.reload) f |= F.reload;
  if (i.interact) f |= F.interact;
  if (i.drop) f |= F.drop;
  if (hasAim) f |= F.hasAim;
  if (i.slot !== null) f |= F.hasSlot | ((i.slot & 7) << 12);
  w.u16(f);
  w.i8(qMove(i.moveX)); w.i8(qMove(i.moveZ));
  w.u16(qYaw(i.yaw)); w.i16(qPitch(i.pitch));
  if (hasAim) write12x2(w, qDelta(wrapPi((i.aimYaw as number) - i.yaw)), qDelta((i.aimPitch as number) - i.pitch));
}

function readInput(r: Reader, seq: number): WireInput {
  const f = r.u16();
  const moveX = dqMove(r.i8()), moveZ = dqMove(r.i8());
  const yaw = dqYaw(r.u16()), pitch = dqPitch(r.i16());
  const out: WireInput = {
    seq, moveX, moveZ, yaw, pitch,
    jump: (f & F.jump) !== 0, sprint: (f & F.sprint) !== 0, crouch: (f & F.crouch) !== 0, dodge: (f & F.dodge) !== 0,
    ads: (f & F.ads) !== 0, fire: (f & F.fire) !== 0, firePressed: (f & F.firePressed) !== 0,
    reload: (f & F.reload) !== 0, interact: (f & F.interact) !== 0, drop: (f & F.drop) !== 0,
    slot: (f & F.hasSlot) !== 0 ? (f >> 12) & 7 : null,
  };
  if ((f & F.hasAim) !== 0) {
    const [ay, ap] = read12x2(r);
    out.aimYaw = yaw + dqDelta(ay);
    out.aimPitch = pitch + dqDelta(ap);
  }
  return out;
}

export interface InputBatch {
  /** Low 16 bits of the client's estimate of the server clock (ms) when its newest input was sampled. */
  serverTimeLow: number;
  /** Oldest first, with consecutive sequence numbers. */
  inputs: WireInput[];
}

export const MAX_BATCH_INPUTS = 5;

/** The sequence number after `s`: 16-bit, and 0 is never used (it means "nothing acknowledged yet"). */
export const nextSeq = (s: number): number => (s >= 0xffff ? 1 : s + 1);

/**
 * `serverTimeEst` is the full estimate in ms; only its low 16 bits travel. The server resolves them against its own
 * clock, which is unambiguous as long as the estimate is within 32 s of the truth.
 */
export function encodeInputBatch(b: { serverTimeEst: number; inputs: WireInput[] }): Uint8Array {
  if (b.inputs.length < 1 || b.inputs.length > MAX_BATCH_INPUTS) throw new CodecError('bad input count');
  for (let k = 1; k < b.inputs.length; k++)
    if (b.inputs[k]!.seq !== nextSeq(b.inputs[k - 1]!.seq)) throw new CodecError('input sequence numbers must be consecutive');
  const w = new Writer();
  w.u8(MSG_TYPE.INPUT); w.u8(b.inputs.length); w.u16(Math.round(b.serverTimeEst) & 0xffff); w.u16(b.inputs[0]!.seq);
  for (const i of b.inputs) writeInput(w, i);
  return w.finish();
}

export function decodeInputBatch(buf: Uint8Array): InputBatch {
  const r = new Reader(buf);
  if (r.u8() !== MSG_TYPE.INPUT) throw new CodecError('not an input batch');
  const n = r.u8();
  if (n < 1 || n > MAX_BATCH_INPUTS) throw new CodecError('bad input count');
  const serverTimeLow = r.u16();
  let seq = r.u16();
  if (seq === 0) throw new CodecError('sequence number 0 is reserved');
  const inputs: WireInput[] = [];
  for (let k = 0; k < n; k++) {
    inputs.push(readInput(r, seq));
    seq = nextSeq(seq);
  }
  r.done();
  return { serverTimeLow, inputs };
}

/** Turns the 16 bits a client sent back into a full server-clock time, choosing the value nearest `serverNow`. */
export function resolveClientTime(low16: number, serverNow: number): number {
  const diff = ((((low16 - (Math.round(serverNow) & 0xffff)) & 0xffff) + 0x8000) & 0xffff) - 0x8000;
  return serverNow + diff;
}

// --- snapshots ---------------------------------------------------------------------

/** Everything the owner needs to reset its predicted body to the server's state. */
export interface OwnBody {
  pos: Vec3; vel: Vec3;
  onGround: boolean; crouched: boolean; sprinting: boolean;
  stamina: number; sinceSprint: number; sprintRecover: number;
  rollT: number; rollCd: number; rollDirX: number; rollDirZ: number;
}

export interface OwnWeapon {
  id: WeaponId; rarity: number; mag: number; magSize: number;
  /** Infinity for unlimited. */
  reserve: number;
  cooldown: number; reloading: boolean; reloadT: number; equipT: number; adsT: number; buffer: number;
}

export interface OwnCombat {
  /** Health 0..100. */
  hp: number; alive: boolean; protectT: number; respawnT: number;
  slot: number; shotCounter: number;
  recoil: { pitch: number; yaw: number; hold: number };
  rack: OwnWeapon[];
}

/** What other players need to draw an actor. Slow fields are omitted when unchanged. */
export interface RemoteState {
  id: number;
  x: number; y: number; z: number; vx: number; vy: number; vz: number;
  yaw: number; pitch: number;
  onGround: boolean; crouched: boolean; sprinting: boolean; rolling: boolean;
  alive: boolean; reloading: boolean; ads: boolean; protectedNow: boolean;
  hp?: number; weapon?: WeaponId; rarity?: number; mag?: number; stamina?: number;
}

export interface Snapshot {
  /** Server clock (ms) of the tick this snapshot describes. */
  serverTime: number;
  /** Snapshot counter (16-bit, wraps); gaps reveal packet loss. */
  tick: number;
  /** Newest input of the receiver that the server has processed. */
  ack: number;
  own: { body: OwnBody; combat: OwnCombat } | null;
  actors: RemoteState[];
}

const ms16 = (s: number): number => clamp(Math.round(s * 1000), -32768, 32767);
const fromMs16 = (v: number): number => v / 1000;
const q256 = (v: number): number => clamp(Math.round(v * 256), -32768, 32767);

function writeOwnBody(w: Writer, b: OwnBody): void {
  w.f32(b.pos.x); w.f32(b.pos.y); w.f32(b.pos.z);
  w.f32(b.vel.x); w.f32(b.vel.y); w.f32(b.vel.z);
  const rolling = b.rollT > 0;
  w.u8((b.onGround ? 1 : 0) | (b.crouched ? 2 : 0) | (b.sprinting ? 4 : 0) | (rolling ? 8 : 0));
  w.f32(b.stamina);
  w.f32(Math.min(b.sinceSprint, 30)); w.f32(b.sprintRecover); w.f32(b.rollT); w.f32(b.rollCd);
  if (rolling) { w.f32(b.rollDirX); w.f32(b.rollDirZ); } // the roll direction is unused (and re-set at the next roll) otherwise
}

function readOwnBody(r: Reader): OwnBody {
  const pos = { x: r.f32(), y: r.f32(), z: r.f32() };
  const vel = { x: r.f32(), y: r.f32(), z: r.f32() };
  const f = r.u8();
  const stamina = r.f32();
  const sinceSprint = r.f32(), sprintRecover = r.f32(), rollT = r.f32(), rollCd = r.f32();
  const rolling = (f & 8) !== 0;
  return {
    pos, vel, onGround: (f & 1) !== 0, crouched: (f & 2) !== 0, sprinting: (f & 4) !== 0, stamina,
    sinceSprint, sprintRecover, rollT, rollCd, rollDirX: rolling ? r.f32() : 0, rollDirZ: rolling ? r.f32() : 0,
  };
}

const RESERVE_INF = 0xffff;

function writeOwnCombat(w: Writer, c: OwnCombat): void {
  w.u16(clamp(Math.round(c.hp * 100), 0, 10000));
  w.u8(c.alive ? 1 : 0);
  w.i16(ms16(c.protectT)); w.i16(ms16(c.respawnT));
  w.u8(c.slot); w.u32(c.shotCounter);
  w.f32(c.recoil.pitch); w.f32(c.recoil.yaw); w.f32(c.recoil.hold);
  w.u8(c.rack.length);
  for (const k of c.rack) {
    w.u8(weaponCode(k.id)); w.u8(k.rarity); w.u8(k.reloading ? 1 : 0); w.u8(k.mag); w.u8(k.magSize);
    w.u16(Number.isFinite(k.reserve) ? clamp(Math.round(k.reserve), 0, RESERVE_INF - 1) : RESERVE_INF);
    w.f32(k.cooldown); w.f32(k.reloadT); w.f32(k.equipT); w.f32(k.adsT); w.f32(k.buffer);
  }
}

function readOwnCombat(r: Reader): OwnCombat {
  const hp = r.u16() / 100, alive = r.u8() !== 0;
  const protectT = fromMs16(r.i16()), respawnT = fromMs16(r.i16());
  const slot = r.u8(), shotCounter = r.u32();
  const recoil = { pitch: r.f32(), yaw: r.f32(), hold: r.f32() };
  const n = r.u8();
  if (n > 4) throw new CodecError('too many weapons');
  const rack: OwnWeapon[] = [];
  for (let k = 0; k < n; k++) {
    const id = weaponFromCode(r.u8()), rarity = r.u8(), reloading = r.u8() !== 0, mag = r.u8(), magSize = r.u8();
    const res = r.u16();
    rack.push({
      id, rarity, reloading, mag, magSize, reserve: res === RESERVE_INF ? Infinity : res,
      cooldown: r.f32(), reloadT: r.f32(), equipT: r.f32(), adsT: r.f32(), buffer: r.f32(),
    });
  }
  return { hp, alive, protectT, respawnT, slot, shotCounter, recoil, rack };
}

function writeRemote(w: Writer, s: RemoteState): void {
  const slow = s.hp !== undefined && s.weapon !== undefined && s.rarity !== undefined && s.mag !== undefined && s.stamina !== undefined;
  w.u8(s.id); w.u8(slow ? 1 : 0);
  w.i16(q256(s.x)); w.i16(q256(s.y)); w.i16(q256(s.z));
  w.i8(clamp(Math.round(s.vx * 16), -127, 127)); w.i8(clamp(Math.round(s.vy * 3), -127, 127)); w.i8(clamp(Math.round(s.vz * 16), -127, 127));
  w.u16(qYaw(s.yaw)); w.i8(clamp(Math.round((clamp(s.pitch, -Math.PI / 2, Math.PI / 2) / (Math.PI / 2)) * 127), -127, 127));
  w.u8((s.onGround ? 1 : 0) | (s.crouched ? 2 : 0) | (s.sprinting ? 4 : 0) | (s.rolling ? 8 : 0) | (s.alive ? 16 : 0) | (s.reloading ? 32 : 0) | (s.ads ? 64 : 0) | (s.protectedNow ? 128 : 0));
  if (slow) {
    w.u8(clamp(Math.ceil(s.hp as number), 0, 100));
    w.u8(weaponCode(s.weapon as WeaponId) | ((s.rarity as number) << 3));
    w.u8(clamp(s.mag as number, 0, 255));
    w.u8(clamp(Math.round(s.stamina as number), 0, 100));
  }
}

function readRemote(r: Reader): RemoteState {
  const id = r.u8(), mask = r.u8();
  const x = r.i16() / 256, y = r.i16() / 256, z = r.i16() / 256;
  const vx = r.i8() / 16, vy = r.i8() / 3, vz = r.i8() / 16;
  const yaw = dqYaw(r.u16()), pitch = (r.i8() / 127) * (Math.PI / 2);
  const f = r.u8();
  const out: RemoteState = {
    id, x, y, z, vx, vy, vz, yaw, pitch,
    onGround: (f & 1) !== 0, crouched: (f & 2) !== 0, sprinting: (f & 4) !== 0, rolling: (f & 8) !== 0,
    alive: (f & 16) !== 0, reloading: (f & 32) !== 0, ads: (f & 64) !== 0, protectedNow: (f & 128) !== 0,
  };
  if ((mask & 1) !== 0) {
    out.hp = r.u8();
    const wb = r.u8();
    out.weapon = weaponFromCode(wb & 7); out.rarity = (wb >> 3) & 3;
    out.mag = r.u8(); out.stamina = r.u8();
  }
  return out;
}

export const MAX_ACTORS = 16;

export function encodeSnapshot(s: Snapshot): Uint8Array {
  const w = new Writer();
  w.u8(MSG_TYPE.SNAPSHOT); w.u32(s.serverTime); w.u16(s.tick & 0xffff); w.u16(s.ack & 0xffff);
  w.u8((s.own ? 1 : 0)); w.u8(s.actors.length);
  if (s.own) { writeOwnBody(w, s.own.body); writeOwnCombat(w, s.own.combat); }
  for (const a of s.actors) writeRemote(w, a);
  return w.finish();
}

export function decodeSnapshot(buf: Uint8Array): Snapshot {
  const r = new Reader(buf);
  if (r.u8() !== MSG_TYPE.SNAPSHOT) throw new CodecError('not a snapshot');
  const serverTime = r.u32(), tick = r.u16(), ack = r.u16();
  const hasOwn = (r.u8() & 1) !== 0;
  const n = r.u8();
  if (n > MAX_ACTORS) throw new CodecError('too many actors');
  const own = hasOwn ? { body: readOwnBody(r), combat: readOwnCombat(r) } : null;
  const actors: RemoteState[] = [];
  for (let k = 0; k < n; k++) actors.push(readRemote(r));
  r.done();
  return { serverTime, tick, ack, own, actors };
}

// --- events --------------------------------------------------------------------------

export interface WireItem { weapon: WeaponId; rarity: number; mag: number; reserve: number }
export interface WireStats {
  kills: number; deaths: number; damageDealt: number; damageTaken: number; shotsFired: number; shotsHit: number;
  headshots: number; pickups: number; streak: number; bestStreak: number;
}
export type NoteKind = 'dry' | 'reloadStart' | 'reloadDone' | 'equip' | 'weaponEmpty';
export type MatchState = 'waiting' | 'live' | 'paused' | 'forfeit';

export type WireEvent =
  | { t: 'shot'; actor: number; weapon: WeaponId; shotId: number; origin: Vec3; pellets: { kind: PelletKind; point: Vec3 }[] }
  | { t: 'hit'; victim: number; damage: number; head: boolean; killed: boolean; dist: number; falloff: number }
  | { t: 'dmg'; attacker: number; dirX: number; dirZ: number; amount: number }
  | { t: 'kill'; killer: number; victim: number; weapon: WeaponId | null; head: boolean }
  | { t: 'pickup'; actor: number; weapon: WeaponId; rarity: number }
  | { t: 'pad'; id: number; item: WireItem | null }
  | { t: 'drop'; id: number; x: number; y: number; z: number; item: WireItem }
  | { t: 'dropGone'; id: number }
  | { t: 'respawn'; actor: number; yaw: number }
  | { t: 'note'; kind: NoteKind; actor: number }
  | { t: 'stats'; actor: number; stats: WireStats }
  | { t: 'match'; state: MatchState; who: number; secs: number };

const EV = { SHOT: 1, HIT: 2, DMG: 3, KILL: 4, PICKUP: 5, PAD: 6, DROP: 7, DROP_GONE: 8, RESPAWN: 9, NOTE: 10, STATS: 11, MATCH: 12 } as const;
const KINDS: PelletKind[] = ['miss', 'world', 'body', 'head'];
const NOTES: NoteKind[] = ['dry', 'reloadStart', 'reloadDone', 'equip', 'weaponEmpty'];
const MATCHES: MatchState[] = ['waiting', 'live', 'paused', 'forfeit'];
const q64 = (v: number): number => clamp(Math.round(v * 64), -32768, 32767);

function writeItem(w: Writer, it: WireItem): void {
  w.u8(weaponCode(it.weapon)); w.u8(it.rarity); w.u8(clamp(it.mag, 0, 255));
  w.u16(Number.isFinite(it.reserve) ? clamp(Math.round(it.reserve), 0, RESERVE_INF - 1) : RESERVE_INF);
}
function readItem(r: Reader): WireItem {
  const weapon = weaponFromCode(r.u8()), rarity = r.u8(), mag = r.u8(), res = r.u16();
  return { weapon, rarity, mag, reserve: res === RESERVE_INF ? Infinity : res };
}

function writeEvent(w: Writer, e: WireEvent): void {
  switch (e.t) {
    case 'shot':
      w.u8(EV.SHOT); w.u8(e.actor); w.u8(weaponCode(e.weapon)); w.u16(e.shotId & 0xffff);
      w.i16(q64(e.origin.x)); w.i16(q64(e.origin.y)); w.i16(q64(e.origin.z));
      w.u8(e.pellets.length);
      for (const p of e.pellets) { w.u8(KINDS.indexOf(p.kind)); w.i16(q64(p.point.x)); w.i16(q64(p.point.y)); w.i16(q64(p.point.z)); }
      break;
    case 'hit':
      w.u8(EV.HIT); w.u8(e.victim); w.u16(clamp(Math.round(e.damage * 10), 0, 65535));
      w.u8((e.head ? 1 : 0) | (e.killed ? 2 : 0)); w.u16(clamp(Math.round(e.dist * 10), 0, 65535)); w.u8(clamp(Math.round(e.falloff * 255), 0, 255));
      break;
    case 'dmg':
      w.u8(EV.DMG); w.u8(e.attacker); w.i8(clamp(Math.round(e.dirX * 127), -127, 127)); w.i8(clamp(Math.round(e.dirZ * 127), -127, 127));
      w.u16(clamp(Math.round(e.amount * 10), 0, 65535));
      break;
    case 'kill':
      w.u8(EV.KILL); w.u8(e.killer); w.u8(e.victim); w.u8(e.weapon === null ? 0xff : weaponCode(e.weapon)); w.u8(e.head ? 1 : 0);
      break;
    case 'pickup': w.u8(EV.PICKUP); w.u8(e.actor); w.u8(weaponCode(e.weapon)); w.u8(e.rarity); break;
    case 'pad':
      w.u8(EV.PAD); w.u16(e.id); w.u8(e.item ? 1 : 0);
      if (e.item) writeItem(w, e.item);
      break;
    case 'drop': w.u8(EV.DROP); w.u16(e.id); w.f32(e.x); w.f32(e.y); w.f32(e.z); writeItem(w, e.item); break;
    case 'dropGone': w.u8(EV.DROP_GONE); w.u16(e.id); break;
    case 'respawn': w.u8(EV.RESPAWN); w.u8(e.actor); w.f32(e.yaw); break;
    case 'note': w.u8(EV.NOTE); w.u8(NOTES.indexOf(e.kind)); w.u8(e.actor); break;
    case 'stats': {
      const s = e.stats;
      w.u8(EV.STATS); w.u8(e.actor);
      w.u16(s.kills); w.u16(s.deaths); w.u32(Math.round(s.damageDealt)); w.u32(Math.round(s.damageTaken));
      w.u16(s.shotsFired); w.u16(s.shotsHit); w.u16(s.headshots); w.u16(s.pickups); w.u16(s.streak); w.u16(s.bestStreak);
      break;
    }
    case 'match': w.u8(EV.MATCH); w.u8(MATCHES.indexOf(e.state)); w.u8(e.who); w.u16(clamp(Math.round(e.secs), 0, 65535)); break;
  }
}

function readEvent(r: Reader): WireEvent {
  const t = r.u8();
  switch (t) {
    case EV.SHOT: {
      const actor = r.u8(), weapon = weaponFromCode(r.u8()), shotId = r.u16();
      const origin = { x: r.i16() / 64, y: r.i16() / 64, z: r.i16() / 64 };
      const n = r.u8();
      if (n > 16) throw new CodecError('too many pellets');
      const pellets: { kind: PelletKind; point: Vec3 }[] = [];
      for (let k = 0; k < n; k++) {
        const kind = KINDS[r.u8()];
        if (!kind) throw new CodecError('bad pellet kind');
        pellets.push({ kind, point: { x: r.i16() / 64, y: r.i16() / 64, z: r.i16() / 64 } });
      }
      return { t: 'shot', actor, weapon, shotId, origin, pellets };
    }
    case EV.HIT: {
      const victim = r.u8(), damage = r.u16() / 10, f = r.u8(), dist = r.u16() / 10, falloff = r.u8() / 255;
      return { t: 'hit', victim, damage, head: (f & 1) !== 0, killed: (f & 2) !== 0, dist, falloff };
    }
    case EV.DMG: return { t: 'dmg', attacker: r.u8(), dirX: r.i8() / 127, dirZ: r.i8() / 127, amount: r.u16() / 10 };
    case EV.KILL: {
      const killer = r.u8(), victim = r.u8(), w = r.u8(), head = r.u8() !== 0;
      return { t: 'kill', killer, victim, weapon: w === 0xff ? null : weaponFromCode(w), head };
    }
    case EV.PICKUP: return { t: 'pickup', actor: r.u8(), weapon: weaponFromCode(r.u8()), rarity: r.u8() };
    case EV.PAD: {
      const id = r.u16(), has = r.u8() !== 0;
      return { t: 'pad', id, item: has ? readItem(r) : null };
    }
    case EV.DROP: return { t: 'drop', id: r.u16(), x: r.f32(), y: r.f32(), z: r.f32(), item: readItem(r) };
    case EV.DROP_GONE: return { t: 'dropGone', id: r.u16() };
    case EV.RESPAWN: return { t: 'respawn', actor: r.u8(), yaw: r.f32() };
    case EV.NOTE: {
      const kind = NOTES[r.u8()];
      if (!kind) throw new CodecError('bad note kind');
      return { t: 'note', kind, actor: r.u8() };
    }
    case EV.STATS: {
      const actor = r.u8();
      return {
        t: 'stats', actor,
        stats: {
          kills: r.u16(), deaths: r.u16(), damageDealt: r.u32(), damageTaken: r.u32(), shotsFired: r.u16(), shotsHit: r.u16(),
          headshots: r.u16(), pickups: r.u16(), streak: r.u16(), bestStreak: r.u16(),
        },
      };
    }
    case EV.MATCH: {
      const state = MATCHES[r.u8()];
      if (!state) throw new CodecError('bad match state');
      return { t: 'match', state, who: r.u8(), secs: r.u16() };
    }
    default: throw new CodecError(`unknown event type ${t}`);
  }
}

export function encodeEvents(events: readonly WireEvent[]): Uint8Array {
  if (events.length > 255) throw new CodecError('too many events in one message');
  const w = new Writer();
  w.u8(MSG_TYPE.EVENTS); w.u8(events.length);
  for (const e of events) writeEvent(w, e);
  return w.finish();
}

export function decodeEvents(buf: Uint8Array): WireEvent[] {
  const r = new Reader(buf);
  if (r.u8() !== MSG_TYPE.EVENTS) throw new CodecError('not an event batch');
  const n = r.u8();
  const out: WireEvent[] = [];
  for (let k = 0; k < n; k++) out.push(readEvent(r));
  r.done();
  return out;
}
