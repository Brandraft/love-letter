import { serve } from '@hono/node-server';
import { existsSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createApp } from './app.js';
import { Store } from './store.js';

const here = dirname(fileURLToPath(import.meta.url));
const port = Number(process.env['PORT'] ?? 8080);
const host = process.env['HOST'] ?? '0.0.0.0';
const dataDir = process.env['DATA_DIR'] ?? resolve(here, '../../../data');
const webDist = process.env['WEB_DIST'] ?? resolve(here, '../../web/dist');
const baseUrl = process.env['BASE_URL'] ?? null;

const store = new Store(resolve(dataDir, 'love-letter.sqlite'));
const { app, rooms } = createApp({
  store,
  baseUrl,
  webDist: existsSync(webDist) ? webDist : null,
  roomTtlMs: Number(process.env['ROOM_TTL_HOURS'] ?? 48) * 3600 * 1000,
});

serve({ fetch: app.fetch, port, hostname: host }, (info) => {
  console.log(`love-letter listening on http://${info.address}:${info.port} (${rooms.rooms.size} rooms restored, web: ${existsSync(webDist) ? 'yes' : 'no'})`);
});

for (const sig of ['SIGINT', 'SIGTERM'] as const) {
  process.on(sig, () => { store.close(); process.exit(0); });
}
