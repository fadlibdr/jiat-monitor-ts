import { eq, sql } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { headerAuthenticator } from '../../src/auth/authenticator.js';
import { companies, companyUsers, payments, sites, users, vendorInvoices, vendors } from '../../src/db/schema.js';
import { withApp, withCompany, type Db } from '../../src/db/tenant.js';
import type { Panels } from '../../src/dashboard/panels.js';
import { createApp } from '../../src/http/app.js';
import { DEFAULT_PAYMENT_TERMS_DAYS, trustedSplit } from '../../src/intake/review.js';
import { asOwner, createTestDb } from '../helpers/db.js';

/**
 * The review-round fixes seen through the API: a confirmed nota gets a due date (so payables can be
 * overdue and the vendor_overdue alert fires), a paid nota cannot be corrected below what was paid,
 * an OCR subtotal that does not add up to a confirmed total is not used for cost, and money/goods
 * POSTs are idempotent with an Idempotency-Key.
 */
let now = new Date('2026-10-27T03:00:00Z');
let db: Db;
let close: () => Promise<void>;
let app: ReturnType<typeof createApp>;
let A = 0; let s1 = 0; let termVendor = 0; let plainVendor = 0;
let mgr = 0; let adm = 0;

const RP = 100;
const VENDOR_TERMS_DAYS = 14;
const KEY = 'form-3f9c2b1a-0001';
const send = (userId: number, method: string, body?: unknown, headers: Record<string, string> = {}) => ({
  method, headers: { 'x-dev-user-id': String(userId), 'content-type': 'application/json', ...headers }, ...(body === undefined ? {} : { body: JSON.stringify(body) }),
});
async function ok<T>(res: Response | Promise<Response>, status = 200): Promise<T> {
  const r = await res;
  const text = await r.text();
  expect(r.status, text).toBe(status);
  return (JSON.parse(text) as { data: T }).data;
}
const call = (userId: number, method: string, path: string, body?: unknown, headers?: Record<string, string>) =>
  app.request(`/companies/${A}${path}`, send(userId, method, body, headers));

/** An open nota as the intake would leave it (OCR split included). */
async function nota(v: Partial<typeof vendorInvoices.$inferInsert>): Promise<string> {
  const [row] = await withCompany(db, A, (tx) => tx.insert(vendorInvoices).values({
    companyId: A, siteId: s1, totalCents: 1_110_000 * RP, status: 'perlu_konfirmasi', source: 'manual', invoiceDate: '2026-10-01', category: 'material', ...v,
  }).returning({ rowId: vendorInvoices.rowId }));
  return row!.rowId;
}
type Row = { rowId: string; status: string; dueDate: string | null; dppCents: number | null; ppnCents: number | null; totalCents: number };

beforeAll(async () => {
  ({ db, close } = await createTestDb());
  app = createApp({ db, auth: headerAuthenticator('test'), now: () => now });
  await withApp(db, async (tx) => {
    const [c] = await tx.insert(companies).values({ code: 'AAA', name: 'PT AAA' }).returning({ id: companies.id });
    A = c!.id;
    [mgr, adm] = (await tx.insert(users).values([{ email: 'mgr@a.test', name: 'Manager' }, { email: 'adm@a.test', name: 'Admin' }])
      .returning({ id: users.id })).map((u) => u.id) as [number, number];
  });
  await withCompany(db, A, async (tx) => {
    const [s] = await tx.insert(sites).values({ companyId: A, code: 'KRM', name: 'JIAT Keerom' }).returning({ id: sites.id });
    s1 = s!.id;
    const vs = await tx.insert(vendors).values([
      { companyId: A, name: 'CV Tempo Dua Minggu', paymentTermsDays: VENDOR_TERMS_DAYS },
      { companyId: A, name: 'PT Tanpa Tempo' },
    ]).returning({ id: vendors.id });
    [termVendor, plainVendor] = vs.map((v) => v.id) as [number, number];
  });
  await withApp(db, (tx) => tx.insert(companyUsers).values([
    { userId: mgr, companyId: A, role: 'company_manager' },
    { userId: adm, companyId: A, role: 'project_admin' },
  ]));
});
afterAll(async () => { await close(); });

