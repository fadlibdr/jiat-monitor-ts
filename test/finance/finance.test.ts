import { eq, sql } from 'drizzle-orm';
import { HTTPException } from 'hono/http-exception';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { companies, payments, salesInvoices } from '../../src/db/schema.js';
import { withApp, withCompany } from '../../src/db/tenant.js';
import {
  cancelSalesInvoice, issueTermInvoice, payables, receivables, recordPayment, termsStatus, type PaymentInput,
} from '../../src/finance/service.js';
import {
  addendum, approvedProgress, contract, inCompany, rejects, rhaz, rows, seedWorld, seqOf, submittedProgress, vendorInvoice, type World,
} from './fixture.js';

/**
 * Finance service (HLD §4 "Tagihan termin, invoice vendor, pembayaran"): termin status, termin
 * invoices (order, trigger, last-takes-rest rounding, addendum, document numbers), cancellation,
 * payments in/out, receivables aging and payables overdue. Service level, inside withCompany().
 */
let w: World;
beforeAll(async () => { w = await seedWorld(); });
afterAll(async () => { await w.close(); });

const TODAY = new Date('2026-10-27T03:00:00Z');
const issue = (K: number, termId: number, invoiceDate = '2026-10-20', company?: number, siteIds: number[] | null = null) =>
  inCompany(w, company, siteIds)((tx) => issueTermInvoice(tx, { companyId: company ?? w.A, userId: w.u.fin }, { contractId: K, termId, invoiceDate }));
const status = (K: number, company?: number) => inCompany(w, company)((tx) => termsStatus(tx, K));
const cancel = (id: number, company?: number) => inCompany(w, company)((tx) => cancelSalesInvoice(tx, id));
const pay = (input: Partial<PaymentInput> & Pick<PaymentInput, 'rowRef' | 'amountCents'>, company?: number, siteIds: number[] | null = null) =>
  inCompany(w, company, siteIds)((tx) => recordPayment(tx, { companyId: company ?? w.A }, {
    payableType: 'sales_invoices', paidAt: '2026-10-25', method: 'transfer', ...input,
  }));
const invoice = (id: number) => inCompany(w)(async (tx) => (await tx.select().from(salesInvoices).where(eq(salesInvoices.id, id)))[0]!);
const liveInvoicesOf = (K: number) => inCompany(w)((tx) =>
  tx.select().from(salesInvoices).where(sql`${salesInvoices.contractId} = ${K} AND ${salesInvoices.status} <> 'cancelled'`));
const paymentsOf = (type: string, id: number) => inCompany(w)((tx) =>
  tx.select().from(payments).where(sql`${payments.payableType} = ${type} AND ${payments.payableId} = ${id}`));
function isoDaysAgo(days: number, from = TODAY): string {
  const d = new Date(Date.UTC(from.getUTCFullYear(), from.getUTCMonth(), from.getUTCDate()));
  d.setUTCDate(d.getUTCDate() - days);
  return d.toISOString().slice(0, 10);
}

// ---------------------------------------------------------------------------------------------

describe('termsStatus', () => {
  it('lists termin in seq order with reached/invoiced; no approved opname = 0 %, so only a 0 % trigger is reached', async () => {
    const { K, terms } = await contract(w, {}, [
      { seq: 3, percentBp: 4000, triggerProgressBp: 9000 },
      { seq: 1, percentBp: 3000, triggerProgressBp: 0 },
      { seq: 2, percentBp: 3000, triggerProgressBp: 1 },
    ]);
    const s = await status(K);
    expect(s.actualMicroPct).toBe(0);
    expect(s.terms.map((t) => [t.seq, t.id, t.reached, t.invoiced, t.invoiceNumber])).toEqual([
      [1, terms[1], true, false, null],
      [2, terms[2], false, false, null],
      [3, terms[3], false, false, null],
    ]);
  });

  it('counts only APPROVED opname, the latest approved period (a submitted later report does not count)', async () => {
    const { K, leaf } = await contract(w, {}, [{ seq: 1, percentBp: 10_000, triggerProgressBp: 5000 }]);
    await approvedProgress(w, K, leaf, '2026-08-01', 30_000_000);
    await approvedProgress(w, K, leaf, '2026-09-01', 45_000_000);
    await submittedProgress(w, K, leaf, '2026-10-01', 90_000_000);
    const s = await status(K);
    expect(s.actualMicroPct).toBe(45_000_000);
    expect(s.terms[0]).toMatchObject({ reached: false, invoiced: false });
  });

  it('a contract without termin returns an empty list; another company\'s contract shows nothing of it', async () => {
    const { K } = await contract(w);
    expect((await status(K)).terms).toEqual([]);
    const kb = await contract(w, { company: w.B }, [{ seq: 1, percentBp: 10_000, triggerProgressBp: 0 }]);
    // termsStatus itself does not 404 (the route checks the contract first) but RLS hides everything
    expect((await status(kb.K)).terms).toEqual([]);
  });

  it('shows the invoice number while the invoice is live and clears it after cancellation', async () => {
    const { K, terms } = await contract(w, {}, [{ seq: 1, percentBp: 10_000, triggerProgressBp: 0 }]);
    const inv = await issue(K, terms[1]!);
    expect((await status(K)).terms[0]).toMatchObject({ invoiced: true, invoiceNumber: inv.number });
    await cancel(inv.id);
    expect((await status(K)).terms[0]).toMatchObject({ invoiced: false, invoiceNumber: null });
  });
});

