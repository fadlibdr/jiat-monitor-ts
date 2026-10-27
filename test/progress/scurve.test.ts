import ExcelJS from 'exceljs';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { currentLeaves } from '../../src/boq/current.js';
import { importBoq } from '../../src/boq/importer.js';
import { vendors } from '../../src/db/schema.js';
import { withCompany } from '../../src/db/tenant.js';
import { approvePo, commitments, createPo, OUTSIDE_BOQ } from '../../src/procurement/service.js';
import {
  createReport, getReport, getSchedule, latestActualMicro, PLAN_PERIODS_MAX, PLAN_POINTS_MAX, putReportItems, putSchedule, sCurve, sCurveMicro, transitionReport,
} from '../../src/progress/service.js';
import { createWorld, http, rejects, seedContract, svc, type Seeded, type World } from './fixture.js';

/**
 * Kurva S from the database: approved reports only, carry-forward, the latest actual used by termin
 * triggers, BOQ re-import (progress kept by code), and ordering of approvals.
 */
let w: World;
let H: ReturnType<typeof http>;
let S: ReturnType<typeof svc>;

beforeAll(async () => {
  w = await createWorld();
  H = http(w);
  S = svc(w);
});
afterAll(async () => { await w.close(); });

const M = 1_000_000; // micro-percent per percent

