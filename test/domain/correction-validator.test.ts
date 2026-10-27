import { describe, expect, it } from 'vitest';
import { parseCorrection } from '../../src/domain/correction.js';
import {
  arithPpnFails, BLOCKING_FLAGS, checkStage1, dateOutOfRange, moneyCents, TEXT_MAX, validateReceipt,
} from '../../src/domain/receipt-validator.js';

describe('parseCorrection', () => {
  it('ignores text that is neither a reply to the bot nor carries a #ref', () => {
    expect(parseCorrection('total 2450000', false)).toBeNull();
    expect(parseCorrection('halo semua', true)).toBeNull();
  });

  it('parses money with the shared MoneyParser (accepts Rp, thousands, ",-")', () => {
    expect(parseCorrection('total 2450000', true)).toEqual({ command: 'total', value: 245_000_000, rowRef: null });
    expect(parseCorrection('Total Rp 2.450.000,-', true)).toEqual({ command: 'total', value: 245_000_000, rowRef: null });
    expect(parseCorrection('  TOTAL    100000  ', true)).toEqual({ command: 'total', value: 10_000_000, rowRef: null });
  });

  it('returns an error (not null) when the command is recognised but the value is not', () => {
    expect(parseCorrection('total abc', true)).toMatchObject({ command: 'total', error: 'total tidak terbaca', raw: 'abc' });
    expect(parseCorrection('total 0', true)).toMatchObject({ command: 'total', error: 'total tidak terbaca' });
    expect(parseCorrection('tanggal 21/06/26', true)).toMatchObject({ command: 'tanggal', error: 'tanggal tidak terbaca' });
    expect(parseCorrection('kategori pemeliharaan', true)).toMatchObject({ command: 'kategori', error: 'kategori tidak dikenal' });
  });

  it('parses dates in every form DateParser accepts, including "21 Juni 2026" (L3)', () => {
    expect(parseCorrection('tanggal 21/06/2026', true)).toEqual({ command: 'tanggal', value: '2026-06-21', rowRef: null });
    expect(parseCorrection('tanggal 21 Juni 2026', true)).toEqual({ command: 'tanggal', value: '2026-06-21', rowRef: null });
  });

  it('normalises categories through the single category list (L4)', () => {
    expect(parseCorrection('KATEGORI Material', true)).toEqual({ command: 'kategori', value: 'material', rowRef: null });
    expect(parseCorrection('kategori Peralatan', true)).toEqual({ command: 'kategori', value: 'alat', rowRef: null });
  });

  it('extracts a #xxxx row reference anywhere in the text and lower-cases it', () => {
    expect(parseCorrection('total 2450000 #A1b2', false)).toEqual({ command: 'total', value: 245_000_000, rowRef: 'a1b2' });
    expect(parseCorrection('#ffff vendor PT Sumber Beton', false)).toEqual({ command: 'vendor', value: 'PT Sumber Beton', rowRef: 'ffff' });
    expect(parseCorrection('ok #1234', false)).toEqual({ command: 'ok', value: null, rowRef: '1234' });
  });

  it('does not treat #12345 (5 hex) or #zzzz as a reference', () => {
    expect(parseCorrection('total 100 #12345', false)).toBeNull();
    expect(parseCorrection('total 100 #zzzz', false)).toBeNull();
  });

  it('ok / tolak carry no value', () => {
    expect(parseCorrection('OK', true)).toEqual({ command: 'ok', value: null, rowRef: null });
    expect(parseCorrection('tolak', true)).toEqual({ command: 'tolak', value: null, rowRef: null });
  });
});

const today = new Date('2026-06-21T00:00:00Z');
const siteStart = new Date('2026-01-10T00:00:00Z');
const f = (value: string | null, confidence = 0.95) => ({ value, confidence });
const good = () => ({
  vendor_name: f('PT Sumber Beton'),
  invoice_number: f('INV-0621-A'),
  invoice_date: f('2026-06-21'),
  subtotal: f('2.207.207'),
  ppn: f('242.793'),
  total: f('2.450.000'),
  npwp: f('01.234.567.8-901.000'),
  line_items: [
    { description: 'Semen 40 sak', amount: '1.680.000' as string | null },
    { description: 'Pasir 4 truk', amount: '527.207' as string | null },
  ],
});

