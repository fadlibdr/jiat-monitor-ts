import { describe, expect, it } from 'vitest';
import { PAYMENT_METHODS, SALES_INVOICE_STATUSES } from '../../src/db/schema.js';
import { AGING_BUCKETS, termInvoiceAmounts } from '../../src/domain/invoice.js';
import {
  AGING_LABEL, balanceAfter, cancellable, emptyPayment, INVOICE_LABEL, INVOICE_TONE, invoiceLines, METHOD_LABEL, nextBillable, paymentBody,
} from '../../web/src/lib/finance.js';
import type { TermStatus } from '../../web/src/lib/types.js';

const RP = 100;
const term = (seq: number, over: Partial<TermStatus> = {}): TermStatus => ({
  id: 10 + seq, seq, name: `Termin ${seq}`, percentBp: 5000, triggerProgressBp: seq * 5000, dueDays: 30, invoiceNumber: null, reached: false, invoiced: false, ...over,
});

describe('finance labels', () => {
  it('cover every server value', () => {
    expect(Object.keys(AGING_LABEL).sort()).toEqual([...AGING_BUCKETS].sort());
    expect(Object.keys(METHOD_LABEL).sort()).toEqual([...PAYMENT_METHODS].sort());
    expect(Object.keys(INVOICE_LABEL).sort()).toEqual([...SALES_INVOICE_STATUSES].sort());
    expect(Object.keys(INVOICE_TONE).sort()).toEqual([...SALES_INVOICE_STATUSES].sort());
  });
});

describe('next termin to bill', () => {
  it('the first termin without a live invoice, in order; ready only when its trigger is reached', () => {
    const terms = [term(2, { reached: false }), term(1, { reached: true, invoiced: true, invoiceNumber: 'INV/KRM/2026/001' })];
    expect(nextBillable(terms, 59_000_000)).toEqual({
      term: terms[0], ready: false, reason: 'Progres disetujui 59,0% belum mencapai ambang termin 2 (100,0%).',
    });
    expect(nextBillable([term(1, { reached: true })], 60_000_000)).toMatchObject({ ready: true, reason: null });
    expect(nextBillable([term(1, { invoiced: true })], 0)).toBeNull();
    expect(nextBillable([], 0)).toBeNull();
  });
});

describe('invoice lines', () => {
  it('add up to the server total (DPP − uang muka − retensi + PPN)', () => {
    const amounts = termInvoiceAmounts({
      effectiveDppCents: 8_150_000_000 * RP, ppnRateBp: 1100, retentionBp: 500, advanceCents: 815_000_000 * RP, termPercentBp: 3000,
      previousDppCents: 0, previousAdvanceDeductionCents: 0, previousRetentionCents: 0, previousPpnCents: 0, isLastTerm: false,
    });
    const lines = invoiceLines(amounts);
    const total = lines.pop()!;
    expect(total).toEqual({ label: 'Jumlah tagihan', cents: amounts.totalCents });
    expect(lines.reduce((s, l) => s + l.cents, 0)).toBe(amounts.totalCents);
  });
});

describe('payments', () => {
  it('balance and what may be cancelled', () => {
    expect(balanceAfter(1_000 * RP, [{ amountCents: 300 * RP }, { amountCents: 200 * RP }])).toBe(500 * RP);
    expect(cancellable({ status: 'issued', totalCents: 5 })).toBe(true);
    expect(cancellable({ status: 'paid', totalCents: 0 })).toBe(true); // issued already settled
    expect(cancellable({ status: 'paid', totalCents: 5 })).toBe(false);
    expect(cancellable({ status: 'partial', totalCents: 5 })).toBe(false);
    expect(cancellable({ status: 'cancelled', totalCents: 5 })).toBe(false);
  });

  it('body: rupiah through the server parser, refused above the balance, optional text trimmed', () => {
    const f = { ...emptyPayment('2026-10-31'), amount: 'Rp 1.250.000', reference: '  TRF-0042 ' };
    expect(paymentBody(f, { payableType: 'sales_invoices', rowRef: 7 }, 2_000_000 * RP)).toEqual({ ok: true, body: {
      payableType: 'sales_invoices', rowRef: 7, paidAt: '2026-10-31', amountCents: 1_250_000 * RP, method: 'transfer', reference: 'TRF-0042',
    } });
    const vendor = paymentBody({ ...f, method: 'tunai', reference: '' }, { payableType: 'vendor_invoices', rowRef: 'a-uuid' }, 1_250_000 * RP);
    expect(vendor).toEqual({ ok: true, body: { payableType: 'vendor_invoices', rowRef: 'a-uuid', paidAt: '2026-10-31', amountCents: 1_250_000 * RP, method: 'tunai' } });
    expect(paymentBody(f, { payableType: 'sales_invoices', rowRef: 7 }, 1_000_000 * RP))
      .toEqual({ ok: false, error: 'Jumlah Rp 1.250.000 melebihi sisa Rp 1.000.000.' });
    expect(paymentBody({ ...f, amount: '0' }, { payableType: 'sales_invoices', rowRef: 7 }, 1).ok).toBe(false);
    expect(paymentBody({ ...f, amount: '245.50' }, { payableType: 'sales_invoices', rowRef: 7 }, 1e12).ok).toBe(false); // ambiguous: refused, not guessed
    expect(paymentBody({ ...f, paidAt: '' }, { payableType: 'sales_invoices', rowRef: 7 }, 1e12)).toEqual({ ok: false, error: 'Tanggal bayar wajib diisi.' });
  });
});
