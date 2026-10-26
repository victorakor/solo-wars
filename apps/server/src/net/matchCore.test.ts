import { describe, expect, it } from 'vitest';
import {
  NET, NET_MSG, SIM, decodeEvents, decodeSnapshot, encodeInputBatch, idleInput, mulberry32, quantizeInput,
  type ActorInput, type WireEvent, type Welcome,
} from '@arena/shared';
import { MatchCore, type CoreOptions } from './matchCore';

const TICK = 1000 / SIM.tickHz;

interface Sent { key: string; type: string; payload: unknown; reliable: boolean }

/** A core with no network at all: sends are recorded, time is virtual. */
function mk(opts: Partial<CoreOptions> = {}) {
  const sent: Sent[] = [];
  const t = { now: 50000 };
  const core = new MatchCore({ seed: 4, now: () => t.now, send: (key, type, payload, reliable) => sent.push({ key, type, payload, reliable }), minHumans: 2, ...opts });
  const tick = (n = 1): void => { for (let i = 0; i < n; i++) { t.now += TICK; core.advance(); } };
  const events = (key: string): WireEvent[] =>
    sent.filter((s) => s.key === key && s.type === NET_MSG.EVENTS).flatMap((s) => decodeEvents(s.payload as Uint8Array));
  const snaps = (key: string) => sent.filter((s) => s.key === key && s.type === NET_MSG.SNAPSHOT).map((s) => decodeSnapshot(s.payload as Uint8Array));
  /** Ticks while the given clients keep talking (a real client sends an input every tick; silence for 3 s means disconnected). */
  const live = (n: number, keys: string[] = ['a', 'b']): void => {
    for (let i = 0; i < n; i++) {
      for (const k of keys) core.onMessage(k, NET_MSG.INPUT, encodeInputBatch({ serverTimeEst: core.clock(), inputs: [quantizeInput(idleInput(), (seqCounter = (seqCounter % 60000) + 1) + 60000)] }));
      t.now += TICK; core.advance();
    }
  };
  return { core, sent, t, tick, live, events, snaps };
}

let seqCounter = 0;
const input = (o: Partial<ActorInput> = {}, seq?: number) => quantizeInput({ ...idleInput(), ...o }, seq ?? ++seqCounter);
/** Builds a wire batch; the helper renumbers the inputs consecutively from the first one's sequence, as a real client sends them. */
const batch = (est: number, ...inputs: ReturnType<typeof input>[]): Uint8Array => {
  const first = inputs[0]!.seq;
  let s = first;
  const fixed = inputs.map((i) => { const x = { ...i, seq: s }; s = s >= 65535 ? 1 : s + 1; return x; });
  return encodeInputBatch({ serverTimeEst: est, inputs: fixed });
};

/** Two humans on the open lane, ready to run. */
function duel(opts: Partial<CoreOptions> = {}) {
  const m = mk(opts);
  m.core.join('a', 'A', 'vanguard');
  m.core.join('b', 'B', 'vanguard');
  const ha = m.core.humans.get('a')!, hb = m.core.humans.get('b')!;
  ha.actor.hp.protectT = 0; hb.actor.hp.protectT = 0;
  m.tick(2);
  return { ...m, ha, hb };
}

