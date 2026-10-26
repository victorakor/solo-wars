import {
  BOT_PROFILES, BotBrain, CodecError, CollisionWorld, CombatSim, FOUNDRY, NET, NET_MSG, NO_ACTOR, PingSchema, SIM, TRAINING_RACK,
  addBotTo, asBytes, decodeInputBatch, encodeEvents, encodeSnapshot, eyeHeightOf, heightOf, itemOf, ownBodyOf, ownCombatOf,
  pickSpawn, remoteOf, resolveClientTime, seqNewer,
  type Actor, type ActorInput, type BotLevel, type CombatEvent, type HitTarget, type PickupInfo, type SceneDef, type WeaponId,
  type WireEvent, type WireInput, type Welcome,
} from '@arena/shared';

const DT = 1 / SIM.tickHz;
const DT_MS = 1000 / SIM.tickHz;
const SNAPSHOT_EVERY = SIM.tickHz / SIM.snapshotHz;
const STATS_EVERY = SIM.tickHz; // once a second
const SLOW_REFRESH_EVERY = 10; // slow fields are always resent every 10th snapshot, so a lost one heals within 0.5 s
const clamp = (v: number, lo: number, hi: number): number => Math.max(lo, Math.min(hi, v));

export type CoreState = 'waiting' | 'live' | 'paused' | 'ended';
/** What the transport should do with a client after a message. */
export type MessageVerdict = 'ok' | 'kick';

export interface CoreOptions {
  seed: number;
  scene?: SceneDef;
  /** Monotonic milliseconds. Real time in production, virtual in tests. */
  now: () => number;
  /** Transport send. `reliable` payloads must arrive in order; snapshots and pongs may be dropped. */
  send: (key: string, type: string, payload: Uint8Array | object, reliable: boolean) => void;
  bots?: number;
  botLevel?: BotLevel;
  /** Humans needed before the match goes live. */
  minHumans?: number;
}

interface Queued {
  inp: WireInput;
  /** Server clock (ms) the shooter was looking at for this input, before clamping. */
  renderTime: number;
}

interface Human {
  key: string;
  actor: Actor;
  queue: Queued[];
  credits: number;
  lastSeq: number;
  /** Newest input processed: echoed in snapshots so the client knows what to replay. */
  ack: number;
  connected: boolean;
  lastMsgAt: number;
  disconnectedAt: number;
  tokens: number;
  pingTokens: number;
  refilledAt: number;
  dropped: number;
  malformed: number;
  /** Last slow-field signature sent per remote actor. */
  slowSent: Map<number, string>;
  events: WireEvent[];
  bytesOut: number;
  bytesIn: number;
  inputsProcessed: number;
}

interface HistoryEntry {
  t: number;
  actors: { id: string; x: number; y: number; z: number; height: number; eye: number; alive: boolean; epoch: number }[];
}

/**
 * Authoritative match logic with no transport and no framework: the Colyseus room is a thin adapter around it,
 * and the network tests drive it directly over a simulated link.
 *
 * Authority model (spec 4, 9): clients send inputs only. The server runs the same shared sim, one input per player
 * per tick (with a bounded catch-up budget so nobody can run faster than real time), resolves hits with the target
 * rewound to what the shooter saw, and replies with snapshots and events.
 */
export class MatchCore {
  readonly sim: CombatSim;
  readonly humans = new Map<string, Human>();
  state: CoreState = 'waiting';
  tickNo = 0;
  /** Counters for tests and /metrics. */
  readonly counters = { rewound: 0, snapshotsSent: 0, messagesDropped: 0, malformed: 0 };

  private bots: { actor: Actor; brain: BotBrain }[] = [];
  private botSeq = 0;
  private history: HistoryEntry[] = [];
  private pickupKeys = new Map<number, string>();
  private epochMs: number;
  private lastAdvance: number;
  private acc = 0;
  private snapNo = 0;
  private botsAdded = false;
  private lastCountdown = -1;
  private readonly minHumans: number;
  private readonly world: CollisionWorld;
  private readonly scene: SceneDef;

  constructor(private opts: CoreOptions) {
    this.scene = opts.scene ?? FOUNDRY;
    this.world = new CollisionWorld(this.scene.boxes);
    this.sim = new CombatSim(this.world, this.scene.spawns, opts.seed, this.scene.pads);
    this.sim.rewind = (shooter, renderTime) => this.rewindTargets(shooter, renderTime);
    this.minHumans = opts.minHumans ?? 2;
    this.epochMs = opts.now();
    this.lastAdvance = this.epochMs;
    for (const p of this.sim.pickups) this.pickupKeys.set(p.id, this.pickupKey(p.state));
  }

