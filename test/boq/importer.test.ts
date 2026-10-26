import ExcelJS from 'exceljs';
import { asc, eq } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { BoqImportError } from '../../src/boq/errors.js';
import { importBoq, leafWeights, MICRO_PCT_TOTAL } from '../../src/boq/importer.js';
import { boqItems, boqVersions, companies, contracts, sites } from '../../src/db/schema.js';
import { withApp, withCompany, type Db } from '../../src/db/tenant.js';
import { createTestDb } from '../helpers/db.js';

type Row = Array<string | number | null>;
const HEADER: Row[] = [['KEMENTERIAN X'], ['Kegiatan: JIAT'], [], ['No', 'Uraian Pekerjaan', 'Satuan', 'Volume', 'Harga Satuan (Rp)', 'Jumlah (Rp)']];
async function workbook(rows: Row[], sheet = 'RAB'): Promise<Buffer> {
  const wb = new ExcelJS.Workbook();
  const ws = wb.addWorksheet(sheet);
  for (const r of [...HEADER, ...rows]) ws.addRow(r);
  return Buffer.from(await wb.xlsx.writeBuffer());
}
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
const RAPI_TOTAL_CENTS = 207_600_050_00;

let db: Db;
let close: () => Promise<void>;
let companyA = 0;
let companyB = 0;
let n = 0;

async function contractIn(company: number, valueDppCents: number): Promise<number> {
  return withCompany(db, company, async (tx) => {
    const [site] = await tx.insert(sites).values({ companyId: company, code: `S${++n}`, name: 'Keerom' }).returning({ id: sites.id });
    const [c] = await tx.insert(contracts).values({ companyId: company, siteId: site!.id, number: `K-${n}`, employerName: 'BWS Papua', valueDppCents }).returning({ id: contracts.id });
    return c!.id;
  });
}

beforeAll(async () => {
  ({ db, close } = await createTestDb());
  [companyA, companyB] = await withApp(db, async (tx) => {
    const rows = await tx.insert(companies).values([{ code: 'AAA', name: 'PT AAA' }, { code: 'BBB', name: 'PT BBB' }]).returning({ id: companies.id });
    return rows.map((r) => r.id) as [number, number];
  });
});
afterAll(async () => { await close(); });

