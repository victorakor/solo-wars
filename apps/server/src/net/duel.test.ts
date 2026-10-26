import { describe, expect, it } from 'vitest';
import { NET, SIM, idleInput, type ActorInput } from '@arena/shared';
import { Rig, TICK_MS, type Peer } from './testkit';

/** Spec exit criterion: two clients duel over a simulated link (150 ms, 5% loss) and hits are fair. */
const LINKS = [
  { name: 'LAN', rtt: 0, loss: 0 },
  { name: '80 ms / 2% loss', rtt: 80, loss: 0.02 },
  { name: '150 ms / 5% loss', rtt: 150, loss: 0.05 },
  { name: '250 ms / 5% loss', rtt: 250, loss: 0.05 },
] as const;
const link = (rtt: number, loss: number) => ({ latencyMs: rtt / 2, jitterMs: rtt * 0.1, loss });

const walker = (seed: number) => (tick: number): ActorInput => {
  const i = idleInput();
  i.moveZ = Math.sin(tick / 90 + seed) > -0.3 ? 1 : -1; i.moveX = Math.cos(tick / 37 + seed); i.yaw = tick / 150 + seed;
  i.jump = tick % 110 === 0; i.sprint = Math.sin(tick / 200) > 0.2; i.crouch = tick % 400 > 360; i.dodge = tick % 331 === 0;
  return i;
};

/** Aim at where the other player appears on this client's screen, cancelling recoil like a steady hand. */
const gunner = (): ((t: number, p: Peer) => ActorInput) => (_t, p) => {
  const i = idleInput();
  const net = p.net;
  if (!net) return i;
  const foe = net.sim.actors.find((x) => x !== net.me && x.kind === 'player');
  i.ads = true;
  if (!foe) return i;
  const eye = { x: net.me.body.pos.x, y: net.me.body.pos.y + 1.6, z: net.me.body.pos.z };
  const dx = foe.body.pos.x - eye.x, dy = foe.body.pos.y + 1.0 - eye.y, dz = foe.body.pos.z - eye.z;
  i.yaw = Math.atan2(-dx, -dz); i.pitch = Math.atan2(dy, Math.hypot(dx, dz));
  i.fire = true; i.firePressed = true;
  i.aimYaw = i.yaw - net.me.recoil.yaw; i.aimPitch = i.pitch - net.me.recoil.pitch;
  return i;
};

/** B strafes across the line of fire at running speed. */
const strafer = (tick: number): ActorInput => {
  const i = idleInput();
  i.yaw = Math.PI / 2; i.moveX = Math.floor(tick / 30) % 2 ? 1 : -1;
  return i;
};

/** Puts A and B on the clear lane and keeps B alive and inside the lane so the run is a clean measurement. */
function pinDuel(rig: Rig): void {
  rig.onTick = () => {
    const a = rig.core.humans.get('a'), b = rig.core.humans.get('b');
    if (!a || !b) return;
    if (rig.tick === 5) { a.actor.body.pos.x = -24; a.actor.body.pos.z = 0; b.actor.body.pos.x = -9; b.actor.body.pos.z = 0; }
    b.actor.hp.hp = 100; b.actor.hp.alive = true; b.actor.hp.protectT = 0; a.actor.hp.hp = 100; a.actor.hp.protectT = 0;
    if (Math.abs(b.actor.body.pos.z) > 6) b.actor.body.pos.z = Math.sign(b.actor.body.pos.z) * 6;
  };
}

describe('connecting', () => {
  it('both clients get a welcome, sync their clocks within a few ms, and go live (150 ms link)', () => {
    const rig = new Rig();
    const a = rig.addPeer('a', link(150, 0.05)), b = rig.addPeer('b', link(150, 0.05));
    rig.run(3000);
    expect(rig.core.state).toBe('live');
    for (const p of [a, b]) {
      expect(p.net).not.toBeNull();
      expect(p.net!.ready).toBe(true);
      expect(p.net!.status).toBe('connected');
      const err = p.net!.clock.serverNow(rig.clientNow(p)) - rig.core.clock();
      expect(Math.abs(err)).toBeLessThan(15); // despite client clocks that are tens of seconds off
      expect(p.net!.rttMs).toBeGreaterThan(120);
      expect(p.net!.rttMs).toBeLessThan(260);
    }
  });
  it('each client mirrors the other player by name', () => {
    const rig = new Rig();
    const a = rig.addPeer('a', link(80, 0)), b = rig.addPeer('b', link(80, 0));
    rig.run(1000);
    expect(a.net!.sim.actors.map((x) => x.name).sort()).toEqual(['Player a', 'Player b']);
    expect(b.net!.me.name).toBe('Player b');
  });
});

