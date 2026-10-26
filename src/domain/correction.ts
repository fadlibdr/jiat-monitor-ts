import { normalizeCategory, type Category } from './categories.js';
import { parseIdrCents, type Cents } from './money.js';
import { parseIndonesianDate } from './date.js';

/**
 * Chat correction parser. A text is a correction only if it replies to a bot summary
 * (`isReplyToBot`) or carries a "#xxxx" row reference (last 4 hex of the row id). Anything
 * else is `null` and the group stays quiet.
 *
 * Unlike the PHP build (L3), values are parsed here with the same parsers the intake uses,
 * so "tanggal 21 Juni 2026" and "total Rp 2.450.000,-" are accepted and the rules live once.
 * A recognised command whose value cannot be parsed is returned with `error` so the bot can
 * say *why* ("total tidak terbaca"), instead of silently ignoring the message.
 */
export type Correction =
  | { command: 'kategori'; value: Category; rowRef: string | null }
  | { command: 'total'; value: Cents; rowRef: string | null }
  | { command: 'vendor'; value: string; rowRef: string | null }
  | { command: 'tanggal'; value: string; rowRef: string | null } // ISO date
  | { command: 'nomor'; value: string; rowRef: string | null }
  | { command: 'ok' | 'tolak'; value: null; rowRef: string | null }
  | { command: 'kategori' | 'total' | 'tanggal'; error: string; raw: string; rowRef: string | null };

const REF = /(?:^|\s)#([0-9a-f]{4})(?=\s|$)/i;

export function parseCorrection(text: string, isReplyToBot: boolean): Correction | null {
  let t = text.trim().replace(/\s+/g, ' ');
  if (t === '') return null;

  let rowRef: string | null = null;
  const refMatch = REF.exec(t);
  if (refMatch) {
    rowRef = refMatch[1]!.toLowerCase();
    t = t.replace(REF, ' ').trim().replace(/\s+/g, ' ');
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
    case 'vendor':
    case 'nomor':
      return { command, value: raw, rowRef };
  }
}
