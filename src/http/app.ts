import { and, asc, eq } from 'drizzle-orm';
import { Hono, type Context } from 'hono';
import { cors } from 'hono/cors';
import { HTTPException } from 'hono/http-exception';
import { z } from 'zod';
import type { Authenticator } from '../auth/authenticator.js';
import type { Auth } from '../auth/better-auth.js';
import { BoqImportError } from '../boq/errors.js';
import { importBoq } from '../boq/importer.js';
import {
  boqItems, boqVersions, companies, companyUsers, contracts, managementViewers, sites, users,
  COMPANY_ROLES, type CompanyRole,
} from '../db/schema.js';
import { withApp, withCompany, withHoldingRead, type Db } from '../db/tenant.js';

export interface AppDeps {
  db: Db;
  auth: Authenticator;
  /** When given, Better Auth's own endpoints are mounted at /api/auth/* (sign-in, sign-out, session…). */
  betterAuth?: Auth;
  trustedOrigins?: string[];
  maxUploadBytes?: number;
}
type Vars = { userId: number; companyId: number; role: CompanyRole };

const IdParam = z.coerce.number().int().positive();
const CompanyParams = z.object({ companyId: IdParam });
const ContractParams = z.object({ companyId: IdParam, contractId: IdParam });
const ImportQuery = z.object({ sheet: z.string().min(1).max(64).default('RAB') });
const MAX_UPLOAD = 15 * 1024 * 1024;

const CompanyBody = z.object({
  code: z.string().regex(/^[A-Z0-9]{2,8}$/, 'kode 2–8 huruf kapital/angka'),
  name: z.string().min(2).max(200),
  npwp: z.string().regex(/^\d{15,16}$/).optional(),
  address: z.string().max(1000).optional(),
  docPrefix: z.string().max(12).optional(),
});
const SiteBody = z.object({
  code: z.string().regex(/^[A-Z0-9-]{1,20}$/),
  name: z.string().min(2).max(200),
  location: z.string().max(500).optional(),
  province: z.string().max(100).optional(),
  startDate: z.iso.date().optional(),
  endDate: z.iso.date().optional(),
});
const ContractBody = z.object({
  siteId: IdParam,
  number: z.string().min(1).max(100),
  employerName: z.string().min(2).max(200),
  valueDppCents: z.number().int().positive(),
  ppnRateBp: z.number().int().min(0).max(10_000).default(1100),
  signedAt: z.iso.date().optional(),
  startDate: z.iso.date().optional(),
  endDate: z.iso.date().optional(),
});
const MemberBody = z.object({
  email: z.email(),
  role: z.enum(COMPANY_ROLES),
  siteIds: z.array(IdParam).max(100).optional(),
});

/** Roles allowed to manage master data / members. */
const MANAGE_ROLES: readonly CompanyRole[] = ['company_manager', 'system_admin'];
const EDIT_ROLES: readonly CompanyRole[] = ['project_admin', 'company_manager', 'system_admin'];

