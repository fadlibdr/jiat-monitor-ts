import { z } from 'zod';
import { parseIdrCents, type Cents } from './money.js';

/**
 * Validation rules V1–V7 on the two OCR stage outputs. Pure: V8–V10 (sha256, pHash window,
 * vendor trigram) need the database and live in the intake job.
 *
 * Stage-2 fields arrive as {value, confidence}. Money values are text and go through the same
 * MoneyParser as everything else; the OCR is told to return printed text, never numbers it computed.
 */
export const Stage1 = z.object({
  doc_type: z.enum(['faktur', 'nota', 'invoice', 'kwitansi', 'bukan_dokumen']).default('bukan_dokumen'),
  quality: z.number().min(0).max(1).nullable().default(null),
});
export type Stage1 = z.infer<typeof Stage1>;

const Field = z.object({ value: z.string().nullable(), confidence: z.number().min(0).max(1).default(0) });
export const Stage2 = z.object({
  vendor_name: Field.optional(),
  invoice_number: Field.optional(),
  invoice_date: Field.optional(), // ISO date (stage 2 prompt asks for YYYY-MM-DD) or null
  subtotal: Field.optional(),
  ppn: Field.optional(),
  total: Field.optional(),
  npwp: Field.optional(),
  line_items: z.array(z.object({ description: z.string(), amount: z.string().nullable() })).default([]),
});
export type Stage2 = z.infer<typeof Stage2>;

export type Flag = 'field_kosong' | 'arith_items' | 'arith_ppn' | 'npwp_format' | 'date_range' | 'total_nol';

export type ValidationResult =
  | { decision: 'reject'; outcome: 'tidak_terbaca'; message: string }
  | {
      decision: 'accept';
      status: 'perlu_konfirmasi' | 'perlu_cek';
      flags: Flag[];
      totalCents: Cents;
      npwp: string | null; // digits only, null if V6 failed
      missing: string[];
    };

export interface ValidatorOptions {
  qualityMin?: number; // V1
  totalConfidenceMin?: number; // V2
  arithToleranceCents?: number; // V4/V5 absolute tolerance
  arithTolerancePct?: number; // V4 relative tolerance
}

export function validateReceipt(
  stage1In: unknown,
  stage2In: unknown,
  siteStart: Date | null,
  today: Date,
  opt: ValidatorOptions = {},
): ValidationResult {
  const qualityMin = opt.qualityMin ?? 0.45;
  const totalConfidenceMin = opt.totalConfidenceMin ?? 0.7;
  const tolCents = opt.arithToleranceCents ?? 100_000; // Rp 1.000
  const tolPct = opt.arithTolerancePct ?? 0.005;

  const s1 = Stage1.parse(stage1In);
  const s2 = Stage2.parse(stage2In);

  // V1 — document type & image quality
  if (s1.doc_type === 'bukan_dokumen' || (s1.quality ?? 0) < qualityMin) {
    return reject('Foto kurang jelas atau bukan nota. Mohon kirim ulang foto yang lebih jelas.');
  }

  // V2 — total present, confident, and > 0 (the PHP build let "0" through: L5)
  const totalCents = parseIdrCents(s2.total?.value);
  if (totalCents === null || totalCents <= 0 || (s2.total?.confidence ?? 0) < totalConfidenceMin) {
    return reject('Total tidak terbaca. Mohon kirim ulang foto yang lebih jelas.');
  }

  const flags = new Set<Flag>();
  const missing: string[] = [];

  // V3 — required fields
  for (const f of ['invoice_date', 'vendor_name'] as const) {
    if (!s2[f]?.value) missing.push(f);
  }
  if (missing.length) flags.add('field_kosong');

  // V4 — Σ line items ≈ subtotal
  const subtotal = parseIdrCents(s2.subtotal?.value);
  if (s2.line_items.length && subtotal !== null) {
    let sum = 0;
    let unreadable = false;
    for (const it of s2.line_items) {
      const a = parseIdrCents(it.amount);
      if (a === null) unreadable = true;
      else sum += a;
    }
    if (!unreadable && Math.abs(sum - subtotal) > Math.max(tolCents, tolPct * subtotal)) flags.add('arith_items');
  }

  // V5 — subtotal + PPN ≈ total
  const ppn = parseIdrCents(s2.ppn?.value);
  if (ppn !== null && subtotal !== null && Math.abs(subtotal + ppn - totalCents) > tolCents) flags.add('arith_ppn');

  // V6 — NPWP 15 (old) or 16 (NIK-format) digits
  let npwp: string | null = null;
  if (s2.npwp?.value) {
    const digits = s2.npwp.value.replace(/\D/g, '');
    if (digits.length === 15 || digits.length === 16) npwp = digits;
    else flags.add('npwp_format');
  }

  // V7 — invoice date within [site start − 30 d, today + 1 d]
  const dateStr = s2.invoice_date?.value;
  if (dateStr) {
    const d = /^\d{4}-\d{2}-\d{2}$/.test(dateStr) ? new Date(`${dateStr}T00:00:00Z`) : null;
    const lower = siteStart ? addDays(siteStart, -30) : null;
    const upper = addDays(today, 1);
    if (!d || Number.isNaN(d.getTime()) || (lower && d < lower) || d > upper) flags.add('date_range');
  }

  const needsCheck = ['field_kosong', 'arith_items', 'arith_ppn', 'date_range'].some((f) => flags.has(f as Flag));
  return {
    decision: 'accept',
    status: needsCheck ? 'perlu_cek' : 'perlu_konfirmasi',
    flags: [...flags],
    totalCents,
    npwp,
    missing,
  };
}

function reject(message: string): ValidationResult {
  return { decision: 'reject', outcome: 'tidak_terbaca', message };
}

function addDays(d: Date, n: number): Date {
  return new Date(d.getTime() + n * 86_400_000);
}
