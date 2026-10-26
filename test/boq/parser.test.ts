import ExcelJS from 'exceljs';
import { describe, expect, it } from 'vitest';
import { BoqImportError } from '../../src/boq/errors.js';
import { intToRoman, parseBoqWorkbook, parseRows, romanToInt } from '../../src/boq/parser.js';

const HEADER = [
  ['KEMENTERIAN X'], ['Kegiatan: JIAT'], [],
  ['No', 'Uraian Pekerjaan', 'Satuan', 'Volume', 'Harga Satuan (Rp)', 'Jumlah (Rp)'],
];
type Row = Array<string | number | null>;
const sheet = (rows: Row[]): Row[] => [...HEADER, ...rows];

// Synthetic RAPI-like fixture ported from BoqImporterTest.php.
const RAPI: Row[] = [
  ['I', 'PEKERJAAN PERSIAPAN', null, null, null, null],
  ['1', 'Mobilisasi', 'LS', 1, 5_000_000, 5_000_000],
  ['2', 'Pengukuran', 'titik', 26, 100_000, 2_600_000],
  ['II', 'PEKERJAAN SUMUR', null, null, null, null],
  ['A', 'Pengeboran', null, null, null, null],
  ['1', 'Bor 100 m', 'm', 100, 1_250_000.5, 125_000_050],
  ['2', 'Casing', 'm', 50, 300_000, 15_000_000],
  ['B', 'Pompa', null, null, null, null],
  ['1', 'Pompa submersible', 'unit', 2, 30_000_000, 60_000_000],
  [null, 'Jumlah', null, null, null, 207_600_050],
  [null, 'PPN 11%', null, null, null, 22_836_005.5],
];

describe('parseRows — tree, codes, totals', () => {
  it('builds full-path codes, levels and parents from Roman > letter > number sections', () => {
    const p = parseRows(sheet(RAPI));
    expect(p.items.map((i) => [i.code, i.level, i.isLeaf])).toEqual([
      ['I', 0, false], ['I.1', 1, true], ['I.2', 1, true],
      ['II', 0, false], ['II.A', 1, false], ['II.A.1', 2, true], ['II.A.2', 2, true],
      ['II.B', 1, false], ['II.B.1', 2, true],
    ]);
    expect(p.items.find((i) => i.code === 'II.A.1')?.codePrinted).toBe('1');
    expect(p.totalCents).toBe(207_600_050_00);
    expect(p.footers).toHaveLength(2);
    expect(p.anomalies).toEqual([]);
  });

  it('rolls leaf amounts up into parents and keeps the printed cent', () => {
    const p = parseRows(sheet(RAPI));
    const by = Object.fromEntries(p.items.map((i) => [i.code, i]));
    expect(by['I']!.amountCents).toBe(7_600_000_00);
    expect(by['II.A']!.amountCents).toBe(140_000_050_00);
    expect(by['II']!.amountCents).toBe(200_000_050_00);
    expect(by['II.A.1']!.amountCents).toBe(125_000_050_00);
  });

  it('section letter "C" (and I, V, X, L) stays a letter inside its Roman parent', () => {
    const p = parseRows(sheet([
      ['I', 'PEKERJAAN', null, null, null, null],
      ['A', 'Alpha', null, null, null, null], ['1', 'a1', 'm', 1, 100, 100],
      ['B', 'Bravo', null, null, null, null], ['1', 'b1', 'm', 1, 100, 100],
      ['C', 'Charlie', null, null, null, null], ['1', 'c1', 'm', 1, 100, 100],
      ['D', 'Delta', null, null, null, null], ['1', 'd1', 'm', 1, 100, 100],
      ['II', 'LAIN', null, null, null, null], ['1', 'x', 'm', 1, 100, 100],
    ]));
    expect(p.items.map((i) => i.code)).toEqual(['I', 'I.A', 'I.A.1', 'I.B', 'I.B.1', 'I.C', 'I.C.1', 'I.D', 'I.D.1', 'II', 'II.1']);
    expect(p.items.find((i) => i.code === 'I.C')?.level).toBe(1);
  });

  it('letters A..L at top level with no Roman sections stay letters (I and L included)', () => {
    const rows: Row[] = [];
    for (const l of 'ABCDEFGHIJKL') rows.push([l, `Seksi ${l}`, null, null, null, null], ['1', 'item', 'm', 1, 100, 100]);
    const p = parseRows(sheet(rows));
    expect(p.items.filter((i) => i.level === 0).map((i) => i.code)).toEqual([...'ABCDEFGHIJKL']);
  });

  it('a Roman sequence I..V at top level is still Roman', () => {
    const rows: Row[] = [];
    for (const r of ['I', 'II', 'III', 'IV', 'V']) rows.push([r, `Bab ${r}`, null, null, null, null], ['1', 'item', 'm', 1, 100, 100]);
    const p = parseRows(sheet(rows));
    expect(p.items.filter((i) => i.level === 0).map((i) => i.code)).toEqual(['I', 'II', 'III', 'IV', 'V']);
    expect(p.items.map((i) => i.level)).toEqual([0, 1, 0, 1, 0, 1, 0, 1, 0, 1]);
  });

  it('dotted numbers "1.1" under "1" keep their printed prefix', () => {
    const p = parseRows(sheet([
      ['1', 'Induk', null, null, null, null],
      ['1.1', 'Anak', 'm', 2, 50, 100],
      ['1.2', 'Anak', 'm', 2, 50, 100],
      ['2', 'Induk 2', 'm', 1, 100, 100],
    ]));
    expect(p.items.map((i) => [i.code, i.level])).toEqual([['1', 0], ['1.1', 1], ['1.2', 1], ['2', 0]]);
  });

  it('printed jumlah wins over qty × harga and is reported', () => {
    const p = parseRows(sheet([['1', 'Item', 'm', 10, 1000, 10_002]]));
    expect(p.totalCents).toBe(10_002_00);
    expect(p.anomalies).toEqual([{ row: 5, type: 'amount_mismatch', detail: expect.stringContaining('jumlah tercetak dipakai') }]);
  });

  it('computes jumlah from qty × harga only when jumlah is empty, and says so', () => {
    const p = parseRows(sheet([['1', 'Item', 'm', 2.5, 1000, null]]));
    expect(p.totalCents).toBe(2_500_00);
    expect(p.anomalies[0]?.type).toBe('amount_computed');
  });

  it('reports a printed subtotal that disagrees with its children, keeps the roll-up', () => {
    const p = parseRows(sheet([
      ['A', 'Induk', null, null, null, 999],
      ['1', 'a', 'm', 1, 100, 100],
      ['2', 'b', 'm', 1, 100, 100],
    ]));
    expect(p.items[0]!.amountCents).toBe(200_00);
    expect(p.anomalies[0]?.type).toBe('subtotal_mismatch');
  });

  it('a coded row with jumlah but no qty/price is a leaf when nothing below is its child', () => {
    const p = parseRows(sheet([
      ['1', 'Lump sum', 'LS', null, null, 5000],
      ['2', 'Item', 'm', 1, 100, 100],
    ]));
    expect(p.items.map((i) => i.isLeaf)).toEqual([true, true]);
    expect(p.totalCents).toBe(5100_00);
  });

  it('parses text cells with Indonesian decimals ("2,5") and thousands ("1.250.000,50") parse', () => {
    const p = parseRows(sheet([['1', 'Item', 'm', '2,5', 'Rp 1.000,00', '2.500']]));
    expect(p.items[0]).toMatchObject({ qty: 2.5, unitPriceCents: 100_000, amountCents: 250_000 });
  });

  it('throws typed errors: missing header, missing qty column, duplicate code', () => {
    expect(() => parseRows([['x']])).toThrow(BoqImportError);
    expect(() => parseRows([['No', 'Uraian', 'Satuan', 'Harga', 'Jumlah'], ['1', 'a', 'm', 1, 1]])).toThrowError(/qty/);
    expect(() => parseRows(sheet([['1', 'a', 'm', 1, 1, 1], ['1', 'b', 'm', 1, 1, 1]]))).toThrowError(/Kode ganda/);
  });

  it('a coded row with no numbers and no children is reported as empty_section and excluded from the total', () => {
    const p = parseRows(sheet([['1', 'a', 'm', null, null, null], ['2', 'b', 'm', 1, 100, 100]]));
    expect(p.totalCents).toBe(100_00);
    expect(p.anomalies).toEqual([{ row: 5, type: 'empty_section', detail: expect.stringContaining('"1"') }]);
  });

  it('an empty workbook has no header and is refused with header_missing', () => {
    const err = (() => { try { parseRows([]); } catch (e) { return e; } return null; })();
    expect(err).toBeInstanceOf(BoqImportError);
    expect((err as BoqImportError).code).toBe('header_missing');
  });

  it('a header with no data rows parses to zero items and total 0 (the importer refuses it, not the parser)', () => {
    const p = parseRows(sheet([]));
    expect(p).toEqual({ items: [], footers: [], anomalies: [], totalCents: 0 });
  });

  it('when a RAB labels quantity "Jumlah", the amount column is the next "Jumlah/Total" to its right', () => {
    const p = parseRows([
      ['No', 'Uraian', 'Sat', 'Jumlah', 'Harga Satuan', 'Jumlah Harga'],
      ['1', 'Item', 'm', 3, 100, 300],
    ]);
    expect(p.items[0]).toMatchObject({ qty: 3, unitPriceCents: 100_00, amountCents: 300_00 });
  });
});