describe('validateReceipt V1–V7', () => {
  it('V1 rejects non-documents and low quality', () => {
    expect(validateReceipt({ doc_type: 'bukan_dokumen', quality: 0.9 }, good(), siteStart, today)).toMatchObject({ decision: 'reject' });
    expect(validateReceipt({ doc_type: 'nota', quality: 0.3 }, good(), siteStart, today)).toMatchObject({ decision: 'reject' });
  });

  it('V2 rejects missing, unparseable, low-confidence or zero totals (L5)', () => {
    for (const total of [f(null), f('abc'), f('2.450.000', 0.5), f('0'), f('Rp 0,-')]) {
      const r = validateReceipt({ doc_type: 'nota', quality: 0.9 }, { ...good(), total }, siteStart, today);
      expect(r).toMatchObject({ decision: 'reject', outcome: 'tidak_terbaca' });
      if (r.decision === 'reject') expect(r.message).toMatch(/Total tidak terbaca/);
    }
  });

  it('accepts a clean receipt as perlu_konfirmasi with sanitised NPWP, total in cents and normalised fields', () => {
    const r = validateReceipt({ doc_type: 'nota', quality: 0.9 }, good(), siteStart, today);
    expect(r).toEqual({
      decision: 'accept',
      status: 'perlu_konfirmasi',
      flags: [],
      totalCents: 245_000_000,
      npwp: '012345678901000',
      missing: [],
      fields: {
        vendorName: 'PT Sumber Beton', docNumber: 'INV-0621-A', invoiceDate: '2026-06-21', description: null,
        subtotalCents: 220_720_700, ppnCents: 24_279_300, totalCents: 245_000_000, itemsCents: 220_720_700,
        confidence: { vendor_name: 0.95, invoice_number: 0.95, invoice_date: 0.95, subtotal: 0.95, ppn: 0.95, total: 0.95, npwp: 0.95 },
      },
    });
  });

  it('V3 missing vendor/date -> perlu_cek with field_kosong and the missing list', () => {
    const r = validateReceipt({ doc_type: 'nota', quality: 0.9 }, { ...good(), vendor_name: f(null) }, siteStart, today);
    expect(r).toMatchObject({ status: 'perlu_cek', flags: ['field_kosong'], missing: ['vendor_name'] });
  });

  it('V4 flags line items that do not sum to subtotal beyond tolerance', () => {
    const s2 = good();
    s2.line_items[1]!.amount = '600.000'; // off by ~73k
    expect(validateReceipt({ doc_type: 'nota', quality: 0.9 }, s2, siteStart, today)).toMatchObject({ flags: ['arith_items'] });
  });

  it('V4 does not flag when an item amount is unreadable (cannot prove a mismatch)', () => {
    const s2 = good();
    s2.line_items[1]!.amount = null;
    expect(validateReceipt({ doc_type: 'nota', quality: 0.9 }, s2, siteStart, today)).toMatchObject({ flags: [] });
  });

  it('V5 flags subtotal + PPN != total', () => {
    expect(validateReceipt({ doc_type: 'nota', quality: 0.9 }, { ...good(), ppn: f('100.000') }, siteStart, today)).toMatchObject({ flags: ['arith_ppn'] });
  });

  it('V6 bad NPWP length -> npwp null + npwp_format, but status stays perlu_konfirmasi', () => {
    const r = validateReceipt({ doc_type: 'nota', quality: 0.9 }, { ...good(), npwp: f('12345') }, siteStart, today);
    expect(r).toMatchObject({ status: 'perlu_konfirmasi', flags: ['npwp_format'], npwp: null });
  });

  it('V7 flags dates before site start − 30 days or after tomorrow', () => {
    expect(validateReceipt({ doc_type: 'nota', quality: 0.9 }, { ...good(), invoice_date: f('2025-12-01') }, siteStart, today)).toMatchObject({ flags: ['date_range'] });
    expect(validateReceipt({ doc_type: 'nota', quality: 0.9 }, { ...good(), invoice_date: f('2026-06-23') }, siteStart, today)).toMatchObject({ flags: ['date_range'] });
    expect(validateReceipt({ doc_type: 'nota', quality: 0.9 }, { ...good(), invoice_date: f('2026-06-22') }, siteStart, today)).toMatchObject({ flags: [] });
    expect(validateReceipt({ doc_type: 'nota', quality: 0.9 }, { ...good(), invoice_date: f('2025-12-01') }, null, today)).toMatchObject({ flags: [] });
  });

  it('rejects malformed stage payloads at the boundary (zod)', () => {
    expect(() => validateReceipt({ doc_type: 'faktur', quality: 2 }, good(), siteStart, today)).toThrow();
    expect(() => validateReceipt({ doc_type: 'nota', quality: 0.9 }, { total: 'not-a-field' }, siteStart, today)).toThrow();
  });
});

