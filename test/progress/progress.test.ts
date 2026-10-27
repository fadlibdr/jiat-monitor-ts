import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { withCompany } from '../../src/db/tenant.js';
import { createReport, getReport, getSchedule, putReportItems, putSchedule, transitionReport } from '../../src/progress/service.js';
import { createWorld, http, rejects, seedContract, svc, type Seeded, type World } from './fixture.js';

/**
 * Progress (HLD §4 "Progres"): plan (boq_schedules), opname reports and their approval flow,
 * at service level and through HTTP (roles HLD §2, site scope and tenancy by RLS).
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

type Report = { id: number; status: string; period: string; siteId: number; contractId: number; companyId: number; reportedBy: number | null; approvedBy: number | null; approvedAt: string | null; note: string | null };
type FullReport = Report & { items: Array<{ code: string; boqItemId: number; qtyDone: string | null; cumulativeMicroPct: number; cumulativePct: number }> };

// ---------------------------------------------------------------------------------------------
// plan
// ---------------------------------------------------------------------------------------------

describe('putSchedule / getSchedule (service)', () => {
  let C: Seeded;
  beforeAll(async () => { C = await seedContract(w, w.A, w.s1); });

  it('stores per-code cumulative points, normalising any day of the month to the 1st', async () => {
    const res = await S.inA((tx) => putSchedule(tx, w.A, C.K, [
      { code: 'I.1', period: '2026-09', plannedPct: 50 },
      { code: 'I.1', period: '2026-10-15', plannedPct: 80 },
      { code: 'II.1', period: '2026-09-30', plannedPct: 33.333333 },
    ]));
    expect(res).toEqual({ items: 2, points: 3 });
    expect(await S.inA((tx) => getSchedule(tx, C.K))).toEqual([
      { code: 'I.1', period: '2026-09-01', plannedPct: 50 },
      { code: 'I.1', period: '2026-10-01', plannedPct: 80 },
      { code: 'II.1', period: '2026-09-01', plannedPct: 33.333333 },
    ]);
    const stored = await S.schedulesOf(Object.values(C.ids));
    expect(stored.map((s) => s.plannedMicroPct).sort((a, b) => a - b)).toEqual([33_333_333, 50_000_000, 80_000_000]);
    expect(stored.every((s) => s.companyId === w.A)).toBe(true);
  });

  it('code null applies to every LEAF (never the section); a later specific line overrides it for that month', async () => {
    const res = await S.inA((tx) => putSchedule(tx, w.A, C.K, [
      { code: null, period: '2026-09', plannedPct: 20 },
      { code: null, period: '2026-10', plannedPct: 60 },
      { code: 'II.1', period: '2026-10', plannedPct: 70 },
    ]));
    expect(res).toEqual({ items: 2, points: 4 });
    expect(await S.inA((tx) => getSchedule(tx, C.K))).toEqual([
      { code: 'I.1', period: '2026-09-01', plannedPct: 20 },
      { code: 'I.1', period: '2026-10-01', plannedPct: 60 },
      { code: 'II.1', period: '2026-09-01', plannedPct: 20 },
      { code: 'II.1', period: '2026-10-01', plannedPct: 70 },
    ]);
    expect((await S.schedulesOf([C.ids['I']!]))).toEqual([]);
  });

  it('the same item and month given twice (different days) keeps one point, the last value — no duplicate-key error', async () => {
    const res = await S.inA((tx) => putSchedule(tx, w.A, C.K, [
      { code: 'I.1', period: '2026-09', plannedPct: 10 },
      { code: 'I.1', period: '2026-09-20', plannedPct: 30 },
    ]));
    expect(res).toEqual({ items: 1, points: 1 });
    expect(await S.inA((tx) => getSchedule(tx, C.K))).toEqual([{ code: 'I.1', period: '2026-09-01', plannedPct: 30 }]);
  });

  it('entries may come in any order: monotonicity is checked per item in period order', async () => {
    await S.inA((tx) => putSchedule(tx, w.A, C.K, [
      { code: 'I.1', period: '2026-11', plannedPct: 90 },
      { code: 'I.1', period: '2026-09', plannedPct: 40 },
      { code: 'I.1', period: '2026-10', plannedPct: 40 }, // flat is fine
    ]));
    expect((await S.inA((tx) => getSchedule(tx, C.K))).map((p) => [p.period, p.plannedPct])).toEqual([
      ['2026-09-01', 40], ['2026-10-01', 40], ['2026-11-01', 90],
    ]);
  });

  it('replaces the whole plan: months absent from the new body disappear; idempotent; an empty body clears it', async () => {
    const body = [{ code: 'II.1', period: '2027-01', plannedPct: 5 }];
    await S.inA((tx) => putSchedule(tx, w.A, C.K, body));
    expect(await S.inA((tx) => putSchedule(tx, w.A, C.K, body))).toEqual({ items: 1, points: 1 });
    expect(await S.inA((tx) => getSchedule(tx, C.K))).toEqual([{ code: 'II.1', period: '2027-01-01', plannedPct: 5 }]);
    expect(await S.inA((tx) => putSchedule(tx, w.A, C.K, []))).toEqual({ items: 0, points: 0 });
    expect(await S.inA((tx) => getSchedule(tx, C.K))).toEqual([]);
  });

  it('accepts exactly 0 and 100 %; refuses below 0, above 100 and non-finite (400) and keeps the previous plan', async () => {
    const good = [
      { code: 'I.1', period: '2026-01', plannedPct: 0 }, { code: 'I.1', period: '2026-02', plannedPct: 0 },
      { code: 'I.1', period: '2026-03', plannedPct: 100 }, { code: 'I.1', period: '2026-04', plannedPct: 100 },
    ];
    expect(await S.inA((tx) => putSchedule(tx, w.A, C.K, good))).toEqual({ items: 1, points: 4 });
    for (const bad of [-0.000001, 100.000001, Number.NaN, Number.POSITIVE_INFINITY]) {
      await rejects(S.inA((tx) => putSchedule(tx, w.A, C.K, [{ code: 'II.1', period: '2026-05', plannedPct: bad }])), 400, /plannedPct 0–100/);
    }
    expect(await S.inA((tx) => getSchedule(tx, C.K))).toHaveLength(4);
  });

  it('refuses an invalid month (400) and writes nothing', async () => {
    for (const period of ['2026-13', '2026-00', '2026-9', 'Sep 2026', '']) {
      await rejects(S.inA((tx) => putSchedule(tx, w.A, C.K, [{ code: 'I.1', period, plannedPct: 1 }])), 400, /periode/);
    }
    expect(await S.inA((tx) => getSchedule(tx, C.K))).toHaveLength(4);
  });

  it('refuses an unknown code and a section (non-leaf) code with 400, naming the line; keeps the previous plan', async () => {
    await rejects(S.inA((tx) => putSchedule(tx, w.A, C.K, [{ code: 'I.1', period: '2026-05', plannedPct: 1 }, { code: 'IX.9', period: '2026-05', plannedPct: 1 }])), 400, /baris 2.*IX\.9/);
    await rejects(S.inA((tx) => putSchedule(tx, w.A, C.K, [{ code: 'I', period: '2026-05', plannedPct: 1 }])), 400, /bukan item daun/);
    expect(await S.inA((tx) => getSchedule(tx, C.K))).toHaveLength(4);
  });

  it('refuses a plan that decreases for an item — also when a contract-wide line and a specific line combine', async () => {
    await rejects(S.inA((tx) => putSchedule(tx, w.A, C.K, [
      { code: 'I.1', period: '2026-09', plannedPct: 50 }, { code: 'I.1', period: '2026-10', plannedPct: 49.999999 },
    ])), 400, /I\.1 menurun pada 2026-10/);
    await rejects(S.inA((tx) => putSchedule(tx, w.A, C.K, [
      { code: null, period: '2026-10', plannedPct: 40 }, { code: 'II.1', period: '2026-09', plannedPct: 50 },
    ])), 400, /II\.1 menurun/);
    expect(await S.inA((tx) => getSchedule(tx, C.K))).toHaveLength(4);
  });

  it('a contract without BOQ: put → 409, get → []', async () => {
    const N = await seedContract(w, w.A, w.s1, null);
    await rejects(S.inA((tx) => putSchedule(tx, w.A, N.K, [{ code: null, period: '2026-09', plannedPct: 10 }])), 409, /BOQ/);
    expect(await S.inA((tx) => getSchedule(tx, N.K))).toEqual([]);
  });
});

describe('schedule over HTTP: roles, site scope, tenancy', () => {
  let C: Seeded;
  const path = () => `/contracts/${C.K}/boq/schedule`;
  const plan = [{ code: 'I.1', period: '2026-09', plannedPct: 50 }, { code: 'II.1', period: '2026-09', plannedPct: 25 }];
  beforeAll(async () => { C = await seedContract(w, w.A, w.s1); });

  it('admin proyek, manager and system admin write the plan (EDIT_ROLES)', async () => {
    expect(await H.ok(H.req(w.adm, 'PUT', path(), plan))).toEqual({ items: 2, points: 2 });
    expect(await H.ok(H.req(w.mgr, 'PUT', path(), plan))).toEqual({ items: 2, points: 2 });
    expect(await H.ok(H.req(w.sys, 'PUT', path(), plan))).toEqual({ items: 2, points: 2 });
  });

  it('site staff and finance get 403 and the plan is unchanged', async () => {
    const other = [{ code: null, period: '2026-12', plannedPct: 100 }];
    expect(await H.code(H.req(w.staff1, 'PUT', path(), other))).toBe(403);
    expect(await H.code(H.req(w.fin, 'PUT', path(), other))).toBe(403);
    expect(await H.ok<unknown[]>(H.req(w.mgr, 'GET', path()))).toHaveLength(2);
  });

  it('staff of the site reads it; staff of another site / without sites and another company get 404; a non-member 403', async () => {
    expect(await H.ok<unknown[]>(H.req(w.staff1, 'GET', path()))).toHaveLength(2);
    expect(await H.code(H.req(w.staff2, 'GET', path()))).toBe(404);
    expect(await H.code(H.req(w.staffNone, 'GET', path()))).toBe(404);
    expect(await H.code(H.req(w.mgrB, 'GET', path(), undefined, w.B))).toBe(404);
    expect(await H.code(H.req(w.mgrB, 'GET', path()))).toBe(403);
  });

  it('another company cannot overwrite the plan through its own tenant path (404, nothing written)', async () => {
    expect(await H.code(H.req(w.mgrB, 'PUT', path(), [], w.B))).toBe(404);
    expect(await H.ok<unknown[]>(H.req(w.mgr, 'GET', path()))).toHaveLength(2);
  });

  it('validation: plannedPct > 100, < 0, a malformed period or a non-array body → 400; month 13 passes zod but the service refuses', async () => {
    for (const body of [
      [{ code: 'I.1', period: '2026-09', plannedPct: 100.5 }],
      [{ code: 'I.1', period: '2026-09', plannedPct: -1 }],
      [{ code: 'I.1', period: '2026/09', plannedPct: 1 }],
      [{ code: 'I.1', period: '2026-13', plannedPct: 1 }],
      [{ code: '', period: '2026-09', plannedPct: 1 }],
      { code: 'I.1', period: '2026-09', plannedPct: 1 },
    ]) {
      expect(await H.code(H.req(w.mgr, 'PUT', path(), body)), JSON.stringify(body)).toBe(400);
    }
    expect(await H.ok<unknown[]>(H.req(w.mgr, 'GET', path()))).toHaveLength(2);
  });

  it('an unknown contract → 404', async () => {
    expect(await H.code(H.req(w.mgr, 'GET', `/contracts/999999/boq/schedule`))).toBe(404);
    expect(await H.code(H.req(w.mgr, 'PUT', `/contracts/999999/boq/schedule`, plan))).toBe(404);
  });
});

// ---------------------------------------------------------------------------------------------
// opname reports
// ---------------------------------------------------------------------------------------------

describe('createReport (HTTP)', () => {
  let C: Seeded;
  let C2: Seeded;
  beforeAll(async () => {
    C = await seedContract(w, w.A, w.s1);
    C2 = await seedContract(w, w.A, w.s1);
  });

  it('site staff creates a draft at their site; the period is normalised to the 1st; site and reporter come from the context', async () => {
    const r = await H.ok<Report>(H.req(w.staff1, 'POST', '/progress-reports', { contractId: C.K, period: '2026-09-15', note: 'opname minggu 2' }), 201);
    expect(r).toMatchObject({
      period: '2026-09-01', status: 'draft', siteId: w.s1, contractId: C.K, companyId: w.A, reportedBy: w.staff1, approvedBy: null, approvedAt: null, note: 'opname minggu 2',
    });
  });

  it('one report per contract and month: a second one for the same month (any day) → 409, nothing written', async () => {
    expect(await H.code(H.req(w.staff1, 'POST', '/progress-reports', { contractId: C.K, period: '2026-09' }))).toBe(409);
    expect(await H.code(H.req(w.mgr, 'POST', '/progress-reports', { contractId: C.K, period: '2026-09-30' }))).toBe(409);
    expect((await S.reportsOf(C.K)).filter((r) => r.period === '2026-09-01')).toHaveLength(1);
    // another month, or the same month of another contract, are fine
    await H.ok(H.req(w.staff1, 'POST', '/progress-reports', { contractId: C.K, period: '2026-10' }), 201);
    await H.ok(H.req(w.staff1, 'POST', '/progress-reports', { contractId: C2.K, period: '2026-09' }), 201);
  });

  it('refuses a bad period (400) and an unknown contract (404)', async () => {
    expect(await H.code(H.req(w.mgr, 'POST', '/progress-reports', { contractId: C.K, period: '2026-13' }))).toBe(400);
    expect(await H.code(H.req(w.mgr, 'POST', '/progress-reports', { contractId: C.K, period: '2026-00' }))).toBe(400);
    expect(await H.code(H.req(w.mgr, 'POST', '/progress-reports', { contractId: C.K, period: '2026/11' }))).toBe(400);
    expect(await H.code(H.req(w.mgr, 'POST', '/progress-reports', { contractId: C.K }))).toBe(400);
    expect(await H.code(H.req(w.mgr, 'POST', '/progress-reports', { contractId: 999999, period: '2026-11' }))).toBe(404);
    expect(await S.reportsOf(C.K)).toHaveLength(2);
  });

  it('roles: finance → 403; admin proyek and manager may create (OPNAME_ROLES)', async () => {
    expect(await H.code(H.req(w.fin, 'POST', '/progress-reports', { contractId: C.K, period: '2026-11' }))).toBe(403);
    await H.ok(H.req(w.adm, 'POST', '/progress-reports', { contractId: C.K, period: '2026-11' }), 201);
    await H.ok(H.req(w.mgr, 'POST', '/progress-reports', { contractId: C.K, period: '2026-12' }), 201);
  });

  it('staff of another site, staff without sites and another company → 404 and nothing written', async () => {
    const before = (await S.reportsOf(C.K)).length;
    expect(await H.code(H.req(w.staff2, 'POST', '/progress-reports', { contractId: C.K, period: '2027-01' }))).toBe(404);
    expect(await H.code(H.req(w.staffNone, 'POST', '/progress-reports', { contractId: C.K, period: '2027-01' }))).toBe(404);
    expect(await H.code(H.req(w.mgrB, 'POST', '/progress-reports', { contractId: C.K, period: '2027-01' }, w.B))).toBe(404);
    expect(await H.code(H.req(w.mgrB, 'POST', '/progress-reports', { contractId: C.K, period: '2027-01' }))).toBe(403);
    expect(await S.reportsOf(C.K)).toHaveLength(before);
  });

  it('service: createReport through RLS of another company → 404', async () => {
    await rejects(withCompany(w.db, w.B, (tx) => createReport(tx, { companyId: w.B, userId: w.mgrB }, { contractId: C.K, period: '2027-02' })), 404);
  });
});

describe('putReportItems (service)', () => {
  // I.1 100 m³ (50 %), II.1 no volume (30 %), III.1 3 unit (20 %), IV.1 volume 0 (0 %)
  let C: Seeded;
  let other: Seeded;
  let rid = 0;
  const put = (lines: Parameters<typeof putReportItems>[3], reportId = rid) => S.inA((tx) => putReportItems(tx, w.A, reportId, lines));
  const items = async (reportId = rid) => (await S.inA((tx) => getReport(tx, reportId))).items.map((i) => [i.code, i.cumulativeMicroPct, i.qtyDone]);
  beforeAll(async () => {
    C = await seedContract(w, w.A, w.s1, [
      { code: 'I', weight: 50_000_000, isLeaf: false },
      { code: 'I.1', weight: 50_000_000, qty: '100.0000' },
      { code: 'II.1', weight: 30_000_000, qty: null },
      { code: 'III.1', weight: 20_000_000, qty: '3.0000' },
      { code: 'IV.1', weight: 0, qty: '0.0000' },
    ]);
    other = await seedContract(w, w.A, w.s1);
    rid = (await S.inA((tx) => createReport(tx, { companyId: w.A, userId: w.mgr }, { contractId: C.K, period: '2026-09' }))).id;
  });

  it('lines by code or by boqItemId; qtyDone → qty_done/qty, cumulativePct → micro-percent', async () => {
    const res = await put([
      { code: 'I.1', qtyDone: '40' },
      { boqItemId: C.ids['II.1']!, cumulativePct: 25.5 },
    ]);
    expect(res.items.map((i) => [i.boqItemId, i.cumulativeMicroPct, i.qtyDone])).toEqual([
      [C.ids['I.1'], 40_000_000, '40.0000'], [C.ids['II.1'], 25_500_000, null],
    ]);
    expect(res.items.every((i) => i.companyId === w.A && i.reportId === rid)).toBe(true);
    const full = await S.inA((tx) => getReport(tx, rid));
    expect(full.items.map((i) => [i.code, i.cumulativePct])).toEqual([['I.1', 40], ['II.1', 25.5]]);
  });

  it('qtyDone accepts "12,5", 12.5 and padded strings; rounds qty/total half away from zero (1/3 → 33.333333 %, 2/3 → 66.666667 %)', async () => {
    for (const q of ['12,5', 12.5, ' 12.5 ', '12.5000']) {
      await put([{ code: 'I.1', qtyDone: q }]);
      expect(await items()).toEqual([['I.1', 12_500_000, '12.5000']]);
    }
    await put([{ code: 'III.1', qtyDone: '1' }]);
    expect(await items()).toEqual([['III.1', 33_333_333, '1.0000']]);
    await put([{ code: 'III.1', qtyDone: 2 }]);
    expect(await items()).toEqual([['III.1', 66_666_667, '2.0000']]);
  });

  it('bounds: qtyDone 0 and = volume, cumulativePct 0 and 100 are accepted', async () => {
    await put([{ code: 'I.1', qtyDone: '0' }, { code: 'II.1', cumulativePct: 0 }, { code: 'III.1', qtyDone: '3' }]);
    expect(await items()).toEqual([['I.1', 0, '0.0000'], ['II.1', 0, null], ['III.1', 100_000_000, '3.0000']]);
    await put([{ code: 'I.1', qtyDone: '100.0000' }, { code: 'II.1', cumulativePct: 100 }]);
    expect(await items()).toEqual([['I.1', 100_000_000, '100.0000'], ['II.1', 100_000_000, null]]);
  });

  it('refuses beyond the bounds with 400 and keeps the previous lines', async () => {
    const cases: Array<[Parameters<typeof putReportItems>[3], RegExp]> = [
      [[{ code: 'I.1', qtyDone: '100.0001' }], /0–100/],
      [[{ code: 'III.1', qtyDone: '3.0001' }], /0–100/],
      [[{ code: 'II.1', cumulativePct: 100.000001 }], /0–100/],
      [[{ code: 'II.1', cumulativePct: -0.000001 }], /0–100/],
      [[{ code: 'II.1', cumulativePct: Number.NaN }], /0–100/],
      [[{ code: 'II.1' }], /0–100/], // neither qtyDone nor cumulativePct
      [[{ code: 'I.1', qtyDone: '-1' }], /qtyDone tidak valid/],
      [[{ code: 'I.1', qtyDone: 'abc' }], /qtyDone tidak valid/],
      [[{ code: 'I.1', qtyDone: '1.23456' }], /qtyDone tidak valid/],
      [[{ code: 'II.1', qtyDone: '1' }], /tanpa volume/],
      [[{ code: 'IV.1', qtyDone: '0' }], /tanpa volume/],
    ];
    for (const [lines, msg] of cases) await rejects(put(lines), 400, msg);
    expect(await items()).toEqual([['I.1', 100_000_000, '100.0000'], ['II.1', 100_000_000, null]]);
  });

  it('refuses unknown codes, sections, items of another contract and duplicate items (400)', async () => {
    await rejects(put([{ code: 'I.1', cumulativePct: 1 }, { code: 'ZZ.9', cumulativePct: 1 }]), 400, /baris 2/);
    await rejects(put([{ code: 'I', cumulativePct: 1 }]), 400, /bukan item daun/);
    await rejects(put([{ boqItemId: C.ids['I']!, cumulativePct: 1 }]), 400, /bukan item daun/);
    await rejects(put([{ boqItemId: other.ids['I.1']!, cumulativePct: 1 }]), 400, /bukan item daun/);
    await rejects(put([{ boqItemId: 999_999, cumulativePct: 1 }]), 400);
    await rejects(put([{ code: 'I.1', cumulativePct: 1 }, { boqItemId: C.ids['I.1']!, cumulativePct: 2 }]), 400, /ganda/);
    await rejects(put([{ code: 'II.1', cumulativePct: 1 }, { code: 'II.1', cumulativePct: 1 }]), 400, /ganda/);
    expect(await items()).toHaveLength(2);
  });

  it('replaces all lines of the report; idempotent; an empty list clears them', async () => {
    await put([{ code: 'III.1', qtyDone: '1.5' }]);
    await put([{ code: 'III.1', qtyDone: '1.5' }]);
    expect(await items()).toEqual([['III.1', 50_000_000, '1.5000']]);
    expect((await S.itemsOf(rid))).toHaveLength(1);
    expect((await put([])).items).toEqual([]);
    expect(await S.itemsOf(rid)).toEqual([]);
  });

  it('an unknown report → 404', async () => {
    await rejects(put([{ code: 'I.1', qtyDone: '1' }], 999_999), 404);
  });

  it('only draft and rejected reports are editable; submitted and approved → 409 and lines unchanged', async () => {
    await put([{ code: 'I.1', qtyDone: '10' }]);
    await S.inA((tx) => transitionReport(tx, rid, 'submit', w.mgr));
    await rejects(put([{ code: 'I.1', qtyDone: '20' }]), 409, /submitted/);
    await S.inA((tx) => transitionReport(tx, rid, 'reject', w.mgr));
    await put([{ code: 'I.1', qtyDone: '20' }]);
    expect(await items()).toEqual([['I.1', 20_000_000, '20.0000']]);
    await S.inA((tx) => transitionReport(tx, rid, 'submit', w.mgr));
    await S.inA((tx) => transitionReport(tx, rid, 'approve', w.mgr));
    await rejects(put([{ code: 'I.1', qtyDone: '30' }]), 409, /approved/);
    await rejects(put([]), 409);
    expect(await items()).toEqual([['I.1', 20_000_000, '20.0000']]);
  });

  it('progress cannot go below the latest APPROVED report of an earlier month (equal is fine; drafts/submitted do not count)', async () => {
    // Sep (rid) is approved with I.1 = 20 %
    const oct = await S.drafted(C.K, '2026-10', [{ code: 'I.1', cumulativePct: 20 }]); // equal: allowed
    await rejects(put([{ code: 'I.1', cumulativePct: 19.999999 }], oct.id), 400, /I\.1 turun dari 20%/);
    await rejects(put([{ code: 'I.1', qtyDone: '19.9999' }], oct.id), 400, /turun/);
    await put([{ code: 'I.1', cumulativePct: 60 }, { code: 'II.1', cumulativePct: 0 }], oct.id); // II.1 had nothing approved
    await S.inA((tx) => transitionReport(tx, oct.id, 'submit', w.mgr)); // submitted, NOT approved
    // Nov is compared with Sep (20 %), not with the submitted Oct (60 %)
    const nov = await S.drafted(C.K, '2026-11', [{ code: 'I.1', cumulativePct: 30 }]);
    expect((await S.itemsOf(nov.id)).map((i) => i.cumulativeMicroPct)).toEqual([30_000_000]);
  });

  it('the baseline is the LATEST approved month before, not any approved month', async () => {
    const D = await seedContract(w, w.A, w.s1);
    await S.approved(D.K, '2026-08', [{ code: 'I.1', cumulativePct: 10 }]);
    await S.approved(D.K, '2026-09', [{ code: 'I.1', cumulativePct: 40 }]);
    const oct = await S.drafted(D.K, '2026-10', []);
    await rejects(S.inA((tx) => putReportItems(tx, w.A, oct.id, [{ code: 'I.1', cumulativePct: 30 }])), 400, /turun dari 40%/);
    // an item missing from the latest approved report keeps its own latest approved value
    const E = await seedContract(w, w.A, w.s1);
    await S.approved(E.K, '2026-08', [{ code: 'II.1', cumulativePct: 50 }]);
    await S.approved(E.K, '2026-09', [{ code: 'I.1', cumulativePct: 10 }]);
    const eOct = await S.drafted(E.K, '2026-10', []);
    await rejects(S.inA((tx) => putReportItems(tx, w.A, eOct.id, [{ code: 'II.1', cumulativePct: 49 }])), 400, /II\.1 turun dari 50%/);
  });
});

describe('opname over HTTP: validation, roles and site scope', () => {
  let C: Seeded;
  let rid = 0;
  beforeAll(async () => {
    C = await seedContract(w, w.A, w.s1);
    rid = (await H.ok<Report>(H.req(w.staff1, 'POST', '/progress-reports', { contractId: C.K, period: '2026-09' }), 201)).id;
  });

  it('site staff fills their report; GET returns codes and percents', async () => {
    const res = await H.ok<{ items: Array<{ cumulativeMicroPct: number }> }>(H.req(w.staff1, 'PUT', `/progress-reports/${rid}/items`, [
      { code: 'I.1', qtyDone: 40 }, { code: 'II.1', cumulativePct: 25 },
    ]));
    expect(res.items.map((i) => i.cumulativeMicroPct)).toEqual([40_000_000, 25_000_000]);
    const full = await H.ok<FullReport>(H.req(w.staff1, 'GET', `/progress-reports/${rid}`));
    expect(full.items.map((i) => [i.code, i.cumulativePct, i.qtyDone])).toEqual([['I.1', 40, '40.0000'], ['II.1', 25, null]]);
  });

  it('zod: exactly one of boqItemId/code and one of qtyDone/cumulativePct; bounds; → 400 and nothing changed', async () => {
    for (const body of [
      [{ code: 'I.1', boqItemId: C.ids['I.1'], cumulativePct: 1 }],
      [{ cumulativePct: 1 }],
      [{ code: 'I.1', qtyDone: 1, cumulativePct: 1 }],
      [{ code: 'I.1' }],
      [{ code: 'I.1', cumulativePct: 100.1 }],
      [{ code: 'I.1', cumulativePct: -1 }],
      [{ code: 'I.1', qtyDone: -1 }],
      [{ code: 'I.1', qtyDone: '' }],
      { code: 'I.1', cumulativePct: 1 },
    ]) {
      expect(await H.code(H.req(w.staff1, 'PUT', `/progress-reports/${rid}/items`, body)), JSON.stringify(body)).toBe(400);
    }
    expect(await S.itemsOf(rid)).toHaveLength(2);
  });

  // Regression (was a defect): parseQty (src/domain/quantity.ts) accepts up to 14 integer digits, i.e. qty4 values above
  // Number.MAX_SAFE_INTEGER; putReportItems then calls mulDiv with that unsafe integer, which throws
  // RangeError → unhandled → HTTP 500 instead of the 400 every other bad qtyDone gets.
  it('a very large qtyDone is a 400 (not a 500)', async () => {
    const res = await H.req(w.staff1, 'PUT', `/progress-reports/${rid}/items`, [{ code: 'I.1', qtyDone: '99999999999999' }]);
    expect(res.status).not.toBe(500);
    expect(await S.itemsOf(rid)).toHaveLength(2);
  });

  it('finance → 403; staff of another site / without sites → 404; another company → 404; nothing written', async () => {
    const body = [{ code: 'I.1', cumulativePct: 99 }];
    expect(await H.code(H.req(w.fin, 'PUT', `/progress-reports/${rid}/items`, body))).toBe(403);
    expect(await H.code(H.req(w.staff2, 'PUT', `/progress-reports/${rid}/items`, body))).toBe(404);
    expect(await H.code(H.req(w.staffNone, 'PUT', `/progress-reports/${rid}/items`, body))).toBe(404);
    expect(await H.code(H.req(w.mgrB, 'PUT', `/progress-reports/${rid}/items`, body, w.B))).toBe(404);
    expect((await S.itemsOf(rid)).map((i) => i.cumulativeMicroPct)).toEqual([40_000_000, 25_000_000]);
    expect(await H.code(H.req(w.staff2, 'GET', `/progress-reports/${rid}`))).toBe(404);
    expect(await H.code(H.req(w.mgrB, 'GET', `/progress-reports/${rid}`, undefined, w.B))).toBe(404);
  });

  it('the list is scoped: staff of another site and another company do not see the report; filters work', async () => {
    const mine = await H.ok<Report[]>(H.req(w.staff1, 'GET', `/progress-reports?contractId=${C.K}`));
    expect(mine.map((r) => r.id)).toEqual([rid]);
    expect(await H.ok<Report[]>(H.req(w.staff2, 'GET', `/progress-reports?contractId=${C.K}`))).toEqual([]);
    expect((await H.ok<Report[]>(H.req(w.staff2, 'GET', '/progress-reports'))).some((r) => r.id === rid)).toBe(false);
    expect(await H.ok<Report[]>(H.req(w.staffNone, 'GET', '/progress-reports'))).toEqual([]);
    expect((await H.ok<Report[]>(H.req(w.mgrB, 'GET', '/progress-reports', undefined, w.B))).some((r) => r.id === rid)).toBe(false);
    expect(await H.ok<Report[]>(H.req(w.mgr, 'GET', `/progress-reports?contractId=${C.K}&status=approved`))).toEqual([]);
    expect((await H.ok<Report[]>(H.req(w.mgr, 'GET', `/progress-reports?contractId=${C.K}&status=draft`))).map((r) => r.id)).toEqual([rid]);
    expect(await H.code(H.req(w.mgr, 'GET', '/progress-reports?status=bogus'))).toBe(400);
  });
});

// ---------------------------------------------------------------------------------------------
// approval flow
// ---------------------------------------------------------------------------------------------

describe('transitionReport over HTTP: staff enters opname, the manager approves', () => {
  let C: Seeded;
  beforeAll(async () => { C = await seedContract(w, w.A, w.s1); });
  const create = async (period: string, user = w.staff1) => (await H.ok<Report>(H.req(user, 'POST', '/progress-reports', { contractId: C.K, period }), 201)).id;
  // months are approved in order below, so each fill uses a value no lower than the months before
  const fill = (id: number, user = w.staff1, pct = 50) => H.ok(H.req(user, 'PUT', `/progress-reports/${id}/items`, [{ code: 'I.1', cumulativePct: pct }]));
  const act = (id: number, action: string, user: number) => H.req(user, 'POST', `/progress-reports/${id}/${action}`);
  const statusOf = async (id: number) => (await H.ok<Report>(H.req(w.mgr, 'GET', `/progress-reports/${id}`))).status;

  it('an empty report cannot be submitted (409)', async () => {
    const id = await create('2026-01');
    expect(await H.code(act(id, 'submit', w.staff1))).toBe(409);
    expect(await statusOf(id)).toBe('draft');
  });

  it('draft → submitted (staff) → approved (manager); approvedBy/approvedAt are set', async () => {
    const id = await create('2026-02');
    await fill(id, w.staff1, 10);
    const sub = await H.ok<Report>(act(id, 'submit', w.staff1));
    expect(sub).toMatchObject({ status: 'submitted', approvedBy: null, approvedAt: null });
    for (const u of [w.staff1, w.adm, w.fin]) expect(await H.code(act(id, 'approve', u))).toBe(403);
    for (const u of [w.staff1, w.adm, w.fin]) expect(await H.code(act(id, 'reject', u))).toBe(403);
    expect(await statusOf(id)).toBe('submitted');
    const ap = await H.ok<Report>(act(id, 'approve', w.mgr));
    expect(ap).toMatchObject({ status: 'approved', approvedBy: w.mgr });
    expect(ap.approvedAt).not.toBeNull();
  });

  it('refuses transitions from the wrong status with 409 and leaves the status', async () => {
    const id = await create('2026-03');
    await fill(id, w.staff1, 10);
    expect(await H.code(act(id, 'approve', w.mgr))).toBe(409); // draft
    expect(await H.code(act(id, 'reject', w.mgr))).toBe(409);
    expect(await statusOf(id)).toBe('draft');
    await H.ok(act(id, 'submit', w.staff1));
    expect(await H.code(act(id, 'submit', w.staff1))).toBe(409); // already submitted
    await H.ok(act(id, 'approve', w.mgr));
    for (const a of ['approve', 'reject', 'submit']) expect(await H.code(act(id, a, w.mgr)), a).toBe(409);
    expect(await statusOf(id)).toBe('approved');
    expect(await H.code(act(id, 'publish', w.mgr))).toBe(404);
  });

  it('rejected → edited → resubmitted → approved; reject does not record an approver', async () => {
    const id = await create('2026-04');
    await fill(id, w.staff1, 10);
    await H.ok(act(id, 'submit', w.staff1));
    const rj = await H.ok<Report>(act(id, 'reject', w.mgr));
    expect(rj).toMatchObject({ status: 'rejected', approvedBy: null, approvedAt: null });
    await H.ok(H.req(w.staff1, 'PUT', `/progress-reports/${id}/items`, [{ code: 'I.1', cumulativePct: 12 }]));
    await H.ok(act(id, 'submit', w.staff1));
    await H.ok(act(id, 'approve', w.sys));
    const full = await H.ok<FullReport>(H.req(w.staff1, 'GET', `/progress-reports/${id}`));
    expect(full).toMatchObject({ status: 'approved', approvedBy: w.sys });
    expect(full.items.map((i) => i.cumulativePct)).toEqual([12]);
  });

  it('admin proyek may create and submit but not approve; finance cannot submit', async () => {
    const id = await create('2026-05', w.adm);
    await fill(id, w.adm);
    expect(await H.code(act(id, 'submit', w.fin))).toBe(403);
    await H.ok(act(id, 'submit', w.adm));
    expect(await H.code(act(id, 'approve', w.adm))).toBe(403);
    expect(await statusOf(id)).toBe('submitted');
  });

  it('site scope and tenancy: staff of another site / another company cannot submit or approve (404), nothing changes', async () => {
    const id = await create('2026-06');
    await fill(id);
    expect(await H.code(act(id, 'submit', w.staff2))).toBe(404);
    expect(await H.code(act(id, 'submit', w.staffNone))).toBe(404);
    expect(await statusOf(id)).toBe('draft');
    await H.ok(act(id, 'submit', w.staff1));
    expect(await H.code(act(id, 'approve', w.mgrB))).toBe(403); // not a member of A
    expect(await H.code(H.req(w.mgrB, 'POST', `/progress-reports/${id}/approve`, undefined, w.B))).toBe(404);
    expect(await H.code(H.req(w.mgrB, 'POST', `/progress-reports/${id}/reject`, undefined, w.B))).toBe(404);
    expect(await statusOf(id)).toBe('submitted');
  });
});
