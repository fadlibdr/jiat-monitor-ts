import { describe, expect, it } from 'vitest';
import { CATEGORY_LABEL, normalizeCategory } from '../../src/domain/categories.js';
import { parseCorrection } from '../../src/domain/correction.js';
import { validateReceipt } from '../../src/domain/receipt-validator.js';
import { scrubVendorName, usableVendorName } from '../../src/domain/vendor-name.js';
import { summaryReply, correctionReply } from '../../src/intake/replies.js';

describe('"#xxxx" is a row reference only where it cannot be part of a value', () => {
  it('as the first token, for any command', () => {
    expect(parseCorrection('#a1b2 TOTAL 2450000', false)).toEqual({ command: 'total', value: 245_000_000, rowRef: 'a1b2' });
    expect(parseCorrection('#A1B2 vendor Toko X', false)).toEqual({ command: 'vendor', value: 'Toko X', rowRef: 'a1b2' });
    expect(parseCorrection('#a1b2 nomor INV #1024', false)).toEqual({ command: 'nomor', value: 'INV #1024', rowRef: 'a1b2' });
  });

  it('as the last token after ok / tolak / total / tanggal / kategori', () => {
    expect(parseCorrection('OK #a1b2', false)).toEqual({ command: 'ok', value: null, rowRef: 'a1b2' });
    expect(parseCorrection('tolak #a1b2', false)).toEqual({ command: 'tolak', value: null, rowRef: 'a1b2' });
    expect(parseCorrection('TOTAL 2.450.000 #a1b2', false)).toEqual({ command: 'total', value: 245_000_000, rowRef: 'a1b2' });
    expect(parseCorrection('kategori material #a1b2', false)).toEqual({ command: 'kategori', value: 'material', rowRef: 'a1b2' });
  });

  it('never inside or at the end of a NOMOR or VENDOR value: document numbers keep their "#"', () => {
    expect(parseCorrection('nomor INV #1024', true)).toEqual({ command: 'nomor', value: 'INV #1024', rowRef: null });
    expect(parseCorrection('nomor #0012', true)).toEqual({ command: 'nomor', value: '#0012', rowRef: null });
    expect(parseCorrection('vendor Toko #beef', true)).toEqual({ command: 'vendor', value: 'Toko #beef', rowRef: null });
    // without a reply, such a text carries no reference at all and stays silent
    expect(parseCorrection('nomor INV #1024', false)).toBeNull();
  });

  it('a "#" with other than 4 hex characters is text', () => {
    expect(parseCorrection('#a1b TOTAL 5000', false)).toBeNull();
    expect(parseCorrection('#a1b2c TOTAL 5000', false)).toBeNull();
  });
});

describe('VENDOR and NOMOR are bounded like the review API', () => {
  it('vendor needs 2–200 characters with a letter or digit; spaces collapse', () => {
    expect(parseCorrection('vendor  Toko   Sinar  ', true)).toEqual({ command: 'vendor', value: 'Toko Sinar', rowRef: null });
    expect(parseCorrection('vendor AB', true)).toMatchObject({ command: 'vendor', value: 'AB' });
    for (const bad of ['vendor A', 'vendor -', 'vendor ..', `vendor ${'x'.repeat(201)}`]) {
      expect(parseCorrection(bad, true), bad).toMatchObject({ command: 'vendor', error: expect.stringMatching(/nama vendor/) });
    }
    expect(parseCorrection(`vendor ${'x'.repeat(200)}`, true)).toMatchObject({ command: 'vendor', value: 'x'.repeat(200) });
  });

  it('nomor up to exactly 100 characters', () => {
    expect(parseCorrection(`nomor ${'1'.repeat(100)}`, true)).toMatchObject({ command: 'nomor', value: '1'.repeat(100) });
    expect(parseCorrection(`nomor ${'1'.repeat(101)}`, true)).toMatchObject({ command: 'nomor', error: expect.stringMatching(/100/) });
  });
});