// ---------------------------------------------------------------------------------------------

describe('issueTermInvoice: progress trigger', () => {
  it('one micro-percent below the trigger is refused (409, nothing written, no number consumed); exactly equal reaches', async () => {
    const { K, leaf, terms } = await contract(w, {}, [
      { seq: 1, percentBp: 2500, triggerProgressBp: 2500 }, { seq: 2, percentBp: 7500, triggerProgressBp: 10_000 },
    ]);
    await approvedProgress(w, K, leaf, '2026-08-01', 24_999_999);
    expect((await status(K)).terms[0]!.reached).toBe(false);
    const before = { inv: await rows(w, salesInvoices), seq: await seqOf(w, w.A, 'INV', 2026) };
    await rejects(issue(K, terms[1]!), 409, /belum mencapai ambang termin 1 \(25%\)/);
    expect(await rows(w, salesInvoices)).toBe(before.inv);
    expect(await seqOf(w, w.A, 'INV', 2026)).toBe(before.seq);

    await approvedProgress(w, K, leaf, '2026-09-01', 25_000_000);
    expect((await status(K)).terms[0]!.reached).toBe(true);
    const inv = await issue(K, terms[1]!);
    expect(inv).toMatchObject({ status: 'issued', progressMicroPct: 25_000_000, termId: terms[1], contractId: K, companyId: w.A, siteId: w.s1 });
  });

  it('a 100 % trigger needs exactly 100 %: 99.999999 % is refused, 100 % reaches', async () => {
    const { K, leaf, terms } = await contract(w, {}, [{ seq: 1, percentBp: 10_000, triggerProgressBp: 10_000 }]);
    await approvedProgress(w, K, leaf, '2026-08-01', 99_999_999);
    await rejects(issue(K, terms[1]!), 409);
    await approvedProgress(w, K, leaf, '2026-09-01', 100_000_000);
    expect((await issue(K, terms[1]!)).progressMicroPct).toBe(100_000_000);
  });

  it('a 0 % trigger (uang muka termin) is billable with no opname at all', async () => {
    const { K, terms } = await contract(w, {}, [{ seq: 1, percentBp: 1000, triggerProgressBp: 0 }]);
    const inv = await issue(K, terms[1]!);
    expect(inv.progressMicroPct).toBe(0);
    expect(inv.dppCents).toBe(100_000_00);
  });

  it('a submitted (not approved) opname does not unlock a termin', async () => {
    const { K, leaf, terms } = await contract(w, {}, [{ seq: 1, percentBp: 10_000, triggerProgressBp: 1000 }]);
    await submittedProgress(w, K, leaf, '2026-09-01', 100_000_000);
    await rejects(issue(K, terms[1]!), 409, /belum mencapai/);
  });
});

describe('issueTermInvoice: order, duplicates, not found', () => {
  it('termin are billed in seq order: a later reached termin is refused while an earlier one is open', async () => {
    const { K, leaf, terms } = await contract(w, {}, [
      { seq: 1, percentBp: 3000, triggerProgressBp: 1000 }, { seq: 2, percentBp: 3000, triggerProgressBp: 2000 }, { seq: 3, percentBp: 4000, triggerProgressBp: 3000 },
    ]);
    await approvedProgress(w, K, leaf, '2026-09-01', 50_000_000);
    const before = await rows(w, salesInvoices);
    await rejects(issue(K, terms[3]!), 409, /Termin 1, 2 belum ditagih/);
    await rejects(issue(K, terms[2]!), 409, /Termin 1 belum ditagih/);
    expect(await rows(w, salesInvoices)).toBe(before);
    await issue(K, terms[1]!);
    await rejects(issue(K, terms[3]!), 409, /Termin 2 belum ditagih/);
    await issue(K, terms[2]!);
    await issue(K, terms[3]!);
    expect((await status(K)).terms.every((t) => t.invoiced)).toBe(true);
  });

  it('a termin with a live invoice is refused with 409 naming the invoice; nothing is written', async () => {
    const { K, terms } = await contract(w, {}, [{ seq: 1, percentBp: 5000, triggerProgressBp: 0 }]);
    const first = await issue(K, terms[1]!);
    const before = { inv: await rows(w, salesInvoices), seq: await seqOf(w, w.A, 'INV', 2026) };
    await rejects(issue(K, terms[1]!, '2026-10-21'), 409, new RegExp(`Termin 1 sudah ditagih \\(${first.number.replace(/\//g, '\\/')}\\)`));
    expect(await rows(w, salesInvoices)).toBe(before.inv);
    expect(await seqOf(w, w.A, 'INV', 2026)).toBe(before.seq);
  });

  it('a paid or partially paid invoice also blocks re-issuing its termin', async () => {
    const { K, terms } = await contract(w, {}, [{ seq: 1, percentBp: 5000, triggerProgressBp: 0 }]);
    const inv = await issue(K, terms[1]!);
    await pay({ rowRef: inv.id, amountCents: 1 });
    await rejects(issue(K, terms[1]!), 409, /sudah ditagih/);
  });

  it('404 for an unknown contract, a termin of another contract, and a contract of another company (RLS)', async () => {
    const a = await contract(w, {}, [{ seq: 1, percentBp: 5000, triggerProgressBp: 0 }]);
    const b = await contract(w, {}, [{ seq: 1, percentBp: 5000, triggerProgressBp: 0 }]);
    const kb = await contract(w, { company: w.B }, [{ seq: 1, percentBp: 5000, triggerProgressBp: 0 }]);
    await rejects(issue(9_999_999, a.terms[1]!), 404, /Kontrak tidak ditemukan/);
    await rejects(issue(a.K, b.terms[1]!), 404, /Termin tidak ditemukan/);
    await rejects(issue(kb.K, kb.terms[1]!), 404, /Kontrak tidak ditemukan/);
    await rejects(issue(a.K, kb.terms[1]!), 404, /Termin tidak ditemukan/);
  });

  it('a finance member limited to s1 cannot bill a contract at s2 (invisible = 404)', async () => {
    const k = await contract(w, { site: w.s2 }, [{ seq: 1, percentBp: 5000, triggerProgressBp: 0 }]);
    await rejects(issue(k.K, k.terms[1]!, '2026-10-20', w.A, [w.s1]), 404);
    expect((await issue(k.K, k.terms[1]!, '2026-10-20', w.A, [w.s2])).siteId).toBe(w.s2);
  });
});

