import { and, eq } from 'drizzle-orm';
import { Hono } from 'hono';
import { cors } from 'hono/cors';
import { HTTPException } from 'hono/http-exception';
import { z } from 'zod';
import type { Authenticator } from '../auth/authenticator.js';
import type { Auth } from '../auth/better-auth.js';
import { BoqImportError } from '../boq/errors.js';
import { companies, companyUsers, managementViewers, users } from '../db/schema.js';
import { AmountOutOfRange } from '../domain/contract.js';
import { siteScopeFor, withApp, type Db } from '../db/tenant.js';
import { CompanyParams, requireHolding, requireUser, type AppEnv, type RouteDeps } from './context.js';
import { registerAdminRoutes } from './routes/admin.js';
import { registerCompanyRoutes } from './routes/company.js';
import { registerDashboardRoutes } from './routes/dashboard.js';
import { registerFinanceRoutes } from './routes/finance.js';
import { registerHoldingRoutes } from './routes/holding.js';
import { registerIntakeRoutes } from './routes/intake.js';
import { registerMemberRoutes } from './routes/members.js';
import { registerProcurementRoutes } from './routes/procurement.js';
import { registerProgressRoutes } from './routes/progress.js';
import { registerTelegramWebhook } from './routes/telegram.js';
import { registerVendorRoutes } from './routes/vendors.js';
import { MANAGE_ROLES, requireRole } from './context.js';
import type { ObjectStorage } from '../intake/storage.js';
import { errorText } from '../jobs/queue.js';
import type { Log } from '../log.js';
import { createLinkCode } from '../ops/telegram-link.js';
import { registerWeb } from './web.js';

export { readUpload } from './context.js';

export interface AppDeps {
  db: Db;
  auth: Authenticator;
  /** When given, Better Auth's own endpoints are mounted at /api/auth/* (sign-in, sign-out, session…). */
  betterAuth?: Auth;
  trustedOrigins?: string[];
  maxUploadBytes?: number;
  now?: () => Date;
  /** where intake photos are read from (review screen); absent → photo route answers 503 */
  storage?: ObjectStorage;
  /** TELEGRAM_WEBHOOK_SECRET; absent → the webhook route answers 404 */
  telegramWebhookSecret?: string;
  /** structured log (src/log.ts); absent → silent (tests) */
  log?: Log;
  /** TELEGRAM_BOT_USERNAME: makes POST /me/telegram-link return a t.me deep link */
  telegramBotUsername?: string;
  /** web/dist: the browser UI served under /app/ (src/http/web.ts); absent → API only */
  webDistDir?: string;
}

const MAX_UPLOAD = 15 * 1024 * 1024;