describe('KATEGORI accepts every label the bot shows', () => {
  it('each CATEGORY_LABEL maps back to its slug, whatever the spacing around "/"', () => {
    for (const [slug, label] of Object.entries(CATEGORY_LABEL)) {
      expect(normalizeCategory(label), label).toBe(slug);
      expect(parseCorrection(`KATEGORI ${label}`, true), label).toMatchObject({ command: 'kategori', value: slug });
    }
    expect(normalizeCategory('upah/jasa')).toBe('upah');
    expect(normalizeCategory('UPAH  /  JASA')).toBe('upah');
  });
});

describe('vendor names: usable and scrubbed', () => {
  it('usableVendorName: 2–200 characters with a letter or digit', () => {
    expect([usableVendorName(null), usableVendorName(''), usableVendorName('-'), usableVendorName('A'), usableVendorName(' ..  ')]).toEqual([null, null, null, null, null]);
    expect(usableVendorName('  Toko   Sinar ')).toBe('Toko Sinar');
    expect(usableVendorName('99')).toBe('99');
    expect(usableVendorName('x'.repeat(201))).toBeNull();
  });

  it('scrubVendorName cuts at NPWP / Rek. / a.n. markers and removes numbers of 8+ digits', () => {
    expect(scrubVendorName('Toko Sinar Jaya NPWP 01.234.567.8-901.000')).toBe('Toko Sinar Jaya');
    expect(scrubVendorName('CV Maju Rek. BCA 1234567890')).toBe('CV Maju');
    expect(scrubVendorName('UD Abadi No Rek 8800112233 a.n. Budi')).toBe('UD Abadi');
    expect(scrubVendorName('Toko Bangunan a/n Siti')).toBe('Toko Bangunan');
    expect(scrubVendorName('PT Abadi 0812-3456-7890')).toBe('PT Abadi');
    // ordinary names and short numbers are kept; "Rekan" is not "Rek."
    expect(scrubVendorName('Toko 99 Rekan Jaya')).toBe('Toko 99 Rekan Jaya');
    expect(scrubVendorName('Material 2000 - Cab. 12')).toBe('Material 2000 - Cab. 12');
    expect([scrubVendorName(null), scrubVendorName('NPWP 012345678901000')]).toEqual([null, null]);
  });

  it('the validator stores the scrubbed name, and "-" counts as a missing vendor (field_kosong)', () => {
    const s1 = { doc_type: 'nota', quality: 0.9, reason: '' };
    const s2 = (vendor: string) => ({
      vendor_name: { value: vendor, confidence: 0.9 }, invoice_date: { value: '21/06/2026', confidence: 0.9 }, total: { value: 'Rp 100.000', confidence: 0.95 }, line_items: [],
    });
    const today = new Date('2026-06-22T00:00:00Z');
    const opts = { qualityMin: 0.45, totalConfidenceMin: 0.7 };
    const v = validateReceipt(s1, s2('Toko Sinar Jaya NPWP 01.234.567.8-901.000 Rek BRI 8800112233'), null, today, opts);
    expect(v).toMatchObject({ decision: 'accept', fields: { vendorName: 'Toko Sinar Jaya' } });
    const dash = validateReceipt(s1, s2('-'), null, today, opts);
    expect(dash).toMatchObject({ decision: 'accept', fields: { vendorName: null } });
    expect(dash.decision === 'accept' && dash.flags).toContain('field_kosong');
  });

  it('replies scrub the vendor name a second time (a name stored before this rule, or typed by an admin)', () => {
    const row = { rowId: '00000000-0000-0000-0000-00000000abcd', vendorName: 'Toko A NPWP 012345678901000', invoiceDate: null, totalCents: 100, category: null, status: 'perlu_konfirmasi', flags: [] };
    for (const text of [summaryReply(row), correctionReply({ ...row, status: 'terkonfirmasi' }, 'OK')]) {
      expect(text).toContain('Toko A');
      expect(text).not.toMatch(/npwp|012345678901000/i);
    }
  });
});
