import { decimalStringToCents, parseIdrCents } from '../../../src/domain/money.js';

/**
 * Form input → API values. Rupiah amounts go through the server's own parser (src/domain/money.ts has
 * no dependencies), so what a form accepts is exactly what the API would accept: "8.150.000.000",
 * "Rp 2.450.000,-" and "2,5" are read; ambiguous "245.50" is refused rather than guessed.
 */
export { parseIdrCents };

/** The API's decimal money strings ("207600050.00", BOQ import summary) → cents; not a decimal → null. */
export function decimalCents(s: string): number | null {
  try {
    return decimalStringToCents(s);
  } catch {
    return null; // not a plain decimal: the caller shows the text as it came
  }
}

const MINUS = /^[-−]\s*/;

/** "-1.000.000" / "−Rp 1.000.000" / "1.000.000" → signed cents (an addendum can reduce the value); unreadable → null */
export function parseSignedRupiah(raw: string): number | null {
  const s = raw.trim();
  const negative = MINUS.test(s);
  const cents = parseIdrCents(s.replace(MINUS, ''));
  if (cents === null) return null;
  return negative ? -cents : cents;
}

/** "5" / "5,5" / "2.25" → basis points (550); outside 0–100 % or more than two decimals → null */
export function parsePercentBp(raw: string): number | null {
  const m = /^(\d{1,3})(?:[.,](\d{1,2}))?\s*%?$/.exec(raw.trim());
  if (!m) return null;
  const bp = Number(m[1]) * 100 + Number((m[2] ?? '').padEnd(2, '0'));
  return bp <= 10_000 ? bp : null;
}

/** 550 → "5,5"; 1100 → "11"; 1025 → "10,25" (what parsePercentBp reads back) */
export function bpInput(bp: number): string {
  const whole = Math.trunc(bp / 100);
  const frac = String(bp % 100).padStart(2, '0').replace(/0+$/, '');
  return frac ? `${whole},${frac}` : String(whole);
}

/** A non-negative whole number of days ("30"); empty → null; anything else → undefined (invalid) */
export function parseDays(raw: string, max = 365): number | null | undefined {
  const s = raw.trim();
  if (!s) return null;
  if (!/^\d{1,3}$/.test(s)) return undefined;
  const n = Number(s);
  return n <= max ? n : undefined;
}

/**
 * The text fields of a form that differ from the stored row ('' and null count as the same).
 * An emptied field is sent as null when the API can clear it (`clearable`), else not sent at all.
 */
export function changedText<K extends string>(
  stored: Partial<Record<K, string | null>>, form: Record<K, string>, keys: readonly K[], clearable: readonly K[] = [],
): Partial<Record<K, string | null>> {
  const out: Partial<Record<K, string | null>> = {};
  for (const k of keys) {
    const now = form[k].trim();
    if (now === (stored[k] ?? '')) continue;
    if (now) out[k] = now;
    else if (clearable.includes(k)) out[k] = null;
  }
  return out;
}
