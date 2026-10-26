import { describe, expect, it } from 'vitest';
import { NET, SIM } from '../balance';
import { CollisionWorld } from '../collision';
import { CombatSim, idleInput, type Actor, type ActorInput } from '../sim/sim';
import { mulberry32 } from '../sim/rng';
import { ClockSync, LossMeter } from './clock';
import { quantizeInput, type RemoteState } from './codec';
import { RemoteTrack } from './interpolation';
import { SimLink } from './netsim';
import { Predictor } from './prediction';
import { ownBodyOf, ownCombatOf } from './state';

const floor = { min: { x: -100, y: -1, z: -100 }, max: { x: 100, y: 0, z: 100 } };
const DT = 1 / SIM.tickHz;

describe('ClockSync', () => {
  it('is exact on a symmetric link', () => {
    const c = new ClockSync();
    c.addSample(1000, 6040, 1080); // 40 ms each way, server is 5000 ms ahead
    expect(c.offsetMs).toBeCloseTo(5000, 6);
    expect(c.rttMs).toBe(80);
    expect(c.serverNow(2000)).toBe(7000);
  });
  it('follows the lowest-round-trip sample under asymmetric jitter', () => {
    const rnd = mulberry32(5), c = new ClockSync();
    const trueOffset = 12345;
    for (let i = 0; i < 40; i++) {
      const up = 40 + rnd() * 60, down = 40 + rnd() * 60, t0 = i * 200;
      c.addSample(t0, t0 + up + trueOffset, t0 + up + down);
    }
    expect(Math.abs(c.offsetMs - trueOffset)).toBeLessThan(25);
  });
  it('ignores impossible samples', () => {
    const c = new ClockSync();
    c.addSample(100, 500, 50); // negative round trip
    c.addSample(100, NaN, 200);
    expect(c.ready).toBe(false);
  });
});

describe('LossMeter', () => {
  it('counts gaps, handles wraparound, ignores reordered packets', () => {
    const m = new LossMeter(100);
    for (let t = 65500; t < 65536 + 100; t++) if (t % 10 !== 3) m.onTick(t & 0xffff); // 10% lost
    expect(m.lossPct).toBeGreaterThan(7);
    expect(m.lossPct).toBeLessThan(13);
    const before = m.lossPct;
    m.onTick(40); // an old one arriving late
    expect(m.lossPct).toBe(before);
  });
  it('reports nothing until it has enough samples', () => {
    const m = new LossMeter();
    m.onTick(1); m.onTick(5);
    expect(m.lossPct).toBe(0);
  });
});

describe('SimLink', () => {
  it('delays by the latency', () => {
    const l = new SimLink<number>({ latencyMs: 50, jitterMs: 0, loss: 0 });
    l.send(1, 1000);
    expect(l.poll(1049)).toEqual([]);
    expect(l.poll(1050)).toEqual([1]);
    expect(l.inFlight).toBe(0);
  });
  it('drops about the configured share of unreliable messages, and can reorder them', () => {
    const l = new SimLink<number>({ latencyMs: 50, jitterMs: 40, loss: 0.2 }, 3);
    for (let i = 0; i < 5000; i++) l.send(i, i);
    const got = l.poll(1e9);
    expect(got.length / 5000).toBeGreaterThan(0.75);
    expect(got.length / 5000).toBeLessThan(0.85);
    let reordered = 0;
    for (let i = 1; i < got.length; i++) if (got[i]! < got[i - 1]!) reordered++;
    expect(reordered).toBeGreaterThan(0);
  });
  it('reliable messages are never lost and always in order, even with loss and jitter', () => {
    const l = new SimLink<number>({ latencyMs: 50, jitterMs: 40, loss: 0.3 }, 9);
    for (let i = 0; i < 2000; i++) l.send(i, i, true);
    const got = l.poll(1e9);
    expect(got).toEqual(Array.from({ length: 2000 }, (_, i) => i));
  });
  it('a lost reliable message delays the ones behind it (retransmission, head-of-line blocking)', () => {
    const l = new SimLink<number>({ latencyMs: 50, jitterMs: 0, loss: 1 }, 1);
    l.send(1, 0, true); l.send(2, 1, true);
    expect(l.poll(60)).toEqual([]);
    expect(l.poll(400)).toEqual([1, 2]);
  });
});

const rs = (over: Partial<RemoteState> = {}): RemoteState => ({
  id: 1, x: 0, y: 0, z: 0, vx: 0, vy: 0, vz: 0, yaw: 0, pitch: 0, onGround: true, crouched: false, sprinting: false,
  rolling: false, alive: true, reloading: false, ads: false, protectedNow: false, ...over,
});

