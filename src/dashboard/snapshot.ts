import { createHash } from 'node:crypto';
import { and, eq, gte, inArray, ne, sql } from 'drizzle-orm';
import { daysLeft, effectiveContract } from '../domain/contract.js';
import { wibDate, wibMonth } from '../domain/date.js';
import { lineAmountCents, parseQty } from '../domain/quantity.js';
import { progressAt } from '../domain/scurve.js';
import {
  companies, contractAddendums, contracts, contractTerms, dashAlerts, dashBalances, dashContracts, dashMonthly, dashProgress,
  dashRefreshes, dashVendors, goodsReceiptItems, goodsReceipts, intakeEvents, payments, purchaseOrderItems, purchaseOrders,
  purchaseRequests, salesInvoices, sites, vendorInvoices, vendors,
} from '../db/schema.js';
import type { PgTable } from 'drizzle-orm/pg-core';
import { isSerializationFailure, rowsOf, withApp, withCompany, type Db, type Tx } from '../db/tenant.js';
import { errorText } from '../jobs/queue.js';
import { payables, receivables } from '../finance/service.js';
import { REVIEW_FLAGS } from '../intake/review.js';
import { commitments } from '../procurement/service.js';
import { sCurveMicro } from '../progress/service.js';

/**
 * Dashboard numbers of one company (LLD §8), computed from the transaction tables with the same
 * functions the detail endpoints use. `computeSnapshot` serves the company dashboard live (inside
 * the caller's RLS and site scope); `refreshCompany` stores it for the holding dashboard.
 */
export interface SnapshotRows {
  contracts: Array<typeof dashContracts.$inferSelect>;
  progress: Array<typeof dashProgress.$inferSelect>;
  monthly: Array<typeof dashMonthly.$inferSelect>;
  balances: Array<typeof dashBalances.$inferSelect>;
  vendors: Array<typeof dashVendors.$inferSelect>;
  alerts: Array<typeof dashAlerts.$inferSelect>;
}

/** AlertService thresholds (LLD §8). */
export const ALERT_RULES = {
  terminDueWithinDays: 14,
  poOlderThanDays: 30,
  /** deviation below −10 percentage points */
  deviationBelowMicroPct: -10_000_000,
  contractDaysLeftAtMost: 30,
  contractProgressBelowMicroPct: 95_000_000,
} as const;

const MICRO_PER_BP = 10_000;
const DAY = 86_400_000;
const INTAKE_WINDOW_DAYS = 7;
/** pg_advisory_xact_lock(key1, company_id) namespace of snapshot refreshes */
const DASH_LOCK = 4101;

const monthOf = (iso: string) => `${iso.slice(0, 7)}-01`;
/** 16 hex of sha256 over the trimmed, lower-cased name: a stable, bounded key for an id-less vendor */
const nameKey = (name: string | null) => createHash('sha256').update((name ?? '').trim().replace(/\s+/g, ' ').toLowerCase()).digest('hex').slice(0, 16);
const ageDays = (iso: string, now: Date) => 0 - (daysLeft(iso, now) ?? 0); // never -0