describe('sCurve / sCurveMicro / latestActualMicro', () => {
  let C: Seeded;
  beforeAll(async () => {
    C = await seedContract(w, w.A, w.s1); // I.1 60 %, II.1 40 %
    await S.inA((tx) => putSchedule(tx, w.A, C.K, [
      { code: 'I.1', period: '2026-09', plannedPct: 50 }, { code: 'II.1', period: '2026-09', plannedPct: 25 },
      { code: 'I.1', period: '2026-10', plannedPct: 70 }, { code: 'II.1', period: '2026-10', plannedPct: 50 },
      { code: 'I.1', period: '2026-11', plannedPct: 90 }, { code: 'II.1', period: '2026-11', plannedPct: 75 },
      { code: 'I.1', period: '2026-12', plannedPct: 100 }, { code: 'II.1', period: '2026-12', plannedPct: 100 },
    ]));
  });

  it('plan only, nothing approved: every actual is null, latest is null, latestActualMicro is 0', async () => {
    const s = await S.inA((tx) => sCurve(tx, C.K));
    expect(s.points).toEqual([
      { period: '2026-09-01', plannedPct: 40, actualPct: null, deviationPct: null },
      { period: '2026-10-01', plannedPct: 62, actualPct: null, deviationPct: null },
      { period: '2026-11-01', plannedPct: 84, actualPct: null, deviationPct: null },
      { period: '2026-12-01', plannedPct: 100, actualPct: null, deviationPct: null },
    ]);
    expect(s.latest).toBeNull();
    expect(await S.inA((tx) => latestActualMicro(tx, C.K))).toBe(0);
  });

  it('draft, submitted and rejected reports never count', async () => {
    await S.drafted(C.K, '2026-09', [{ code: 'I.1', cumulativePct: 40 }]); // draft
    await S.drafted(C.K, '2026-10', [{ code: 'I.1', cumulativePct: 60 }], true); // submitted
    const nov = await S.drafted(C.K, '2026-11', [{ code: 'I.1', cumulativePct: 80 }], true);
    await S.inA((tx) => transitionReport(tx, nov.id, 'reject', w.mgr)); // rejected
    const micro = await S.inA((tx) => sCurveMicro(tx, C.K));
    expect(micro.every((p) => p.actualMicroPct === null)).toBe(true);
    expect(await S.inA((tx) => latestActualMicro(tx, C.K))).toBe(0);
  });

  it('approved reports are weighted by leaf; a month without a report and an item missing from a report carry forward', async () => {
    const reports = await S.reportsOf(C.K);
    const id = (p: string) => reports.find((r) => r.period === p)!.id;
    // approve Sep (I.1 40, II.1 25) ; Oct stays submitted ; Nov resubmitted with only I.1 = 70 and approved
    await S.inA(async (tx) => {
      await putReportItems(tx, w.A, id('2026-09-01'), [{ code: 'I.1', cumulativePct: 40 }, { code: 'II.1', cumulativePct: 25 }]);
      await transitionReport(tx, id('2026-09-01'), 'submit', w.mgr);
      await transitionReport(tx, id('2026-09-01'), 'approve', w.mgr);
      await putReportItems(tx, w.A, id('2026-11-01'), [{ code: 'I.1', cumulativePct: 70 }]);
      await transitionReport(tx, id('2026-11-01'), 'submit', w.mgr);
      await transitionReport(tx, id('2026-11-01'), 'approve', w.mgr);
    });
    const s = await S.inA((tx) => sCurve(tx, C.K));
    expect(s.points).toEqual([
      { period: '2026-09-01', plannedPct: 40, actualPct: 34, deviationPct: -6 }, // .6×40 + .4×25
      { period: '2026-10-01', plannedPct: 62, actualPct: 34, deviationPct: -28 }, // Oct only submitted → Sep carried
      { period: '2026-11-01', plannedPct: 84, actualPct: 52, deviationPct: -32 }, // .6×70 + .4×25 (II.1 carried)
      { period: '2026-12-01', plannedPct: 100, actualPct: null, deviationPct: null },
    ]);
    expect(s.latest).toEqual(s.points[2]);
    expect(await S.inA((tx) => latestActualMicro(tx, C.K))).toBe(52 * M);
    const micro = await S.inA((tx) => sCurveMicro(tx, C.K));
    expect(micro[2]).toEqual({ period: '2026-11-01', plannedMicroPct: 84 * M, actualMicroPct: 52 * M, deviationMicroPct: -32 * M });
  });

  it('an approved month beyond the plan extends the curve; its plan is the last planned value carried', async () => {
    await S.approved(C.K, '2027-02', [{ code: 'I.1', cumulativePct: 100 }, { code: 'II.1', cumulativePct: 100 }]);
    const s = await S.inA((tx) => sCurve(tx, C.K));
    expect(s.points.at(-1)).toEqual({ period: '2027-02-01', plannedPct: 100, actualPct: 100, deviationPct: 0 });
    // December lies before the latest approved month now → carried actual from November
    expect(s.points.find((p) => p.period === '2026-12-01')).toEqual({ period: '2026-12-01', plannedPct: 100, actualPct: 52, deviationPct: -48 });
    expect(await S.inA((tx) => latestActualMicro(tx, C.K))).toBe(100 * M);
  });

  it('weighted rounding is half up to a micro-percent', async () => {
    const R = await seedContract(w, w.A, w.s1, [
      { code: 'a', weight: 33_333_333 }, { code: 'b', weight: 33_333_333 }, { code: 'c', weight: 33_333_334 },
    ]);
    await S.approved(R.K, '2026-09', [{ code: 'a', cumulativePct: 50 }]); // 33_333_333 × 0.5 = 16_666_666.5 → 16_666_667
    expect(await S.inA((tx) => latestActualMicro(tx, R.K))).toBe(16_666_667);
    expect((await S.inA((tx) => sCurve(tx, R.K))).latest).toEqual({ period: '2026-09-01', plannedPct: 0, actualPct: 16.666667, deviationPct: 16.666667 });
  });

  it('a contract without BOQ or without anything: empty curve, latest null, 0', async () => {
    const N = await seedContract(w, w.A, w.s1, null);
    expect(await S.inA((tx) => sCurve(tx, N.K))).toEqual({ points: [], latest: null });
    expect(await S.inA((tx) => latestActualMicro(tx, N.K))).toBe(0);
  });

  it('HTTP: staff of the site and the manager see the same curve; staff of another site / another company → 404', async () => {
    const path = `/contracts/${C.K}/s-curve`;
    const mine = await H.ok(H.req(w.staff1, 'GET', path));
    expect(mine).toEqual(await S.inA((tx) => sCurve(tx, C.K)));
    expect(await H.ok(H.req(w.fin, 'GET', path))).toEqual(mine);
    expect(await H.code(H.req(w.staff2, 'GET', path))).toBe(404);
    expect(await H.code(H.req(w.staffNone, 'GET', path))).toBe(404);
    expect(await H.code(H.req(w.mgrB, 'GET', path, undefined, w.B))).toBe(404);
    expect(await H.code(H.req(w.mgr, 'GET', `/contracts/999999/s-curve`))).toBe(404);
  });
});