describe('joining', () => {
  it('waits for the second player, goes live, and refuses a third', () => {
    const m = mk();
    expect(m.core.join('a', 'A', 'vanguard')).not.toBeNull();
    expect(m.core.state).toBe('waiting');
    expect(m.core.join('b', 'B', 'vanguard')).not.toBeNull();
    expect(m.core.state).toBe('live');
    expect(m.core.join('c', 'C', 'vanguard')).toBeNull();
    expect(m.core.join('a', 'A again', 'vanguard')).toBeNull(); // same key twice
  });
  it('sends a welcome with the roster, seed and all seven pads; unknown weapons fall back to the Vanguard', () => {
    const m = mk();
    const h = m.core.join('a', 'Alice', 'rocket-launcher')!;
    const w = m.sent.find((s) => s.type === NET_MSG.WELCOME)!;
    expect(w.reliable).toBe(true);
    const p = w.payload as Welcome;
    expect(p.you).toBe(h.actor.index);
    expect(p.seed).toBe(4);
    expect(p.roster.map((r) => r.name)).toEqual(['Alice']);
    expect(p.pickups.filter((x) => x.kind === 'pad')).toHaveLength(7);
    expect(h.actor.rack[0]!.id).toBe('vanguard');
  });
  it('answers a hello with the welcome again, in case the first one was missed', () => {
    const m = mk();
    m.core.join('a', 'A', 'vanguard');
    const before = m.sent.filter((x) => x.type === NET_MSG.WELCOME).length;
    m.t.now += 100;
    m.core.onMessage('a', NET_MSG.HELLO, {});
    expect(m.sent.filter((x) => x.type === NET_MSG.WELCOME).length).toBe(before + 1);
  });
  it('caps bots to the bandwidth budget and adds them when the match goes live', () => {
    const m = mk({ bots: 4, minHumans: 1 });
    m.core.join('a', 'A', 'vanguard');
    expect(m.core.sim.actors.filter((a) => a.kind === 'bot')).toHaveLength(NET.maxBots);
    const roster = m.sent.filter((x) => x.type === NET_MSG.ROSTER).pop()!.payload as { roster: { kind: string }[] };
    expect(roster.roster.filter((r) => r.kind === 'bot')).toHaveLength(NET.maxBots); // clients are told about them
  });
});

describe('hostile and broken clients', () => {
  it('garbage never throws and is counted', () => {
    const { core, t } = duel();
    const rnd = mulberry32(9);
    const junk: unknown[] = [undefined, null, 5, 'text', {}, [], [1, 2, 3], new Uint8Array(0), new Uint8Array(1_000_000), { a: 1 }, true, Symbol.iterator.toString()];
    for (let i = 0; i < 300; i++) junk.push(new Uint8Array(Math.floor(rnd() * 90)).map(() => Math.floor(rnd() * 256)));
    const good = batch(1000, input());
    junk.push(good.slice(0, 5), new Uint8Array([...good, 1, 2, 3]));
    for (const j of junk) {
      t.now += 15; // a polite rate, so every message reaches the decoder
      expect(() => core.onMessage('a', NET_MSG.INPUT, j)).not.toThrow();
    }
    for (const ty of ['', 'zzz', '__proto__', 'ping2', 'in ']) { t.now += 15; expect(() => core.onMessage('a', ty, good)).not.toThrow(); }
    expect(core.counters.malformed).toBeGreaterThan(100);
  });
  it('a message from nobody, or from a client that already left, is ignored', () => {
    const { core } = duel();
    expect(() => core.onMessage('ghost', NET_MSG.INPUT, batch(1, input()))).not.toThrow();
    core.leave('a');
    expect(() => core.onMessage('a', NET_MSG.INPUT, batch(1, input()))).not.toThrow();
  });
  it('ping payloads are validated with zod', () => {
    const { core, sent, t } = duel();
    const pongs = (): Sent[] => sent.filter((s) => s.type === NET_MSG.PONG);
    for (const bad of [null, undefined, {}, { t: 'x' }, { t: NaN }, { t: Infinity }, 7, 'ping']) {
      t.now += 400;
      core.onMessage('a', NET_MSG.PING, bad);
    }
    expect(pongs()).toHaveLength(0);
    t.now += 400;
    core.onMessage('a', NET_MSG.PING, { t: 1234 });
    expect(pongs()).toHaveLength(1);
    expect(pongs()[0]!.payload).toMatchObject({ t: 1234 });
    expect(typeof (pongs()[0]!.payload as { serverTime: number }).serverTime).toBe('number');
  });
  it('duplicate and stale inputs are processed once', () => {
    const { core, ha, tick } = duel();
    const base = 100;
    const [i1, i2, i3] = [input({ moveZ: 1 }, base + 1), input({ moveZ: 1 }, base + 2), input({ moveZ: 1 }, base + 3)];
    core.onMessage('a', NET_MSG.INPUT, batch(1000, i1, i2, i3));
    core.onMessage('a', NET_MSG.INPUT, batch(1000, i1, i2, i3)); // redundant copy
    core.onMessage('a', NET_MSG.INPUT, batch(1000, i2)); // late straggler
    tick(10);
    expect(ha.inputsProcessed).toBe(3);
    expect(ha.ack).toBe(base + 3);
  });
  it('sequence numbers keep working across the 16-bit wrap', () => {
    const { core, ha, tick } = duel();
    core.onMessage('a', NET_MSG.INPUT, batch(1000, input({}, 65534), input({}, 65535), input({}, 1)));
    tick(6);
    expect(ha.inputsProcessed).toBe(3);
    expect(ha.ack).toBe(1);
  });
  it('flooding inputs cannot make a player move faster than real time', () => {
    const { core, ha, hb, tick, t } = duel();
    for (const [h, z] of [[ha, 1.0], [hb, -1.5]] as const) { h.actor.body.pos.x = -24; h.actor.body.pos.z = z; h.actor.body.pos.y = 0.05; }
    const yaw = -Math.PI / 2; // facing +x along the clear lane
    let seqA = 1000, seqB = 5000;
    const x0 = ha.actor.body.pos.x;
    for (let i = 0; i < 300; i++) { // 5 s
      core.onMessage('a', NET_MSG.INPUT, batch(t.now, input({ moveZ: 1, yaw }, ++seqA)));
      const fast = [1, 2, 3, 4, 5].map(() => input({ moveZ: 1, yaw }, ++seqB)); // five inputs per tick
      core.onMessage('b', NET_MSG.INPUT, batch(t.now, ...fast));
      tick(1);
    }
    const da = ha.actor.body.pos.x - x0, db = hb.actor.body.pos.x - x0;
    expect(da).toBeGreaterThan(15);
    expect(db).toBeLessThan(da + 1.5); // at most the catch-up allowance
    expect(hb.queue.length).toBeLessThanOrEqual(NET.inputQueueMax);
  });
  it('messages beyond the budget are dropped, and a relentless flood gets the client kicked', () => {
    const { core } = duel();
    const msg = batch(1, input());
    let kicked = false;
    for (let i = 0; i < 100; i++) core.onMessage('a', NET_MSG.INPUT, msg);
    expect(core.counters.messagesDropped).toBeGreaterThan(10);
    for (let i = 0; i < 2000 && !kicked; i++) kicked = core.onMessage('a', NET_MSG.INPUT, msg) === 'kick';
    expect(kicked).toBe(true);
  });
  it('a legitimate client at the normal rate is never throttled', () => {
    const { core, tick } = duel();
    for (let i = 0; i < 600; i++) { core.onMessage('a', NET_MSG.INPUT, batch(i, input({}, 2000 + i))); tick(2); } // 30 messages/s for 20 s
    expect(core.counters.messagesDropped).toBe(0);
  });
  it('an oversized backlog is trimmed to the queue cap', () => {
    const { core, hb } = duel();
    for (let k = 0; k < 20; k++) core.onMessage('b', NET_MSG.INPUT, batch(1, input({}, 100 + k * 2), input({}, 101 + k * 2))); // 40 inputs, no ticks
    expect(hb.queue.length).toBeLessThanOrEqual(NET.inputQueueMax);
  });
});

