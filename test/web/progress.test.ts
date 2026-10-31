import { describe, expect, it } from 'vitest';
import { COMPANY_ROLES } from '../../src/db/schema.js';
import { mulDiv } from '../../src/domain/contract.js';
import { parseQty } from '../../src/domain/quantity.js';
import { MICRO_100, pctToMicro } from '../../src/domain/scurve.js';
import { OPNAME_ROLES as S_OPNAME } from '../../src/http/context.js';
import {
  curvePoints, nextMonth, opnameBody, opnameRows, parsePctMicro, pctText, PLAN_ROWS_EDITABLE, planRowsOf, rowMicro, scheduleBody, type OpnameRow,
} from '../../web/src/lib/progress.js';
import { OPNAME_ROLES, PROGRESS_ROLES } from '../../web/src/lib/roles.js';
import type { BoqItem, PlanEntry } from '../../web/src/lib/types.js';

const leaf = (id: number, code: string, qty: string | null, isLeaf = true): BoqItem => ({
  id, parentId: null, code, codePrinted: null, description: `Item ${code}`, unit: qty === null ? null : 'm3', qty,
  unitPriceCents: null, amountCents: 0, weightMicroPct: 0, category: null, level: 1, isLeaf,
});
const sorted = (a: readonly string[]) => [...a].sort();

describe('progress roles', () => {
  it('opname writers mirror the server; every company role may read progress', () => {
    expect(sorted(OPNAME_ROLES)).toEqual(sorted(S_OPNAME));
    expect(sorted(PROGRESS_ROLES)).toEqual(sorted(COMPANY_ROLES));
  });
});

describe('percent input', () => {
  it('reads comma or dot decimals up to 6 places, 0–100 only', () => {
    expect(parsePctMicro('41,25')).toBe(41_250_000);
    expect(parsePctMicro('41.25 %')).toBe(41_250_000);
    expect(parsePctMicro('100')).toBe(MICRO_100);
    expect(parsePctMicro('0,000001')).toBe(1);
    expect(parsePctMicro('100,1')).toBeNull();
    expect(parsePctMicro('1,2345678')).toBeNull();
    expect(parsePctMicro('-5')).toBeNull();
    expect(parsePctMicro('')).toBeNull();
  });

  it('pctText is read back exactly, and micro / 1e6 is what the server rounds back to the same integer', () => {
    for (const micro of [0, 1, 999_999, 41_250_000, 33_333_333, 99_999_999, MICRO_100]) {
      expect(parsePctMicro(pctText(micro))).toBe(micro);
      expect(pctToMicro(micro / 1_000_000)).toBe(micro);
    }
    expect(pctText(41_250_000)).toBe('41,25');
    expect(pctText(MICRO_100)).toBe('100');
  });
});

describe('S-curve points', () => {
  it('percent from the API → micro-percent for the chart', () => {
    expect(curvePoints({
      points: [{ period: '2026-09-01', plannedPct: 12.5, actualPct: 10.333333, deviationPct: -2.166667 }, { period: '2026-10-01', plannedPct: 30, actualPct: null, deviationPct: null }],
      latest: null,
    })).toEqual([
      { period: '2026-09-01', plannedMicroPct: 12_500_000, actualMicroPct: 10_333_333, deviationMicroPct: -2_166_667 },
      { period: '2026-10-01', plannedMicroPct: 30_000_000, actualMicroPct: null, deviationMicroPct: null },
    ]);
  });
});

describe('opname form', () => {
  const items = [leaf(1, '1.1', '150.0000'), leaf(2, '1.2', null), leaf(3, '1', null, false), leaf(4, '1.3', '0.0000'), leaf(5, '1.4', '40.0000')];

  it('one row per leaf, by volume when the leaf has one, filled from saved lines by code', () => {
    const rows = opnameRows(items, [
      { id: 9, boqItemId: 101, code: '1.1', qtyDone: '80.0000', cumulativeMicroPct: 53_333_333 }, // an older BOQ version's id
      { id: 10, boqItemId: 2, code: '1.2', qtyDone: null, cumulativeMicroPct: 25_500_000 },
      { id: 11, boqItemId: 5, code: '1.4', qtyDone: null, cumulativeMicroPct: 10_000_000 }, // given as % although the leaf has a volume
    ]);
    expect(rows.map((r) => [r.code, r.mode, r.value, r.qty])).toEqual([
      ['1.1', 'qty', '80', '150.0000'],
      ['1.2', 'pct', '25,5', null],
      ['1.3', 'pct', '', null], // a zero volume cannot be a denominator
      ['1.4', 'pct', '10', null],
    ]);
  });

  it('the % shown beside a volume matches the server (done × 100 % / volume)', () => {
    const [row] = opnameRows(items, []) as [OpnameRow];
    for (const v of ['80', '0,0001', '149,9999', '150']) {
      expect(rowMicro({ ...row, value: v })).toBe(mulDiv(parseQty(v)!, MICRO_100, 1_500_000));
    }
    expect(rowMicro({ ...row, value: 'x' })).toBeNull();
    expect(rowMicro({ ...row, value: '' })).toBeNull();
  });

  it('body: empty rows skipped, volumes in the stored form, a volume above the BOQ refused', () => {
    const rows = opnameRows(items, []).map((r) => ({ ...r, value: r.code === '1.1' ? '90,5' : r.code === '1.2' ? '33,333333' : '' }));
    expect(opnameBody(rows)).toEqual({ ok: true, body: [{ boqItemId: 1, qtyDone: '90.5000' }, { boqItemId: 2, cumulativePct: 33.333333 }] });
    expect(opnameBody(rows.map((r) => (r.code === '1.1' ? { ...r, value: '151' } : r)))).toEqual({ ok: false, error: '1.1: 151 melebihi volume BOQ 150.' });
    expect(opnameBody(rows.map((r) => (r.code === '1.2' ? { ...r, value: '101' } : r))).ok).toBe(false);
    expect(opnameBody(rows.map((r) => ({ ...r, value: '' })))).toEqual({ ok: false, error: 'Isi progres minimal satu item.' });
  });
});

