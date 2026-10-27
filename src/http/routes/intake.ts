import { and, desc, eq, inArray, sql, type SQL } from 'drizzle-orm';
import { HTTPException } from 'hono/http-exception';
import { z } from 'zod';
import { CATEGORIES } from '../../domain/categories.js';
import { parseIdrCents } from '../../domain/money.js';
import { parseIndonesianDate } from '../../domain/date.js';
import { attachments, vendorInvoices, VENDOR_INVOICE_STATUSES } from '../../db/schema.js';
import { withCompany } from '../../db/tenant.js';
import { applyChanges, type Change, type VendorInvoiceRow } from '../../intake/review.js';
import type { ObjectStorage } from '../../intake/storage.js';
import { matchCandidates, setMatch } from '../../procurement/matching.js';
import {
  EDIT_ROLES, FINANCE_ROLES, IdParam, jsonBody, notFound, requireRole, type App, type RouteDeps,
} from '../context.js';

const REVIEW_ROLES = [...new Set([...EDIT_ROLES, ...FINANCE_ROLES])];
const RowParams = z.object({ companyId: IdParam, rowId: z.uuid() });
const ReviewQuery = z.object({
  status: z.enum(VENDOR_INVOICE_STATUSES).optional(),
  siteId: IdParam.optional(),
  limit: z.coerce.number().int().min(1).max(200).default(50),
  /** "<created_at, microseconds, UTC>~<row_id>" from the previous page's nextCursor */
  cursor: z.string().regex(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{6}Z~[0-9a-f-]{36}$/i, 'cursor tidak valid')
    .transform((s) => { const [at, rowId] = s.split('~') as [string, string]; return { at, rowId }; }).optional(),
});
/** The review screen sends what it edits; money as integer cents or as text ("Rp 2.450.000,-"). */
const ReviewPatch = z.object({
  category: z.enum(CATEGORIES).optional(),
  totalCents: z.union([z.number().int().positive(), z.string().min(1)]).optional(),
  vendorId: IdParam.optional(),
  vendorName: z.string().trim().min(2).max(200).optional(),
  invoiceDate: z.string().min(6).max(30).optional(),
  docNumber: z.string().min(1).max(100).optional(),
  dueDate: z.string().min(6).max(30).optional(),
  status: z.enum(['terkonfirmasi', 'ditolak']).optional(),
}).refine((b) => Object.keys(b).length > 0, 'body kosong');
const MatchBody = z.object({ poId: IdParam.nullable(), grId: IdParam.nullable().optional() });

/**
 * Review screen API (LLD §7 IntakeReview). PATCH goes through the same applyChanges() as chat
 * corrections, so validation, flags and the audit trail are one path.
 */
export function registerIntakeRoutes(app: App, { db, now }: RouteDeps, storage: ObjectStorage | undefined): void {
  /**
   * Newest first, in pages: `nextCursor` (present when the page is full) is passed back as `cursor`.
   * Keyset on (created_at, row_id) at microsecond precision, so no row is skipped or repeated even
   * when several share a millisecond, and the oldest open rows stay reachable however many there are.
   */
  app.get('/companies/:companyId/intake/review', requireRole(REVIEW_ROLES), async (c) => {
    const q = ReviewQuery.parse(c.req.query());
    const where: SQL[] = [q.status ? eq(vendorInvoices.status, q.status) : inArray(vendorInvoices.status, ['perlu_konfirmasi', 'perlu_cek'])];
    if (q.siteId) where.push(eq(vendorInvoices.siteId, q.siteId));
    if (q.cursor) where.push(sql`(${vendorInvoices.createdAt}, ${vendorInvoices.rowId}) < (${q.cursor.at}::timestamptz, ${q.cursor.rowId}::uuid)`);
    const rows = await withCompany(db, c.get('tenant'), (tx) =>
      tx.select({ row: vendorInvoices, at: sql<string>`to_char(${vendorInvoices.createdAt} AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"')` })
        .from(vendorInvoices).where(and(...where)).orderBy(desc(vendorInvoices.createdAt), desc(vendorInvoices.rowId)).limit(q.limit));
    const last = rows.at(-1);
    return c.json({
      data: rows.map((r) => publicRow(r.row, c.get('role'))),
      nextCursor: rows.length === q.limit && last ? `${last.at}~${last.row.rowId}` : null,
    });
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
    if (body.dueDate !== undefined) {
      const iso = parseIndonesianDate(body.dueDate);
      if (!iso) throw new HTTPException(400, { message: 'jatuh tempo tidak terbaca' });
      changes.push({ field: 'dueDate', value: iso });
    }
    if (body.status) changes.push({ field: 'status', value: body.status });

    const r = await withCompany(db, c.get('tenant'), (tx) => applyChanges(tx, rowId, changes, { channel: 'admin', userId: c.get('userId'), today: now() }));
    if (r.ok) return c.json({ data: publicRow(r.row, c.get('role')) });
    if (r.reason === 'not_found') notFound('Nota tidak ditemukan.');
    if (r.reason === 'vendor_not_found') notFound('Vendor tidak ditemukan.');
    if (r.reason === 'invalid_value') return c.json({ error: 'invalid_request', message: r.detail ?? 'Nilai tidak valid.' }, 400);
    const message = r.reason === 'closed' ? 'Nota sudah ditutup (terkonfirmasi/ditolak).'
      : r.reason === 'confirm_blocked' ? 'Belum bisa dikonfirmasi.' : 'Sudah ada nota terkonfirmasi dengan vendor, tanggal, dan total yang sama.';
    return c.json({ error: r.reason, message, flags: r.flags ?? [] }, 409);
  });

  /** Three-way match: which PO (and goods receipt) this invoice bills. */
  app.get('/companies/:companyId/intake/:rowId/match-candidates', requireRole(REVIEW_ROLES), async (c) => {
    const { rowId } = RowParams.parse(c.req.param());
    return c.json({ data: await withCompany(db, c.get('tenant'), (tx) => matchCandidates(tx, rowId)) });
  });
  app.put('/companies/:companyId/intake/:rowId/match', requireRole(EDIT_ROLES), async (c) => {
    const { rowId } = RowParams.parse(c.req.param());
    const body = await jsonBody(c, MatchBody);
    const row = await withCompany(db, c.get('tenant'), (tx) => setMatch(tx, rowId, body));
    return c.json({ data: publicRow(row, c.get('role')) });
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
