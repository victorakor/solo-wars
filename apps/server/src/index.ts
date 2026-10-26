import { createServer } from 'node:http';
import cors from 'cors';
import express from 'express';
import { Server } from '@colyseus/core';
import { WebSocketTransport } from '@colyseus/ws-transport';
import { ROOM_HELLO, ROOM_MATCH } from '@arena/shared';
import { config } from './config';
import { HelloRoom } from './rooms/HelloRoom';
import { MatchRoom } from './rooms/MatchRoom';

const app = express();
app.use(cors({ origin: config.CORS_ORIGINS.split(',') }));
app.get('/healthz', (_req, res) => res.json({ ok: true, region: config.REGION_LABEL }));

const httpServer = createServer(app);
const gameServer = new Server({ transport: new WebSocketTransport({ server: httpServer }) });
gameServer.define(ROOM_HELLO, HelloRoom);
// players who pass the same `code` join option meet in the same match room
gameServer.define(ROOM_MATCH, MatchRoom).filterBy(['code']);

await gameServer.listen(config.PORT);
console.log(JSON.stringify({ msg: 'server listening', port: config.PORT }));

const shutdown = async (): Promise<void> => {
  await gameServer.gracefullyShutdown();
  process.exit(0);
};
process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);
