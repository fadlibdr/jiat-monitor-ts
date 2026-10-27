import { count, eq, sql, type SQL } from 'drizzle-orm';
import type { PgTable } from 'drizzle-orm/pg-core';
import { expect } from 'vitest';
import { headerAuthenticator } from '../../src/auth/authenticator.js';
import { computeSnapshot, type SnapshotRows } from '../../src/dashboard/snapshot.js';
import type { Category } from '../../src/domain/categories.js';
import { lineAmountCents, parseQty } from '../../src/domain/quantity.js';
import {
  boqItems, boqSchedules, boqVersions, companies, companyUsers, contractAddendums, contracts, contractTerms, goodsReceiptItems,
  goodsReceipts, intakeEvents, managementViewers, payments, progressItems, progressReports, purchaseOrderItems, purchaseOrders,
  salesInvoices, sites, users, vendorInvoices, vendors, type IntakeOutcome, type IntakeReview, type VendorInvoiceStatus,
} from '../../src/db/schema.js';
import { withApp, withCompany, type Db, type TenantCtx, type Tx } from '../../src/db/tenant.js';
import { createApp } from '../../src/http/app.js';
import { asOwner, createTestDb } from '../helpers/db.js';

/**
 * Shared seed for the dashboard tests (one fresh PGlite per test file).
 *
 * Company A (sites s1 KRM, s2 JYP), company B (site sB). Vendors vA1, vA2 (A) and vB (B).
 * Members of A: mgr (company_manager), adm (project_admin), fin (finance), staff1 (site_staff at s1),
 * staffNone (site_staff without sites); mgrB manages B; boss is a holding viewer and member of no
 * company; outsider is a user with neither. Transaction data is inserted directly per test with the
 * helpers below (dates fully controlled), or through the services where the flow matters.
 */
export const RP = 100; // cents per rupiah
export const NOW = '2026-10-27T03:00:00Z';

export interface DashWorld {
  db: Db;
  close: () => Promise<void>;
  app: ReturnType<typeof createApp>;
  clock: { now: Date };
  A: number; B: number;
  s1: number; s2: number; sB: number;
  vA1: number; vA2: number; vB: number;
  u: { mgr: number; adm: number; fin: number; staff1: number; staffNone: number; mgrB: number; boss: number; outsider: number };
}

export async function seedDash(nowIso = NOW): Promise<DashWorld> {
  const { db, close } = await createTestDb();
  const clock = { now: new Date(nowIso) };
  const app = createApp({ db, auth: headerAuthenticator('test'), now: () => clock.now });
  const w = { db, close, app, clock } as DashWorld;
  await withApp(db, async (tx) => {
    const cs = await tx.insert(companies).values([{ code: 'AAA', name: 'PT AAA' }, { code: 'BBB', name: 'PT BBB' }]).returning({ id: companies.id });
    [w.A, w.B] = cs.map((c) => c.id) as [number, number];
    const us = await tx.insert(users).values([
      { email: 'mgr@a.test', name: 'Manager A' }, { email: 'adm@a.test', name: 'Admin proyek A' }, { email: 'fin@a.test', name: 'Finance A' },
      { email: 'staff1@a.test', name: 'Staf KRM' }, { email: 'none@a.test', name: 'Staf tanpa site' }, { email: 'mgr@b.test', name: 'Manager B' },
      { email: 'boss@h.test', name: 'Boss' }, { email: 'out@x.test', name: 'Orang luar' },
    ]).returning({ id: users.id });
    const [mgr, adm, fin, staff1, staffNone, mgrB, boss, outsider] = us.map((u) => u.id) as number[];
    w.u = { mgr: mgr!, adm: adm!, fin: fin!, staff1: staff1!, staffNone: staffNone!, mgrB: mgrB!, boss: boss!, outsider: outsider! };
    await tx.insert(managementViewers).values({ userId: w.u.boss, role: 'holding_viewer' });
  });
  await withCompany(db, w.A, async (tx) => {
    const ss = await tx.insert(sites).values([{ companyId: w.A, code: 'KRM', name: 'JIAT Keerom' }, { companyId: w.A, code: 'JYP', name: 'JIAT Jayapura' }])
      .returning({ id: sites.id });
    [w.s1, w.s2] = ss.map((s) => s.id) as [number, number];
    const vs = await tx.insert(vendors).values([{ companyId: w.A, name: 'PT Sumber Beton' }, { companyId: w.A, name: 'CV Alat Berat' }]).returning({ id: vendors.id });
    [w.vA1, w.vA2] = vs.map((v) => v.id) as [number, number];
  });
  await withCompany(db, w.B, async (tx) => {
    const [s] = await tx.insert(sites).values({ companyId: w.B, code: 'MKS', name: 'Site Makassar' }).returning({ id: sites.id });
    w.sB = s!.id;
    const [v] = await tx.insert(vendors).values({ companyId: w.B, name: 'PT Vendor B' }).returning({ id: vendors.id });
    w.vB = v!.id;
  });
  await withApp(db, (tx) => tx.insert(companyUsers).values([
    { userId: w.u.mgr, companyId: w.A, role: 'company_manager' },
    { userId: w.u.adm, companyId: w.A, role: 'project_admin' },
    { userId: w.u.fin, companyId: w.A, role: 'finance' },
    { userId: w.u.staff1, companyId: w.A, role: 'site_staff', siteIds: [w.s1] },
    { userId: w.u.staffNone, companyId: w.A, role: 'site_staff' },
    { userId: w.u.mgrB, companyId: w.B, role: 'company_manager' },
  ]));
  return w;
}

