import { BP_100, mulDiv } from './contract.js';
import type { Cents } from './money.js';

/**
 * Termin invoice arithmetic (HLD §4 "Tagihan termin (DPP, PPN, retensi, uang muka)"). Pure.
 *
 * Rules (to be confirmed by finance — docs/remaining-work.md §5.1):
 *  - termin DPP = effective contract DPP × termin percent; the LAST termin of a complete schedule
 *    takes the rest (effective DPP − Σ earlier termin DPP), so termin DPPs add up to the contract
 *    to the cent despite rounding;
 *  - uang muka is recovered in proportion to the termin percent, the last termin taking the rest;
 *  - retensi = termin DPP × retention rate, withheld from the payment;
 *  - PPN is charged on (termin DPP − uang muka recovered): the advance was taxed when it was paid;
 *  - the last termin also takes the rest of retensi and PPN, so over the schedule they add up to the
 *    contract's (effective DPP × retention rate, and (effective DPP − uang muka) × PPN rate) exactly;
 *  - amount due = termin DPP − uang muka recovered − retensi + PPN.
 */
export interface TermInvoiceInput {
  effectiveDppCents: Cents;
  ppnRateBp: number;
  retentionBp: number;
  advanceCents: Cents;
  termPercentBp: number;
  /** totals over the termin invoices already issued for this contract */
  previousDppCents: Cents;
  previousAdvanceDeductionCents: Cents;
  previousRetentionCents: Cents;
  previousPpnCents: Cents;
  /** this is the last termin of a schedule whose percents add up to 100 % */
  isLastTerm: boolean;
}
export interface TermInvoiceAmounts {
  dppCents: Cents;
  advanceDeductionCents: Cents;
  retentionCents: Cents;
  ppnCents: Cents;
  totalCents: Cents;
}

export function termInvoiceAmounts(i: TermInvoiceInput): TermInvoiceAmounts {
  const dppCents = i.isLastTerm ? i.effectiveDppCents - i.previousDppCents : mulDiv(i.effectiveDppCents, i.termPercentBp, BP_100);
  const advanceDeductionCents = i.isLastTerm
    ? i.advanceCents - i.previousAdvanceDeductionCents
    : mulDiv(i.advanceCents, i.termPercentBp, BP_100);
  const retentionCents = i.isLastTerm
    ? mulDiv(i.effectiveDppCents, i.retentionBp, BP_100) - i.previousRetentionCents
    : mulDiv(dppCents, i.retentionBp, BP_100);
  const ppnCents = i.isLastTerm
    ? mulDiv(i.effectiveDppCents - i.advanceCents, i.ppnRateBp, BP_100) - i.previousPpnCents
    : mulDiv(dppCents - advanceDeductionCents, i.ppnRateBp, BP_100);
  return { dppCents, advanceDeductionCents, retentionCents, ppnCents, totalCents: dppCents - advanceDeductionCents - retentionCents + ppnCents };
}

export type AgingBucket = 'd0_30' | 'd31_60' | 'd61_90' | 'd90p';
export const AGING_BUCKETS: readonly AgingBucket[] = ['d0_30', 'd31_60', 'd61_90', 'd90p'];

/** HLD §7 aging 0–30 / 31–60 / 61–90 / > 90, by days since the invoice date. */
export function agingBucket(ageDays: number): AgingBucket {
  if (ageDays <= 30) return 'd0_30';
  if (ageDays <= 60) return 'd31_60';
  if (ageDays <= 90) return 'd61_90';
  return 'd90p';
}

/**
 * Document number, e.g. "PO/KRM/2026/031" (mockup) or with a company prefix "PII/PO/KRM/2026/031".
 * The sequence comes from document_sequences (one counter per company, document type and year).
 */
export function formatDocNumber(p: { prefix: string | null; docType: string; siteCode: string | null; year: number; seq: number }): string {
  const parts = [p.prefix, p.docType, p.siteCode, String(p.year), String(p.seq).padStart(3, '0')].filter((x): x is string => !!x);
  return parts.join('/');
}
