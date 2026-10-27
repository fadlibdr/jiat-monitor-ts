/**
 * Kurva S: weighted physical progress, plan vs actual, per period. Pure.
 *
 * Fixes the three problems of the LLD §8 SQL (docs/remaining-work.md §5.2):
 *  - weights are those of the LEAF items (opname is recorded per item), not level-0 sections;
 *  - a period without an approved report carries the last approved cumulative forward instead
 *    of dropping to 0;
 *  - plan points are CUMULATIVE (% of the item complete by the end of the period), the same
 *    unit as actuals, and carry forward the same way.
 * Items are matched by BOQ code, so progress recorded against an older BOQ version still counts
 * after a re-import (docs/remaining-work.md §5.3: "carry rows over by code").
 *
 * Units: micro-percent integers (100 % = 100_000_000). Products are computed in BigInt, because
 * weight × percent (1e8 × 1e8) exceeds 2^53.
 */
export const MICRO_100 = 100_000_000;

export interface LeafWeight { code: string; weightMicroPct: number }
/** period = first day of the month, ISO (YYYY-MM-01) */
export interface PlanPoint { code: string; period: string; plannedMicroPct: number }
export interface ActualPoint { code: string; period: string; cumulativeMicroPct: number }
export interface SCurvePoint {
  period: string;
  plannedMicroPct: number;
  /** null after the last approved report (the future has no actual) */
  actualMicroPct: number | null;
  deviationMicroPct: number | null;
}

export function computeSCurve(leaves: readonly LeafWeight[], plan: readonly PlanPoint[], actual: readonly ActualPoint[]): SCurvePoint[] {
  const periods = [...new Set([...plan.map((p) => p.period), ...actual.map((a) => a.period)])].sort();
  const lastActual = actual.reduce<string | null>((m, a) => (m === null || a.period > m ? a.period : m), null);
  const planBy = cumulativeLookup(plan.map((p) => ({ code: p.code, period: p.period, value: p.plannedMicroPct })));
  const actualBy = cumulativeLookup(actual.map((a) => ({ code: a.code, period: a.period, value: a.cumulativeMicroPct })));

  return periods.map((period) => {
    const planned = weighted(leaves, (code) => planBy(code, period));
    const act = lastActual !== null && period <= lastActual ? weighted(leaves, (code) => actualBy(code, period)) : null;
    return { period, plannedMicroPct: planned, actualMicroPct: act, deviationMicroPct: act === null ? null : act - planned };
  });
}

/** Σ weight × pct / 100 %, exact, rounded half up to a micro-percent. */
function weighted(leaves: readonly LeafWeight[], pctOf: (code: string) => number): number {
  let sum = 0n;
  for (const l of leaves) sum += BigInt(l.weightMicroPct) * BigInt(pctOf(l.code));
  return Number((sum + BigInt(MICRO_100 / 2)) / BigInt(MICRO_100));
}

/** (code, period) → latest value at or before period, 0 if none (carry forward). */
function cumulativeLookup(points: ReadonlyArray<{ code: string; period: string; value: number }>) {
  const byCode = new Map<string, Array<{ period: string; value: number }>>();
  for (const p of points) {
    const list = byCode.get(p.code) ?? [];
    list.push({ period: p.period, value: p.value });
    byCode.set(p.code, list);
  }
  for (const list of byCode.values()) list.sort((a, b) => a.period.localeCompare(b.period));
  return (code: string, period: string): number => {
    const list = byCode.get(code);
    if (!list) return 0;
    let v = 0;
    for (const p of list) {
      if (p.period > period) break;
      v = p.value;
    }
    return v;
  };
}

/** "2026-10" / "2026-10-15" → "2026-10-01"; null if not a valid month. */
export function periodOf(raw: string): string | null {
  const m = /^(\d{4})-(\d{2})(?:-(\d{2}))?$/.exec(raw);
  if (!m) return null;
  const month = Number(m[2]);
  if (month < 1 || month > 12) return null;
  return `${m[1]}-${m[2]}-01`;
}

/** Percent with up to 6 decimals (e.g. 41.25) → micro-percent integer; null when outside 0..100. */
export function pctToMicro(pct: number): number | null {
  if (!Number.isFinite(pct) || pct < 0 || pct > 100) return null;
  return Math.round(pct * 1_000_000);
}

export function microToPct(micro: number): number {
  return micro / 1_000_000;
}