describe('due date of a confirmed nota', () => {
  it('is the nota date + the vendor\'s payment term, or + 30 days without one; an explicit one is kept', async () => {
    const a = await nota({ vendorId: termVendor, vendorName: 'CV Tempo Dua Minggu' });
    expect(await ok<Row>(call(adm, 'PATCH', `/intake/${a}`, { status: 'terkonfirmasi' }))).toMatchObject({ status: 'terkonfirmasi', dueDate: '2026-10-15' });
    const b = await nota({ vendorId: plainVendor, vendorName: 'PT Tanpa Tempo', totalCents: 2_220_000 * RP });
    expect(DEFAULT_PAYMENT_TERMS_DAYS).toBe(30);
    expect((await ok<Row>(call(adm, 'PATCH', `/intake/${b}`, { status: 'terkonfirmasi' }))).dueDate).toBe('2026-10-31');
    const c = await nota({ vendorId: plainVendor, vendorName: 'PT Tanpa Tempo', totalCents: 3_330_000 * RP });
    expect((await ok<Row>(call(adm, 'PATCH', `/intake/${c}`, { dueDate: '20 November 2026', status: 'terkonfirmasi' }))).dueDate).toBe('2026-11-20');
  });

  it('refuses a due date before the nota date (400) and an unreadable one (400)', async () => {
    const d = await nota({ vendorId: plainVendor, vendorName: 'PT Tanpa Tempo', totalCents: 4_440_000 * RP });
    expect((await call(adm, 'PATCH', `/intake/${d}`, { dueDate: '2026-09-30' })).status).toBe(400);
    expect((await call(adm, 'PATCH', `/intake/${d}`, { dueDate: 'besok' })).status).toBe(400);
  });

  it('so an unpaid confirmed nota becomes overdue and raises vendor_overdue for managers', async () => {
    now = new Date('2026-10-16T03:00:00Z'); // the day after CV Tempo Dua Minggu's due date
    const dash = await ok<Panels>(call(mgr, 'GET', '/dashboard'));
    expect(dash.finance?.payableOverdueCents).toBe(1_110_000 * RP);
    expect(dash.alerts.filter((a) => a.kind === 'vendor_overdue').map((a) => a.siteId)).toEqual([s1]);
    now = new Date('2026-10-27T03:00:00Z');
  });
});

describe('a paid nota cannot be corrected below what was paid', () => {
  it('400 below the paid amount; equal or above is fine', async () => {
    const r = await nota({ vendorId: plainVendor, vendorName: 'PT Tanpa Tempo', totalCents: 5_000_000 * RP, invoiceDate: '2026-10-05' });
    await ok(call(adm, 'PATCH', `/intake/${r}`, { status: 'terkonfirmasi' }));
    await ok(call(mgr, 'POST', '/payments', { payableType: 'vendor_invoices', rowRef: r, paidAt: '2026-10-20', amountCents: 3_000_000 * RP, method: 'transfer' }), 201);
    const res = await call(adm, 'PATCH', `/intake/${r}`, { totalCents: 2_999_999 * RP });
    expect(res.status).toBe(400);
    expect(((await res.json()) as { message: string }).message).toMatch(/sudah dibayar/);
    expect((await ok<Row>(call(adm, 'PATCH', `/intake/${r}`, { totalCents: 3_000_000 * RP }))).totalCents).toBe(3_000_000 * RP);
  });
});

describe('OCR split of a confirmed total', () => {
  it('a subtotal that does not add up to the confirmed total is not used for cost (PPN kept); one that does is kept', async () => {
    // OCR read 1.000.000 + PPN 110.000 = 1.110.000 consistently, but the nota says 2.220.000
    const r = await nota({ vendorId: plainVendor, vendorName: 'PT Tanpa Tempo', totalCents: 1_110_000 * RP, dppCents: 1_000_000 * RP, ppnCents: 110_000 * RP, invoiceDate: '2026-10-06' });
    const open = await ok<Row>(call(adm, 'PATCH', `/intake/${r}`, { totalCents: 'Rp 2.220.000' }));
    // while open the split stays, so the reviewer is told to look
    expect(open).toMatchObject({ status: 'perlu_cek', dppCents: 1_000_000 * RP });
    const done = await ok<Row>(call(adm, 'PATCH', `/intake/${r}`, { status: 'terkonfirmasi' }));
    expect(done).toMatchObject({ status: 'terkonfirmasi', totalCents: 2_220_000 * RP, dppCents: null, ppnCents: 110_000 * RP });
  });

  it('trustedSplit: within the Rp 1.000 tolerance the split stays; an impossible PPN is dropped too', () => {
    expect(trustedSplit({ totalCents: 1_110_000 * RP, dppCents: 1_000_000 * RP, ppnCents: 110_000 * RP })).toEqual({ dppCents: 1_000_000 * RP, ppnCents: 110_000 * RP });
    expect(trustedSplit({ totalCents: 1_110_500 * RP, dppCents: 1_000_000 * RP, ppnCents: 110_000 * RP }).dppCents).toBe(1_000_000 * RP);
    expect(trustedSplit({ totalCents: 500 * RP, dppCents: 1_000 * RP, ppnCents: 600 * RP })).toEqual({ dppCents: null, ppnCents: null });
    expect(trustedSplit({ totalCents: 1_000 * RP, dppCents: null, ppnCents: 100 * RP })).toEqual({ dppCents: null, ppnCents: 100 * RP });
  });
});

