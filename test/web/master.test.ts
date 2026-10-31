import { describe, expect, it } from 'vitest';
import { parseIdrCents as serverParse } from '../../src/domain/money.js';
import { EDIT_ROLES as S_EDIT, FINANCE_ROLES as S_FINANCE, MANAGE_ROLES as S_MANAGE } from '../../src/http/context.js';
import { bpInput, changedText, decimalCents, parseDays, parseIdrCents, parsePercentBp, parseSignedRupiah } from '../../web/src/lib/forms.js';
import { qtyLabel } from '../../web/src/lib/format.js';
import {
  addendumBody, contractBody, contractFormOf, contractPatchOf, siteBody, siteFormOf, sitePatchOf, termRowsOf, termsBody,
  vendorBody, vendorFormOf, vendorPatchOf,
} from '../../web/src/lib/master.js';
import { DASHBOARD_ROLES, EDIT_ROLES, FINANCE_ROLES, MANAGE_ROLES, REVIEW_ROLES, VENDOR_WRITE_ROLES } from '../../web/src/lib/roles.js';
import type { Contract, Site, Vendor } from '../../web/src/lib/types.js';

const RP = 100;
const sorted = (xs: readonly string[]) => [...xs].sort();

describe('UI role sets mirror the server', () => {
  it('edit, finance, manage; review = edit ∪ finance; vendor writers = edit ∪ finance; dashboard = finance', () => {
    expect(sorted(EDIT_ROLES)).toEqual(sorted(S_EDIT));
    expect(sorted(FINANCE_ROLES)).toEqual(sorted(S_FINANCE));
    expect(sorted(MANAGE_ROLES)).toEqual(sorted(S_MANAGE));
    const editOrFinance = sorted([...new Set([...S_EDIT, ...S_FINANCE])]);
    expect(sorted(REVIEW_ROLES)).toEqual(editOrFinance);
    expect(sorted(VENDOR_WRITE_ROLES)).toEqual(editOrFinance);
    expect(sorted(DASHBOARD_ROLES)).toEqual(sorted(S_FINANCE));
  });
});

describe('form input → API values', () => {
  it('reads rupiah exactly as the API does (it is the same parser)', () => {
    for (const s of ['8.150.000.000', 'Rp 2.450.000,-', '2,5', '245.50', '1.234.56', '', 'abc']) expect(parseIdrCents(s)).toBe(serverParse(s));
    expect(parseIdrCents('8.150.000.000')).toBe(8_150_000_000 * RP);
  });

  it('signed rupiah for addenda; percent → basis points and back; days', () => {
    expect(parseSignedRupiah('-250.000.000')).toBe(-250_000_000 * RP);
    expect(parseSignedRupiah('−Rp 1.000.000')).toBe(-1_000_000 * RP);
    expect(parseSignedRupiah('1.200.000.000')).toBe(1_200_000_000 * RP);
    expect(parseSignedRupiah('-')).toBeNull();
    expect([parsePercentBp('11'), parsePercentBp('5,5'), parsePercentBp('2.25'), parsePercentBp('100'), parsePercentBp('0')]).toEqual([1100, 550, 225, 10_000, 0]);
    expect([parsePercentBp('100,01'), parsePercentBp('5,555'), parsePercentBp('-1'), parsePercentBp('')]).toEqual([null, null, null, null]);
    for (const bp of [0, 1, 550, 1025, 1100, 10_000]) expect(parsePercentBp(bpInput(bp))).toBe(bp);
    expect([bpInput(550), bpInput(1100), bpInput(1025)]).toEqual(['5,5', '11', '10,25']);
    expect([parseDays(''), parseDays('30'), parseDays('365'), parseDays('366'), parseDays('3,5')]).toEqual([null, 30, 365, undefined, undefined]);
  });

  it('API decimal money and BOQ volumes, shown the Indonesian way', () => {
    expect([decimalCents('207600050.00'), decimalCents('-1.5'), decimalCents('12,5'), decimalCents('')]).toEqual([207_600_050 * RP, -150, null, null]);
    expect([qtyLabel('26.0000'), qtyLabel('1250.5000'), qtyLabel('100'), qtyLabel('0.0050'), qtyLabel(null), qtyLabel('-2.5000')])
      .toEqual(['26', '1.250,5', '100', '0,005', '', '−2,5']);
  });

  it('changedText: only changed fields; an emptied one is null where the API can clear it', () => {
    const stored = { phone: '0812', name: 'A', location: null };
    expect(changedText(stored, { phone: '0812', name: 'B', location: '' }, ['phone', 'name', 'location'])).toEqual({ name: 'B' });
    expect(changedText(stored, { phone: '', name: 'A', location: '' }, ['phone', 'name', 'location'], ['phone'])).toEqual({ phone: null });
    expect(changedText(stored, { phone: '', name: 'A', location: '' }, ['phone', 'name', 'location'])).toEqual({});
  });
});

