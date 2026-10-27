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

/** "Upah/Jasa", "upah /  jasa" → "upah / jasa": the same key whatever the spacing around "/" */
const keyOf = (raw: string) => raw.trim().toLowerCase().replace(/\s*\/\s*/g, ' / ').replace(/\s+/g, ' ');
// every label the bot shows (summary reply) must be accepted back by KATEGORI
for (const [slug, label] of Object.entries(CATEGORY_LABEL) as Array<[Category, string]>) ALIASES[keyOf(label)] ??= slug;

export function normalizeCategory(raw: string): Category | null {
  return ALIASES[keyOf(raw)] ?? null;
}

export function isCategory(v: string): v is Category {
  return (CATEGORIES as readonly string[]).includes(v);
}

/**
 * Keywords for the intake fallback (LLD §6: vendor.default_category → keyword → null). Whole words
 * only (`\bsemen\b`, not substring), so "semennya" or "pasirwangi" do not match by accident.
 */
const KEYWORDS: Record<Category, readonly string[]> = {
  material: ['semen', 'pasir', 'batu', 'kerikil', 'split', 'besi', 'beton', 'pipa', 'kabel', 'paku', 'kawat', 'bata', 'kayu', 'triplek', 'cat', 'seng', 'baut', 'casing', 'readymix'],
  upah: ['upah', 'tukang', 'mandor', 'harian', 'ongkos kerja', 'jasa'],
  alat: ['sewa alat', 'sewa', 'rental', 'excavator', 'ekskavator', 'molen', 'stamper', 'genset', 'crane'],
  subkon: ['borongan', 'subkon', 'subkontraktor'],
  operasional: ['bbm', 'solar', 'bensin', 'pertalite', 'pertamax', 'transport', 'ongkir', 'makan', 'konsumsi', 'atk', 'pulsa'],
  lain: [],
};
const KEYWORD_RE: Array<[Category, RegExp]> = (Object.entries(KEYWORDS) as Array<[Category, readonly string[]]>)
  .filter(([, words]) => words.length)
  .map(([cat, words]) => [cat, new RegExp(`\\b(?:${words.map((w) => w.replace(/\s+/g, '\\s+')).join('|')})\\b`, 'i')]);

/**
 * Category from a receipt description, or null when nothing matches or two categories match
 * (ambiguous → the bot asks instead of guessing).
 */
export function categoryFromDescription(description: string | null | undefined): Category | null {
  if (!description) return null;
  const hits = KEYWORD_RE.filter(([, re]) => re.test(description)).map(([cat]) => cat);
  return hits.length === 1 ? hits[0]! : null;
}
