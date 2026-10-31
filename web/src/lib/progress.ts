import { parseQty, qtyToString } from '../../../src/domain/quantity.js';
import type { Built } from './master.js';
import { qtyText } from './procurement.js';
import type { BoqItem, CurvePoint, OpnameLineInput, PlanEntry, ProgressItem, SCurveData } from './types.js';

/**
 * Plan and opname forms → request bodies. Progress is cumulative per BOQ leaf; the API stores it as
 * micro-percent (100 % = 100_000_000), so percents are read here exactly to 6 decimals and sent as
 * micro / 1e6, which the server rounds back to the same integer.
 */
const fail = (error: string): { ok: false; error: string } => ({ ok: false, error });
const MICRO_PER_PCT = 1_000_000;
const MICRO_100 = 100 * MICRO_PER_PCT;

/** "41,25" / "41.25" / "100" / "7 %" → micro-percent; outside 0–100 or more than 6 decimals → null */
export function parsePctMicro(raw: string): number | null {
  const m = /^(\d{1,3})(?:[.,](\d{1,6}))?\s*%?$/.exec(raw.trim());
  if (!m) return null;
  const micro = Number(m[1]) * MICRO_PER_PCT + Number((m[2] ?? '').padEnd(6, '0'));
  return micro <= MICRO_100 ? micro : null;
}

/** micro-percent → "41,25" (what parsePctMicro reads back) */
export function pctText(micro: number): string {
  const whole = Math.trunc(micro / MICRO_PER_PCT);
  const frac = String(micro % MICRO_PER_PCT).padStart(6, '0').replace(/0+$/, '');
  return frac ? `${whole},${frac}` : String(whole);
}

const toMicro = (pct: number) => Math.round(pct * MICRO_PER_PCT);

/** GET …/s-curve (percent) → the chart's micro-percent points */
export function curvePoints(sc: SCurveData): CurvePoint[] {
  return sc.points.map((p) => ({
    period: p.period,
    plannedMicroPct: toMicro(p.plannedPct),
    actualMicroPct: p.actualPct === null ? null : toMicro(p.actualPct),
    deviationMicroPct: p.deviationPct === null ? null : toMicro(p.deviationPct),
  }));
}

// --- opname ---

export interface OpnameRow {
  boqItemId: number;
  code: string;
  description: string;
  unit: string | null;
  /** 'qty': the cumulative volume done (the leaf has a volume); 'pct': the cumulative percent */
  mode: 'qty' | 'pct';
  /** the leaf's current volume (qty4) when measured by volume */
  total: number | null;
  /** the same volume as stored ("26.0000"), for display */
  qty: string | null;
  /** what the user typed; '' = not reported this month */
  value: string;
}

/**
 * One row per leaf of the current BOQ, filled from the saved lines (matched by code). A leaf with a
 * volume is measured by volume, unless its saved line was given as a percent: that line stays one, so
 * saving the form again does not turn it into a rounded volume.
 */
export function opnameRows(items: readonly BoqItem[], saved: readonly ProgressItem[]): OpnameRow[] {
  const byCode = new Map(saved.map((s) => [s.code, s]));
  return items.filter((i) => i.isLeaf).map((leaf) => {
    const q = leaf.qty === null ? null : parseQty(leaf.qty);
    const volume = q !== null && q > 0 ? q : null;
    const s = byCode.get(leaf.code);
    const mode = volume !== null && (!s || s.qtyDone !== null) ? 'qty' : 'pct';
    const value = !s ? '' : mode === 'qty' ? qtyText(s.qtyDone!) : pctText(s.cumulativeMicroPct);
    return { boqItemId: leaf.id, code: leaf.code, description: leaf.description, unit: leaf.unit, mode, total: mode === 'qty' ? volume : null, qty: mode === 'qty' ? leaf.qty : null, value };
  });
}

/** The cumulative percent a row stands for (shown beside a volume), micro-percent; null while unreadable. */
export function rowMicro(r: OpnameRow): number | null {
  const raw = r.value.trim();
  if (!raw) return null;
  if (r.mode === 'pct') return parsePctMicro(raw);
  const q = parseQty(raw);
  return q === null || q < 0 || r.total === null ? null : Math.round((q * MICRO_100) / r.total);
}

/** Rows with a value (empty = not reported); a volume above the BOQ's is refused here (the API would too). */
export function opnameBody(rows: readonly OpnameRow[]): Built<OpnameLineInput[]> {
  const out: OpnameLineInput[] = [];
  for (const r of rows) {
    const raw = r.value.trim();
    if (!raw) continue;
    if (r.mode === 'qty') {
      const q = parseQty(raw);
      if (q === null || q < 0) return fail(`${r.code}: volume tidak terbaca (paling banyak 4 desimal, mis. 12,5).`);
      if (q > r.total!) return fail(`${r.code}: ${qtyText(qtyToString(q))} melebihi volume BOQ ${qtyText(qtyToString(r.total!))}.`);
      out.push({ boqItemId: r.boqItemId, qtyDone: qtyToString(q) });
    } else {
      const micro = parsePctMicro(raw);
      if (micro === null) return fail(`${r.code}: progres 0–100 %, paling banyak 6 desimal.`);
      out.push({ boqItemId: r.boqItemId, cumulativePct: micro / MICRO_PER_PCT });
    }
  }
  if (out.length === 0) return fail('Isi progres minimal satu item.');
  return { ok: true, body: out };
}