describe('plan form', () => {
  const codes = ['1.1', '1.2'];
  const entry = (code: string, period: string, plannedPct: number): PlanEntry => ({ code, period, plannedPct });

  it('a plan that is the same for every leaf comes back as contract-level rows', () => {
    const stored = [entry('1.1', '2026-09-01', 10), entry('1.1', '2026-10-01', 35.5), entry('1.2', '2026-09-01', 10), entry('1.2', '2026-10-01', 35.5)];
    expect(planRowsOf(stored, codes)).toEqual({ rows: [{ code: '', month: '2026-09', pct: '10' }, { code: '', month: '2026-10', pct: '35,5' }], tooLarge: false });
  });

  it('a per-item plan stays per item; a huge one is not put into inputs', () => {
    const stored = [entry('1.1', '2026-09-01', 10), entry('1.2', '2026-09-01', 20)];
    expect(planRowsOf(stored, codes).rows.map((r) => r.code)).toEqual(['1.1', '1.2']);
    expect(planRowsOf([entry('1.1', '2026-09-01', 10)], codes).rows).toEqual([{ code: '1.1', month: '2026-09', pct: '10' }]); // 1.2 has no plan
    // per-item plans that differ (identical ones would collapse into one contract-level row)
    const big = Array.from({ length: PLAN_ROWS_EDITABLE + 1 }, (_, i) => entry(`c${i}`, '2026-09-01', i % 100));
    expect(planRowsOf(big, big.map((e) => e.code!))).toEqual({ rows: [], tooLarge: true });
    expect(planRowsOf([], codes)).toEqual({ rows: [], tooLarge: false });
  });

  it('body: blank code = all leaves; codes, months, percents, duplicates and a falling plan checked', () => {
    const ok = scheduleBody([{ code: '', month: '2026-09', pct: '10' }, { code: ' 1.2 ', month: '2026-10', pct: '40,25' }], codes);
    expect(ok).toEqual({ ok: true, body: [{ code: null, period: '2026-09', plannedPct: 10 }, { code: '1.2', period: '2026-10', plannedPct: 40.25 }] });
    expect(scheduleBody([], codes).ok).toBe(false);
    expect(scheduleBody([{ code: '9.9', month: '2026-09', pct: '10' }], codes)).toEqual({ ok: false, error: 'Baris 1: kode 9.9 bukan item daun BOQ kontrak ini.' });
    expect(scheduleBody([{ code: '', month: '', pct: '10' }], codes).ok).toBe(false);
    expect(scheduleBody([{ code: '', month: '1999-12', pct: '10' }], codes).ok).toBe(false);
    expect(scheduleBody([{ code: '', month: '2026-09', pct: '120' }], codes).ok).toBe(false);
    expect(scheduleBody([{ code: '', month: '2026-09', pct: '10' }, { code: '', month: '2026-09', pct: '20' }], codes))
      .toEqual({ ok: false, error: 'Baris 2: semua item bulan 2026-09 sudah ada.' });
    expect(scheduleBody([{ code: '', month: '2026-10', pct: '30' }, { code: '', month: '2026-09', pct: '40' }], codes))
      .toEqual({ ok: false, error: 'Rencana semua item turun pada 2026-10; rencana kumulatif tidak boleh turun.' });
  });

  it('next month rolls over the year', () => {
    expect(nextMonth('2026-11')).toBe('2026-12');
    expect(nextMonth('2026-12')).toBe('2027-01');
    expect(nextMonth('')).toBe('');
  });
});
