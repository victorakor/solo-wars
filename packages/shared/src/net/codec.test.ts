import { describe, expect, it } from 'vitest';
import { WEAPONS } from '../balance';
import { idleInput } from '../sim/sim';
import {
  CodecError, nextSeq, resolveClientTime, decodeEvents, decodeInputBatch, decodeSnapshot, encodeEvents, encodeInputBatch, encodeSnapshot, quantizeInput,
  seqNewer, weaponCode, weaponFromCode, WEAPON_ORDER, type OwnBody, type OwnCombat, type RemoteState, type Snapshot, type WireEvent,
} from './codec';
import { mulberry32 } from '../sim/rng';

const rnd = mulberry32(42);
const r = (lo: number, hi: number): number => lo + (hi - lo) * rnd();

function randomInput(seq: number) {
  const i = idleInput();
  i.moveX = r(-1, 1); i.moveZ = r(-1, 1); i.yaw = r(-20, 20); i.pitch = r(-1.5, 1.5);
  i.jump = rnd() < 0.3; i.sprint = rnd() < 0.3; i.crouch = rnd() < 0.3; i.dodge = rnd() < 0.3; i.ads = rnd() < 0.3;
  i.fire = rnd() < 0.5; i.firePressed = rnd() < 0.5; i.reload = rnd() < 0.2; i.interact = rnd() < 0.2; i.drop = rnd() < 0.2;
  i.slot = rnd() < 0.5 ? Math.floor(r(0, 8)) : null;
  if (rnd() < 0.5) { i.aimYaw = i.yaw + r(-0.4, 0.4); i.aimPitch = i.pitch + r(-0.3, 0.3); }
  return quantizeInput(i, seq);
}