// ---------------------------------------------------------------------------------------------

describe('issueTermInvoice: amounts (DPP, uang muka, retensi, PPN)', () => {
  it('3 × 33.33 %: the last termin takes the rest so DPP, uang muka, retensi and PPN add up to the cent', async () => {
    const { K, terms } = await contract(w, { valueDppCents: 100, advanceCents: 10, retentionBp: 500, ppnRateBp: 1100 }, [
      { seq: 1, percentBp: 3333, triggerProgressBp: 0 }, { seq: 2, percentBp: 3333, triggerProgressBp: 0 }, { seq: 3, percentBp: 3334, triggerProgressBp: 0 },
    ]);
    const i1 = await issue(K, terms[1]!);
    const i2 = await issue(K, terms[2]!);
    const i3 = await issue(K, terms[3]!);
    // 33.33 → 33; uang muka 3.333 → 3; retensi 1.65 → 2 (half away from zero); PPN 11 % × 30 = 3.3 → 3
    expect(i1).toMatchObject({ dppCents: 33, advanceDeductionCents: 3, retentionCents: 2, ppnCents: 3, totalCents: 31 });
    expect(i2).toMatchObject({ dppCents: 33, advanceDeductionCents: 3, retentionCents: 2, ppnCents: 3, totalCents: 31 });
    // naive 33.34 % would give 33 and 3; the last takes 34 and 4. Retensi of the contract is 5 % × 100 = 5,
    // so the last withholds 5 − 2 − 2 = 1 (not 2); PPN of the contract is 11 % × (100 − 10) = 9.9 → 10, so 10 − 3 − 3 = 4
    expect(i3).toMatchObject({ dppCents: 34, advanceDeductionCents: 4, retentionCents: 1, ppnCents: 4, totalCents: 33 });
    expect(i1.dppCents + i2.dppCents + i3.dppCents).toBe(100);
    expect(i1.advanceDeductionCents + i2.advanceDeductionCents + i3.advanceDeductionCents).toBe(10);
    expect(i1.retentionCents + i2.retentionCents + i3.retentionCents).toBe(5);
    expect(i1.ppnCents + i2.ppnCents + i3.ppnCents).toBe(10);
    // what the employer pays over the schedule: DPP − uang muka − retensi + PPN of the whole contract
    expect(i1.totalCents + i2.totalCents + i3.totalCents).toBe(100 - 10 - 5 + 10);
  });

  it('awkward amounts + an addendum between termin 1 and 2: Σ DPP = effective DPP, Σ uang muka = advance, to the cent', async () => {
    const DPP0 = 98_765_432_107; const ADV = 14_814_814_817; const DELTA = 123_456_789;
    const { K, leaf, terms } = await contract(w, { valueDppCents: DPP0, advanceCents: ADV, retentionBp: 500, ppnRateBp: 1100 }, [
      { seq: 1, percentBp: 3333, triggerProgressBp: 1000 }, { seq: 2, percentBp: 3333, triggerProgressBp: 2000 }, { seq: 3, percentBp: 3334, triggerProgressBp: 3000 },
    ]);
    await approvedProgress(w, K, leaf, '2026-09-01', 50_000_000);
    const i1 = await issue(K, terms[1]!);
    await addendum(w, K, DELTA);
    const i2 = await issue(K, terms[2]!);
    const i3 = await issue(K, terms[3]!);
    const DPP1 = DPP0 + DELTA;

    const expectRow = (inv: typeof i1, dpp: number, adv: number, rest?: { ret: number; ppn: number }) => {
      const ret = rest?.ret ?? rhaz(dpp, 500, 10_000);
      const ppn = rest?.ppn ?? rhaz(dpp - adv, 1100, 10_000);
      expect(inv).toMatchObject({ dppCents: dpp, advanceDeductionCents: adv, retentionCents: ret, ppnCents: ppn, totalCents: dpp - adv - ret + ppn });
    };
    expectRow(i1, rhaz(DPP0, 3333, 10_000), rhaz(ADV, 3333, 10_000)); // billed before the addendum
    expectRow(i2, rhaz(DPP1, 3333, 10_000), rhaz(ADV, 3333, 10_000)); // after: on the new effective DPP
    // the last takes the rest of every figure, against the effective contract
    expectRow(i3, DPP1 - i1.dppCents - i2.dppCents, ADV - i1.advanceDeductionCents - i2.advanceDeductionCents, {
      ret: rhaz(DPP1, 500, 10_000) - i1.retentionCents - i2.retentionCents,
      ppn: rhaz(DPP1 - ADV, 1100, 10_000) - i1.ppnCents - i2.ppnCents,
    });
    expect(i3.advanceDeductionCents).not.toBe(rhaz(ADV, 3334, 10_000)); // the rounding cent really moved
    expect(i1.dppCents + i2.dppCents + i3.dppCents).toBe(DPP1);
    expect(i1.advanceDeductionCents + i2.advanceDeductionCents + i3.advanceDeductionCents).toBe(ADV);
    expect(i1.retentionCents + i2.retentionCents + i3.retentionCents).toBe(rhaz(DPP1, 500, 10_000));
    expect(i1.ppnCents + i2.ppnCents + i3.ppnCents).toBe(rhaz(DPP1 - ADV, 1100, 10_000));
    // concrete values (independently computed, .probe/termin3.ts), so a change of rounding mode is caught
    expect([i1.dppCents, i2.dppCents, i3.dppCents]).toEqual([32_918_518_521, 32_959_666_669, 33_010_703_706]);
    expect(i3.retentionCents).toBe(1_650_535_186); // one cent more than 5 % of its own DPP: the rest
    expect([i1.totalCents, i2.totalCents, i3.totalCents]).toEqual([29_412_696_298, 29_456_313_335, 29_508_768_150]);
  });

  it('an addendum before any billing: every termin is on the effective DPP (the original is never used)', async () => {
    const { K, terms } = await contract(w, { valueDppCents: 1_000_000_01, ppnRateBp: 1100 }, [
      { seq: 1, percentBp: 5000, triggerProgressBp: 0 }, { seq: 2, percentBp: 5000, triggerProgressBp: 0 },
    ]);
    await addendum(w, K, -333_333_33);
    await addendum(w, K, 7);
    const eff = 1_000_000_01 - 333_333_33 + 7;
    const i1 = await issue(K, terms[1]!);
    const i2 = await issue(K, terms[2]!);
    expect(i1.dppCents).toBe(rhaz(eff, 5000, 10_000));
    expect(i1.dppCents + i2.dppCents).toBe(eff);
  });

  it('an incomplete schedule (Σ < 100 %) has no "last termin": each is exactly its percent', async () => {
    const { K, terms } = await contract(w, { valueDppCents: 1_000_001, advanceCents: 333_333 }, [
      { seq: 1, percentBp: 3333, triggerProgressBp: 0 }, { seq: 2, percentBp: 3333, triggerProgressBp: 0 },
    ]);
    const i1 = await issue(K, terms[1]!);
    const i2 = await issue(K, terms[2]!);
    expect(i2.dppCents).toBe(rhaz(1_000_001, 3333, 10_000));
    expect(i2.advanceDeductionCents).toBe(rhaz(333_333, 3333, 10_000));
    expect(i1.dppCents + i2.dppCents).toBeLessThan(1_000_001);
  });

  it('no uang muka, no retensi, PPN 0 %: total = DPP', async () => {
    const { K, terms } = await contract(w, { valueDppCents: 999_999_99, ppnRateBp: 0 }, [{ seq: 1, percentBp: 10_000, triggerProgressBp: 0 }]);
    expect(await issue(K, terms[1]!)).toMatchObject({ dppCents: 999_999_99, advanceDeductionCents: 0, retentionCents: 0, ppnCents: 0, totalCents: 999_999_99 });
  });

  it('half a cent rounds away from zero; the last termin may be 0', async () => {
    const { K, terms } = await contract(w, { valueDppCents: 1, ppnRateBp: 0 }, [
      { seq: 1, percentBp: 5000, triggerProgressBp: 0 }, { seq: 2, percentBp: 5000, triggerProgressBp: 0 },
    ]);
    const first = await issue(K, terms[1]!);
    expect(first.dppCents).toBe(1);
    // nothing left to bill: issued as settled, so it never waits for a payment
    const zero = await issue(K, terms[2]!);
    expect(zero).toMatchObject({ dppCents: 0, totalCents: 0, status: 'paid' });
    // ...yet it was never paid, so it can be cancelled — else the wrong termin 1 under it could never be
    await rejects(cancel(first.id), 409, /termin 2/);
    expect((await cancel(zero.id)).status).toBe('cancelled');
    expect((await cancel(first.id)).status).toBe('cancelled');
  });

  it('very large contract (Rp 50 T): DPP × bp exceeds 2^53 but stays exact', async () => {
    const big = 5_000_000_000_000_00 + 7; // cents
    const { K, terms } = await contract(w, { valueDppCents: big, advanceCents: 1_000_000_000_000_01, retentionBp: 500 }, [
      { seq: 1, percentBp: 3333, triggerProgressBp: 0 }, { seq: 2, percentBp: 6667, triggerProgressBp: 0 },
    ]);
    const i1 = await issue(K, terms[1]!);
    const i2 = await issue(K, terms[2]!);
    expect(i1.dppCents).toBe(rhaz(big, 3333, 10_000));
    expect(i1.dppCents + i2.dppCents).toBe(big);
    expect(i1.advanceDeductionCents + i2.advanceDeductionCents).toBe(1_000_000_000_000_01);
  });

  it('due date = invoice date + dueDays across month/year ends and a leap day; 0 days = same day', async () => {
    const { K, terms } = await contract(w, {}, [
      { seq: 1, percentBp: 2000, triggerProgressBp: 0, dueDays: 30 }, { seq: 2, percentBp: 2000, triggerProgressBp: 0, dueDays: 0 },
      { seq: 3, percentBp: 2000, triggerProgressBp: 0, dueDays: 1 },
    ]);
    expect((await issue(K, terms[1]!, '2026-12-15')).dueDate).toBe('2027-01-14');
    expect((await issue(K, terms[2]!, '2027-01-31')).dueDate).toBe('2027-01-31');
    expect((await issue(K, terms[3]!, '2028-02-28')).dueDate).toBe('2028-02-29');
  });

  // Regression (was a defect): when an addendum lowers the effective DPP below what is already billed, the last termin
  // "takes the rest" = a NEGATIVE DPP and a negative total. Such an invoice can never be paid
  // (payments must be > 0 and Σ ≤ total), drops out of receivables (balance ≤ 0), but stays
  // 'issued' forever and keeps raising the "termin jatuh tempo" alert. It should be refused (or
  // handled as a credit note), not issued as a sales invoice.
  it('never issues a termin invoice with a negative DPP / total (addendum below the billed amount)', async () => {
    const { K, terms } = await contract(w, { valueDppCents: 1_000_000_00, ppnRateBp: 1100 }, [
      { seq: 1, percentBp: 5000, triggerProgressBp: 0 }, { seq: 2, percentBp: 5000, triggerProgressBp: 0 },
    ]);
    await issue(K, terms[1]!); // 500 000 000 cents billed
    await addendum(w, K, -600_000_00); // effective DPP now 400 000 000
    const res = await issue(K, terms[2]!).then((r) => r, (e: unknown) => e);
    if (res instanceof HTTPException) {
      expect([400, 409]).toContain(res.status);
    } else {
      expect((res as { dppCents: number }).dppCents).toBeGreaterThanOrEqual(0);
      expect((res as { totalCents: number }).totalCents).toBeGreaterThanOrEqual(0);
    }
  });
});

