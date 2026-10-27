import { eq, sql } from 'drizzle-orm';
import type { Context, Hono, MiddlewareHandler } from 'hono';
import { HTTPException } from 'hono/http-exception';
import { z } from 'zod';
import type { Authenticator } from '../auth/authenticator.js';
import { managementViewers, users, type CompanyRole } from '../db/schema.js';
import { withApp, type Db, type TenantCtx } from '../db/tenant.js';

/** Per-request values set by the middlewares below. */
export type Vars = {
  userId: number;
  isSystemAdmin: boolean;
  companyId: number;
  role: CompanyRole;
  /** company + acting user + site scope, passed to withCompany() by every company route */
  tenant: TenantCtx;
};
export type AppEnv = { Variables: Vars };
export type App = Hono<AppEnv>;

export interface RouteDeps {
  db: Db;
  maxUploadBytes: number;
  /** clock for due dates / days-left; injectable for tests */
  now: () => Date;
}

/** Roles allowed to manage members of their company. */
export const MANAGE_ROLES: readonly CompanyRole[] = ['company_manager', 'system_admin'];
/** Master data (sites, contracts, termin, addendum, BOQ). */
export const EDIT_ROLES: readonly CompanyRole[] = ['project_admin', 'company_manager', 'system_admin'];
/** Invoicing and payments (HLD §2 "Keuangan"). */
export const FINANCE_ROLES: readonly CompanyRole[] = ['finance', 'company_manager', 'system_admin'];
/** Approvals of PR, PO and progress (HLD §2 "Manajer perusahaan: persetujuan PO dan progres"). */
export const APPROVE_ROLES: readonly CompanyRole[] = ['company_manager', 'system_admin'];
/** Opname input (HLD §2 "Staf site: input opname") plus the office roles. */
export const OPNAME_ROLES: readonly CompanyRole[] = ['site_staff', 'project_admin', 'company_manager', 'system_admin'];

export const IdParam = z.coerce.number().int().positive();
export const CompanyParams = z.object({ companyId: IdParam });
export const ContractParams = z.object({ companyId: IdParam, contractId: IdParam });

/**
 * Authenticates, then loads the user row: a deactivated account is refused even with a valid
 * session (sessions are also deleted on deactivation, see admin routes).
 */
export function requireUser(auth: Authenticator, db: Db): MiddlewareHandler<AppEnv> {
  return async (c, next) => {
    const p = await auth.authenticate(c);
    if (!p) throw new HTTPException(401, { message: 'Belum masuk.' });
    const user = await withApp(db, (tx) =>
      tx.query.users.findFirst({ where: eq(users.id, p.userId), columns: { isActive: true, isSystemAdmin: true } }),
    );
    if (!user) throw new HTTPException(401, { message: 'Belum masuk.' });
    if (!user.isActive) throw new HTTPException(403, { message: 'Akun dinonaktifkan.' });
    c.set('userId', p.userId);
    c.set('isSystemAdmin', user.isSystemAdmin);
    await next();
  };
}

export function requireRole(roles: readonly CompanyRole[]): MiddlewareHandler<AppEnv> {
  return async (c, next) => {
    if (!roles.includes(c.get('role'))) throw new HTTPException(403, { message: 'Peran Anda tidak berwenang untuk tindakan ini.' });
    await next();
  };
}

/** HLD §2 "Admin sistem": configuration only (companies, users, roles, Telegram mapping). */
export const requireSystemAdmin: MiddlewareHandler<AppEnv> = async (c, next) => {
  if (!c.get('isSystemAdmin')) throw new HTTPException(403, { message: 'Hanya admin sistem.' });
  await next();
};

/**
 * The holding gate (LLD §4 `can:holding-read` + `AuditHoldingAccess`): only management_viewers pass,
 * and every request is logged with route and filters before any data is read.
 */
export function requireHolding(db: Db): MiddlewareHandler<AppEnv> {
  return async (c, next) => {
    const userId = c.get('userId');
    const viewer = await withApp(db, (tx) => tx.query.managementViewers.findFirst({ where: eq(managementViewers.userId, userId) }));
    if (!viewer) throw new HTTPException(403, { message: 'Bukan holding viewer.' });
    const meta = { method: c.req.method, path: c.req.path, query: c.req.queries() };
    // separate transaction: holding reads run read-only (withHoldingRead) and could not write the log
    await withApp(db, (tx) =>
      tx.execute(sql`SELECT jiat_audit_event(NULL, ${userId}, 'holding_access', 'route', NULL, ${JSON.stringify(meta)}::jsonb, ${clientIp(c)})`),
    );
    await next();
  };
}

/** Best effort, for the audit log only (never for authorization): first X-Forwarded-For hop. */
export function clientIp(c: Context): string | null {
  return c.req.header('x-forwarded-for')?.split(',')[0]?.trim() || c.req.header('x-real-ip') || null;
}

/** JSON body through a zod schema (ZodError / SyntaxError are mapped to 400 by onError). */
export async function jsonBody<T extends z.ZodType>(c: Context, schema: T): Promise<z.infer<T>> {
  return schema.parse(await c.req.json());
}

/** Exported for tests. Errors other than HTTPException propagate to onError (generic 500). */
export async function readUpload(c: Context, max: number): Promise<{ bytes: Buffer; name: string | undefined }> {
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

export function notFound(message: string): never {
  throw new HTTPException(404, { message });
}
