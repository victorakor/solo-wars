// Smoke test for the match room against a RUNNING server (pnpm dev, then: pnpm smoke:match).
// Two clients join the same room, stream idle inputs for 3 s, and we check that welcomes, snapshots,
// input acknowledgements and pongs all flow. The input packet is assembled by hand (14 bytes) so this
// script needs no build step; the byte layout is documented in docs/PROTOCOL.md.
import { Client } from 'colyseus.js';

const url = process.env.SERVER_URL ?? 'ws://localhost:2567';
const code = `smoke-${Date.now()}`;

function idleBatch(seq, timeLow) {
  const dv = new DataView(new ArrayBuffer(14));
  dv.setUint8(0, 1); // message type: input batch
  dv.setUint8(1, 1); // one input
  dv.setUint16(2, timeLow & 0xffff, true);
  dv.setUint16(4, seq, true); // first (and only) sequence number
  dv.setUint16(6, 0, true); // flags: nothing pressed
  dv.setInt8(8, 0); dv.setInt8(9, 0); // move x, z
  dv.setUint16(10, 0, true); dv.setInt16(12, 0, true); // yaw, pitch
  return new Uint8Array(dv.buffer);
}

async function player(name) {
  const room = await new Client(url).joinOrCreate('match', { name, code });
  const st = { name, welcome: null, rosterSizes: [], snaps: 0, lastAck: 0, pongs: 0, rtt: [], events: 0 };
  room.onMessage('welcome', (w) => { st.welcome = w; });
  room.onMessage('roster', (r) => { st.rosterSizes.push(r.roster.length); });
  room.onMessage('snap', (m) => {
    const b = new Uint8Array(m);
    if (b[0] === 2) { st.snaps++; st.lastAck = b[7] | (b[8] << 8); } // type, u32 serverTime, u16 tick, u16 ack
  });
  room.onMessage('pong', (m) => { st.pongs++; st.rtt.push(Date.now() - m.t); });
  room.onMessage('ev', () => { st.events++; });
  return { room, st };
}

const [a, b] = await Promise.all([player('smoke-a'), player('smoke-b')]);
let seq = 0;
const started = Date.now();
const timer = setInterval(() => {
  for (const p of [a, b]) p.room.send('in', idleBatch(++seq > 60000 ? (seq = 1) : seq, Date.now()));
}, 1000 / 60);
const pinger = setInterval(() => { for (const p of [a, b]) p.room.send('ping', { t: Date.now() }); }, 500);
await new Promise((r) => setTimeout(r, 3000));
clearInterval(timer); clearInterval(pinger);

const secs = (Date.now() - started) / 1000;
let failed = false;
for (const { st } of [a, b]) {
  const ok = st.welcome !== null && st.snaps >= 35 && st.lastAck > 100 && st.pongs >= 4;
  console.log(`${st.name}: welcome=${st.welcome !== null} roster=${JSON.stringify(st.rosterSizes)} snapshots=${st.snaps} (${(st.snaps / secs).toFixed(1)}/s) lastAck=${st.lastAck} pongs=${st.pongs} rtt~${Math.round(st.rtt.reduce((x, y) => x + y, 0) / Math.max(1, st.rtt.length))}ms events=${st.events} ${ok ? 'OK' : 'FAIL'}`);
  if (!ok) failed = true;
}
await Promise.all([a.room.leave(), b.room.leave()]);
if (failed) { console.error('MATCH SMOKE FAILED'); process.exit(1); }
console.log('MATCH SMOKE OK');
process.exit(0);
