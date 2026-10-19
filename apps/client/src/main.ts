import { Client } from 'colyseus.js';
import { MSG, ROOM_HELLO, type Pong } from '@arena/shared';

const statusEl = document.getElementById('status');
const setStatus = (text: string): void => {
  if (statusEl) statusEl.textContent = text;
};

const serverUrl = import.meta.env.VITE_SERVER_URL ?? `ws://${location.hostname}:2567`;

async function main(): Promise<void> {
  const client = new Client(serverUrl);
  const room = await client.joinOrCreate(ROOM_HELLO);
  room.onMessage(MSG.PONG, (pong: Pong) => {
    setStatus(`Connected. RTT ${Date.now() - pong.t} ms`);
  });
  room.send(MSG.PING, { t: Date.now() });
}

main().catch((err: unknown) => setStatus(`Connection failed: ${String(err)}`));
