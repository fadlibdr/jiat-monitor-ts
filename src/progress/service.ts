import { and, asc, desc, eq, gt, inArray, lt, type SQL } from 'drizzle-orm';
import { HTTPException } from 'hono/http-exception';
import { mulDiv } from '../domain/contract.js';
import { parseQty, qtyToString } from '../domain/quantity.js';
import { computeSCurve, MICRO_100, pctToMicro, periodOf, type ActualPoint, type PlanPoint } from '../domain/scurve.js';
import { codesOf, currentLeaves, type BoqItemRow } from '../boq/current.js';
import { boqItems, boqSchedules, boqVersions, contracts, progressItems, progressReports } from '../db/schema.js';
import type { Tx } from '../db/tenant.js';

/**
 * Physical progress (HLD §4 "Progres: opname per item BOQ per periode, kurva S"). Plans and actuals
 * are cumulative micro-percent per leaf item and period (domain/scurve.ts explains why).
 */

// --- plan (boq_schedules) ---

export interface ScheduleEntry { code: string | null; period: string; plannedPct: number }

/**
 * Replaces the plan of the contract's current BOQ. `code: null` applies a line to every leaf
 * (a contract-level S-curve, when only that is known). Per item the plan must not decrease.
 */
export async function putSchedule(tx: Tx, companyId: number, contractId: number, entries: readonly ScheduleEntry[]) {
  const leaves = await currentLeaves(tx, contractId);
  if (!leaves.length) throw new HTTPException(409, { message: 'Kontrak belum punya BOQ; impor BOQ dulu.' });
  const byCode = new Map(leaves.map((l) => [l.code, l]));
  const plan = new Map<number, Map<string, number>>(); // leaf id → period → micro
  for (const [k, e] of entries.entries()) {
    const period = periodOf(e.period);
    const micro = pctToMicro(e.plannedPct);
    if (!period || micro === null) throw new HTTPException(400, { message: `baris ${k + 1}: periode YYYY-MM dan plannedPct 0–100.` });
    const targets: BoqItemRow[] = e.code === null ? leaves : [byCode.get(e.code)].filter((x): x is BoqItemRow => !!x);
    if (!targets.length) throw new HTTPException(400, { message: `baris ${k + 1}: kode ${e.code} bukan item daun BOQ aktif.` });
    for (const t of targets) {
      const m = plan.get(t.id) ?? new Map<string, number>();
      m.set(period, micro); // a later, more specific line overrides
      plan.set(t.id, m);
    }
  }
  for (const [leafId, m] of plan) {
    let prev = -1;
    for (const p of [...m.keys()].sort()) {
      if (m.get(p)! < prev) throw new HTTPException(400, { message: `Rencana item ${leaves.find((l) => l.id === leafId)!.code} menurun pada ${p.slice(0, 7)}.` });
      prev = m.get(p)!;
    }
  }
  await tx.delete(boqSchedules).where(inArray(boqSchedules.boqItemId, leaves.map((l) => l.id)));
  const rows = [...plan].flatMap(([boqItemId, m]) => [...m].map(([period, plannedMicroPct]) => ({ companyId, boqItemId, period, plannedMicroPct })));
  if (rows.length) await tx.insert(boqSchedules).values(rows);
  return { items: plan.size, points: rows.length };
}

export async function getSchedule(tx: Tx, contractId: number) {
  const leaves = await currentLeaves(tx, contractId);
  const order = new Map(leaves.map((l, i) => [l.code, i]));
  return (await currentPlan(tx, contractId, leaves))
    .sort((a, b) => order.get(a.code)! - order.get(b.code)! || a.period.localeCompare(b.period))
    .map((p) => ({ code: p.code, period: p.period, plannedPct: p.plannedMicroPct / 1_000_000 }));
}

/**
 * The plan of the current BOQ, by code. Plans are stored per BOQ item of one version; a re-import
 * makes a new version with new item ids, so the plan is read from the NEWEST version of the
 * contract that has one, matched to the current leaves by code — like the actuals. A re-import
 * therefore keeps the plan of every unchanged code, and a PUT after it replaces the plan whole.
 */
