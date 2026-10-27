import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { ALERT_RULES } from '../../src/dashboard/snapshot.js';
import {
  addActual, addAddendum, addContract, addGr, addPayment, addPlan, addPo, addSalesInvoice, addSite, addTerms, addVendor, addVendorInvoice,
  RP, seedDash, setActual, setSalesInvoiceStatus, snap, type DashWorld,
} from './fixture.js';

/**
 * AlertService (LLD §8, ALERT_RULES): every kind fires AT its threshold and not one step before
 * (one day, one micro-percent), contract alerts only for active contracts. computeSnapshot is
 * evaluated at a chosen `now`, so the data stays put and the clock moves.
 */
let w: DashWorld;
beforeAll(async () => { w = await seedDash(); });
afterAll(async () => { await w.close(); });

const at = (iso: string) => new Date(iso);
async function alertsOf(kind: string, ref: string, now = w.clock.now, company = w.A) {
  return (await snap(w, company, now)).alerts.filter((a) => a.kind === kind && a.ref === ref);
}

it('thresholds are the LLD §8 ones', () => {
  expect(ALERT_RULES).toEqual({
    terminDueWithinDays: 14, poOlderThanDays: 30, deviationBelowMicroPct: -10_000_000, contractDaysLeftAtMost: 30, contractProgressBelowMicroPct: 95_000_000,
  });
});

describe('termin_siap', () => {
  it('fires exactly when the approved progress reaches the trigger of the next termin, not one micro-percent before', async () => {
    const { K, number, leaf } = await addContract(w, w.A, w.s1);
    await addTerms(w, w.A, K, [{ seq: 1, percentBp: 3000, triggerBp: 2500 }, { seq: 2, percentBp: 7000, triggerBp: 10_000 }]);
    const r = await addActual(w, w.A, K, '2026-09-01', [{ leaf: leaf.L!, micro: 24_999_999 }]);
    let s = await snap(w, w.A);
    expect(s.alerts.filter((a) => a.kind === 'termin_siap' && a.ref === `contract:${K}`)).toEqual([]);
    expect(s.contracts.find((k) => k.contractId === K)).toMatchObject({ termsTotal: 2, termsIssued: 0, termsReady: 0 });

    await setActual(w, w.A, r.itemIds[0]!, 25_000_000);
    s = await snap(w, w.A);
    expect(s.alerts.filter((a) => a.kind === 'termin_siap' && a.ref === `contract:${K}`)).toEqual([{
      companyId: w.A, kind: 'termin_siap', ref: `contract:${K}`, siteId: w.s1,
      data: { contractId: K, contractNumber: number, termSeq: 1, triggerBp: 2500, actualMicroPct: 25_000_000 },
    }]);
    expect(s.contracts.find((k) => k.contractId === K)).toMatchObject({ termsReady: 1 });
  });

  it('a termin with a 0 % trigger (paid at signing) is ready without any opname', async () => {
    const { K } = await addContract(w, w.A, w.s1);
    await addTerms(w, w.A, K, [{ seq: 1, percentBp: 1000, triggerBp: 0 }, { seq: 2, percentBp: 9000, triggerBp: 10_000 }]);
    const a = await alertsOf('termin_siap', `contract:${K}`);
    expect(a.map((x) => x.data['termSeq'])).toEqual([1]);
  });

  it('only the first open termin is reported; invoicing it moves on; a cancelled invoice re-opens the termin', async () => {
    const { K, leaf } = await addContract(w, w.A, w.s1);
    const t = await addTerms(w, w.A, K, [{ seq: 1, percentBp: 3000, triggerBp: 2500 }, { seq: 2, percentBp: 7000, triggerBp: 10_000 }]);
    await addActual(w, w.A, K, '2026-10-01', [{ leaf: leaf.L!, micro: 100_000_000 }]);
    let s = await snap(w, w.A);
    expect(s.alerts.filter((a) => a.ref === `contract:${K}` && a.kind === 'termin_siap').map((a) => a.data['termSeq'])).toEqual([1]);
    expect(s.contracts.find((k) => k.contractId === K)).toMatchObject({ termsIssued: 0, termsReady: 2 });

    await addSalesInvoice(w, w.A, { K, termId: t[1]!, invoiceDate: '2026-10-20', dueDate: '2026-12-20', totalCents: 300_000 * RP });
    s = await snap(w, w.A);
    expect(s.alerts.filter((a) => a.ref === `contract:${K}` && a.kind === 'termin_siap').map((a) => a.data['termSeq'])).toEqual([2]);
    expect(s.contracts.find((k) => k.contractId === K)).toMatchObject({ termsIssued: 1, termsReady: 1 });

    const inv2 = await addSalesInvoice(w, w.A, { K, termId: t[2]!, invoiceDate: '2026-10-21', dueDate: '2026-12-21', totalCents: 700_000 * RP });
    s = await snap(w, w.A);
    expect(s.alerts.filter((a) => a.ref === `contract:${K}` && a.kind === 'termin_siap')).toEqual([]);
    expect(s.contracts.find((k) => k.contractId === K)).toMatchObject({ termsIssued: 2, termsReady: 0 });

    await setSalesInvoiceStatus(w, w.A, inv2.id, 'cancelled');
    s = await snap(w, w.A);
    expect(s.alerts.filter((a) => a.ref === `contract:${K}` && a.kind === 'termin_siap').map((a) => a.data['termSeq'])).toEqual([2]);
    expect(s.contracts.find((k) => k.contractId === K)).toMatchObject({ termsIssued: 1, termsReady: 1 });
  });

  it('a submitted (not yet approved) report does not count', async () => {
    const { K, leaf } = await addContract(w, w.A, w.s1);
    await addTerms(w, w.A, K, [{ seq: 1, percentBp: 5000, triggerBp: 1000 }]);
    await addActual(w, w.A, K, '2026-10-01', [{ leaf: leaf.L!, micro: 100_000_000 }], 'submitted');
    const s = await snap(w, w.A);
    expect(s.alerts.filter((a) => a.ref === `contract:${K}`)).toEqual([]);
    expect(s.contracts.find((k) => k.contractId === K)).toMatchObject({ termsReady: 0 });
  });

  it.each(['draft', 'completed', 'terminated'])('is not raised for a %s contract, though termsReady still counts the termin', async (status) => {
    const { K, leaf } = await addContract(w, w.A, w.s1, { status });
    await addTerms(w, w.A, K, [{ seq: 1, percentBp: 5000, triggerBp: 1000 }]);
    await addActual(w, w.A, K, '2026-10-01', [{ leaf: leaf.L!, micro: 50_000_000 }]);
    const s = await snap(w, w.A);
    expect(s.alerts.filter((a) => a.ref === `contract:${K}`)).toEqual([]);
    expect(s.contracts.find((k) => k.contractId === K)).toMatchObject({ status, termsReady: 1 });
  });
});

