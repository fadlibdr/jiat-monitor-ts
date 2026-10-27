import { z } from 'zod';
import { parseIndonesianDate } from './date.js';
import { parseIdrCents, type Cents } from './money.js';

/**
 * Validation rules V1–V7 on the two OCR stage outputs. Pure: V8–V10 (sha256, pHash window,
 * vendor trigram) need the database and live in the intake job.
 *
 * Output contract (resolves the mismatch recorded in docs/remaining-work.md §5.10): we accept both
 * the LLD §6 shape and the text-only shape the prompts ask for —
 *   - stage 1 doc_type: nota | faktur | kwitansi | bukti_transfer | invoice | bukan_dokumen; anything
 *     else is treated as bukan_dokumen (the model broke the contract: ask for a new photo)
 *   - stage 2 values: printed text ("Rp 2.450.000,-", parsed by the shared MoneyParser) or JSON
 *     numbers in rupiah (2450000); `doc_number` or `invoice_number`
 *   - line items: {desc|description, qty?, unit?, price?, amount} with text or number amounts
 * A payload that does not fit this at all still throws ZodError; the intake job maps that to
 * `tidak_terbaca`, never to empty fields (LLD §6).
 */
const DOC_TYPES = ['nota', 'faktur', 'kwitansi', 'bukti_transfer', 'invoice', 'bukan_dokumen'] as const;
export const Stage1 = z.object({
  doc_type: z.string().nullable().default('bukan_dokumen')
    .transform((v) => ((DOC_TYPES as readonly string[]).includes(v ?? '') ? (v as (typeof DOC_TYPES)[number]) : 'bukan_dokumen')),
  quality: z.number().min(0).max(1).nullable().default(null),
});
export type Stage1 = z.infer<typeof Stage1>;

const Value = z.union([z.string(), z.number()]).nullable();
const Field = z.object({ value: Value.default(null), confidence: z.number().min(0).max(1).default(0) });
const LineItem = z.object({
  description: z.string().optional(),
  desc: z.string().optional(),
  qty: z.union([z.string(), z.number()]).nullable().optional(),
  unit: z.string().nullable().optional(),
  price: z.union([z.string(), z.number()]).nullable().optional(),
  amount: Value.default(null),
}).transform((it) => ({ description: it.description ?? it.desc ?? '', amount: it.amount }));
export const Stage2 = z.object({
  vendor_name: Field.optional(),
  doc_number: Field.optional(),
  invoice_number: Field.optional(),
  invoice_date: Field.optional(),
  description: Field.optional(),
  subtotal: Field.optional(),
  ppn: Field.optional(),
  total: Field.optional(),
  npwp: Field.optional(),
  bank_account: Field.optional(), // read so it can be dropped explicitly: never stored, never replied
  line_items: z.array(LineItem).default([]),
});
export type Stage2 = z.infer<typeof Stage2>;

export type Flag = 'field_kosong' | 'arith_items' | 'arith_ppn' | 'npwp_format' | 'date_range' | 'total_nol';

/** What a receipt says, normalised. Deliberately has no bank account. */
export interface ReceiptFields {
  vendorName: string | null;
  docNumber: string | null;
  invoiceDate: string | null; // ISO
  description: string | null;
  subtotalCents: Cents | null;
  ppnCents: Cents | null;
  totalCents: Cents;
  /** Σ line item amounts, null when there are none or one is unreadable */
  itemsCents: Cents | null;
  /** per-field OCR confidence */
  confidence: Record<string, number>;
}

export type ValidationResult =
  | { decision: 'reject'; outcome: 'tidak_terbaca'; message: string }
  | {
      decision: 'accept';
      status: 'perlu_konfirmasi' | 'perlu_cek';
      flags: Flag[];
      totalCents: Cents;
      npwp: string | null; // digits only, null if V6 failed
      missing: string[];
      fields: ReceiptFields;
    };

export interface ValidatorOptions {
  qualityMin?: number; // V1
  totalConfidenceMin?: number; // V2
  arithToleranceCents?: number; // V4/V5 absolute tolerance
  arithTolerancePct?: number; // V4 relative tolerance
}

export const DEFAULT_TOLERANCE_CENTS = 100_000; // Rp 1.000 (LLD §6)

/** V1 alone, so the intake job can stop before paying for stage 2. */
export function checkStage1(stage1In: unknown, opt: ValidatorOptions = {}): { ok: true; stage1: Stage1 } | { ok: false; message: string } {
  const s1 = Stage1.parse(stage1In);
  if (s1.doc_type === 'bukan_dokumen' || (s1.quality ?? 0) < (opt.qualityMin ?? 0.45)) {
    return { ok: false, message: 'Foto kurang jelas atau bukan nota. Mohon kirim ulang foto yang lebih jelas.' };
  }
  return { ok: true, stage1: s1 };
}

/** Rupiah from OCR: printed text through the shared MoneyParser, or a JSON number of rupiah. */
export function moneyCents(v: string | number | null | undefined): Cents | null {
  if (v == null) return null;
  if (typeof v === 'number') return Number.isFinite(v) && v >= 0 ? Math.round(v * 100) : null;
  return parseIdrCents(v);
}

