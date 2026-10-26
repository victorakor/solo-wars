import { Client, type Room } from 'colyseus.js';
import { NET, NET_MSG, NetClient, ROOM_MATCH, SCENES, type Welcome } from '@arena/shared';
import { DebugLink } from './debugLink';

export interface OnlineOptions {
  url: string;
  name: string;
  /** Players with the same code meet in the same room. */
  code: string;
  weapon: string;
  bots: number;
}

export type ConnState = 'connecting' | 'online' | 'reconnecting' | 'closed' | 'error';

const KICK_CODE = 4001;
const CONSENTED_LEAVE = 4000;
/** Messages the server sends reliably (everything else may be dropped by the simulator). */
const RELIABLE_DOWN = new Set<string>([NET_MSG.WELCOME, NET_MSG.EVENTS, NET_MSG.ROSTER]);

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

/**
 * Colyseus transport for a NetClient: joins the match room, feeds server messages in, sends inputs and pings out,
 * and reconnects with the room's token for up to 30 s when the socket drops. All netcode logic lives in NetClient
 * (shared, unit-tested); this is only plumbing.
 */
export class Connection {
  net: NetClient | null = null;
  state: ConnState = 'connecting';
  error = '';
  readonly debug = new DebugLink();
  /** Called when `net` is first created (the welcome arrived). */
  onNet: ((net: NetClient) => void) | null = null;
  private client: Client;
  private room: Room | null = null;
  private token = '';
  private closing = false;
  private awaitingWelcome = false;

  constructor(private opts: OnlineOptions, private onChange: () => void) {
    this.client = new Client(opts.url);
  }

  async connect(): Promise<void> {
    try {
      const room = await this.client.joinOrCreate(ROOM_MATCH, {
        name: this.opts.name, code: this.opts.code, bots: this.opts.bots, weapon: this.opts.weapon,
      });
      this.attach(room);
      this.state = 'online';
    } catch (e) {
      this.state = 'error';
      this.error = e instanceof Error ? e.message : String(e);
      throw e;
    } finally {
      this.onChange();
    }
  }

  async leave(): Promise<void> {
    this.closing = true;
    this.state = 'closed';
    try { await this.room?.leave(true); } catch { /* already gone */ }
    this.room = null;
    this.onChange();
  }

  private attach(room: Room): void {
    this.room = room;
    this.token = room.reconnectionToken;
    for (const type of Object.values(NET_MSG)) {
      if (type === NET_MSG.INPUT || type === NET_MSG.PING || type === NET_MSG.HELLO) continue; // client-to-server only
      room.onMessage(type, (data: unknown) => this.debug.receive(() => this.onServer(type, data), RELIABLE_DOWN.has(type)));
    }
    room.onLeave((code: number) => { void this.onLeave(code); });
    void this.askForWelcome();
  }

  /**
   * The server sends the welcome the moment we join, which may be before our handlers are listening. Ask again until
   * it arrives (a few tries, half a second apart) so a missed welcome can never leave the player stuck connecting.
   */
  private async askForWelcome(): Promise<void> {
    this.awaitingWelcome = true;
    for (let i = 0; i < 10 && this.awaitingWelcome && !this.closing; i++) {
      await sleep(500);
      if (this.awaitingWelcome && !this.closing) this.send(NET_MSG.HELLO, {}, true);
    }
  }

  private send = (type: string, payload: Uint8Array | object, reliable: boolean): void => {
    this.debug.send(() => this.room?.send(type, payload), reliable);
  };

  private onServer(type: string, data: unknown): void {
    const now = performance.now();
    if (type === NET_MSG.WELCOME) {
      this.awaitingWelcome = false;
      const w = data as Welcome;
      if (!this.net) {
        const scene = SCENES[w.sceneId];
        if (!scene) { this.state = 'error'; this.error = `unknown scene ${w.sceneId}`; this.onChange(); return; }
        this.net = new NetClient(w, scene, { send: this.send }, now);
        this.onNet?.(this.net);
      } else this.net.resync(w, now);
      this.state = 'online';
      this.onChange();
      return;
    }
    this.net?.handle(type, data, now);
  }

  private async onLeave(code: number): Promise<void> {
    if (this.closing) return;
    if (code === KICK_CODE || code === CONSENTED_LEAVE) {
      this.state = 'closed';
      this.error = code === KICK_CODE ? 'The server removed you (too many messages).' : '';
      this.onChange();
      return;
    }
    this.state = 'reconnecting';
    this.onChange();
    const deadline = performance.now() + NET.reconnectSec * 1000;
    while (!this.closing && performance.now() < deadline) {
      try {
        const room = await this.client.reconnect(this.token);
        this.attach(room);
        this.state = 'online';
        this.onChange();
        return;
      } catch {
        await sleep(1000);
      }
    }
    if (!this.closing) {
      this.state = 'closed';
      this.error = 'Lost the connection and could not get back in time.';
      this.onChange();
    }
  }
}