describe('snapshots and acknowledgements', () => {
  it('sends snapshots at 20 Hz, each acknowledging the newest processed input', () => {
    const { core, ha, tick, snaps, t } = duel();
    for (let i = 0; i < 120; i++) { core.onMessage('a', NET_MSG.INPUT, batch(t.now, input({}, 300 + i))); core.onMessage('b', NET_MSG.INPUT, batch(t.now, input({}, 300 + i))); tick(1); }
    const s = snaps('a');
    expect(s.length).toBeGreaterThan(35);
    expect(s.length).toBeLessThan(45); // 2 s at 20 Hz
    const lag = ha.ack - s[s.length - 1]!.ack; // the last snapshot went out up to 3 ticks ago
    expect(lag).toBeGreaterThanOrEqual(0);
    expect(lag).toBeLessThanOrEqual(3);
    expect(s[s.length - 1]!.own).not.toBeNull();
    expect(s[s.length - 1]!.actors.map((a) => a.id)).toEqual([core.humans.get('b')!.actor.index]);
    expect(new Set(s.map((x) => x.tick)).size).toBe(s.length);
  });
  it('slow fields are sent when they change and refreshed periodically, not every snapshot', () => {
    const { live, snaps } = duel();
    live(240);
    const s = snaps('a');
    const withSlow = s.filter((x) => x.actors[0]!.hp !== undefined).length;
    expect(withSlow).toBeGreaterThan(0);
    expect(withSlow).toBeLessThan(s.length / 3);
  });
});

