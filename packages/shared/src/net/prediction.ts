import { NET, SIM } from '../balance';
import type { Vec3 } from '../collision';
import type { Actor, ActorInput, CombatSim } from '../sim/sim';
import { nextSeq, seqNewer, quantizeInput, type OwnBody, type OwnCombat, type WireInput } from './codec';
import { applyOwnBody, applyOwnCombat } from './state';

const DT = 1 / SIM.tickHz;
const MAX_PENDING = 600; // 10 s of unacknowledged input is a dead connection, not something to replay

/**
 * Client-side prediction and server reconciliation (spec 9).
 *
 * `predict` applies each input immediately to the local actor and remembers it. When a snapshot arrives,
 * `reconcile` rewinds the actor to the server's state (which already includes every input up to `ack`) and
 * replays the inputs the server has not seen yet. Whatever the replay moves the actor by relative to what was
 * on screen becomes a visual offset that bleeds off over ~100 ms, so corrections glide instead of popping.
 * An error of 1.5 m or more is a teleport (respawn) and snaps at once.
 */
export class Predictor {
  private pending: WireInput[] = [];
  private seq = 0;
  /** Visual offset added to the predicted position while a correction bleeds off. */
  readonly err: Vec3 = { x: 0, y: 0, z: 0 };
  /** Size of the last correction in metres (before smoothing), for diagnostics and tests. */
  lastCorrection = 0;
  hardSnaps = 0;
  reconciles = 0;

  constructor(private sim: CombatSim, readonly actor: Actor) {}

  get pendingCount(): number {
    return this.pending.length;
  }

  /** Quantise, predict and remember one input. Returns the wire form to send. */
  predict(raw: ActorInput): WireInput {
    this.seq = nextSeq(this.seq); // never 0: that means "nothing acknowledged yet"
    const q = quantizeInput(raw, this.seq);
    this.sim.stepActor(this.actor, q, DT);
    this.pending.push(q);
    if (this.pending.length > MAX_PENDING) this.pending.shift();
    return q;
  }

  reconcile(ack: number, own: { body: OwnBody; combat: OwnCombat }): void {
    const a = this.actor;
    const before = { x: a.body.pos.x, y: a.body.pos.y, z: a.body.pos.z };
    while (this.pending.length > 0 && !seqNewer(this.pending[0]!.seq, ack)) this.pending.shift();

    const keep = this.sim.drainEvents(); // effects already shown for predicted shots; the replay must not repeat them
    applyOwnBody(a, own.body);
    applyOwnCombat(a, own.combat);
    for (const inp of this.pending) this.sim.stepActor(a, inp, DT);
    this.sim.drainEvents();
    this.sim.restoreEvents(keep);

    const dx = before.x - a.body.pos.x, dy = before.y - a.body.pos.y, dz = before.z - a.body.pos.z;
    const mag = Math.hypot(dx, dy, dz);
    this.lastCorrection = mag;
    this.reconciles++;
    if (mag >= NET.reconcileSnapM) {
      this.err.x = this.err.y = this.err.z = 0;
      this.hardSnaps++;
    } else {
      this.err.x += dx; this.err.y += dy; this.err.z += dz;
    }
  }

  /** Bleeds the visual offset off. Call once per rendered frame. */
  decay(dtSec: number): void {
    const k = Math.exp(-dtSec / NET.errorDecaySec);
    this.err.x *= k; this.err.y *= k; this.err.z *= k;
    if (Math.abs(this.err.x) + Math.abs(this.err.y) + Math.abs(this.err.z) < 1e-4) this.err.x = this.err.y = this.err.z = 0;
  }

  /** Where to draw the local player: the predicted position plus the correction offset. */
  visual(out: Vec3): Vec3 {
    out.x = this.actor.body.pos.x + this.err.x;
    out.y = this.actor.body.pos.y + this.err.y;
    out.z = this.actor.body.pos.z + this.err.z;
    return out;
  }
}
