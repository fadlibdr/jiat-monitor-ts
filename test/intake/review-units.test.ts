import { randomUUID } from 'node:crypto';
import { and, eq } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  auditLogs, companies, sites, users, vendorInvoices, vendors, type IntakeReview, type VendorInvoiceStatus,
} from '../../src/db/schema.js';
import { withApp, withCompany, type Db } from '../../src/db/tenant.js';
import { CATEGORY_LABEL, type Category } from '../../src/domain/categories.js';
import {
  correctionReply, duplicateReply, flagText, REPLY, shortRef, summaryReply, type ReplyRow,
} from '../../src/intake/replies.js';
import {
  applyChanges, recomputeFlags, REVIEW_FLAGS, statusFor,
  type ApplyResult, type Change, type Channel, type FlagInput, type VendorInvoiceRow,
} from '../../src/intake/review.js';
import { matchVendor, VENDOR_MATCH_MIN, vendorForName } from '../../src/intake/vendors.js';
import { createTestDb } from '../helpers/db.js';

const TODAY = new Date('2026-10-27T03:00:00Z');
const SITE_START = new Date('2026-03-01T00:00:00Z'); // V7 lower bound = 2026-01-30
const sorted = (xs: readonly string[]): string[] => [...xs].sort();

// =============================================================================================
// statusFor / recomputeFlags (pure)
// =============================================================================================

describe('statusFor', () => {
  it('a row without flags waits for a confirmation (perlu_konfirmasi)', () => {
    expect(statusFor([])).toBe('perlu_konfirmasi');
  });

  it.each([...REVIEW_FLAGS])('%s alone sends the row to perlu_cek', (flag) => {
    expect(statusFor([flag])).toBe('perlu_cek');
  });

  it('V9 near_duplicate is a review flag (LLD: near_duplicate → status perlu_cek)', () => {
    expect(REVIEW_FLAGS).toContain('near_duplicate');
    expect(statusFor(['near_duplicate'])).toBe('perlu_cek');
  });

  it('kategori_kosong and npwp_format alone do not need a human check: perlu_konfirmasi', () => {
    expect(statusFor(['kategori_kosong'])).toBe('perlu_konfirmasi');
    expect(statusFor(['npwp_format'])).toBe('perlu_konfirmasi');
    expect(statusFor(['kategori_kosong', 'npwp_format'])).toBe('perlu_konfirmasi');
  });

  it('one review flag among non-review flags is enough for perlu_cek', () => {
    expect(statusFor(['npwp_format', 'kategori_kosong', 'date_range'])).toBe('perlu_cek');
  });
});

describe('recomputeFlags', () => {
  const clean: FlagInput = {
    vendorId: 1, vendorName: 'Sentosa', invoiceDate: '2026-10-20', category: 'material',
    dppCents: 200_000_000, ppnCents: 22_000_000, totalCents: 222_000_000,
  };
  const flagsOf = (patch: Partial<FlagInput>, previous: readonly string[] = [], siteStart: Date | null = SITE_START) =>
    sorted(recomputeFlags({ ...clean, ...patch }, previous, siteStart, TODAY));

  it('a complete, consistent row has no flags', () => {
    expect(flagsOf({})).toEqual([]);
  });

  it('keeps the sticky flags (arith_items, npwp_format, near_duplicate) a correction cannot re-derive', () => {
    expect(flagsOf({}, ['arith_items', 'npwp_format', 'near_duplicate'])).toEqual(['arith_items', 'near_duplicate', 'npwp_format']);
  });

  it('drops stale re-derivable flags (field_kosong, arith_ppn, date_range, kategori_kosong) once the data is fixed', () => {
    expect(flagsOf({}, ['field_kosong', 'arith_ppn', 'date_range', 'kategori_kosong'])).toEqual([]);
  });

  it('keeps sticky flags and re-derives the others in the same call', () => {
    expect(flagsOf({ category: null }, ['near_duplicate', 'date_range'])).toEqual(['kategori_kosong', 'near_duplicate']);
  });

  it('never returns a flag twice and does not mutate the previous list', () => {
    const previous = Object.freeze(['near_duplicate', 'near_duplicate', 'npwp_format']);
    const out = recomputeFlags({ ...clean, category: null }, previous, SITE_START, TODAY);
    expect(sorted(out)).toEqual(['kategori_kosong', 'near_duplicate', 'npwp_format']);
    expect(previous).toEqual(['near_duplicate', 'near_duplicate', 'npwp_format']);
  });

  describe('field_kosong (V3)', () => {
    it('is set when neither a vendor id nor a vendor name is known', () => {
      expect(flagsOf({ vendorId: null, vendorName: null })).toEqual(['field_kosong']);
    });
    it('an empty vendor name counts as missing', () => {
      expect(flagsOf({ vendorId: null, vendorName: '' })).toEqual(['field_kosong']);
    });
    it('a vendor name without a master id, or a master id without a name, is enough', () => {
      expect(flagsOf({ vendorId: null, vendorName: 'Toko X' })).toEqual([]);
      expect(flagsOf({ vendorId: 7, vendorName: null })).toEqual([]);
    });
    it('is set when the invoice date is missing (and a missing date is never date_range)', () => {
      expect(flagsOf({ invoiceDate: null })).toEqual(['field_kosong']);
    });
  });

  describe('arith_ppn (V5)', () => {
    it('is set when subtotal + PPN differs from the total by more than Rp 1.000', () => {
      expect(flagsOf({ totalCents: 250_000_000 })).toEqual(['arith_ppn']);
    });
    it('tolerance boundary: exactly Rp 1.000 off passes, one cent more fails', () => {
      expect(flagsOf({ totalCents: 222_000_000 + 100_000 })).toEqual([]);
      expect(flagsOf({ totalCents: 222_000_000 - 100_000 })).toEqual([]);
      expect(flagsOf({ totalCents: 222_000_000 + 100_001 })).toEqual(['arith_ppn']);
    });
    it('cannot be checked (so is not set) when subtotal or PPN is unknown', () => {
      expect(flagsOf({ dppCents: null, totalCents: 999_000_000 })).toEqual([]);
      expect(flagsOf({ ppnCents: null, totalCents: 999_000_000 })).toEqual([]);
    });
    it('a corrected total clears a previous arith_ppn', () => {
      expect(flagsOf({ totalCents: 222_000_000 }, ['arith_ppn'])).toEqual([]);
    });
  });

  describe('date_range (V7: [site start − 30 d, today + 1 d])', () => {
    it('lower boundary: site start − 30 days is inside, one day earlier is outside', () => {
      expect(flagsOf({ invoiceDate: '2026-01-30' })).toEqual([]);
      expect(flagsOf({ invoiceDate: '2026-01-29' })).toEqual(['date_range']);
    });
    it('upper boundary: tomorrow is inside, the day after is outside', () => {
      expect(flagsOf({ invoiceDate: '2026-10-28' })).toEqual([]);
      expect(flagsOf({ invoiceDate: '2026-10-29' })).toEqual(['date_range']);
    });
    it('without a site start only the upper bound applies', () => {
      expect(flagsOf({ invoiceDate: '2020-01-01' }, [], null)).toEqual([]);
      expect(flagsOf({ invoiceDate: '2027-01-01' }, [], null)).toEqual(['date_range']);
    });
  });

  describe('kategori_kosong', () => {
    it('is set when the category is null and cleared once one is set', () => {
      expect(flagsOf({ category: null })).toEqual(['kategori_kosong']);
      expect(flagsOf({ category: 'alat' }, ['kategori_kosong'])).toEqual([]);
    });
  });
});

