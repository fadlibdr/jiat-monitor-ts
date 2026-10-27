import ExcelJS from 'exceljs';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { headerAuthenticator } from '../../src/auth/authenticator.js';
import {
  boqItems, boqVersions, companies, companyUsers, contracts, managementViewers, sites, users, vendorInvoices, vendors,
} from '../../src/db/schema.js';
import { withApp, withCompany, type Db } from '../../src/db/tenant.js';
import { createApp } from '../../src/http/app.js';
import { createTestDb } from '../helpers/db.js';

/**
 * One contract end to end (HLD §9 Phase 3–4 exit criteria): PR → PO → GR, plan + approved opname →
 * S-curve, termin invoice with DPP/PPN/retensi/uang muka, payment, snapshot refresh, and the holding
 * dashboard equal to the company's live dashboard (LLD §10 reconciliation).
 */
let now = new Date('2026-10-27T03:00:00Z');
let db: Db;
let close: () => Promise<void>;
let app: ReturnType<typeof createApp>;
let A = 0; let s1 = 0; let K = 0; let leafMat = 0; let leafSub = 0; let vendor = 0;
let mgr = 0; let fin = 0; let staff = 0; let boss = 0; let adm = 0;

const RP = 100; // cents per rupiah
const send = (userId: number, method: string, body?: unknown) => ({
  method, headers: { 'x-dev-user-id': String(userId), 'content-type': 'application/json' }, ...(body === undefined ? {} : { body: JSON.stringify(body) }),
});
async function ok<T>(res: Response | Promise<Response>, status = 200): Promise<T> {
  const r = await res;
  const text = await r.text();
  expect(r.status, text).toBe(status);
  return (JSON.parse(text) as { data: T }).data;
}
const call = (userId: number, method: string, path: string, body?: unknown) => app.request(`/companies/${A}${path}`, send(userId, method, body));

beforeAll(async () => {
  ({ db, close } = await createTestDb());
  app = createApp({ db, auth: headerAuthenticator('test'), now: () => now });
  await withApp(db, async (tx) => {
    const [c] = await tx.insert(companies).values({ code: 'AAA', name: 'PT AAA' }).returning({ id: companies.id });
    A = c!.id;
    const us = await tx.insert(users).values([
      { email: 'mgr@a.test', name: 'Manager' }, { email: 'fin@a.test', name: 'Finance' },
      { email: 'staff@a.test', name: 'Staff' }, { email: 'boss@h.test', name: 'Boss' }, { email: 'adm@a.test', name: 'Admin proyek' },
    ]).returning({ id: users.id });
    [mgr, fin, staff, boss, adm] = us.map((u) => u.id) as [number, number, number, number, number];
    await tx.insert(managementViewers).values({ userId: boss, role: 'holding_viewer' });
  });
  await withCompany(db, A, async (tx) => {
    const [s] = await tx.insert(sites).values({ companyId: A, code: 'KRM', name: 'JIAT Keerom' }).returning({ id: sites.id });
    s1 = s!.id;
    const [k] = await tx.insert(contracts).values({
      companyId: A, siteId: s1, number: 'HK-KRM', employerName: 'BWS Papua', valueDppCents: 1_000_000_000 * RP,
      retentionBp: 500, advanceCents: 100_000_000 * RP, endDate: '2026-11-15', status: 'active',
    }).returning({ id: contracts.id });
    K = k!.id;
    const [v] = await tx.insert(boqVersions).values({ companyId: A, contractId: K, version: 1, totalCents: 1_000_000_000 * RP }).returning({ id: boqVersions.id });
    const items = await tx.insert(boqItems).values([
      { companyId: A, versionId: v!.id, code: 'I.1', description: 'Pekerjaan beton', amountCents: 600_000_000 * RP, weightMicroPct: 60_000_000, category: 'material', sortOrder: 1 },
      { companyId: A, versionId: v!.id, code: 'II.1', description: 'Pengeboran', amountCents: 400_000_000 * RP, weightMicroPct: 40_000_000, category: 'subkon', sortOrder: 2 },
    ]).returning({ id: boqItems.id });
    [leafMat, leafSub] = items.map((i) => i.id) as [number, number];
    const [vd] = await tx.insert(vendors).values({ companyId: A, name: 'PT Sumber Beton' }).returning({ id: vendors.id });
    vendor = vd!.id;
  });
  await withApp(db, (tx) => tx.insert(companyUsers).values([
    { userId: mgr, companyId: A, role: 'company_manager' },
    { userId: fin, companyId: A, role: 'finance' },
    { userId: staff, companyId: A, role: 'site_staff', siteIds: [s1] },
    { userId: adm, companyId: A, role: 'project_admin' },
  ]));
});
afterAll(async () => { await close(); });

