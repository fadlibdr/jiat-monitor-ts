import { parseIdrCents } from './forms.js';
import { percentBp, percentMicro, rupiah } from './format.js';
import type { Built } from './master.js';
import type { AgingBucket, Payment, PaymentInput, PaymentMethod, SalesInvoice, SalesInvoiceStatus, TermStatus } from './types.js';

/**
 * Invoicing and payment forms → request bodies. Every invoice amount is computed and frozen by the
 * server (src/domain/invoice.ts); the screen only shows them and checks a payment against the balance.
 */
const fail = (error: string): { ok: false; error: string } => ({ ok: false, error });

export const AGING_LABEL: Record<AgingBucket, string> = { d0_30: '0–30 hari', d31_60: '31–60 hari', d61_90: '61–90 hari', d90p: '> 90 hari' };
export const METHOD_LABEL: Record<PaymentMethod, string> = { transfer: 'Transfer', tunai: 'Tunai', giro: 'Giro', lain: 'Lainnya' };
export const INVOICE_LABEL: Record<SalesInvoiceStatus, string> = { issued: 'Terbit', partial: 'Dibayar sebagian', paid: 'Lunas', cancelled: 'Dibatalkan' };
export const INVOICE_TONE: Record<SalesInvoiceStatus, 'plain' | 'amber' | 'green' | 'red'> = { issued: 'amber', partial: 'amber', paid: 'green', cancelled: 'plain' };

/**
 * The termin to bill next: the first one without a live invoice (they are billed in order). `ready`
 * when approved progress has reached its trigger; otherwise `reason` says by how much it falls short.
 */
export function nextBillable(terms: readonly TermStatus[], actualMicroPct: number): { term: TermStatus; ready: boolean; reason: string | null } | null {
  const term = [...terms].sort((a, b) => a.seq - b.seq).find((t) => !t.invoiced);
  if (!term) return null;
  if (term.reached) return { term, ready: true, reason: null };
  return { term, ready: false, reason: `Progres disetujui ${percentMicro(actualMicroPct)} belum mencapai ambang termin ${term.seq} (${percentBp(term.triggerProgressBp)}).` };
}

/** The lines of an invoice as the server added them up: DPP − uang muka − retensi + PPN = tagihan. */
export function invoiceLines(i: Pick<SalesInvoice, 'dppCents' | 'advanceDeductionCents' | 'retentionCents' | 'ppnCents' | 'totalCents'>): Array<{ label: string; cents: number }> {
  return [
    { label: 'DPP termin', cents: i.dppCents },
    { label: 'Potongan uang muka', cents: -i.advanceDeductionCents },
    { label: 'Retensi', cents: -i.retentionCents },
    { label: 'PPN', cents: i.ppnCents },
    { label: 'Jumlah tagihan', cents: i.totalCents },
  ];
}

/** What is still owed on a document after its payments. */
export function balanceAfter(totalCents: number, payments: readonly Pick<Payment, 'amountCents'>[]): number {
  return totalCents - payments.reduce((s, p) => s + p.amountCents, 0);
}

/** Unpaid, so it may be cancelled (a zero invoice is issued already settled and counts as unpaid). The server also checks the termin order. */
export function cancellable(i: Pick<SalesInvoice, 'status' | 'totalCents'>): boolean {
  return i.status === 'issued' || (i.status === 'paid' && i.totalCents === 0);
}

export interface PaymentForm { paidAt: string; amount: string; method: PaymentMethod; reference: string; note: string }
export const emptyPayment = (today: string): PaymentForm => ({ paidAt: today, amount: '', method: 'transfer', reference: '', note: '' });

export type PaymentTarget = { payableType: 'sales_invoices'; rowRef: number } | { payableType: 'vendor_invoices'; rowRef: string };

/** A payment of `target`; refused above what is still owed (the API would refuse it too). */
export function paymentBody(f: PaymentForm, target: PaymentTarget, balanceCents: number): Built<PaymentInput> {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(f.paidAt)) return fail('Tanggal bayar wajib diisi.');
  const amountCents = parseIdrCents(f.amount);
  if (amountCents === null || amountCents <= 0) return fail('Jumlah tidak terbaca (tulis mis. 1.250.000).');
  if (amountCents > balanceCents) return fail(`Jumlah ${rupiah(amountCents)} melebihi sisa ${rupiah(balanceCents)}.`);
  const reference = f.reference.trim();
  if (reference.length > 100) return fail('Referensi paling banyak 100 karakter.');
  const note = f.note.trim();
  if (note.length > 2000) return fail('Catatan paling banyak 2000 karakter.');
  return {
    ok: true,
    body: { ...target, paidAt: f.paidAt, amountCents, method: f.method, ...(reference ? { reference } : {}), ...(note ? { note } : {}) },
  };
}
