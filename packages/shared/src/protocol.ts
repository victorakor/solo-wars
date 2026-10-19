import { z } from 'zod';

export const ROOM_HELLO = 'hello';
export const MSG = { PING: 'ping', PONG: 'pong' } as const;

export const PingSchema = z.object({ t: z.number().finite() });
export type Ping = z.infer<typeof PingSchema>;
export interface Pong extends Ping {
  serverTime: number;
}