describe('client-side prediction', () => {
  for (const l of LINKS) {
    it(`stays accurate while running, jumping, rolling and sprinting over ${l.name}`, () => {
      const rig = new Rig({ seed: 3 });
      const a = rig.addPeer('a', link(l.rtt, l.loss), 'vanguard', walker(1));
      rig.addPeer('b', link(l.rtt, l.loss), 'vanguard', walker(2));
      const corr: number[] = [];
      let last = -1;
      rig.onTick = () => {
        const n = a.net;
        if (n && rig.tick > 180 && n.predictor.reconciles !== last) { last = n.predictor.reconciles; corr.push(n.predictor.lastCorrection); }
      };
      rig.run(30000);
      corr.sort((x, y) => x - y);
      const p99 = corr[Math.floor(corr.length * 0.99)]!, max = corr[corr.length - 1]!;
      expect(a.net!.predictor.hardSnaps).toBeLessThanOrEqual(1); // only the initial placement
      expect(p99).toBeLessThan(l.loss === 0 ? 0.01 : 0.08);
      expect(max).toBeLessThan(0.25);
      expect(corr[Math.floor(corr.length * 0.5)]).toBeLessThan(0.001); // the usual correction is nothing at all
    });
  }
  it('the server does not run a player ahead of real time: inputs processed track ticks', () => {
    const rig = new Rig();
    const a = rig.addPeer('a', link(150, 0.05), 'vanguard', walker(1));
    rig.addPeer('b', link(150, 0.05), 'vanguard', walker(2));
    rig.run(20000);
    const h = rig.core.humans.get('a')!;
    expect(h.inputsProcessed).toBeLessThanOrEqual(rig.tick);
    expect(h.inputsProcessed).toBeGreaterThan(rig.tick * 0.97);
    expect(a.net!.predictor.pendingCount).toBeLessThan(30);
  });
});

describe('lag compensation: hits are fair', () => {
  function duelHits(rtt: number, loss: number, compensate: boolean, seed = 7) {
    const rig = new Rig({ seed });
    const a = rig.addPeer('a', link(rtt, loss), 'vanguard', gunner());
    rig.addPeer('b', link(rtt, loss), 'vanguard', strafer);
    if (!compensate) rig.core.sim.rewind = null;
    pinDuel(rig);
    rig.run(20000);
    const st = rig.core.humans.get('a')!.actor.stats;
    return { fired: st.shotsFired, hit: st.shotsHit, rate: st.shotsHit / Math.max(1, st.shotsFired), seen: a.predictedHits, sent: a.predictedShots };
  }
  for (const l of LINKS) {
    it(`registers 90%+ of shots aimed at a strafing target over ${l.name}`, () => {
      const r = duelHits(l.rtt, l.loss, true);
      expect(r.fired).toBeGreaterThan(80);
      expect(r.rate).toBeGreaterThan(0.9);
    });
  }
  it('without compensation the same shots mostly miss (so the rewind is what makes them land)', () => {
    const on = duelHits(150, 0.05, true), off = duelHits(150, 0.05, false);
    expect(off.rate).toBeLessThan(0.4);
    expect(on.rate).toBeGreaterThan(off.rate + 0.5);
  });
  it('what the shooter saw is what the server decides: server hits match the shooter\'s own view', () => {
    const r = duelHits(150, 0.05, true);
    expect(r.hit).toBeGreaterThanOrEqual(r.seen * 0.9);
    expect(r.hit).toBeLessThanOrEqual(r.seen * 1.1 + 2);
  });
  it('the shooter is told about hits (hit confirmation events) and the victim about damage', () => {
    const rig = new Rig({ seed: 3 });
    const a = rig.addPeer('a', link(150, 0.05), 'vanguard', gunner());
    const b = rig.addPeer('b', link(150, 0.05), 'vanguard', strafer);
    pinDuel(rig);
    let confirms = 0, damage = 0;
    rig.onEvents = (p, events) => {
      for (const e of events) {
        if (p === a && e.type === 'hit') confirms++;
        if (p === b && e.type === 'damage') damage++;
      }
    };
    rig.run(10000);
    const hits = rig.core.humans.get('a')!.actor.stats.shotsHit;
    expect(hits).toBeGreaterThan(30);
    expect(confirms).toBeGreaterThanOrEqual(hits - 3); // all but the last few still in flight
    expect(confirms).toBeLessThanOrEqual(hits);
    expect(damage).toBeGreaterThan(0);
  });
});