describe('input quantisation and batches', () => {
  it('quantising is idempotent and survives the wire bit for bit', () => {
    for (let n = 0; n < 500; n++) {
      const a = randomInput(n + 1); // sequence 0 is reserved
      const again = quantizeInput(a, a.seq);
      expect(again).toEqual(a);
      const b = decodeInputBatch(encodeInputBatch({ serverTimeEst: 123456, inputs: [a] }));
      expect(b.inputs[0]).toEqual(a);
      expect(resolveClientTime(b.serverTimeLow, 123000)).toBe(123456);
    }
  });
  it('quantising barely changes the input (angles within 0.01 degrees, move within 1/254)', () => {
    for (let n = 0; n < 200; n++) {
      const i = idleInput();
      i.yaw = r(-10, 10); i.pitch = r(-1.5, 1.5); i.moveX = r(-1, 1); i.moveZ = r(-1, 1);
      const q = quantizeInput(i, 1);
      const dy = Math.atan2(Math.sin(q.yaw - i.yaw), Math.cos(q.yaw - i.yaw));
      expect(Math.abs(dy)).toBeLessThan((0.01 * Math.PI) / 180);
      expect(Math.abs(q.pitch - i.pitch)).toBeLessThan((0.01 * Math.PI) / 180);
      expect(Math.abs(q.moveX - i.moveX)).toBeLessThan(1 / 250);
    }
  });
  it('a batch carries consecutive inputs, sending only the first sequence number', () => {
    const inputs = [randomInput(65534), randomInput(65535), randomInput(1)]; // 0 is skipped
    const buf = encodeInputBatch({ serverTimeEst: 4000000000, inputs });
    const d = decodeInputBatch(buf);
    expect(d.inputs.map((x) => x.seq)).toEqual([65534, 65535, 1]);
    expect(d.inputs).toEqual(inputs);
    expect(resolveClientTime(d.serverTimeLow, 4000000300)).toBe(4000000000);
    expect(nextSeq(65535)).toBe(1);
    expect(() => encodeInputBatch({ serverTimeEst: 1, inputs: [randomInput(5), randomInput(7)] })).toThrow(); // gap
  });
  it('a four-input batch with aim on every input is at most 56 bytes; without aim 38', () => {
    const mk = (fire: boolean) => Array.from({ length: 4 }, (_, k) => {
      const i = idleInput(); i.yaw = 1 + k; i.fire = fire; i.firePressed = fire; i.aimYaw = i.yaw + 0.1; i.aimPitch = 0.05;
      return quantizeInput(i, 100 + k);
    });
    expect(encodeInputBatch({ serverTimeEst: 1, inputs: mk(true) }).length).toBeLessThanOrEqual(50);
    expect(encodeInputBatch({ serverTimeEst: 1, inputs: mk(false) }).length).toBe(6 + 4 * 8);
  });
  it('aim is only sent with inputs that pull the trigger (it is only used when a shot leaves the barrel)', () => {
    const i = idleInput(); i.aimYaw = 1; i.aimPitch = 0.1;
    expect(quantizeInput(i, 1).aimYaw).toBeUndefined();
    i.fire = true;
    expect(quantizeInput(i, 1).aimYaw).toBeDefined();
    const j = idleInput(); j.firePressed = true; j.aimYaw = 1; j.aimPitch = 0.1;
    expect(quantizeInput(j, 1).aimYaw).toBeDefined();
  });
  it('aim keeps 0.02 degree precision inside +-0.6 rad of the view, and clamps beyond', () => {
    for (let n = 0; n < 300; n++) {
      const i = idleInput(); i.fire = true; i.yaw = r(0, 6); i.pitch = r(-1, 1);
      const dy = r(-0.55, 0.55), dp = r(-0.55, 0.55);
      i.aimYaw = i.yaw + dy; i.aimPitch = i.pitch + dp;
      const q = decodeInputBatch(encodeInputBatch({ serverTimeEst: 1, inputs: [quantizeInput(i, 1)] })).inputs[0]!;
      expect(Math.abs(q.aimYaw! - q.yaw - dy)).toBeLessThan((0.02 * Math.PI) / 180);
      expect(Math.abs(q.aimPitch! - q.pitch - dp)).toBeLessThan((0.02 * Math.PI) / 180);
    }
    const far = idleInput(); far.fire = true; far.aimYaw = 3; far.aimPitch = 0;
    expect(quantizeInput(far, 1).aimYaw! - quantizeInput(far, 1).yaw).toBeCloseTo(0.6, 6);
  });
  it('the 16-bit clock is resolved against the server clock across its wrap', () => {
    for (const now of [0, 1000, 65000, 65535, 70000, 4_000_000_000]) {
      for (const off of [-30000, -5000, 0, 250, 20000]) {
        const est = now + off;
        if (est < 0) continue;
        expect(resolveClientTime(est & 0xffff, now)).toBe(est);
      }
    }
  });
  it('the hand-built 14-byte idle packet used by scripts/matchsmoke.mjs decodes with the real codec', () => {
    const dv = new DataView(new ArrayBuffer(14)); // identical to idleBatch() in the script
    dv.setUint8(0, 1); dv.setUint8(1, 1); dv.setUint16(2, 0xbeef, true); dv.setUint16(4, 77, true);
    dv.setUint16(6, 0, true); dv.setInt8(8, 0); dv.setInt8(9, 0); dv.setUint16(10, 0, true); dv.setInt16(12, 0, true);
    const d = decodeInputBatch(new Uint8Array(dv.buffer));
    expect(d.serverTimeLow).toBe(0xbeef);
    expect(d.inputs).toHaveLength(1);
    expect(d.inputs[0]).toEqual(quantizeInput(idleInput(), 77));
  });
  it('slots outside 0-7 become none; out-of-range moves clamp', () => {
    const i = idleInput(); i.slot = 12; i.moveX = 5; i.moveZ = -5;
    const q = quantizeInput(i, 1);
    expect(q.slot).toBeNull();
    expect([q.moveX, q.moveZ]).toEqual([1, -1]);
  });
  it('rejects malformed batches without throwing anything but CodecError', () => {
    const good = encodeInputBatch({ serverTimeEst: 1, inputs: [randomInput(1)] });
    const bad: Uint8Array[] = [
      new Uint8Array(0), new Uint8Array([1]), good.slice(0, good.length - 1), new Uint8Array([...good, 0]),
      new Uint8Array([9, 1, 0, 0, 0, 0]), new Uint8Array([1, 0, 0, 0, 0, 0]), new Uint8Array([1, 200, 0, 0, 0, 0]),
      new Uint8Array([1, 1, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0]), // sequence number 0 is reserved
    ];
    for (const b of bad) expect(() => decodeInputBatch(b)).toThrow();
    for (const b of bad) { try { decodeInputBatch(b); } catch (e) { expect(e instanceof CodecError).toBe(true); } }
    expect(() => encodeInputBatch({ serverTimeEst: 1, inputs: [] })).toThrow();
  });
  it('random garbage never crashes the decoder', () => {
    for (let n = 0; n < 3000; n++) {
      const len = Math.floor(r(0, 80));
      const b = new Uint8Array(len).map(() => Math.floor(r(0, 256)));
      if (len > 0 && n % 2) b[0] = 1;
      try { decodeInputBatch(b); } catch (e) { expect(e instanceof CodecError).toBe(true); }
      try { decodeSnapshot(b); } catch (e) { expect(e instanceof CodecError).toBe(true); }
      try { decodeEvents(b); } catch (e) { expect(e instanceof CodecError).toBe(true); }
    }
  });
  it('sequence numbers compare across the 16-bit wrap', () => {
    expect(seqNewer(5, 4)).toBe(true);
    expect(seqNewer(4, 5)).toBe(false);
    expect(seqNewer(3, 65530)).toBe(true);
    expect(seqNewer(65530, 3)).toBe(false);
    expect(seqNewer(7, 7)).toBe(false);
  });
  it('weapon codes round trip', () => {
    for (const id of WEAPON_ORDER) expect(weaponFromCode(weaponCode(id))).toBe(id);
    expect(() => weaponFromCode(99)).toThrow();
    expect(WEAPON_ORDER).toHaveLength(Object.keys(WEAPONS).length);
  });
});