/** A transaction of `company`, unscoped (every site), acting as the system. */
export const inCo = <T>(w: DashWorld, company: number, fn: (tx: Tx) => Promise<T>) => withCompany(w.db, company, fn);

let seq = 0;
const next = () => ++seq;

export async function addSite(w: DashWorld, company: number, name?: string): Promise<number> {
  const n = next();
  return inCo(w, company, async (tx) => {
    const [s] = await tx.insert(sites).values({ companyId: company, code: `S${n}`, name: name ?? `Site ${n}` }).returning({ id: sites.id });
    return s!.id;
  });
}

export async function addVendor(w: DashWorld, company: number, name?: string): Promise<number> {
  const n = next();
  return inCo(w, company, async (tx) => {
    const [v] = await tx.insert(vendors).values({ companyId: company, name: name ?? `Vendor ${n}` }).returning({ id: vendors.id });
    return v!.id;
  });
}

export interface LeafSpec { code: string; weight: number; amountCents: number; category?: Category | null }
export interface ContractSpec {
  number?: string;
  employer?: string;
  dppCents?: number;
  status?: string;
  endDate?: string | null;
  retentionBp?: number;
  advanceCents?: number;
  /** null = contract without BOQ; default one leaf "L" of weight 100 % with budget = DPP, category material */
  leaves?: LeafSpec[] | null;
}

/** Contract with a current BOQ v1 of leaves; returns the contract id and leaf ids by code. */
export async function addContract(w: DashWorld, company: number, site: number, spec: ContractSpec = {}): Promise<{ K: number; number: string; leaf: Record<string, number> }> {
  const n = next();
  const number = spec.number ?? `HK-${n}`;
  const dpp = spec.dppCents ?? 1_000_000 * RP;
  const leaves = spec.leaves === undefined ? [{ code: 'L', weight: 100_000_000, amountCents: dpp, category: 'material' as const }] : spec.leaves;
  return inCo(w, company, async (tx) => {
    const [k] = await tx.insert(contracts).values({
      companyId: company, siteId: site, number, employerName: spec.employer ?? 'BWS Papua', valueDppCents: dpp,
      status: spec.status ?? 'active', endDate: spec.endDate ?? null, retentionBp: spec.retentionBp ?? 0, advanceCents: spec.advanceCents ?? 0,
    }).returning({ id: contracts.id });
    const leaf: Record<string, number> = {};
    if (leaves) {
      const [v] = await tx.insert(boqVersions).values({ companyId: company, contractId: k!.id, version: 1, totalCents: leaves.reduce((s, l) => s + l.amountCents, 0) })
        .returning({ id: boqVersions.id });
      const rows = await tx.insert(boqItems).values(leaves.map((l, i) => ({
        companyId: company, versionId: v!.id, code: l.code, description: `Item ${l.code}`, amountCents: l.amountCents,
        weightMicroPct: l.weight, category: l.category ?? null, sortOrder: i + 1,
      }))).returning({ id: boqItems.id, code: boqItems.code });
      for (const r of rows) leaf[r.code] = r.id;
    }
    return { K: k!.id, number, leaf };
  });
}

export async function addAddendum(w: DashWorld, company: number, K: number, a: { signedAt: string; valueDeltaCents?: number; endDateNew?: string | null }) {
  const n = next();
  await inCo(w, company, (tx) => tx.insert(contractAddendums).values({
    companyId: company, contractId: K, number: `ADD-${n}`, signedAt: a.signedAt, valueDeltaCents: a.valueDeltaCents ?? 0, endDateNew: a.endDateNew ?? null,
  }));
}

