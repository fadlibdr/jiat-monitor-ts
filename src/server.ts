import { serve } from '@hono/node-server';
import { headerAuthenticator } from './auth/authenticator.js';
import { createDb, DatabaseUnavailable } from './db/client.js';
import { createApp } from './http/app.js';

async function main(): Promise<void> {
  const url = process.env['DATABASE_URL'];
  if (!url) throw new DatabaseUnavailable('DATABASE_URL harus diisi (lihat .env.example).');
  const port = Number(process.env['PORT'] ?? 3000);
  if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error(`PORT tidak valid: ${process.env['PORT']}`);

  const { db, ping, close } = createDb(url);
  await ping(); // refuse to listen without a database

  // Dev-only authenticator; replace with the Better Auth adapter before any deployment (see README).
  const app = createApp({ db, auth: headerAuthenticator() });
  const server = serve({ fetch: app.fetch, port }, (info) => console.log(`JIAT Monitor API on :${info.port}`));

  const shutdown = (sig: string) => {
    console.log(`${sig}: menutup server…`);
    server.close(() => void close().finally(() => process.exit(0)));
  };
  process.on('SIGINT', () => shutdown('SIGINT'));
  process.on('SIGTERM', () => shutdown('SIGTERM'));
}

main().catch((e: unknown) => {
  console.error(e instanceof Error ? `${e.name}: ${e.message}` : String(e));
  process.exit(1);
});
