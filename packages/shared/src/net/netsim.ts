/**
 * Link simulator: latency, jitter and packet loss between two endpoints (spec 9 debug simulator, spec 23 network tests).
 * Driven by whatever clock the caller passes (virtual in tests, real in the in-game debug panel).
 *
 * Unreliable messages are dropped with probability `loss` and may arrive out of order. Reliable messages model
 * the real transport (WebSocket over TCP): never lost, always in order, but a "lost" one is retransmitted after a
 * timeout, which delays it and everything queued behind it.
 */
export interface LinkOptions {
  /** One-way delay in ms. */
  latencyMs: number;
  /** Each message gets a random extra delay in [0, jitterMs]. */
  jitterMs: number;
  /** 0..1 probability a message is lost. */
  loss: number;
}

interface Queued<T> {
  at: number;
  order: number;
  msg: T;
}

export class SimLink<T> {
  private queue: Queued<T>[] = [];
  private order = 0;
  private lastReliableAt = 0;
  private state: number;
  /** Counters for tests and the debug panel. */
  sent = 0;
  dropped = 0;

  constructor(public opts: LinkOptions, seed = 1) {
    this.state = seed >>> 0 || 1;
  }

  private rand(): number {
    // xorshift32: small, deterministic
    let x = this.state;
    x ^= x << 13; x >>>= 0;
    x ^= x >>> 17;
    x ^= x << 5; x >>>= 0;
    this.state = x;
    return x / 4294967296;
  }

  send(msg: T, now: number, reliable = false): void {
    this.sent++;
    const { latencyMs, jitterMs, loss } = this.opts;
    let at = now + latencyMs + this.rand() * jitterMs;
    if (reliable) {
      if (this.rand() < loss) at += Math.max(200, 3 * latencyMs); // retransmission timeout
      at = Math.max(at, this.lastReliableAt + 0.001); // head-of-line blocking keeps order
      this.lastReliableAt = at;
    } else if (this.rand() < loss) {
      this.dropped++;
      return;
    }
    this.queue.push({ at, order: this.order++, msg });
  }

  /** Messages that have arrived by `now`, in arrival order. */
  poll(now: number): T[] {
    if (this.queue.length === 0) return [];
    const ready = this.queue.filter((q) => q.at <= now).sort((a, b) => a.at - b.at || a.order - b.order);
    if (ready.length === 0) return [];
    this.queue = this.queue.filter((q) => q.at > now);
    return ready.map((q) => q.msg);
  }

  get inFlight(): number {
    return this.queue.length;
  }
}
