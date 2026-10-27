import { and, asc, eq, inArray, sql } from 'drizzle-orm';
import { HTTPException } from 'hono/http-exception';
import { ppnOf } from '../domain/contract.js';
import { lineAmountCents, parseQty, qtyToString, receiptStatus } from '../domain/quantity.js';
import { assertCurrentLeaves, codesOf, currentLeaves } from '../boq/current.js';
import {
  contracts, goodsReceiptItems, goodsReceipts, purchaseOrderItems, purchaseOrders, purchaseRequestItems, purchaseRequests, sites, vendors,
} from '../db/schema.js';
import type { Tx } from '../db/tenant.js';
import { nextDocNumber } from './docnumber.js';

/**
 * Procurement (HLD §4 "Pembelian: PR → PO → GR, vendor per perusahaan"). Every function runs inside
 * withCompany(), so another company's — or another site's — rows are simply not found.
 */
export interface LineInput {
  boqItemId?: number | undefined;
  description: string;
  qty: string | number;
  unit?: string | undefined;
}

type Actor = { companyId: number; userId: number };

function qty4(raw: string | number, what: string): number {
  const q = parseQty(raw);
  if (q === null || q <= 0) throw new HTTPException(400, { message: `${what}: qty harus > 0 dengan maksimal 4 desimal.` });
  return q;
}

async function siteCode(tx: Tx, siteId: number): Promise<string> {
  const [s] = await tx.select({ code: sites.code }).from(sites).where(eq(sites.id, siteId));
  if (!s) throw new HTTPException(404, { message: 'Site tidak ditemukan pada perusahaan ini.' });
  return s.code;
}

/** A contract, if given, must be of the same site (and visible). */
async function assertContractOfSite(tx: Tx, contractId: number | null | undefined, siteId: number): Promise<number | null> {
  if (contractId == null) return null;
  const [k] = await tx.select({ siteId: contracts.siteId }).from(contracts).where(eq(contracts.id, contractId));
  if (!k) throw new HTTPException(404, { message: 'Kontrak tidak ditemukan pada perusahaan ini.' });
  if (k.siteId !== siteId) throw new HTTPException(400, { message: 'Kontrak bukan milik site tersebut.' });
  return contractId;
}

// --- purchase requests ---

export interface PrInput { siteId: number; contractId?: number | undefined; neededBy?: string | undefined; note?: string | undefined; items: Array<LineInput & { estPriceCents?: number | undefined }> }

export async function createPr(tx: Tx, actor: Actor, input: PrInput, today: string) {
  const code = await siteCode(tx, input.siteId);
  const contractId = await assertContractOfSite(tx, input.contractId, input.siteId);
  await assertCurrentLeaves(tx, contractId, input.items.map((i) => i.boqItemId));
  const lines = input.items.map((i, k) => ({ ...i, q: qty4(i.qty, `item ${k + 1}`) }));
  const number = await nextDocNumber(tx, actor.companyId, 'PR', code, today);
  const [pr] = await tx.insert(purchaseRequests).values({
    companyId: actor.companyId, siteId: input.siteId, contractId, number, requestedBy: actor.userId,
    neededBy: input.neededBy ?? null, note: input.note ?? null,
  }).returning();
  const items = await tx.insert(purchaseRequestItems).values(lines.map((l) => ({
    companyId: actor.companyId, prId: pr!.id, boqItemId: l.boqItemId ?? null, description: l.description,
    qty: qtyToString(l.q), unit: l.unit ?? null, estPriceCents: l.estPriceCents ?? null,
  }))).returning();
  return { ...pr!, items };
}

const PR_FLOW = {
  submit: { from: ['draft', 'rejected'], to: 'submitted' },
  approve: { from: ['submitted'], to: 'approved' },
  reject: { from: ['submitted'], to: 'rejected' },
} as const;

export async function transitionPr(tx: Tx, prId: number, action: keyof typeof PR_FLOW, userId: number) {
  const flow = PR_FLOW[action];
  const decision = action === 'submit' ? {} : { decidedBy: userId, decidedAt: new Date() };
  const [row] = await tx.update(purchaseRequests).set({ status: flow.to, ...decision })
    .where(and(eq(purchaseRequests.id, prId), inArray(purchaseRequests.status, [...flow.from]))).returning();
  if (row) return row;
  const [exists] = await tx.select({ status: purchaseRequests.status }).from(purchaseRequests).where(eq(purchaseRequests.id, prId));
  if (!exists) throw new HTTPException(404, { message: 'PR tidak ditemukan.' });
  throw new HTTPException(409, { message: `PR berstatus ${exists.status}; ${action} hanya dari ${flow.from.join('/')}.` });
}

