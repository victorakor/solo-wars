import {
  BOT_PROFILES, BotBrain, addBot, createTraining, SIM,
  type Actor, type ActorInput, type BotLevel, type CombatEvent, type CombatSim, type NetClient, type Training, type Vec3, type WeaponId,
} from '@arena/shared';

const DT = 1 / SIM.tickHz;

/**
 * What the renderer and HUD need from "a match": a CombatSim to draw, the local actor, a way to advance one 60 Hz
 * tick with the player's input, and a stream of events. Local practice and a server-backed room both fit, so the
 * rest of the game does not care which one it is looking at.
 */
export interface Session {
  readonly online: boolean;
  readonly sim: CombatSim;
  readonly me: Actor;
  readonly net: NetClient | null;
  /** One 60 Hz tick with the local player's input (already carrying the converged aim). `now` is performance.now(). */
  step(mine: ActorInput, now: number): void;
  /** Everything that happened since the last call. */
  events(): CombatEvent[];
  /** Per rendered frame, before drawing. */
  frame(now: number, real: number): void;
  /** Visual offset for an actor (the local player's smoothed prediction correction), or null. */
  offset(a: Actor): Vec3 | null;
}

/** Practice on Foundry against local bots: the simulation runs right here. */
export class LocalSession implements Session {
  readonly online = false;
  readonly net = null;
  private brains = new Map<string, BotBrain>();
  private inputs = new Map<string, ActorInput>();
  private training: Training;

  constructor(seed: number, weapon: WeaponId) {
    this.training = createTraining(seed, { weapon });
  }

  get sim(): CombatSim { return this.training.sim; }
  get me(): Actor { return this.training.player; }
  get botCount(): number { return this.brains.size; }

  addBot(level: BotLevel): Actor {
    const a = addBot(this.training, level);
    this.brains.set(a.id, new BotBrain(BOT_PROFILES[level], Math.floor(Math.random() * 1e9), a.view.yaw));
    return a;
  }

  /** Removes the most recently added bot, if any. */
  removeBot(): Actor | null {
    const bots = this.sim.actors.filter((a) => a.kind === 'bot');
    const b = bots[bots.length - 1];
    if (!b) return null;
    this.sim.removeActor(b.id);
    this.brains.delete(b.id);
    return b;
  }

  step(mine: ActorInput): void {
    const sim = this.sim;
    this.inputs.clear();
    this.inputs.set(this.me.id, mine);
    for (const [id, brain] of this.brains) {
      const bot = sim.actor(id);
      if (bot) this.inputs.set(id, brain.think(bot, sim.actors, sim.world, DT, sim.pickups));
    }
    sim.step(DT, this.inputs);
  }

  events(): CombatEvent[] { return this.sim.drainEvents(); }
  frame(): void { /* the sim is already current */ }
  offset(): Vec3 | null { return null; }
}

/** A match on the server: we predict ourselves, interpolate everyone else, and the server decides. */
export class OnlineSession implements Session {
  readonly online = true;
  constructor(readonly net: NetClient) {}

  get sim(): CombatSim { return this.net.sim; }
  get me(): Actor { return this.net.me; }

  step(mine: ActorInput, now: number): void { this.net.tick(mine, now); }
  events(): CombatEvent[] { return this.net.drainEvents(); }
  frame(now: number, real: number): void { this.net.update(now, real); }
  offset(a: Actor): Vec3 | null { return a === this.net.me ? this.net.predictor.err : null; }
}
