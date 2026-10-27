import { mulDiv } from './contract.js';
import type { Cents } from './money.js';

/**
 * Quantities as stored in numeric(18,4) columns, handled as integers of 1/10 000 unit ("qty4") so
 * qty × price and Σ received ≤ ordered are exact. Pure.
 */
export const QTY_SCALE = 10_000;

/** "12.5" / 12.5 / "12,5" → 125_000; null for negatives, more than 4 decimals or garbage. */
export function parseQty(raw: string | number): number | null {
  const s = typeof raw === 'number' ? String(raw) : raw.trim().replace(',', '.');
  const m = /^(\d{1,14})(?:\.(\d{1,4}))?$/.exec(s);
  if (!m) return null;
  return Number(m[1]) * QTY_SCALE + Number((m[2] ?? '').padEnd(4, '0'));
}

/** 125_000 → "12.5000" (the numeric(18,4) text form). */
export function qtyToString(qty4: number): string {
  const whole = Math.trunc(qty4 / QTY_SCALE);
  return `${whole}.${String(qty4 % QTY_SCALE).padStart(4, '0')}`;
}

/** Line amount = qty × unit price, rounded half away from zero to the cent. */
export function lineAmountCents(qty4: number, unitPriceCents: Cents): Cents {
  return mulDiv(qty4, unitPriceCents, QTY_SCALE);
}

export type PoReceiptStatus = 'issued' | 'partial' | 'received';

/** Status of an issued PO from what was ordered and received per line (qty4). */
export function receiptStatus(lines: ReadonlyArray<{ ordered4: number; received4: number }>): PoReceiptStatus {
  if (lines.length === 0 || lines.every((l) => l.received4 === 0)) return 'issued';
  return lines.every((l) => l.received4 >= l.ordered4) ? 'received' : 'partial';
}