describe('roman helpers', () => {
  it('round-trip canonical numerals and reject non-canonical ones', () => {
    for (let n = 1; n <= 50; n++) expect(romanToInt(intToRoman(n))).toBe(n);
    expect(romanToInt('IIII')).toBeNull();
    expect(romanToInt('VX')).toBeNull();
  });
});

describe('parseBoqWorkbook (exceljs I/O)', () => {
  async function workbookBuffer(rows: Row[], sheetName = 'RAB'): Promise<Buffer> {
    const wb = new ExcelJS.Workbook();
    const ws = wb.addWorksheet(sheetName);
    for (const r of sheet(rows)) ws.addRow(r);
    return Buffer.from(await wb.xlsx.writeBuffer());
  }

  it('reads a real .xlsx buffer, including formula results', async () => {
    const wb = new ExcelJS.Workbook();
    const ws = wb.addWorksheet('RAB');
    for (const r of HEADER) ws.addRow(r);
    ws.addRow(['1', 'Item', 'm', 10, 1000, { formula: 'D5*E5', result: 10_000 }]);
    const p = await parseBoqWorkbook(Buffer.from(await wb.xlsx.writeBuffer()));
    expect(p.totalCents).toBe(10_000_00);
  });

  it('missing sheet -> sheet_missing with the available sheet names', async () => {
    const err = await parseBoqWorkbook(await workbookBuffer([['1', 'x', 'm', 1, 1, 1]], 'LAIN')).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(BoqImportError);
    expect((err as BoqImportError).code).toBe('sheet_missing');
    expect((err as BoqImportError).details).toEqual({ sheets: ['LAIN'] });
  });

  it('garbage bytes -> file_unreadable, never an unhandled exception', async () => {
    const err = await parseBoqWorkbook(Buffer.from('not an xlsx')).catch((e: unknown) => e);
    expect((err as BoqImportError).code).toBe('file_unreadable');
  });
});