describe('deviasi_progres', () => {
  it('fires below −10 points, not at exactly −10', async () => {
    const { K, number, leaf } = await addContract(w, w.A, w.s1);
    await addPlan(w, w.A, [{ leaf: leaf.L!, period: '2026-10-01', micro: 50_000_000 }]);
    const r = await addActual(w, w.A, K, '2026-10-01', [{ leaf: leaf.L!, micro: 40_000_000 }]);
    expect(await alertsOf('deviasi_progres', `contract:${K}`)).toEqual([]);
    await setActual(w, w.A, r.itemIds[0]!, 39_999_999);
    expect(await alertsOf('deviasi_progres', `contract:${K}`)).toEqual([{
      companyId: w.A, kind: 'deviasi_progres', ref: `contract:${K}`, siteId: w.s1,
      data: { contractId: K, contractNumber: number, period: '2026-10-01', plannedMicroPct: 50_000_000, actualMicroPct: 39_999_999, deviationMicroPct: -10_000_001 },
    }]);
  });

  it('weights the leaves: −12 points over two leaves fires', async () => {
    const { K, leaf } = await addContract(w, w.A, w.s1, {
      leaves: [{ code: 'A', weight: 60_000_000, amountCents: 600 * RP }, { code: 'B', weight: 40_000_000, amountCents: 400 * RP }],
    });
    await addPlan(w, w.A, [{ leaf: leaf.A!, period: '2026-10-01', micro: 50_000_000 }, { leaf: leaf.B!, period: '2026-10-01', micro: 50_000_000 }]);
    await addActual(w, w.A, K, '2026-10-01', [{ leaf: leaf.A!, micro: 40_000_000 }, { leaf: leaf.B!, micro: 35_000_000 }]);
    const [a] = await alertsOf('deviasi_progres', `contract:${K}`);
    expect(a?.data).toMatchObject({ plannedMicroPct: 50_000_000, actualMicroPct: 38_000_000, deviationMicroPct: -12_000_000 });
  });

  it('compares plan and actual of the latest month that has an approved actual, not this month\'s plan with last month\'s actual', async () => {
    const { K, leaf } = await addContract(w, w.A, w.s1);
    await addPlan(w, w.A, [{ leaf: leaf.L!, period: '2026-09-01', micro: 40_000_000 }, { leaf: leaf.L!, period: '2026-10-01', micro: 80_000_000 }]);
    await addActual(w, w.A, K, '2026-09-01', [{ leaf: leaf.L!, micro: 35_000_000 }]);
    // Oct plan 80 vs Sep actual 35 would be −45; the rule compares Sep with Sep (−5)
    expect(await alertsOf('deviasi_progres', `contract:${K}`)).toEqual([]);
    await addActual(w, w.A, K, '2026-10-01', [{ leaf: leaf.L!, micro: 69_999_999 }]);
    const [a] = await alertsOf('deviasi_progres', `contract:${K}`);
    expect(a?.data).toMatchObject({ period: '2026-10-01', deviationMicroPct: -10_000_001 });
  });

  it('an old deviation is still reported while no later opname is approved', async () => {
    const { K, leaf } = await addContract(w, w.A, w.s1);
    await addPlan(w, w.A, [{ leaf: leaf.L!, period: '2026-08-01', micro: 50_000_000 }, { leaf: leaf.L!, period: '2026-10-01', micro: 90_000_000 }]);
    await addActual(w, w.A, K, '2026-08-01', [{ leaf: leaf.L!, micro: 30_000_000 }]);
    const [a] = await alertsOf('deviasi_progres', `contract:${K}`);
    expect(a?.data).toMatchObject({ period: '2026-08-01', deviationMicroPct: -20_000_000 });
    // in August itself (before the October plan exists) the same point is compared
    expect((await alertsOf('deviasi_progres', `contract:${K}`, at('2026-08-31T00:00:00Z')))[0]?.data).toMatchObject({ period: '2026-08-01' });
    // before any opname month: nothing to compare
    expect(await alertsOf('deviasi_progres', `contract:${K}`, at('2026-07-15T00:00:00Z'))).toEqual([]);
  });

  it.each(['draft', 'completed', 'terminated'])('is not raised for a %s contract', async (status) => {
    const { K, leaf } = await addContract(w, w.A, w.s1, { status });
    await addPlan(w, w.A, [{ leaf: leaf.L!, period: '2026-10-01', micro: 90_000_000 }]);
    await addActual(w, w.A, K, '2026-10-01', [{ leaf: leaf.L!, micro: 10_000_000 }]);
    expect(await alertsOf('deviasi_progres', `contract:${K}`)).toEqual([]);
  });
});

