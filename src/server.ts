import { serve } from '@hono/node-server';
import { z } from 'zod';
import { betterAuthAuthenticator, createAuth } from './auth/better-auth.js';
import { createDb, DatabaseUnavailable } from './db/client.js';
import { createApp } from './http/app.js';
import { LocalDiskStorage } from './intake/storage.js';
import { createLogger } from './log.js';

const Env = z.object({
  DATABASE_URL: z.string().min(1, 'DATABASE_URL harus diisi (lihat .env.example).'),
  PORT: z.coerce.number().int().min(1).max(65535).default(3000),
  BETTER_AUTH_SECRET: z.string().min(32, 'BETTER_AUTH_SECRET harus ≥ 32 karakter (openssl rand -base64 48).'),
  BETTER_AUTH_URL: z.url({ message: 'BETTER_AUTH_URL harus URL lengkap tempat API ini dilayani.' }),
  TRUSTED_ORIGINS: z.string().default(''),
  AUTH_ALLOW_SIGNUP: z.enum(['0', '1']).default('0'),
  /** unset: on in production only (Better Auth default) */
  AUTH_RATE_LIMIT: z.enum(['0', '1']).optional(),
  /** comma-separated CIDRs of the reverse proxy, e.g. 127.0.0.1/32 */
  AUTH_TRUSTED_PROXIES: z.string().default(''),
  /** compared with X-Telegram-Bot-Api-Secret-Token; unset = webhook off (404) */
  TELEGRAM_WEBHOOK_SECRET: z.string().regex(/^[A-Za-z0-9_-]{32,256}$/, 'TELEGRAM_WEBHOOK_SECRET: 32–256 karakter A-Z a-z 0-9 _ -').optional(),
  /** folder of original intake photos (same as the worker's) */
  STORAGE_DIR: z.string().min(1).optional(),
  NODE_ENV: z.string().default('development'),
});

async function main(): Promise<void> {
  const env = Env.parse(process.env);
  const { db, ping, close } = createDb(env.DATABASE_URL);
  await ping(); // refuse to listen without a database

  const trustedOrigins = env.TRUSTED_ORIGINS.split(',').map((s) => s.trim()).filter(Boolean);
  const auth = createAuth(db, {
    secret: env.BETTER_AUTH_SECRET,
    baseURL: env.BETTER_AUTH_URL,
    trustedOrigins,
    allowSignUp: env.AUTH_ALLOW_SIGNUP === '1',
    secureCookies: env.NODE_ENV === 'production',
    ...(env.AUTH_RATE_LIMIT ? { rateLimit: env.AUTH_RATE_LIMIT === '1' } : {}),
    trustedProxies: env.AUTH_TRUSTED_PROXIES.split(',').map((s) => s.trim()).filter(Boolean),
  });
  const log = createLogger({ service: 'api' });
  const app = createApp({
    db, auth: betterAuthAuthenticator(auth), betterAuth: auth, trustedOrigins, log,
    ...(env.STORAGE_DIR ? { storage: new LocalDiskStorage(env.STORAGE_DIR) } : {}),
    ...(env.TELEGRAM_WEBHOOK_SECRET ? { telegramWebhookSecret: env.TELEGRAM_WEBHOOK_SECRET } : {}),
  });
  const server = serve({ fetch: app.fetch, port: env.PORT }, (info) => log('api_started', { port: info.port }));

  const shutdown = (sig: string) => {
    log('api_stopping', { signal: sig });
    server.close(() => void close().finally(() => process.exit(0)));
  };
  process.on('SIGINT', () => shutdown('SIGINT'));
  process.on('SIGTERM', () => shutdown('SIGTERM'));
}

main().catch((e: unknown) => {
  if (e instanceof z.ZodError) console.error('Konfigurasi env tidak valid:', e.issues.map((i) => `${i.path.join('.')}: ${i.message}`).join('; '));
  else if (e instanceof DatabaseUnavailable) console.error(`${e.name}: ${e.message}`);
  else console.error(e instanceof Error ? `${e.name}: ${e.message}` : String(e));
  process.exit(1);
});
