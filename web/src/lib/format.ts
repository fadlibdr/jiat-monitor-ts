/**
 * Indonesian number, money and date formatting for the UI. Pure functions with no Intl dependency, so
 * every browser and the test runner print the same text. Money arrives from the API as integer cents,
 * progress as micro-percent (100% = 100_000_000), ratios as basis points (100% = 10_000).
 */

const MINUS = '−';
const MONTHS_SHORT = ['Jan', 'Feb', 'Mar', 'Apr', 'Mei', 'Jun', 'Jul', 'Agu', 'Sep', 'Okt', 'Nov', 'Des'] as const;
const MONTHS_LONG = ['Januari', 'Februari', 'Maret', 'April', 'Mei', 'Juni', 'Juli', 'Agustus', 'September', 'Oktober', 'November', 'Desember'] as const;
/** WIB, UTC+7 all year (no daylight saving): the zone of every project and of the server's schedules */
const WIB_OFFSET_MS = 7 * 60 * 60 * 1000;

const MILIAR = 1_000_000_000;
const JUTA = 1_000_000;
const MICRO_PER_PERCENT = 1_000_000;
const BP_PER_PERCENT = 100;

/** 1234567 → "1.234.567" */
export function groupThousands(n: number): string {
  const sign = n < 0 ? MINUS : '';
  return sign + Math.trunc(Math.abs(n)).toString().replace(/\B(?=(\d{3})+(?!\d))/g, '.');
}

/** One decimal with a decimal comma: 41.25 → "41,3"; a whole number keeps its ",0". */
function oneDecimal(x: number): string {
  const rounded = Math.round(Math.abs(x) * 10) / 10;
  return (x < 0 && rounded !== 0 ? MINUS : '') + rounded.toFixed(1).replace('.', ',');
}

/** Full amount: 642_000_000_000 cents → "Rp 6.420.000.000"; cents shown only when there are any. */
export function rupiah(cents: number): string {
  const sign = cents < 0 ? MINUS : '';
  const abs = Math.abs(cents);
  const whole = groupThousands(Math.trunc(abs / 100));
  const rest = abs % 100;
  return `${sign}Rp ${whole}${rest ? `,${String(rest).padStart(2, '0')}` : ''}`;
}

/** Amount without the currency, as typed in a form: 245_000_000 cents → "2.450.000"; 12_345 → "123,45". */
export function amountPlain(cents: number): string {
  return rupiah(cents).replace('Rp ', '');
}

/** Short amount for cards: "Rp 48,6 M" (miliar), "Rp 410 jt" (juta), smaller amounts in full. */
export function rupiahShort(cents: number, opts: { signed?: boolean } = {}): string {
  const sign = cents < 0 ? MINUS : opts.signed && cents > 0 ? '+' : '';
  const rp = Math.abs(cents) / 100;
  // 999,5 juta rounds to 1.000 jt: print it as miliar instead
  if (rp >= MILIAR || Math.round(rp / JUTA) >= 1_000) return `${sign}Rp ${oneDecimal(rp / MILIAR)} M`;
  if (rp >= JUTA) return `${sign}Rp ${groupThousands(Math.round(rp / JUTA))} jt`;
  return sign + rupiah(Math.abs(cents));
}

/** Amount in miliar without the currency, for "masuk 4,1 · keluar 2,5". */
export function miliar(cents: number): string {
  return oneDecimal(cents / 100 / MILIAR);
}

/** micro-percent → "41,2%"; null → "—" */
export function percentMicro(micro: number | null | undefined): string {
  return micro === null || micro === undefined ? '—' : `${oneDecimal(micro / MICRO_PER_PERCENT)}%`;
}

/** basis points → "39,9%"; null → "—" */
export function percentBp(bp: number | null | undefined): string {
  return bp === null || bp === undefined ? '—' : `${oneDecimal(bp / BP_PER_PERCENT)}%`;
}

/** deviation in micro-percent → signed points "−4,8" / "+1,0" / "0,0" */
export function points(micro: number | null | undefined): string {
  if (micro === null || micro === undefined) return '—';
  const s = oneDecimal(micro / MICRO_PER_PERCENT);
  return micro > 0 && s !== '0,0' ? `+${s}` : s;
}

/** "2026-10-01" → "Okt 2026" */
export function monthLabel(period: string): string {
  const m = /^(\d{4})-(\d{2})/.exec(period);
  const name = m ? MONTHS_SHORT[Number(m[2]) - 1] : undefined;
  return m && name ? `${name} ${m[1]}` : period;
}

/** "2026-10-01" → "Oktober 2026" */
export function monthLong(period: string): string {
  const m = /^(\d{4})-(\d{2})/.exec(period);
  const name = m ? MONTHS_LONG[Number(m[2]) - 1] : undefined;
  return m && name ? `${name} ${m[1]}` : period;
}

/** "2026-10-01" → "Okt" */
export function monthShort(period: string): string {
  const m = /^\d{4}-(\d{2})/.exec(period);
  return (m && MONTHS_SHORT[Number(m[1]) - 1]) ?? period;
}

/** "2026-10-01" / "2026-10" → months since year 0 (a time axis position); null if not a month. */
export function monthIndex(period: string): number | null {
  const m = /^(\d{4})-(\d{2})/.exec(period);
  if (!m) return null;
  const month = Number(m[2]);
  return month >= 1 && month <= 12 ? Number(m[1]) * 12 + month - 1 : null;
}

/** The inverse of monthIndex: → "2026-10-01". */
export function periodOfIndex(index: number): string {
  return `${String(Math.floor(index / 12)).padStart(4, '0')}-${String((index % 12) + 1).padStart(2, '0')}-01`;
}

/** A calendar date "2026-10-27" → "27 Okt 2026" (no time zone involved). */
export function dateLabel(iso: string | null | undefined): string {
  if (!iso) return '—';
  const m = /^(\d{4})-(\d{2})-(\d{2})/.exec(iso);
  const name = m ? MONTHS_SHORT[Number(m[2]) - 1] : undefined;
  return m && name ? `${Number(m[3])} ${name} ${m[1]}` : iso;
}

/** An instant → "26 Okt 2026 · 17:15" in WIB. */
export function instantLabel(at: string | Date | null | undefined): string {
  if (!at) return '—';
  const ms = (typeof at === 'string' ? new Date(at) : at).getTime();
  if (Number.isNaN(ms)) return '—';
  const d = new Date(ms + WIB_OFFSET_MS);
  const hh = String(d.getUTCHours()).padStart(2, '0');
  const mm = String(d.getUTCMinutes()).padStart(2, '0');
  return `${d.getUTCDate()} ${MONTHS_SHORT[d.getUTCMonth()]} ${d.getUTCFullYear()} · ${hh}:${mm}`;
}

/** The current month in WIB as "YYYY-MM" (the value of an <input type="month">). */
export function currentMonthWib(now: Date = new Date()): string {
  return new Date(now.getTime() + WIB_OFFSET_MS).toISOString().slice(0, 7);
}

/** 220 → "3 j 40 m"; 45 → "45 m"; null → "—" */
export function minutesLabel(min: number | null | undefined): string {
  if (min === null || min === undefined) return '—';
  const total = Math.round(min);
  const h = Math.floor(total / 60);
  const m = total % 60;
  if (h === 0) return `${m} m`;
  return m === 0 ? `${h} j` : `${h} j ${m} m`;
}

/** Public short reference of an intake row, as used in chat: last 4 hex of the uuid ("#3f2a"). */
export function shortRef(rowId: string): string {
  return `#${rowId.replace(/-/g, '').slice(-4).toLowerCase()}`;
}