describe('kontrak_mendekati_batas', () => {
  it('fires at 30 days left, not at 31', async () => {
    const { K, number } = await addContract(w, w.A, w.s1, { endDate: '2026-11-27' });
    expect(await alertsOf('kontrak_mendekati_batas', `contract:${K}`, at('2026-10-27T16:59:59Z'))).toEqual([]);
    expect(await alertsOf('kontrak_mendekati_batas', `contract:${K}`, at('2026-10-27T17:00:00Z'))).toEqual([{
      companyId: w.A, kind: 'kontrak_mendekati_batas', ref: `contract:${K}`, siteId: w.s1,
      data: { contractId: K, contractNumber: number, endDate: '2026-11-27', daysLeft: 30, actualMicroPct: 0 },
    }]);
  });

  it('progress of exactly 95 % silences it, 94.999999 % does not', async () => {
    const { K, leaf } = await addContract(w, w.A, w.s1, { endDate: '2026-11-10' });
    const r = await addActual(w, w.A, K, '2026-10-01', [{ leaf: leaf.L!, micro: 95_000_000 }]);
    expect(await alertsOf('kontrak_mendekati_batas', `contract:${K}`)).toEqual([]);
    await setActual(w, w.A, r.itemIds[0]!, 94_999_999);
    expect((await alertsOf('kontrak_mendekati_batas', `contract:${K}`))[0]?.data).toMatchObject({ daysLeft: 14, actualMicroPct: 94_999_999 });
  });

  it('follows the effective end date of the addenda; an overdue contract keeps alerting with negative days', async () => {
    const { K } = await addContract(w, w.A, w.s1, { endDate: '2026-11-10' });
    expect(await alertsOf('kontrak_mendekati_batas', `contract:${K}`)).toHaveLength(1);
    await addAddendum(w, w.A, K, { signedAt: '2026-10-01', endDateNew: '2027-01-31' });
    expect(await alertsOf('kontrak_mendekati_batas', `contract:${K}`)).toEqual([]);
    // a later addendum that changes only the value leaves the extension in force
    await addAddendum(w, w.A, K, { signedAt: '2026-10-05', valueDeltaCents: 1000 * RP });
    expect(await alertsOf('kontrak_mendekati_batas', `contract:${K}`)).toEqual([]);
    await addAddendum(w, w.A, K, { signedAt: '2026-10-10', endDateNew: '2026-10-20' });
    expect((await alertsOf('kontrak_mendekati_batas', `contract:${K}`))[0]?.data).toMatchObject({ endDate: '2026-10-20', daysLeft: -7 });
  });

  it('no end date → no alert; a contract that is not active → no alert', async () => {
    const open = await addContract(w, w.A, w.s1, { endDate: null });
    expect(await alertsOf('kontrak_mendekati_batas', `contract:${open.K}`)).toEqual([]);
    for (const status of ['draft', 'completed', 'terminated']) {
      const { K } = await addContract(w, w.A, w.s1, { endDate: '2026-11-01', status });
      expect(await alertsOf('kontrak_mendekati_batas', `contract:${K}`)).toEqual([]);
    }
  });
});

