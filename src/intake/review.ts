import { and, eq, ne } from 'drizzle-orm';
import type { Category } from '../domain/categories.js';
import type { Cents } from '../domain/money.js';
import { arithPpnFails, dateOutOfRange } from '../domain/receipt-validator.js';
import { usableVendorName } from '../domain/vendor-name.js';
import { sites, vendorInvoices, vendors, type IntakeReview, type VendorInvoiceStatus } from '../db/schema.js';
import type { Tx } from '../db/tenant.js';
import { vendorForName } from './vendors.js';

/**
 * One path for every change to an intake row, whether it comes from a chat reply (LLD §7) or the
 * review screen (PATCH /intake/:rowId): same rules, same flags, same audit trigger.
 */
export type Change =
  | { field: 'category'; value: Category }
  | { field: 'totalCents'; value: Cents }
  | { field: 'vendorName'; value: string }
  | { field: 'vendorId'; value: number }
  | { field: 'invoiceDate'; value: string }
  | { field: 'docNumber'; value: string }
  | { field: 'status'; value: 'terkonfirmasi' | 'ditolak' };

/** chat = staff in the group; admin = project admin on the review screen (has seen photo + candidates). */
export type Channel = 'chat' | 'admin';

export type VendorInvoiceRow = typeof vendorInvoices.$inferSelect;
export type ApplyResult =
  | { ok: true; row: VendorInvoiceRow }
  | {
    ok: false;
    reason: 'not_found' | 'vendor_not_found' | 'closed' | 'confirm_blocked' | 'duplicate_confirmed' | 'invalid_value';
    row?: VendorInvoiceRow; flags?: string[]; detail?: string;
  };

/** Flags that send a row to perlu_cek (a human has to look). */
export const REVIEW_FLAGS = ['field_kosong', 'arith_items', 'arith_ppn', 'date_range', 'near_duplicate'] as const;
/**
 * What blocks OK. In chat, every open flag (LLD §7: "terkonfirmasi bila tidak ada flag tersisa").
 * On the review screen the admin has seen the photo and the candidates, so arithmetic, date and
 * near-duplicate warnings are theirs to accept; only missing data still blocks.
 */
const CONFIRM_BLOCKERS: Record<Channel, readonly string[]> = {
  chat: [...REVIEW_FLAGS, 'kategori_kosong'],
  admin: ['field_kosong', 'kategori_kosong'],
};
/** Flags that corrections cannot re-derive: carried over as they were. */
const STICKY = ['arith_items', 'npwp_format', 'near_duplicate'];

export function statusFor(flags: readonly string[]): 'perlu_cek' | 'perlu_konfirmasi' {
  return flags.some((f) => (REVIEW_FLAGS as readonly string[]).includes(f)) ? 'perlu_cek' : 'perlu_konfirmasi';
}

export interface FlagInput {
  vendorId: number | null;
  vendorName: string | null;
  invoiceDate: string | null;
  category: string | null;
  dppCents: Cents | null;
  ppnCents: Cents | null;
  totalCents: Cents;
}

/** Re-derives the flags a correction can change (V3, V5, V7, category); keeps the sticky ones. */
export function recomputeFlags(row: FlagInput, previous: readonly string[], siteStart: Date | null, today: Date): string[] {
  const out = new Set(previous.filter((f) => STICKY.includes(f)));
  // a name like "-" or "A" is no vendor: it could never be confirmed against a master vendor
  if ((!row.vendorId && !usableVendorName(row.vendorName)) || !row.invoiceDate) out.add('field_kosong');
  if (arithPpnFails(row.dppCents, row.ppnCents, row.totalCents)) out.add('arith_ppn');
  if (row.invoiceDate && dateOutOfRange(row.invoiceDate, siteStart, today)) out.add('date_range');
  if (!row.category) out.add('kategori_kosong');
  return [...out];
}

/** A refusal: thrown inside the savepoint so everything the attempt wrote is rolled back. */
class Refused extends Error {
  constructor(readonly result: ApplyResult) {
    super('refused');
  }
}

/**
 * Applies the changes atomically: in a savepoint, so a refused change (409) leaves nothing behind —
 * not even a draft vendor created while resolving a VENDOR name. The confirmed-twin fence is
 * company-wide (partial unique index), but the caller may be site-scoped and unable to see a twin
 * at another site, so the index violation itself is also answered as duplicate_confirmed.
 */
export async function applyChanges(
  tx: Tx, rowId: string, changes: readonly Change[], ctx: { channel: Channel; userId: number | null; today: Date },
): Promise<ApplyResult> {
  try {
    return await tx.transaction((sp) => applyInSavepoint(sp as Tx, rowId, changes, ctx));
  } catch (e) {
    if (e instanceof Refused) return e.result;
    if (pgCode(e) === '23505') return { ok: false, reason: 'duplicate_confirmed' };
    throw e;
  }
}