const body: OwnBody = {
  pos: { x: 12.5, y: 0.05, z: -7.25 }, vel: { x: 3.5, y: -1, z: 0.25 }, onGround: true, crouched: false, sprinting: true,
  stamina: 82.5, sinceSprint: 0.4, sprintRecover: 0.05, rollT: 0, rollCd: 1.25, rollDirX: 0.6, rollDirZ: -0.8,
};
const combat: OwnCombat = {
  hp: 73.25, alive: true, protectT: 0, respawnT: 0, slot: 1, shotCounter: 70000,
  recoil: { pitch: 0.05, yaw: -0.01, hold: 0.1 },
  rack: [
    { id: 'vanguard', rarity: 0, mag: 22, magSize: 30, reserve: Infinity, cooldown: 0.05, reloading: false, reloadT: 0, equipT: 0, adsT: 0.5, buffer: 0 },
    { id: 'longshot', rarity: 2, mag: 3, magSize: 5, reserve: 12, cooldown: -0.01, reloading: true, reloadT: 1.5, equipT: 0.2, adsT: 0, buffer: 0.1 },
  ],
};
const remote: RemoteState = {
  id: 3, x: -20.5, y: 1.25, z: 14, vx: 4, vy: 0, vz: -3.5, yaw: 2.5, pitch: -0.3,
  onGround: true, crouched: true, sprinting: false, rolling: false, alive: true, reloading: true, ads: false, protectedNow: true,
  hp: 88, weapon: 'breaker', rarity: 1, mag: 5, stamina: 60,
};

describe('snapshots', () => {
  const snap: Snapshot = { serverTime: 3000000, tick: 65535, ack: 777, own: { body, combat }, actors: [remote] };
  it('round trip within quantisation error', () => {
    const d = decodeSnapshot(encodeSnapshot(snap));
    expect([d.serverTime, d.tick, d.ack]).toEqual([3000000, 65535, 777]);
    expect(d.own!.body.pos.x).toBeCloseTo(12.5, 5);
    expect(d.own!.body.rollCd).toBeCloseTo(1.25, 3);
    expect(d.own!.body.sprinting).toBe(true);
    expect(d.own!.combat.shotCounter).toBe(70000);
    expect(d.own!.combat.hp).toBeCloseTo(73.25, 2);
    expect(d.own!.combat.rack[0]!.reserve).toBe(Infinity);
    expect(d.own!.combat.rack[1]).toMatchObject({ id: 'longshot', rarity: 2, mag: 3, reserve: 12, reloading: true });
    expect(d.own!.combat.rack[1]!.cooldown).toBeCloseTo(-0.01, 3);
    const a = d.actors[0]!;
    expect(a.x).toBeCloseTo(-20.5, 2);
    expect(a.yaw).toBeCloseTo(2.5, 3);
    expect(a.vx).toBeCloseTo(4, 1);
    expect([a.crouched, a.reloading, a.protectedNow, a.alive]).toEqual([true, true, true, true]);
    expect([a.hp, a.weapon, a.rarity, a.mag, a.stamina]).toEqual([88, 'breaker', 1, 5, 60]);
  });
  it('omits slow fields when absent and is smaller for it', () => {
    const { hp, weapon, rarity, mag, stamina, ...fast } = remote;
    void hp; void weapon; void rarity; void mag; void stamina;
    const withSlow = encodeSnapshot({ ...snap, own: null, actors: [remote] });
    const without = encodeSnapshot({ ...snap, own: null, actors: [fast] });
    expect(without.length).toBe(withSlow.length - 4);
    expect(decodeSnapshot(without).actors[0]!.hp).toBeUndefined();
  });
  it('position quantisation error stays under 2 mm across the arena', () => {
    for (let n = 0; n < 500; n++) {
      const a: RemoteState = { ...remote, x: r(-30, 30), y: r(0, 8), z: r(-22, 22) };
      const d = decodeSnapshot(encodeSnapshot({ ...snap, own: null, actors: [a] })).actors[0]!;
      expect(Math.abs(d.x - a.x)).toBeLessThan(0.002);
      expect(Math.abs(d.z - a.z)).toBeLessThan(0.002);
    }
  });
  it('size: own block + one opponent stays under 170 bytes (20 Hz of this is about 24 kbps with framing)', () => {
    const n = encodeSnapshot(snap).length;
    expect(n).toBeGreaterThan(120);
    expect(n).toBeLessThan(170);
  });
  it('weapon timers travel as exact floats: a cooldown a hair above zero is not rounded to a different tick', () => {
    const c: OwnCombat = { ...combat, rack: [{ ...combat.rack[0]!, cooldown: 0.0004 }] };
    const d = decodeSnapshot(encodeSnapshot({ ...snap, own: { body, combat: c } }));
    expect(d.own!.combat.rack[0]!.cooldown).toBeCloseTo(0.0004, 7);
  });
  it('truncation or too many actors is rejected', () => {
    const b = encodeSnapshot(snap);
    expect(() => decodeSnapshot(b.slice(0, 30))).toThrow();
    const evil = new Uint8Array(b); evil[9] = 250; // actor count
    expect(() => decodeSnapshot(evil)).toThrow();
  });
});