export async function computeSnapshot(tx: Tx, companyId: number, now: Date): Promise<SnapshotRows> {
  const currentPeriod = wibMonth(now);
  const alerts: SnapshotRows['alerts'] = [];
  const alert = (kind: SnapshotRows['alerts'][number]['kind'], ref: string, siteId: number, data: Record<string, string | number | null>) =>
    alerts.push({ companyId, kind, ref, siteId, data });

  // --- contracts: value, termin, progress curve, commitment ---
  const ks = await tx.select().from(contracts);
  const adds = await tx.select().from(contractAddendums);
  const terms = await tx.select().from(contractTerms);
  const invs = await tx.select().from(salesInvoices).where(ne(salesInvoices.status, 'cancelled'));
  const contractRows: SnapshotRows['contracts'] = [];
  const progressRows: SnapshotRows['progress'] = [];
  for (const k of ks) {
    const e = effectiveContract(k, adds.filter((a) => a.contractId === k.id));
    const curve = await sCurveMicro(tx, k.id);
    const latestActual = curve.filter((p) => p.actualMicroPct !== null).at(-1)?.actualMicroPct ?? 0;
    const kTerms = terms.filter((t) => t.contractId === k.id).sort((a, b) => a.seq - b.seq);
    const invoiced = new Set(invs.filter((i) => i.contractId === k.id).map((i) => i.termId));
    const reached = (t: (typeof kTerms)[number]) => latestActual >= t.triggerProgressBp * MICRO_PER_BP;
    const { total, byCategory } = await commitments(tx, k.id);
    contractRows.push({
      contractId: k.id, companyId, siteId: k.siteId, number: k.number, employerName: k.employerName, status: k.status,
      valueDppCents: k.valueDppCents, addendumDeltaCents: e.addendumDeltaCents, valueDppEffectiveCents: e.valueDppEffectiveCents,
      valueTotalCents: e.valueTotalCents, endDateEffective: e.endDateEffective,
      termsTotal: kTerms.length, termsIssued: invoiced.size, termsReady: kTerms.filter((t) => !invoiced.has(t.id) && reached(t)).length,
      commitment: { total, byCategory },
    });
    for (const p of curve) {
      progressRows.push({ contractId: k.id, period: p.period, companyId, siteId: k.siteId, plannedMicroPct: p.plannedMicroPct, actualMicroPct: p.actualMicroPct, deviationMicroPct: p.deviationMicroPct });
    }

    if (k.status !== 'active') continue;
    // termin are billed in order, so only the first open one can be "ready"
    const next = kTerms.find((t) => !invoiced.has(t.id));
    if (next && reached(next)) {
      alert('termin_siap', `contract:${k.id}`, k.siteId, { contractId: k.id, contractNumber: k.number, termSeq: next.seq, triggerBp: next.triggerProgressBp, actualMicroPct: latestActual });
    }
    const p = progressAt(curve, currentPeriod);
    if (p?.deviationMicroPct != null && p.deviationMicroPct < ALERT_RULES.deviationBelowMicroPct) {
      alert('deviasi_progres', `contract:${k.id}`, k.siteId, { contractId: k.id, contractNumber: k.number, period: p.period, plannedMicroPct: p.plannedMicroPct, actualMicroPct: p.actualMicroPct, deviationMicroPct: p.deviationMicroPct });
    }
    const left = daysLeft(e.endDateEffective, now);
    if (left !== null && left <= ALERT_RULES.contractDaysLeftAtMost && latestActual < ALERT_RULES.contractProgressBelowMicroPct) {
      alert('kontrak_mendekati_batas', `contract:${k.id}`, k.siteId, { contractId: k.id, contractNumber: k.number, endDate: e.endDateEffective, daysLeft: left, actualMicroPct: latestActual });
    }
  }

  // --- money per site × month ---
  const monthly = new Map<string, SnapshotRows['monthly'][number]>();
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
  for (const po of pos) bucket(po.siteId, monthOf(po.orderDate)).poIssuedCents += po.dppCents;
  const poLines = pos.length ? await tx.select().from(purchaseOrderItems).where(inArray(purchaseOrderItems.poId, pos.map((p) => p.id))) : [];
  const lineById = new Map(poLines.map((l) => [l.id, l]));
  const grRows = await tx.select({ siteId: goodsReceipts.siteId, receivedAt: goodsReceipts.receivedAt, poItemId: goodsReceiptItems.poItemId, qty: goodsReceiptItems.qtyReceived })
    .from(goodsReceiptItems).innerJoin(goodsReceipts, eq(goodsReceipts.id, goodsReceiptItems.grId));
  const receivedByLine = new Map<number, number>();
  for (const g of grRows) {
    const q = parseQty(g.qty) ?? 0;
    receivedByLine.set(g.poItemId, (receivedByLine.get(g.poItemId) ?? 0) + q);
    const line = lineById.get(g.poItemId);
    if (line) bucket(g.siteId, monthOf(g.receivedAt)).grReceivedCents += lineAmountCents(q, line.unitPriceCents);
  }
  const undeliveredOf = (poId: number) => poLines.filter((l) => l.poId === poId)
    .reduce((s, l) => s + lineAmountCents(Math.max(0, (parseQty(l.qty) ?? 0) - (receivedByLine.get(l.id) ?? 0)), l.unitPriceCents), 0);
  for (const i of invs) {
    const m = bucket(i.siteId, monthOf(i.invoiceDate));
    m.invoicedDppCents += i.dppCents;
    m.invoicedTotalCents += i.totalCents;
  }
  for (const p of await tx.select().from(payments)) {
    const m = bucket(p.siteId, monthOf(p.paidAt));
    if (p.payableType === 'sales_invoices') m.cashInCents += p.amountCents;
    else m.cashOutCents += p.amountCents;
  }
  // realised cost = confirmed vendor invoices, DPP (the BOQ budget is DPP too)
  for (const v of await tx.select().from(vendorInvoices).where(eq(vendorInvoices.status, 'terkonfirmasi'))) {
    const m = bucket(v.siteId, monthOf(v.invoiceDate ?? wibDate(v.createdAt)));
    const cat = v.category ?? 'tanpa_kategori';
    const dpp = v.dppCents ?? (v.ppnCents !== null ? v.totalCents - v.ppnCents : v.totalCents);
    m.costByCategory[cat] = (m.costByCategory[cat] ?? 0) + dpp;
  }

  // --- balances per site, as of now ---
  const siteIds = (await tx.select({ id: sites.id }).from(sites)).map((s) => s.id);
  const recv = await receivables(tx, now);
  const pay = await payables(tx, now);
  const prs = await tx.select({ siteId: purchaseRequests.siteId, status: purchaseRequests.status }).from(purchaseRequests)
    .where(inArray(purchaseRequests.status, ['submitted', 'approved']));
  const since = new Date(now.getTime() - INTAKE_WINDOW_DAYS * DAY);
  const photos = await tx.select({ siteId: intakeEvents.siteId, outcome: intakeEvents.outcome }).from(intakeEvents)
    .where(and(eq(intakeEvents.kind, 'photo'), gte(intakeEvents.createdAt, since)));
  const recentRows = await tx.select({ siteId: vendorInvoices.siteId, confidence: vendorInvoices.confidence }).from(vendorInvoices)
    .where(and(eq(vendorInvoices.source, 'telegram'), gte(vendorInvoices.createdAt, since)));
  const open = await tx.select({ siteId: vendorInvoices.siteId, status: vendorInvoices.status }).from(vendorInvoices)
    .where(inArray(vendorInvoices.status, ['perlu_konfirmasi', 'perlu_cek']));
  const confirmed7d = await tx.select({ siteId: vendorInvoices.siteId, createdAt: vendorInvoices.createdAt, confirmedAt: vendorInvoices.confirmedAt })
    .from(vendorInvoices).where(and(eq(vendorInvoices.status, 'terkonfirmasi'), eq(vendorInvoices.source, 'telegram'), gte(vendorInvoices.confirmedAt, since)));
  const openPos = pos.filter((po) => po.status === 'issued' || po.status === 'partial');
  const reviewFlags: readonly string[] = REVIEW_FLAGS;

  const balanceRows: SnapshotRows['balances'] = siteIds.map((siteId) => {
    const r = recv.filter((x) => x.siteId === siteId);
    const aging = (b: string) => r.filter((x) => x.bucket === b).reduce((s, x) => s + x.balanceCents, 0);
    const p = pay.filter((x) => x.siteId === siteId);
    const sitePos = openPos.filter((po) => po.siteId === siteId);
    const sitePhotos = photos.filter((x) => x.siteId === siteId);
    return {
      companyId, siteId,
      receivable0to30Cents: aging('d0_30'), receivable31to60Cents: aging('d31_60'), receivable61to90Cents: aging('d61_90'), receivable90pCents: aging('d90p'),
      receivableCount: r.length,
      payableTotalCents: p.reduce((s, x) => s + x.balanceCents, 0),
      payableOverdueCents: p.filter((x) => x.overdue).reduce((s, x) => s + x.balanceCents, 0),
      prOpen: prs.filter((x) => x.siteId === siteId).length,
      prWaiting: prs.filter((x) => x.siteId === siteId && x.status === 'submitted').length,
      poOutstandingCents: sitePos.reduce((s, po) => s + undeliveredOf(po.id), 0),
      poOverdueCount: sitePos.filter((po) => ageDays(po.orderDate, now) > ALERT_RULES.poOlderThanDays).length,
      photos7d: sitePhotos.length,
      // "ask" (§5.4): the bot had to ask a person — a re-send request, or a saved row that needs checking
      asked7d: sitePhotos.filter((x) => x.outcome === 'tidak_terbaca').length
        + recentRows.filter((x) => x.siteId === siteId && (x.confidence.flags ?? []).some((f) => reviewFlags.includes(f))).length,
      openKonfirmasi: open.filter((x) => x.siteId === siteId && x.status === 'perlu_konfirmasi').length,
      openCek: open.filter((x) => x.siteId === siteId && x.status === 'perlu_cek').length,
      confirmMinutes7d: confirmed7d.filter((x) => x.siteId === siteId && x.confirmedAt)
        .map((x) => Math.max(0, Math.round((x.confirmedAt!.getTime() - x.createdAt.getTime()) / 60_000))).sort((a, b) => a - b),
    };
  });

  // --- vendors: committed value per vendor × site ---
  const vendorName = new Map((await tx.select({ id: vendors.id, name: vendors.name }).from(vendors)).map((v) => [v.id, v.name]));
  const vendorAgg = new Map<string, SnapshotRows['vendors'][number]>();
  for (const po of pos) {
    const key = `${po.vendorId}|${po.siteId}`;
    const v = vendorAgg.get(key) ?? { companyId, siteId: po.siteId, vendorId: po.vendorId, vendorName: vendorName.get(po.vendorId) ?? '', poValueCents: 0, undeliveredCents: 0 };
    v.poValueCents += po.dppCents;
    if (po.status !== 'received') v.undeliveredCents += undeliveredOf(po.id);
    vendorAgg.set(key, v);
  }

  // --- alerts on documents ---
  const termById = new Map(terms.map((t) => [t.id, t]));
  const contractById = new Map(ks.map((k) => [k.id, k]));
  const invById = new Map(invs.map((i) => [i.id, i]));
  for (const r of recv) {
    const left = daysLeft(r.dueDate, now) ?? 0;
    if (left > ALERT_RULES.terminDueWithinDays) continue;
    alert('termin_jatuh_tempo', `invoice:${r.id}`, r.siteId, {
      contractId: r.contractId, contractNumber: contractById.get(r.contractId)?.number ?? null, invoiceId: r.id, invoiceNumber: r.number,
      termSeq: termById.get(invById.get(r.id)?.termId ?? 0)?.seq ?? null, dueDate: r.dueDate, daysLeft: left, balanceCents: r.balanceCents,
    });
  }
  const overdue = new Map<string, { vendorId: number | null; vendorName: string | null; siteId: number; cents: number; invoices: number; maxDays: number }>();
  for (const p of pay) {
    if (!p.overdue || p.dueDate === null) continue;
    // a vendor without a master row is grouped by its WHOLE name (hashed to fit dash_alerts.ref):
    // two long names with a common prefix are two vendors
    const key = `${p.vendorId ?? `?${nameKey(p.vendorName)}`}:site:${p.siteId}`;
    const o = overdue.get(key) ?? { vendorId: p.vendorId, vendorName: p.vendorName, siteId: p.siteId, cents: 0, invoices: 0, maxDays: 0 };
    o.cents += p.balanceCents;
    o.invoices += 1;
    o.maxDays = Math.max(o.maxDays, ageDays(p.dueDate, now));
    overdue.set(key, o);
  }
  for (const [key, o] of overdue) {
    alert('vendor_overdue', `vendor:${key}`, o.siteId, { vendorId: o.vendorId, vendorName: o.vendorName, overdueCents: o.cents, invoices: o.invoices, maxDaysOverdue: o.maxDays });
  }
  for (const po of openPos) {
    const age = ageDays(po.orderDate, now);
    if (age <= ALERT_RULES.poOlderThanDays) continue;
    alert('po_lewat_30_hari', `po:${po.id}`, po.siteId, {
      poId: po.id, poNumber: po.number, vendorName: vendorName.get(po.vendorId) ?? null,
      firstItem: poLines.find((l) => l.poId === po.id)?.description.slice(0, 200) ?? null, ageDays: age, outstandingCents: undeliveredOf(po.id),
    });
  }

  return { contracts: contractRows, progress: progressRows, monthly: [...monthly.values()], balances: balanceRows, vendors: [...vendorAgg.values()], alerts };
}

