import { and, eq, gte, inArray, ne, sql } from 'drizzle-orm';
import { effectiveContract } from '../domain/contract.js';
import { lineAmountCents, parseQty } from '../domain/quantity.js';
import { MICRO_100 } from '../domain/scurve.js';
import {
  companies, contractAddendums, contracts, contractTerms, dashBalances, dashContracts, dashMonthly, dashProgress, dashRefreshes, dashVendors,
  goodsReceiptItems, goodsReceipts, intakeEvents, payments, purchaseOrderItems, purchaseOrders, purchaseRequests, salesInvoices,
  sites, vendorInvoices, vendors,
} from '../db/schema.js';
import { withApp, withCompany, type Db, type Tx } from '../db/tenant.js';
import { payables, receivables } from '../finance/service.js';
import { REVIEW_FLAGS } from '../intake/review.js';
import { commitments } from '../procurement/service.js';
import { sCurveMicro } from '../progress/service.js';

/**
 * Dashboard numbers for one company (LLD §8 panels), computed from the transaction tables with the
 * same functions the detail endpoints use. `computeSnapshot` serves the company dashboard live
 * (inside the caller's RLS/site scope); `refreshCompany` stores it for the holding dashboard.
 */
export type Snapshot = Awaited<ReturnType<typeof computeSnapshot>>;

const MICRO_PER_BP = 10_000;
const DAY = 86_400_000;
const PO_OVERDUE_DAYS = 30;
const INTAKE_WINDOW_DAYS = 7;
/** pg_advisory_xact_lock(key1, company_id) namespace of snapshot refreshes */
const DASH_LOCK = 4101;

const month = (iso: string) => `${iso.slice(0, 7)}-01`;