describe('termin_jatuh_tempo', () => {
  it('fires 14 days before the due date, not 15', async () => {
    const { K, number } = await addContract(w, w.A, w.s1);
    const t = await addTerms(w, w.A, K, [{ seq: 1, percentBp: 10_000, triggerBp: 0 }]);
    const inv = await addSalesInvoice(w, w.A, { K, termId: t[1]!, invoiceDate: '2026-10-11', dueDate: '2026-11-10', totalCents: 1_000_000 * RP });
    expect(await alertsOf('termin_jatuh_tempo', `invoice:${inv.id}`, at('2026-10-26T16:59:59Z'))).toEqual([]);
    expect(await alertsOf('termin_jatuh_tempo', `invoice:${inv.id}`, at('2026-10-26T17:00:00Z'))).toEqual([{
      companyId: w.A, kind: 'termin_jatuh_tempo', ref: `invoice:${inv.id}`, siteId: w.s1,
      data: {
        contractId: K, contractNumber: number, invoiceId: inv.id, invoiceNumber: inv.number, termSeq: 1, dueDate: '2026-11-10', daysLeft: 14,
        balanceCents: 1_000_000 * RP,
      },
    }]);
  });

  it('shows the open balance; overdue invoices keep alerting; paid and cancelled ones do not', async () => {
    const { K } = await addContract(w, w.A, w.s1);
    const t = await addTerms(w, w.A, K, [{ seq: 1, percentBp: 5000, triggerBp: 0 }, { seq: 2, percentBp: 5000, triggerBp: 0 }]);
    const inv = await addSalesInvoice(w, w.A, { K, termId: t[1]!, invoiceDate: '2026-09-20', dueDate: '2026-10-20', totalCents: 1000 * RP });
    await addPayment(w, w.A, { type: 'sales_invoices', payableId: inv.id, siteId: inv.siteId, paidAt: '2026-10-21', amountCents: 400 * RP });
    await setSalesInvoiceStatus(w, w.A, inv.id, 'partial');
    expect((await alertsOf('termin_jatuh_tempo', `invoice:${inv.id}`))[0]?.data).toMatchObject({ daysLeft: -7, balanceCents: 600 * RP });

    await addPayment(w, w.A, { type: 'sales_invoices', payableId: inv.id, siteId: inv.siteId, paidAt: '2026-10-22', amountCents: 600 * RP });
    await setSalesInvoiceStatus(w, w.A, inv.id, 'paid');
    expect(await alertsOf('termin_jatuh_tempo', `invoice:${inv.id}`)).toEqual([]);

    const cancelled = await addSalesInvoice(w, w.A, { K, termId: t[2]!, invoiceDate: '2026-10-20', dueDate: '2026-10-30', totalCents: 1000 * RP, status: 'cancelled' });
    expect(await alertsOf('termin_jatuh_tempo', `invoice:${cancelled.id}`)).toEqual([]);
  });

  it('is about money owed, so an invoice of a completed contract still alerts', async () => {
    const { K } = await addContract(w, w.A, w.s1, { status: 'completed' });
    const t = await addTerms(w, w.A, K, [{ seq: 1, percentBp: 10_000, triggerBp: 0 }]);
    const inv = await addSalesInvoice(w, w.A, { K, termId: t[1]!, invoiceDate: '2026-10-01', dueDate: '2026-10-31', totalCents: 1000 * RP });
    expect(await alertsOf('termin_jatuh_tempo', `invoice:${inv.id}`)).toHaveLength(1);
  });
});