  /** Server clock in ms since the room started (what snapshots and pongs carry). */
  clock(): number {
    return Math.round(this.opts.now() - this.epochMs);
  }

  // --- joining and leaving ------------------------------------------------------------

  /** Adds a human. Returns null when the room is full. */
  join(key: string, name: string, weapon: string): Human | null {
    if (this.humans.has(key) || this.humans.size >= NET.maxHumans || this.state === 'ended') return null;
    const w: WeaponId = (TRAINING_RACK as readonly string[]).includes(weapon) ? (weapon as WeaponId) : 'vanguard';
    const eyes = this.sim.actors.filter((a) => a.hp.alive).map((a) => ({ x: a.body.pos.x, y: a.body.pos.y + eyeHeightOf(a.body), z: a.body.pos.z }));
    const spawn = pickSpawn(this.world, this.sim.spawns, eyes);
    const actor = this.sim.addActor({ id: `h-${key}`, kind: 'player', name, spawn, loadout: [w] });
    const now = this.opts.now();
    const h: Human = {
      key, actor, queue: [], credits: 1, lastSeq: 0, ack: 0, connected: true, lastMsgAt: now, disconnectedAt: 0,
      tokens: NET.maxInMessagesPerSec, pingTokens: NET.maxPingsPerSec, refilledAt: now, dropped: 0, malformed: 0,
      slowSent: new Map(), events: [], bytesOut: 0, bytesIn: 0, inputsProcessed: 0,
    };
    this.humans.set(key, h);
    this.sendWelcome(h);
    this.broadcastRoster();
    if (this.state === 'waiting' && this.humans.size >= this.minHumans) this.goLive();
    return h;
  }

  /** The player left for good (or was kicked). */
  leave(key: string): void {
    const h = this.humans.get(key);
    if (!h) return;
    this.sim.removeActor(h.actor.id);
    this.humans.delete(key);
    this.broadcastRoster();
    if (this.humans.size === 0) this.state = 'ended';
    else this.refreshPause();
  }

  /** The connection dropped. The match pauses for up to `NET.reconnectSec` waiting for them. */
  disconnect(key: string): void {
    const h = this.humans.get(key);
    if (!h || !h.connected) return;
    h.connected = false;
    h.disconnectedAt = this.opts.now();
    h.queue.length = 0;
    if (this.state === 'live') {
      this.state = 'paused';
      this.lastCountdown = -1;
      this.pushAll({ t: 'match', state: 'paused', who: h.actor.index, secs: NET.reconnectSec });
    }
  }

  /** They are back (token reconnect, or traffic resumed on a connection we had written off). */
  reconnect(key: string): void {
    const h = this.humans.get(key);
    if (!h || h.connected) return;
    h.connected = true;
    h.lastMsgAt = this.opts.now();
    h.credits = 1;
    this.sendWelcome(h);
    this.refreshPause();
  }

  private refreshPause(): void {
    if (this.state !== 'paused') return;
    if ([...this.humans.values()].every((x) => x.connected)) {
      this.state = 'live';
      this.lastAdvance = this.opts.now();
      this.acc = 0;
      this.pushAll({ t: 'match', state: 'live', who: 0, secs: 0 });
    }
  }

  private goLive(): void {
    this.state = 'live';
    if (!this.botsAdded) {
      this.botsAdded = true;
      for (let i = 0; i < Math.min(this.opts.bots ?? 0, NET.maxBots); i++) this.addBot(this.opts.botLevel ?? 'medium');
    }
    this.lastAdvance = this.opts.now();
    this.pushAll({ t: 'match', state: 'live', who: 0, secs: 0 });
  }

  private addBot(level: BotLevel): void {
    const actor = addBotTo(this.sim, this.opts.seed, ++this.botSeq, level);
    this.bots.push({ actor, brain: new BotBrain(BOT_PROFILES[level], this.opts.seed * 131 + this.botSeq, actor.view.yaw) });
    this.broadcastRoster();
  }

  // --- messages from clients ----------------------------------------------------------