describe('lag compensation window', () => {
  /** B stands still at P0, then is moved away; A fires at P0 claiming a given render time. */
  function setup() {
    const m = duel();
    const { ha, hb, core } = m;
    ha.actor.body.pos.x = -24; ha.actor.body.pos.z = 0; hb.actor.body.pos.x = -9; hb.actor.body.pos.z = 0;
    m.live(30);
    return { ...m, core, ha, hb };
  }
  const shoot = (m: ReturnType<typeof setup>, claimedAgoMs: number): number => {
    const { core, ha, hb, live } = m;
    hb.actor.hp.hp = 100; ha.actor.hp.hp = 100;
    ha.actor.rack[0]!.adsT = 1; // already aimed down sights: hip spread would be wider than the target
    const before = ha.actor.stats.shotsHit;
    const eye = { x: ha.actor.body.pos.x, y: 1.6, z: ha.actor.body.pos.z };
    const dx = -9 - eye.x, dy = 1.0 - eye.y;
    const yaw = Math.atan2(-dx, 0.0001), pitch = Math.atan2(dy, Math.abs(dx));
    // the claimed render time: what the shooter says it was looking at, plus the interpolation delay the server subtracts
    const est = Math.round(core.clock() + SIM.interpDelayMs - claimedAgoMs);
    for (let k = 0; k < 4; k++) {
      core.onMessage('a', NET_MSG.INPUT, batch(est, input({ yaw, pitch, ads: true, fire: true, firePressed: true }, ++seqCounter)));
      live(1, ['b']); // B keeps talking; A's fire inputs are the ones we sent
    }
    return ha.actor.stats.shotsHit - before;
  };
  it('a shot is judged against where the target was when the shooter saw it (and misses without lag compensation)', () => {
    const run = (compensate: boolean): number => {
      const m = setup();
      m.live(60); // B has stood on the line of fire for a while
      if (!compensate) m.core.sim.rewind = null;
      for (let i = 0; i < 6; i++) { m.hb.actor.body.pos.z += 0.3; m.live(1); } // then runs 1.8 m aside in the last 100 ms
      return shoot(m, 150); // the shooter saw B still on the line 150 ms ago
    };
    expect(run(true)).toBeGreaterThan(0);
    expect(run(false)).toBe(0);
  });
  it('a target that moved long ago cannot be hit there: rewinding is clamped to 250 ms', () => {
    const m = setup();
    m.live(120); // B has stood at z = 0 for a long time
    m.hb.actor.body.pos.z = 6; // moves clear of the line of fire
    m.live(30); // 0.5 s later: well beyond the rewind limit
    const hit = shoot(m, 600); // the shooter claims to have been looking at the old position 600 ms ago
    expect(hit).toBe(0);
    expect(m.core.counters.rewound).toBeGreaterThan(0);
  });
  it('claiming a future render time is clamped to now', () => {
    const m = setup();
    m.hb.actor.body.pos.z = 6;
    m.live(10);
    expect(shoot(m, -5000)).toBe(0);
  });
  it('never hits a hitbox interpolated across a respawn teleport', () => {
    const m = setup();
    m.hb.actor.body.pos.z = 0;
    m.live(20);
    m.hb.actor.hp.hp = 0; m.hb.actor.hp.alive = false; m.hb.actor.hp.respawnT = 0.0001;
    m.live(3); // respawns elsewhere (epoch changes)
    const epochAfter = m.hb.actor.epoch;
    expect(epochAfter).toBeGreaterThan(0);
    expect(m.core.sim.rewind!(m.ha.actor, m.core.clock() - 40).every((x) => Number.isFinite(x.pos.x))).toBe(true);
  });
});