// ---------------------------------------------------------------------------------------------

describe('document number', () => {
  it('INV/<site>/<year>/<seq> per company and year, with the company prefix; cancelled numbers are not reused; refusals consume none', async () => {
    await withApp(w.db, (tx) => tx.update(companies).set({ docPrefix: 'PBB' }).where(eq(companies.id, w.B)));
    const { K, terms } = await contract(w, { company: w.B }, [
      { seq: 1, percentBp: 3000, triggerProgressBp: 0 }, { seq: 2, percentBp: 3000, triggerProgressBp: 0 }, { seq: 3, percentBp: 4000, triggerProgressBp: 9000 },
    ]);
    const i1 = await issue(K, terms[1]!, '2026-10-20', w.B);
    expect(i1.number).toBe('PBB/INV/BBB/2026/001');
    await rejects(issue(K, terms[1]!, '2026-10-20', w.B), 409); // duplicate
    await rejects(issue(K, terms[3]!, '2026-10-20', w.B), 409); // order
    await cancel(i1.id, w.B);
    const again = await issue(K, terms[1]!, '2026-10-21', w.B);
    expect(again.number).toBe('PBB/INV/BBB/2026/002');
    expect(again.id).not.toBe(i1.id);
    // a new year restarts the counter
    const i2 = await issue(K, terms[2]!, '2027-01-03', w.B);
    expect(i2.number).toBe('PBB/INV/BBB/2027/001');
    expect(await seqOf(w, w.B, 'INV', 2026)).toBe(2);
    expect(await seqOf(w, w.B, 'INV', 2027)).toBe(1);
    // the cancelled invoice keeps its own number and status
    const old = await inCompany(w, w.B)(async (tx) => (await tx.select().from(salesInvoices).where(eq(salesInvoices.id, i1.id)))[0]!);
    expect(old).toMatchObject({ number: 'PBB/INV/BBB/2026/001', status: 'cancelled' });
  });

  it('company A: no prefix, the site code of the contract, one counter for all sites of the company', async () => {
    const a = await contract(w, { site: w.s1 }, [{ seq: 1, percentBp: 1000, triggerProgressBp: 0 }]);
    const b = await contract(w, { site: w.s2 }, [{ seq: 1, percentBp: 1000, triggerProgressBp: 0 }]);
    const ia = await issue(a.K, a.terms[1]!, '2030-05-01');
    const ib = await issue(b.K, b.terms[1]!, '2030-05-02');
    expect(ia.number).toBe('INV/KRM/2030/001');
    expect(ib.number).toBe('INV/JYP/2030/002');
  });
});

