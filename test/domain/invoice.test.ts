import { describe, expect, it } from 'vitest';
import { mulDiv, ppnOf } from '../../src/domain/contract.js';
import { agingBucket, formatDocNumber, termInvoiceAmounts } from '../../src/domain/invoice.js';

/** Rp 8.150.000.000 (mockup JIAT Keerom) in cents */
const KEEROM_DPP = 8_150_000_000_00;

describe('mulDiv / ppnOf (exact beyond 2^53)', () => {
  it('stays exact where a float product would not', () => {
    // 1e12 cents (Rp 10 M-billion) × 10 000 bp = 1e16 > 2^53
    expect(mulDiv(1_000_000_000_003, 10_000, 10_000)).toBe(1_000_000_000_003);
    expect(ppnOf(100_000_000_000_01, 1100)).toBe(11_000_000_000_00); // 11 % of Rp 100 M-billion + 1 cent → .11 cent rounds down
  });
  it('rounds half away from zero, for both signs', () => {
    expect([mulDiv(5, 1, 10), mulDiv(15, 1, 10), mulDiv(-15, 1, 10), mulDiv(14, 1, 10), mulDiv(-14, 1, 10)]).toEqual([1, 2, -2, 1, -1]);
  });
  it('refuses non-integer or unsafe inputs and division by zero', () => {
    expect(() => mulDiv(1.5, 1, 1)).toThrow(RangeError);
    expect(() => mulDiv(Number.MAX_SAFE_INTEGER + 1, 1, 1)).toThrow(RangeError);
    expect(() => mulDiv(1, 1, 0)).toThrow(RangeError);
  });
});

describe('termInvoiceAmounts', () => {
  const base = { effectiveDppCents: KEEROM_DPP, ppnRateBp: 1100, retentionBp: 500, advanceCents: 1_630_000_000_00, previousDppCents: 0, previousAdvanceDeductionCents: 0, isLastTerm: false };

  it('termin 30 %: DPP, proportional advance recovery, 5 % retention, PPN on DPP − advance', () => {
    const a = termInvoiceAmounts({ ...base, termPercentBp: 3000 });
    expect(a).toEqual({
      dppCents: 2_445_000_000_00,
      advanceDeductionCents: 489_000_000_00,
      retentionCents: 122_250_000_00,
      ppnCents: 215_160_000_00, // 11 % × 1.956.000.000
      totalCents: 2_445_000_000_00 - 489_000_000_00 - 122_250_000_00 + 215_160_000_00,
    });
  });

  it('the last termin takes the rounding rest, so Σ DPP and Σ advance recovery are exact', () => {
    const thirds = [3333, 3333, 3334];
    let prevDpp = 0; let prevAdv = 0;
    const dpp = 1_000_000_01; const adv = 200_000_01;
    thirds.forEach((bp, k) => {
      const a = termInvoiceAmounts({ ...base, effectiveDppCents: dpp, advanceCents: adv, termPercentBp: bp, previousDppCents: prevDpp, previousAdvanceDeductionCents: prevAdv, isLastTerm: k === 2 });
      prevDpp += a.dppCents; prevAdv += a.advanceDeductionCents;
    });
    expect([prevDpp, prevAdv]).toEqual([dpp, adv]);
  });

  it('without advance or retention, total = DPP + PPN', () => {
    const a = termInvoiceAmounts({ ...base, advanceCents: 0, retentionBp: 0, termPercentBp: 10_000, isLastTerm: true });
    expect(a).toMatchObject({ dppCents: KEEROM_DPP, advanceDeductionCents: 0, retentionCents: 0, ppnCents: 896_500_000_00, totalCents: KEEROM_DPP + 896_500_000_00 });
  });
});

describe('agingBucket', () => {
  it('splits at 30 / 60 / 90 days inclusive', () => {
    expect([0, 30, 31, 60, 61, 90, 91, -5].map(agingBucket)).toEqual(['d0_30', 'd0_30', 'd31_60', 'd31_60', 'd61_90', 'd61_90', 'd90p', 'd0_30']);
  });
});

describe('formatDocNumber', () => {
  it('matches the mockup format, with an optional company prefix and no site', () => {
    expect(formatDocNumber({ prefix: null, docType: 'PO', siteCode: 'KRM', year: 2026, seq: 31 })).toBe('PO/KRM/2026/031');
    expect(formatDocNumber({ prefix: 'PII', docType: 'INV', siteCode: null, year: 2026, seq: 1204 })).toBe('PII/INV/2026/1204');
  });
});
