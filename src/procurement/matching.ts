import { and, asc, desc, eq, inArray, sql } from 'drizzle-orm';
import { HTTPException } from 'hono/http-exception';
import { goodsReceipts, purchaseOrders, vendorInvoices } from '../db/schema.js';
import type { Tx } from '../db/tenant.js';

/**
 * Matching an intake row (vendor invoice) to the PO it bills and, optionally, the goods receipt
 * (HLD §9 Phase 3, docs/remaining-work.md §4.5). Runs inside withCompany(): a PO or GR at a site the
 * caller cannot see is "not found". Matching never changes the invoice's money, vendor or status.
 */
const MATCHABLE_PO = ['issued', 'partial', 'received'] as const;
const CANDIDATES_MAX = 20;

async function rowFor(tx: Tx, rowId: string, lock: boolean) {
  const q = tx.select().from(vendorInvoices).where(eq(vendorInvoices.rowId, rowId));
  const [row] = lock ? await q.for('update') : await q;
  if (!row) throw new HTTPException(404, { message: 'Nota tidak ditemukan.' });
  return row;
}

/** POs at the invoice's site (of its vendor, when known), closest total first, with their receipts. */
export async function matchCandidates(tx: Tx, rowId: string) {
  const inv = await rowFor(tx, rowId, false);
  const pos = await tx.select().from(purchaseOrders).where(and(
    eq(purchaseOrders.siteId, inv.siteId),
    inArray(purchaseOrders.status, [...MATCHABLE_PO]),
    inv.vendorId === null ? undefined : eq(purchaseOrders.vendorId, inv.vendorId),
  )).orderBy(sql`abs(${purchaseOrders.totalCents} - ${inv.totalCents})`, desc(purchaseOrders.orderDate), asc(purchaseOrders.id)).limit(CANDIDATES_MAX);
  const grs = pos.length
    ? await tx.select({ id: goodsReceipts.id, poId: goodsReceipts.poId, number: goodsReceipts.number, receivedAt: goodsReceipts.receivedAt })
      .from(goodsReceipts).where(inArray(goodsReceipts.poId, pos.map((p) => p.id))).orderBy(asc(goodsReceipts.receivedAt), asc(goodsReceipts.id))
    : [];
  return pos.map((po) => ({
    id: po.id, number: po.number, vendorId: po.vendorId, orderDate: po.orderDate, status: po.status, totalCents: po.totalCents,
    differenceCents: inv.totalCents - po.totalCents,
    receipts: grs.filter((g) => g.poId === po.id),
  }));
}

/** Links (or with poId null, unlinks) the invoice to a PO and optionally one of its receipts. */
export async function setMatch(tx: Tx, rowId: string, input: { poId: number | null; grId?: number | null | undefined }) {
  const inv = await rowFor(tx, rowId, true);
  if (inv.status === 'ditolak') throw new HTTPException(409, { message: 'Nota sudah ditolak.' });
  if (input.poId === null) {
    if (input.grId != null) throw new HTTPException(400, { message: 'Penerimaan barang hanya bisa dicocokkan bersama PO-nya.' });
    const [row] = await tx.update(vendorInvoices).set({ poId: null, grId: null }).where(eq(vendorInvoices.id, inv.id)).returning();
    return row!;
  }
  const [po] = await tx.select().from(purchaseOrders).where(eq(purchaseOrders.id, input.poId));
  if (!po) throw new HTTPException(404, { message: 'PO tidak ditemukan.' });
  if (po.siteId !== inv.siteId) throw new HTTPException(409, { message: 'PO berasal dari lokasi lain.' });
  if (!(MATCHABLE_PO as readonly string[]).includes(po.status)) throw new HTTPException(409, { message: `PO berstatus ${po.status}; hanya PO terbit yang bisa dicocokkan.` });
  if (inv.vendorId !== null && po.vendorId !== inv.vendorId) throw new HTTPException(409, { message: 'Vendor PO berbeda dengan vendor nota.' });
  if (input.grId != null) {
    const [gr] = await tx.select({ id: goodsReceipts.id }).from(goodsReceipts).where(and(eq(goodsReceipts.id, input.grId), eq(goodsReceipts.poId, po.id)));
    if (!gr) throw new HTTPException(409, { message: 'Penerimaan barang bukan milik PO ini.' });
  }
  const [row] = await tx.update(vendorInvoices).set({ poId: po.id, grId: input.grId ?? null }).where(eq(vendorInvoices.id, inv.id)).returning();
  return row!;
}
