import {
  NetClient, NET_MSG, SIM, SCENES, SimLink, idleInput,
  type ActorInput, type CombatEvent, type LinkOptions, type Welcome,
} from '@arena/shared';
import { MatchCore, type CoreOptions } from './matchCore';

/** Test harness: real MatchCore + real NetClients over simulated links on a virtual clock (not shipped). */
export const TICK_MS = 1000 / SIM.tickHz;

interface Msg { type: string; payload: unknown }

export interface Peer {
  key: string;
  net: NetClient | null;
  up: SimLink<Msg>;
  down: SimLink<Msg>;
  /** Client clock = server clock + this, so clock sync has something real to estimate. */
  clockOffset: number;
  connected: boolean;
  script: (tick: number, peer: Peer) => ActorInput;
  upBytes: number;
  downBytes: number;
  upMsgs: number;
  downMsgs: number;
  /** Client-side record of shots it fired and whether its own view said they hit. */
  predictedShots: number;
  predictedHits: number;
}

export class Rig {
  clock = 100000; // virtual server-side ms
  tick = 0;
  readonly core: MatchCore;
  readonly peers: Peer[] = [];
  /** Runs once per virtual tick before the server steps (tests use it to pin things in place). */
  onTick: (() => void) | null = null;
  /** Receives every client's events right after the client drains them. */
  onEvents: ((p: Peer, events: CombatEvent[]) => void) | null = null;
  private nextSeed = 1;
  /** Server-side position history of every human, for comparing against what clients rendered. */
  readonly trail = new Map<string, { t: number; x: number; z: number }[]>();

  constructor(opts: Partial<CoreOptions> = {}) {
    this.core = new MatchCore({
      seed: 7, now: () => this.clock, send: (key, type, payload, reliable) => this.fromServer(key, type, payload, reliable),
      minHumans: 2, ...opts,
    });
  }

  private peer(key: string): Peer | undefined {
    return this.peers.find((p) => p.key === key);
  }

  private fromServer(key: string, type: string, payload: unknown, reliable: boolean): void {
    const p = this.peer(key);
    if (!p || !p.connected) return;
    const size = payload instanceof Uint8Array ? payload.length : JSON.stringify(payload).length;
    p.downBytes += size + 8; // + WebSocket frame and Colyseus header overhead
    p.downMsgs++;
    p.down.send({ type, payload }, this.clock, reliable);
  }

  /** Adds a human behind a link with the given one-way latency. */
  addPeer(key: string, link: LinkOptions, weapon = 'vanguard', script?: Peer['script']): Peer {
    const p: Peer = {
      key, net: null, connected: true, clockOffset: 31337.25 + this.peers.length * 977.5,
      up: new SimLink<Msg>(link, 11 + this.nextSeed++), down: new SimLink<Msg>(link, 101 + this.nextSeed++),
      script: script ?? (() => idleInput()), upBytes: 0, downBytes: 0, upMsgs: 0, downMsgs: 0, predictedShots: 0, predictedHits: 0,
    };
    this.peers.push(p);
    this.core.join(key, `Player ${key}`, weapon);
    return p;
  }

  /** The connection dies: nothing more is delivered either way (a closed socket), and the server is told. */
  dropPeer(key: string): void {
    const p = this.peer(key)!;
    p.connected = false;
    p.up.poll(Infinity);
    p.down.poll(Infinity);
    this.core.disconnect(key);
  }

  /** The player comes back with their reconnection token. */
  returnPeer(key: string): void {
    this.peer(key)!.connected = true;
    this.core.reconnect(key);
  }

  setLink(p: Peer, opts: Partial<LinkOptions>): void {
    Object.assign(p.up.opts, opts);
    Object.assign(p.down.opts, opts);
  }

  clientNow(p: Peer): number {
    return this.clock + p.clockOffset;
  }

  /** Runs for `ms` of virtual time, one server tick per iteration. */
  run(ms: number): void {
    const end = this.clock + ms;
    while (this.clock < end) this.stepOnce();
  }

  stepOnce(): void {
    this.clock += TICK_MS;
    this.tick++;
    for (const p of this.peers) {
      for (const m of p.up.poll(this.clock)) this.core.onMessage(p.key, m.type, m.payload);
    }
    this.onTick?.();
    this.core.advance();
    for (const [key, h] of this.core.humans) {
      let tr = this.trail.get(key);
      if (!tr) { tr = []; this.trail.set(key, tr); }
      tr.push({ t: this.core.clock(), x: h.actor.body.pos.x, z: h.actor.body.pos.z });
      if (tr.length > 1200) tr.shift();
    }
    for (const p of this.peers) {
      const now = this.clientNow(p);
      if (!p.connected) continue;
      for (const m of p.down.poll(this.clock)) {
        if (m.type === NET_MSG.WELCOME) {
          if (!p.net) {
            p.net = new NetClient(m.payload as Welcome, SCENES.foundry!, { send: (t, d, r) => this.toServer(p, t, d, r) }, now);
          } else p.net.resync(m.payload as Welcome, now);
        } else p.net?.handle(m.type, m.payload, now);
      }
      if (!p.net) continue;
      const inp = p.script(this.tick, p);
      p.net.tick(inp, now);
      p.net.update(now, TICK_MS / 1000);
      const evs = p.net.drainEvents();
      this.onEvents?.(p, evs);
      for (const e of evs) {
        if (e.type === 'shot' && e.actor === p.net.me.id) {
          p.predictedShots++;
          if (e.pellets.some((x) => x.kind === 'body' || x.kind === 'head')) p.predictedHits++;
        }
      }
    }
  }

  /** Where the server had `key` at server time `t` (ms), interpolated. */
  truthAt(key: string, t: number): { x: number; z: number } | null {
    const tr = this.trail.get(key);
    if (!tr || tr.length < 2) return null;
    for (let i = tr.length - 1; i > 0; i--) {
      if (tr[i - 1]!.t <= t) {
        const a = tr[i - 1]!, b = tr[i]!, k = b.t > a.t ? Math.min(1, (t - a.t) / (b.t - a.t)) : 0;
        return { x: a.x + (b.x - a.x) * k, z: a.z + (b.z - a.z) * k };
      }
    }
    return null;
  }

  private toServer(p: Peer, type: string, payload: unknown, reliable: boolean): void {
    if (!p.connected) return;
    const size = payload instanceof Uint8Array ? payload.length : JSON.stringify(payload).length;
    p.upBytes += size + 10; // client frames are masked: bigger header
    p.upMsgs++;
    p.up.send({ type, payload }, this.clock, reliable);
  }
}