async function currentPlan(tx: Tx, contractId: number, leaves: readonly BoqItemRow[]): Promise<PlanPoint[]> {
  if (!leaves.length) return [];
  const rows = await tx.select({ version: boqVersions.version, code: boqItems.code, period: boqSchedules.period, plannedMicroPct: boqSchedules.plannedMicroPct })
    .from(boqSchedules)
    .innerJoin(boqItems, eq(boqItems.id, boqSchedules.boqItemId))
    .innerJoin(boqVersions, eq(boqVersions.id, boqItems.versionId))
    .where(eq(boqVersions.contractId, contractId));
  if (!rows.length) return [];
  const newest = Math.max(...rows.map((r) => r.version));
  const current = new Set(leaves.map((l) => l.code));
  return rows.filter((r) => r.version === newest && current.has(r.code))
    .map((r) => ({ code: r.code, period: r.period, plannedMicroPct: r.plannedMicroPct }));
}

// --- opname reports ---

export async function createReport(tx: Tx, actor: { companyId: number; userId: number }, input: { contractId: number; period: string; note?: string | undefined }) {
  const period = periodOf(input.period);
  if (!period) throw new HTTPException(400, { message: 'periode harus YYYY-MM.' });
  const [k] = await tx.select({ siteId: contracts.siteId }).from(contracts).where(eq(contracts.id, input.contractId));
  if (!k) throw new HTTPException(404, { message: 'Kontrak tidak ditemukan pada perusahaan ini.' });
  const [row] = await tx.insert(progressReports).values({
    companyId: actor.companyId, siteId: k.siteId, contractId: input.contractId, period, reportedBy: actor.userId, note: input.note ?? null,
  }).returning();
  return row!;
}

export interface OpnameInput { boqItemId?: number | undefined; code?: string | undefined; qtyDone?: string | number | undefined; cumulativePct?: number | undefined }

/**
 * Replaces the lines of a draft/rejected report. Each line: a leaf of the current BOQ, cumulative
 * progress from the quantity done (qty_done / qty) or given as a percent, between 0 and 100 %, and
 * not below the last approved report before this period (progress does not go backwards).
 */
export async function putReportItems(tx: Tx, companyId: number, reportId: number, lines: readonly OpnameInput[]) {
  const report = await lockReport(tx, reportId);
  if (report.status !== 'draft' && report.status !== 'rejected') throw new HTTPException(409, { message: `Laporan berstatus ${report.status}; hanya draft/ditolak yang bisa diubah.` });
  const leaves = await currentLeaves(tx, report.contractId);
  const byId = new Map(leaves.map((l) => [l.id, l]));
  const byCode = new Map(leaves.map((l) => [l.code, l]));
  const bounds = await approvedBounds(tx, report.contractId, report.period);

  const seen = new Set<number>();
  const rows = lines.map((line, k) => {
    const leaf = line.boqItemId !== undefined ? byId.get(line.boqItemId) : line.code !== undefined ? byCode.get(line.code) : undefined;
    if (!leaf) throw new HTTPException(400, { message: `baris ${k + 1}: bukan item daun BOQ aktif kontrak ini.` });
    if (seen.has(leaf.id)) throw new HTTPException(400, { message: `baris ${k + 1}: item ${leaf.code} ganda.` });
    seen.add(leaf.id);
    let micro: number | null = null;
    let qtyDone: string | null = null;
    if (line.qtyDone !== undefined) {
      const done = parseQty(line.qtyDone);
      const total = leaf.qty === null ? null : parseQty(leaf.qty);
      if (done === null) throw new HTTPException(400, { message: `baris ${k + 1}: qtyDone tidak valid.` });
      if (!total) throw new HTTPException(400, { message: `baris ${k + 1}: item ${leaf.code} tanpa volume; isi cumulativePct.` });
      micro = mulDiv(done, MICRO_100, total);
      qtyDone = qtyToString(done);
    } else if (line.cumulativePct !== undefined) {
      micro = pctToMicro(line.cumulativePct);
    }
    if (micro === null || micro < 0 || micro > MICRO_100) throw new HTTPException(400, { message: `baris ${k + 1}: progres harus 0–100 %.` });
    const outOfOrder = monotonicViolation(bounds, leaf.code, micro);
    if (outOfOrder) throw new HTTPException(400, { message: `baris ${k + 1}: ${outOfOrder}` });
    return { companyId, reportId, boqItemId: leaf.id, qtyDone, cumulativeMicroPct: micro };
  });
  await tx.delete(progressItems).where(eq(progressItems.reportId, reportId));
  const saved = rows.length ? await tx.insert(progressItems).values(rows).returning() : [];
  return { ...report, items: saved };
}