// ---------------------------------------------------------------------------------------------

describe('cancelSalesInvoice', () => {
  it('cancels an unpaid invoice; the termin is billable again with the same amounts and a new number', async () => {
    const { K, terms } = await contract(w, { valueDppCents: 777_777_77, advanceCents: 111_111_11, retentionBp: 500 }, [
      { seq: 1, percentBp: 3333, triggerProgressBp: 0 }, { seq: 2, percentBp: 6667, triggerProgressBp: 0 },
    ]);
    const i1 = await issue(K, terms[1]!);
    const c = await cancel(i1.id);
    expect(c.status).toBe('cancelled');
    const r1 = await issue(K, terms[1]!, '2026-10-22');
    expect(r1.number).not.toBe(i1.number);
    const pick = (i: typeof i1) => [i.dppCents, i.advanceDeductionCents, i.retentionCents, i.ppnCents, i.totalCents];
    expect(pick(r1)).toEqual(pick(i1));
    // the cancelled one does not count as "previous": the last termin still adds up exactly
    const i2 = await issue(K, terms[2]!);
    expect(r1.dppCents + i2.dppCents).toBe(777_777_77);
    expect(r1.advanceDeductionCents + i2.advanceDeductionCents).toBe(111_111_11);
  });

  it('after cancelling termin 1, termin 2 is refused again (order rule follows live invoices)', async () => {
    const { K, terms } = await contract(w, {}, [{ seq: 1, percentBp: 5000, triggerProgressBp: 0 }, { seq: 2, percentBp: 5000, triggerProgressBp: 0 }]);
    const i1 = await issue(K, terms[1]!);
    await cancel(i1.id);
    await rejects(issue(K, terms[2]!), 409, /Termin 1 belum ditagih/);
  });

  it('refuses partial, paid and already cancelled invoices (409, status unchanged); 404 unknown / other company', async () => {
    const { K, terms } = await contract(w, {}, [
      { seq: 1, percentBp: 3000, triggerProgressBp: 0 }, { seq: 2, percentBp: 3000, triggerProgressBp: 0 }, { seq: 3, percentBp: 4000, triggerProgressBp: 0 },
    ]);
    const i1 = await issue(K, terms[1]!);
    const i2 = await issue(K, terms[2]!);
    const i3 = await issue(K, terms[3]!);
    await pay({ rowRef: i1.id, amountCents: 1 });
    await pay({ rowRef: i2.id, amountCents: i2.totalCents });
    await rejects(cancel(i1.id), 409, /partial/);
    await rejects(cancel(i2.id), 409, /paid/);
    expect((await invoice(i1.id)).status).toBe('partial');
    expect((await invoice(i2.id)).status).toBe('paid');
    await cancel(i3.id);
    await rejects(cancel(i3.id), 409, /cancelled/);
    await rejects(cancel(9_999_999), 404);
    const kb = await contract(w, { company: w.B }, [{ seq: 1, percentBp: 1000, triggerProgressBp: 0 }]);
    const ib = await issue(kb.K, kb.terms[1]!, '2026-10-20', w.B);
    await rejects(cancel(ib.id), 404);
    expect((await inCompany(w, w.B)((tx) => tx.select().from(salesInvoices).where(eq(salesInvoices.id, ib.id))))[0]!.status).toBe('issued');
  });

  // Regression (was a defect): cancelSalesInvoice does not look at later termin. Cancelling termin 1 while termin 2 (the
  // last, which "took the rest") is live lets termin 1 be re-billed AFTER termin 2 — against the
  // in-order rule issueTermInvoice relies on for "previous" totals. With an addendum (or a changed
  // uang muka) in between, the re-issued termin 1 is computed on the new value while the last termin
  // was computed on the old one, so Σ live termin DPP ≠ effective DPP. Expected: refuse to cancel a
  // termin invoice while a later termin of the same contract has a live invoice (or recompute).
  it('an earlier termin cannot be cancelled under a live later one (409); cancelled in reverse order, Σ termin DPP = new effective DPP', async () => {
    const { K, terms } = await contract(w, { valueDppCents: 1_000_000_00 }, [
      { seq: 1, percentBp: 3000, triggerProgressBp: 0 }, { seq: 2, percentBp: 7000, triggerProgressBp: 0 },
    ]);
    const i1 = await issue(K, terms[1]!);
    const i2 = await issue(K, terms[2]!); // last: takes the rest = 700 000 00
    await expect(cancel(i1.id)).rejects.toMatchObject({ status: 409 });
    expect((await liveInvoicesOf(K)).map((i) => i.id).sort()).toEqual([i1.id, i2.id].sort());

    await cancel(i2.id);
    await cancel(i1.id);
    await addendum(w, K, 100_000_00);
    await issue(K, terms[1]!, '2026-10-22');
    await issue(K, terms[2]!, '2026-10-22');
    const live = await liveInvoicesOf(K);
    expect(live.reduce((s, i) => s + i.dppCents, 0)).toBe(1_100_000_00);
  });
});

