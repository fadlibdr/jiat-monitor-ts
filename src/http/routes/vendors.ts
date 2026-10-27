import { asc, eq } from 'drizzle-orm';
import { HTTPException } from 'hono/http-exception';
import { z } from 'zod';
import { CATEGORIES } from '../../domain/categories.js';
import { VENDOR_NAME_MAX, VENDOR_NAME_MIN } from '../../domain/vendor-name.js';
import { vendors, VENDOR_STATUSES } from '../../db/schema.js';
import { withCompany } from '../../db/tenant.js';
import { EDIT_ROLES, FINANCE_ROLES, IdParam, jsonBody, notFound, requireRole, type App, type RouteDeps } from '../context.js';

/** Same cleaning as vendorForName (trim, collapse spaces), so " Toko A" and "Toko A" cannot both exist. */
const Name = z.string().transform((s) => s.trim().replace(/\s+/g, ' ')).pipe(z.string().min(VENDOR_NAME_MIN).max(VENDOR_NAME_MAX));
/** vendors.phone is varchar(30): the length is checked as a whole, "+" included */
const Phone = z.string().max(30).regex(/^\+?[0-9 -]{6,30}$/);
const Npwp = z.string().regex(/^\d{15,16}$/);
const BankName = z.string().trim().min(1).max(100);
const BankAccount = z.string().regex(/^[0-9-]{5,40}$/);

const VendorBody = z.object({
  name: Name,
  npwp: Npwp.optional(),
  bankName: BankName.optional(),
  bankAccount: BankAccount.optional(),
  phone: Phone.optional(),
  defaultCategory: z.enum(CATEGORIES).optional(),
  status: z.enum(VENDOR_STATUSES).default('active'),
});
const VendorPatch = z.object({
  name: Name.optional(),
  npwp: Npwp.nullable().optional(),
  bankName: BankName.nullable().optional(),
  bankAccount: BankAccount.nullable().optional(),
  phone: Phone.nullable().optional(),
  defaultCategory: z.enum(CATEGORIES).nullable().optional(),
  status: z.enum(VENDOR_STATUSES).optional(),
}).refine((b) => Object.keys(b).length > 0, 'body kosong');
const VendorParams = z.object({ companyId: IdParam, vendorId: IdParam });

type VendorRow = typeof vendors.$inferSelect;
/** HLD §8 / UU 27/2022: personal and payment data of a vendor */
const PII_FIELDS = ['npwp', 'bankName', 'bankAccount'] as const;
const WRITE_ROLES = [...new Set([...EDIT_ROLES, ...FINANCE_ROLES])];

/**
 * Vendor master per company (HLD §7). Bank account and NPWP are personal/financial data
 * (HLD §8, UU 27/2022): only finance and managers see them — and only they may WRITE them. A role
 * that cannot see the payment account must not be able to replace it either (redirecting a
 * vendor's payments is the classic fraud), so such a body is refused with 403, not silently cut.
 * The admin keeps managing the rest of the vendor (name, phone, category, status).
 */
export function registerVendorRoutes(app: App, { db }: RouteDeps): void {
  const sees = (role: string) => (FINANCE_ROLES as readonly string[]).includes(role);
  const shape = (v: VendorRow, role: string) => (sees(role) ? v : { ...v, npwp: null, bankName: null, bankAccount: null });
  const guardPii = (role: string, body: object) => {
    const touched = PII_FIELDS.filter((f) => f in body);
    if (touched.length && !sees(role)) {
      throw new HTTPException(403, { message: `Hanya keuangan / manajer yang boleh mengubah ${touched.join(', ')}.` });
    }
  };

  app.get('/companies/:companyId/vendors', async (c) => {
    const rows = await withCompany(db, c.get('tenant'), (tx) => tx.select().from(vendors).orderBy(asc(vendors.name)));
    return c.json({ data: rows.map((v) => shape(v, c.get('role'))) });
  });
  app.post('/companies/:companyId/vendors', requireRole(WRITE_ROLES), async (c) => {
    const body = await jsonBody(c, VendorBody);
    guardPii(c.get('role'), body);
    const companyId = c.get('companyId');
    const [row] = await withCompany(db, c.get('tenant'), (tx) => tx.insert(vendors).values({ ...body, companyId }).returning());
    return c.json({ data: shape(row!, c.get('role')) }, 201);
  });
  app.patch('/companies/:companyId/vendors/:vendorId', requireRole(WRITE_ROLES), async (c) => {
    const { vendorId } = VendorParams.parse(c.req.param());
    const body = await jsonBody(c, VendorPatch);
    guardPii(c.get('role'), body);
    const [row] = await withCompany(db, c.get('tenant'), (tx) => tx.update(vendors).set(body).where(eq(vendors.id, vendorId)).returning());
    if (!row) notFound('Vendor tidak ditemukan.');
    return c.json({ data: shape(row, c.get('role')) });
  });
}
