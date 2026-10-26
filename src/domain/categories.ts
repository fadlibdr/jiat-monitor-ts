/**
 * THE category list. BOQ items, receipt intake, chat corrections and any n8n/WhatsApp
 * integration must all import from here — the PHP build had three different lists.
 *
 * Decision recorded in docs/REVIEW (L4): keep the ERP/BOQ cost taxonomy (material/upah/alat/subkon/lain)
 * as the canonical slugs; the P2X spec labels (Material/Peralatan/Transportasi/Konsumsi/Jasa/Lain-lain)
 * are mapped onto it via aliases so field staff may type either.
 */
export const CATEGORIES = ['material', 'upah', 'alat', 'subkon', 'operasional', 'lain'] as const;
export type Category = (typeof CATEGORIES)[number];

export const CATEGORY_LABEL: Record<Category, string> = {
  material: 'Material',
  upah: 'Upah / Jasa',
  alat: 'Peralatan',
  subkon: 'Subkontraktor',
  operasional: 'Operasional',
  lain: 'Lain-lain',
};

/** Lower-case aliases (incl. the P2X spec names) -> canonical slug. */
const ALIASES: Record<string, Category> = {
  material: 'material', bahan: 'material',
  upah: 'upah', jasa: 'upah', tenaga: 'upah', honor: 'upah', gaji: 'upah',
  alat: 'alat', peralatan: 'alat', 'sewa alat': 'alat', sewa: 'alat',
  subkon: 'subkon', subkontraktor: 'subkon', borong: 'subkon',
  operasional: 'operasional', transportasi: 'operasional', transport: 'operasional',
  konsumsi: 'operasional', bbm: 'operasional', atk: 'operasional',
  lain: 'lain', 'lain-lain': 'lain', lainnya: 'lain',
};

export function normalizeCategory(raw: string): Category | null {
  const key = raw.trim().toLowerCase().replace(/\s+/g, ' ');
  return ALIASES[key] ?? null;
}

export function isCategory(v: string): v is Category {
  return (CATEGORIES as readonly string[]).includes(v);
}