// ---------------------------------------------------------------------------------------------

describe('recordPayment: sales invoices', () => {
  it('partial → paid at exactly the remaining balance; one more cent is refused (409, nothing written)', async () => {
    const { K, terms } = await contract(w, { valueDppCents: 123_456_79, retentionBp: 500, advanceCents: 10_000_01 }, [{ seq: 1, percentBp: 10_000, triggerProgressBp: 0 }]);
    const inv = await issue(K, terms[1]!);
    const T = inv.totalCents;
    const p1 = await pay({ rowRef: inv.id, amountCents: 1, method: 'tunai', reference: 'KW-1', note: 'cicilan' });
    expect(p1).toMatchObject({ balanceCents: T - 1, payableType: 'sales_invoices', rowRef: inv.id, siteId: w.s1, companyId: w.A, amountCents: 1, method: 'tunai', reference: 'KW-1', note: 'cicilan' });
    expect((await invoice(inv.id)).status).toBe('partial');

    const before = await rows(w, payments);
    await rejects(pay({ rowRef: inv.id, amountCents: T }), 409, new RegExp(`sisa ${T - 1} sen`));
    expect(await rows(w, payments)).toBe(before);
    expect((await invoice(inv.id)).status).toBe('partial');

    const p2 = await pay({ rowRef: inv.id, amountCents: T - 1 });
    expect(p2.balanceCents).toBe(0);
    expect((await invoice(inv.id)).status).toBe('paid');
    await rejects(pay({ rowRef: inv.id, amountCents: 1 }), 409, /sisa 0 sen/);
    expect((await invoice(inv.id)).status).toBe('paid');
    expect((await paymentsOf('sales_invoices', inv.id)).map((p) => p.amountCents)).toEqual([1, T - 1]);
  });

  it('one payment of exactly the total goes straight to paid; the same payment posted twice is refused the second time', async () => {
    const { K, terms } = await contract(w, {}, [{ seq: 1, percentBp: 10_000, triggerProgressBp: 0 }]);
    const inv = await issue(K, terms[1]!);
    expect((await pay({ rowRef: inv.id, amountCents: inv.totalCents, reference: 'TRF-9' })).balanceCents).toBe(0);
    expect((await invoice(inv.id)).status).toBe('paid');
    await rejects(pay({ rowRef: inv.id, amountCents: inv.totalCents, reference: 'TRF-9' }), 409);
    expect(await paymentsOf('sales_invoices', inv.id)).toHaveLength(1);
  });

  it('a cancelled invoice cannot be paid (409); unknown / other company / outside the site scope = 404', async () => {
    const { K, terms } = await contract(w, {}, [{ seq: 1, percentBp: 10_000, triggerProgressBp: 0 }]);
    const inv = await issue(K, terms[1]!);
    await cancel(inv.id);
    const before = await rows(w, payments);
    await rejects(pay({ rowRef: inv.id, amountCents: 1 }), 409, /dibatalkan/);
    await rejects(pay({ rowRef: 9_999_999, amountCents: 1 }), 404);
    const kb = await contract(w, { company: w.B }, [{ seq: 1, percentBp: 1000, triggerProgressBp: 0 }]);
    const ib = await issue(kb.K, kb.terms[1]!, '2026-10-20', w.B);
    await rejects(pay({ rowRef: ib.id, amountCents: 1 }), 404);
    const k2 = await contract(w, { site: w.s2 }, [{ seq: 1, percentBp: 10_000, triggerProgressBp: 0 }]);
    const i2 = await issue(k2.K, k2.terms[1]!);
    await rejects(pay({ rowRef: i2.id, amountCents: 1 }, w.A, [w.s1]), 404);
    expect(await rows(w, payments)).toBe(before);
    expect((await pay({ rowRef: i2.id, amountCents: 1 }, w.A, [w.s2])).siteId).toBe(w.s2);
  });

  it('payments of a vendor invoice never count against a sales invoice (and vice versa)', async () => {
    const { K, terms } = await contract(w, {}, [{ seq: 1, percentBp: 10_000, triggerProgressBp: 0 }]);
    const inv = await issue(K, terms[1]!);
    // insert a payment row of the OTHER type with the same payable id; it must not reduce the balance
    await withCompany(w.db, w.A, (tx) => tx.insert(payments).values({
      companyId: w.A, siteId: w.s1, payableType: 'vendor_invoices', payableId: inv.id, paidAt: '2026-10-01', amountCents: inv.totalCents, method: 'transfer',
    }));
    expect((await pay({ rowRef: inv.id, amountCents: inv.totalCents })).balanceCents).toBe(0);
  });
});