async function lockReport(tx: Tx, reportId: number) {
  const [r] = await tx.select().from(progressReports).where(eq(progressReports.id, reportId)).for('update');
  if (!r) throw new HTTPException(404, { message: 'Laporan progres tidak ditemukan.' });
  return r;
}

/**
 * Cumulative progress may never go down along the APPROVED curve. Per code: the floor is the latest
 * approved report before `period`, the ceiling the earliest approved report after it (a back-dated
 * month must not exceed a later month that is already approved).
 */
interface Bounds { floor: Map<string, { micro: number; period: string }>; ceiling: Map<string, { micro: number; period: string }> }

async function approvedBounds(tx: Tx, contractId: number, period: string): Promise<Bounds> {
  const before = await approvedByCode(tx, contractId, lt(progressReports.period, period), 'latest');
  const after = await approvedByCode(tx, contractId, gt(progressReports.period, period), 'earliest');
  return { floor: before, ceiling: after };
}

function monotonicViolation(b: Bounds, code: string, micro: number): string | null {
  const floor = b.floor.get(code);
  if (floor && micro < floor.micro) return `progres ${code} turun dari ${floor.micro / 1_000_000}% (disetujui ${floor.period.slice(0, 7)}).`;
  const ceiling = b.ceiling.get(code);
  if (ceiling && micro > ceiling.micro) return `progres ${code} melebihi ${ceiling.micro / 1_000_000}% yang sudah disetujui untuk ${ceiling.period.slice(0, 7)}.`;
  return null;
}

/** code → cumulative micro-percent of the latest (or earliest) approved report matching `when`. */
async function approvedByCode(tx: Tx, contractId: number, when: SQL, pick: 'latest' | 'earliest') {
  const reports = await tx.select({ id: progressReports.id, period: progressReports.period }).from(progressReports)
    .where(and(eq(progressReports.contractId, contractId), eq(progressReports.status, 'approved'), when))
    .orderBy(pick === 'latest' ? desc(progressReports.period) : asc(progressReports.period));
  const out = new Map<string, { micro: number; period: string }>();
  if (!reports.length) return out;
  const items = await tx.select().from(progressItems).where(inArray(progressItems.reportId, reports.map((r) => r.id)));
  const codes = await codesOf(tx, items.map((i) => i.boqItemId));
  const rank = new Map(reports.map((r, i) => [r.id, i])); // 0 = the one closest to the period
  const periodOf = new Map(reports.map((r) => [r.id, r.period]));
  const best = new Map<string, number>();
  for (const it of items) {
    const code = codes.get(it.boqItemId)!;
    const r = rank.get(it.reportId)!;
    if (best.has(code) && best.get(code)! <= r) continue;
    best.set(code, r);
    out.set(code, { micro: it.cumulativeMicroPct, period: periodOf.get(it.reportId)! });
  }
  return out;
}

const REPORT_FLOW = {
  submit: { from: ['draft', 'rejected'], to: 'submitted' },
  approve: { from: ['submitted'], to: 'approved' },
  reject: { from: ['submitted'], to: 'rejected' },
} as const;