export async function getPr(tx: Tx, prId: number) {
  const [pr] = await tx.select().from(purchaseRequests).where(eq(purchaseRequests.id, prId));
  if (!pr) throw new HTTPException(404, { message: 'PR tidak ditemukan.' });
  const items = await tx.select().from(purchaseRequestItems).where(eq(purchaseRequestItems.prId, prId)).orderBy(asc(purchaseRequestItems.id));
  return { ...pr, items };
}

// --- purchase orders ---

export interface PoInput {
  siteId: number;
  vendorId: number;
  prId?: number | undefined;
  contractId?: number | undefined;
  orderDate: string;
  expectedDate?: string | undefined;
  ppnRateBp?: number | undefined;
  note?: string | undefined;
  items: Array<LineInput & { prItemId?: number | undefined; unitPriceCents: number }>;
}

/**
 * Draft PO. From a PR: the PR must be approved and of the same site; it is closed by the PO.
 * Amounts are computed here (qty × unit price), never taken from the client.
 */
export async function createPo(tx: Tx, actor: Actor, input: PoInput) {
  const code = await siteCode(tx, input.siteId);
  const [vendor] = await tx.select({ id: vendors.id }).from(vendors).where(eq(vendors.id, input.vendorId));
  if (!vendor) throw new HTTPException(404, { message: 'Vendor tidak ditemukan pada perusahaan ini.' });
  let contractId = await assertContractOfSite(tx, input.contractId, input.siteId);
  if (input.prId !== undefined) {
    const [pr] = await tx.select().from(purchaseRequests).where(eq(purchaseRequests.id, input.prId)).for('update');
    if (!pr) throw new HTTPException(404, { message: 'PR tidak ditemukan.' });
    if (pr.status !== 'approved') throw new HTTPException(409, { message: `PR berstatus ${pr.status}; PO hanya dari PR yang disetujui.` });
    if (pr.siteId !== input.siteId) throw new HTTPException(400, { message: 'PR bukan milik site tersebut.' });
    contractId ??= pr.contractId;
    const prItemIds = input.items.map((i) => i.prItemId).filter((x): x is number => x !== undefined);
    if (prItemIds.length) {
      const own = await tx.select({ id: purchaseRequestItems.id }).from(purchaseRequestItems)
        .where(and(eq(purchaseRequestItems.prId, pr.id), inArray(purchaseRequestItems.id, prItemIds)));
      if (own.length !== new Set(prItemIds).size) throw new HTTPException(400, { message: 'prItemId bukan item PR tersebut.' });
    }
    await tx.update(purchaseRequests).set({ status: 'closed' }).where(eq(purchaseRequests.id, pr.id));
  } else if (input.items.some((i) => i.prItemId !== undefined)) {
    throw new HTTPException(400, { message: 'prItemId hanya boleh diisi bila prId diisi.' });
  }
  await assertCurrentLeaves(tx, contractId, input.items.map((i) => i.boqItemId));

  const lines = input.items.map((i, k) => {
    const q = qty4(i.qty, `item ${k + 1}`);
    return { ...i, q, amountCents: lineAmountCents(q, i.unitPriceCents) };
  });
  const ppnRateBp = input.ppnRateBp ?? 1100;
  const dppCents = lines.reduce((s, l) => s + l.amountCents, 0);
  const ppnCents = ppnOf(dppCents, ppnRateBp);
  const number = await nextDocNumber(tx, actor.companyId, 'PO', code, input.orderDate);
  const [po] = await tx.insert(purchaseOrders).values({
    companyId: actor.companyId, siteId: input.siteId, vendorId: input.vendorId, prId: input.prId ?? null, contractId,
    number, orderDate: input.orderDate, expectedDate: input.expectedDate ?? null, ppnRateBp,
    dppCents, ppnCents, totalCents: dppCents + ppnCents, note: input.note ?? null,
  }).returning();
  const items = await tx.insert(purchaseOrderItems).values(lines.map((l) => ({
    companyId: actor.companyId, poId: po!.id, prItemId: l.prItemId ?? null, boqItemId: l.boqItemId ?? null,
    description: l.description, qty: qtyToString(l.q), unit: l.unit ?? null, unitPriceCents: l.unitPriceCents, amountCents: l.amountCents,
  }))).returning();
  return { ...po!, items };
}