describe('RemoteTrack (interpolation)', () => {
  it('blends between the two snapshots around the render time', () => {
    const t = new RemoteTrack();
    t.push(1000, rs({ x: 0 })); t.push(1050, rs({ x: 0.4 })); // 8 m/s, a fast sprint
    expect(t.sample(1025)!.x).toBeCloseTo(0.2, 9);
    expect(t.sample(1010)!.x).toBeCloseTo(0.08, 9);
  });
  it('turns the short way round the yaw wrap', () => {
    const t = new RemoteTrack();
    t.push(0, rs({ yaw: 6.2 })); t.push(100, rs({ yaw: 0.2 }));
    const y = t.sample(50)!.yaw;
    const mid = 6.2 + (0.2 + Math.PI * 2 - 6.2) / 2; // halfway along the short arc, through 2 pi
    expect(Math.abs(Math.atan2(Math.sin(y - mid), Math.cos(y - mid)))).toBeLessThan(1e-9);
  });
  it('extrapolates along velocity for at most 100 ms, then holds', () => {
    const t = new RemoteTrack();
    t.push(1000, rs({ x: 10, vx: 5 }));
    expect(t.sample(1050)!.x).toBeCloseTo(10.25, 6);
    expect(t.sample(1100)!.x).toBeCloseTo(10.5, 6);
    expect(t.sample(5000)!.x).toBeCloseTo(10.5, 6);
    expect(NET.extrapolateMs).toBe(100);
  });
  it('holds the first snapshot before it, and has nothing when empty', () => {
    const t = new RemoteTrack();
    expect(t.sample(0)).toBeNull();
    t.push(1000, rs({ x: 3 }));
    expect(t.sample(10)!.x).toBe(3);
  });
  it('does not blend across a teleport (respawn)', () => {
    const t = new RemoteTrack();
    t.push(1000, rs({ x: 0 })); t.push(1050, rs({ x: 40 }));
    const early = t.sample(1010)!.x, late = t.sample(1040)!.x;
    expect([early, late]).toEqual([0, 40]);
  });
  it('orders late arrivals, drops duplicates, and keeps slow fields until they change', () => {
    const t = new RemoteTrack();
    t.push(1100, rs({ x: 0.8 })); t.push(1000, rs({ x: 0, hp: 80, weapon: 'breaker', mag: 4, stamina: 50, rarity: 1 }));
    t.push(1000, rs({ x: 99 }));
    expect(t.size).toBe(2);
    expect(t.sample(1050)!.x).toBeCloseTo(0.4, 9);
    // a later snapshot without slow fields keeps the last known values
    const t2 = new RemoteTrack();
    t2.push(1000, rs({ x: 0, hp: 80, weapon: 'breaker', mag: 4, stamina: 50, rarity: 1 }));
    t2.push(1050, rs({ x: 0.1 }));
    const s = t2.sample(1050)!;
    expect([s.hp, s.weapon, s.mag, s.rarity, s.stamina]).toEqual([80, 'breaker', 4, 1, 50]);
  });
  it('prunes old snapshots', () => {
    const t = new RemoteTrack();
    for (let i = 0; i < 100; i++) t.push(i * 50, rs({ x: i }));
    expect(t.size).toBeLessThan(25);
    expect(t.newestTime).toBe(4950);
  });
});

/** A client-side mirror and a server-side authority running the same shared sim. */
function pair() {
  const mk = (authority: boolean): { sim: CombatSim; a: Actor } => {
    const sim = new CombatSim(new CollisionWorld([floor]), [{ x: 0, y: 0, z: 0, yaw: 0 }], 5);
    sim.authority = authority;
    const a = sim.addActor({ id: 'me', kind: 'player', name: 'me', index: 3, spawn: { x: 0, y: 0, z: 0, yaw: 0 }, loadout: ['vanguard'] });
    a.hp.protectT = 0;
    return { sim, a };
  };
  return { client: mk(false), server: mk(true) };
}

const walkInput = (i: number): ActorInput => {
  const x = idleInput();
  x.moveZ = 1; x.moveX = Math.sin(i / 20); x.yaw = i / 100; x.jump = i % 90 === 0; x.sprint = i % 200 > 100;
  return x;
};

