/** What to show when the server answered without its own message. */
const FALLBACK: Record<number, string> = {
  401: 'Sesi berakhir. Silakan masuk lagi.',
  403: 'Anda tidak berwenang untuk tindakan ini.',
  404: 'Data tidak ditemukan.',
  429: 'Terlalu sering. Coba lagi sebentar.',
};

/** A plain-text body longer than this is not a message written for a person (a proxy error page, a stack). */
const TEXT_MESSAGE_MAX = 300;

/**
 * The message of a non-2xx answer: the JSON `message`, else the plain-text body (the API's
 * HTTPException answers are text/plain, e.g. "total tidak terbaca"), else a fixed text per status.
 * An HTML error page from a proxy in front of the API is never shown as is.
 */
export function errorMessage(status: number, contentType: string | null, text: string, json: unknown): string {
  const fromJson = (json as { message?: unknown } | null)?.message;
  if (typeof fromJson === 'string' && fromJson.trim()) return fromJson.trim();
  const plain = text.trim();
  if (json === null && plain && (contentType ?? '').toLowerCase().startsWith('text/plain') && plain.length <= TEXT_MESSAGE_MAX) return plain;
  return FALLBACK[status] ?? `Permintaan gagal (${status}).`;
}
