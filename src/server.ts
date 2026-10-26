import { serve } from '@hono/node-server';
import { headerAuthenticator } from './auth/authenticator.js';
import { createDb } from './db/client.js';
import { createApp } from './http/app.js';

const url = process.env['DATABASE_URL'];
if (!url) {
  console.error('DATABASE_URL harus diisi.');
  process.exit(1);
}
const port = Number(process.env['PORT'] ?? 3000);
const { db, close } = createDb(url);
// Dev-only authenticator; replace with the Better Auth adapter before any deployment (see README).
const app = createApp({ db, auth: headerAuthenticator() });

const server = serve({ fetch: app.fetch, port }, (info) => console.log(`JIAT Monitor API on :${info.port}`));
for (const sig of ['SIGINT', 'SIGTERM'] as const) {
  process.on(sig, () => {
    server.close();
    void close().finally(() => process.exit(0));
  });
}