describe('importBoq', () => {
  it('imports the tree with stable full-path codes, parent amounts and weights summing to exactly 100 %', async () => {
    const cid = await contractIn(companyA, RAPI_TOTAL_CENTS);
    const sum = await withCompany(db, companyA, (tx) => importBoq(tx, cid, RAPI_BUFFER, { filename: 'keerom.xlsx' }));
    expect(sum).toMatchObject({ version: 1, items: 9, leaves: 5, total: '207600050.00', diff: '0.00', anomalies: [] });
    expect(sum.footers).toHaveLength(2);

    const items = await withCompany(db, companyA, (tx) => tx.select().from(boqItems).where(eq(boqItems.versionId, sum.versionId)).orderBy(asc(boqItems.sortOrder)));
    const by = Object.fromEntries(items.map((i) => [i.code, i]));
    expect(by['I']!.level).toBe(0);
    expect(by['I.1']!.level).toBe(1);
    expect(by['II.A.1']).toMatchObject({ codePrinted: '1', description: 'Bor 100 m', level: 2, amountCents: 125_000_050_00, qty: '100.0000' });
    expect(by['II.A.1']!.parentId).toBe(by['II.A']!.id);
    expect(by['II.A']!.parentId).toBe(by['II']!.id);
    expect(by['I']!.amountCents).toBe(7_600_000_00);
    const level0 = items.filter((i) => i.level === 0).reduce((s, i) => s + i.weightMicroPct, 0);
    const leaves = items.filter((i) => i.isLeaf).reduce((s, i) => s + i.weightMicroPct, 0);
    expect(level0).toBe(MICRO_PCT_TOTAL);
    expect(leaves).toBe(MICRO_PCT_TOTAL);

    const [v] = await withCompany(db, companyA, (tx) => tx.select().from(boqVersions).where(eq(boqVersions.id, sum.versionId)));
    expect(v).toMatchObject({ isCurrent: true, sourceFilename: 'keerom.xlsx', totalCents: RAPI_TOTAL_CENTS });
    expect(v!.sourceSha256).toMatch(/^[0-9a-f]{64}$/);
  });

  it('refuses a one-rupiah mismatch with total_mismatch and writes nothing', async () => {
    const cid = await contractIn(companyA, RAPI_TOTAL_CENTS + 100);
    const err = await withCompany(db, companyA, (tx) => importBoq(tx, cid, RAPI_BUFFER)).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(BoqImportError);
    expect((err as BoqImportError).code).toBe('total_mismatch');
    expect((err as BoqImportError).message).toContain('selisih -1.00');
    const versions = await withCompany(db, companyA, (tx) => tx.select().from(boqVersions).where(eq(boqVersions.contractId, cid)));
    expect(versions).toEqual([]);
  });

  it('re-import creates version 2 and keeps version 1 (ids stable, only is_current flips)', async () => {
    const cid = await contractIn(companyA, 10_000_00);
    const file = await workbook([['1', 'Item', 'm', 10, 1000, 10_000]]);
    const v1 = await withCompany(db, companyA, (tx) => importBoq(tx, cid, file));
    const v2 = await withCompany(db, companyA, (tx) => importBoq(tx, cid, file));
    expect([v1.version, v2.version]).toEqual([1, 2]);
    const versions = await withCompany(db, companyA, (tx) => tx.select().from(boqVersions).where(eq(boqVersions.contractId, cid)).orderBy(asc(boqVersions.version)));
    expect(versions.map((v) => [v.version, v.isCurrent])).toEqual([[1, false], [2, true]]);
    const items = await withCompany(db, companyA, (tx) => tx.select().from(boqItems).where(eq(boqItems.versionId, v1.versionId)));
    expect(items).toHaveLength(1);
  });

  it('a contract of another company is invisible through RLS -> foreign_contract, nothing written', async () => {
    const cidB = await contractIn(companyB, 10_000_00);
    const file = await workbook([['1', 'Item', 'm', 10, 1000, 10_000]]);
    const err = await withCompany(db, companyA, (tx) => importBoq(tx, cidB, file)).catch((e: unknown) => e);
    expect((err as BoqImportError).code).toBe('foreign_contract');
    const versions = await withCompany(db, companyB, (tx) => tx.select().from(boqVersions).where(eq(boqVersions.contractId, cidB)));
    expect(versions).toEqual([]);
  });

  it('refuses a contract with DPP 0 and a sheet with no items, before parsing/writing', async () => {
    const cid0 = await contractIn(companyA, 0);
    const file = await workbook([['1', 'Item', 'm', 1, 1, 1]]);
    await expect(withCompany(db, companyA, (tx) => importBoq(tx, cid0, file))).rejects.toMatchObject({ code: 'contract_invalid' });
    const cid = await contractIn(companyA, 100);
    await expect(withCompany(db, companyA, async (tx) => importBoq(tx, cid, await workbook([])))).rejects.toMatchObject({ code: 'row_invalid' });
  });

  it('propagates parser errors (missing sheet) as BoqImportError', async () => {
    const cid = await contractIn(companyA, 100);
    await expect(withCompany(db, companyA, async (tx) => importBoq(tx, cid, await workbook([['1', 'x', 'm', 1, 1, 1]], 'LAIN')))).rejects.toMatchObject({ code: 'sheet_missing' });
  });

  it('stores null qty/unit price for a lump-sum leaf and null jumlah computed from qty × harga', async () => {
    const cid = await contractIn(companyA, 7_500_00);
    const sum = await withCompany(db, companyA, async (tx) => importBoq(tx, cid, await workbook([
      ['1', 'Lump sum', 'LS', null, null, 5000], // amount only
      ['2', 'Computed', 'm', 2.5, 1000, null], // qty × harga, jumlah empty
    ])));
    expect(sum.anomalies.map((a) => a.type)).toEqual(['amount_computed']);
    const items = await withCompany(db, companyA, (tx) => tx.select().from(boqItems).where(eq(boqItems.versionId, sum.versionId)).orderBy(asc(boqItems.sortOrder)));
    expect(items[0]).toMatchObject({ qty: null, unitPriceCents: null, amountCents: 5000_00, parentId: null, isLeaf: true });
    expect(items[1]).toMatchObject({ qty: '2.5000', unitPriceCents: 1000_00, amountCents: 2500_00, parentId: null });
  });

  it('printed jumlah wins over qty × harga and the anomaly is stored on the version', async () => {
    const cid = await contractIn(companyA, 10_002_00);
    const sum = await withCompany(db, companyA, async (tx) => importBoq(tx, cid, await workbook([['1', 'Item', 'm', 10, 1000, 10_002]])));
    expect(sum.total).toBe('10002.00');
    expect(sum.anomalies[0]).toMatchObject({ type: 'amount_mismatch', row: 5 });
    const [v] = await withCompany(db, companyA, (tx) => tx.select().from(boqVersions).where(eq(boqVersions.id, sum.versionId)));
    expect((v!.anomalies as Array<{ type: string }>)[0]?.type).toBe('amount_mismatch');
  });
});

describe('leafWeights', () => {
  const leaf = (amountCents: number, parentIdx: number | null = null) => ({
    row: 0, code: '', codePrinted: '', description: '', unit: null, qty: null, unitPriceCents: null,
    amountCents, printedAmountCents: null, parentIdx, level: 0, isLeaf: true,
  });
  it('sums to exactly 100 % even when per-leaf rounding would not', () => {
    const items = [leaf(1), leaf(1), leaf(1)]; // 33.333333…% each
    const w = leafWeights(items, 3);
    expect([...w.values()].reduce((s, v) => s + v, 0)).toBe(MICRO_PCT_TOTAL);
  });
  it('puts the rounding residual on the largest leaf', () => {
    const items = [leaf(1), leaf(1), leaf(4)];
    const w = leafWeights(items, 6);
    expect(w.get(2)).toBe(MICRO_PCT_TOTAL - 2 * Math.round(MICRO_PCT_TOTAL / 6));
  });
  it('ignores non-leaf rows', () => {
    const items = [{ ...leaf(100), isLeaf: false }, leaf(100)];
    expect([...leafWeights(items, 100).keys()]).toEqual([1]);
  });
});

let RAPI_BUFFER: Buffer;
beforeAll(async () => { RAPI_BUFFER = await workbook(RAPI); });
