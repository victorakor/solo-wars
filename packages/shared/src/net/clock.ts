/**
 * NTP-style clock sync (spec 9). Each pong gives one sample: the server clock is assumed to have been read
 * halfway through the round trip. The sample with the lowest round trip among the recent ones is the least
 * distorted by queueing, so the offset follows it, smoothed so it never jumps.
 */
export class ClockSync {
  private samples: { rtt: number; offset: number }[] = [];
  /** Server clock minus client clock, in ms. */
  offsetMs = 0;
  /** Smoothed round-trip time, ms. */
  rttMs = 0;
  ready = false;

  constructor(private keep = 8, private smoothing = 0.25) {}

  addSample(clientSend: number, serverTime: number, clientRecv: number): void {
    const rtt = clientRecv - clientSend;
    if (!(rtt >= 0) || !Number.isFinite(serverTime)) return;
    this.samples.push({ rtt, offset: serverTime - (clientSend + rtt / 2) });
    if (this.samples.length > this.keep) this.samples.shift();
    let best = this.samples[0]!;
    for (const s of this.samples) if (s.rtt < best.rtt) best = s;
    if (!this.ready) { this.offsetMs = best.offset; this.rttMs = rtt; this.ready = true; return; }
    this.offsetMs += (best.offset - this.offsetMs) * this.smoothing;
    this.rttMs += (rtt - this.rttMs) * 0.2;
  }

  serverNow(clientNow: number): number {
    return clientNow + this.offsetMs;
  }
}

/** Packet loss estimate from gaps in the 16-bit snapshot counter over a sliding window. */
export class LossMeter {
  private window: boolean[] = [];
  private last = -1;
  constructor(private size = 100) {}

  /** Call for every snapshot received, in arrival order. Late (reordered) snapshots are ignored. */
  onTick(tick: number): void {
    if (this.last < 0) { this.last = tick; return; }
    const gap = (tick - this.last) & 0xffff;
    if (gap === 0 || gap >= 0x8000) return;
    for (let i = 1; i < gap; i++) this.push(false);
    this.push(true);
    this.last = tick;
  }

  private push(got: boolean): void {
    this.window.push(got);
    if (this.window.length > this.size) this.window.shift();
  }

  /** Percentage (0-100) of expected snapshots that did not arrive. */
  get lossPct(): number {
    if (this.window.length < 10) return 0;
    return (100 * this.window.filter((g) => !g).length) / this.window.length;
  }
}