// --- plan ---

/** code '' = every leaf (a contract-level plan); month "YYYY-MM"; pct = cumulative plan at month end */
export interface PlanRow { code: string; month: string; pct: string }

/** "2026-12" → "2027-01"; not a month → '' (the user picks one) */
export function nextMonth(month: string): string {
  const m = /^(\d{4})-(\d{2})$/.exec(month);
  if (!m) return '';
  const year = Number(m[1]);
  const mon = Number(m[2]);
  return mon >= 12 ? `${year + 1}-01` : `${m[1]}-${String(mon + 1).padStart(2, '0')}`;
}

/** More rows than this are not put into inputs (a per-item plan of a big BOQ). */
export const PLAN_ROWS_EDITABLE = 500;

/**
 * The stored plan as editable rows. GET answers one point per leaf and month; when every leaf has the
 * same plan, that is a contract-level plan and comes back as one row per month with code ''.
 */
export function planRowsOf(entries: readonly PlanEntry[], leafCodes: readonly string[]): { rows: PlanRow[]; tooLarge: boolean } {
  if (entries.length === 0) return { rows: [], tooLarge: false };
  const byCode = new Map<string, Array<[string, number]>>();
  for (const e of entries) {
    const list = byCode.get(e.code ?? '') ?? [];
    list.push([e.period.slice(0, 7), toMicro(e.plannedPct)]);
    byCode.set(e.code ?? '', list);
  }
  const signature = (list: ReadonlyArray<[string, number]>) => [...list].sort(([a], [b]) => a.localeCompare(b)).map(([p, v]) => `${p}=${v}`).join(';');
  const first = leafCodes[0] === undefined ? undefined : byCode.get(leafCodes[0]);
  const shared = first ? signature(first) : null;
  const uniform = shared !== null && byCode.size === leafCodes.length && leafCodes.every((c) => byCode.has(c) && signature(byCode.get(c)!) === shared);
  const rows: PlanRow[] = uniform
    ? [...first!].sort(([a], [b]) => a.localeCompare(b)).map(([month, micro]) => ({ code: '', month, pct: pctText(micro) }))
    : entries.map((e) => ({ code: e.code ?? '', month: e.period.slice(0, 7), pct: pctText(toMicro(e.plannedPct)) }));
  return rows.length > PLAN_ROWS_EDITABLE ? { rows: [], tooLarge: true } : { rows, tooLarge: false };
}

/**
 * Rows → PUT body (the whole plan). Checked here: a known leaf code, a month 2000–2099, 0–100 %, no row
 * twice, and per code (or for '' = all) a plan that does not go down. A specific code on top of a
 * contract-level plan is checked by the server against the merged plan.
 */
export function scheduleBody(rows: readonly PlanRow[], leafCodes: readonly string[]): Built<PlanEntry[]> {
  if (rows.length === 0) return fail('Tambahkan minimal satu baris rencana.');
  const codes = new Set(leafCodes);
  const seen = new Set<string>();
  const byCode = new Map<string, Array<{ month: string; micro: number }>>();
  const out: PlanEntry[] = [];
  for (const [i, r] of rows.entries()) {
    const n = i + 1;
    const code = r.code.trim();
    if (code && !codes.has(code)) return fail(`Baris ${n}: kode ${code} bukan item daun BOQ kontrak ini.`);
    if (!/^20\d{2}-(0[1-9]|1[0-2])$/.test(r.month)) return fail(`Baris ${n}: pilih bulan (2000–2099).`);
    const micro = parsePctMicro(r.pct);
    if (micro === null) return fail(`Baris ${n}: rencana kumulatif 0–100 %, paling banyak 6 desimal.`);
    const key = `${code}|${r.month}`;
    if (seen.has(key)) return fail(`Baris ${n}: ${code || 'semua item'} bulan ${r.month} sudah ada.`);
    seen.add(key);
    byCode.set(code, [...(byCode.get(code) ?? []), { month: r.month, micro }]);
    out.push({ code: code || null, period: r.month, plannedPct: micro / MICRO_PER_PCT });
  }
  for (const [code, list] of byCode) {
    const sorted = [...list].sort((a, b) => a.month.localeCompare(b.month));
    for (let k = 1; k < sorted.length; k++) {
      if (sorted[k]!.micro < sorted[k - 1]!.micro) return fail(`Rencana ${code || 'semua item'} turun pada ${sorted[k]!.month}; rencana kumulatif tidak boleh turun.`);
    }
  }
  return { ok: true, body: out };
}
