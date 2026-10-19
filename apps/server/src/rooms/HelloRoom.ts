import { Room, type Client } from '@colyseus/core';
import { MSG, PingSchema, type Pong } from '@arena/shared';

/** Phase 0 connectivity room. Replaced by real rooms in later phases. */
export class HelloRoom extends Room {
  override onCreate(): void {
    this.onMessage(MSG.PING, (client: Client, raw: unknown) => {
      const parsed = PingSchema.safeParse(raw);
      if (!parsed.success) return;
      const pong: Pong = { t: parsed.data.t, serverTime: Date.now() };
      client.send(MSG.PONG, pong);
    });
  }
}