export async function computeSnapshot(tx: Tx, companyId: number, now: Date) {
  const refreshedAt = now;
  const today = now.toISOString().slice(0, 10);
  const currentPeriod = month(today);

  // --- contracts, progress, commitment ---
  const ks = await tx.select().from(contracts);
  const adds = await tx.select().from(contractAddendums);
  const terms = await tx.select().from(contractTerms);
  const liveInv = await tx.select({ contractId: salesInvoices.contractId, termId: salesInvoices.termId }).from(salesInvoices).where(ne(salesInvoices.status, 'cancelled'));
  const contractRows: Array<typeof dashContracts.$inferInsert> = [];
  const progressRows: Array<typeof dashProgress.$inferInsert> = [];
  for (const k of ks) {
    const e = effectiveContract(k, adds.filter((a) => a.contractId === k.id));
    const curve = await sCurveMicro(tx, k.id);
    const latestActual = [...curve].reverse().find((p) => p.actualMicroPct !== null)?.actualMicroPct ?? null;
    const planNow = [...curve].reverse().find((p) => p.period <= currentPeriod)?.plannedMicroPct ?? null;
    const kTerms = terms.filter((t) => t.contractId === k.id);
    const invoiced = new Set(liveInv.filter((i) => i.contractId === k.id).map((i) => i.termId));
    const c = await commitments(tx, k.id);
    contractRows.push({
      contractId: k.id, companyId, siteId: k.siteId, number: k.number, employerName: k.employerName, status: k.status,
      valueDppCents: k.valueDppCents, addendumDeltaCents: e.addendumDeltaCents, valueDppEffectiveCents: e.valueDppEffectiveCents,
      valueTotalCents: e.valueTotalCents, endDateEffective: e.endDateEffective,
      termsTotal: kTerms.length, termsIssued: invoiced.size,
      termsReady: kTerms.filter((t) => !invoiced.has(t.id) && (latestActual ?? 0) >= t.triggerProgressBp * MICRO_PER_BP).length,
      plannedMicroPct: planNow, actualMicroPct: latestActual,
      commitment: { total: c.total, byCategory: c.byCategory },
      refreshedAt,
    });
    for (const p of curve) {
      progressRows.push({ contractId: k.id, period: p.period, companyId, siteId: k.siteId, plannedMicroPct: p.plannedMicroPct, actualMicroPct: p.actualMicroPct, deviationMicroPct: p.deviationMicroPct });
    }
  }

  // --- money per site × month ---
  const monthly = new Map<string, typeof dashMonthly.$inferInsert>();
  const bucket = (siteId: number, period: string) => {
    const key = `${siteId}|${period}`;
    let m = monthly.get(key);
    if (!m) {
      m = { companyId, siteId, period, poIssuedCents: 0, grReceivedCents: 0, invoicedDppCents: 0, invoicedTotalCents: 0, cashInCents: 0, cashOutCents: 0, costByCategory: {} };
      monthly.set(key, m);
    }
    return m;
  };
  const pos = await tx.select().from(purchaseOrders).where(inArray(purchaseOrders.status, ['issued', 'partial', 'received']));
  for (const po of pos) bucket(po.siteId, month(po.orderDate)).poIssuedCents! += po.dppCents;
  const poLines = pos.length ? await tx.select().from(purchaseOrderItems).where(inArray(purchaseOrderItems.poId, pos.map((p) => p.id))) : [];
  const grRows = await tx.select({ siteId: goodsReceipts.siteId, receivedAt: goodsReceipts.receivedAt, poItemId: goodsReceiptItems.poItemId, qty: goodsReceiptItems.qtyReceived })
    .from(goodsReceiptItems).innerJoin(goodsReceipts, eq(goodsReceipts.id, goodsReceiptItems.grId));
  const receivedByLine = new Map<number, number>();
  for (const g of grRows) {
    const line = poLines.find((l) => l.id === g.poItemId);
    const q = parseQty(g.qty) ?? 0;
    receivedByLine.set(g.poItemId, (receivedByLine.get(g.poItemId) ?? 0) + q);
    if (line) bucket(g.siteId, month(g.receivedAt)).grReceivedCents! += lineAmountCents(q, line.unitPriceCents);
  }
  const invs = await tx.select().from(salesInvoices).where(ne(salesInvoices.status, 'cancelled'));
  for (const i of invs) {
    const m = bucket(i.siteId, month(i.invoiceDate));
    m.invoicedDppCents! += i.dppCents;
    m.invoicedTotalCents! += i.totalCents;
  }
  for (const p of await tx.select().from(payments)) {
    const m = bucket(p.siteId, month(p.paidAt));
    if (p.payableType === 'sales_invoices') m.cashInCents! += p.amountCents;
    else m.cashOutCents! += p.amountCents;
  }
  const confirmed = await tx.select().from(vendorInvoices).where(eq(vendorInvoices.status, 'terkonfirmasi'));
  for (const v of confirmed) {
    const m = bucket(v.siteId, month(v.invoiceDate ?? v.createdAt.toISOString().slice(0, 10)));
    const cat = v.category ?? 'tanpa_kategori';
    const cost = m.costByCategory as Record<string, number>;
    cost[cat] = (cost[cat] ?? 0) + (v.dppCents ?? v.totalCents);
  }

  // --- balances per site (as of now) ---
  const siteRows = await tx.select({ id: sites.id }).from(sites);
  const recv = await receivables(tx, now);
  const pay = await payables(tx, now);
  const prs = await tx.select({ siteId: purchaseRequests.siteId, status: purchaseRequests.status }).from(purchaseRequests)
    .where(inArray(purchaseRequests.status, ['submitted', 'approved']));
  const since = new Date(now.getTime() - INTAKE_WINDOW_DAYS * DAY);
  const photos = await tx.select({ siteId: intakeEvents.siteId, outcome: intakeEvents.outcome }).from(intakeEvents)
    .where(and(eq(intakeEvents.kind, 'photo'), gte(intakeEvents.createdAt, since)));
  const recentRows = await tx.select({ siteId: vendorInvoices.siteId, confidence: vendorInvoices.confidence, status: vendorInvoices.status, createdAt: vendorInvoices.createdAt, confirmedAt: vendorInvoices.confirmedAt })
    .from(vendorInvoices).where(and(eq(vendorInvoices.source, 'telegram'), gte(vendorInvoices.createdAt, since)));
  const open = await tx.select({ siteId: vendorInvoices.siteId, status: vendorInvoices.status }).from(vendorInvoices)
    .where(inArray(vendorInvoices.status, ['perlu_konfirmasi', 'perlu_cek']));
  const confirmedRecently = await tx.select({ siteId: vendorInvoices.siteId, createdAt: vendorInvoices.createdAt, confirmedAt: vendorInvoices.confirmedAt })
    .from(vendorInvoices).where(and(eq(vendorInvoices.status, 'terkonfirmasi'), gte(vendorInvoices.confirmedAt, since)));

  const balanceRows: Array<typeof dashBalances.$inferInsert> = siteRows.map(({ id: siteId }) => {
    const r = recv.filter((x) => x.siteId === siteId);
    const sum = (b: string) => r.filter((x) => x.bucket === b).reduce((s, x) => s + x.balanceCents, 0);
    const p = pay.filter((x) => x.siteId === siteId);
    const sitePos = pos.filter((po) => po.siteId === siteId && (po.status === 'issued' || po.status === 'partial'));
    const outstanding = sitePos.reduce((s, po) => s + poLines.filter((l) => l.poId === po.id)
      .reduce((t, l) => t + lineAmountCents(Math.max(0, (parseQty(l.qty) ?? 0) - (receivedByLine.get(l.id) ?? 0)), l.unitPriceCents), 0), 0);
    const sitePhotos = photos.filter((x) => x.siteId === siteId);
    // "ask" = the bot had to ask a person: a re-send request, or a saved row that needed checking
    const asked = sitePhotos.filter((x) => x.outcome === 'tidak_terbaca').length
      + recentRows.filter((x) => x.siteId === siteId && (x.confidence.flags ?? []).some((f) => (REVIEW_FLAGS as readonly string[]).includes(f))).length;
    const minutes = confirmedRecently.filter((x) => x.siteId === siteId && x.confirmedAt)
      .map((x) => Math.round((x.confirmedAt!.getTime() - x.createdAt.getTime()) / 60_000)).sort((a, b) => a - b);
    return {
      companyId, siteId,
      receivable0to30Cents: sum('d0_30'), receivable31to60Cents: sum('d31_60'), receivable61to90Cents: sum('d61_90'), receivable90pCents: sum('d90p'),
      payableTotalCents: p.reduce((s, x) => s + x.balanceCents, 0),
      payableOverdueCents: p.filter((x) => x.overdue).reduce((s, x) => s + x.balanceCents, 0),
      prOpen: prs.filter((x) => x.siteId === siteId).length,
      prWaiting: prs.filter((x) => x.siteId === siteId && x.status === 'submitted').length,
      poOutstandingCents: outstanding,
      poOverdueCount: sitePos.filter((po) => now.getTime() - new Date(`${po.orderDate}T00:00:00Z`).getTime() > PO_OVERDUE_DAYS * DAY).length,
      photos7d: sitePhotos.length,
      asked7d: asked,
      openKonfirmasi: open.filter((x) => x.siteId === siteId && x.status === 'perlu_konfirmasi').length,
      openCek: open.filter((x) => x.siteId === siteId && x.status === 'perlu_cek').length,
      medianConfirmMinutes7d: minutes.length ? minutes[Math.floor((minutes.length - 1) / 2)]! : null,
      refreshedAt,
    };
  });

  // --- vendors by committed value ---
  const vendorRows = await tx.select({ id: vendors.id, name: vendors.name }).from(vendors);
  const vendorAgg = vendorRows.map((v) => {
    const vPos = pos.filter((po) => po.vendorId === v.id);
    const undelivered = vPos.filter((po) => po.status !== 'received').reduce((s, po) => s + poLines.filter((l) => l.poId === po.id)
      .reduce((t, l) => t + lineAmountCents(Math.max(0, (parseQty(l.qty) ?? 0) - (receivedByLine.get(l.id) ?? 0)), l.unitPriceCents), 0), 0);
    return { companyId, vendorId: v.id, vendorName: v.name, poValueCents: vPos.reduce((s, po) => s + po.dppCents, 0), undeliveredCents: undelivered };
  }).filter((v) => v.poValueCents > 0);

  return { contracts: contractRows, progress: progressRows, monthly: [...monthly.values()], balances: balanceRows, vendors: vendorAgg, refreshedAt };
}