// =============================================================================================
// replies (pure)
// =============================================================================================

describe('replies', () => {
  const ROW_ID = '3f2b8c1e-5a7d-4e9b-9c0d-1a2b3c4dbeef';
  const base: ReplyRow = {
    rowId: ROW_ID, vendorName: 'Toko Sentosa', invoiceDate: '2026-06-21', totalCents: 245_000_000,
    category: 'material', status: 'perlu_konfirmasi', flags: [],
  };

  describe('shortRef', () => {
    it('is the last 4 hex of the row uuid', () => {
      expect(shortRef(ROW_ID)).toBe('beef');
      expect(shortRef('123e4567-e89b-12d3-a456-426614174000')).toBe('4000');
    });
    it('is lower-case and independent of hyphens', () => {
      expect(shortRef('3F2B8C1E-5A7D-4E9B-9C0D-1A2B3C4DBEEF')).toBe('beef');
      expect(shortRef('3f2b8c1e5a7d4e9b9c0d1a2b3c4dbeef')).toBe('beef');
    });
  });

  describe('flagText', () => {
    const ALL = ['field_kosong', 'arith_items', 'arith_ppn', 'date_range', 'near_duplicate', 'npwp_format', 'kategori_kosong'];
    it('turns every known flag into a readable text, never the slug', () => {
      const texts = flagText(ALL);
      expect(texts).toHaveLength(ALL.length);
      texts.forEach((t, i) => {
        expect(t).not.toBe(ALL[i]);
        expect(t).not.toMatch(/_/);
        expect(t.length).toBeGreaterThan(5);
      });
      expect(new Set(texts).size).toBe(ALL.length);
    });
    it('has the expected Indonesian texts for the key flags', () => {
      expect(flagText(['near_duplicate'])).toEqual(['mirip nota lain yang sudah tercatat']);
      expect(flagText(['kategori_kosong'])).toEqual(['kategori belum ditentukan']);
      expect(flagText(['date_range'])).toEqual(['tanggal di luar masa proyek']);
      expect(flagText(['arith_ppn'])).toEqual(['subtotal + PPN tidak cocok dengan total']);
    });
    it('passes an unknown flag through unchanged and maps an empty list to an empty list', () => {
      expect(flagText(['total_nol'])).toEqual(['total_nol']);
      expect(flagText([])).toEqual([]);
    });
  });

  describe('duplicateReply', () => {
    it('names the existing row by its short reference', () => {
      expect(duplicateReply(ROW_ID)).toBe('Nota ini sudah tercatat (#beef).');
    });
    it('without a row (photo stored but not attached to an invoice) says only "sudah tercatat"', () => {
      expect(duplicateReply(null)).toBe('Nota ini sudah tercatat.');
    });
  });

  describe('summaryReply', () => {
    it('shows the reference, vendor, Indonesian date, rupiah total and category label', () => {
      const text = summaryReply(base);
      expect(text.split('\n')[0]).toBe('Tercatat #beef');
      expect(text).toContain('Vendor: Toko Sentosa');
      expect(text).toContain('Tanggal: 21/06/2026');
      expect(text).toContain('Total: Rp 2.450.000,00');
      expect(text).toContain(`Kategori: ${CATEGORY_LABEL.material}`);
      expect(text).toMatch(/OK/);
      expect(text).toMatch(/TOLAK/);
      expect(text).not.toContain('Perlu dicek');
    });
    it('shows a dash for an unknown vendor, date and category', () => {
      const text = summaryReply({ ...base, vendorName: null, invoiceDate: null, category: null });
      expect(text).toContain('Vendor: —');
      expect(text).toContain('Tanggal: —');
      expect(text).toContain('Kategori: —');
    });
    it('lists the open flags in words on a "Perlu dicek" line', () => {
      const text = summaryReply({ ...base, flags: ['near_duplicate', 'kategori_kosong'], status: 'perlu_cek' });
      expect(text).toContain('Perlu dicek: mirip nota lain yang sudah tercatat; kategori belum ditentukan');
      expect(text).not.toContain('near_duplicate');
    });
  });

  describe('correctionReply', () => {
    it('a confirmed row: reference, vendor and total', () => {
      expect(correctionReply({ ...base, status: 'terkonfirmasi' }, 'OK')).toBe('#beef terkonfirmasi: Toko Sentosa, Rp 2.450.000,00.');
    });
    it('a rejected row: says the photo is kept', () => {
      expect(correctionReply({ ...base, status: 'ditolak' }, 'TOLAK')).toBe('#beef ditolak. Foto tetap disimpan.');
    });
    it('an open row with remaining flags lists them', () => {
      const text = correctionReply({ ...base, status: 'perlu_cek', flags: ['arith_ppn'] }, 'TOTAL');
      expect(text).toBe('#beef TOTAL diperbarui. Total Rp 2.450.000,00. Masih perlu: subtotal + PPN tidak cocok dengan total.');
    });
    it('an open row without flags invites an OK', () => {
      expect(correctionReply(base, 'KATEGORI')).toBe('#beef KATEGORI diperbarui. Total Rp 2.450.000,00. Balas OK untuk konfirmasi.');
    });
    it('a confirmed row with an unknown vendor shows a dash', () => {
      expect(correctionReply({ ...base, vendorName: null, status: 'terkonfirmasi' }, 'OK')).toContain('terkonfirmasi: —,');
    });
  });

  it('REPLY.confirmBlocked lists the blocking flags in words', () => {
    expect(REPLY.confirmBlocked(['near_duplicate', 'kategori_kosong']))
      .toBe('Belum bisa dikonfirmasi: mirip nota lain yang sudah tercatat; kategori belum ditentukan.');
  });

  describe('never contains a bank account or NPWP (HLD §8, UU 27/2022)', () => {
    const NPWP = '091234567812000';
    const NPWP_PRINTED = '09.123.456.7-812.000';
    const NIK_NPWP = '3201234567890123';
    const BANK = '7771234560';
    const BANK_PRINTED = '777-123-4560';
    const SECRETS = [NPWP, NPWP_PRINTED, NIK_NPWP, BANK, BANK_PRINTED];
    const ALL_FLAGS = ['field_kosong', 'arith_items', 'arith_ppn', 'date_range', 'near_duplicate', 'npwp_format', 'kategori_kosong'];
    // a DB row / OCR result smuggled in where a ReplyRow is expected: every builder must ignore the extras
    const leaky = (status: string): ReplyRow => ({
      ...base, status, flags: ALL_FLAGS,
      npwp: NPWP, npwpPrinted: NPWP_PRINTED, nikNpwp: NIK_NPWP,
      bankAccount: BANK, bank_account: BANK_PRINTED, bankName: 'BCA',
      vendor: { npwp: NPWP, bankAccount: BANK },
      confidence: { fields: { npwp: 0.9, bank_account: 0.9 } },
    } as unknown as ReplyRow);

    const outputs: Array<[string, string]> = [];
    for (const status of ['perlu_konfirmasi', 'perlu_cek', 'terkonfirmasi', 'ditolak']) {
      outputs.push([`summaryReply(${status})`, summaryReply(leaky(status))]);
      for (const what of ['OK', 'TOLAK', 'TOTAL', 'VENDOR', 'TANGGAL', 'NOMOR', 'KATEGORI']) {
        outputs.push([`correctionReply(${status}, ${what})`, correctionReply(leaky(status), what)]);
      }
    }
    outputs.push(['duplicateReply(row)', duplicateReply(ROW_ID)], ['duplicateReply(null)', duplicateReply(null)]);
    outputs.push(['REPLY.confirmBlocked', REPLY.confirmBlocked(ALL_FLAGS)]);
    for (const [k, v] of Object.entries(REPLY)) if (typeof v === 'string') outputs.push([`REPLY.${k}`, v]);

    it.each(outputs)('%s', (_name, text) => {
      for (const s of SECRETS) expect(text).not.toContain(s);
      // also with any separators: no run of digits/punctuation in the text spells a secret
      const runs = (text.match(/[\d][\d.\-\s/]*/g) ?? []).map((r) => r.replace(/\D/g, ''));
      for (const run of runs) {
        for (const s of SECRETS) expect(run).not.toContain(s.replace(/\D/g, ''));
      }
    });
  });
});