export function createApp({
  db, auth, betterAuth, trustedOrigins = [], maxUploadBytes = MAX_UPLOAD, now = () => new Date(), storage, telegramWebhookSecret,
  log = () => {}, telegramBotUsername, webDistDir,
}: AppDeps) {
  const app = new Hono<AppEnv>();
  const deps: RouteDeps = { db, maxUploadBytes, now };

  // one line per request: ids and timing only — no query string, body or headers (LLD §9)
  app.use('*', async (c, next) => {
    const started = performance.now();
    await next();
    if (c.req.path === '/health') return;
    log('http_request', {
      method: c.req.method, path: c.req.path, status: c.res.status, ms: Math.round(performance.now() - started),
      userId: c.get('userId') ?? null, companyId: c.get('companyId') ?? null,
    });
  });

  app.onError((err, c) => {
    if (err instanceof HTTPException) return err.getResponse();
    if (err instanceof BoqImportError) return c.json({ error: err.code, message: err.message, details: err.details }, 422);
    if (err instanceof z.ZodError) return c.json({ error: 'invalid_request', issues: err.issues }, 400);
    if (err instanceof SyntaxError) return c.json({ error: 'invalid_json', message: 'Body bukan JSON yang valid.' }, 400);
    if (err instanceof AmountOutOfRange) return c.json({ error: 'invalid_request', message: 'Jumlah atau nilai di luar batas yang dapat dihitung.' }, 400);
    switch (pgCode(err)) {
      case '23505': return c.json({ error: 'conflict', message: 'Data dengan kode/nomor yang sama sudah ada.' }, 409);
      case '23503': return c.json({ error: 'conflict', message: 'Data masih dirujuk oleh data lain.' }, 409);
      // RLS WITH CHECK: e.g. writing a row for a site outside the caller's scope
      case '42501': return c.json({ error: 'forbidden', message: 'Akses ditolak oleh kebijakan data.' }, 403);
      // a value the column cannot hold (too long, bad encoding/NUL, not a number): the request, not the server
      case '22001': case '22021': case '22P02': case '22003':
        return c.json({ error: 'invalid_request', message: 'Nilai tidak valid atau terlalu panjang.' }, 400);
      // two writes to the same documents at the same moment; Postgres rolled this one back whole
      case '40P01': case '40001':
        return c.json({ error: 'conflict', message: 'Data sedang diubah bersamaan; coba lagi.' }, 409);
    }
    // errorText: the database's reason, never Drizzle's SQL + bound parameters (row data such as a
    // vendor's bank account must not reach the logs, LLD §9)
    log('unhandled', {
      method: c.req.method, path: c.req.path, userId: c.get('userId') ?? null, companyId: c.get('companyId') ?? null,
      code: pgCode(err) ?? null, error: errorText(err),
    });
    return c.json({ error: 'internal', message: 'Terjadi kesalahan pada server.' }, 500);
  });

  app.get('/health', (c) => c.json({ ok: true }));

  // the browser UI (public files; every API call it makes goes through the gates below)
  if (webDistDir && !registerWeb(app, webDistDir)) log('web_missing', { dir: webDistDir });

  // Telegram authenticates with its secret token, not a session (registered before the session gates)
  registerTelegramWebhook(app, { db, secret: telegramWebhookSecret, now });

  if (betterAuth) {
    if (trustedOrigins.length) app.use('/api/auth/*', cors({ origin: trustedOrigins, credentials: true }));
    app.all('/api/auth/*', (c) => betterAuth.handler(c.req.raw));
  }

  // --- authentication ---
  for (const path of ['/me', '/me/*', '/companies', '/companies/*', '/holding/*', '/admin/*']) app.use(path, requireUser(auth, db));

  /** Who is signed in, and whether the holding dashboard is theirs (the UI decides what to offer). */
  app.get('/me', async (c) => {
    const userId = c.get('userId');
    const me = await withApp(db, async (tx) => {
      const [u] = await tx.select({ id: users.id, name: users.name, email: users.email, isSystemAdmin: users.isSystemAdmin }).from(users).where(eq(users.id, userId));
      const [viewer] = await tx.select({ userId: managementViewers.userId }).from(managementViewers).where(eq(managementViewers.userId, userId));
      return u ? { ...u, holdingViewer: viewer !== undefined } : null;
    });
    if (!me) throw new HTTPException(401, { message: 'Belum masuk.' });
    return c.json({ data: me });
  });

  app.get('/me/companies', async (c) => {
    const userId = c.get('userId');
    const rows = await withApp(db, (tx) =>
      tx.select({ id: companies.id, code: companies.code, name: companies.name, role: companyUsers.role })
        .from(companyUsers).innerJoin(companies, eq(companies.id, companyUsers.companyId))
        .where(eq(companyUsers.userId, userId)),
    );
    return c.json({ data: rows });
  });

  /** One-time code to link the caller's Telegram account: send "/start <code>" to the bot (or open `link`). */
  app.post('/me/telegram-link', async (c) => {
    const { code, expiresAt } = await createLinkCode(db, c.get('userId'), now());
    const link = telegramBotUsername ? `https://t.me/${telegramBotUsername}?start=${code}` : null;
    return c.json({ data: { code, expiresAt: expiresAt.toISOString(), link } }, 201);
  });

  registerAdminRoutes(app, deps);

  app.use('/holding/*', requireHolding(db));
  registerHoldingRoutes(app, deps);

  // --- authorization: company in the path must be one the user is a member of (SEC-AUTHZ) ---
  app.use('/companies/:companyId/*', async (c, next) => {
    const { companyId } = CompanyParams.parse(c.req.param());
    const userId = c.get('userId');
    const member = await withApp(db, (tx) =>
      tx.query.companyUsers.findFirst({ where: and(eq(companyUsers.userId, userId), eq(companyUsers.companyId, companyId)) }),
    );
    if (!member) throw new HTTPException(403, { message: 'Anda tidak terdaftar pada perusahaan ini.' });
    c.set('companyId', companyId);
    c.set('role', member.role);
    c.set('tenant', { companyId, userId, siteIds: siteScopeFor(member.role, member.siteIds) });
    await next();
  });

  registerMemberRoutes(app, '/companies/:companyId/members', deps, { canRead: async (_c, next) => { await next(); }, canWrite: requireRole(MANAGE_ROLES) });
  registerCompanyRoutes(app, deps);
  registerVendorRoutes(app, deps);
  registerIntakeRoutes(app, deps, storage);
  registerProcurementRoutes(app, deps);
  registerProgressRoutes(app, deps);
  registerFinanceRoutes(app, deps);
  registerDashboardRoutes(app, deps);

  return app;
}

function pgCode(err: unknown): string | undefined {
  return (err as { code?: string; cause?: { code?: string } })?.cause?.code ?? (err as { code?: string })?.code;
}