describe('vendor_overdue', () => {
  it('a confirmed unpaid vendor invoice is overdue from the day after its due date, not on it', async () => {
    const site = await addSite(w, w.A);
    const v = await addVendor(w, w.A);
    await addVendorInvoice(w, w.A, { site, vendorId: v, vendorName: 'PT Semen Papua', totalCents: 500_000 * RP, status: 'terkonfirmasi', invoiceDate: '2026-10-01', dueDate: '2026-10-27' });
    const ref = `vendor:${v}:site:${site}`;
    expect(await alertsOf('vendor_overdue', ref, at('2026-10-27T16:59:59Z'))).toEqual([]);
    expect(await alertsOf('vendor_overdue', ref, at('2026-10-27T17:00:00Z'))).toEqual([{
      companyId: w.A, kind: 'vendor_overdue', ref, siteId: site,
      data: { vendorId: v, vendorName: 'PT Semen Papua', overdueCents: 500_000 * RP, invoices: 1, maxDaysOverdue: 1 },
    }]);
    const bal = (await snap(w, w.A, at('2026-10-27T17:00:00Z'))).balances.find((b) => b.siteId === site);
    expect(bal).toMatchObject({ payableTotalCents: 500_000 * RP, payableOverdueCents: 500_000 * RP });
  });

  it('groups per vendor and site, sums the open balances and reports the oldest; paid, unconfirmed, rejected and undated ones do not count', async () => {
    const sX = await addSite(w, w.A);
    const sY = await addSite(w, w.A);
    const v1 = await addVendor(w, w.A);
    const v2 = await addVendor(w, w.A);
    await addVendorInvoice(w, w.A, { site: sX, vendorId: v1, totalCents: 100 * RP, status: 'terkonfirmasi', invoiceDate: '2026-09-01', dueDate: '2026-10-01' });
    const b = await addVendorInvoice(w, w.A, { site: sX, vendorId: v1, totalCents: 200 * RP, status: 'terkonfirmasi', invoiceDate: '2026-09-02', dueDate: '2026-10-20' });
    await addPayment(w, w.A, { type: 'vendor_invoices', payableId: b.id, siteId: sX, paidAt: '2026-10-21', amountCents: 50 * RP });
    await addVendorInvoice(w, w.A, { site: sY, vendorId: v1, totalCents: 300 * RP, status: 'terkonfirmasi', invoiceDate: '2026-09-03', dueDate: '2026-10-25' });
    const paid = await addVendorInvoice(w, w.A, { site: sX, vendorId: v2, totalCents: 400 * RP, status: 'terkonfirmasi', invoiceDate: '2026-09-04', dueDate: '2026-10-01' });
    await addPayment(w, w.A, { type: 'vendor_invoices', payableId: paid.id, siteId: sX, paidAt: '2026-10-02', amountCents: 400 * RP });
    await addVendorInvoice(w, w.A, { site: sX, vendorId: v2, totalCents: 500 * RP, status: 'perlu_konfirmasi', invoiceDate: '2026-09-05', dueDate: '2026-09-30' });
    await addVendorInvoice(w, w.A, { site: sX, vendorId: v2, totalCents: 550 * RP, status: 'ditolak', invoiceDate: '2026-09-05', dueDate: '2026-09-30' });
    await addVendorInvoice(w, w.A, { site: sX, vendorId: v2, totalCents: 600 * RP, status: 'terkonfirmasi', invoiceDate: '2026-09-06', dueDate: null });

    const s = await snap(w, w.A);
    const mine = s.alerts.filter((a) => a.kind === 'vendor_overdue' && (a.siteId === sX || a.siteId === sY)).sort((a, b) => a.ref.localeCompare(b.ref));
    expect(mine.map((a) => [a.ref, a.data])).toEqual([
      [`vendor:${v1}:site:${sX}`, { vendorId: v1, vendorName: null, overdueCents: 250 * RP, invoices: 2, maxDaysOverdue: 26 }],
      [`vendor:${v1}:site:${sY}`, { vendorId: v1, vendorName: null, overdueCents: 300 * RP, invoices: 1, maxDaysOverdue: 2 }],
    ].sort((a, b) => String(a[0]).localeCompare(String(b[0]))));
    // the undated confirmed invoice is owed but not overdue
    expect(s.balances.find((x) => x.siteId === sX)).toMatchObject({ payableTotalCents: 850 * RP, payableOverdueCents: 250 * RP });
  });

  it('an unregistered vendor (no master row) is grouped by its name', async () => {
    const site = await addSite(w, w.A);
    await addVendorInvoice(w, w.A, { site, vendorName: 'Toko Jaya', totalCents: 100 * RP, status: 'terkonfirmasi', invoiceDate: '2026-09-01', dueDate: '2026-10-01' });
    await addVendorInvoice(w, w.A, { site, vendorName: 'Toko Jaya', totalCents: 200 * RP, status: 'terkonfirmasi', invoiceDate: '2026-09-02', dueDate: '2026-10-02' });
    await addVendorInvoice(w, w.A, { site, vendorName: 'Toko Baru', totalCents: 300 * RP, status: 'terkonfirmasi', invoiceDate: '2026-09-03', dueDate: '2026-10-03' });
    const s = await snap(w, w.A);
    const mine = s.alerts.filter((a) => a.kind === 'vendor_overdue' && a.siteId === site).map((a) => a.data).sort((a, b) => String(a['vendorName']).localeCompare(String(b['vendorName'])));
    expect(mine).toEqual([
      { vendorId: null, vendorName: 'Toko Baru', overdueCents: 300 * RP, invoices: 1, maxDaysOverdue: 24 },
      { vendorId: null, vendorName: 'Toko Jaya', overdueCents: 300 * RP, invoices: 2, maxDaysOverdue: 26 },
    ]);
  });

  // Regression (was a defect): snapshot.ts groups id-less vendors by the first 40 characters of the name, so two different
  // unregistered vendors whose (long, common for CV names) names share a 40-char prefix are merged
  // into one alert: one name shown, both debts summed under it.
  it('two different unregistered vendors with a long common name prefix stay two alerts', async () => {
    const site = await addSite(w, w.A);
    const prefix = 'CV Sumber Rejeki Abadi Jaya Makmur Sentosa ';
    expect(prefix.length).toBeGreaterThan(40);
    await addVendorInvoice(w, w.A, { site, vendorName: `${prefix}Keerom`, totalCents: 100 * RP, status: 'terkonfirmasi', invoiceDate: '2026-09-01', dueDate: '2026-10-01' });
    await addVendorInvoice(w, w.A, { site, vendorName: `${prefix}Jayapura`, totalCents: 900 * RP, status: 'terkonfirmasi', invoiceDate: '2026-09-02', dueDate: '2026-10-02' });
    const s = await snap(w, w.A);
    const mine = s.alerts.filter((a) => a.kind === 'vendor_overdue' && a.siteId === site);
    expect(mine.map((a) => [a.data['vendorName'], a.data['overdueCents']]).sort()).toEqual([[`${prefix}Jayapura`, 900 * RP], [`${prefix}Keerom`, 100 * RP]]);
  });
});