describe('tenancy at service level: another company sees nothing and changes nothing', () => {
  let C: Seeded;
  let rid = 0;
  const inB = <T>(fn: Parameters<typeof withCompany<T>>[2]) => withCompany(w.db, { companyId: w.B, userId: w.mgrB }, fn);
  beforeAll(async () => {
    C = await seedContract(w, w.A, w.s1);
    await S.inA((tx) => putSchedule(tx, w.A, C.K, [{ code: null, period: '2026-09', plannedPct: 50 }]));
    rid = (await S.approved(C.K, '2026-09', [{ code: 'I.1', cumulativePct: 30 }])).id;
  });

  it('reads: empty schedule, empty curve, 0 progress, report 404', async () => {
    expect(await inB((tx) => getSchedule(tx, C.K))).toEqual([]);
    expect(await inB((tx) => sCurveMicro(tx, C.K))).toEqual([]);
    expect(await inB((tx) => latestActualMicro(tx, C.K))).toBe(0);
    await rejects(inB((tx) => getReport(tx, rid)), 404);
  });

  it('writes: putSchedule 409 (no BOQ visible), createReport/putReportItems/transition 404; A is unchanged', async () => {
    await rejects(inB((tx) => putSchedule(tx, w.B, C.K, [])), 409);
    await rejects(inB((tx) => createReport(tx, { companyId: w.B, userId: w.mgrB }, { contractId: C.K, period: '2026-10' })), 404);
    await rejects(inB((tx) => putReportItems(tx, w.B, rid, [])), 404);
    await rejects(inB((tx) => transitionReport(tx, rid, 'reject', w.mgrB)), 404);
    expect(await S.inA((tx) => getSchedule(tx, C.K))).toHaveLength(2);
    const r = await S.inA((tx) => getReport(tx, rid));
    expect(r.status).toBe('approved');
    expect(r.items).toHaveLength(1);
  });

  it('site scope: a staff transaction for another site sees neither the report nor the curve', async () => {
    const asStaff2 = <T>(fn: Parameters<typeof withCompany<T>>[2]) => withCompany(w.db, { companyId: w.A, userId: w.staff2, siteIds: [w.s2] }, fn);
    await rejects(asStaff2((tx) => getReport(tx, rid)), 404);
    await rejects(asStaff2((tx) => putReportItems(tx, w.A, rid, [])), 404);
    await rejects(asStaff2((tx) => createReport(tx, { companyId: w.A, userId: w.staff2 }, { contractId: C.K, period: '2026-11' })), 404);
    expect(await asStaff2((tx) => sCurveMicro(tx, C.K))).toEqual([]);
    expect(await asStaff2((tx) => latestActualMicro(tx, C.K))).toBe(0);
  });
});

// ---------------------------------------------------------------------------------------------
// BOQ re-import: progress is carried over by code (docs/remaining-work.md §5.3)
// ---------------------------------------------------------------------------------------------

type Row = Array<string | number | null>;
const HEADER: Row[] = [['KEMENTERIAN X'], ['Kegiatan: JIAT'], [], ['No', 'Uraian Pekerjaan', 'Satuan', 'Volume', 'Harga Satuan (Rp)', 'Jumlah (Rp)']];
async function workbook(rows: Row[]): Promise<Buffer> {
  const wb = new ExcelJS.Workbook();
  const ws = wb.addWorksheet('RAB');
  for (const r of [...HEADER, ...rows]) ws.addRow(r);
  return Buffer.from(await wb.xlsx.writeBuffer());
}
// both total Rp 1.000.000.000 (= the contract DPP)
const V1: Row[] = [
  ['I', 'PEKERJAAN BETON', null, null, null, null],
  ['1', 'Beton K-250', 'm3', 100, 6_000_000, 600_000_000],
  ['II', 'PEKERJAAN BOR', null, null, null, null],
  ['1', 'Pengeboran', 'LS', 1, 400_000_000, 400_000_000],
];
const V2: Row[] = [
  ['I', 'PEKERJAAN BETON', null, null, null, null],
  ['1', 'Beton K-250', 'm3', 100, 5_000_000, 500_000_000],
  ['2', 'Bekisting', 'm2', 200, 500_000, 100_000_000],
  ['II', 'PEKERJAAN BOR', null, null, null, null],
  ['1', 'Pengeboran', 'LS', 1, 400_000_000, 400_000_000],
];