/**
 * Replaces a company's snapshot in one transaction: readers see the old or the new, never a mix.
 * It reads the source tables in one snapshot (REPEATABLE READ), so the rows agree with each other.
 * When another refresh of the company is running (scheduled job + POST /holding/refresh), this one
 * steps aside instead of queueing behind it on a pooled connection: the running one is as fresh.
 * Returns false when it stepped aside.
 */
export async function refreshCompany(db: Db, companyId: number, now: Date): Promise<boolean> {
  try {
    return await withCompany(db, companyId, (tx) => writeSnapshot(tx, companyId, now), { snapshot: true });
  } catch (e) {
    // a refresh that committed between our snapshot and our lock: its rows are newer than ours would be
    if (isSerializationFailure(e)) return false;
    throw e;
  }
}

/** Rows per INSERT: far below Postgres' 65,534 bind parameters for the widest dash_* row. */
export const INSERT_CHUNK = 1_000;

async function writeSnapshot(tx: Tx, companyId: number, now: Date): Promise<boolean> {
  const [lock] = rowsOf<{ ok: boolean }>(await tx.execute(sql`SELECT pg_try_advisory_xact_lock(${DASH_LOCK}, ${companyId}::int) AS ok`));
  if (!lock?.ok) return false;
  const s = await computeSnapshot(tx, companyId, now);
  for (const t of [dashProgress, dashContracts, dashMonthly, dashBalances, dashVendors, dashAlerts]) await tx.delete(t);
  await insertChunked(tx, dashContracts, s.contracts);
  await insertChunked(tx, dashProgress, s.progress);
  await insertChunked(tx, dashMonthly, s.monthly);
  await insertChunked(tx, dashBalances, s.balances);
  await insertChunked(tx, dashVendors, s.vendors);
  await insertChunked(tx, dashAlerts, s.alerts);
  await tx.insert(dashRefreshes).values({ companyId, refreshedAt: now })
    .onConflictDoUpdate({ target: dashRefreshes.companyId, set: { refreshedAt: now } });
  return true;
}

