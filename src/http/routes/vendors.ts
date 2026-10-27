import { asc, eq } from 'drizzle-orm';
import { z } from 'zod';
import { CATEGORIES } from '../../domain/categories.js';
import { vendors, VENDOR_STATUSES } from '../../db/schema.js';
import { withCompany } from '../../db/tenant.js';
import { EDIT_ROLES, FINANCE_ROLES, IdParam, jsonBody, notFound, requireRole, type App, type RouteDeps } from '../context.js';

const VendorBody = z.object({
  name: z.string().min(2).max(200),
  npwp: z.string().regex(/^\d{15,16}$/).optional(),
  bankName: z.string().max(100).optional(),
  bankAccount: z.string().regex(/^[0-9-]{5,40}$/).optional(),
  phone: z.string().regex(/^\+?[0-9 -]{6,30}$/).optional(),
  defaultCategory: z.enum(CATEGORIES).optional(),
  status: z.enum(VENDOR_STATUSES).default('active'),
});
const VendorPatch = z.object({
  name: z.string().min(2).max(200).optional(),
  npwp: z.string().regex(/^\d{15,16}$/).nullable().optional(),
  bankName: z.string().max(100).nullable().optional(),
  bankAccount: z.string().regex(/^[0-9-]{5,40}$/).nullable().optional(),
  phone: z.string().regex(/^\+?[0-9 -]{6,30}$/).nullable().optional(),
  defaultCategory: z.enum(CATEGORIES).nullable().optional(),
  status: z.enum(VENDOR_STATUSES).optional(),
}).refine((b) => Object.keys(b).length > 0, 'body kosong');
const VendorParams = z.object({ companyId: IdParam, vendorId: IdParam });

type VendorRow = typeof vendors.$inferSelect;

/**
 * Vendor master per company (HLD §7). Bank account and NPWP are personal/financial data
 * (HLD §8, UU 27/2022): only finance and managers see them; everyone else gets null.
 */
export function registerVendorRoutes(app: App, { db }: RouteDeps): void {
  const sees = (role: string) => (FINANCE_ROLES as readonly string[]).includes(role);
  const shape = (v: VendorRow, role: string) => (sees(role) ? v : { ...v, npwp: null, bankName: null, bankAccount: null });

  app.get('/companies/:companyId/vendors', async (c) => {
    const rows = await withCompany(db, c.get('tenant'), (tx) => tx.select().from(vendors).orderBy(asc(vendors.name)));
    return c.json({ data: rows.map((v) => shape(v, c.get('role'))) });
  });
  app.post('/companies/:companyId/vendors', requireRole(EDIT_ROLES), async (c) => {
    const body = await jsonBody(c, VendorBody);
    const companyId = c.get('companyId');
    const [row] = await withCompany(db, c.get('tenant'), (tx) => tx.insert(vendors).values({ ...body, companyId }).returning());
    return c.json({ data: shape(row!, c.get('role')) }, 201);
  });
  app.patch('/companies/:companyId/vendors/:vendorId', requireRole(EDIT_ROLES), async (c) => {
    const { vendorId } = VendorParams.parse(c.req.param());
    const body = await jsonBody(c, VendorPatch);
    const [row] = await withCompany(db, c.get('tenant'), (tx) => tx.update(vendors).set(body).where(eq(vendors.id, vendorId)).returning());
    if (!row) notFound('Vendor tidak ditemukan.');
    return c.json({ data: shape(row, c.get('role')) });
  });
}
