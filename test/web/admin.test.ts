import { describe, expect, it } from 'vitest';
import { chatBody, companyBody, companyFormOf, companyPatchOf, emptyChat, npwpDigits, userFormOf, userPatchOf } from '../../web/src/lib/admin.js';
import type { AdminCompany, AdminUser } from '../../web/src/lib/types.js';

const company: AdminCompany = {
  id: 3, code: 'PII', name: 'PT Prima Infra', npwp: '012345678901000', address: 'Jl. Sentani 1', bankName: null, bankAccount: null, logoPath: null, docPrefix: null,
};
const user: AdminUser = { id: 5, email: 'mgr@demo.test', name: 'Manager', phone: null, telegramUserId: 777001, isActive: true, isSystemAdmin: false };

describe('company form', () => {
  it('NPWP as written with dots and dashes is stored as its digits', () => {
    expect(npwpDigits('01.234.567.8-901.000')).toBe('012345678901000');
    expect(npwpDigits('0123456789010000')).toBe('0123456789010000'); // 16 digits (NIK-based)
    expect(npwpDigits('')).toBe('');
    expect(npwpDigits('01.234.567')).toBeNull();
  });

  it('new company: code upper-cased and checked, empty optional fields not sent, a first manager by email', () => {
    const f = { ...companyFormOf(), code: ' krm2 ', name: 'PT Keerom Raya', npwp: '01.234.567.8-901.000', managerEmail: 'mgr@demo.test' };
    expect(companyBody(f)).toEqual({ ok: true, body: { code: 'KRM2', name: 'PT Keerom Raya', npwp: '012345678901000', managerEmail: 'mgr@demo.test' } });
    expect(companyBody({ ...f, code: 'K' }).ok).toBe(false);
    expect(companyBody({ ...f, code: 'KRM-1' }).ok).toBe(false);
    expect(companyBody({ ...f, bankAccount: '12' })).toEqual({ ok: false, error: 'Nomor rekening 5–40 angka (tanda hubung boleh).' });
    expect(companyBody({ ...f, managerEmail: 'not-an-email' }).ok).toBe(false);
  });

  it('patch: only what changed; a stored field cannot be emptied through the API', () => {
    const f = { ...companyFormOf(company), bankName: 'Bank Papua', bankAccount: '123-456-789' };
    expect(companyPatchOf(company, f)).toEqual({ ok: true, body: { bankName: 'Bank Papua', bankAccount: '123-456-789' } });
    expect(companyPatchOf(company, companyFormOf(company))).toEqual({ ok: false, error: 'Tidak ada perubahan.' });
    expect(companyPatchOf(company, { ...companyFormOf(company), address: '' })).toEqual({ ok: false, error: 'Alamat tidak bisa dikosongkan dari sini.' });
    // the same NPWP typed with separators is not a change
    expect(companyPatchOf(company, { ...companyFormOf(company), npwp: '01.234.567.8-901.000', name: 'PT Prima Infra Baru' }))
      .toEqual({ ok: true, body: { name: 'PT Prima Infra Baru' } });
  });
});

describe('user form', () => {
  it('changed fields only; an emptied phone or Telegram id unlinks (null)', () => {
    expect(userPatchOf(user, { ...userFormOf(user), phone: '+62 811 000 111' })).toEqual({ ok: true, body: { phone: '+62 811 000 111' } });
    expect(userPatchOf(user, { ...userFormOf(user), telegramUserId: '' })).toEqual({ ok: true, body: { telegramUserId: null } });
    expect(userPatchOf(user, { ...userFormOf(user), telegramUserId: '-5' }).ok).toBe(false);
    expect(userPatchOf(user, { ...userFormOf(user), name: 'M' }).ok).toBe(false);
    expect(userPatchOf(user, userFormOf(user))).toEqual({ ok: false, error: 'Tidak ada perubahan.' });
  });
});

describe('Telegram group form', () => {
  it('a group chat id (negative) mapped to a company and site', () => {
    const f = { ...emptyChat(), chatId: ' -1001234567890 ', companyId: '3', siteId: '7', title: 'Nota Keerom' };
    expect(chatBody(f)).toEqual({ ok: true, body: { chatId: -1001234567890, companyId: 3, siteId: 7, title: 'Nota Keerom' } });
    expect(chatBody({ ...f, chatId: '0' }).ok).toBe(false);
    expect(chatBody({ ...f, chatId: '-100abc' }).ok).toBe(false);
    expect(chatBody({ ...f, chatId: '-99999999999999999' }).ok).toBe(false); // beyond a safe integer
    expect(chatBody({ ...f, siteId: '' })).toEqual({ ok: false, error: 'Pilih lokasi.' });
  });
});