export function createApp({ db, auth, betterAuth, trustedOrigins = [], maxUploadBytes = MAX_UPLOAD }: AppDeps) {
  const app = new Hono<{ Variables: Vars }>();

  app.onError((err, c) => {
    if (err instanceof HTTPException) return err.getResponse();
    if (err instanceof BoqImportError) return c.json({ error: err.code, message: err.message, details: err.details }, 422);
    if (err instanceof z.ZodError) return c.json({ error: 'invalid_request', issues: err.issues }, 400);
    if (err instanceof SyntaxError) return c.json({ error: 'invalid_json', message: 'Body bukan JSON yang valid.' }, 400);
    if (isUniqueViolation(err)) return c.json({ error: 'conflict', message: 'Data dengan kode/nomor yang sama sudah ada.' }, 409);
    console.error('unhandled', err);
    return c.json({ error: 'internal', message: 'Terjadi kesalahan pada server.' }, 500);
  });

  app.get('/health', (c) => c.json({ ok: true }));

  if (betterAuth) {
    if (trustedOrigins.length) app.use('/api/auth/*', cors({ origin: trustedOrigins, credentials: true }));
    app.all('/api/auth/*', (c) => betterAuth.handler(c.req.raw));
  }

  // --- authentication ---
  app.use('/me/*', requireUser(auth));
  app.use('/companies', requireUser(auth));
  app.use('/companies/*', requireUser(auth));
  app.use('/holding/*', requireUser(auth));

  app.get('/me/companies', async (c) => {
    const userId = c.get('userId');
    const rows = await withApp(db, (tx) =>
      tx.select({ id: companies.id, code: companies.code, name: companies.name, role: companyUsers.role })
        .from(companyUsers).innerJoin(companies, eq(companies.id, companyUsers.companyId))
        .where(eq(companyUsers.userId, userId)),
    );
    return c.json({ data: rows });
  });

  /** Any signed-in user may found a company and becomes its company_manager. */
  app.post('/companies', async (c) => {
    const body = CompanyBody.parse(await c.req.json());
    const userId = c.get('userId');
    const company = await withApp(db, async (tx) => {
      const [row] = await tx.insert(companies).values(body).returning();
      await tx.insert(companyUsers).values({ userId, companyId: row!.id, role: 'company_manager' });
      return row!;
    });
    return c.json({ data: company }, 201);
  });

  /** Holding/direksi only: read-only across companies (the single cross-company door). */
  app.get('/holding/companies', async (c) => {
    const userId = c.get('userId');
    const viewer = await withApp(db, (tx) => tx.query.managementViewers.findFirst({ where: eq(managementViewers.userId, userId) }));
    if (!viewer) throw new HTTPException(403, { message: 'Bukan holding viewer.' });
    const rows = await withHoldingRead(db, (tx) => tx.select({ id: companies.id, code: companies.code, name: companies.name }).from(companies));
    return c.json({ data: rows });
  });

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
    await next();
  });

  // members
  app.get('/companies/:companyId/members', async (c) => {
    const rows = await withApp(db, (tx) =>
      tx.select({ userId: users.id, email: users.email, name: users.name, role: companyUsers.role, siteIds: companyUsers.siteIds })
        .from(companyUsers).innerJoin(users, eq(users.id, companyUsers.userId))
        .where(eq(companyUsers.companyId, c.get('companyId'))),
    );
    return c.json({ data: rows });
  });
  app.post('/companies/:companyId/members', requireRole(MANAGE_ROLES), async (c) => {
    const body = MemberBody.parse(await c.req.json());
    const companyId = c.get('companyId');
    const row = await withApp(db, async (tx) => {
      const user = await tx.query.users.findFirst({ where: eq(users.email, body.email) });
      if (!user) throw new HTTPException(404, { message: 'Pengguna dengan email tersebut belum terdaftar.' });
      const [m] = await tx.insert(companyUsers)
        .values({ userId: user.id, companyId, role: body.role, siteIds: body.siteIds ?? null })
        .onConflictDoUpdate({ target: [companyUsers.userId, companyUsers.companyId], set: { role: body.role, siteIds: body.siteIds ?? null } })
        .returning();
      return { ...m!, email: user.email };
    });
    return c.json({ data: row }, 201);
  });

  // sites
  app.get('/companies/:companyId/sites', async (c) => {
    const rows = await withCompany(db, c.get('companyId'), (tx) => tx.select().from(sites).orderBy(asc(sites.code)));
    return c.json({ data: rows });
  });
  app.post('/companies/:companyId/sites', requireRole(EDIT_ROLES), async (c) => {
    const body = SiteBody.parse(await c.req.json());
    const companyId = c.get('companyId');
    const [row] = await withCompany(db, companyId, (tx) => tx.insert(sites).values({ ...body, companyId }).returning());
    return c.json({ data: row }, 201);
  });

  // contracts
  app.get('/companies/:companyId/contracts', async (c) => {
    const rows = await withCompany(db, c.get('companyId'), (tx) => tx.select().from(contracts).orderBy(asc(contracts.number)));
    return c.json({ data: rows.map(withValueTotal) });
  });
  app.post('/companies/:companyId/contracts', requireRole(EDIT_ROLES), async (c) => {
    const body = ContractBody.parse(await c.req.json());
    const companyId = c.get('companyId');
    const row = await withCompany(db, companyId, async (tx) => {
      // the site must be this company's (RLS makes another company's site invisible => 404)
      const site = await tx.query.sites.findFirst({ where: eq(sites.id, body.siteId) });
      if (!site) throw new HTTPException(404, { message: 'Site tidak ditemukan pada perusahaan ini.' });
      const [k] = await tx.insert(contracts).values({ ...body, companyId }).returning();
      return k!;
    });
    return c.json({ data: withValueTotal(row) }, 201);
  });

  // boq
  app.post('/companies/:companyId/contracts/:contractId/boq/import', requireRole(EDIT_ROLES), async (c) => {
    const { contractId } = ContractParams.parse(c.req.param());
    const { sheet } = ImportQuery.parse(c.req.query());
    const file = await readUpload(c, maxUploadBytes);
    const summary = await withCompany(db, c.get('companyId'), (tx) =>
      importBoq(tx, contractId, file.bytes, { sheet, filename: file.name, importedBy: c.get('userId') }),
    );
    return c.json({ data: summary }, 201);
  });

  app.get('/companies/:companyId/contracts/:contractId/boq', async (c) => {
    const { contractId } = ContractParams.parse(c.req.param());
    const result = await withCompany(db, c.get('companyId'), async (tx) => {
      const version = await tx.query.boqVersions.findFirst({ where: and(eq(boqVersions.contractId, contractId), eq(boqVersions.isCurrent, true)) });
      if (!version) return null;
      const items = await tx.select().from(boqItems).where(eq(boqItems.versionId, version.id)).orderBy(asc(boqItems.sortOrder));
      return { version, items };
    });
    if (!result) throw new HTTPException(404, { message: 'Belum ada BOQ untuk kontrak ini.' });
    return c.json({ data: result });
  });

  return app;
}

