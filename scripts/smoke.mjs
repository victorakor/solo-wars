import { Client } from 'colyseus.js';
const url = process.env.SERVER_URL ?? 'ws://localhost:2567';
const room = await new Client(url).joinOrCreate('hello');
const result = await new Promise((resolve, reject) => {
  const timer = setTimeout(() => reject(new Error('no pong within 3s')), 3000);
  room.onMessage('pong', (m) => { clearTimeout(timer); resolve(m); });
  room.send('ping', { t: Date.now() });
});
console.log('SMOKE OK', JSON.stringify(result));
await room.leave();
process.exit(0);
