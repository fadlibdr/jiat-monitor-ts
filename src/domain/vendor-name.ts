/**
 * Vendor names, wherever they come from (OCR, a chat VENDOR correction, the review screen, the
 * vendor master). One rule for what is usable, and one scrubber for what must never be echoed.
 */
export const VENDOR_NAME_MIN = 2;
export const VENDOR_NAME_MAX = 200;

/** Trimmed, whitespace-collapsed name if usable (2–200 characters with a letter or digit), else null. */
export function usableVendorName(raw: string | null | undefined): string | null {
  const s = (raw ?? '').trim().replace(/\s+/g, ' ');
  return s.length >= VENDOR_NAME_MIN && s.length <= VENDOR_NAME_MAX && /[\p{L}\p{N}]/u.test(s) ? s : null;
}

/** Where the shop's tax id or bank details start on a receipt header: "NPWP …", "No. Rek …", "Rek. BCA …", "a.n. …", "a/n …". */
const PII_START = /(?:\bnpwp\b|\bno\.?\s*rek|\brek(?:ening)?\b\.?|\ba\s*\/\s*n\b|\ba\.n\.?(?=\s|$))/i;
/** a run of digits with . - or spaces inside: an account, NPWP or phone number once it has 8+ digits */
const NUMBER_RUN = /\d[\d.\-\s]*\d/g;

/**
 * OCR'd vendor text without what HLD §8 / UU 27/2022 keep out of group replies: everything from
 * an "NPWP" / "Rek." / "a.n." marker on, and any number of 8 or more digits. Receipts often print
 * these on the line under the shop name, which OCR may read as part of the name.
 */
export function scrubVendorName(raw: string | null | undefined): string | null {
  if (!raw) return null;
  let s = raw;
  const marker = PII_START.exec(s);
  if (marker) s = s.slice(0, marker.index);
  s = s.replace(NUMBER_RUN, (run) => (run.replace(/\D/g, '').length >= 8 ? ' ' : run));
  s = s.replace(/\s+/g, ' ').replace(/[\s,;:|/–-]+$/u, '').trim();
  return s || null;
}