export async function approvePo(tx: Tx, poId: number, userId: number) {
  const [row] = await tx.update(purchaseOrders).set({ status: 'issued', approvedBy: userId, approvedAt: new Date() })
    .where(and(eq(purchaseOrders.id, poId), eq(purchaseOrders.status, 'draft'))).returning();
  if (row) return row;
  return conflictOrMissing(tx, poId, 'approve hanya dari draft');
}

/** A PO with goods already received cannot be cancelled (the receipt is a fact). */
export async function cancelPo(tx: Tx, poId: number) {
  const [row] = await tx.update(purchaseOrders).set({ status: 'cancelled' })
    .where(and(eq(purchaseOrders.id, poId), inArray(purchaseOrders.status, ['draft', 'issued']))).returning();
  if (row) return row;
  return conflictOrMissing(tx, poId, 'batal hanya dari draft/issued tanpa penerimaan');
}

async function conflictOrMissing(tx: Tx, poId: number, rule: string): Promise<never> {
  const [po] = await tx.select({ status: purchaseOrders.status }).from(purchaseOrders).where(eq(purchaseOrders.id, poId));
  if (!po) throw new HTTPException(404, { message: 'PO tidak ditemukan.' });
  throw new HTTPException(409, { message: `PO berstatus ${po.status}; ${rule}.` });
}

/** PO with its lines and, per line, the quantity received so far. */
export async function getPo(tx: Tx, poId: number) {
  const [po] = await tx.select().from(purchaseOrders).where(eq(purchaseOrders.id, poId));
  if (!po) throw new HTTPException(404, { message: 'PO tidak ditemukan.' });
  const items = await tx.select().from(purchaseOrderItems).where(eq(purchaseOrderItems.poId, poId)).orderBy(asc(purchaseOrderItems.id));
  const received = await receivedByLine(tx, items.map((i) => i.id));
  return { ...po, items: items.map((i) => ({ ...i, qtyReceived: qtyToString(received.get(i.id) ?? 0) })) };
}

async function receivedByLine(tx: Tx, poItemIds: number[]): Promise<Map<number, number>> {
  if (!poItemIds.length) return new Map();
  const rows = await tx.select({ poItemId: goodsReceiptItems.poItemId, qty: goodsReceiptItems.qtyReceived })
    .from(goodsReceiptItems).where(inArray(goodsReceiptItems.poItemId, poItemIds));
  const m = new Map<number, number>();
  for (const r of rows) m.set(r.poItemId, (m.get(r.poItemId) ?? 0) + (parseQty(r.qty) ?? 0));
  return m;
}

// --- goods receipts ---

export interface GrInput { receivedAt: string; note?: string | undefined; items: Array<{ poItemId: number; qtyReceived: string | number }> }

/**
 * Goods receipt against an issued PO. Σ received per line may not exceed the ordered quantity;
 * the PO becomes partial or received accordingly. The PO row is locked, so two receipts at once
 * cannot both pass the check.
 */