describe('BOQ re-import', () => {
  let K = 0;
  let oldLeafI1 = 0;
  let septId = 0;
  beforeAll(async () => {
    K = (await seedContract(w, w.A, w.s1, null)).K;
    const v1 = await S.inA((tx) => importBoq(tx, K, Buffer.alloc(0)).catch(() => null)); // sanity: garbage is refused
    expect(v1).toBeNull();
    const sum = await S.inA(async (tx) => importBoq(tx, K, await workbook(V1)));
    expect(sum).toMatchObject({ version: 1, leaves: 2 });
    await S.inA((tx) => putSchedule(tx, w.A, K, [
      { code: 'I.1', period: '2026-09', plannedPct: 50 }, { code: 'II.1', period: '2026-09', plannedPct: 25 },
    ]));
    const sep = await S.approved(K, '2026-09', [{ code: 'I.1', qtyDone: '40' }, { code: 'II.1', cumulativePct: 25 }]);
    septId = sep.id;
    oldLeafI1 = (await S.itemsOf(sep.id)).find((i) => i.cumulativeMicroPct === 40 * M)!.boqItemId;
    expect(await S.inA((tx) => latestActualMicro(tx, K))).toBe(34 * M); // .6×40 + .4×25
    const sum2 = await S.inA(async (tx) => importBoq(tx, K, await workbook(V2)));
    expect(sum2).toMatchObject({ version: 2, leaves: 3 });
  });

  it('approved progress of the old version still counts, matched by code and re-weighted with the new BOQ', async () => {
    // new weights: I.1 50 %, I.2 10 %, II.1 40 % → .5×40 + .1×0 + .4×25 = 30
    expect(await S.inA((tx) => latestActualMicro(tx, K))).toBe(30 * M);
    const r = await S.inA((tx) => getReport(tx, septId));
    expect(r.items.map((i) => [i.code, i.cumulativePct])).toEqual([['I.1', 40], ['II.1', 25]]);
  });

  it('a new opname must reference the NEW version leaves; an id of the old version is refused (400)', async () => {
    const oct = await S.drafted(K, '2026-10', []);
    await rejects(S.inA((tx) => putReportItems(tx, w.A, oct.id, [{ boqItemId: oldLeafI1, cumulativePct: 50 }])), 400, /bukan item daun/);
    const res = await S.inA((tx) => putReportItems(tx, w.A, oct.id, [{ code: 'I.1', cumulativePct: 50 }, { code: 'I.2', qtyDone: '100' }]));
    expect(res.items.map((i) => i.cumulativeMicroPct)).toEqual([50 * M, 50 * M]);
    expect(res.items.some((i) => i.boqItemId === oldLeafI1)).toBe(false);
  });

  it('the "no going backwards" baseline follows the code across versions', async () => {
    const oct = (await S.reportsOf(K)).find((r) => r.period === '2026-10-01')!;
    await rejects(S.inA((tx) => putReportItems(tx, w.A, oct.id, [{ code: 'I.1', qtyDone: '39' }])), 400, /I\.1 turun dari 40%/);
    await rejects(S.inA((tx) => putReportItems(tx, w.A, oct.id, [{ code: 'II.1', cumulativePct: 24 }])), 400, /II\.1 turun dari 25%/);
  });

  it('approving the new-version report moves the curve: .5×50 + .1×50 + .4×25 = 40 %', async () => {
    const oct = (await S.reportsOf(K)).find((r) => r.period === '2026-10-01')!;
    await S.inA(async (tx) => {
      await transitionReport(tx, oct.id, 'submit', w.mgr);
      await transitionReport(tx, oct.id, 'approve', w.mgr);
    });
    expect(await S.inA((tx) => latestActualMicro(tx, K))).toBe(40 * M);
    const s = await S.inA((tx) => sCurve(tx, K));
    expect(s.points.map((p) => [p.period, p.actualPct])).toEqual([['2026-09-01', 30], ['2026-10-01', 40]]);
  });

  // Regression (was a defect): the plan (boq_schedules) is keyed by boq_item_id of one version and is NOT carried over by
  // code like the actuals are: after a re-import getSchedule() is [] and the S-curve plan drops to 0
  // for every month, so the deviation flips from behind-plan to "ahead of plan" (and deviation alerts
  // go quiet) although nothing in the plan changed.
  it('the plan of unchanged codes survives a re-import (as the actuals do)', async () => {
    expect((await S.inA((tx) => getSchedule(tx, K))).map((p) => [p.code, p.period, p.plannedPct])).toEqual([
      ['I.1', '2026-09-01', 50], ['II.1', '2026-09-01', 25],
    ]);
    // Sep plan with the new weights: .5×50 + .4×25 = 35
    expect((await S.inA((tx) => sCurve(tx, K))).points[0]).toMatchObject({ period: '2026-09-01', plannedPct: 35 });
  });
});

