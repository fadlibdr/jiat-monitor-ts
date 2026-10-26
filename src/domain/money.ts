/**
 * Rupiah text -> integer cents, or null when ambiguous. The system never guesses a number.
 *
 * Accepted:
 *   "2450000"            -> 245000000
 *   "Rp 2.450.000"       -> 245000000   (dot thousands)
 *   "2,450,000"          -> 245000000   (comma thousands)
 *   "Rp 2.450.000,00"    -> 245000000   (dot thousands, comma decimals)
 *   "1,234,567.89"       -> 123456789   (comma thousands, dot decimals)
 *   "2.450.000,-"        -> 245000000   (",-" / ".-" = "no cents", common on Indonesian nota)   [fix B4]
 *   "12,50"              -> 1250        (single comma + 2 digits = decimal)
 *   "2,5"                -> 250         (single comma + 1 digit = decimal; Indonesian decimal mark) [fix L2]
 * Ambiguous -> null:
 *   "245.50", "12.5"     (dot + 1–2 digits: thousands or decimal? not decidable in Indonesian text)
 *   "1.234.56"           (broken grouping)
 */
export type Cents = number;

const STRIP_CURRENCY = /(rp\.?|idr)/gi;
const STRIP_SPACE = /[\s ]+/g;
const TRAILING_DASH = /[.,]-$/; // "2.450.000,-"
const SHAPE = /^\d[\d.,]*$/;

export function parseIdrCents(raw: string | null | undefined): Cents | null {
  if (raw == null) return null;
  let s = raw.replace(STRIP_CURRENCY, '').replace(STRIP_SPACE, '');
  const noCents = TRAILING_DASH.test(s);
  if (noCents) s = s.replace(TRAILING_DASH, '');
  if (s === '' || !SHAPE.test(s)) return null;

  const dots = count(s, '.');
  const commas = count(s, ',');

  if (dots > 0 && commas > 0) {
    if (noCents) return null;
    const last = Math.max(s.lastIndexOf('.'), s.lastIndexOf(','));
    const sep = s[last] as '.' | ',';
    const other = sep === '.' ? ',' : '.';
    const tail = s.slice(last + 1);
    const head = s.slice(0, last);
    if (tail.length === 2 && count(s, sep) === 1 && groupsOk(head, other)) {
      return toCents(head.split(other).join(''), tail);
    }
    return null;
  }

  if (dots > 0 || commas > 0) {
    const sep = dots > 0 ? '.' : ',';
    const n = Math.max(dots, commas);
    const last = s.lastIndexOf(sep);
    const tail = s.slice(last + 1);
    const head = s.slice(0, last);
    if (n === 1 && tail.length <= 2) {
      if (sep === ',' && !noCents && /^\d+$/.test(head)) return toCents(head, tail.padEnd(2, '0'));
      return null; // "245.50" / "12.5": not decidable
    }
    if (groupsOk(s, sep)) return toCents(s.split(sep).join(''), '00');
    return null;
  }

  return toCents(s, '00');
}

/** "2.450.000": first group 1–3 digits, every other group exactly 3. */
function groupsOk(s: string, sep: string): boolean {
  const parts = s.split(sep);
  const first = parts[0] ?? '';
  if (first.length < 1 || first.length > 3) return false;
  return parts.slice(1).every((p) => /^\d{3}$/.test(p));
}

function toCents(intPart: string, dec: string): Cents | null {
  const v = Number(intPart) * 100 + Number(dec);
  return Number.isSafeInteger(v) ? v : null;
}

function count(s: string, ch: string): number {
  let n = 0;
  for (const c of s) if (c === ch) n++;
  return n;
}

/** Cents -> "2450000.00" (DB/API string, never float). */
export function centsToDecimalString(cents: Cents): string {
  const sign = cents < 0 ? '-' : '';
  const c = Math.abs(cents);
  return `${sign}${Math.trunc(c / 100)}.${String(c % 100).padStart(2, '0')}`;
}

/** "2450000.00" (numeric string from DB) -> cents. Rejects anything that is not a plain decimal. */
export function decimalStringToCents(s: string): Cents {
  const m = /^(-?)(\d+)(?:\.(\d{1,2}))?$/.exec(s.trim());
  if (!m) throw new TypeError(`Bukan angka desimal: "${s}"`);
  const v = Number(m[2]) * 100 + Number((m[3] ?? '').padEnd(2, '0'));
  return m[1] === '-' ? -v : v;
}

/** Cents -> "Rp 2.450.000,00" for chat replies. */
export function formatRupiah(cents: Cents): string {
  const sign = cents < 0 ? '-' : '';
  const c = Math.abs(cents);
  const int = Math.trunc(c / 100).toString().replace(/\B(?=(\d{3})+(?!\d))/g, '.');
  return `${sign}Rp ${int},${String(c % 100).padStart(2, '0')}`;
}
