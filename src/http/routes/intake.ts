import { and, asc, desc, eq, inArray, type SQL } from 'drizzle-orm';
import { HTTPException } from 'hono/http-exception';
import { z } from 'zod';
import { CATEGORIES } from '../../domain/categories.js';
import { parseIdrCents } from '../../domain/money.js';
import { parseIndonesianDate } from '../../domain/date.js';
import { attachments, vendorInvoices, VENDOR_INVOICE_STATUSES } from '../../db/schema.js';
import { withCompany } from '../../db/tenant.js';
import { applyChanges, type Change, type VendorInvoiceRow } from '../../intake/review.js';
import type { ObjectStorage } from '../../intake/storage.js';
import {
  EDIT_ROLES, FINANCE_ROLES, IdParam, jsonBody, notFound, requireRole, type App, type RouteDeps,
} from '../context.js';

const REVIEW_ROLES = [...new Set([...EDIT_ROLES, ...FINANCE_ROLES])];
const RowParams = z.object({ companyId: IdParam, rowId: z.uuid() });
const ReviewQuery = z.object({
  status: z.enum(VENDOR_INVOICE_STATUSES).optional(),
  siteId: IdParam.optional(),
  limit: z.coerce.number().int().min(1).max(200).default(50),
});
/** The review screen sends what it edits; money as integer cents or as text ("Rp 2.450.000,-"). */
const ReviewPatch = z.object({
  category: z.enum(CATEGORIES).optional(),
  totalCents: z.union([z.number().int().positive(), z.string().min(1)]).optional(),
  vendorId: IdParam.optional(),
  vendorName: z.string().trim().min(2).max(200).optional(),
  invoiceDate: z.string().min(6).max(30).optional(),
  docNumber: z.string().min(1).max(100).optional(),
  status: z.enum(['terkonfirmasi', 'ditolak']).optional(),
}).refine((b) => Object.keys(b).length > 0, 'body kosong');

/**
 * Review screen API (LLD §7 IntakeReview). PATCH goes through the same applyChanges() as chat
 * corrections, so validation, flags and the audit trail are one path.
 */
export function registerIntakeRoutes(app: App, { db, now }: RouteDeps, storage: ObjectStorage | undefined): void {
  app.get('/companies/:companyId/intake/review', requireRole(REVIEW_ROLES), async (c) => {
    const q = ReviewQuery.parse(c.req.query());
    const where: SQL[] = [q.status ? eq(vendorInvoices.status, q.status) : inArray(vendorInvoices.status, ['perlu_konfirmasi', 'perlu_cek'])];
    if (q.siteId) where.push(eq(vendorInvoices.siteId, q.siteId));
    const rows = await withCompany(db, c.get('tenant'), (tx) =>
      tx.select().from(vendorInvoices).where(and(...where)).orderBy(desc(vendorInvoices.createdAt), asc(vendorInvoices.id)).limit(q.limit));
    return c.json({ data: rows.map((r) => publicRow(r, c.get('role'))) });
  });

  app.patch('/companies/:companyId/intake/:rowId', requireRole(EDIT_ROLES), async (c) => {
    const { rowId } = RowParams.parse(c.req.param());
    const body = await jsonBody(c, ReviewPatch);
    const changes: Change[] = [];
    if (body.vendorId !== undefined) changes.push({ field: 'vendorId', value: body.vendorId });
    else if (body.vendorName !== undefined) changes.push({ field: 'vendorName', value: body.vendorName });
    if (body.category) changes.push({ field: 'category', value: body.category });
    if (body.totalCents !== undefined) {
      const cents = typeof body.totalCents === 'number' ? body.totalCents : parseIdrCents(body.totalCents);
      if (cents === null || cents <= 0) throw new HTTPException(400, { message: 'total tidak terbaca' });
      changes.push({ field: 'totalCents', value: cents });
    }
    if (body.invoiceDate !== undefined) {
      const iso = parseIndonesianDate(body.invoiceDate);
      if (!iso) throw new HTTPException(400, { message: 'tanggal tidak terbaca' });
      changes.push({ field: 'invoiceDate', value: iso });
    }
    if (body.docNumber !== undefined) changes.push({ field: 'docNumber', value: body.docNumber });
    if (body.status) changes.push({ field: 'status', value: body.status });

    const r = await withCompany(db, c.get('tenant'), (tx) => applyChanges(tx, rowId, changes, { channel: 'admin', userId: c.get('userId'), today: now() }));
    if (r.ok) return c.json({ data: publicRow(r.row, c.get('role')) });
    if (r.reason === 'not_found') notFound('Nota tidak ditemukan.');
    const message = r.reason === 'closed' ? 'Nota sudah ditutup (terkonfirmasi/ditolak).'
      : r.reason === 'confirm_blocked' ? 'Belum bisa dikonfirmasi.' : 'Sudah ada nota terkonfirmasi dengan vendor, tanggal, dan total yang sama.';
    return c.json({ error: r.reason, message, flags: r.flags ?? [] }, 409);
  });

  /** Original photo for the review thumbnail/zoom; never a public URL. */
  app.get('/companies/:companyId/intake/:rowId/photo', requireRole(REVIEW_ROLES), async (c) => {
    const { rowId } = RowParams.parse(c.req.param());
    if (!storage) throw new HTTPException(503, { message: 'Storage tidak dikonfigurasi.' });
    const file = await withCompany(db, c.get('tenant'), async (tx) => {
      const [inv] = await tx.select({ id: vendorInvoices.id }).from(vendorInvoices).where(eq(vendorInvoices.rowId, rowId));
      if (!inv) return null;
      const [a] = await tx.select({ path: attachments.path, mime: attachments.mime }).from(attachments)
        .where(and(eq(attachments.attachableType, 'vendor_invoices'), eq(attachments.attachableId, inv.id))).limit(1);
      return a ?? null;
    });
    if (!file) notFound('Foto tidak ditemukan.');
    const bytes = await storage.get(file.path);
    return c.body(new Uint8Array(bytes), 200, { 'content-type': file.mime, 'cache-control': 'private, max-age=3600', 'x-content-type-options': 'nosniff' });
  });
}

/**
 * API shape: no internal id (LLD §2: row_id is the public reference), and the vendor NPWP read from
 * the receipt only for finance and managers (HLD §8, as in the vendors API).
 */
function publicRow(r: VendorInvoiceRow, role: string) {
  const { id: _id, companyId: _companyId, ...rest } = r;
  return (FINANCE_ROLES as readonly string[]).includes(role) ? rest : { ...rest, npwp: null };
}