/** value_total is derived (L8), never stored. */
function withValueTotal<T extends { valueDppCents: number; ppnRateBp: number }>(k: T): T & { valueTotalCents: number } {
  return { ...k, valueTotalCents: k.valueDppCents + Math.round((k.valueDppCents * k.ppnRateBp) / 10_000) };
}

function requireUser(auth: Authenticator) {
  return async (c: Context<{ Variables: Vars }>, next: () => Promise<void>) => {
    const p = await auth.authenticate(c);
    if (!p) throw new HTTPException(401, { message: 'Belum masuk.' });
    c.set('userId', p.userId);
    await next();
  };
}

function requireRole(roles: readonly CompanyRole[]) {
  return async (c: Context<{ Variables: Vars }>, next: () => Promise<void>) => {
    if (!roles.includes(c.get('role'))) throw new HTTPException(403, { message: 'Peran Anda tidak berwenang untuk tindakan ini.' });
    await next();
  };
}

function isUniqueViolation(err: unknown): boolean {
  const code = (err as { code?: string; cause?: { code?: string } })?.cause?.code ?? (err as { code?: string })?.code;
  return code === '23505';
}

async function readUpload(c: Context, max: number): Promise<{ bytes: Buffer; name: string | undefined }> {
  const len = Number(c.req.header('content-length') ?? 0);
  if (len > max) throw new HTTPException(413, { message: `Berkas melebihi ${Math.round(max / 1024 / 1024)} MB.` });
  let body: FormData;
  try {
    body = await c.req.formData();
  } catch {
    throw new HTTPException(400, { message: 'Body harus multipart/form-data dengan field "file".' });
  }
  const f = body.get('file');
  if (!(f instanceof File)) throw new HTTPException(400, { message: 'Field "file" (.xlsx) wajib ada.' });
  if (f.size > max) throw new HTTPException(413, { message: `Berkas melebihi ${Math.round(max / 1024 / 1024)} MB.` });
  return { bytes: Buffer.from(await f.arrayBuffer()), name: f.name || undefined };
}