export async function setContractStatus(w: DashWorld, company: number, K: number, status: string) {
  await inCo(w, company, (tx) => tx.update(contracts).set({ status }).where(eq(contracts.id, K)));
}

/** Plan points (cumulative micro-percent per leaf and month). */
export async function addPlan(w: DashWorld, company: number, points: Array<{ leaf: number; period: string; micro: number }>) {
  await inCo(w, company, (tx) => tx.insert(boqSchedules).values(points.map((p) => ({ companyId: company, boqItemId: p.leaf, period: p.period, plannedMicroPct: p.micro }))));
}

/** One opname report (default approved) with its lines; returns the report id and line ids. */
export async function addActual(w: DashWorld, company: number, K: number, period: string, lines: Array<{ leaf: number; micro: number }>,
  status: 'draft' | 'submitted' | 'approved' | 'rejected' = 'approved'): Promise<{ reportId: number; itemIds: number[] }> {
  return inCo(w, company, async (tx) => {
    const [k] = await tx.select({ siteId: contracts.siteId }).from(contracts).where(eq(contracts.id, K));
    const [r] = await tx.insert(progressReports).values({ companyId: company, siteId: k!.siteId, contractId: K, period, status })
      .returning({ id: progressReports.id });
    const items = await tx.insert(progressItems).values(lines.map((l) => ({ companyId: company, reportId: r!.id, boqItemId: l.leaf, cumulativeMicroPct: l.micro })))
      .returning({ id: progressItems.id });
    return { reportId: r!.id, itemIds: items.map((i) => i.id) };
  });
}

export async function setActual(w: DashWorld, company: number, itemId: number, micro: number) {
  await inCo(w, company, (tx) => tx.update(progressItems).set({ cumulativeMicroPct: micro }).where(eq(progressItems.id, itemId)));
}

export async function addTerms(w: DashWorld, company: number, K: number, terms: Array<{ seq: number; percentBp: number; triggerBp: number; dueDays?: number }>): Promise<Record<number, number>> {
  return inCo(w, company, async (tx) => {
    const rows = await tx.insert(contractTerms).values(terms.map((t) => ({
      companyId: company, contractId: K, seq: t.seq, name: `Termin ${t.seq}`, percentBp: t.percentBp, triggerProgressBp: t.triggerBp, dueDays: t.dueDays ?? 30,
    }))).returning({ id: contractTerms.id, seq: contractTerms.seq });
    return Object.fromEntries(rows.map((r) => [r.seq, r.id]));
  });
}

/** Sales (termin) invoice inserted as is: amounts are not under test here, dates and balances are. */
export async function addSalesInvoice(w: DashWorld, company: number, i: {
  K: number; termId: number; invoiceDate: string; dueDate: string; totalCents: number; dppCents?: number; status?: 'issued' | 'partial' | 'paid' | 'cancelled';
}): Promise<{ id: number; number: string; siteId: number }> {
  const n = next();
  return inCo(w, company, async (tx) => {
    const [k] = await tx.select({ siteId: contracts.siteId }).from(contracts).where(eq(contracts.id, i.K));
    const [row] = await tx.insert(salesInvoices).values({
      companyId: company, siteId: k!.siteId, contractId: i.K, termId: i.termId, number: `INV-T-${n}`, invoiceDate: i.invoiceDate, dueDate: i.dueDate,
      progressMicroPct: 0, dppCents: i.dppCents ?? i.totalCents, advanceDeductionCents: 0, retentionCents: 0, ppnCents: 0, totalCents: i.totalCents,
      status: i.status ?? 'issued',
    }).returning({ id: salesInvoices.id, number: salesInvoices.number, siteId: salesInvoices.siteId });
    return row!;
  });
}

export async function setSalesInvoiceStatus(w: DashWorld, company: number, id: number, status: 'issued' | 'partial' | 'paid' | 'cancelled') {
  await inCo(w, company, (tx) => tx.update(salesInvoices).set({ status }).where(eq(salesInvoices.id, id)));
}

export async function addPayment(w: DashWorld, company: number, p: {
  type: 'sales_invoices' | 'vendor_invoices'; payableId: number; siteId: number; paidAt: string; amountCents: number;
}): Promise<number> {
  return inCo(w, company, async (tx) => {
    const [row] = await tx.insert(payments).values({
      companyId: company, siteId: p.siteId, payableType: p.type, payableId: p.payableId, paidAt: p.paidAt, amountCents: p.amountCents, method: 'transfer',
    }).returning({ id: payments.id });
    return row!.id;
  });
}