describe('events', () => {
  const events: WireEvent[] = [
    { t: 'shot', actor: 1, weapon: 'breaker', shotId: 65539, origin: { x: 1.5, y: 1.6, z: -3 }, pellets: [{ kind: 'body', point: { x: 2, y: 1, z: -9 } }, { kind: 'miss', point: { x: 5, y: 3, z: -150 } }] },
    { t: 'hit', victim: 2, damage: 36.7, head: true, killed: false, dist: 23.4, falloff: 0.8 },
    { t: 'dmg', attacker: 1, dirX: -0.6, dirZ: 0.8, amount: 20 },
    { t: 'kill', killer: 1, victim: 2, weapon: 'longshot', head: true },
    { t: 'kill', killer: 255, victim: 2, weapon: null, head: false },
    { t: 'pickup', actor: 1, weapon: 'rattler', rarity: 2 },
    { t: 'pad', id: 4, item: { weapon: 'vanguard', rarity: 1, mag: 33, reserve: 90 } },
    { t: 'pad', id: 5, item: null },
    { t: 'drop', id: 40, x: 1, y: 0, z: 2, item: { weapon: 'sidearm', rarity: 0, mag: 4, reserve: 20 } },
    { t: 'dropGone', id: 40 },
    { t: 'respawn', actor: 1, yaw: -1.5 },
    { t: 'note', kind: 'reloadDone', actor: 1 },
    { t: 'stats', actor: 1, stats: { kills: 3, deaths: 2, damageDealt: 640, damageTaken: 410, shotsFired: 120, shotsHit: 70, headshots: 9, pickups: 2, streak: 1, bestStreak: 3 } },
    { t: 'match', state: 'paused', who: 2, secs: 27 },
  ];
  it('every event type survives the wire', () => {
    const d = decodeEvents(encodeEvents(events));
    expect(d).toHaveLength(events.length);
    expect(d[0]).toMatchObject({ t: 'shot', actor: 1, weapon: 'breaker', shotId: 3 });
    expect((d[0] as Extract<WireEvent, { t: 'shot' }>).pellets).toHaveLength(2);
    expect((d[1] as Extract<WireEvent, { t: 'hit' }>).damage).toBeCloseTo(36.7, 1);
    expect(d[3]).toEqual(events[3]);
    expect(d[4]).toEqual(events[4]);
    expect(d[6]).toEqual(events[6]);
    expect(d[7]).toEqual(events[7]);
    expect(d[12]).toEqual(events[12]);
    expect(d[13]).toEqual(events[13]);
  });
  it('rejects unknown types and bad enums', () => {
    expect(() => decodeEvents(new Uint8Array([3, 1, 99]))).toThrow();
    expect(() => decodeEvents(new Uint8Array([3, 1, 10, 9, 0]))).toThrow(); // note kind 9
  });
});
