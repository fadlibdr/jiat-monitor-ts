import { and, eq } from 'drizzle-orm';
import { Hono } from 'hono';
import { cors } from 'hono/cors';
import { HTTPException } from 'hono/http-exception';
import { z } from 'zod';
import type { Authenticator } from '../auth/authenticator.js';
import type { Auth } from '../auth/better-auth.js';
import { BoqImportError } from '../boq/errors.js';
import { companies, companyUsers } from '../db/schema.js';
import { withApp, type Db } from '../db/tenant.js';
import { CompanyParams, requireHolding, requireUser, type AppEnv, type RouteDeps } from './context.js';
import { registerAdminRoutes } from './routes/admin.js';
import { registerCompanyRoutes } from './routes/company.js';
import { registerHoldingRoutes } from './routes/holding.js';
import { registerMemberRoutes } from './routes/members.js';
import { MANAGE_ROLES, requireRole } from './context.js';

export { readUpload } from './context.js';

export interface AppDeps {
  db: Db;
  auth: Authenticator;
  /** When given, Better Auth's own endpoints are mounted at /api/auth/* (sign-in, sign-out, session…). */
  betterAuth?: Auth;
  trustedOrigins?: string[];
  maxUploadBytes?: number;
  now?: () => Date;
}

const MAX_UPLOAD = 15 * 1024 * 1024;

export function createApp({ db, auth, betterAuth, trustedOrigins = [], maxUploadBytes = MAX_UPLOAD, now = () => new Date() }: AppDeps) {
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
    c.set('tenant', { companyId, userId, siteIds: siteScope(member.role, member.siteIds) });
    await next();
  });

  registerMemberRoutes(app, '/companies/:companyId/members', deps, { canRead: async (_c, next) => { await next(); }, canWrite: requireRole(MANAGE_ROLES) });
  registerCompanyRoutes(app, deps);

  return app;
}

/**
 * Site scope of a membership (HLD §2). site_staff see only the sites assigned to them — none until
 * assigned. Other roles see every site unless an explicit list was set on their membership.
 */
export function siteScope(role: string, siteIds: number[] | null): number[] | null {
  if (role === 'site_staff') return siteIds ?? [];
  return siteIds;
}

function pgCode(err: unknown): string | undefined {
  return (err as { code?: string; cause?: { code?: string } })?.cause?.code ?? (err as { code?: string })?.code;
}
