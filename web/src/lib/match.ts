/**
 * '/c/:companyId/intake' against '/c/3/intake' → { companyId: '3' }; no match → null. A segment that is
 * not valid percent-encoding ('/c/%') is no match either: decodeURIComponent would throw during render
 * and take the whole app down instead of showing "Halaman tidak ditemukan".
 */
export function match(pattern: string, path: string): Record<string, string> | null {
  const ps = pattern.split('/').filter(Boolean);
  const xs = path.split('/').filter(Boolean);
  if (ps.length !== xs.length) return null;
  const out: Record<string, string> = {};
  for (let i = 0; i < ps.length; i++) {
    const p = ps[i]!;
    const x = xs[i]!;
    if (p.startsWith(':')) {
      try {
        out[p.slice(1)] = decodeURIComponent(x);
      } catch {
        return null;
      }
    } else if (p !== x) return null;
  }
  return out;
}
