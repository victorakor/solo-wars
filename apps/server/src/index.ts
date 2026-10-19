import { createServer } from 'node:http';
import cors from 'cors';
import express from 'express';
import { Server } from '@colyseus/core';
import { WebSocketTransport } from '@colyseus/ws-transport';
import { ROOM_HELLO } from '@arena/shared';
import { config } from './config';
import { HelloRoom } from './rooms/HelloRoom';

const app = express();
app.use(cors({ origin: config.CORS_ORIGINS.split(',') }));
app.get('/healthz', (_req, res) => res.json({ ok: true, region: config.REGION_LABEL }));

const httpServer = createServer(app);
const gameServer = new Server({ transport: new WebSocketTransport({ server: httpServer }) });
gameServer.define(ROOM_HELLO, HelloRoom);

await gameServer.listen(config.PORT);
console.log(JSON.stringify({ msg: 'server listening', port: config.PORT }));

const shutdown = async (): Promise<void> => {
  await gameServer.gracefullyShutdown();
  process.exit(0);
};
process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);
