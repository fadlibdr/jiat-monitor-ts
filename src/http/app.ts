import { and, eq } from 'drizzle-orm';
import { Hono } from 'hono';
import { cors } from 'hono/cors';
import { HTTPException } from 'hono/http-exception';
import { z } from 'zod';
import type { Authenticator } from '../auth/authenticator.js';
import type { Auth } from '../auth/better-auth.js';
import { BoqImportError } from '../boq/errors.js';
import { companies, companyUsers } from '../db/schema.js';
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
}

const MAX_UPLOAD = 15 * 1024 * 1024;

export function createApp({
  db, auth, betterAuth, trustedOrigins = [], maxUploadBytes = MAX_UPLOAD, now = () => new Date(), storage, telegramWebhookSecret,
}: AppDeps) {
  const app = new Hono<AppEnv>();
  const deps: RouteDeps = { db, maxUploadBytes, now };

  app.onError((err, c) => {
    if (err instanceof HTTPException) return err.getResponse();
    if (err instanceof BoqImportError) return c.json({ error: err.code, message: err.message, details: err.details }, 422);
    if (err instanceof z.ZodError) return c.json({ error: 'invalid_request', issues: err.issues }, 400);
    if (err instanceof SyntaxError) return c.json({ error: 'invalid_json', message: 'Body bukan JSON yang valid.' }, 400);
    switch (pgCode(err)) {
      case '23505': return c.json({ error: 'conflict', message: 'Data dengan kode/nomor yang sama sudah ada.' }, 409);
      case '23503': return c.json({ error: 'conflict', message: 'Data masih dirujuk oleh data lain.' }, 409);
      // RLS WITH CHECK: e.g. writing a row for a site outside the caller's scope
      case '42501': return c.json({ error: 'forbidden', message: 'Akses ditolak oleh kebijakan data.' }, 403);
    }
    console.error('unhandled', err);
    return c.json({ error: 'internal', message: 'Terjadi kesalahan pada server.' }, 500);
  });

  app.get('/health', (c) => c.json({ ok: true }));

  // Telegram authenticates with its secret token, not a session (registered before the session gates)
  registerTelegramWebhook(app, { db, secret: telegramWebhookSecret });

  if (betterAuth) {
    if (trustedOrigins.length) app.use('/api/auth/*', cors({ origin: trustedOrigins, credentials: true }));
    app.all('/api/auth/*', (c) => betterAuth.handler(c.req.raw));
  }

  // --- authentication ---
  for (const path of ['/me/*', '/companies', '/companies/*', '/holding/*', '/admin/*']) app.use(path, requireUser(auth, db));

  app.get('/me/companies', async (c) => {
    const userId = c.get('userId');
    const rows = await withApp(db, (tx) =>
      tx.select({ id: companies.id, code: companies.code, name: companies.name, role: companyUsers.role })
        .from(companyUsers).innerJoin(companies, eq(companies.id, companyUsers.companyId))
        .where(eq(companyUsers.userId, userId)),
    );
    return c.json({ data: rows });
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