let poId = 0; let poLine = 0; let grId = 0; let invoiceId = 0; let t1 = 0;

describe('procurement: PR → PO → partial GR', () => {
  it('runs the approval chain (HLD §2: admin proyek writes, manager approves) and receives 40 of 100', async () => {
    expect((await call(staff, 'POST', '/purchase-requests', { siteId: s1, items: [{ description: 'x', qty: 1 }] })).status).toBe(403);
    const pr = await ok<{ id: number }>(call(adm, 'POST', '/purchase-requests', {
      siteId: s1, contractId: K, items: [{ boqItemId: leafMat, description: 'Semen 50 kg', qty: 100, unit: 'sak', estPriceCents: 75_000 * RP }],
    }), 201);
    await ok(call(adm, 'POST', `/purchase-requests/${pr.id}/submit`));
    expect((await call(adm, 'POST', `/purchase-requests/${pr.id}/approve`)).status).toBe(403);
    await ok(call(mgr, 'POST', `/purchase-requests/${pr.id}/approve`));

    const po = await ok<{ id: number; dppCents: number; status: string }>(call(adm, 'POST', '/purchase-orders', {
      siteId: s1, vendorId: vendor, prId: pr.id, contractId: K, orderDate: '2026-09-01',
      items: [{ boqItemId: leafMat, description: 'Semen 50 kg', qty: 100, unit: 'sak', unitPriceCents: 75_000 * RP }],
    }), 201);
    expect(po.dppCents).toBe(7_500_000 * RP);
    poId = po.id;
    await ok(call(mgr, 'POST', `/purchase-orders/${poId}/approve`));
    const full = await ok<{ items: Array<{ id: number }> }>(call(staff, 'GET', `/purchase-orders/${poId}`));
    poLine = full.items[0]!.id;
    const gr = await ok<{ id: number }>(call(adm, 'POST', `/purchase-orders/${poId}/receipts`, { receivedAt: '2026-09-10', items: [{ poItemId: poLine, qtyReceived: 40 }] }), 201);
    grId = gr.id;
    expect((await ok<{ status: string }>(call(staff, 'GET', `/purchase-orders/${poId}`))).status).toBe('partial');

    const c = await ok<{ total: { budgetCents: number; committedCents: number; receivedCents: number } }>(call(mgr, 'GET', `/contracts/${K}/commitments`));
    expect(c.total).toEqual({ budgetCents: 1_000_000_000 * RP, committedCents: 7_500_000 * RP, receivedCents: 3_000_000 * RP });
  });
});

describe('BOQ item category correction', () => {
  it('project_admin corrects a category (200); site_staff 403; an unknown item 404; null clears it', async () => {
    const path = (id: number) => `/contracts/${K}/boq/items/${id}`;
    expect((await call(staff, 'PATCH', path(leafSub), { category: 'alat' })).status).toBe(403);
    expect(await ok(call(adm, 'PATCH', path(leafSub), { category: 'alat' }))).toMatchObject({ id: leafSub, category: 'alat' });
    expect((await call(adm, 'PATCH', path(leafSub + 999), { category: 'alat' })).status).toBe(404);
    expect((await call(adm, 'PATCH', path(leafSub), { category: 'makanan' })).status).toBe(400);
    expect(await ok(call(adm, 'PATCH', path(leafSub), { category: null }))).toMatchObject({ category: null });
    await ok(call(adm, 'PATCH', path(leafSub), { category: 'subkon' })); // back to the seeded value for the panels below
  });
});

describe('progress: plan + approved opname → S-curve', () => {
  it('weights the leaves: Sep plan 40 %, actual 34 %', async () => {
    await ok(call(mgr, 'PUT', `/contracts/${K}/boq/schedule`, [
      { code: 'I.1', period: '2026-09', plannedPct: 50 }, { code: 'II.1', period: '2026-09', plannedPct: 25 },
      { code: 'I.1', period: '2026-10', plannedPct: 80 }, { code: 'II.1', period: '2026-10', plannedPct: 50 },
    ]));
    const r = await ok<{ id: number }>(call(staff, 'POST', '/progress-reports', { contractId: K, period: '2026-09' }), 201);
    await ok(call(staff, 'PUT', `/progress-reports/${r.id}/items`, [{ code: 'I.1', cumulativePct: 40 }, { code: 'II.1', cumulativePct: 25 }]));
    await ok(call(staff, 'POST', `/progress-reports/${r.id}/submit`));
    await ok(call(mgr, 'POST', `/progress-reports/${r.id}/approve`));
    const s = await ok<{ points: Array<{ period: string; plannedPct: number; actualPct: number | null }> }>(call(mgr, 'GET', `/contracts/${K}/s-curve`));
    expect(s.points).toEqual([
      { period: '2026-09-01', plannedPct: 40, actualPct: 34, deviationPct: -6 },
      { period: '2026-10-01', plannedPct: 68, actualPct: null, deviationPct: null },
    ]);
  });
});