describe('recordPayment: vendor invoices (by row_id)', () => {
  it('pays only a confirmed invoice, in parts, never above its total; payables follow', async () => {
    const vi = await vendorInvoice(w, { status: 'terkonfirmasi', totalCents: 1_000_01, dueDate: '2026-11-30', invoiceDate: '2026-10-02' });
    const v = (amount: number) => pay({ payableType: 'vendor_invoices', rowRef: vi.rowId, amountCents: amount });
    const p1 = await v(400_00);
    // the vendor invoice by its public row_id; its internal id never leaves the API
    expect(p1).toMatchObject({ payableType: 'vendor_invoices', rowRef: vi.rowId, siteId: w.s1, balanceCents: 600_01 });
    expect(p1).not.toHaveProperty('payableId');
    const open = async () => (await inCompany(w)((tx) => payables(tx, TODAY))).find((r) => r.rowId === vi.rowId);
    expect(await open()).toMatchObject({ balanceCents: 600_01, totalCents: 1_000_01, overdue: false });
    await rejects(v(600_02), 409, /sisa 60001 sen/);
    expect((await v(600_01)).balanceCents).toBe(0);
    expect(await open()).toBeUndefined();
    await rejects(v(1), 409);
  });

  it('refuses unconfirmed / rejected invoices with 409 and writes nothing', async () => {
    const before = await rows(w, payments);
    for (const s of ['perlu_konfirmasi', 'perlu_cek', 'ditolak'] as const) {
      const vi = await vendorInvoice(w, { status: s, totalCents: 5_000_00 + before });
      await rejects(pay({ payableType: 'vendor_invoices', rowRef: vi.rowId, amountCents: 1 }), 409, /terkonfirmasi/);
    }
    expect(await rows(w, payments)).toBe(before);
  });

  it('404 for an unknown row_id, another company\'s invoice, or one outside the site scope', async () => {
    await rejects(pay({ payableType: 'vendor_invoices', rowRef: '00000000-0000-4000-8000-000000000000', amountCents: 1 }), 404, /Nota vendor/);
    const vb = await vendorInvoice(w, { status: 'terkonfirmasi', totalCents: 9_99, company: w.B });
    await rejects(pay({ payableType: 'vendor_invoices', rowRef: vb.rowId, amountCents: 1 }), 404);
    const v2 = await vendorInvoice(w, { status: 'terkonfirmasi', totalCents: 8_88, site: w.s2 });
    await rejects(pay({ payableType: 'vendor_invoices', rowRef: v2.rowId, amountCents: 1 }, w.A, [w.s1]), 404);
  });
});

