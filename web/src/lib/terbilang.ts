/**
 * An amount in Indonesian words ("terbilang"), as printed under the total of an invoice or a PO:
 * 2_591_700_000 rupiah → "Dua miliar lima ratus sembilan puluh satu juta tujuh ratus ribu rupiah".
 * Exact for every safe integer of cents (the API never sends more).
 */
const ONES = ['', 'satu', 'dua', 'tiga', 'empat', 'lima', 'enam', 'tujuh', 'delapan', 'sembilan', 'sepuluh', 'sebelas'];
const SCALES = ['', 'ribu', 'juta', 'miliar', 'triliun', 'kuadriliun'];

function belowThousand(n: number): string {
  if (n < 12) return ONES[n]!;
  if (n < 20) return `${ONES[n - 10]} belas`;
  if (n < 100) return `${ONES[Math.floor(n / 10)]} puluh${n % 10 ? ` ${ONES[n % 10]}` : ''}`;
  const rest = n % 100;
  const hundreds = Math.floor(n / 100) === 1 ? 'seratus' : `${ONES[Math.floor(n / 100)]} ratus`;
  return rest ? `${hundreds} ${belowThousand(rest)}` : hundreds;
}

/** 1_100 → "seribu seratus"; 0 → "nol" (a whole, non-negative number) */
export function numberWords(n: number): string {
  if (!Number.isSafeInteger(n) || n < 0) throw new RangeError(`terbilang: ${n}`);
  if (n === 0) return 'nol';
  const parts: string[] = [];
  for (let scale = 0, rest = n; rest > 0; scale++, rest = Math.floor(rest / 1000)) {
    const group = rest % 1000;
    if (group === 0) continue;
    // "seribu", never "satu ribu" — but "satu juta", "satu miliar"
    parts.unshift(scale === 1 && group === 1 ? 'seribu' : `${belowThousand(group)}${SCALES[scale] ? ` ${SCALES[scale]}` : ''}`);
  }
  return parts.join(' ');
}

/** cents → "Dua juta rupiah" / "Seratus rupiah lima puluh sen"; a negative amount is "minus …" */
export function terbilangRupiah(cents: number): string {
  const abs = Math.abs(cents);
  const sen = abs % 100;
  const text = `${cents < 0 ? 'minus ' : ''}${numberWords(Math.floor(abs / 100))} rupiah${sen ? ` ${numberWords(sen)} sen` : ''}`;
  return text.charAt(0).toUpperCase() + text.slice(1);
}