describe('disconnect, pause, reconnect, forfeit', () => {
  it('pauses the whole match when a player drops, and freezes the simulation', () => {
    const { core, ha, hb, live, events } = duel();
    live(30);
    const p0 = { x: ha.actor.body.pos.x, z: ha.actor.body.pos.z };
    core.disconnect('b');
    expect(core.state).toBe('paused');
    const n0 = core.tickNo;
    live(300, ['a']);
    expect(ha.actor.body.pos.x).toBe(p0.x);
    expect(core.tickNo).toBe(n0); // not one tick ran while paused
    const m = events('a').filter((e): e is Extract<WireEvent, { t: 'match' }> => e.t === 'match');
    expect(m.some((e) => e.state === 'paused' && e.who === hb.actor.index)).toBe(true);
  });
  it('counts down for the other player and resumes when the dropped player returns', () => {
    const { core, tick, live, events, sent } = duel();
    core.disconnect('b');
    live(200, ['a']); // a little over 3 s
    const secs = events('a').filter((e): e is Extract<WireEvent, { t: 'match' }> => e.t === 'match' && e.state === 'paused').map((e) => e.secs);
    expect(Math.min(...secs)).toBeLessThanOrEqual(27);
    expect(Math.min(...secs)).toBeGreaterThanOrEqual(26);
    expect(secs[0]).toBe(NET.reconnectSec); // starts at the full 30 s
    sent.length = 0;
    core.reconnect('b');
    expect(core.state).toBe('live');
    tick(3); // events queued by the state change go out with the next tick
    expect(sent.some((s) => s.key === 'b' && s.type === NET_MSG.WELCOME)).toBe(true); // fresh state for the returning client
    expect(events('a').some((e) => e.t === 'match' && e.state === 'live')).toBe(true);
    const n = core.tickNo;
    tick(30);
    expect(core.tickNo).toBeGreaterThan(n + 20);
  });
  it('forfeits after 30 s without a reconnect', () => {
    const { core, hb, live, events } = duel();
    core.disconnect('b');
    live(60 * 29, ['a']);
    expect(core.state).toBe('paused');
    live(60 * 2, ['a']);
    expect(core.state).toBe('ended');
    expect(events('a').some((e) => e.t === 'match' && e.state === 'forfeit' && e.who === hb.actor.index)).toBe(true);
  });
  it('traffic from a connection written off as lost counts as a reconnect', () => {
    const { core, tick, t } = duel();
    t.now += NET.silenceMs + 200; // total silence from both
    core.advance();
    expect(core.state).toBe('paused');
    core.onMessage('a', NET_MSG.INPUT, batch(1, input()));
    core.onMessage('b', NET_MSG.INPUT, batch(1, input()));
    expect(core.state).toBe('live');
    tick(5);
  });
  it('silence of 3 s is treated as a lost connection', () => {
    const { core, tick, t } = duel();
    for (let i = 0; i < 100; i++) { core.onMessage('a', NET_MSG.INPUT, batch(1, input({}, 9000 + i))); tick(1); }
    expect(core.state).toBe('live');
    // only A keeps talking
    for (let i = 0; i < 60 * 4; i++) { core.onMessage('a', NET_MSG.INPUT, batch(1, input({}, 9200 + i))); t.now += 0; tick(1); }
    expect(core.humans.get('b')!.connected).toBe(false);
    expect(core.state).toBe('paused');
  });
  it('leaving removes the player and ends an empty room', () => {
    const { core } = duel();
    core.leave('a');
    expect(core.humans.size).toBe(1);
    core.leave('b');
    expect(core.state).toBe('ended');
  });
});

describe('pickups over the wire', () => {
  it('pads announce their stock after 3 s, and a taken pad is announced as empty', () => {
    const { core, ha, tick, live, events } = duel();
    live(60 * 4);
    const pads = events('a').filter((e): e is Extract<WireEvent, { t: 'pad' }> => e.t === 'pad');
    expect(pads.filter((p) => p.item !== null).length).toBeGreaterThanOrEqual(7);
    const centre = core.sim.pickups.find((p) => p.x === 0 && p.z === 0)!;
    ha.actor.body.pos.x = 0; ha.actor.body.pos.z = 0; ha.actor.body.pos.y = 0.05;
    core.onMessage('a', NET_MSG.INPUT, batch(core.clock(), input({}, 7000)));
    tick(10);
    const after = events('a').filter((e): e is Extract<WireEvent, { t: 'pad' }> => e.t === 'pad' && e.id === centre.id);
    expect(after[after.length - 1]!.item).toBeNull();
    expect(events('a').some((e) => e.t === 'pickup')).toBe(true);
  });
});