  /** Handles one client message. Everything is validated; nothing a client sends can throw. */
  onMessage(key: string, type: string, data: unknown): MessageVerdict {
    const h = this.humans.get(key);
    if (!h) return 'ok';
    const now = this.opts.now();
    const elapsed = (now - h.refilledAt) / 1000;
    h.refilledAt = now;
    h.tokens = Math.min(NET.maxInMessagesPerSec, h.tokens + elapsed * NET.maxInMessagesPerSec);
    h.pingTokens = Math.min(NET.maxPingsPerSec, h.pingTokens + elapsed * NET.maxPingsPerSec);

    if (type === NET_MSG.PING) {
      if (h.pingTokens < 1) return this.dropMessage(h);
      h.pingTokens -= 1;
    } else {
      if (h.tokens < 1) return this.dropMessage(h);
      h.tokens -= 1;
    }
    h.dropped = 0;
    h.lastMsgAt = now;
    if (!h.connected) this.reconnect(key); // traffic resumed on a connection we had given up on

    if (type === NET_MSG.PING) {
      const p = PingSchema.safeParse(data);
      if (p.success) this.opts.send(key, NET_MSG.PONG, { t: p.data.t, serverTime: this.clock() }, false);
      else this.noteMalformed(h);
    } else if (type === NET_MSG.HELLO) {
      this.sendWelcome(h); // the client may have missed the first one
    } else if (type === NET_MSG.INPUT) {
      this.onInput(h, data);
    } else {
      this.noteMalformed(h); // unknown message type
    }
    return 'ok';
  }

  private dropMessage(h: Human): MessageVerdict {
    h.dropped++;
    this.counters.messagesDropped++;
    return h.dropped > NET.kickAfterDropped ? 'kick' : 'ok';
  }

  private noteMalformed(h: Human): void {
    h.malformed++;
    this.counters.malformed++;
  }

  private onInput(h: Human, data: unknown): void {
    const bytes = asBytes(data);
    if (!bytes) { this.noteMalformed(h); return; }
    h.bytesIn += bytes.length;
    let batch;
    try { batch = decodeInputBatch(bytes); } catch (e) {
      if (e instanceof CodecError) { this.noteMalformed(h); return; }
      throw e;
    }
    const est = resolveClientTime(batch.serverTimeLow, this.clock());
    const n = batch.inputs.length;
    for (let k = 0; k < n; k++) {
      const inp = batch.inputs[k]!;
      if (h.lastSeq !== 0 && !seqNewer(inp.seq, h.lastSeq)) continue; // duplicate from the redundant batches, or stale
      h.lastSeq = inp.seq;
      h.queue.push({ inp, renderTime: est - (n - 1 - k) * DT_MS - SIM.interpDelayMs });
    }
    while (h.queue.length > NET.inputQueueMax) h.queue.shift(); // a client that runs ahead loses its oldest inputs
  }

  // --- the simulation loop ------------------------------------------------------------

  /**
   * Called as often as the host likes (setSimulationInterval); runs as many fixed 60 Hz ticks as real time owes.
   * Bounded so one long stall cannot trigger a spiral of catch-up ticks.
   */
  advance(): void {
    const now = this.opts.now();
    this.detectSilence(now);
    if (this.state === 'paused') this.tickPause(now);
    if (this.state !== 'live') { this.lastAdvance = now; this.acc = 0; return; }
    this.acc += now - this.lastAdvance;
    this.lastAdvance = now;
    let steps = Math.floor(this.acc / DT_MS);
    this.acc -= steps * DT_MS;
    if (steps > 5) { steps = 5; this.acc = 0; }
    for (let i = 0; i < steps; i++) this.step(this.clock() - (steps - 1 - i) * DT_MS);
  }

  private detectSilence(now: number): void {
    for (const h of this.humans.values())
      if (h.connected && now - h.lastMsgAt > NET.silenceMs) this.disconnect(h.key);
  }

  private tickPause(now: number): void {
    const gone = [...this.humans.values()].filter((h) => !h.connected);
    if (gone.length === 0) return;
    const waited = Math.max(...gone.map((h) => (now - h.disconnectedAt) / 1000));
    const left = Math.ceil(NET.reconnectSec - waited);
    if (left <= 0) {
      this.state = 'ended';
      this.pushAll({ t: 'match', state: 'forfeit', who: gone[0]!.actor.index, secs: 0 });
      this.flush();
    } else if (left !== this.lastCountdown) {
      this.lastCountdown = left;
      this.pushAll({ t: 'match', state: 'paused', who: gone[0]!.actor.index, secs: left });
      this.flush();
    }
  }