export interface PoLine { qty: string; unitPriceCents: number; boqItemId?: number; description?: string }
/** PO inserted directly with server-style amounts (Σ qty × price, PPN 11 %). */
export async function addPo(w: DashWorld, company: number, po: {
  site: number; vendor: number; contractId?: number; orderDate: string; status: 'draft' | 'issued' | 'partial' | 'received' | 'cancelled'; lines: PoLine[];
}): Promise<{ id: number; number: string; lineIds: number[]; dppCents: number }> {
  const n = next();
  const amounts = po.lines.map((l) => lineAmountCents(parseQty(l.qty)!, l.unitPriceCents));
  const dppCents = amounts.reduce((s, a) => s + a, 0);
  const ppnCents = Math.round(dppCents * 0.11);
  return inCo(w, company, async (tx) => {
    const [row] = await tx.insert(purchaseOrders).values({
      companyId: company, siteId: po.site, vendorId: po.vendor, contractId: po.contractId ?? null, number: `PO-T-${n}`, orderDate: po.orderDate,
      dppCents, ppnCents, totalCents: dppCents + ppnCents, status: po.status,
    }).returning({ id: purchaseOrders.id, number: purchaseOrders.number });
    const lines = await tx.insert(purchaseOrderItems).values(po.lines.map((l, i) => ({
      companyId: company, poId: row!.id, boqItemId: l.boqItemId ?? null, description: l.description ?? `Barang ${n}.${i + 1}`, qty: l.qty,
      unitPriceCents: l.unitPriceCents, amountCents: amounts[i]!,
    }))).returning({ id: purchaseOrderItems.id });
    return { id: row!.id, number: row!.number, lineIds: lines.map((l) => l.id), dppCents };
  });
}

export async function setPoStatus(w: DashWorld, company: number, id: number, status: 'draft' | 'issued' | 'partial' | 'received' | 'cancelled') {
  await inCo(w, company, (tx) => tx.update(purchaseOrders).set({ status }).where(eq(purchaseOrders.id, id)));
}

export async function addGr(w: DashWorld, company: number, gr: { site: number; poId: number; receivedAt: string; items: Array<{ poItemId: number; qty: string }> }): Promise<number> {
  const n = next();
  return inCo(w, company, async (tx) => {
    const [row] = await tx.insert(goodsReceipts).values({ companyId: company, siteId: gr.site, poId: gr.poId, number: `GR-T-${n}`, receivedAt: gr.receivedAt })
      .returning({ id: goodsReceipts.id });
    await tx.insert(goodsReceiptItems).values(gr.items.map((i) => ({ companyId: company, grId: row!.id, poItemId: i.poItemId, qtyReceived: i.qty })));
    return row!.id;
  });
}

export async function addVendorInvoice(w: DashWorld, company: number, v: {
  site: number; totalCents: number; status: VendorInvoiceStatus; source?: 'telegram' | 'manual';
  vendorId?: number | null; vendorName?: string | null; invoiceDate?: string | null; dueDate?: string | null;
  category?: Category | null; dppCents?: number | null; ppnCents?: number | null;
  createdAt?: Date; confirmedAt?: Date | null; flags?: string[];
}): Promise<{ id: number; rowId: string }> {
  return inCo(w, company, async (tx) => {
    const confidence: IntakeReview = v.flags ? { flags: v.flags } : {};
    const [row] = await tx.insert(vendorInvoices).values({
      companyId: company, siteId: v.site, vendorId: v.vendorId ?? null, vendorName: v.vendorName ?? null, invoiceDate: v.invoiceDate ?? null,
      dueDate: v.dueDate ?? null, category: v.category ?? null, dppCents: v.dppCents ?? null, ppnCents: v.ppnCents ?? null, totalCents: v.totalCents,
      status: v.status, source: v.source ?? 'manual', confidence, confirmedAt: v.confirmedAt ?? null,
      ...(v.createdAt ? { createdAt: v.createdAt } : {}),
    }).returning({ id: vendorInvoices.id, rowId: vendorInvoices.rowId });
    return row!;
  });
}

let messageId = 1000;
export async function addPhoto(w: DashWorld, company: number, site: number, createdAt: Date, outcome: IntakeOutcome = 'tersimpan'): Promise<void> {
  const m = ++messageId;
  await inCo(w, company, (tx) => tx.insert(intakeEvents).values({
    companyId: company, siteId: site, chatId: -100 - company, messageId: m, kind: 'photo', payload: { fileId: `f${m}` }, outcome, createdAt,
  }));
}