/** Replaces a company's snapshot in one transaction: readers see the old or the new, never a mix. */
export async function refreshCompany(db: Db, companyId: number, now: Date): Promise<void> {
  await withCompany(db, companyId, async (tx) => {
    // two refreshes of one company (job + POST /holding/refresh) run one after the other, not interleaved
    await tx.execute(sql`SELECT pg_advisory_xact_lock(${DASH_LOCK}, ${companyId}::int)`);
    const s = await computeSnapshot(tx, companyId, now);
    await tx.delete(dashProgress);
    await tx.delete(dashContracts);
    await tx.delete(dashMonthly);
    await tx.delete(dashBalances);
    await tx.delete(dashVendors);
    if (s.contracts.length) await tx.insert(dashContracts).values(s.contracts);
    if (s.progress.length) await tx.insert(dashProgress).values(s.progress);
    if (s.monthly.length) await tx.insert(dashMonthly).values(s.monthly);
    if (s.balances.length) await tx.insert(dashBalances).values(s.balances);
    if (s.vendors.length) await tx.insert(dashVendors).values(s.vendors);
    await tx.insert(dashRefreshes).values({ companyId, refreshedAt: now })
      .onConflictDoUpdate({ target: dashRefreshes.companyId, set: { refreshedAt: now } });
  });
}

/** RefreshDashboards (LLD §9 "tiap 15 menit"): every company, each in its own transaction. */
export async function refreshAll(db: Db, now: Date): Promise<{ companies: number }> {
  const ids = await withApp(db, (tx) => tx.select({ id: companies.id }).from(companies));
  for (const { id } of ids) await refreshCompany(db, id, now);
  return { companies: ids.length };
}

/** Completion of a weighted progress, for labels like "41,2 %". */
export function microToPctLabel(micro: number | null): string {
  return micro === null ? '—' : `${(micro / (MICRO_100 / 100)).toFixed(1).replace('.', ',')}%`;
}
