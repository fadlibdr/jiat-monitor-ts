import { normalizeCategory, type Category } from './categories.js';
import { parseIdrCents, type Cents } from './money.js';
import { parseIndonesianDate } from './date.js';
import { usableVendorName, VENDOR_NAME_MAX, VENDOR_NAME_MIN } from './vendor-name.js';

/**
 * Chat correction parser. A text is a correction only if it replies to a bot summary
 * (`isReplyToBot`) or carries a "#xxxx" row reference (last 4 hex of the row id). Anything
 * else is `null` and the group stays quiet.
 *
 * Unlike the PHP build (L3), values are parsed here with the same parsers the intake uses,
 * so "tanggal 21 Juni 2026" and "total Rp 2.450.000,-" are accepted and the rules live once.
 * A recognised command whose value cannot be parsed is returned with `error` so the bot can
 * say *why* ("total tidak terbaca"), instead of silently ignoring the message.
 *
 * "#xxxx" is a row reference only where it cannot be part of a value: as the FIRST token
 * ("#a1b2 TOTAL 2.450.000"), or as the LAST token after ok / tolak / total / tanggal / kategori
 * ("OK #a1b2", "TOTAL 2.450.000 #a1b2"). Inside a NOMOR or VENDOR value it is text: document
 * numbers like "INV #1024" or "#0012" are common on receipts.
 *
 * VENDOR and NOMOR are bounded like the review API (vendor 2–200 characters with a letter or
 * digit, nomor ≤ 100), so a value the database would refuse is answered, not retried.
 */
export type Correction =
  | { command: 'kategori'; value: Category; rowRef: string | null }
  | { command: 'total'; value: Cents; rowRef: string | null }
  | { command: 'vendor'; value: string; rowRef: string | null }
  | { command: 'tanggal'; value: string; rowRef: string | null } // ISO date
  | { command: 'nomor'; value: string; rowRef: string | null }
  | { command: 'ok' | 'tolak'; value: null; rowRef: string | null }
  | { command: 'kategori' | 'total' | 'tanggal' | 'vendor' | 'nomor'; error: string; raw: string; rowRef: string | null };

export const DOC_NUMBER_MAX = 100;

const FIRST_REF = /^#([0-9a-f]{4})(?: |$)/i;
const LAST_REF = / #([0-9a-f]{4})$/i;
/** commands after which a trailing "#xxxx" is a row reference, not part of the value */
const REF_MAY_TRAIL = /^(ok|tolak|kategori|total|tanggal)\b/i;

export function parseCorrection(text: string, isReplyToBot: boolean): Correction | null {
  let t = text.trim().replace(/\s+/g, ' ');
  if (t === '') return null;

  let rowRef: string | null = null;
  const first = FIRST_REF.exec(t);
  if (first) {
    rowRef = first[1]!.toLowerCase();
    t = t.slice(first[0].length).trim();
  } else if (REF_MAY_TRAIL.test(t)) {
    const last = LAST_REF.exec(t);
    if (last) {
      rowRef = last[1]!.toLowerCase();
      t = t.slice(0, last.index).trim();
    }
  }
  if (!isReplyToBot && rowRef === null) return null;

  const lower = t.toLowerCase();
  if (lower === 'ok') return { command: 'ok', value: null, rowRef };
  if (lower === 'tolak') return { command: 'tolak', value: null, rowRef };

  const m = /^(kategori|total|vendor|tanggal|nomor) (.+)$/i.exec(t);
  if (!m) return null;
  const command = m[1]!.toLowerCase() as 'kategori' | 'total' | 'vendor' | 'tanggal' | 'nomor';
  const raw = m[2]!.trim();

  switch (command) {
    case 'kategori': {
      const value = normalizeCategory(raw);
      return value ? { command, value, rowRef } : { command, error: 'kategori tidak dikenal', raw, rowRef };
    }
    case 'total': {
      const value = parseIdrCents(raw);
      return value !== null && value > 0
        ? { command, value, rowRef }
        : { command, error: 'total tidak terbaca', raw, rowRef };
    }
    case 'tanggal': {
      const value = parseIndonesianDate(raw);
      return value ? { command, value, rowRef } : { command, error: 'tanggal tidak terbaca', raw, rowRef };
    }
    case 'vendor': {
      const value = usableVendorName(raw);
      return value ? { command, value, rowRef } : { command, error: `nama vendor harus ${VENDOR_NAME_MIN}–${VENDOR_NAME_MAX} karakter`, raw, rowRef };
    }
    case 'nomor':
      return raw.length <= DOC_NUMBER_MAX ? { command, value: raw, rowRef } : { command, error: `nomor maksimal ${DOC_NUMBER_MAX} karakter`, raw, rowRef };
  }
}