/** Same contract value as V1, but Beton K-250 grows from 100 to 150 m3 (an addendum added work). */
const V3: Row[] = [
  ['I', 'PEKERJAAN BETON', null, null, null, null],
  ['1', 'Beton K-250', 'm3', 150, 4_000_000, 600_000_000],
  ['II', 'PEKERJAAN BOR', null, null, null, null],
  ['1', 'Pengeboran', 'LS', 1, 400_000_000, 400_000_000],
];
/** Pengeboran (II.1) is gone; its value moved into Beton. */
const V4: Row[] = [
  ['I', 'PEKERJAAN BETON', null, null, null, null],
  ['1', 'Beton K-250', 'm3', 100, 10_000_000, 1_000_000_000],
];

describe('BOQ re-import that changes a volume', () => {
  let K = 0;
  beforeAll(async () => {
    K = (await seedContract(w, w.A, w.s1, null)).K;
    await S.inA(async (tx) => importBoq(tx, K, await workbook(V1)));
    // September: 80 of the 100 m3 (80 %) measured; Pengeboran given as a percent
    await S.approved(K, '2026-09', [{ code: 'I.1', qtyDone: '80' }, { code: 'II.1', cumulativePct: 25 }]);
    await S.inA(async (tx) => importBoq(tx, K, await workbook(V3)));
  });

  it('a measured line is re-based on the new volume: 80 of 150 m3 is 53.33 %, so 90 m3 in October is progress, not a drop', async () => {
    const oct = await S.drafted(K, '2026-10', []);
    // 79 m3 is less than the 80 already measured
    await rejects(S.inA((tx) => putReportItems(tx, w.A, oct.id, [{ code: 'I.1', qtyDone: '79' }])), 400, /I\.1 turun dari 53\.333333%/);
    const saved = await S.inA((tx) => putReportItems(tx, w.A, oct.id, [{ code: 'I.1', qtyDone: '90' }, { code: 'II.1', cumulativePct: 25 }]));
    expect(saved.items.map((i) => i.cumulativeMicroPct)).toEqual([60 * M, 25 * M]);
  });

  it('the S-curve shows September against the new volume too (a percent line stays as given)', async () => {
    // weights 60 % / 40 %: .6 × 53.333333 + .4 × 25 = 42
    const s = await S.inA((tx) => sCurve(tx, K));
    expect(s.points.find((p) => p.period === '2026-09-01')?.actualPct).toBeCloseTo(42, 5);
  });

  it('PO lines on a code the new BOQ no longer has stay committed, under "di luar BOQ"', async () => {
    const K2 = (await seedContract(w, w.A, w.s1, null)).K;
    await S.inA(async (tx) => importBoq(tx, K2, await workbook(V1)));
    const committed = 50_000_000;
    await S.inA(async (tx) => {
      const leaves = await currentLeaves(tx, K2);
      const [v] = await tx.insert(vendors).values({ companyId: w.A, name: `PT Bor ${K2}` }).returning({ id: vendors.id });
      const po = await createPo(tx, { companyId: w.A, userId: w.mgr }, {
        siteId: w.s1, vendorId: v!.id, contractId: K2, orderDate: '2026-10-01', ppnRateBp: 0,
        items: [{ boqItemId: leaves.find((l) => l.code === 'II.1')!.id, description: 'Pengeboran', qty: 1, unitPriceCents: committed }],
      });
      await approvePo(tx, po.id, w.mgr);
    });
    await S.inA(async (tx) => importBoq(tx, K2, await workbook(V4)));
    const c = await S.inA((tx) => commitments(tx, K2));
    expect(c.outside).toEqual([{ code: 'II.1', committedCents: committed, receivedCents: 0 }]);
    expect(c.byCategory[OUTSIDE_BOQ]).toEqual({ budgetCents: 0, committedCents: committed, receivedCents: 0 });
    expect(c.total.committedCents).toBe(committed);
  });
});