export function validateReceipt(
  stage1In: unknown,
  stage2In: unknown,
  siteStart: Date | null,
  today: Date,
  opt: ValidatorOptions = {},
): ValidationResult {
  const totalConfidenceMin = opt.totalConfidenceMin ?? 0.7;
  const tolCents = opt.arithToleranceCents ?? DEFAULT_TOLERANCE_CENTS;
  const tolPct = opt.arithTolerancePct ?? 0.005;

  // V1 — document type & image quality
  const s1 = checkStage1(stage1In, opt);
  const s2 = Stage2.parse(stage2In);
  if (!s1.ok) return reject(s1.message);

  // V2 — total present, confident, and > 0 (the PHP build let "0" through: L5)
  const totalCents = moneyCents(s2.total?.value);
  if (totalCents === null || totalCents <= 0 || (s2.total?.confidence ?? 0) < totalConfidenceMin) {
    return reject('Total tidak terbaca. Mohon kirim ulang foto yang lebih jelas.');
  }

  const flags = new Set<Flag>();
  const missing: string[] = [];

  const text = (f: z.infer<typeof Field> | undefined) => (f?.value == null || String(f.value).trim() === '' ? null : String(f.value).trim());
  const vendorName = text(s2.vendor_name);
  const rawDate = text(s2.invoice_date);
  const invoiceDate = rawDate === null ? null : parseIndonesianDate(rawDate);

  // V3 — required fields (an unparseable date counts as missing, never as a guess)
  if (!invoiceDate) missing.push('invoice_date');
  if (!vendorName) missing.push('vendor_name');
  if (missing.length) flags.add('field_kosong');

  // V4 — Σ line items ≈ subtotal
  const subtotal = moneyCents(s2.subtotal?.value);
  let itemsCents: Cents | null = null;
  if (s2.line_items.length) {
    let sum = 0;
    let unreadable = false;
    for (const it of s2.line_items) {
      const a = moneyCents(it.amount);
      if (a === null) unreadable = true;
      else sum += a;
    }
    if (!unreadable) itemsCents = sum;
  }
  if (itemsCents !== null && subtotal !== null && Math.abs(itemsCents - subtotal) > Math.max(tolCents, tolPct * subtotal)) flags.add('arith_items');

  // V5 — subtotal + PPN ≈ total
  const ppn = moneyCents(s2.ppn?.value);
  if (arithPpnFails(subtotal, ppn, totalCents, tolCents)) flags.add('arith_ppn');

  // V6 — NPWP 15 (old) or 16 (NIK-format) digits
  let npwp: string | null = null;
  const rawNpwp = text(s2.npwp);
  if (rawNpwp) {
    const digits = rawNpwp.replace(/\D/g, '');
    if (digits.length === 15 || digits.length === 16) npwp = digits;
    else flags.add('npwp_format');
  }

  // V7 — invoice date within [site start − 30 d, today + 1 d]
  if (invoiceDate && dateOutOfRange(invoiceDate, siteStart, today)) flags.add('date_range');

  const confidence: Record<string, number> = {};
  for (const [k, f] of Object.entries(s2)) {
    if (f && typeof f === 'object' && 'confidence' in f && k !== 'bank_account') confidence[k] = f.confidence;
  }

  return {
    decision: 'accept',
    status: [...flags].some((f) => BLOCKING_FLAGS.includes(f)) ? 'perlu_cek' : 'perlu_konfirmasi',
    flags: [...flags],
    totalCents,
    npwp,
    missing,
    fields: {
      vendorName,
      docNumber: text(s2.doc_number) ?? text(s2.invoice_number),
      invoiceDate,
      description: text(s2.description),
      subtotalCents: subtotal,
      ppnCents: ppn,
      totalCents,
      itemsCents,
      confidence,
    },
  };
}

/** Flags that need a human before the row may be confirmed. npwp_format alone does not. */
export const BLOCKING_FLAGS: readonly string[] = ['field_kosong', 'arith_items', 'arith_ppn', 'date_range'];

/** V5, reusable when a chat TOTAL correction changes the total. */
export function arithPpnFails(subtotal: Cents | null, ppn: Cents | null, total: Cents, tolCents = DEFAULT_TOLERANCE_CENTS): boolean {
  return ppn !== null && subtotal !== null && Math.abs(subtotal + ppn - total) > tolCents;
}

/** V7, reusable when a chat TANGGAL correction changes the date. */
export function dateOutOfRange(isoDate: string, siteStart: Date | null, today: Date): boolean {
  const d = new Date(`${isoDate}T00:00:00Z`);
  const lower = siteStart ? addDays(siteStart, -30) : null;
  return Number.isNaN(d.getTime()) || (lower !== null && d < lower) || d > addDays(today, 1);
}

function reject(message: string): ValidationResult {
  return { decision: 'reject', outcome: 'tidak_terbaca', message };
}

function addDays(d: Date, n: number): Date {
  return new Date(d.getTime() + n * 86_400_000);
}