// ---------------------------------------------------------------------------------------------

describe('receivables: aging by days since the invoice date', () => {
  it('bucket boundaries 30/31, 60/61, 90/91 (and today, future-dated) — by the WIB date, whatever the time of day', async () => {
    const ages = [0, 30, 31, 60, 61, 90, 91, -3];
    const ids = new Map<number, number>();
    for (const age of ages) {
      const { K, terms } = await contract(w, {}, [{ seq: 1, percentBp: 10_000, triggerProgressBp: 0 }]);
      ids.set((await issue(K, terms[1]!, isoDaysAgo(age))).id, age);
    }
    const agesAt = async (now: Date) => Object.fromEntries((await inCompany(w)((tx) => receivables(tx, now)))
      .filter((r) => ids.has(r.id)).map((r) => [ids.get(r.id)!, [r.ageDays, r.bucket]]));
    // the whole WIB day of 27 Oct: 00:00 WIB is 17:00 UTC the day before
    for (const now of [TODAY, new Date('2026-10-26T17:00:00Z'), new Date('2026-10-27T16:59:59Z')]) {
      expect(await agesAt(now)).toEqual({
        0: [0, 'd0_30'], 30: [30, 'd0_30'], 31: [31, 'd31_60'], 60: [60, 'd31_60'], 61: [61, 'd61_90'], 90: [90, 'd61_90'], 91: [91, 'd90p'], [-3]: [-3, 'd0_30'],
      });
    }
    // 00:00 WIB on the 28th (still the 27th in UTC): every invoice is a day older
    expect((await agesAt(new Date('2026-10-27T17:00:00Z')))[30]).toEqual([31, 'd31_60']);
  });

  it('open balance = total − payments; paid and cancelled invoices are not receivables', async () => {
    const mk = async () => {
      const { K, terms } = await contract(w, {}, [{ seq: 1, percentBp: 10_000, triggerProgressBp: 0 }]);
      return issue(K, terms[1]!, '2026-10-01');
    };
    const [a, b, c] = [await mk(), await mk(), await mk()];
    await pay({ rowRef: a.id, amountCents: 12_345 });
    await pay({ rowRef: b.id, amountCents: b.totalCents });
    await cancel(c.id);
    const rec = (await inCompany(w)((tx) => receivables(tx, TODAY))).filter((r) => [a.id, b.id, c.id].includes(r.id));
    expect(rec).toEqual([expect.objectContaining({ id: a.id, totalCents: a.totalCents, balanceCents: a.totalCents - 12_345, ageDays: 26, bucket: 'd0_30', number: a.number })]);
  });

  it('site scope: a member limited to s1 does not see s2 receivables', async () => {
    const k2 = await contract(w, { site: w.s2 }, [{ seq: 1, percentBp: 10_000, triggerProgressBp: 0 }]);
    const i2 = await issue(k2.K, k2.terms[1]!);
    const scoped = await inCompany(w, w.A, [w.s1])((tx) => receivables(tx, TODAY));
    expect(scoped.some((r) => r.id === i2.id)).toBe(false);
    expect(scoped.every((r) => r.siteId === w.s1)).toBe(true);
  });
});

describe('payables: unpaid confirmed vendor invoices, overdue after the due date', () => {
  it('due yesterday = overdue; due today, tomorrow or without a due date = not overdue; unconfirmed are not payables', async () => {
    const yesterday = await vendorInvoice(w, { status: 'terkonfirmasi', totalCents: 1_01, dueDate: '2026-10-26' });
    const today = await vendorInvoice(w, { status: 'terkonfirmasi', totalCents: 1_02, dueDate: '2026-10-27' });
    const tomorrow = await vendorInvoice(w, { status: 'terkonfirmasi', totalCents: 1_03, dueDate: '2026-10-28' });
    const none = await vendorInvoice(w, { status: 'terkonfirmasi', totalCents: 1_04, dueDate: null });
    const draft = await vendorInvoice(w, { status: 'perlu_konfirmasi', totalCents: 1_05, dueDate: '2026-01-01' });
    const rejected = await vendorInvoice(w, { status: 'ditolak', totalCents: 1_06, dueDate: '2026-01-01' });
    const list = await inCompany(w)((tx) => payables(tx, TODAY));
    const by = new Map(list.map((r) => [r.rowId, r]));
    expect(by.get(yesterday.rowId)!.overdue).toBe(true);
    expect(by.get(today.rowId)!.overdue).toBe(false);
    expect(by.get(tomorrow.rowId)!.overdue).toBe(false);
    expect(by.get(none.rowId)!.overdue).toBe(false);
    expect(by.has(draft.rowId)).toBe(false);
    expect(by.has(rejected.rowId)).toBe(false);
    expect(by.get(yesterday.rowId)).toMatchObject({ totalCents: 1_01, balanceCents: 1_01, siteId: w.s1, vendorId: w.vA });
  });

  it('another company\'s vendor invoices never appear', async () => {
    const vb = await vendorInvoice(w, { status: 'terkonfirmasi', totalCents: 7_77, company: w.B, dueDate: '2026-01-01' });
    const list = await inCompany(w)((tx) => payables(tx, TODAY));
    expect(list.some((r) => r.rowId === vb.rowId)).toBe(false);
  });
});
