import { and, asc, eq, inArray, lte, ne, sql } from 'drizzle-orm';
import { HTTPException } from 'hono/http-exception';
import { daysLeft, effectiveContract } from '../domain/contract.js';
import { agingBucket, termInvoiceAmounts, type AgingBucket } from '../domain/invoice.js';
import { BP_100 } from '../domain/contract.js';
import {
  contractAddendums, contracts, contractTerms, payments, salesInvoices, sites, vendorInvoices, PAYABLE_TYPES, PAYMENT_METHODS,
} from '../db/schema.js';
import type { Tx } from '../db/tenant.js';
import { nextDocNumber } from '../procurement/docnumber.js';
import { latestActualMicro } from '../progress/service.js';

/**
 * Invoicing (HLD §4 "Tagihan termin, invoice vendor, pembayaran"; LLD §4 POST /invoices/sales/from-term).
 * Runs inside withCompany(); amounts come from domain/invoice.ts, never from the client.
 */

const MICRO_PER_BP = 10_000; // 1 bp = 0.01 % = 10 000 micro-percent

/** Termin with whether its progress trigger is reached and whether it is already invoiced. */
export async function termsStatus(tx: Tx, contractId: number) {
  const terms = await tx.select().from(contractTerms).where(eq(contractTerms.contractId, contractId)).orderBy(asc(contractTerms.seq));
  const live = await tx.select({ termId: salesInvoices.termId, id: salesInvoices.id, number: salesInvoices.number }).from(salesInvoices)
    .where(and(eq(salesInvoices.contractId, contractId), ne(salesInvoices.status, 'cancelled')));
  const actual = await latestActualMicro(tx, contractId);
  return {
    actualMicroPct: actual,
    terms: terms.map((t) => {
      const inv = live.find((l) => l.termId === t.id);
      return { ...t, invoiceNumber: inv?.number ?? null, reached: actual >= t.triggerProgressBp * MICRO_PER_BP, invoiced: !!inv };
    }),
  };
}

/**
 * Issues the invoice of one termin. Refused when the approved progress has not reached the
 * termin's trigger, when the termin already has a live invoice, or when an earlier termin is not
 * invoiced yet (termin are billed in order, so "previous" totals are well-defined).
 */
export async function issueTermInvoice(tx: Tx, actor: { companyId: number; userId: number }, input: { contractId: number; termId: number; invoiceDate: string }) {
  const [k] = await tx.select().from(contracts).where(eq(contracts.id, input.contractId)).for('update');
  if (!k) throw new HTTPException(404, { message: 'Kontrak tidak ditemukan pada perusahaan ini.' });
  const { terms, actualMicroPct } = await termsStatus(tx, k.id);
  const term = terms.find((t) => t.id === input.termId);
  if (!term) throw new HTTPException(404, { message: 'Termin tidak ditemukan pada kontrak ini.' });
  if (term.invoiced) throw new HTTPException(409, { message: `Termin ${term.seq} sudah ditagih (${term.invoiceNumber}).` });
  const earlierOpen = terms.filter((t) => t.seq < term.seq && !t.invoiced);
  if (earlierOpen.length) throw new HTTPException(409, { message: `Termin ${earlierOpen.map((t) => t.seq).join(', ')} belum ditagih.` });
  if (!term.reached) {
    throw new HTTPException(409, { message: `Progres disetujui ${actualMicroPct / 1_000_000}% belum mencapai ambang termin ${term.seq} (${term.triggerProgressBp / 100}%).` });
  }

  const addendums = await tx.select().from(contractAddendums).where(eq(contractAddendums.contractId, k.id));
  const effective = effectiveContract(k, addendums);
  const prev = await tx.select({
    dpp: sql<string>`coalesce(sum(${salesInvoices.dppCents}), 0)`,
    adv: sql<string>`coalesce(sum(${salesInvoices.advanceDeductionCents}), 0)`,
  }).from(salesInvoices).where(and(eq(salesInvoices.contractId, k.id), ne(salesInvoices.status, 'cancelled')));
  const totalBp = terms.reduce((s, t) => s + t.percentBp, 0);
  const isLastTerm = totalBp === BP_100 && term.seq === Math.max(...terms.map((t) => t.seq));
  const amounts = termInvoiceAmounts({
    effectiveDppCents: effective.valueDppEffectiveCents, ppnRateBp: k.ppnRateBp, retentionBp: k.retentionBp, advanceCents: k.advanceCents,
    termPercentBp: term.percentBp, previousDppCents: Number(prev[0]!.dpp), previousAdvanceDeductionCents: Number(prev[0]!.adv), isLastTerm,
  });
  const [site] = await tx.select({ code: sites.code }).from(sites).where(eq(sites.id, k.siteId));
  const number = await nextDocNumber(tx, actor.companyId, 'INV', site?.code ?? null, input.invoiceDate);
  const [row] = await tx.insert(salesInvoices).values({
    companyId: actor.companyId, siteId: k.siteId, contractId: k.id, termId: term.id, number,
    invoiceDate: input.invoiceDate, dueDate: addDays(input.invoiceDate, term.dueDays), progressMicroPct: actualMicroPct, ...amounts,
  }).returning();
  return row!;
}

/** Cancels an invoice that has no payment yet (the termin can then be re-issued). */
export async function cancelSalesInvoice(tx: Tx, invoiceId: number) {
  const [inv] = await tx.select().from(salesInvoices).where(eq(salesInvoices.id, invoiceId)).for('update');
  if (!inv) throw new HTTPException(404, { message: 'Tagihan tidak ditemukan.' });
  if (inv.status !== 'issued') throw new HTTPException(409, { message: `Tagihan berstatus ${inv.status}; hanya yang belum dibayar bisa dibatalkan.` });
  const [row] = await tx.update(salesInvoices).set({ status: 'cancelled' }).where(eq(salesInvoices.id, invoiceId)).returning();
  return row!;
}