describe('po_lewat_30_hari', () => {
  it('an issued PO alerts when it is older than 30 days, not at 30; poOverdueCount follows', async () => {
    const site = await addSite(w, w.A);
    const po = await addPo(w, w.A, { site, vendor: w.vA1, orderDate: '2026-09-27', status: 'issued', lines: [{ qty: '10', unitPriceCents: 1000 * RP, description: 'Semen 50 kg' }] });
    let s = await snap(w, w.A, at('2026-10-27T16:59:59Z'));
    expect(s.alerts.filter((a) => a.ref === `po:${po.id}`)).toEqual([]);
    expect(s.balances.find((b) => b.siteId === site)).toMatchObject({ poOverdueCount: 0, poOutstandingCents: 10_000 * RP });

    s = await snap(w, w.A, at('2026-10-27T17:00:00Z'));
    expect(s.alerts.filter((a) => a.ref === `po:${po.id}`)).toEqual([{
      companyId: w.A, kind: 'po_lewat_30_hari', ref: `po:${po.id}`, siteId: site,
      data: { poId: po.id, poNumber: po.number, vendorName: 'PT Sumber Beton', firstItem: 'Semen 50 kg', ageDays: 31, outstandingCents: 10_000 * RP },
    }]);
    expect(s.balances.find((b) => b.siteId === site)).toMatchObject({ poOverdueCount: 1 });
  });

  it('a partial PO alerts with what is still undelivered; received, draft and cancelled POs do not', async () => {
    const site = await addSite(w, w.A);
    const part = await addPo(w, w.A, { site, vendor: w.vA2, orderDate: '2026-09-01', status: 'partial', lines: [{ qty: '10', unitPriceCents: 1000 * RP }, { qty: '4', unitPriceCents: 250 * RP }] });
    await addGr(w, w.A, { site, poId: part.id, receivedAt: '2026-09-10', items: [{ poItemId: part.lineIds[0]!, qty: '6' }, { poItemId: part.lineIds[1]!, qty: '4' }] });
    const full = await addPo(w, w.A, { site, vendor: w.vA2, orderDate: '2026-08-01', status: 'received', lines: [{ qty: '2', unitPriceCents: 100 * RP }] });
    await addGr(w, w.A, { site, poId: full.id, receivedAt: '2026-08-05', items: [{ poItemId: full.lineIds[0]!, qty: '2' }] });
    await addPo(w, w.A, { site, vendor: w.vA2, orderDate: '2026-08-01', status: 'draft', lines: [{ qty: '1', unitPriceCents: 100 * RP }] });
    await addPo(w, w.A, { site, vendor: w.vA2, orderDate: '2026-08-01', status: 'cancelled', lines: [{ qty: '1', unitPriceCents: 100 * RP }] });

    const s = await snap(w, w.A);
    expect(s.alerts.filter((a) => a.kind === 'po_lewat_30_hari' && a.siteId === site).map((a) => [a.ref, a.data['ageDays'], a.data['outstandingCents']]))
      .toEqual([[`po:${part.id}`, 56, 4000 * RP]]);
    expect(s.balances.find((b) => b.siteId === site)).toMatchObject({ poOverdueCount: 1, poOutstandingCents: 4000 * RP });
    // vendors panel: committed = issued/partial/received, the received PO has nothing undelivered
    expect(s.vendors.find((v) => v.siteId === site && v.vendorId === w.vA2)).toMatchObject({ poValueCents: 11_000 * RP + 200 * RP, undeliveredCents: 4000 * RP });
  });
});

describe('isolation', () => {
  it('a company\'s snapshot never contains another company\'s alerts', async () => {
    const po = await addPo(w, w.B, { site: w.sB, vendor: w.vB, orderDate: '2026-01-01', status: 'issued', lines: [{ qty: '1', unitPriceCents: 100 * RP }] });
    const a = await snap(w, w.A);
    expect(a.alerts.every((x) => x.companyId === w.A)).toBe(true);
    expect(a.alerts.some((x) => x.ref === `po:${po.id}`)).toBe(false);
    const b = await snap(w, w.B);
    expect(b.alerts.map((x) => x.ref)).toEqual([`po:${po.id}`]);
  });
});
