import { and, asc, eq } from 'drizzle-orm';
import { Hono, type Context } from 'hono';
import { HTTPException } from 'hono/http-exception';
import { z } from 'zod';
import type { Authenticator } from '../auth/authenticator.js';
import { BoqImportError } from '../boq/errors.js';
import { importBoq } from '../boq/importer.js';
import { boqItems, boqVersions, companies, companyUsers, managementViewers } from '../db/schema.js';
import { withApp, withCompany, withHoldingRead, type Db } from '../db/tenant.js';

export interface AppDeps { db: Db; auth: Authenticator; maxUploadBytes?: number }
type Vars = { userId: number; companyId: number };

const IdParam = z.coerce.number().int().positive();
const CompanyParams = z.object({ companyId: IdParam });
const ContractParams = z.object({ companyId: IdParam, contractId: IdParam });
const ImportQuery = z.object({ sheet: z.string().min(1).max(64).default('RAB') });
const MAX_UPLOAD = 15 * 1024 * 1024;

export function createApp({ db, auth, maxUploadBytes = MAX_UPLOAD }: AppDeps) {
  const app = new Hono<{ Variables: Vars }>();

  app.onError((err, c) => {
    if (err instanceof HTTPException) return err.getResponse();
    if (err instanceof BoqImportError) return c.json({ error: err.code, message: err.message, details: err.details }, 422);
    if (err instanceof z.ZodError) return c.json({ error: 'invalid_request', issues: err.issues }, 400);
    console.error('unhandled', err);
    return c.json({ error: 'internal', message: 'Terjadi kesalahan pada server.' }, 500);
  });

  app.get('/health', (c) => c.json({ ok: true }));

  // --- authentication: every route below needs a principal ---
  app.use('/me/*', requireUser(auth));
  app.use('/companies/*', requireUser(auth));

  app.get('/me/companies', async (c) => {
    const userId = c.get('userId');
    const rows = await withApp(db, (tx) =>
      tx.select({ id: companies.id, code: companies.code, name: companies.name, role: companyUsers.role })
        .from(companyUsers).innerJoin(companies, eq(companies.id, companyUsers.companyId))
        .where(eq(companyUsers.userId, userId)),
    );
    return c.json({ data: rows });
  });

  /** Holding/direksi only: read-only list of every company (the single cross-company door). */
  app.get('/holding/companies', requireUser(auth), async (c) => {
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
    await next();
  });

  app.post('/companies/:companyId/contracts/:contractId/boq/import', async (c) => {
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

function requireUser(auth: Authenticator) {
  return async (c: Context<{ Variables: Vars }>, next: () => Promise<void>) => {
    const p = await auth.authenticate(c);
    if (!p) throw new HTTPException(401, { message: 'Belum masuk.' });
    c.set('userId', p.userId);
    await next();
  };
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
