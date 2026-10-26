import { Room, type Client } from '@colyseus/core';
import { JoinOptionsSchema, NET, SIM, type JoinOptions } from '@arena/shared';
import { MatchCore } from '../net/matchCore';

const KICK_CODE = 4001;

/**
 * The Colyseus side of a match: a thin adapter. All game and netcode logic lives in MatchCore (transport-free and
 * covered by the network tests); this class only
 *  - validates join options,
 *  - maps Colyseus clients to players,
 *  - forwards messages in and out,
 *  - runs the fixed 60 Hz loop, and
 *  - holds the seat open for 30 s when a connection drops (Colyseus reconnection tokens).
 *
 * Hot-path messages are binary (see docs/PROTOCOL.md). We do not use Colyseus Schema state sync: snapshots are our
 * own quantised packets, so automatic state patches are turned off.
 */
export class MatchRoom extends Room {
  override maxClients = NET.maxHumans;
  private core!: MatchCore;

  override onCreate(options: unknown): void {
    const parsed = JoinOptionsSchema.safeParse(options ?? {});
    const o: JoinOptions = parsed.success ? parsed.data : JoinOptionsSchema.parse({});
    this.setPatchRate(null);
    this.core = new MatchCore({
      seed: Math.floor(Math.random() * 0x7fffffff),
      now: () => performance.now(),
      send: (key, type, payload) => {
        const c = this.clients.getById(key);
        if (c) c.send(type, payload);
      },
      bots: o.bots,
      botLevel: 'medium',
      minHumans: o.bots > 0 ? 1 : NET.maxHumans,
    });
    this.setSimulationInterval(() => this.core.advance(), 1000 / SIM.tickHz);
    this.onMessage('*', (client: Client, type: string | number, message: unknown) => {
      if (this.core.onMessage(client.sessionId, String(type), message) === 'kick') client.leave(KICK_CODE);
    });
  }

  override onJoin(client: Client, options: unknown): void {
    const parsed = JoinOptionsSchema.safeParse(options ?? {});
    const o: JoinOptions = parsed.success ? parsed.data : JoinOptionsSchema.parse({});
    if (!this.core.join(client.sessionId, o.name, o.weapon)) client.leave();
  }

  override async onLeave(client: Client, consented: boolean): Promise<void> {
    const key = client.sessionId;
    if (consented) {
      this.core.leave(key);
      return;
    }
    this.core.disconnect(key); // pauses the match; the core forfeits the player itself after NET.reconnectSec
    try {
      await this.allowReconnection(client, NET.reconnectSec);
      this.core.reconnect(key);
    } catch {
      this.core.leave(key); // the seat expired
    }
  }

  override onDispose(): void {
    // nothing to release: the core owns no timers or sockets
  }
}