/** computeSnapshot of a company at `now`, in the given scope (default: the whole company). */
export function snap(w: DashWorld, company: number, now: Date = w.clock.now, ctx?: TenantCtx): Promise<SnapshotRows> {
  return withCompany(w.db, ctx ?? company, (tx) => computeSnapshot(tx, company, now));
}

/** Row count as table owner (bypasses RLS), optionally only rows matching `where`. */
export async function countRows(w: DashWorld, table: PgTable, where?: SQL): Promise<number> {
  return asOwner(w.db, async () => {
    const q = w.db.select({ n: count() }).from(table);
    const [r] = await (where ? q.where(where) : q);
    return Number(r!.n);
  });
}

/** Raw SQL as table owner (DDL for failure injection, direct deletes). */
export async function ownerSql(w: DashWorld, statement: SQL): Promise<void> {
  await asOwner(w.db, async () => { await w.db.execute(statement); });
}
export { sql };

// --- HTTP ---

export function client(w: DashWorld) {
  const send = (userId: number | null, method: string, body?: unknown) => ({
    method,
    headers: { ...(userId === null ? {} : { 'x-dev-user-id': String(userId) }), 'content-type': 'application/json' },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
  const get = (userId: number | null, path: string) => w.app.request(path, send(userId, 'GET'));
  const post = (userId: number | null, path: string, body?: unknown) => w.app.request(path, send(userId, 'POST', body));
  async function ok<T>(res: Response | Promise<Response>, status = 200): Promise<T> {
    const r = await res;
    const text = await r.text();
    expect(r.status, text).toBe(status);
    return (JSON.parse(text) as { data: T }).data;
  }
  async function body<T>(res: Response | Promise<Response>, status = 200): Promise<T> {
    const r = await res;
    const text = await r.text();
    expect(r.status, text).toBe(status);
    return JSON.parse(text) as T;
  }
  async function status(res: Response | Promise<Response>): Promise<number> {
    const r = await res;
    await r.arrayBuffer();
    return r.status;
  }
  return { send, get, post, ok, body, status };
}

/** Weighted average of percents (micro), rounded half up — the expectation side of combineCurves. */
export function wavg(parts: Array<{ w: number; micro: number }>): number {
  const total = parts.reduce((s, p) => s + p.w, 0);
  return Math.round(parts.reduce((s, p) => s + p.w * p.micro, 0) / total);
}

export type PanelsJson = {
  period: string;
  summary: {
    contracts: number; sites: number; companies: number; valueDppEffectiveCents: number; addendumDeltaCents: number; valueTotalCents: number;
    costRealisedCents: number; budgetCents: number; costOfBudgetBp: number | null;
    progress: { period: string; plannedMicroPct: number; actualMicroPct: number | null; deviationMicroPct: number | null } | null;
  };
  curve: Array<{ period: string; plannedMicroPct: number; actualMicroPct: number | null; deviationMicroPct: number | null }>;
  byCompany: Array<{ companyId: number; contracts: number; valueDppEffectiveCents: number; progress: { period: string; plannedMicroPct: number; actualMicroPct: number | null } | null }>;
  contracts: Array<{ contractId: number; companyId: number; siteId: number; number: string; employerName: string; status: string; daysLeft: number | null; termsReady: number; termsIssued: number; termsTotal: number }>;
  procurement: {
    prOpen: number; prWaiting: number; poOutstandingCents: number; poOverdueCount: number;
    commitment: { budgetCents: number; committedCents: number; receivedCents: number; committedOfBudgetBp: number | null; byCategory: Array<{ category: string; committedCents: number }> };
    topVendors: Array<{ companyId: number; vendorId: number; vendorName: string; poValueCents: number; undeliveredCents: number }>;
  };
  finance: {
    receivableCents: number; receivableCount: number; aging: Record<string, number>; payableCents: number; payableOverdueCents: number;
    cash: { period: string; inCents: number; outCents: number; netCents: number };
    monthly: Array<{ period: string; poIssuedCents: number; grReceivedCents: number; invoicedTotalCents: number; cashInCents: number; cashOutCents: number; costCents: number }>;
  } | null;
  intake: {
    photos7d: number; sitesWithPhotos: number; openKonfirmasi: number; openCek: number; asked7d: number; askRateBp: number | null;
    medianConfirmMinutes7d: number | null; perSite: Array<{ companyId: number; siteId: number; photos7d: number }>;
  };
  alerts: Array<Record<string, unknown> & { kind: string; companyId: number; siteId: number; ref: string }>;
};
export type HoldingMeta = { refreshedAt: string | null; companies: Array<{ id: number; code: string; name: string }>; sites: Array<{ id: number; companyId: number }> };