// =============================================================================================
// DB-level: vendors (V10) and applyChanges, against PGlite with RLS
// =============================================================================================

describe('against PGlite (RLS)', () => {
  let db: Db;
  let close: () => Promise<void>;
  let A = 0; let B = 0;
  let sA1 = 0; let sA2 = 0; let sB = 0;
  let staff = 0; let admin = 0;
  const vA: Record<string, number> = {};
  const vB: Record<string, number> = {};

  beforeAll(async () => {
    ({ db, close } = await createTestDb());
    await withApp(db, async (tx) => {
      const cs = await tx.insert(companies).values([{ code: 'RVA', name: 'PT Review A' }, { code: 'RVB', name: 'PT Review B' }]).returning({ id: companies.id });
      [A, B] = [cs[0]!.id, cs[1]!.id];
      const us = await tx.insert(users).values([{ email: 'staff@rv.test', name: 'Staff' }, { email: 'admin@rv.test', name: 'Admin' }]).returning({ id: users.id });
      [staff, admin] = [us[0]!.id, us[1]!.id];
    });
    await withCompany(db, A, async (tx) => {
      const ss = await tx.insert(sites).values([
        { companyId: A, code: 'S1', name: 'Site 1', startDate: '2026-03-01' },
        { companyId: A, code: 'S2', name: 'Site 2', startDate: '2026-03-01' },
      ]).returning({ id: sites.id });
      [sA1, sA2] = [ss[0]!.id, ss[1]!.id];
      // insertion order matters: 'Sentosa Jaya' gets the lower id, so "most similar" cannot be "first"
      const names: Array<[string, Category]> = [
        ['Sentosa Jaya', 'material'], ['Sentosa', 'material'], ['Makmur', 'alat'],
        ['CV Sumber Rejeki', 'operasional'], ['Jaya Sentosa', 'upah'],
      ];
      for (const [name, defaultCategory] of names) {
        const [v] = await tx.insert(vendors).values({ companyId: A, name, defaultCategory }).returning({ id: vendors.id });
        vA[name] = v!.id;
      }
    });
    await withCompany(db, B, async (tx) => {
      const [s] = await tx.insert(sites).values({ companyId: B, code: 'S1', name: 'Site B', startDate: '2026-03-01' }).returning({ id: sites.id });
      sB = s!.id;
      for (const [name, defaultCategory] of [['Abadi Teknik', 'upah'], ['Sentosa', 'subkon']] as Array<[string, Category]>) {
        const [v] = await tx.insert(vendors).values({ companyId: B, name, defaultCategory }).returning({ id: vendors.id });
        vB[name] = v!.id;
      }
    });
  });
  afterAll(async () => { await close(); });

  const vendorsNamed = (companyId: number, name: string) =>
    withCompany(db, companyId, (tx) => tx.select().from(vendors).where(eq(vendors.name, name)));

  // -------------------------------------------------------------------------------------------
  describe('matchVendor (V10: trigram similarity ≥ 0.6)', () => {
    const match = (name: string, companyId = A) => withCompany(db, companyId, (tx) => matchVendor(tx, name));

    it('the threshold is 0.6', () => {
      expect(VENDOR_MATCH_MIN).toBe(0.6);
    });

    it('an exact name matches with similarity 1 and carries the default category', async () => {
      expect(await match('Makmur')).toEqual({ id: vA['Makmur'], name: 'Makmur', defaultCategory: 'alat', similarity: 1 });
    });

    it('boundary: similarity exactly 0.6 matches ("Sentosi" vs "Sentosa": 6 of 10 trigrams)', async () => {
      const m = await match('Sentosi');
      expect(m).not.toBeNull();
      expect(m!.id).toBe(vA['Sentosa']);
      expect(typeof m!.similarity).toBe('number');
      expect(m!.similarity).toBeCloseTo(0.6, 5);
    });

    it('boundary: similarity just below 0.6 does not match ("Makmun" vs "Makmur": 5 of 9 trigrams)', async () => {
      expect(await match('Makmun')).toBeNull();
    });

    it('is case-insensitive', async () => {
      const m = await match('cv SUMBER rejeki');
      expect(m).toMatchObject({ id: vA['CV Sumber Rejeki'], name: 'CV Sumber Rejeki', similarity: 1 });
    });

    it('ignores surrounding whitespace', async () => {
      expect((await match('   Makmur  '))?.id).toBe(vA['Makmur']);
    });

    it('picks the most similar vendor, not the first one above the threshold', async () => {
      // "Sentosa Jaya" (lower id) is also ≥ 0.6 for "Sentosa", but "Sentosa" itself is the exact match
      const m = await match('Sentosa');
      expect(m).toMatchObject({ id: vA['Sentosa'], name: 'Sentosa', similarity: 1 });
    });

    it('a tie in similarity is resolved deterministically (same answer every call)', async () => {
      const first = await match('sentosa jaya');
      const again = await match('Jaya Sentosa');
      expect(first?.similarity).toBe(1);
      expect([vA['Sentosa Jaya'], vA['Jaya Sentosa']]).toContain(first!.id);
      expect(again!.id).toBe(first!.id);
    });

    it('empty or whitespace-only names match nothing (no query error)', async () => {
      expect(await match('')).toBeNull();
      expect(await match('   ')).toBeNull();
    });

    it('a name nobody resembles matches nothing', async () => {
      expect(await match('Zzyzx Qwerty')).toBeNull();
    });

    it('sees only the current company\'s vendors (RLS)', async () => {
      expect(await match('Abadi Teknik')).toBeNull();
      expect((await match('Abadi Teknik', B))?.id).toBe(vB['Abadi Teknik']);
      // both companies have a "Sentosa": each sees its own
      expect((await match('Sentosa', A))?.id).toBe(vA['Sentosa']);
      expect(await match('Sentosa', B)).toMatchObject({ id: vB['Sentosa'], defaultCategory: 'subkon' });
    });
  });

  // -------------------------------------------------------------------------------------------
  describe('vendorForName (chat VENDOR: match, else a draft vendor)', () => {
    const forName = (name: string, companyId = A) => withCompany(db, companyId, (tx) => vendorForName(tx, companyId, name));
    const countA = async () => (await withCompany(db, A, (tx) => tx.select({ id: vendors.id }).from(vendors))).length;

    it('returns the matching vendor and creates nothing', async () => {
      const before = await countA();
      const v = await forName('makmur');
      expect(v).toMatchObject({ id: vA['Makmur'], name: 'Makmur', defaultCategory: 'alat' });
      expect(await countA()).toBe(before);
    });

    it('an unknown name creates exactly one draft vendor with the cleaned name', async () => {
      const before = await countA();
      const v = await forName('  UD   Cahaya   Baru ');
      expect(v).toMatchObject({ name: 'UD Cahaya Baru', defaultCategory: null, similarity: 1 });
      const rows = await vendorsNamed(A, 'UD Cahaya Baru');
      expect(rows).toHaveLength(1);
      expect(rows[0]).toMatchObject({ id: v.id, companyId: A, status: 'draft', npwp: null, bankAccount: null });
      expect(await countA()).toBe(before + 1);
    });

    it('is idempotent: the same name (any spacing/case) returns the same draft and creates no second one', async () => {
      const first = await forName('Bengkel Las Pelangi');
      const before = await countA();
      const second = await forName('Bengkel Las Pelangi');
      const third = await forName('  bengkel   las PELANGI ');
      expect(second.id).toBe(first.id);
      expect(third.id).toBe(first.id);
      expect(await countA()).toBe(before);
      expect(await vendorsNamed(A, 'Bengkel Las Pelangi')).toHaveLength(1);
    });

    it('a name that exists only in another company creates this company\'s own draft and leaves the other untouched', async () => {
      const v = await forName('Abadi Teknik');
      expect(v.id).not.toBe(vB['Abadi Teknik']);
      expect(await vendorsNamed(A, 'Abadi Teknik')).toMatchObject([{ companyId: A, status: 'draft' }]);
      expect(await vendorsNamed(B, 'Abadi Teknik')).toMatchObject([{ id: vB['Abadi Teknik'], companyId: B, status: 'active', defaultCategory: 'upah' }]);
    });

    it('never creates a draft vendor with a blank name', async () => {
      // admin PATCH accepts vendorName "  " (z.string().min(2)); a blank name must not become a master vendor
      await withCompany(db, A, (tx) => vendorForName(tx, A, '   ')).catch(() => null);
      const blank = (await withCompany(db, A, (tx) => tx.select({ id: vendors.id, name: vendors.name }).from(vendors)))
        .filter((v) => v.name.trim() === '');
      expect(blank).toEqual([]);
    });
  });

  // -------------------------------------------------------------------------------------------
  describe('applyChanges', () => {
    let totalSeq = 0;
    /** distinct totals, so confirmed rows of different tests never collide on the vendor/date/total fence */
    const nextTotal = () => 300_000_000 + (++totalSeq) * 1_000_000;

    interface Seed {
      companyId?: number; siteId?: number;
      vendorId?: number | null; vendorName?: string | null; invoiceDate?: string | null; category?: Category | null;
      dppCents?: number | null; ppnCents?: number | null; totalCents?: number;
      status?: VendorInvoiceStatus; flags?: string[]; docNumber?: string | null;
    }
    async function seedRow(s: Seed = {}): Promise<{ id: number; rowId: string; totalCents: number }> {
      const companyId = s.companyId ?? A;
      const flags = s.flags ?? [];
      const totalCents = s.totalCents ?? nextTotal();
      const confidence: IntakeReview = {
        fields: { total: 0.95, vendor_name: 0.9 },
        flags,
        missing: [],
        nearDuplicates: flags.includes('near_duplicate') ? [{ rowId: randomUUID(), distance: 3 }] : [],
        extracted: { subtotalCents: s.dppCents ?? null, ppnCents: s.ppnCents ?? null, itemsCents: null },
      };
      const status = s.status ?? statusFor(flags);
      return withCompany(db, companyId, async (tx) => {
        const [r] = await tx.insert(vendorInvoices).values({
          companyId,
          siteId: s.siteId ?? (companyId === A ? sA1 : sB),
          vendorId: s.vendorId === undefined ? null : s.vendorId,
          vendorName: s.vendorName === undefined ? 'Sentosa' : s.vendorName,
          invoiceDate: s.invoiceDate === undefined ? '2026-10-05' : s.invoiceDate,
          category: s.category === undefined ? 'material' : s.category,
          dppCents: s.dppCents ?? null,
          ppnCents: s.ppnCents ?? null,
          totalCents,
          docNumber: s.docNumber ?? null,
          status,
          source: 'telegram',
          confidence,
          confirmedAt: status === 'terkonfirmasi' ? new Date('2026-10-10T00:00:00Z') : null,
          confirmedBy: status === 'terkonfirmasi' ? admin : null,
        }).returning({ id: vendorInvoices.id, rowId: vendorInvoices.rowId });
        return { id: r!.id, rowId: r!.rowId, totalCents };
      });
    }

    interface Opts { channel: Channel; companyId?: number; siteIds?: number[] | null; userId?: number }
    function apply(rowId: string, changes: Change[], o: Opts): Promise<ApplyResult> {
      const userId = o.userId ?? (o.channel === 'chat' ? staff : admin);
      return withCompany(db, { companyId: o.companyId ?? A, userId, siteIds: o.siteIds ?? null }, (tx) =>
        applyChanges(tx, rowId, changes, { channel: o.channel, userId, today: TODAY }));
    }
    async function load(rowId: string, companyId = A): Promise<VendorInvoiceRow> {
      const [r] = await withCompany(db, companyId, (tx) => tx.select().from(vendorInvoices).where(eq(vendorInvoices.rowId, rowId)));
      if (!r) throw new Error(`row ${rowId} not found`);
      return r;
    }
    function expectOk(r: ApplyResult): VendorInvoiceRow {
      if (!r.ok) throw new Error(`expected ok, got ${JSON.stringify({ reason: r.reason, flags: r.flags })}`);
      return r.row;
    }
    const OK: Change = { field: 'status', value: 'terkonfirmasi' };
    const TOLAK: Change = { field: 'status', value: 'ditolak' };

    describe('row lookup', () => {
      it('an unknown row id is not_found on both channels', async () => {
        for (const channel of ['chat', 'admin'] as const) {
          expect(await apply(randomUUID(), [{ field: 'docNumber', value: 'X' }], { channel })).toEqual({ ok: false, reason: 'not_found' });
        }
      });

      it('a row of another company is not_found (RLS) and stays unchanged', async () => {
        const b = await seedRow({ companyId: B, vendorName: 'Abadi Teknik', category: null, flags: ['kategori_kosong'] });
        const r = await apply(b.rowId, [{ field: 'category', value: 'alat' }], { channel: 'admin' });
        expect(r).toEqual({ ok: false, reason: 'not_found' });
        expect((await load(b.rowId, B)).category).toBeNull();
      });

      it('a row at a site outside the caller\'s site scope is not_found', async () => {
        const row = await seedRow({ siteId: sA2 });
        expect(await apply(row.rowId, [{ field: 'docNumber', value: 'INV-9' }], { channel: 'chat', siteIds: [sA1] }))
          .toEqual({ ok: false, reason: 'not_found' });
        expect((await load(row.rowId)).docNumber).toBeNull();
      });
    });

    describe('closed rows (terkonfirmasi / ditolak)', () => {
      it.each(['terkonfirmasi', 'ditolak'] as const)('chat may not change a %s row: closed, nothing written', async (status) => {
        const row = await seedRow({ vendorId: vA['Sentosa']!, status });
        const before = await load(row.rowId);
        for (const ch of [{ field: 'category', value: 'alat' }, { field: 'docNumber', value: 'INV-1' }, OK, TOLAK] as Change[]) {
          const r = await apply(row.rowId, [ch], { channel: 'chat' });
          expect(r).toMatchObject({ ok: false, reason: 'closed' });
        }
        const after = await load(row.rowId);
        expect(after).toMatchObject({ status, category: 'material', docNumber: null, updatedAt: before.updatedAt });
      });

      it('admin may fix data on a confirmed row; it stays confirmed with its confirmation stamp', async () => {
        const row = await seedRow({ vendorId: vA['Sentosa']!, status: 'terkonfirmasi' });
        const out = expectOk(await apply(row.rowId, [{ field: 'docNumber', value: 'INV-77' }, { field: 'category', value: 'alat' }], { channel: 'admin' }));
        expect(out).toMatchObject({ status: 'terkonfirmasi', docNumber: 'INV-77', category: 'alat', confirmedBy: admin });
        expect(out.confirmedAt?.toISOString()).toBe('2026-10-10T00:00:00.000Z');
      });

      it('admin may not reopen or re-decide a closed row through status', async () => {
        const confirmed = await seedRow({ vendorId: vA['Sentosa']!, status: 'terkonfirmasi' });
        const rejected = await seedRow({ status: 'ditolak' });
        expect(await apply(confirmed.rowId, [TOLAK], { channel: 'admin' })).toMatchObject({ ok: false, reason: 'closed' });
        expect(await apply(confirmed.rowId, [OK], { channel: 'admin' })).toMatchObject({ ok: false, reason: 'closed' });
        expect(await apply(rejected.rowId, [OK], { channel: 'admin' })).toMatchObject({ ok: false, reason: 'closed' });
        expect((await load(confirmed.rowId)).status).toBe('terkonfirmasi');
        expect((await load(rejected.rowId)).status).toBe('ditolak');
      });
    });

    describe('OK (confirm)', () => {
      it('chat OK on a row without flags confirms it, stamps who/when and links the master vendor', async () => {
        const row = await seedRow({ vendorId: null, vendorName: 'Sentosa' });
        const out = expectOk(await apply(row.rowId, [OK], { channel: 'chat' }));
        expect(out).toMatchObject({ status: 'terkonfirmasi', vendorId: vA['Sentosa'], vendorName: 'Sentosa', confirmedBy: staff });
        expect(out.confirmedAt).toBeInstanceOf(Date);
        expect(await load(row.rowId)).toMatchObject({ status: 'terkonfirmasi', confirmedBy: staff });
      });

      const chatBlockers: Array<[string, Seed]> = [
        ['field_kosong', { vendorId: null, vendorName: null }],
        ['arith_ppn', { dppCents: 200_000_000, ppnCents: 22_000_000, totalCents: 260_000_000 }],
        ['date_range', { invoiceDate: '2025-06-01' }],
        ['kategori_kosong', { category: null }],
        ['near_duplicate', { flags: ['near_duplicate'] }],
        ['arith_items', { flags: ['arith_items'] }],
      ];
      it.each(chatBlockers)('chat OK is refused while %s remains; the row is unchanged', async (flag, seed) => {
        const row = await seedRow({ ...seed, flags: seed.flags ?? [flag] });
        const before = await load(row.rowId);
        const r = await apply(row.rowId, [OK], { channel: 'chat' });
        expect(r).toMatchObject({ ok: false, reason: 'confirm_blocked' });
        expect(!r.ok && r.flags).toContain(flag);
        const after = await load(row.rowId);
        expect(after.status).toBe(before.status);
        expect(after.confirmedAt).toBeNull();
        expect(after.updatedAt).toEqual(before.updatedAt);
      });

      it.each([
        ['arith_ppn', { dppCents: 200_000_000, ppnCents: 22_000_000, totalCents: 270_000_000 }],
        ['date_range', { invoiceDate: '2025-07-01' }],
        ['near_duplicate', { flags: ['near_duplicate'] }],
        ['arith_items', { flags: ['arith_items'] }],
      ] as Array<[string, Seed]>)('admin (has seen the photo) may confirm despite %s; the flag stays recorded', async (flag, seed) => {
        const row = await seedRow({ ...seed, flags: seed.flags ?? [flag] });
        const out = expectOk(await apply(row.rowId, [OK], { channel: 'admin' }));
        expect(out.status).toBe('terkonfirmasi');
        expect(out.confirmedBy).toBe(admin);
        expect(out.confidence.flags).toContain(flag);
      });

      it.each([
        ['field_kosong', { vendorId: null, vendorName: null, flags: ['field_kosong'] }],
        ['kategori_kosong', { category: null, flags: ['kategori_kosong'] }],
      ] as Array<[string, Seed]>)('admin OK is still refused while %s (missing data) remains', async (flag, seed) => {
        const row = await seedRow(seed);
        const r = await apply(row.rowId, [OK], { channel: 'admin' });
        expect(r).toMatchObject({ ok: false, reason: 'confirm_blocked', flags: [flag] });
        expect((await load(row.rowId)).status).not.toBe('terkonfirmasi');
      });

      it('a blocked confirm writes none of the other changes sent with it', async () => {
        const row = await seedRow({ category: null, flags: ['kategori_kosong'] });
        const r = await apply(row.rowId, [{ field: 'docNumber', value: 'INV-NEW' }, OK], { channel: 'admin' });
        expect(r).toMatchObject({ ok: false, reason: 'confirm_blocked' });
        expect((await load(row.rowId)).docNumber).toBeNull();
      });

      it('a category set in the same request unblocks the confirm', async () => {
        const row = await seedRow({ category: null, flags: ['kategori_kosong'] });
        const out = expectOk(await apply(row.rowId, [{ field: 'category', value: 'upah' }, OK], { channel: 'admin' }));
        expect(out).toMatchObject({ status: 'terkonfirmasi', category: 'upah' });
        expect(out.confidence.flags).toEqual([]);
      });

      it('second fence: a twin of an already confirmed row (same vendor, date, total) is duplicate_confirmed', async () => {
        const total = nextTotal();
        const first = await seedRow({ vendorName: 'Sentosa', totalCents: total, invoiceDate: '2026-09-01' });
        const twin = await seedRow({ vendorName: 'sentosa', totalCents: total, invoiceDate: '2026-09-01' });
        expectOk(await apply(first.rowId, [OK], { channel: 'chat' }));
        const r = await apply(twin.rowId, [OK], { channel: 'chat' });
        expect(r).toMatchObject({ ok: false, reason: 'duplicate_confirmed' });
        expect((await load(twin.rowId)).status).toBe('perlu_konfirmasi');
      });

      it('second fence for a site-scoped sender: a confirmed twin at another site gives duplicate_confirmed, not a raw unique violation', async () => {
        const total = nextTotal();
        await seedRow({ siteId: sA2, vendorId: vA['Sentosa']!, totalCents: total, invoiceDate: '2026-09-02', status: 'terkonfirmasi' });
        const mine = await seedRow({ siteId: sA1, vendorName: 'Sentosa', totalCents: total, invoiceDate: '2026-09-02' });
        // the chat path runs as the sender's membership: site_staff of site 1 only
        let outcome: ApplyResult | { thrown: string };
        try {
          outcome = await apply(mine.rowId, [OK], { channel: 'chat', siteIds: [sA1] });
        } catch (e) {
          outcome = { thrown: String((e as { cause?: unknown })?.cause ?? e) };
        }
        expect(outcome).toMatchObject({ ok: false, reason: 'duplicate_confirmed' });
        expect((await load(mine.rowId)).status).toBe('perlu_konfirmasi');
      });

      it('admin data edits on a confirmed row can never produce two confirmed rows with the same vendor/date/total', async () => {
        const t1 = nextTotal();
        const t2 = nextTotal();
        await seedRow({ vendorId: vA['Sentosa']!, totalCents: t1, invoiceDate: '2026-09-03', status: 'terkonfirmasi' });
        const other = await seedRow({ vendorId: vA['Sentosa']!, totalCents: t2, invoiceDate: '2026-09-03', status: 'terkonfirmasi' });
        let result: ApplyResult | null = null;
        try {
          result = await apply(other.rowId, [{ field: 'totalCents', value: t1 }], { channel: 'admin' });
        } catch {
          result = null; // the partial unique index refused it
        }
        if (result) expect(result).toMatchObject({ ok: false });
        const confirmedTwins = await withCompany(db, A, (tx) => tx.select({ id: vendorInvoices.id }).from(vendorInvoices).where(and(
          eq(vendorInvoices.status, 'terkonfirmasi'), eq(vendorInvoices.vendorId, vA['Sentosa']!),
          eq(vendorInvoices.invoiceDate, '2026-09-03'), eq(vendorInvoices.totalCents, t1),
        )));
        expect(confirmedTwins).toHaveLength(1);
        expect((await load(other.rowId)).totalCents).toBe(t2);
      });
    });

    describe('TOLAK', () => {
      it('chat TOLAK rejects a flagged row (flags do not block a rejection) and stamps no confirmation', async () => {
        const row = await seedRow({ flags: ['near_duplicate'], category: null });
        const out = expectOk(await apply(row.rowId, [TOLAK], { channel: 'chat' }));
        expect(out).toMatchObject({ status: 'ditolak', confirmedAt: null, confirmedBy: null });
      });
    });

    describe('data corrections re-derive flags and status', () => {
      it('TOTAL that fixes subtotal + PPN clears arith_ppn and moves perlu_cek → perlu_konfirmasi', async () => {
        const row = await seedRow({ dppCents: 200_000_000, ppnCents: 22_000_000, totalCents: 250_000_000, flags: ['arith_ppn'] });
        expect((await load(row.rowId)).status).toBe('perlu_cek');
        const out = expectOk(await apply(row.rowId, [{ field: 'totalCents', value: 222_000_000 }], { channel: 'chat' }));
        expect(out).toMatchObject({ totalCents: 222_000_000, status: 'perlu_konfirmasi' });
        expect(out.confidence.flags).toEqual([]);
      });

      it('TOTAL that breaks subtotal + PPN adds arith_ppn and moves the row to perlu_cek', async () => {
        const row = await seedRow({ dppCents: 100_000_000, ppnCents: 11_000_000, totalCents: 111_000_000 });
        const out = expectOk(await apply(row.rowId, [{ field: 'totalCents', value: 121_000_000 }], { channel: 'chat' }));
        expect(out.status).toBe('perlu_cek');
        expect(out.confidence.flags).toEqual(['arith_ppn']);
      });

      it('TANGGAL inside the project window clears date_range; outside it sets date_range', async () => {
        const row = await seedRow({ invoiceDate: '2025-01-01', flags: ['date_range'] });
        const fixed = expectOk(await apply(row.rowId, [{ field: 'invoiceDate', value: '2026-10-01' }], { channel: 'chat' }));
        expect(fixed).toMatchObject({ invoiceDate: '2026-10-01', status: 'perlu_konfirmasi' });
        expect(fixed.confidence.flags).toEqual([]);
        const future = expectOk(await apply(row.rowId, [{ field: 'invoiceDate', value: '2026-12-01' }], { channel: 'chat' }));
        expect(future.status).toBe('perlu_cek');
        expect(future.confidence.flags).toEqual(['date_range']);
      });

      it('KATEGORI clears kategori_kosong; sticky flags and the rest of the review data survive', async () => {
        const row = await seedRow({ category: null, flags: ['kategori_kosong', 'near_duplicate', 'arith_items', 'npwp_format'] });
        const before = await load(row.rowId);
        const out = expectOk(await apply(row.rowId, [{ field: 'category', value: 'alat' }], { channel: 'chat' }));
        expect(out.category).toBe('alat');
        expect(sorted(out.confidence.flags ?? [])).toEqual(['arith_items', 'near_duplicate', 'npwp_format']);
        expect(out.status).toBe('perlu_cek');
        expect(out.confidence.nearDuplicates).toEqual(before.confidence.nearDuplicates);
        expect(out.confidence.fields).toEqual(before.confidence.fields);
        expect(out.confidence.extracted).toEqual(before.confidence.extracted);
      });

      it('NOMOR sets the document number and keeps the status', async () => {
        const row = await seedRow();
        const out = expectOk(await apply(row.rowId, [{ field: 'docNumber', value: 'INV-2026-001' }], { channel: 'chat' }));
        expect(out).toMatchObject({ docNumber: 'INV-2026-001', status: 'perlu_konfirmasi' });
      });

      it('several admin changes in one request are applied together', async () => {
        const row = await seedRow({ vendorId: null, vendorName: null, invoiceDate: null, category: null, flags: ['field_kosong', 'kategori_kosong'] });
        const out = expectOk(await apply(row.rowId, [
          { field: 'vendorName', value: 'Makmur' }, { field: 'category', value: 'material' },
          { field: 'totalCents', value: 123_400_000 }, { field: 'invoiceDate', value: '2026-10-02' }, { field: 'docNumber', value: 'N-5' },
        ], { channel: 'admin' }));
        expect(out).toMatchObject({
          vendorId: vA['Makmur'], vendorName: 'Makmur', category: 'material', totalCents: 123_400_000,
          invoiceDate: '2026-10-02', docNumber: 'N-5', status: 'perlu_konfirmasi',
        });
        expect(out.confidence.flags).toEqual([]);
      });
    });

    describe('vendor changes', () => {
      it('chat VENDOR with a known name links the master vendor and fills its default category when none was set', async () => {
        const row = await seedRow({ vendorName: 'Toko Tak Dikenal', category: null, flags: ['kategori_kosong'] });
        const out = expectOk(await apply(row.rowId, [{ field: 'vendorName', value: 'makmur' }], { channel: 'chat' }));
        expect(out).toMatchObject({ vendorId: vA['Makmur'], vendorName: 'Makmur', category: 'alat', status: 'perlu_konfirmasi' });
        expect(out.confidence.flags).toEqual([]);
      });

      it('chat VENDOR keeps a category that was already set', async () => {
        const row = await seedRow({ category: 'subkon' });
        const out = expectOk(await apply(row.rowId, [{ field: 'vendorName', value: 'Makmur' }], { channel: 'chat' }));
        expect(out).toMatchObject({ vendorId: vA['Makmur'], category: 'subkon' });
      });

      it('chat VENDOR with an unknown name creates one draft vendor, reused by the next correction with that name', async () => {
        const r1 = await seedRow({ vendorName: null, vendorId: null, flags: ['field_kosong'] });
        const r2 = await seedRow({ vendorName: null, vendorId: null, flags: ['field_kosong'] });
        const a = expectOk(await apply(r1.rowId, [{ field: 'vendorName', value: 'PT Baja Ringan Nusantara' }], { channel: 'chat' }));
        const b = expectOk(await apply(r2.rowId, [{ field: 'vendorName', value: 'pt baja ringan nusantara' }], { channel: 'chat' }));
        const drafts = await vendorsNamed(A, 'PT Baja Ringan Nusantara');
        expect(drafts).toMatchObject([{ status: 'draft', companyId: A }]);
        expect(a.vendorId).toBe(drafts[0]!.id);
        expect(b.vendorId).toBe(drafts[0]!.id);
        expect(a.confidence.flags).toEqual([]);
        expect(a.status).toBe('perlu_konfirmasi');
      });

      it('admin vendorId of the own company links it and takes the master name', async () => {
        const row = await seedRow({ vendorName: 'CV S. Rejeki', category: null, flags: ['kategori_kosong'] });
        const out = expectOk(await apply(row.rowId, [{ field: 'vendorId', value: vA['CV Sumber Rejeki']! }], { channel: 'admin' }));
        expect(out).toMatchObject({ vendorId: vA['CV Sumber Rejeki'], vendorName: 'CV Sumber Rejeki', category: 'operasional' });
      });

      it('admin vendorId of another company is not_found through RLS and changes nothing', async () => {
        const row = await seedRow({ vendorName: 'Abadi Teknik', category: null, flags: ['kategori_kosong'] });
        const r = await apply(row.rowId, [{ field: 'vendorId', value: vB['Abadi Teknik']! }, { field: 'docNumber', value: 'X-1' }], { channel: 'admin' });
        expect(r).toEqual({ ok: false, reason: 'not_found' });
        expect(await load(row.rowId)).toMatchObject({ vendorId: null, vendorName: 'Abadi Teknik', category: null, docNumber: null });
      });

      it('admin vendorId that does not exist at all is not_found', async () => {
        const row = await seedRow();
        expect(await apply(row.rowId, [{ field: 'vendorId', value: 9_999_999 }], { channel: 'admin' })).toEqual({ ok: false, reason: 'not_found' });
      });
    });

    describe('audit trail', () => {
      const updates = (id: number) => withCompany(db, A, (tx) => tx.select().from(auditLogs).where(and(
        eq(auditLogs.auditableType, 'vendor_invoices'), eq(auditLogs.auditableId, id), eq(auditLogs.action, 'update'),
      )));

      it('every applied correction leaves an audit row with the acting user and the before/after values', async () => {
        const row = await seedRow({ category: null, flags: ['kategori_kosong'] });
        expectOk(await apply(row.rowId, [{ field: 'category', value: 'material' }], { channel: 'chat' }));
        const logs = await updates(row.id);
        expect(logs).toHaveLength(1);
        expect(logs[0]).toMatchObject({ companyId: A, userId: staff });
        expect((logs[0]!.before as { category: string | null }).category).toBeNull();
        expect((logs[0]!.after as { category: string | null }).category).toBe('material');
      });

      it('a refused correction (closed row) writes nothing', async () => {
        const row = await seedRow({ vendorId: vA['Sentosa']!, status: 'terkonfirmasi' });
        await apply(row.rowId, [{ field: 'category', value: 'alat' }], { channel: 'chat' });
        expect(await updates(row.id)).toEqual([]);
      });
    });
  });
});
