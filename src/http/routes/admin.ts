import { asc, eq } from 'drizzle-orm';
import type { MiddlewareHandler } from 'hono';
import { HTTPException } from 'hono/http-exception';
import { z } from 'zod';
import { companies, companyUsers, managementViewers, MANAGEMENT_ROLES, sessions, users } from '../../db/schema.js';
import { withApp } from '../../db/tenant.js';
import { CompanyParams, IdParam, jsonBody, notFound, requireSystemAdmin, type App, type AppEnv, type RouteDeps } from '../context.js';
import { registerMemberRoutes } from './members.js';

const CompanyBody = z.object({
  code: z.string().regex(/^[A-Z0-9]{2,8}$/, 'kode 2–8 huruf kapital/angka'),
  name: z.string().min(2).max(200),
  npwp: z.string().regex(/^\d{15,16}$/).optional(),
  address: z.string().max(1000).optional(),
  bankName: z.string().max(100).optional(),
  bankAccount: z.string().regex(/^[0-9-]{5,40}$/).optional(),
  logoPath: z.string().max(500).optional(),
  docPrefix: z.string().max(12).optional(),
});
const CreateCompanyBody = CompanyBody.extend({
  /** first company_manager; the admin who creates the company does not become a member (config ≠ data) */
  managerEmail: z.email().optional(),
});
const CompanyPatch = CompanyBody.omit({ code: true }).partial().refine((b) => Object.keys(b).length > 0, 'body kosong');

const UserParams = z.object({ userId: IdParam });
const UserPatch = z.object({
  name: z.string().min(2).max(200).optional(),
  phone: z.string().regex(/^\+?[0-9 -]{6,30}$/).nullable().optional(),
  telegramUserId: z.number().int().positive().nullable().optional(),
  isActive: z.boolean().optional(),
  isSystemAdmin: z.boolean().optional(),
}).refine((b) => Object.keys(b).length > 0, 'body kosong');

const ViewerBody = z.object({ email: z.email(), role: z.enum(MANAGEMENT_ROLES) });

const publicUser = {
  id: users.id, email: users.email, name: users.name, phone: users.phone,
  telegramUserId: users.telegramUserId, isActive: users.isActive, isSystemAdmin: users.isSystemAdmin,
};

/** HLD §2 "Admin sistem": companies, users, roles, holding viewers. Configuration, never transaction data. */
export function registerAdminRoutes(app: App, deps: RouteDeps): void {
  const { db } = deps;
  app.use('/admin/*', requireSystemAdmin);

  // --- companies ---
  app.get('/admin/companies', async (c) => {
    const rows = await withApp(db, (tx) => tx.select().from(companies).orderBy(asc(companies.code)));
    return c.json({ data: rows });
  });
  app.post('/admin/companies', async (c) => {
    const { managerEmail, ...body } = await jsonBody(c, CreateCompanyBody);
    const company = await withApp(db, async (tx) => {
      const [row] = await tx.insert(companies).values(body).returning();
      if (managerEmail) {
        const manager = await tx.query.users.findFirst({ where: eq(users.email, managerEmail) });
        if (!manager) throw new HTTPException(404, { message: 'managerEmail belum terdaftar sebagai pengguna.' });
        await tx.insert(companyUsers).values({ userId: manager.id, companyId: row!.id, role: 'company_manager' });
      }
      return row!;
    }, c.get('userId'));
    return c.json({ data: company }, 201);
  });
  app.patch('/admin/companies/:companyId', async (c) => {
    const { companyId } = CompanyParams.parse(c.req.param());
    const body = await jsonBody(c, CompanyPatch);
    const [row] = await withApp(db, (tx) =>
      tx.update(companies).set({ ...body, updatedAt: new Date() }).where(eq(companies.id, companyId)).returning(), c.get('userId'));
    if (!row) notFound('Perusahaan tidak ditemukan.');
    return c.json({ data: row });
  });
  const pass: MiddlewareHandler<AppEnv> = async (_c, next) => { await next(); };
  registerMemberRoutes(app, '/admin/companies/:companyId/members', deps, { canRead: pass, canWrite: pass });

  // --- users ---
  app.get('/admin/users', async (c) => {
    const rows = await withApp(db, (tx) => tx.select(publicUser).from(users).orderBy(asc(users.email)));
    return c.json({ data: rows });
  });
  app.patch('/admin/users/:userId', async (c) => {
    const { userId } = UserParams.parse(c.req.param());
    const body = await jsonBody(c, UserPatch);
    if (userId === c.get('userId') && (body.isActive === false || body.isSystemAdmin === false)) {
      throw new HTTPException(409, { message: 'Tidak dapat menonaktifkan atau mencabut admin dari akun sendiri.' });
    }
    const row = await withApp(db, async (tx) => {
      const [u] = await tx.update(users).set({ ...body, updatedAt: new Date() }).where(eq(users.id, userId)).returning(publicUser);
      if (!u) notFound('Pengguna tidak ditemukan.');
      // deactivation ends every session now, not at the next expiry
      if (body.isActive === false) await tx.delete(sessions).where(eq(sessions.userId, userId));
      return u;
    }, c.get('userId'));
    return c.json({ data: row });
  });

  // --- holding / direksi (management_viewers) ---
  app.get('/admin/management-viewers', async (c) => {
    const rows = await withApp(db, (tx) =>
      tx.select({ userId: users.id, email: users.email, name: users.name, role: managementViewers.role, grantedBy: managementViewers.grantedBy, grantedAt: managementViewers.grantedAt })
        .from(managementViewers).innerJoin(users, eq(users.id, managementViewers.userId)).orderBy(asc(users.email)),
    );
    return c.json({ data: rows });
  });
  app.post('/admin/management-viewers', async (c) => {
    const body = await jsonBody(c, ViewerBody);
    const actor = c.get('userId');
    const row = await withApp(db, async (tx) => {
      const user = await tx.query.users.findFirst({ where: eq(users.email, body.email) });
      if (!user) throw new HTTPException(404, { message: 'Pengguna dengan email tersebut belum terdaftar.' });
      const [v] = await tx.insert(managementViewers)
        .values({ userId: user.id, role: body.role, grantedBy: actor, grantedAt: new Date() })
        .onConflictDoUpdate({ target: managementViewers.userId, set: { role: body.role, grantedBy: actor, grantedAt: new Date(), updatedAt: new Date() } })
        .returning();
      return v!;
    }, actor);
    return c.json({ data: row }, 201);
  });
  app.delete('/admin/management-viewers/:userId', async (c) => {
    const { userId } = UserParams.parse(c.req.param());
    const gone = await withApp(db, (tx) => tx.delete(managementViewers).where(eq(managementViewers.userId, userId)).returning(), c.get('userId'));
    if (!gone.length) notFound('Pengguna ini bukan holding viewer.');
    return c.body(null, 204);
  });
}