export async function receive(tx: Tx, actor: Actor, poId: number, input: GrInput) {
  const [po] = await tx.select().from(purchaseOrders).where(eq(purchaseOrders.id, poId)).for('update');
  if (!po) throw new HTTPException(404, { message: 'PO tidak ditemukan.' });
  if (po.status !== 'issued' && po.status !== 'partial') throw new HTTPException(409, { message: `PO berstatus ${po.status}; penerimaan hanya untuk PO issued/partial.` });
  const lines = await tx.select().from(purchaseOrderItems).where(eq(purchaseOrderItems.poId, poId));
  const already = await receivedByLine(tx, lines.map((l) => l.id));
  const incoming = new Map<number, number>();
  for (const [k, it] of input.items.entries()) {
    const line = lines.find((l) => l.id === it.poItemId);
    if (!line) throw new HTTPException(400, { message: `poItemId ${it.poItemId} bukan baris PO ini.` });
    incoming.set(line.id, (incoming.get(line.id) ?? 0) + qty4(it.qtyReceived, `item ${k + 1}`));
  }
  for (const [lineId, q] of incoming) {
    const line = lines.find((l) => l.id === lineId)!;
    const ordered = parseQty(line.qty)!;
    if ((already.get(lineId) ?? 0) + q > ordered) {
      throw new HTTPException(409, { message: `Penerimaan melebihi pesanan pada "${line.description}" (dipesan ${qtyToString(ordered)}).` });
    }
  }
  const code = await siteCode(tx, po.siteId);
  const number = await nextDocNumber(tx, actor.companyId, 'GR', code, input.receivedAt);
  const [gr] = await tx.insert(goodsReceipts).values({
    companyId: actor.companyId, siteId: po.siteId, poId, number, receivedAt: input.receivedAt, receivedBy: actor.userId, note: input.note ?? null,
  }).returning();
  const items = await tx.insert(goodsReceiptItems).values([...incoming].map(([poItemId, q]) => ({
    companyId: actor.companyId, grId: gr!.id, poItemId, qtyReceived: qtyToString(q),
  }))).returning();
  const status = receiptStatus(lines.map((l) => ({ ordered4: parseQty(l.qty)!, received4: (already.get(l.id) ?? 0) + (incoming.get(l.id) ?? 0) })));
  await tx.update(purchaseOrders).set({ status }).where(eq(purchaseOrders.id, poId));
  return { ...gr!, items, poStatus: status };
}

// --- commitment vs BOQ ---

/**
 * Per BOQ leaf of the current version: budget, committed (lines of issued/partial/received POs)
 * and received value (qty received × unit price). Lines are matched by BOQ code, so POs written
 * against an older BOQ version still count after a re-import. Totals per category feed the
 * mockup's "Komitmen vs BOQ" panel.
 */
export async function commitments(tx: Tx, contractId: number) {
  const leaves = await currentLeaves(tx, contractId);
  const lines = await tx.select({
    id: purchaseOrderItems.id, boqItemId: purchaseOrderItems.boqItemId, amountCents: purchaseOrderItems.amountCents,
    unitPriceCents: purchaseOrderItems.unitPriceCents,
  }).from(purchaseOrderItems).innerJoin(purchaseOrders, eq(purchaseOrders.id, purchaseOrderItems.poId))
    .where(and(eq(purchaseOrders.contractId, contractId), inArray(purchaseOrders.status, ['issued', 'partial', 'received']), sql`${purchaseOrderItems.boqItemId} IS NOT NULL`));
  const codes = await codesOf(tx, lines.map((l) => l.boqItemId!));
  const received = await receivedByLine(tx, lines.map((l) => l.id));
  const byCode = new Map<string, { committedCents: number; receivedCents: number }>();
  for (const l of lines) {
    const code = codes.get(l.boqItemId!)!;
    const agg = byCode.get(code) ?? { committedCents: 0, receivedCents: 0 };
    agg.committedCents += l.amountCents;
    agg.receivedCents += lineAmountCents(received.get(l.id) ?? 0, l.unitPriceCents);
    byCode.set(code, agg);
  }
  const items = leaves.map((leaf) => ({
    boqItemId: leaf.id, code: leaf.code, description: leaf.description, category: leaf.category,
    budgetCents: leaf.amountCents, ...(byCode.get(leaf.code) ?? { committedCents: 0, receivedCents: 0 }),
  }));
  const byCategory: Record<string, { budgetCents: number; committedCents: number; receivedCents: number }> = {};
  for (const it of items) {
    const key = it.category ?? 'tanpa_kategori';
    const c = (byCategory[key] ??= { budgetCents: 0, committedCents: 0, receivedCents: 0 });
    c.budgetCents += it.budgetCents; c.committedCents += it.committedCents; c.receivedCents += it.receivedCents;
  }
  const total = items.reduce((s, it) => ({ budgetCents: s.budgetCents + it.budgetCents, committedCents: s.committedCents + it.committedCents, receivedCents: s.receivedCents + it.receivedCents }),
    { budgetCents: 0, committedCents: 0, receivedCents: 0 });
  return { items, byCategory, total };
}