  private step(stamp: number): void {
    const sim = this.sim;
    sim.beginTick(DT);
    for (const h of this.humans.values()) {
      if (!h.connected) continue;
      h.credits = Math.min(NET.inputCreditsMax, h.credits + 1);
      // One input per tick, plus catch-up from saved credits after a lag spike: a client can never get more
      // simulated time than real time has passed, however many inputs it sends.
      while (h.queue.length > 0 && h.credits >= 1) {
        const q = h.queue.shift()!;
        h.credits -= 1;
        this.applyInput(h, q, stamp);
      }
    }
    for (const b of this.bots) {
      const inp = b.brain.think(b.actor, sim.actors, this.world, DT, sim.pickups);
      sim.stepActor(b.actor, inp, DT);
    }
    sim.endTick();
    this.tickNo++;
    this.recordHistory(stamp);
    this.routeEvents(sim.drainEvents());
    this.diffPickups();
    if (this.tickNo % STATS_EVERY === 0) this.pushStats();
    if (this.tickNo % SNAPSHOT_EVERY === 0) this.sendSnapshots(stamp);
    this.flush();
  }

  private applyInput(h: Human, q: Queued, stamp: number): void {
    const inp: ActorInput = { ...q.inp };
    // lag compensation window: what the shooter saw, but never older than maxRewindMs and never from the future
    inp.renderTime = clamp(q.renderTime, stamp - SIM.maxRewindMs, stamp);
    this.sim.stepActor(h.actor, inp, DT);
    h.ack = q.inp.seq;
    h.inputsProcessed++;
  }

  // --- lag compensation -----------------------------------------------------------------

  private recordHistory(t: number): void {
    this.history.push({
      t,
      actors: this.sim.actors.map((a) => ({
        id: a.id, x: a.body.pos.x, y: a.body.pos.y, z: a.body.pos.z, height: heightOf(a.body), eye: eyeHeightOf(a.body),
        alive: a.hp.alive, epoch: a.epoch,
      })),
    });
    const oldest = t - NET.historyMs;
    while (this.history.length > 2 && this.history[0]!.t < oldest) this.history.shift();
  }

  /** Targets as they were at `renderTime` (server clock ms), interpolated between the two ticks around it. */
  private rewindTargets(shooter: Actor, renderTime: number): HitTarget[] {
    const hist = this.history;
    const newest = hist[hist.length - 1];
    if (!newest || renderTime >= newest.t) return this.sim.targetsFor(shooter);
    this.counters.rewound++;
    let i = hist.length - 1;
    while (i > 0 && hist[i]!.t > renderTime) i--;
    const a = hist[i]!, b = hist[i + 1];
    const k = b && renderTime > a.t && b.t > a.t ? (renderTime - a.t) / (b.t - a.t) : 0;
    const out: HitTarget[] = [];
    for (const ha of a.actors) {
      if (ha.id === shooter.id) continue;
      const hb = b?.actors.find((x) => x.id === ha.id);
      const blend = hb !== undefined && hb.epoch === ha.epoch; // never blend across a respawn teleport
      out.push({
        id: ha.id,
        pos: blend ? { x: ha.x + (hb.x - ha.x) * k, y: ha.y + (hb.y - ha.y) * k, z: ha.z + (hb.z - ha.z) * k } : { x: ha.x, y: ha.y, z: ha.z },
        height: ha.height, eye: ha.eye, alive: ha.alive,
      });
    }
    return out;
  }

  // --- events and snapshots ---------------------------------------------------------------

  private wireId(id: string | null): number {
    if (id === null) return NO_ACTOR;
    return this.sim.actor(id)?.index ?? NO_ACTOR;
  }

  private humanOf(actorId: string): Human | undefined {
    for (const h of this.humans.values()) if (h.actor.id === actorId) return h;
    return undefined;
  }

  private push(h: Human | undefined, e: WireEvent): void {
    if (h && h.connected) h.events.push(e);
  }

  private pushAll(e: WireEvent): void {
    for (const h of this.humans.values()) this.push(h, e);
  }

  private routeEvents(events: CombatEvent[]): void {
    for (const e of events) {
      switch (e.type) {
        case 'shot': {
          const shooter = this.humanOf(e.actor);
          const w: WireEvent = { t: 'shot', actor: this.wireId(e.actor), weapon: e.weapon, shotId: e.shotId, origin: e.origin, pellets: e.pellets };
          for (const h of this.humans.values()) if (h !== shooter) this.push(h, w); // the shooter predicted it already
          break;
        }
        case 'hit':
          this.push(this.humanOf(e.shooter), { t: 'hit', victim: this.wireId(e.victim), damage: e.damage, head: e.head, killed: e.killed, dist: e.dist, falloff: e.falloff });
          break;
        case 'damage':
          this.push(this.humanOf(e.victim), { t: 'dmg', attacker: this.wireId(e.attacker), dirX: e.dirX, dirZ: e.dirZ, amount: e.amount });
          break;
        case 'kill':
          this.pushAll({ t: 'kill', killer: this.wireId(e.killer), victim: this.wireId(e.victim), weapon: e.weapon, head: e.head });
          break;
        case 'pickup':
          this.pushAll({ t: 'pickup', actor: this.wireId(e.actor), weapon: e.weapon, rarity: e.rarity });
          break;
        case 'respawn':
          this.pushAll({ t: 'respawn', actor: this.wireId(e.actor), yaw: e.yaw });
          break;
        case 'weaponEmpty':
          this.push(this.humanOf(e.actor), { t: 'note', kind: 'weaponEmpty', actor: this.wireId(e.actor) });
          break;
        default:
          break; // dry fire, reloads and equips are predicted by the owner and need no message
      }
    }
  }