describe('what the other player looks like', () => {
  it('a remote player is drawn where the server had them 100 ms of render delay ago (within 25 cm at 150 ms / 5% loss)', () => {
    const rig = new Rig({ seed: 5 });
    const a = rig.addPeer('a', link(150, 0.05), 'vanguard', walker(1));
    rig.addPeer('b', link(150, 0.05), 'vanguard', walker(2));
    const errs: number[] = [];
    const bId = rig.core.humans.get('b')!.actor.index;
    rig.onTick = () => {
      const n = a.net;
      if (!n || rig.tick < 300 || rig.tick % 5) return;
      const mirror = n.sim.actors.find((x) => x.index === bId)!;
      const truth = rig.truthAt('b', n.renderTime(rig.clientNow(a)));
      if (truth) errs.push(Math.hypot(mirror.body.pos.x - truth.x, mirror.body.pos.z - truth.z));
    };
    rig.run(25000);
    errs.sort((x, y) => x - y);
    expect(errs.length).toBeGreaterThan(200);
    expect(errs[Math.floor(errs.length * 0.9)]).toBeLessThan(0.25);
    expect(errs[Math.floor(errs.length * 0.5)]).toBeLessThan(0.1);
  });
});

describe('bandwidth', () => {
  it('stays inside the budget while both players run and shoot (30 kbps down, 15 kbps up)', () => {
    const rig = new Rig();
    const a = rig.addPeer('a', link(150, 0.05), 'vanguard', gunner());
    const b = rig.addPeer('b', link(150, 0.05), 'vanguard', strafer);
    pinDuel(rig);
    rig.run(20000);
    for (const p of [a, b]) {
      expect(p.downBytes * 8 / 20 / 1000).toBeLessThan(NET.budgetDownKbps);
      expect(p.upBytes * 8 / 20 / 1000).toBeLessThan(NET.budgetUpKbps);
    }
  });
  it('two humans plus two bots still fit the downstream budget', () => {
    const rig = new Rig({ bots: 2, minHumans: 2 });
    const a = rig.addPeer('a', link(80, 0.02), 'vanguard', walker(1));
    const b = rig.addPeer('b', link(80, 0.02), 'vanguard', walker(2));
    rig.run(20000);
    expect(rig.core.sim.actors.filter((x) => x.kind === 'bot')).toHaveLength(2);
    for (const p of [a, b]) {
      expect(p.downBytes * 8 / 20 / 1000).toBeLessThan(NET.budgetDownKbps);
      expect(p.upBytes * 8 / 20 / 1000).toBeLessThan(NET.budgetUpKbps);
    }
  });
});

describe('pickups and combat events reach both clients', () => {
  it('pad stock, takings and drops are mirrored on each client', () => {
    const rig = new Rig({ seed: 11 });
    const a = rig.addPeer('a', link(80, 0.02), 'vanguard', walker(1));
    const b = rig.addPeer('b', link(80, 0.02), 'vanguard', walker(2));
    rig.run(20000);
    for (const p of [a, b]) {
      const mirror = p.net!.sim.pickups, truth = rig.core.sim.pickups;
      expect(mirror.length).toBe(truth.length);
      for (const t of truth) {
        const m = mirror.find((x) => x.id === t.id)!;
        expect(m).toBeDefined();
        expect([m.state?.id, m.state?.rarity]).toEqual([t.state?.id, t.state?.rarity]);
      }
    }
  });
  it('kills, respawns and scores arrive: a full duel plays out on both screens', () => {
    const rig = new Rig({ seed: 2 });
    const a = rig.addPeer('a', link(150, 0.05), 'vanguard', gunner());
    const b = rig.addPeer('b', link(150, 0.05), 'vanguard', strafer);
    rig.onTick = () => {
      const ha = rig.core.humans.get('a'), hb = rig.core.humans.get('b');
      if (!ha || !hb) return;
      if (rig.tick === 5) { ha.actor.body.pos.x = -24; ha.actor.body.pos.z = 0; hb.actor.body.pos.x = -9; hb.actor.body.pos.z = 0; }
      // B respawns at a hidden far spawn; put it back in the fight so the duel keeps going
      if (rig.tick > 10 && hb.actor.hp.alive && Math.abs(hb.actor.body.pos.x + 9) > 4) { hb.actor.body.pos.x = -9; hb.actor.body.pos.z = 0; hb.actor.body.pos.y = 0.05; }
      ha.actor.hp.hp = 100;
    };
    const kinds: Record<string, number> = {};
    rig.onEvents = (p, events) => { if (p === b) for (const e of events) kinds[e.type] = (kinds[e.type] ?? 0) + 1; };
    rig.run(25000);
    const sa = rig.core.humans.get('a')!.actor.stats, sb = rig.core.humans.get('b')!.actor.stats;
    expect(sa.kills).toBeGreaterThan(2);
    expect(sb.deaths).toBe(sa.kills);
    expect(kinds.kill).toBeGreaterThanOrEqual(sa.kills - 1);
    expect(kinds.respawn).toBeGreaterThanOrEqual(sa.kills - 1);
    // the scoreboard numbers the client shows come from the server
    const mirrorA = b.net!.sim.actors.find((x) => x.name === 'Player a')!;
    expect(mirrorA.stats.kills).toBeGreaterThanOrEqual(sa.kills - 1);
    expect(a.net!.me.hp.alive || rig.core.humans.get('a')!.actor.hp.alive).toBe(true);
  });
});

