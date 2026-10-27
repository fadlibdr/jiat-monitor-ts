import { and, eq, ne } from 'drizzle-orm';
import type { MiddlewareHandler } from 'hono';
import { HTTPException } from 'hono/http-exception';
import { z } from 'zod';
import { companies, companyUsers, users, COMPANY_ROLES } from '../../db/schema.js';
import { withApp, type Tx } from '../../db/tenant.js';
import { CompanyParams, IdParam, jsonBody, type App, type AppEnv, type RouteDeps } from '../context.js';

const MemberBody = z.object({
  email: z.email(),
  role: z.enum(COMPANY_ROLES),
  siteIds: z.array(IdParam).max(100).optional(),
});
const MemberParams = CompanyParams.extend({ userId: IdParam });

/**
 * Membership endpoints under `prefix` (must contain `:companyId`): mounted for company managers
 * at /companies/:companyId/members and for system admins at /admin/companies/:companyId/members.
 * `canRead`/`canWrite` are the guards of each mount.
 */
export function registerMemberRoutes(
  app: App, prefix: string, { db }: RouteDeps, guards: { canRead: MiddlewareHandler<AppEnv>; canWrite: MiddlewareHandler<AppEnv> },
): void {
  app.get(prefix, guards.canRead, async (c) => {
    const { companyId } = CompanyParams.parse(c.req.param());
    const rows = await withApp(db, async (tx) => {
      await assertCompany(tx, companyId);
      return tx.select({ userId: users.id, email: users.email, name: users.name, role: companyUsers.role, siteIds: companyUsers.siteIds })
        .from(companyUsers).innerJoin(users, eq(users.id, companyUsers.userId))
        .where(eq(companyUsers.companyId, companyId));
    });
    return c.json({ data: rows });
  });

  /** Upsert: the same call adds a member or changes role/sites. */
  app.post(prefix, guards.canWrite, async (c) => {
    const { companyId } = CompanyParams.parse(c.req.param());
    const body = await jsonBody(c, MemberBody);
    const row = await withApp(db, async (tx) => {
      await assertCompany(tx, companyId);
      const user = await tx.query.users.findFirst({ where: eq(users.email, body.email) });
      if (!user) throw new HTTPException(404, { message: 'Pengguna dengan email tersebut belum terdaftar.' });
      if (body.role !== 'company_manager') await assertNotLastManager(tx, companyId, user.id);
      const [m] = await tx.insert(companyUsers)
        .values({ userId: user.id, companyId, role: body.role, siteIds: body.siteIds ?? null })
        .onConflictDoUpdate({ target: [companyUsers.userId, companyUsers.companyId], set: { role: body.role, siteIds: body.siteIds ?? null, updatedAt: new Date() } })
        .returning();
      return { ...m!, email: user.email };
    }, c.get('userId'));
    return c.json({ data: row }, 201);
  });

  app.delete(`${prefix}/:userId`, guards.canWrite, async (c) => {
    const { companyId, userId } = MemberParams.parse(c.req.param());
    await withApp(db, async (tx) => {
      await assertCompany(tx, companyId);
      await assertNotLastManager(tx, companyId, userId);
      const gone = await tx.delete(companyUsers)
        .where(and(eq(companyUsers.companyId, companyId), eq(companyUsers.userId, userId)))
        .returning({ userId: companyUsers.userId });
      if (!gone.length) throw new HTTPException(404, { message: 'Bukan anggota perusahaan ini.' });
    }, c.get('userId'));
    return c.body(null, 204);
  });
}

async function assertCompany(tx: Tx, companyId: number): Promise<void> {
  const company = await tx.query.companies.findFirst({ where: eq(companies.id, companyId), columns: { id: true } });
  if (!company) throw new HTTPException(404, { message: 'Perusahaan tidak ditemukan.' });
}

/** A company must keep at least one company_manager, or nobody could manage its members again. */
async function assertNotLastManager(tx: Tx, companyId: number, userId: number): Promise<void> {
  const target = await tx.query.companyUsers.findFirst({ where: and(eq(companyUsers.companyId, companyId), eq(companyUsers.userId, userId)) });
  if (target?.role !== 'company_manager') return;
  const others = await tx.select({ userId: companyUsers.userId }).from(companyUsers)
    .where(and(eq(companyUsers.companyId, companyId), eq(companyUsers.role, 'company_manager'), ne(companyUsers.userId, userId)))
    .limit(1);
  if (!others.length) throw new HTTPException(409, { message: 'Perusahaan harus tetap punya minimal satu company_manager.' });
}