describe('Idempotency-Key on payments', () => {
  it('a repeated POST returns the first payment (200) instead of paying twice; the key cannot be reused elsewhere', async () => {
    const r = await nota({ vendorId: plainVendor, vendorName: 'PT Tanpa Tempo', totalCents: 7_000_000 * RP, invoiceDate: '2026-10-07' });
    await ok(call(adm, 'PATCH', `/intake/${r}`, { status: 'terkonfirmasi' }));
    const body = { payableType: 'vendor_invoices', rowRef: r, paidAt: '2026-10-21', amountCents: 1_000_000 * RP, method: 'transfer' };
    const first = await ok<{ id: number; rowRef: string; balanceCents: number }>(call(mgr, 'POST', '/payments', body, { 'idempotency-key': KEY }), 201);
    const again = await ok<{ id: number; balanceCents: number }>(call(mgr, 'POST', '/payments', body, { 'idempotency-key': KEY }), 200);
    expect(again.id).toBe(first.id);
    expect(again.balanceCents).toBe(6_000_000 * RP);
    expect(first.rowRef).toBe(r);
    const paidRows = await withCompany(db, A, (tx) => tx.select().from(payments).where(eq(payments.idempotencyKey, KEY)));
    expect(paidRows).toHaveLength(1);

    const other = await nota({ vendorId: plainVendor, vendorName: 'PT Tanpa Tempo', totalCents: 8_000_000 * RP, invoiceDate: '2026-10-08' });
    await ok(call(adm, 'PATCH', `/intake/${other}`, { status: 'terkonfirmasi' }));
    expect((await call(mgr, 'POST', '/payments', { ...body, rowRef: other }, { 'idempotency-key': KEY })).status).toBe(409);
    expect((await call(mgr, 'POST', '/payments', body, { 'idempotency-key': 'short' })).status).toBe(400);
  });

  it('GET /payments filters a vendor invoice by its row_id and never shows its internal id', async () => {
    const [vi] = await withCompany(db, A, (tx) => tx.select({ rowId: vendorInvoices.rowId }).from(vendorInvoices).innerJoin(payments, eq(payments.payableId, vendorInvoices.id)).where(eq(payments.idempotencyKey, KEY)));
    const list = await ok<Array<Record<string, unknown>>>(call(mgr, 'GET', `/payments?payableType=vendor_invoices&rowRef=${vi!.rowId}`));
    expect(list).toHaveLength(1);
    expect(list[0]).toMatchObject({ rowRef: vi!.rowId, payableType: 'vendor_invoices' });
    expect(list[0]).not.toHaveProperty('payableId');
    expect(list[0]).not.toHaveProperty('idempotencyKey');
    expect(await ok(call(mgr, 'GET', '/payments?payableType=vendor_invoices&rowRef=00000000-0000-4000-8000-000000000000'))).toEqual([]);
    expect((await call(mgr, 'GET', `/payments?rowRef=${vi!.rowId}`)).status).toBe(400);
  });
});