const site: Site = { id: 1, code: 'KRM', name: 'JIAT Keerom', location: null, province: 'Papua', startDate: '2026-02-01', endDate: null, status: 'active' };

describe('sites', () => {
  it('create: code upper-cased and checked, optional fields only when filled', () => {
    expect(siteBody({ ...siteFormOf(), code: 'krm-2', name: 'Keerom 2' })).toEqual({ ok: true, body: { code: 'KRM-2', name: 'Keerom 2' } });
    expect(siteBody({ ...siteFormOf(), code: 'KRM 2', name: 'Keerom' }).ok).toBe(false);
    expect(siteBody({ ...siteFormOf(), code: 'KRM', name: 'Keerom', startDate: '2026-05-01', endDate: '2026-04-01' }).ok).toBe(false);
  });

  it('edit: only what changed, never the code; nothing changed is said so', () => {
    expect(sitePatchOf(site, { ...siteFormOf(site), code: 'XXX', location: 'Arso', status: 'closed' })).toEqual({ ok: true, body: { location: 'Arso', status: 'closed' } });
    expect(sitePatchOf(site, siteFormOf(site))).toEqual({ ok: false, error: 'Tidak ada perubahan.' });
  });
});

const vendor: Vendor = {
  id: 7, name: 'PT Sumber Beton', npwp: '012345678901234', bankName: 'BRI', bankAccount: '1234-5678', phone: '0812 3456',
  defaultCategory: 'material', paymentTermsDays: 14, status: 'draft',
};

describe('vendors', () => {
  it('bank and NPWP are sent only by finance / managers', () => {
    const f = { ...vendorFormOf(), name: '  CV  Baru ', npwp: '012345678901234', bankAccount: '99999' };
    expect(vendorBody(f, true)).toEqual({ ok: true, body: { name: 'CV Baru', npwp: '012345678901234', bankAccount: '99999' } });
    expect(vendorBody(f, false)).toEqual({ ok: true, body: { name: 'CV Baru' } });
    expect(vendorBody({ ...f, npwp: '01.234.567' }, true).ok).toBe(false);
  });

  it('edit: clears with null, confirms a draft vendor, terms emptied back to the default', () => {
    const f = { ...vendorFormOf(vendor), phone: '', status: 'active' as const, paymentTermsDays: '' };
    expect(vendorPatchOf(vendor, f, false)).toEqual({ ok: true, body: { status: 'active', phone: null, paymentTermsDays: null } });
    expect(vendorPatchOf(vendor, { ...vendorFormOf(vendor), bankAccount: '' }, true)).toEqual({ ok: true, body: { bankAccount: null } });
    // a role that cannot see the bank data never sends it, even if the (hidden) field differs
    expect(vendorPatchOf({ ...vendor, bankAccount: null }, { ...vendorFormOf(vendor) }, false)).toEqual({ ok: false, error: 'Tidak ada perubahan.' });
  });
});

const contract: Contract = {
  id: 3, siteId: 1, number: 'HK.02.03/JIAT-KRM/2026', employerName: 'BWS Papua', valueDppCents: 8_150_000_000 * RP, ppnRateBp: 1100,
  retentionBp: 500, advanceCents: 0, signedAt: '2026-01-20', startDate: '2026-02-01', endDate: '2027-01-31', status: 'active',
  valueDppEffectiveCents: 9_350_000_000 * RP, addendumDeltaCents: 1_200_000_000 * RP, valueTotalCents: 0, endDateEffective: '2027-03-31', daysLeft: 150,
};

