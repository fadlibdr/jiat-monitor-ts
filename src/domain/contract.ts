import type { Cents } from './money.js';

/**
 * Contract arithmetic shared by the API, the BOQ importer and (later) invoicing. Pure.
 *
 * Units: money in integer cents, rates and percents in basis points (10_000 = 100 %).
 */
export const BP_100 = 10_000;

export interface ContractBase {
  valueDppCents: Cents;
  ppnRateBp: number;
  endDate: string | null;
}
export interface AddendumLike {
  signedAt: string;
  valueDeltaCents: Cents;
  endDateNew: string | null;
}
export interface EffectiveContract {
  /** original DPP + Σ addendum deltas */
  valueDppEffectiveCents: Cents;
  addendumDeltaCents: Cents;
  /** effective DPP + PPN (L8: derived, never stored) */
  valueTotalCents: Cents;
  /** end date of the latest addendum that moved it, else the original */
  endDateEffective: string | null;
}

/** PPN on a DPP, rounded half away from zero to the cent. */
export function ppnOf(dppCents: Cents, ppnRateBp: number): Cents {
  return mulDiv(dppCents, ppnRateBp, BP_100);
}

/** An amount or quantity outside what can be computed exactly (beyond 2^53): the input, not the server, is wrong (→ 400). */
export class AmountOutOfRange extends RangeError {
  override readonly name = 'AmountOutOfRange';
}

const SAFE_MAX = BigInt(Number.MAX_SAFE_INTEGER);

/**
 * a × b / d rounded half away from zero, exact for any safe-integer inputs. Money × basis points
 * leaves the safe range quickly (Rp 10 M-billion DPP = 1e12 cents × 10 000 bp > 2^53), so the
 * product is taken in BigInt. A result that is not a safe integer is refused, never rounded.
 */
export function mulDiv(a: number, b: number, d: number): number {
  if (!Number.isSafeInteger(a) || !Number.isSafeInteger(b) || !Number.isSafeInteger(d) || d === 0) {
    throw new AmountOutOfRange(`mulDiv: argumen tidak valid (${a}, ${b}, ${d})`);
  }
  const p = BigInt(a) * BigInt(b);
  const D = BigInt(d);
  let q = p / D;
  const r = p % D;
  const twice = (r < 0n ? -r : r) * 2n;
  if (twice >= (D < 0n ? -D : D)) q += (p < 0n) !== (D < 0n) ? -1n : 1n;
  if (q > SAFE_MAX || q < -SAFE_MAX) throw new AmountOutOfRange(`mulDiv: hasil di luar batas (${a} × ${b} / ${d})`);
  return Number(q);
}

export function effectiveContract(k: ContractBase, addendums: readonly AddendumLike[]): EffectiveContract {
  const addendumDeltaCents = addendums.reduce((s, a) => s + a.valueDeltaCents, 0);
  const valueDppEffectiveCents = k.valueDppCents + addendumDeltaCents;
  let endDateEffective = k.endDate;
  // order by signing date; a later addendum without a new end date leaves the previous one in force
  for (const a of [...addendums].sort((x, y) => x.signedAt.localeCompare(y.signedAt))) {
    if (a.endDateNew) endDateEffective = a.endDateNew;
  }
  return {
    valueDppEffectiveCents,
    addendumDeltaCents,
    valueTotalCents: valueDppEffectiveCents + ppnOf(valueDppEffectiveCents, k.ppnRateBp),
    endDateEffective,
  };
}

/** Whole days from `today` to `endDate` (negative when overdue); null without an end date. */
export function daysLeft(endDate: string | null, today: Date): number | null {
  if (!endDate) return null;
  const end = Date.UTC(+endDate.slice(0, 4), +endDate.slice(5, 7) - 1, +endDate.slice(8, 10));
  const t = Date.UTC(today.getUTCFullYear(), today.getUTCMonth(), today.getUTCDate());
  return Math.round((end - t) / 86_400_000);
}

export interface TermInput {
  seq: number;
  name: string;
  percentBp: number;
  triggerProgressBp: number;
  dueDays: number;
}

/**
 * Termin schedule rules. Returns human-readable problems (empty = valid).
 * Σ percent may be below 100 % while the schedule is being drafted (`complete` tells which),
 * but never above; triggers must not decrease with seq, so termin N+1 never unlocks before N.
 */
export function validateTerms(terms: readonly TermInput[]): { errors: string[]; complete: boolean; totalBp: number } {
  const errors: string[] = [];
  const seqs = new Set<number>();
  for (const t of terms) {
    if (seqs.has(t.seq)) errors.push(`seq ${t.seq} ganda`);
    seqs.add(t.seq);
  }
  const sorted = [...terms].sort((a, b) => a.seq - b.seq);
  for (let i = 1; i < sorted.length; i++) {
    if (sorted[i]!.triggerProgressBp < sorted[i - 1]!.triggerProgressBp) {
      errors.push(`ambang progres termin ${sorted[i]!.seq} lebih kecil dari termin ${sorted[i - 1]!.seq}`);
    }
  }
  const totalBp = terms.reduce((s, t) => s + t.percentBp, 0);
  if (totalBp > BP_100) errors.push(`jumlah persen termin ${formatBp(totalBp)} melebihi 100%`);
  return { errors, complete: totalBp === BP_100, totalBp };
}

export function formatBp(bp: number): string {
  return `${(bp / 100).toFixed(2).replace(/\.?0+$/, '')}%`;
}

/** a / b rounded half away from zero, exact on integers within 2^53. */
export function roundDiv(a: number, b: number): number {
  const q = Math.trunc(a / b);
  const r = a - q * b;
  if (Math.abs(r) * 2 >= Math.abs(b)) return q + Math.sign(a) * Math.sign(b);
  return q;
}