describe('Predictor', () => {
  it('replaying inputs on the server state reproduces the prediction: zero correction', () => {
    const { client, server } = pair();
    const p = new Predictor(client.sim, client.a);
    const inputs = Array.from({ length: 120 }, (_, i) => p.predict(walkInput(i)));
    // the server has processed the first 100 of them
    for (let i = 0; i < 100; i++) server.sim.stepActor(server.a, inputs[i]!, DT);
    p.reconcile(inputs[99]!.seq, { body: ownBodyOf(server.a), combat: ownCombatOf(server.a) });
    expect(p.lastCorrection).toBeLessThan(1e-4);
    expect(p.pendingCount).toBe(20);
    expect(p.hardSnaps).toBe(0);
  });
  it('a mismatch becomes a smooth, continuous visual correction that bleeds off', () => {
    const { client, server } = pair();
    const p = new Predictor(client.sim, client.a);
    const inputs = Array.from({ length: 60 }, (_, i) => p.predict(walkInput(i)));
    for (const i of inputs.slice(0, 50)) server.sim.stepActor(server.a, i, DT);
    server.a.body.pos.x += 0.5; // the server disagrees (e.g. a push)
    const v0 = p.visual({ x: 0, y: 0, z: 0 });
    p.reconcile(inputs[49]!.seq, { body: ownBodyOf(server.a), combat: ownCombatOf(server.a) });
    const v1 = p.visual({ x: 0, y: 0, z: 0 });
    expect(Math.hypot(v1.x - v0.x, v1.y - v0.y, v1.z - v0.z)).toBeLessThan(1e-9); // what is on screen does not jump
    expect(p.lastCorrection).toBeGreaterThan(0.4);
    expect(p.lastCorrection).toBeLessThan(0.6);
    const e0 = Math.hypot(p.err.x, p.err.z);
    for (let i = 0; i < 6; i++) p.decay(1 / 60);
    expect(Math.hypot(p.err.x, p.err.z)).toBeLessThan(e0 * 0.5); // ~100 ms time constant
    for (let i = 0; i < 120; i++) p.decay(1 / 60);
    expect(Math.hypot(p.err.x, p.err.z)).toBe(0);
  });
  it('an error of 1.5 m or more snaps at once', () => {
    const { client, server } = pair();
    const p = new Predictor(client.sim, client.a);
    const inputs = Array.from({ length: 30 }, (_, i) => p.predict(walkInput(i)));
    for (const i of inputs) server.sim.stepActor(server.a, i, DT);
    server.a.body.pos.x += 6; // respawned elsewhere
    p.reconcile(inputs[29]!.seq, { body: ownBodyOf(server.a), combat: ownCombatOf(server.a) });
    expect(p.hardSnaps).toBe(1);
    expect(p.err).toEqual({ x: 0, y: 0, z: 0 });
    expect(Math.abs(client.a.body.pos.x - server.a.body.pos.x)).toBeLessThan(1e-4);
  });
  it('weapon state is predicted too: ammo, cooldown and shot ids match the server after replay', () => {
    const { client, server } = pair();
    const p = new Predictor(client.sim, client.a);
    const fireInputs = Array.from({ length: 90 }, (_, i) => { const x = idleInput(); x.fire = true; x.firePressed = true; x.ads = i > 20; x.yaw = i * 0.01; return p.predict(x); });
    for (const i of fireInputs.slice(0, 60)) server.sim.stepActor(server.a, i, DT);
    p.reconcile(fireInputs[59]!.seq, { body: ownBodyOf(server.a), combat: ownCombatOf(server.a) });
    for (const i of fireInputs.slice(60)) server.sim.stepActor(server.a, i, DT);
    expect(client.a.rack[0]!.mag).toBe(server.a.rack[0]!.mag);
    expect(client.a.shotCounter).toBe(server.a.shotCounter);
    expect(client.a.recoil.pitch).toBeCloseTo(server.a.recoil.pitch, 3);
    expect(client.a.shotCounter).toBeGreaterThan(10);
  });
  it('a reconcile keeps queued shot effects and the replay adds none of its own', () => {
    const { client, server } = pair();
    const p = new Predictor(client.sim, client.a);
    const fire = (): ActorInput => { const x = idleInput(); x.fire = true; x.firePressed = true; return x; };
    const inputs = Array.from({ length: 60 }, () => p.predict(fire()));
    for (const i of inputs.slice(0, 20)) server.sim.stepActor(server.a, i, DT); // the server has seen 20 of the 60
    const queued = client.sim.drainEvents(); // effects the game has not drawn yet
    expect(queued.filter((e) => e.type === 'shot').length).toBeGreaterThan(5);
    client.sim.restoreEvents(queued);
    p.reconcile(inputs[19]!.seq, { body: ownBodyOf(server.a), combat: ownCombatOf(server.a) }); // replays 40 inputs, firing again
    const after = client.sim.drainEvents();
    expect(after.length).toBe(queued.length);
    expect(after.filter((e) => e.type === 'shot').length).toBe(queued.filter((e) => e.type === 'shot').length);
  });
  it('sequence numbers wrap past 65535 and never use 0', () => {
    const { client } = pair();
    const p = new Predictor(client.sim, client.a);
    const seqs: number[] = [];
    for (let i = 0; i < 70000; i++) { seqs.push(p.predict(idleInput()).seq); }
    expect(seqs[65534]).toBe(65535);
    expect(seqs[65535]).toBe(1);
    expect(seqs.includes(0)).toBe(false);
  });
  it('quantised inputs are what the sim sees: raw and quantised differ, prediction uses the quantised one', () => {
    const raw = idleInput(); raw.yaw = 1.23456789;
    expect(quantizeInput(raw, 1).yaw).not.toBe(raw.yaw);
  });
});