async function applyInSavepoint(
  tx: Tx, rowId: string, changes: readonly Change[], ctx: { channel: Channel; userId: number | null; today: Date },
): Promise<ApplyResult> {
  const [current] = await tx.select().from(vendorInvoices).where(eq(vendorInvoices.rowId, rowId)).for('update');
  if (!current) throw new Refused({ ok: false, reason: 'not_found' });
  const closed = current.status === 'terkonfirmasi' || current.status === 'ditolak';
  // chat may not touch a closed row (LLD §7); the review screen may still fix data, not reopen
  if (closed && (ctx.channel === 'chat' || changes.some((c) => c.field === 'status'))) throw new Refused({ ok: false, reason: 'closed', row: current });

  const next = { ...current };
  let wantStatus: 'terkonfirmasi' | 'ditolak' | null = null;
  for (const ch of changes) {
    switch (ch.field) {
      case 'category': next.category = ch.value; break;
      case 'totalCents': next.totalCents = ch.value; break;
      case 'invoiceDate': next.invoiceDate = ch.value; break;
      case 'docNumber': next.docNumber = ch.value; break;
      case 'vendorName': {
        const name = usableVendorName(ch.value);
        if (!name) throw new Refused({ ok: false, reason: 'invalid_value', detail: 'nama vendor tidak valid', row: current });
        const v = await vendorForName(tx, current.companyId, name);
        next.vendorId = v.id;
        next.vendorName = v.name;
        next.category ??= v.defaultCategory;
        break;
      }
      case 'vendorId': {
        const [v] = await tx.select({ id: vendors.id, name: vendors.name, defaultCategory: vendors.defaultCategory }).from(vendors).where(eq(vendors.id, ch.value));
        // a vendor of another company is invisible (RLS) and answered the same as a missing one
        if (!v) throw new Refused({ ok: false, reason: 'vendor_not_found', row: current });
        next.vendorId = v.id;
        next.vendorName = v.name;
        next.category ??= v.defaultCategory;
        break;
      }
      case 'status': wantStatus = ch.value; break;
    }
  }

  const [site] = await tx.select({ startDate: sites.startDate }).from(sites).where(eq(sites.id, current.siteId));
  const siteStart = site?.startDate ? new Date(`${site.startDate}T00:00:00Z`) : null;
  const review: IntakeReview = { ...current.confidence };
  const flags = recomputeFlags(next, review.flags ?? [], siteStart, ctx.today);
  review.flags = flags;
  next.confidence = review;
  if (!closed) next.status = statusFor(flags) as VendorInvoiceStatus;

  if (wantStatus === 'ditolak') next.status = 'ditolak';
  if (wantStatus === 'terkonfirmasi') {
    const blocking = flags.filter((f) => CONFIRM_BLOCKERS[ctx.channel].includes(f));
    if (blocking.length) throw new Refused({ ok: false, reason: 'confirm_blocked', flags: blocking, row: current });
    // a confirmed invoice always points at a master vendor, so reports and the fence below work
    // (an unusable name is already field_kosong above, so it never reaches vendorForName)
    if (!next.vendorId) {
      const name = usableVendorName(next.vendorName);
      if (!name) throw new Refused({ ok: false, reason: 'confirm_blocked', flags: ['field_kosong'], row: current });
      const v = await vendorForName(tx, current.companyId, name);
      next.vendorId = v.id;
      next.vendorName = v.name;
    }
    // second fence (LLD §6): one confirmed invoice per vendor + date + total. This check answers the
    // visible case with the row; the partial unique index catches the rest (see applyChanges)
    const [twin] = await tx.select({ id: vendorInvoices.id }).from(vendorInvoices).where(and(
      eq(vendorInvoices.status, 'terkonfirmasi'), eq(vendorInvoices.vendorId, next.vendorId!),
      eq(vendorInvoices.invoiceDate, next.invoiceDate!), eq(vendorInvoices.totalCents, next.totalCents), ne(vendorInvoices.id, current.id),
    )).limit(1);
    if (twin) throw new Refused({ ok: false, reason: 'duplicate_confirmed', row: current });
    next.status = 'terkonfirmasi';
    next.confirmedAt = new Date();
    next.confirmedBy = ctx.userId;
  }

  const [row] = await tx.update(vendorInvoices).set({
    vendorId: next.vendorId, vendorName: next.vendorName, invoiceDate: next.invoiceDate, docNumber: next.docNumber,
    category: next.category, totalCents: next.totalCents, status: next.status, confidence: next.confidence,
    confirmedAt: next.confirmedAt, confirmedBy: next.confirmedBy,
  }).where(eq(vendorInvoices.id, current.id)).returning();
  return { ok: true, row: row! };
}

function pgCode(err: unknown): string | undefined {
  return (err as { code?: string; cause?: { code?: string } })?.cause?.code ?? (err as { code?: string })?.code;
}
