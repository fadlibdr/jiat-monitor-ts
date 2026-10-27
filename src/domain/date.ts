/**
 * Indonesian date text -> ISO "YYYY-MM-DD", or null when ambiguous/invalid.
 * Accepts DD/MM/YYYY, DD-MM-YYYY, DD.MM.YYYY, YYYY-MM-DD and "21 Juni 2026" / "21 jun 2026".
 * Two-digit years ("21/06/26") are never guessed.
 */
const MONTHS: Record<string, number> = {
  januari: 1, jan: 1, februari: 2, feb: 2, pebruari: 2, maret: 3, mar: 3,
  april: 4, apr: 4, mei: 5, juni: 6, jun: 6, juli: 7, jul: 7,
  agustus: 8, agu: 8, agt: 8, ags: 8, september: 9, sep: 9, sept: 9,
  oktober: 10, okt: 10, november: 11, nov: 11, nopember: 11,
  desember: 12, des: 12,
};

/** WIB is UTC+7 all year (no daylight saving): the calendar of every project site and of the schedules. */
export const WIB_OFFSET_MS = 7 * 3_600_000;

/** The WIB calendar date of an instant, "YYYY-MM-DD" (what "today" means for due dates and aging). */
export function wibDate(now: Date): string {
  return new Date(now.getTime() + WIB_OFFSET_MS).toISOString().slice(0, 10);
}

/** The WIB month of an instant, "YYYY-MM-01" (dashboard periods). */
export function wibMonth(now: Date): string {
  return `${wibDate(now).slice(0, 7)}-01`;
}

export function parseIndonesianDate(raw: string | null | undefined): string | null {
  if (raw == null) return null;
  const s = raw.trim().replace(/\s+/g, ' ').toLowerCase();

  let m = /^(\d{4})-(\d{1,2})-(\d{1,2})$/.exec(s);
  if (m) return make(+m[1]!, +m[2]!, +m[3]!);

  m = /^(\d{1,2})[/.\-](\d{1,2})[/.\-](\d{4})$/.exec(s);
  if (m) return make(+m[3]!, +m[2]!, +m[1]!); // day first

  m = /^(\d{1,2}) ([a-z]+)\.? (\d{4})$/.exec(s);
  if (m && MONTHS[m[2]!] !== undefined) return make(+m[3]!, MONTHS[m[2]!]!, +m[1]!);

  return null;
}

function make(y: number, mo: number, d: number): string | null {
  if (y < 2000 || y > 2100 || mo < 1 || mo > 12 || d < 1) return null;
  const dim = new Date(Date.UTC(y, mo, 0)).getUTCDate();
  if (d > dim) return null;
  return `${y}-${String(mo).padStart(2, '0')}-${String(d).padStart(2, '0')}`;
}