describe('OCR output contract (LLD §6 shape and text shape both accepted)', () => {
  /** verbatim from LLD §6 "Tahap 2, keluaran" */
  const lldSample = {
    invoice_date: { value: '2026-06-21', confidence: 0.94 },
    vendor_name: { value: 'PT Sumber Beton', confidence: 0.91 },
    doc_number: { value: 'INV-0621-A', confidence: 0.88 },
    description: { value: 'Semen 40 sak; pasir 4 truk', confidence: 0.80 },
    line_items: [{ desc: 'Semen', qty: 40, unit: 'sak', price: 42000, amount: 1680000 }],
    subtotal: { value: 2450000, confidence: 0.90 },
    ppn: { value: null, confidence: 0.0 },
    total: { value: 2450000, confidence: 0.95 },
    bank_account: { value: '1234567890', confidence: 0.9 },
    npwp: { value: null, confidence: 0.0 },
  };

  it('parses the LLD sample: numbers are rupiah, doc_number and desc are understood, the bank account is dropped', () => {
    const r = validateReceipt({ doc_type: 'nota', quality: 0.9, reason: '' }, lldSample, siteStart, today);
    expect(r).toMatchObject({ decision: 'accept', totalCents: 245_000_000, flags: ['arith_items'] });
    if (r.decision !== 'accept') throw new Error('unreachable');
    expect(r.fields).toMatchObject({ docNumber: 'INV-0621-A', description: 'Semen 40 sak; pasir 4 truk', itemsCents: 168_000_000, ppnCents: null });
    expect(JSON.stringify(r)).not.toContain('1234567890');
  });

  it('bukti_transfer is a document; an unknown doc_type is treated as bukan_dokumen (ask for a new photo)', () => {
    expect(validateReceipt({ doc_type: 'bukti_transfer', quality: 0.9 }, good(), siteStart, today)).toMatchObject({ decision: 'accept' });
    expect(validateReceipt({ doc_type: 'receipt', quality: 0.9 }, good(), siteStart, today)).toMatchObject({ decision: 'reject' });
    expect(validateReceipt({ doc_type: null, quality: 0.9 }, good(), siteStart, today)).toMatchObject({ decision: 'reject' });
  });

  it('a date the DateParser cannot read is missing (field_kosong), never guessed; DD/MM/YYYY is read', () => {
    expect(validateReceipt({ doc_type: 'nota', quality: 0.9 }, { ...good(), invoice_date: f('21/06/26') }, siteStart, today))
      .toMatchObject({ status: 'perlu_cek', flags: ['field_kosong'], missing: ['invoice_date'] });
    const r = validateReceipt({ doc_type: 'nota', quality: 0.9 }, { ...good(), invoice_date: f('21/06/2026') }, siteStart, today);
    expect(r).toMatchObject({ flags: [], fields: { invoiceDate: '2026-06-21' } });
  });

  it('bounds untrusted OCR text: a nota number over 100 chars is dropped (not cut), vendor name and description are cut', () => {
    const r = validateReceipt({ doc_type: 'nota', quality: 0.9 }, {
      ...good(), invoice_number: f('X'.repeat(TEXT_MAX.docNumber + 1)), vendor_name: f('V'.repeat(500)), description: f('d'.repeat(5000)),
    }, siteStart, today);
    if (r.decision !== 'accept') throw new Error('unreachable');
    expect(r.fields.docNumber).toBeNull();
    expect(r.fields.vendorName).toHaveLength(TEXT_MAX.vendorName);
    expect(r.fields.description).toHaveLength(TEXT_MAX.description);
    const exact = validateReceipt({ doc_type: 'nota', quality: 0.9 }, { ...good(), invoice_number: f('X'.repeat(TEXT_MAX.docNumber)) }, siteStart, today);
    expect(exact.decision === 'accept' && exact.fields.docNumber).toHaveLength(TEXT_MAX.docNumber);
  });

  it('npwp_format alone does not block confirmation', () => {
    expect(BLOCKING_FLAGS).not.toContain('npwp_format');
  });
});

describe('validator helpers', () => {
  it('checkStage1 stops before stage 2 on V1', () => {
    expect(checkStage1({ doc_type: 'nota', quality: 0.44 })).toMatchObject({ ok: false });
    expect(checkStage1({ doc_type: 'nota', quality: 0.45 })).toMatchObject({ ok: true });
  });
  it('moneyCents: numbers are rupiah (negative/NaN refused), text goes through MoneyParser, null stays null', () => {
    expect([moneyCents(2450000), moneyCents(1.5), moneyCents(-1), moneyCents(Number.NaN), moneyCents('Rp 2.450.000,-'), moneyCents(null)])
      .toEqual([245_000_000, 150, null, null, 245_000_000, null]);
  });
  it('arithPpnFails and dateOutOfRange are the V5/V7 rules used by chat corrections', () => {
    expect(arithPpnFails(100_000_00, 11_000_00, 111_000_00)).toBe(false);
    expect(arithPpnFails(100_000_00, 11_000_00, 112_000_00)).toBe(false); // exactly Rp 1.000 off: LLD flags only "> 1000"
    expect(arithPpnFails(100_000_00, 11_000_00, 112_000_01)).toBe(true);
    expect(arithPpnFails(null, 11_000_00, 1)).toBe(false);
    expect(dateOutOfRange('2026-06-23', siteStart, today)).toBe(true);
    expect(dateOutOfRange('2025-12-11', siteStart, today)).toBe(false);
    expect(dateOutOfRange('2025-12-10', siteStart, today)).toBe(true);
  });
});
