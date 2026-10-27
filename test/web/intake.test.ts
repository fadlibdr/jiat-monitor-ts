import { describe, expect, it } from 'vitest';
import { wibStamp } from '../../src/domain/date.js';
import { errorMessage } from '../../web/src/lib/errors.js';
import { editMode, formOf, listedIn, patchOf } from '../../web/src/lib/intake.js';
import { match } from '../../web/src/lib/match.js';
import type { IntakeRow } from '../../web/src/lib/types.js';

const row: IntakeRow = {
  rowId: '0b2c9a52-1ec8-4c1e-9d3a-7d1f2e0a1ec8', siteId: 1, vendorId: 7, vendorName: 'PT Sumber Beton', npwp: null,
  invoiceDate: '2026-10-20', dueDate: '2026-11-03', docNumber: 'INV-1024', description: null, category: 'material',
  dppCents: null, ppnCents: null, totalCents: 245_000_000, status: 'perlu_konfirmasi', source: 'telegram',
  confidence: {}, poId: null, grId: null,
};

describe('review form → PATCH body', () => {
  it('an untouched form sends nothing', () => {
    expect(patchOf(row, formOf(row))).toEqual({});
  });

  it('sends only what changed', () => {
    expect(patchOf(row, { ...formOf(row), docNumber: ' INV-1025 ', total: '2.500.000' })).toEqual({ docNumber: 'INV-1025', totalCents: '2.500.000' });
    expect(patchOf(row, { ...formOf(row), vendorId: '9' })).toEqual({ vendorId: 9 });
    expect(patchOf({ ...row, vendorId: null }, { ...formOf(row), vendorId: '', vendorName: 'CV Baru' })).toEqual({ vendorName: 'CV Baru' });
  });

  it('a cleared due date is sent as null (server: nota date + vendor term); an unset one stays unsent', () => {
    expect(patchOf(row, { ...formOf(row), dueDate: '' })).toEqual({ dueDate: null });
    expect(patchOf({ ...row, dueDate: null }, { ...formOf(row), dueDate: '' })).toEqual({});
    expect(patchOf({ ...row, dueDate: null }, { ...formOf(row), dueDate: '2026-12-01' })).toEqual({ dueDate: '2026-12-01' });
  });

  it('other emptied fields are not sent (the API cannot blank them)', () => {
    expect(patchOf(row, { ...formOf(row), docNumber: '', total: '', invoiceDate: '', category: '' })).toEqual({});
  });
});

describe('which list a row belongs to, and what may be done with it', () => {
  it('"Terbuka" holds both open statuses; other tabs exactly their own', () => {
    expect(listedIn(undefined, 'perlu_cek')).toBe(true);
    expect(listedIn(undefined, 'perlu_konfirmasi')).toBe(true);
    expect(listedIn(undefined, 'terkonfirmasi')).toBe(false);
    expect(listedIn('perlu_cek', 'perlu_konfirmasi')).toBe(false);
    expect(listedIn('terkonfirmasi', 'terkonfirmasi')).toBe(true);
  });

  it('open rows: everything; confirmed: data fixes only (as the server allows); rejected and finance: read only', () => {
    expect(editMode('perlu_cek', true)).toBe('full');
    expect(editMode('terkonfirmasi', true)).toBe('fix');
    expect(editMode('ditolak', true)).toBe('none');
    expect(editMode('perlu_konfirmasi', false)).toBe('none');
    expect(editMode('terkonfirmasi', false)).toBe('none');
  });
});

describe('error messages shown to the user', () => {
  it('the JSON message first, then a short plain-text body (HTTPException), then a text per status', () => {
    expect(errorMessage(409, 'application/json', '', { error: 'closed', message: 'Nota sudah ditutup.' })).toBe('Nota sudah ditutup.');
    expect(errorMessage(400, 'text/plain; charset=UTF-8', 'total tidak terbaca', null)).toBe('total tidak terbaca');
    expect(errorMessage(404, 'text/plain', 'Vendor tidak ditemukan.', null)).toBe('Vendor tidak ditemukan.');
    expect(errorMessage(404, 'application/json', '{}', {})).toBe('Data tidak ditemukan.');
    expect(errorMessage(418, null, '', null)).toBe('Permintaan gagal (418).');
  });

  it('never shows a proxy\'s HTML page or a long body', () => {
    expect(errorMessage(502, 'text/html', '<html><body>502 Bad Gateway</body></html>', null)).toBe('Permintaan gagal (502).');
    expect(errorMessage(500, 'text/plain', 'x'.repeat(301), null)).toBe('Permintaan gagal (500).');
    expect(errorMessage(500, 'text/plain', 'x'.repeat(300), null)).toBe('x'.repeat(300));
  });
});

describe('route matching', () => {
  it('extracts and decodes parameters', () => {
    expect(match('/c/:companyId/:view', '/c/3/intake')).toEqual({ companyId: '3', view: 'intake' });
    expect(match('/c/:companyId', '/c/a%20b')).toEqual({ companyId: 'a b' });
    expect(match('/c/:companyId', '/c/3/intake')).toBeNull();
    expect(match('/holding', '/c')).toBeNull();
  });

  it('a malformed escape is no match (NotFound), not a crash of the whole app', () => {
    expect(match('/c/:companyId', '/c/%')).toBeNull();
    expect(match('/c/:companyId', '/c/%E0%A4%A')).toBeNull();
  });
});

describe('WIB stamp (export "Data per")', () => {
  it('is WIB wall-clock time, across the UTC midnight', () => {
    expect(wibStamp(new Date('2026-10-26T23:30:00Z'))).toBe('2026-10-27 06:30 WIB');
    expect(wibStamp(new Date('2026-10-27T16:59:00Z'))).toBe('2026-10-27 23:59 WIB');
    expect(wibStamp(new Date('2026-10-27T17:00:00Z'))).toBe('2026-10-28 00:00 WIB');
  });
});
