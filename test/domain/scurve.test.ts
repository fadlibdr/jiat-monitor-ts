import { describe, expect, it } from 'vitest';
import { combineCurves, computeSCurve, MICRO_100, microToPct, pctToMicro, periodOf } from '../../src/domain/scurve.js';

const pct = (p: number) => p * 1_000_000;
/** two leaves: A carries 60 %, B 40 % of the contract */
const leaves = [{ code: 'I.1', weightMicroPct: pct(60) }, { code: 'II.A.1', weightMicroPct: pct(40) }];

describe('computeSCurve', () => {
  it('weights cumulative plan and actual by leaf weight', () => {
    const curve = computeSCurve(leaves,
      [{ code: 'I.1', period: '2026-01-01', plannedMicroPct: pct(50) }, { code: 'II.A.1', period: '2026-01-01', plannedMicroPct: pct(25) }],
      [{ code: 'I.1', period: '2026-01-01', cumulativeMicroPct: pct(40) }, { code: 'II.A.1', period: '2026-01-01', cumulativeMicroPct: pct(50) }]);
    // planned 0.6×50 + 0.4×25 = 40 ; actual 0.6×40 + 0.4×50 = 44
    expect(curve).toEqual([{ period: '2026-01-01', plannedMicroPct: pct(40), actualMicroPct: pct(44), deviationMicroPct: pct(4) }]);
  });

  it('a month without a report carries the last approved cumulative forward (never drops to 0)', () => {
    const curve = computeSCurve(leaves,
      [{ code: 'I.1', period: '2026-01-01', plannedMicroPct: pct(10) }, { code: 'I.1', period: '2026-02-01', plannedMicroPct: pct(20) }, { code: 'I.1', period: '2026-03-01', plannedMicroPct: pct(30) }],
      [{ code: 'I.1', period: '2026-01-01', cumulativeMicroPct: pct(10) }, { code: 'I.1', period: '2026-03-01', cumulativeMicroPct: pct(25) }]);
    expect(curve.map((p) => p.actualMicroPct)).toEqual([pct(6), pct(6), pct(15)]);
    expect(curve.map((p) => p.deviationMicroPct)).toEqual([0, pct(-6), pct(-3)]);
  });

  it('periods after the last report have a plan but no actual', () => {
    const curve = computeSCurve(leaves,
      [{ code: 'I.1', period: '2026-01-01', plannedMicroPct: pct(50) }, { code: 'I.1', period: '2026-06-01', plannedMicroPct: pct(100) }],
      [{ code: 'I.1', period: '2026-01-01', cumulativeMicroPct: pct(50) }]);
    expect(curve[1]).toEqual({ period: '2026-06-01', plannedMicroPct: pct(60), actualMicroPct: null, deviationMicroPct: null });
  });

  it('a fully planned and fully done contract reaches exactly 100 %, without float drift', () => {
    const thirds = [{ code: 'a', weightMicroPct: 33_333_333 }, { code: 'b', weightMicroPct: 33_333_333 }, { code: 'c', weightMicroPct: 33_333_334 }];
    const all = (k: 'plannedMicroPct' | 'cumulativeMicroPct') => thirds.map((t) => ({ code: t.code, period: '2026-12-01', [k]: MICRO_100 }));
    const [p] = computeSCurve(thirds, all('plannedMicroPct') as never, all('cumulativeMicroPct') as never);
    expect(p).toMatchObject({ plannedMicroPct: MICRO_100, actualMicroPct: MICRO_100, deviationMicroPct: 0 });
  });

  it('progress of an item absent from the current BOQ is ignored; an item without plan counts 0 planned', () => {
    const curve = computeSCurve(leaves, [], [{ code: 'GONE', period: '2026-01-01', cumulativeMicroPct: pct(100) }, { code: 'I.1', period: '2026-01-01', cumulativeMicroPct: pct(100) }]);
    expect(curve).toEqual([{ period: '2026-01-01', plannedMicroPct: 0, actualMicroPct: pct(60), deviationMicroPct: pct(60) }]);
  });

  it('no plan and no actual → empty curve', () => {
    expect(computeSCurve(leaves, [], [])).toEqual([]);
    expect(computeSCurve([], [], [])).toEqual([]);
  });
});

describe('combineCurves (portfolio, weighted by contract DPP)', () => {
  const pt = (period: string, planned: number, actual: number | null) => ({ period, plannedMicroPct: pct(planned), actualMicroPct: actual === null ? null : pct(actual), deviationMicroPct: actual === null ? null : pct(actual - planned) });

  it('weights by DPP and carries each contract forward to the union of periods', () => {
    const combined = combineCurves([
      { weightCents: 300, points: [pt('2026-01-01', 10, 10), pt('2026-02-01', 20, 15)] },
      { weightCents: 100, points: [pt('2026-02-01', 40, 40)] },
    ]);
    // Jan: big 10/10, small has no point yet (0/0) → (3×10 + 1×0)/4 = 7.5 ; Feb: (3×20 + 40)/4 = 25 plan, (3×15 + 40)/4 = 21.25 actual
    expect(combined).toEqual([
      { period: '2026-01-01', plannedMicroPct: pct(7.5), actualMicroPct: pct(7.5), deviationMicroPct: 0 },
      { period: '2026-02-01', plannedMicroPct: pct(25), actualMicroPct: pct(21.25), deviationMicroPct: pct(-3.75) },
    ]);
  });

  it('a contract reporting late keeps its last actual; periods after every report have no actual', () => {
    const combined = combineCurves([
      { weightCents: 1, points: [pt('2026-01-01', 10, 10), pt('2026-02-01', 20, 20), pt('2026-03-01', 30, null)] },
      { weightCents: 1, points: [pt('2026-01-01', 10, 5), pt('2026-02-01', 20, null)] },
    ]);
    expect(combined.map((p) => p.actualMicroPct)).toEqual([pct(7.5), pct(12.5), null]);
  });

  it('zero weights and empty curves are ignored; nothing left → empty', () => {
    expect(combineCurves([{ weightCents: 0, points: [pt('2026-01-01', 10, 10)] }, { weightCents: 5, points: [] }])).toEqual([]);
    expect(combineCurves([])).toEqual([]);
  });
});

describe('periodOf / pctToMicro', () => {
  it('normalises a month to its first day; rejects anything else', () => {
    expect([periodOf('2026-10'), periodOf('2026-10-15'), periodOf('2026-13'), periodOf('2026-00'), periodOf('10/2026'), periodOf('')])
      .toEqual(['2026-10-01', '2026-10-01', null, null, null, null]);
  });
  it('percent ↔ micro-percent, refusing outside 0..100', () => {
    expect([pctToMicro(0), pctToMicro(41.25), pctToMicro(100), pctToMicro(100.000001), pctToMicro(-0.1), pctToMicro(Number.NaN)])
      .toEqual([0, 41_250_000, MICRO_100, null, null, null]);
    expect(microToPct(41_250_000)).toBe(41.25);
  });
});
