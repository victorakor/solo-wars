import { SimLink } from '@arena/shared';

/**
 * In-game network simulator (spec 9: debug panel). Delays, jitters and drops traffic in both directions so
 * you can feel prediction, interpolation and lag compensation on a perfect connection. Off by default.
 * Reliable messages (events, welcome) are never lost, only delayed, like the real WebSocket transport.
 */
export class DebugLink {
  private up = new SimLink<() => void>({ latencyMs: 0, jitterMs: 0, loss: 0 }, 17);
  private down = new SimLink<() => void>({ latencyMs: 0, jitterMs: 0, loss: 0 }, 29);
  private timer: ReturnType<typeof setInterval> | null = null;
  enabled = false;
  rttMs = 0;
  jitterMs = 0;
  lossPct = 0;

  setOptions(rttMs: number, jitterMs: number, lossPct: number): void {
    this.rttMs = rttMs; this.jitterMs = jitterMs; this.lossPct = lossPct;
    for (const l of [this.up, this.down]) { l.opts.latencyMs = rttMs / 2; l.opts.jitterMs = jitterMs; l.opts.loss = lossPct / 100; }
    this.enabled = rttMs > 0 || jitterMs > 0 || lossPct > 0;
    if (this.enabled && this.timer === null) this.timer = setInterval(() => this.pump(), 4);
  }

  /** Outgoing: runs `fn` (the real send) after the simulated uplink delay, or never if the packet is "lost". */
  send(fn: () => void, reliable: boolean): void {
    if (!this.enabled && this.up.inFlight === 0) { fn(); return; }
    this.up.send(fn, performance.now(), reliable);
  }

  /** Incoming: runs `fn` (the real handler) after the simulated downlink delay. */
  receive(fn: () => void, reliable: boolean): void {
    if (!this.enabled && this.down.inFlight === 0) { fn(); return; }
    this.down.send(fn, performance.now(), reliable);
  }

  private pump(): void {
    const now = performance.now();
    for (const fn of this.up.poll(now)) fn();
    for (const fn of this.down.poll(now)) fn();
    if (!this.enabled && this.up.inFlight === 0 && this.down.inFlight === 0 && this.timer !== null) {
      clearInterval(this.timer);
      this.timer = null;
    }
  }
}