describe('plan size bounds', () => {
  it('refuses more than 240 months, more than the point budget, and an empty plan', async () => {
    const C = await seedContract(w, w.A, w.s1);
    const months = Array.from({ length: PLAN_PERIODS_MAX + 1 }, (_, i) => ({ code: null, period: `${2000 + Math.floor(i / 12)}-${String((i % 12) + 1).padStart(2, '0')}`, plannedPct: 0 }));
    await rejects(S.inA((tx) => putSchedule(tx, w.A, C.K, months)), 400, /paling banyak 240/);
    const many = Array.from({ length: PLAN_POINTS_MAX + 1 }, () => ({ code: 'I.1', period: '2026-10', plannedPct: 1 }));
    await rejects(S.inA((tx) => putSchedule(tx, w.A, C.K, many)), 400, /terlalu besar/);
    expect(await S.inA((tx) => putSchedule(tx, w.A, C.K, months.slice(0, PLAN_PERIODS_MAX)))).toMatchObject({ points: PLAN_PERIODS_MAX * 2 });
  });
});

// ---------------------------------------------------------------------------------------------
// ordering of approvals: progress must never go backwards (putReportItems' own invariant)
// ---------------------------------------------------------------------------------------------

describe('approvals out of month order', () => {
  // Regression (was a defect): the "not below the last approved report before this period" check runs only when the lines
  // are saved (putReportItems). transitionReport('approve') does not re-check it, so a later month
  // filled while an earlier month was still unapproved can be approved below it.
  it('approving a later month below an earlier month approved in the meantime is refused', async () => {
    const C = await seedContract(w, w.A, w.s1);
    const oct = await S.drafted(C.K, '2026-10', [{ code: 'I.1', cumulativePct: 30 }], true); // checked: nothing approved yet
    await S.approved(C.K, '2026-09', [{ code: 'I.1', cumulativePct: 50 }]);
    await rejects(S.inA((tx) => transitionReport(tx, oct.id, 'approve', w.mgr)), 409);
  });

  // Regression (was a defect): the same invariant only looks backwards: a back-dated report (month before an approved one)
  // is not compared with LATER approved months, so September can be approved at 80 % while October is
  // already approved at 60 % — the approved curve goes down from Sep to Oct.
  it('a back-dated month cannot exceed a later month that is already approved', async () => {
    const C = await seedContract(w, w.A, w.s1);
    await S.approved(C.K, '2026-10', [{ code: 'I.1', cumulativePct: 60 }]);
    const sep = await S.inA((tx) => createReport(tx, { companyId: w.A, userId: w.mgr }, { contractId: C.K, period: '2026-09' }));
    await rejects(S.inA((tx) => putReportItems(tx, w.A, sep.id, [{ code: 'I.1', cumulativePct: 80 }])), 400);
  });

  it('so the approved curve never decreases month over month: October stays unapproved until corrected', async () => {
    const C = await seedContract(w, w.A, w.s1);
    const oct = await S.drafted(C.K, '2026-10', [{ code: 'I.1', cumulativePct: 30 }], true);
    await S.approved(C.K, '2026-09', [{ code: 'I.1', cumulativePct: 50 }]);
    await rejects(S.inA((tx) => transitionReport(tx, oct.id, 'approve', w.mgr)), 409);
    const micro = await S.inA((tx) => sCurveMicro(tx, C.K));
    expect(micro.map((p) => [p.period, p.actualMicroPct])).toEqual([['2026-09-01', 30 * M]]); // .6×50; no October point
    expect(await S.inA((tx) => latestActualMicro(tx, C.K))).toBe(30 * M);
  });
});