describe('contracts', () => {
  it('create: money and percent read like the API; advance above DPP refused', () => {
    const f = { ...contractFormOf(), siteId: '1', number: 'K-1', employerName: 'BWS Papua', valueDpp: '8.150.000.000', retention: '5', advance: '815.000.000' };
    expect(contractBody(f)).toEqual({ ok: true, body: {
      siteId: 1, number: 'K-1', employerName: 'BWS Papua', valueDppCents: 8_150_000_000 * RP, ppnRateBp: 1100, retentionBp: 500, advanceCents: 815_000_000 * RP, status: 'active',
    } });
    expect(contractBody({ ...f, advance: '9.000.000.000' })).toEqual({ ok: false, error: 'Uang muka melebihi nilai DPP kontrak.' });
    expect(contractBody({ ...f, valueDpp: '245.50' }).ok).toBe(false);
    expect(contractBody({ ...f, siteId: '' }).ok).toBe(false);
  });

  it('edit: never the DPP; the advance is checked against the DPP in force (addenda included)', () => {
    const f = contractFormOf(contract);
    expect(contractPatchOf(contract, { ...f, valueDpp: '1', retention: '2,5' })).toEqual({ ok: true, body: { retentionBp: 250 } });
    // 9 M is above the signed 8,15 M but within the 9,35 M in force
    expect(contractPatchOf(contract, { ...f, advance: '9.000.000.000' })).toEqual({ ok: true, body: { advanceCents: 9_000_000_000 * RP } });
    expect(contractPatchOf(contract, f)).toEqual({ ok: false, error: 'Tidak ada perubahan.' });
  });
});

describe('termin schedule', () => {
  it('rows in screen order become seq 1..n; Σ > 100 % and a falling trigger are refused', () => {
    const rows = [{ name: 'Uang muka', percent: '20', trigger: '0', dueDays: '30' }, { name: 'Termin 1', percent: '80', trigger: '100', dueDays: '14' }];
    expect(termsBody(rows)).toEqual({ ok: true, body: [
      { seq: 1, name: 'Uang muka', percentBp: 2000, triggerProgressBp: 0, dueDays: 30 },
      { seq: 2, name: 'Termin 1', percentBp: 8000, triggerProgressBp: 10_000, dueDays: 14 },
    ] });
    expect(termsBody([...rows, { name: 'X', percent: '1', trigger: '100', dueDays: '0' }])).toEqual({ ok: false, error: 'Jumlah persen termin 101% melebihi 100%.' });
    expect(termsBody([rows[1]!, rows[0]!]).ok).toBe(false);
    expect(termsBody([])).toEqual({ ok: true, body: [] });
    // round trip from the stored schedule
    expect(termsBody(termRowsOf([{ id: 9, seq: 1, name: 'T1', percentBp: 3000, triggerProgressBp: 2500, dueDays: 30 }]))).toEqual({
      ok: true, body: [{ seq: 1, name: 'T1', percentBp: 3000, triggerProgressBp: 2500, dueDays: 30 }],
    });
  });
});

describe('addenda', () => {
  it('a negative change is allowed; one that changes nothing is refused', () => {
    expect(addendumBody({ number: 'ADD-1', signedAt: '2026-06-01', delta: '-250.000.000', endDateNew: '', note: '' }))
      .toEqual({ ok: true, body: { number: 'ADD-1', signedAt: '2026-06-01', valueDeltaCents: -250_000_000 * RP } });
    expect(addendumBody({ number: 'ADD-2', signedAt: '2026-06-01', delta: '', endDateNew: '2027-03-31', note: ' waktu ' }))
      .toEqual({ ok: true, body: { number: 'ADD-2', signedAt: '2026-06-01', endDateNew: '2027-03-31', note: 'waktu' } });
    expect(addendumBody({ number: 'ADD-3', signedAt: '2026-06-01', delta: '0', endDateNew: '', note: '' }).ok).toBe(false);
  });
});
