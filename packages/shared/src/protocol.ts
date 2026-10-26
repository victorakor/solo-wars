import { z } from 'zod';
import { NET } from './balance';

export const ROOM_HELLO = 'hello';
export const MSG = { PING: 'ping', PONG: 'pong' } as const;

export const PingSchema = z.object({ t: z.number().finite() });
export type Ping = z.infer<typeof PingSchema>;
export interface Pong extends Ping {
  serverTime: number;
}

// ---------------------------------------------------------------------------
// Phase 3: match room protocol. Hot-path messages (input, snapshot, events) are binary, see net/codec.ts.
// ---------------------------------------------------------------------------

export const ROOM_MATCH = 'match';

/**
 * Message names on the match room. Binary: INPUT (client to server), SNAPSHOT and EVENTS (server to client).
 * HELLO (client to server) asks for the welcome again, in case it arrived before the client was listening.
 */
export const NET_MSG = {
  PING: 'ping', PONG: 'pong', INPUT: 'in', SNAPSHOT: 'snap', EVENTS: 'ev', WELCOME: 'welcome', ROSTER: 'roster', HELLO: 'hello',
} as const;

/** Options a client passes when joining the match room. Validated on the server. */
export const JoinOptionsSchema = z.object({
  name: z.string().trim().min(1).max(24).default('Player'),
  /** Players with the same code land in the same room. */
  code: z.string().trim().max(32).default('open'),
  /** Practice bots to add when the room is created (bandwidth limits the total). */
  bots: z.number().int().min(0).max(NET.maxBots).default(0),
  /** Your loadout weapon id. Anything unknown falls back to the default. */
  weapon: z.string().max(16).default('vanguard'),
});
export type JoinOptions = z.infer<typeof JoinOptionsSchema>;

export interface RosterEntry {
  /** Wire id (single byte). */
  id: number;
  name: string;
  kind: 'player' | 'bot';
}

export interface PickupInfo {
  id: number;
  kind: 'pad' | 'drop';
  x: number; y: number; z: number;
  item: { weapon: string; rarity: number; mag: number; reserve: number } | null;
}

/** Sent reliably on join and after a reconnect. */
export interface Welcome {
  you: number;
  seed: number;
  sceneId: string;
  serverTime: number;
  roster: RosterEntry[];
  pickups: PickupInfo[];
}

export interface Roster {
  roster: RosterEntry[];
}