describe('purchase requests and document numbers', () => {
  it('cancelling the PO made from a PR approves the PR again, so a corrected PO can be made from it', async () => {
    const pr = await ok<{ id: number }>(call(adm, 'POST', '/purchase-requests', { siteId: s1, items: [{ description: 'Pipa 4"', qty: 10, unit: 'btg' }] }), 201);
    await ok(call(adm, 'POST', `/purchase-requests/${pr.id}/submit`));
    await ok(call(mgr, 'POST', `/purchase-requests/${pr.id}/approve`));
    const poBody = { siteId: s1, prId: pr.id, vendorId: plainVendor, orderDate: '2026-10-10', items: [{ description: 'Pipa 4"', qty: 10, unit: 'btg', unitPriceCents: 1 }] };
    const wrong = await ok<{ id: number }>(call(adm, 'POST', '/purchase-orders', poBody), 201);
    expect((await ok<{ status: string }>(call(adm, 'GET', `/purchase-requests/${pr.id}`))).status).toBe('closed');
    await ok(call(mgr, 'POST', `/purchase-orders/${wrong.id}/cancel`));
    expect((await ok<{ status: string }>(call(adm, 'GET', `/purchase-requests/${pr.id}`))).status).toBe('approved');
    await ok(call(adm, 'POST', '/purchase-orders', { ...poBody, items: [{ ...poBody.items[0]!, unitPriceCents: 250_000 * RP }] }), 201);
    expect((await ok<{ status: string }>(call(adm, 'GET', `/purchase-requests/${pr.id}`))).status).toBe('closed');
  });

  it('a 12-character company prefix with a 20-character site code still makes a valid number (was varchar(40))', async () => {
    await withApp(db, (tx) => tx.update(companies).set({ docPrefix: 'PTJAYAINDAH1' }).where(eq(companies.id, A)));
    const [long] = await withCompany(db, A, (tx) => tx.insert(sites).values({ companyId: A, code: 'TOL-CIPALI-SEKSI-3AB', name: 'Seksi 3' }).returning({ id: sites.id }));
    const pr = await ok<{ number: string }>(call(adm, 'POST', '/purchase-requests', { siteId: long!.id, items: [{ description: 'x', qty: 1 }] }), 201);
    // the sequence is per company, type and year: earlier tests of this file made PRs too
    expect(pr.number).toMatch(/^PTJAYAINDAH1\/PR\/TOL-CIPALI-SEKSI-3AB\/2026\/\d{3}$/);
    expect(pr.number.length).toBeGreaterThan(40);
  });
});

describe('concurrent writes', () => {
  it('a deadlock or serialization failure is a 409 "coba lagi", not a 500', async () => {
    await asOwner(db, async () => {
      await db.execute(sql.raw(`CREATE FUNCTION zz_deadlock() RETURNS trigger LANGUAGE plpgsql AS $$
        BEGIN RAISE EXCEPTION 'deadlock detected' USING ERRCODE = '40P01'; END $$`));
      await db.execute(sql.raw('CREATE TRIGGER zz_deadlock BEFORE INSERT ON vendors FOR EACH ROW EXECUTE FUNCTION zz_deadlock()'));
    });
    try {
      const res = await call(mgr, 'POST', '/vendors', { name: 'CV Bersamaan' });
      expect(res.status).toBe(409);
      expect(((await res.json()) as { message: string }).message).toMatch(/coba lagi/);
    } finally {
      await asOwner(db, async () => {
        await db.execute(sql.raw('DROP TRIGGER zz_deadlock ON vendors'));
        await db.execute(sql.raw('DROP FUNCTION zz_deadlock()'));
      });
    }
  });
});

describe('Idempotency-Key on goods receipts', () => {
  it('a resubmitted receipt returns the first one and does not receive twice', async () => {
    const pr = await ok<{ id: number }>(call(adm, 'POST', '/purchase-requests', { siteId: s1, items: [{ description: 'Semen 50 kg', qty: 100, unit: 'sak', estPriceCents: 75_000 * RP }] }), 201);
    await ok(call(adm, 'POST', `/purchase-requests/${pr.id}/submit`));
    await ok(call(mgr, 'POST', `/purchase-requests/${pr.id}/approve`));
    const po = await ok<{ id: number; items: Array<{ id: number }> }>(call(adm, 'POST', '/purchase-orders', {
      siteId: s1, prId: pr.id, vendorId: plainVendor, orderDate: '2026-10-10', items: [{ description: 'Semen 50 kg', qty: 100, unit: 'sak', unitPriceCents: 75_000 * RP }],
    }), 201);
    await ok(call(mgr, 'POST', `/purchase-orders/${po.id}/approve`));
    const gr = { receivedAt: '2026-10-12', items: [{ poItemId: po.items[0]!.id, qtyReceived: 40 }] };
    const first = await ok<{ id: number; poStatus: string }>(call(adm, 'POST', `/purchase-orders/${po.id}/receipts`, gr, { 'idempotency-key': `${KEY}-gr` }), 201);
    const again = await ok<{ id: number; poStatus: string }>(call(adm, 'POST', `/purchase-orders/${po.id}/receipts`, gr, { 'idempotency-key': `${KEY}-gr` }), 200);
    expect(again.id).toBe(first.id);
    expect(again.poStatus).toBe('partial');
    expect(await ok<unknown[]>(call(adm, 'GET', `/goods-receipts?poId=${po.id}`))).toHaveLength(1);
    // without a key a second submit is a second receipt (40 + 40 of 100)
    expect((await ok<{ poStatus: string }>(call(adm, 'POST', `/purchase-orders/${po.id}/receipts`, gr), 201)).poStatus).toBe('partial');
  });
});