  private pickupKey(s: { id: WeaponId; rarity: number; mag: number; reserve: number } | null): string {
    return s ? `${s.id}|${s.rarity}|${s.mag}|${s.reserve}` : '';
  }

  /** Emits pad refills and takings, and drops appearing and disappearing. */
  private diffPickups(): void {
    const seen = new Set<number>();
    for (const p of this.sim.pickups) {
      seen.add(p.id);
      const key = this.pickupKey(p.state);
      const prev = this.pickupKeys.get(p.id);
      if (prev === key) continue;
      this.pickupKeys.set(p.id, key);
      const item = p.state ? itemOf(p.state) : null;
      if (p.kind === 'pad') this.pushAll({ t: 'pad', id: p.id, item });
      else if (prev === undefined && item) this.pushAll({ t: 'drop', id: p.id, x: p.x, y: p.y, z: p.z, item });
    }
    for (const id of [...this.pickupKeys.keys()]) {
      if (seen.has(id)) continue;
      this.pickupKeys.delete(id);
      this.pushAll({ t: 'dropGone', id });
    }
  }

  private pushStats(): void {
    for (const a of this.sim.actors) this.pushAll({ t: 'stats', actor: a.index, stats: { ...a.stats } });
  }

  private slowKey(a: Actor): string {
    const w = a.rack[a.slot] ?? a.rack[0]!;
    return `${Math.ceil(a.hp.hp)}|${w.id}|${w.rarity}|${w.mag}|${Math.round(a.body.stamina / 5)}`;
  }

  private sendSnapshots(stamp: number): void {
    this.snapNo++;
    for (const h of this.humans.values()) {
      if (!h.connected) continue;
      const actors = [];
      for (const a of this.sim.actors) {
        if (a === h.actor) continue;
        const key = this.slowKey(a);
        const slow = h.slowSent.get(a.index) !== key || this.snapNo % SLOW_REFRESH_EVERY === 0;
        if (slow) h.slowSent.set(a.index, key);
        const r = remoteOf(a, slow);
        if (slow) r.stamina = Math.round(a.body.stamina / 5) * 5;
        actors.push(r);
      }
      const buf = encodeSnapshot({
        serverTime: stamp, tick: this.snapNo & 0xffff, ack: h.ack,
        own: { body: ownBodyOf(h.actor), combat: ownCombatOf(h.actor) }, actors,
      });
      h.bytesOut += buf.length;
      this.counters.snapshotsSent++;
      this.opts.send(h.key, NET_MSG.SNAPSHOT, buf, false);
    }
  }

  /** Sends each human its queued reliable events, in chunks that fit one message. */
  private flush(): void {
    for (const h of this.humans.values()) {
      while (h.events.length > 0) {
        const chunk = h.events.splice(0, 100);
        const buf = encodeEvents(chunk);
        h.bytesOut += buf.length;
        this.opts.send(h.key, NET_MSG.EVENTS, buf, true);
      }
    }
  }

  // --- welcome and roster -------------------------------------------------------------------

  private roster(): { id: number; name: string; kind: 'player' | 'bot' }[] {
    return this.sim.actors.map((a) => ({ id: a.index, name: a.name, kind: a.kind === 'bot' ? ('bot' as const) : ('player' as const) }));
  }

  private pickupInfos(): PickupInfo[] {
    return this.sim.pickups.map((p) => ({
      id: p.id, kind: p.kind, x: p.x, y: p.y, z: p.z, item: p.state ? itemOf(p.state) : null,
    }));
  }

  private sendWelcome(h: Human): void {
    const w: Welcome = {
      you: h.actor.index, seed: this.opts.seed, sceneId: this.scene.id, serverTime: this.clock(),
      roster: this.roster(), pickups: this.pickupInfos(),
    };
    this.opts.send(h.key, NET_MSG.WELCOME, w, true);
  }

  private broadcastRoster(): void {
    const r = { roster: this.roster() };
    for (const h of this.humans.values()) if (h.connected) this.opts.send(h.key, NET_MSG.ROSTER, r, true);
  }
}