describe('invoicing: termin from approved progress', () => {
  it('termin 1 (30 %, trigger 25 %) is billed with DPP, uang muka, retensi and PPN 11 %; termin 2 is refused', async () => {
    const terms = await ok<Array<{ id: number; seq: number }>>(call(mgr, 'PUT', `/contracts/${K}/terms`, [
      { seq: 1, name: 'Termin 1', percentBp: 3000, triggerProgressBp: 2500, dueDays: 14 },
      { seq: 2, name: 'Termin 2', percentBp: 7000, triggerProgressBp: 10000 },
    ]));
    t1 = terms.find((t) => t.seq === 1)!.id;
    const t2 = terms.find((t) => t.seq === 2)!.id;
    const status = await ok<{ terms: Array<{ seq: number; reached: boolean }> }>(call(staff, 'GET', `/contracts/${K}/terms/status`));
    expect(status.terms.map((t) => [t.seq, t.reached])).toEqual([[1, true], [2, false]]);

    expect((await call(staff, 'POST', '/invoices/sales/from-term', { contractId: K, termId: t1, invoiceDate: '2026-10-20' })).status).toBe(403);
    const inv = await ok<Record<string, number | string>>(call(fin, 'POST', '/invoices/sales/from-term', { contractId: K, termId: t1, invoiceDate: '2026-10-20' }), 201);
    expect(inv).toMatchObject({
      dppCents: 300_000_000 * RP, advanceDeductionCents: 30_000_000 * RP, retentionCents: 15_000_000 * RP,
      ppnCents: 29_700_000 * RP, totalCents: 284_700_000 * RP, dueDate: '2026-11-03', status: 'issued', progressMicroPct: 34_000_000,
    });
    invoiceId = inv.id as number;
    expect((await call(fin, 'POST', '/invoices/sales/from-term', { contractId: K, termId: t1, invoiceDate: '2026-10-21' })).status).toBe(409);
    expect((await call(fin, 'POST', '/invoices/sales/from-term', { contractId: K, termId: t2, invoiceDate: '2026-10-21' })).status).toBe(409);
  });

  it('a payment makes the invoice partial; overpaying is refused; aging and receivables follow', async () => {
    await ok(call(fin, 'POST', '/payments', { payableType: 'sales_invoices', rowRef: invoiceId, paidAt: '2026-10-25', amountCents: 100_000_000 * RP, method: 'transfer' }), 201);
    expect((await call(fin, 'POST', '/payments', { payableType: 'sales_invoices', rowRef: invoiceId, paidAt: '2026-10-25', amountCents: 200_000_000 * RP, method: 'transfer' })).status).toBe(409);
    const res = await app.request(`/companies/${A}/receivables`, send(fin, 'GET'));
    const body = (await res.json()) as { data: Array<{ balanceCents: number; bucket: string }>; totals: { balanceCents: number } };
    expect(body.data).toMatchObject([{ balanceCents: 184_700_000 * RP, bucket: 'd0_30' }]);
    expect((await call(staff, 'GET', '/receivables')).status).toBe(403);
  });
});

describe('PO/GR matching of an intake row', () => {
  it('suggests the PO of the same vendor and site; links PO + GR; refuses a GR of another PO', async () => {
    const rowId = await withCompany(db, A, async (tx) => {
      const [r] = await tx.insert(vendorInvoices).values({
        companyId: A, siteId: s1, vendorId: vendor, vendorName: 'PT Sumber Beton', totalCents: 3_330_000 * RP, invoiceDate: '2026-09-12',
        status: 'perlu_konfirmasi', source: 'manual',
      }).returning({ rowId: vendorInvoices.rowId });
      return r!.rowId;
    });
    const cands = await ok<Array<{ id: number; receipts: Array<{ id: number }> }>>(call(mgr, 'GET', `/intake/${rowId}/match-candidates`));
    expect(cands.map((c) => c.id)).toEqual([poId]);
    expect(cands[0]!.receipts.map((g) => g.id)).toEqual([grId]);
    const row = await ok<{ poId: number; grId: number }>(call(mgr, 'PUT', `/intake/${rowId}/match`, { poId, grId }));
    expect([row.poId, row.grId]).toEqual([poId, grId]);
    expect((await call(mgr, 'PUT', `/intake/${rowId}/match`, { poId, grId: grId + 999 })).status).toBe(409);
    const cleared = await ok<{ poId: null; grId: null }>(call(mgr, 'PUT', `/intake/${rowId}/match`, { poId: null }));
    expect([cleared.poId, cleared.grId]).toEqual([null, null]);
  });
});