async function insertChunked<T extends PgTable>(tx: Tx, table: T, rows: Array<T['$inferInsert']>): Promise<void> {
  for (let i = 0; i < rows.length; i += INSERT_CHUNK) await tx.insert(table).values(rows.slice(i, i + INSERT_CHUNK));
}

export interface RefreshSummary {
  companies: number;
  refreshed: number;
  /** another refresh of the company was running */
  skipped: number;
  /** company id → why (errorText: the database's reason, never row data) */
  failed: Array<{ companyId: number; error: string }>;
}

/**
 * RefreshDashboards (LLD §9, every 15 minutes): every company, each in its own transaction. One
 * company failing does not stop the others; the caller decides what a failure means (the job fails
 * so it is retried and logged, the HTTP refresh reports which companies are stale).
 */
export async function refreshAll(db: Db, now: Date): Promise<RefreshSummary> {
  const ids = await withApp(db, (tx) => tx.select({ id: companies.id }).from(companies));
  const out: RefreshSummary = { companies: ids.length, refreshed: 0, skipped: 0, failed: [] };
  for (const { id } of ids) {
    try {
      if (await refreshCompany(db, id, now)) out.refreshed++;
      else out.skipped++;
    } catch (err) {
      out.failed.push({ companyId: id, error: errorText(err) });
    }
  }
  return out;
}