export async function transitionReport(tx: Tx, reportId: number, action: keyof typeof REPORT_FLOW, userId: number) {
  const report = await lockReport(tx, reportId);
  const flow = REPORT_FLOW[action];
  if (!(flow.from as readonly string[]).includes(report.status)) {
    throw new HTTPException(409, { message: `Laporan berstatus ${report.status}; ${action} hanya dari ${flow.from.join('/')}.` });
  }
  if (action === 'submit') {
    const [one] = await tx.select({ id: progressItems.id }).from(progressItems).where(eq(progressItems.reportId, reportId)).limit(1);
    if (!one) throw new HTTPException(409, { message: 'Laporan kosong; isi item opname dulu.' });
  }
  if (action === 'approve') {
    // re-checked here: another month may have been approved since these lines were saved. The
    // contract row is locked so two approvals of one contract are checked one after the other.
    await tx.select({ id: contracts.id }).from(contracts).where(eq(contracts.id, report.contractId)).for('update');
    const bounds = await approvedBounds(tx, report.contractId, report.period);
    const items = await tx.select().from(progressItems).where(eq(progressItems.reportId, reportId));
    const codes = await codesOf(tx, items.map((i) => i.boqItemId));
    for (const it of items) {
      const outOfOrder = monotonicViolation(bounds, codes.get(it.boqItemId)!, it.cumulativeMicroPct);
      if (outOfOrder) throw new HTTPException(409, { message: `Belum bisa disetujui: ${outOfOrder}` });
    }
  }
  const approval = action === 'approve' ? { approvedBy: userId, approvedAt: new Date() } : {};
  const [row] = await tx.update(progressReports).set({ status: flow.to, ...approval }).where(eq(progressReports.id, reportId)).returning();
  return row!;
}

export async function getReport(tx: Tx, reportId: number) {
  const [r] = await tx.select().from(progressReports).where(eq(progressReports.id, reportId));
  if (!r) throw new HTTPException(404, { message: 'Laporan progres tidak ditemukan.' });
  const items = await tx.select().from(progressItems).where(eq(progressItems.reportId, reportId)).orderBy(asc(progressItems.id));
  const codes = await codesOf(tx, items.map((i) => i.boqItemId));
  return { ...r, items: items.map((i) => ({ ...i, code: codes.get(i.boqItemId)!, cumulativePct: i.cumulativeMicroPct / 1_000_000 })) };
}

// --- S-curve ---

/** Plan vs actual (approved reports only) for one contract, in percent with 6 decimals. */
export async function sCurve(tx: Tx, contractId: number) {
  const points = (await sCurveMicro(tx, contractId)).map((p) => ({
    period: p.period,
    plannedPct: p.plannedMicroPct / 1_000_000,
    actualPct: p.actualMicroPct === null ? null : p.actualMicroPct / 1_000_000,
    deviationPct: p.deviationMicroPct === null ? null : p.deviationMicroPct / 1_000_000,
  }));
  const latest = [...points].reverse().find((p) => p.actualPct !== null) ?? null;
  return { points, latest };
}

/** Latest approved weighted progress of a contract, micro-percent (0 when nothing is approved). */
export async function latestActualMicro(tx: Tx, contractId: number): Promise<number> {
  const points = await sCurveMicro(tx, contractId);
  return [...points].reverse().find((p) => p.actualMicroPct !== null)?.actualMicroPct ?? 0;
}

/** The S-curve in exact micro-percent (what dashboards and termin triggers compare). */
export async function sCurveMicro(tx: Tx, contractId: number) {
  const leaves = await currentLeaves(tx, contractId);
  const leafWeights = leaves.map((l) => ({ code: l.code, weightMicroPct: l.weightMicroPct }));
  const plan = await currentPlan(tx, contractId, leaves);
  const approved = await tx.select({ id: progressReports.id, period: progressReports.period }).from(progressReports)
    .where(and(eq(progressReports.contractId, contractId), eq(progressReports.status, 'approved')));
  const items = approved.length ? await tx.select().from(progressItems).where(inArray(progressItems.reportId, approved.map((r) => r.id))) : [];
  const itemCodes = await codesOf(tx, items.map((i) => i.boqItemId));
  const periodOfReport = new Map(approved.map((r) => [r.id, r.period]));
  const actual: ActualPoint[] = items.map((i) => ({ code: itemCodes.get(i.boqItemId)!, period: periodOfReport.get(i.reportId)!, cumulativeMicroPct: i.cumulativeMicroPct }));
  return computeSCurve(leafWeights, plan, actual);
}