describe('dashboards', () => {
  type Panels = {
    summary: { valueDppEffectiveCents: number; progress: { period: string; plannedMicroPct: number; actualMicroPct: number | null } | null };
    finance: { receivableCents: number; cash: { inCents: number } } | null;
    procurement: { poOutstandingCents: number; poOverdueCount: number; commitment: { committedOfBudgetBp: number | null } };
    alerts: Array<{ kind: string }>;
  };

  it('company dashboard is live; finance and money alerts only for finance and managers', async () => {
    const m = await ok<Panels>(call(mgr, 'GET', '/dashboard'));
    expect(m.summary.valueDppEffectiveCents).toBe(1_000_000_000 * RP);
    expect(m.summary.progress).toMatchObject({ period: '2026-09-01', plannedMicroPct: 40_000_000, actualMicroPct: 34_000_000 });
    expect(m.finance).toMatchObject({ receivableCents: 184_700_000 * RP, cash: { inCents: 100_000_000 * RP } });
    expect(m.procurement).toMatchObject({ poOutstandingCents: 4_500_000 * RP, poOverdueCount: 1 });
    expect(m.alerts.map((a) => a.kind).sort()).toEqual(['kontrak_mendekati_batas', 'po_lewat_30_hari', 'termin_jatuh_tempo']);
    const s = await ok<Panels>(call(staff, 'GET', '/dashboard'));
    expect(s.finance).toBeNull();
    expect(s.alerts.map((a) => a.kind).sort()).toEqual(['kontrak_mendekati_batas', 'po_lewat_30_hari']);
  });

  it('holding refresh is rate-limited; the holding dashboard equals the company dashboard (reconciliation)', async () => {
    const holding = (path: string) => app.request(path, send(boss, 'GET'));
    expect((await ok<{ refreshedAt: null }>(holding('/holding/summary'), 200))).toBeTruthy();
    const r = await ok<{ companies: number }>(app.request('/holding/refresh', send(boss, 'POST')));
    expect(r.companies).toBe(1);
    const again = await app.request('/holding/refresh', send(boss, 'POST'));
    expect(again.status).toBe(429);
    expect(Number(again.headers.get('retry-after'))).toBeGreaterThan(0);

    const res = await holding('/holding/dashboard');
    const body = (await res.json()) as { data: Panels; meta: { refreshedAt: string } };
    expect(body.meta.refreshedAt).toBe(now.toISOString());
    const live = await ok<Panels>(call(mgr, 'GET', '/dashboard'));
    expect(body.data).toEqual(live);
    expect(await ok(holding(`/holding/finance?companies[]=${A + 1}`))).toMatchObject({ receivableCents: 0, payableCents: 0 });
    expect(await ok(holding('/holding/alerts'))).toHaveLength(3);
  });

  it('exports the panels as XLSX', async () => {
    const res = await app.request('/holding/export', send(boss, 'GET'));
    expect(res.status).toBe(200);
    expect(res.headers.get('content-type')).toMatch(/spreadsheetml/);
    const wb = new ExcelJS.Workbook();
    await wb.xlsx.load(await res.arrayBuffer());
    expect(wb.worksheets.map((w) => w.name)).toEqual([
      'Ringkasan', 'Per perusahaan', 'Kontrak', 'Kurva S', 'Pembelian', 'Vendor terbesar', 'Invoicing & kas', 'Arus bulanan', 'Intake lapangan', 'Peringatan',
    ]);
    expect((await app.request('/holding/export?format=pdf', send(boss, 'GET'))).status).toBe(400);
  });

  it('a minute later refresh is allowed again', async () => {
    now = new Date(now.getTime() + 61_000);
    const res = await app.request('/holding/refresh', send(boss, 'POST'));
    expect(res.status).toBe(200);
    expect(((await res.json()) as { data: unknown }).data).toMatchObject({ companies: 1, refreshed: 1, skipped: 0, staleCompanyIds: [] });
  });

  it('two presses at the same time run ONE refresh: the second is answered 429 at once', async () => {
    now = new Date(now.getTime() + 61_000);
    const [a, b] = await Promise.all([app.request('/holding/refresh', send(boss, 'POST')), app.request('/holding/refresh', send(boss, 'POST'))]);
    expect([a.status, b.status].sort()).toEqual([200, 429]);
    const refused = a.status === 429 ? a : b;
    expect(((await refused.json()) as { message: string }).message).toMatch(/sedang disegarkan/);
  });
});