export interface PaymentInput {
  payableType: (typeof PAYABLE_TYPES)[number];
  rowRef: string | number; // sales invoice id, or vendor invoice row_id (uuid)
  paidAt: string;
  amountCents: number;
  method: (typeof PAYMENT_METHODS)[number];
  reference?: string | undefined;
  note?: string | undefined;
}

/**
 * Records money in (sales invoice) or out (confirmed vendor invoice). Σ payments may not exceed the
 * document total; a sales invoice becomes partial / paid accordingly. The document row is locked.
 */
export async function recordPayment(tx: Tx, actor: { companyId: number }, input: PaymentInput) {
  let payableId: number;
  let siteId: number;
  let totalCents: number;
  if (input.payableType === 'sales_invoices') {
    const [inv] = await tx.select().from(salesInvoices).where(eq(salesInvoices.id, Number(input.rowRef))).for('update');
    if (!inv) throw new HTTPException(404, { message: 'Tagihan tidak ditemukan.' });
    if (inv.status === 'cancelled') throw new HTTPException(409, { message: 'Tagihan sudah dibatalkan.' });
    ({ id: payableId, siteId, totalCents } = inv);
  } else {
    const [vi] = await tx.select().from(vendorInvoices).where(eq(vendorInvoices.rowId, String(input.rowRef))).for('update');
    if (!vi) throw new HTTPException(404, { message: 'Nota vendor tidak ditemukan.' });
    if (vi.status !== 'terkonfirmasi') throw new HTTPException(409, { message: 'Hanya nota vendor terkonfirmasi yang bisa dibayar.' });
    ({ id: payableId, siteId, totalCents } = vi);
  }
  const [paid] = await tx.select({ sum: sql<string>`coalesce(sum(${payments.amountCents}), 0)` }).from(payments)
    .where(and(eq(payments.payableType, input.payableType), eq(payments.payableId, payableId)));
  const after = Number(paid!.sum) + input.amountCents;
  if (after > totalCents) throw new HTTPException(409, { message: `Pembayaran melebihi sisa tagihan (sisa ${totalCents - Number(paid!.sum)} sen).` });
  const [row] = await tx.insert(payments).values({
    companyId: actor.companyId, siteId, payableType: input.payableType, payableId, paidAt: input.paidAt, amountCents: input.amountCents,
    method: input.method, reference: input.reference ?? null, note: input.note ?? null,
  }).returning();
  if (input.payableType === 'sales_invoices') {
    await tx.update(salesInvoices).set({ status: after === totalCents ? 'paid' : 'partial' }).where(eq(salesInvoices.id, payableId));
  }
  return { ...row!, balanceCents: totalCents - after };
}

/** Open balance per sales invoice, with its aging bucket (age = days since the invoice date). */
export async function receivables(tx: Tx, today: Date) {
  const invs = await tx.select().from(salesInvoices).where(inArray(salesInvoices.status, ['issued', 'partial']));
  const paid = await paidBy(tx, 'sales_invoices', invs.map((i) => i.id));
  return invs.map((i) => {
    const balanceCents = i.totalCents - (paid.get(i.id) ?? 0);
    const age = -(daysLeft(i.invoiceDate, today) ?? 0);
    return { id: i.id, number: i.number, siteId: i.siteId, contractId: i.contractId, invoiceDate: i.invoiceDate, dueDate: i.dueDate, totalCents: i.totalCents, balanceCents, ageDays: age, bucket: agingBucket(age) as AgingBucket };
  }).filter((r) => r.balanceCents > 0);
}

/** Unpaid confirmed vendor invoices; overdue when the due date has passed. */
export async function payables(tx: Tx, today: Date) {
  const iso = today.toISOString().slice(0, 10);
  const vis = await tx.select().from(vendorInvoices).where(eq(vendorInvoices.status, 'terkonfirmasi'));
  const paid = await paidBy(tx, 'vendor_invoices', vis.map((v) => v.id));
  return vis.map((v) => ({
    rowId: v.rowId, siteId: v.siteId, vendorId: v.vendorId, vendorName: v.vendorName, invoiceDate: v.invoiceDate, dueDate: v.dueDate,
    totalCents: v.totalCents, balanceCents: v.totalCents - (paid.get(v.id) ?? 0), overdue: v.dueDate !== null && v.dueDate < iso,
  })).filter((r) => r.balanceCents > 0);
}

async function paidBy(tx: Tx, type: (typeof PAYABLE_TYPES)[number], ids: number[]): Promise<Map<number, number>> {
  if (!ids.length) return new Map();
  const rows = await tx.select({ id: payments.payableId, sum: sql<string>`sum(${payments.amountCents})` }).from(payments)
    .where(and(eq(payments.payableType, type), inArray(payments.payableId, ids))).groupBy(payments.payableId);
  return new Map(rows.map((r) => [r.id, Number(r.sum)]));
}

/** Sales invoices of the company due within `days` days (alert "termin jatuh tempo"). */
export async function salesInvoicesDueWithin(tx: Tx, today: Date, days: number) {
  const limit = addDays(today.toISOString().slice(0, 10), days);
  return tx.select().from(salesInvoices).where(and(inArray(salesInvoices.status, ['issued', 'partial']), lte(salesInvoices.dueDate, limit)));
}

function addDays(iso: string, n: number): string {
  const d = new Date(`${iso}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + n);
  return d.toISOString().slice(0, 10);
}