describe('bad networks and reconnecting', () => {
  it('a 1 s lag spike on the uplink is absorbed: the server catches up and the client settles', () => {
    const rig = new Rig({ seed: 6 });
    const a = rig.addPeer('a', link(100, 0.02), 'vanguard', walker(1));
    rig.addPeer('b', link(100, 0.02), 'vanguard', walker(2));
    rig.run(4000);
    rig.setLink(a, { latencyMs: 600 });
    rig.run(1000);
    rig.setLink(a, { latencyMs: 50 });
    rig.run(4000);
    const n = a.net!;
    expect(n.status).toBe('connected');
    expect(n.predictor.pendingCount).toBeLessThan(40); // no permanent backlog
    expect(rig.core.humans.get('a')!.queue.length).toBeLessThanOrEqual(NET.inputQueueMax);
    expect(n.predictor.lastCorrection).toBeLessThan(0.3);
  });
  it('a 4 s blackout pauses the match, shows reconnecting, and everything resumes when the network returns', () => {
    const rig = new Rig({ seed: 8 });
    const a = rig.addPeer('a', link(100, 0), 'vanguard', walker(1));
    const b = rig.addPeer('b', link(100, 0), 'vanguard', walker(2));
    rig.run(3000);
    rig.setLink(a, { loss: 1 }); // A hears nothing, and is not heard
    rig.run(4500);
    expect(a.net!.status).toBe('reconnecting');
    expect(rig.core.state).toBe('paused');
    expect(b.net!.matchState.state).toBe('paused');
    rig.setLink(a, { loss: 0 });
    rig.run(3000);
    expect(rig.core.state).toBe('live');
    expect(a.net!.status).toBe('connected');
    expect(b.net!.matchState.state).toBe('live');
    const t0 = rig.core.tickNo;
    rig.run(1000);
    expect(rig.core.tickNo).toBeGreaterThan(t0 + 50);
  });
  it('dropping the connection and returning with a token restores the match with fresh state', () => {
    const rig = new Rig({ seed: 9 });
    const a = rig.addPeer('a', link(100, 0.02), 'vanguard', walker(1));
    const b = rig.addPeer('b', link(100, 0.02), 'vanguard', walker(2));
    rig.run(5000);
    rig.dropPeer('a');
    rig.run(8000);
    expect(rig.core.state).toBe('paused');
    expect(b.net!.matchState.state).toBe('paused');
    expect(b.net!.matchState.secs).toBeLessThan(NET.reconnectSec);
    rig.returnPeer('a');
    rig.run(3000);
    expect(rig.core.state).toBe('live');
    expect(a.net!.status).toBe('connected');
    expect(a.net!.predictor.pendingCount).toBeLessThan(40);
    expect(a.net!.sim.pickups.length).toBe(rig.core.sim.pickups.length);
  });
  it('without a reconnect inside 30 s the absent player forfeits and the other is told', () => {
    const rig = new Rig({ seed: 10 });
    rig.addPeer('a', link(100, 0), 'vanguard', walker(1));
    const b = rig.addPeer('b', link(100, 0), 'vanguard', walker(2));
    rig.run(3000);
    rig.dropPeer('a');
    rig.run((NET.reconnectSec + 2) * 1000);
    expect(rig.core.state).toBe('ended');
    expect(b.net!.matchState.state).toBe('forfeit');
  });
  it('is deterministic: the same setup produces the same match', () => {
    const play = () => {
      const rig = new Rig({ seed: 12 });
      rig.addPeer('a', link(150, 0.05), 'vanguard', walker(1));
      rig.addPeer('b', link(150, 0.05), 'vanguard', walker(2));
      rig.run(10000);
      const h = rig.core.humans.get('a')!.actor;
      return JSON.stringify([h.body.pos, h.stats, rig.core.tickNo]);
    };
    expect(play()).toBe(play());
  });
});

describe('timing constants', () => {
  it('the harness ticks at the sim rate', () => {
    expect(TICK_MS).toBeCloseTo(1000 / SIM.tickHz, 9);
  });
});
