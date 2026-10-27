import { daysLeft, mulDiv } from '../domain/contract.js';
import { combineCurves, progressAt, type SCurvePoint } from '../domain/scurve.js';
import type { DashMoney } from '../db/schema.js';
import type { SnapshotRows } from './snapshot.js';

/**
 * Panels of the dashboard (holding mockup; LLD §8), built from snapshot rows. The company dashboard
 * passes rows computed live, the holding dashboard passes the stored snapshot: one aggregation, so
 * the two can never disagree on a rule.
 */
export interface PanelFilter {
  /** first day of the month the panels are "as of" (cash of the month, plan vs actual) */
  period: string;
  /** curve and monthly series range, first days of months, inclusive */
  from?: string | undefined;
  to?: string | undefined;
  companies?: readonly number[] | undefined;
  siteId?: number | undefined;
  /** contract filters; site × month money and balances are not per contract and ignore them */
  employer?: string | undefined;
  status?: string | undefined;
}

const BP = 10_000;
const ratioBp = (part: number, whole: number) => (whole > 0 ? mulDiv(part, BP, whole) : null);
const sum = <T>(rows: readonly T[], f: (r: T) => number) => rows.reduce((s, r) => s + f(r), 0);
const ZERO: DashMoney = { budgetCents: 0, committedCents: 0, receivedCents: 0 };
const addMoney = (a: DashMoney, b: DashMoney): DashMoney =>
  ({ budgetCents: a.budgetCents + b.budgetCents, committedCents: a.committedCents + b.committedCents, receivedCents: a.receivedCents + b.receivedCents });

/** Lower median; null for none. */
export function median(xs: readonly number[]): number | null {
  if (!xs.length) return null;
  const s = [...xs].sort((a, b) => a - b);
  return s[Math.floor((s.length - 1) / 2)]!;
}

export function filterRows(rows: SnapshotRows, f: PanelFilter): SnapshotRows {
  const inCompany = (r: { companyId: number }) => !f.companies?.length || f.companies.includes(r.companyId);
  const inSite = (r: { siteId: number }) => f.siteId === undefined || r.siteId === f.siteId;
  const employer = f.employer?.toLocaleLowerCase('id');
  const contracts = rows.contracts.filter((k) => inCompany(k) && inSite(k)
    && (!f.status || k.status === f.status) && (!employer || k.employerName.toLocaleLowerCase('id').includes(employer)));
  const ids = new Set(contracts.map((k) => k.contractId));
  const keep = <T extends { companyId: number; siteId: number }>(xs: readonly T[]) => xs.filter((r) => inCompany(r) && inSite(r));
  return {
    contracts,
    progress: rows.progress.filter((p) => ids.has(p.contractId)),
    monthly: keep(rows.monthly),
    balances: keep(rows.balances),
    vendors: keep(rows.vendors),
    // contract alerts follow the contract filter; document alerts follow company and site
    alerts: keep(rows.alerts).filter((a) => !a.ref.startsWith('contract:') || ids.has(Number(a.ref.slice('contract:'.length)))),
  };
}

export function buildPanels(all: SnapshotRows, f: PanelFilter, today: Date) {
  const rows = filterRows(all, f);
  const curveOf = new Map<number, SCurvePoint[]>();
  for (const p of [...rows.progress].sort((a, b) => a.period.localeCompare(b.period))) {
    const list = curveOf.get(p.contractId) ?? [];
    list.push({ period: p.period, plannedMicroPct: p.plannedMicroPct, actualMicroPct: p.actualMicroPct, deviationMicroPct: p.deviationMicroPct });
    curveOf.set(p.contractId, list);
  }
  const weighted = (ks: typeof rows.contracts) =>
    combineCurves(ks.map((k) => ({ weightCents: k.valueDppEffectiveCents, points: curveOf.get(k.contractId) ?? [] })));
  const inRange = (period: string) => (!f.from || period >= f.from) && (!f.to || period <= f.to);
  const portfolio = weighted(rows.contracts);
  const commitment = rows.contracts.reduce((s, k) => addMoney(s, k.commitment.total ?? ZERO), ZERO);
  const costToDate = sum(rows.monthly.filter((m) => m.period <= f.period), (m) => sum(Object.values(m.costByCategory), (v) => v));

  const summary = {
    contracts: rows.contracts.length,
    sites: new Set(rows.contracts.map((k) => `${k.companyId}:${k.siteId}`)).size,
    companies: new Set(rows.contracts.map((k) => k.companyId)).size,
    valueDppEffectiveCents: sum(rows.contracts, (k) => k.valueDppEffectiveCents),
    addendumDeltaCents: sum(rows.contracts, (k) => k.addendumDeltaCents),
    valueTotalCents: sum(rows.contracts, (k) => k.valueTotalCents),
    /** "Realisasi biaya": confirmed vendor invoices (DPP) up to the period, against the BOQ budget */
    costRealisedCents: costToDate,
    budgetCents: commitment.budgetCents,
    costOfBudgetBp: ratioBp(costToDate, commitment.budgetCents),
    progress: progressAt(portfolio, f.period),
  };

  const companyIds = [...new Set(rows.contracts.map((k) => k.companyId))].sort((a, b) => a - b);
  const byCompany = companyIds.map((companyId) => {
    const ks = rows.contracts.filter((k) => k.companyId === companyId);
    return { companyId, contracts: ks.length, valueDppEffectiveCents: sum(ks, (k) => k.valueDppEffectiveCents), progress: progressAt(weighted(ks), f.period) };
  });

  const contractList = rows.contracts.map((k) => ({
    contractId: k.contractId, companyId: k.companyId, siteId: k.siteId, number: k.number, employerName: k.employerName, status: k.status,
    valueDppEffectiveCents: k.valueDppEffectiveCents, valueTotalCents: k.valueTotalCents, addendumDeltaCents: k.addendumDeltaCents,
    endDateEffective: k.endDateEffective, daysLeft: daysLeft(k.endDateEffective, today),
    termsIssued: k.termsIssued, termsTotal: k.termsTotal, termsReady: k.termsReady,
    progress: progressAt(curveOf.get(k.contractId) ?? [], f.period),
  })).sort((a, b) => (a.daysLeft ?? Infinity) - (b.daysLeft ?? Infinity) || a.contractId - b.contractId);

  const categories = new Map<string, DashMoney>();
  for (const k of rows.contracts) {
    for (const [cat, m] of Object.entries(k.commitment.byCategory ?? {})) categories.set(cat, addMoney(categories.get(cat) ?? ZERO, m));
  }
  const vendorTotals = new Map<string, { companyId: number; vendorId: number; vendorName: string; poValueCents: number; undeliveredCents: number }>();
  for (const v of rows.vendors) {
    const key = `${v.companyId}:${v.vendorId}`;
    const t = vendorTotals.get(key) ?? { companyId: v.companyId, vendorId: v.vendorId, vendorName: v.vendorName, poValueCents: 0, undeliveredCents: 0 };
    t.poValueCents += v.poValueCents;
    t.undeliveredCents += v.undeliveredCents;
    vendorTotals.set(key, t);
  }
  const procurement = {
    prOpen: sum(rows.balances, (b) => b.prOpen),
    prWaiting: sum(rows.balances, (b) => b.prWaiting),
    poOutstandingCents: sum(rows.balances, (b) => b.poOutstandingCents),
    poOverdueCount: sum(rows.balances, (b) => b.poOverdueCount),
    commitment: {
      ...commitment,
      committedOfBudgetBp: ratioBp(commitment.committedCents, commitment.budgetCents),
      byCategory: [...categories].map(([category, m]) => ({
        category, ...m,
        committedOfBudgetBp: ratioBp(m.committedCents, m.budgetCents),
        shareOfCommittedBp: ratioBp(m.committedCents, commitment.committedCents),
      })).sort((a, b) => b.committedCents - a.committedCents || a.category.localeCompare(b.category)),
    },
    topVendors: [...vendorTotals.values()].sort((a, b) => b.poValueCents - a.poValueCents || a.vendorId - b.vendorId).slice(0, 10),
  };

  const monthTotals = new Map<string, { period: string; poIssuedCents: number; grReceivedCents: number; invoicedTotalCents: number; cashInCents: number; cashOutCents: number; costCents: number }>();
  for (const m of rows.monthly) {
    const t = monthTotals.get(m.period) ?? { period: m.period, poIssuedCents: 0, grReceivedCents: 0, invoicedTotalCents: 0, cashInCents: 0, cashOutCents: 0, costCents: 0 };
    t.poIssuedCents += m.poIssuedCents;
    t.grReceivedCents += m.grReceivedCents;
    t.invoicedTotalCents += m.invoicedTotalCents;
    t.cashInCents += m.cashInCents;
    t.cashOutCents += m.cashOutCents;
    t.costCents += sum(Object.values(m.costByCategory), (v) => v);
    monthTotals.set(m.period, t);
  }
  const ofPeriod = monthTotals.get(f.period);
  const aging = {
    d0_30: sum(rows.balances, (b) => b.receivable0to30Cents),
    d31_60: sum(rows.balances, (b) => b.receivable31to60Cents),
    d61_90: sum(rows.balances, (b) => b.receivable61to90Cents),
    d90p: sum(rows.balances, (b) => b.receivable90pCents),
  };
  const finance = {
    receivableCents: aging.d0_30 + aging.d31_60 + aging.d61_90 + aging.d90p,
    receivableCount: sum(rows.balances, (b) => b.receivableCount),
    aging,
    payableCents: sum(rows.balances, (b) => b.payableTotalCents),
    payableOverdueCents: sum(rows.balances, (b) => b.payableOverdueCents),
    cash: { period: f.period, inCents: ofPeriod?.cashInCents ?? 0, outCents: ofPeriod?.cashOutCents ?? 0, netCents: (ofPeriod?.cashInCents ?? 0) - (ofPeriod?.cashOutCents ?? 0) },
    monthly: [...monthTotals.values()].filter((m) => inRange(m.period)).sort((a, b) => a.period.localeCompare(b.period)),
  };

  const photos = sum(rows.balances, (b) => b.photos7d);
  const asked = sum(rows.balances, (b) => b.asked7d);
  const intake = {
    photos7d: photos,
    sitesWithPhotos: rows.balances.filter((b) => b.photos7d > 0).length,
    openKonfirmasi: sum(rows.balances, (b) => b.openKonfirmasi),
    openCek: sum(rows.balances, (b) => b.openCek),
    asked7d: asked,
    askRateBp: ratioBp(asked, photos),
    medianConfirmMinutes7d: median(rows.balances.flatMap((b) => b.confirmMinutes7d)),
    perSite: rows.balances.filter((b) => b.photos7d > 0).map((b) => ({ companyId: b.companyId, siteId: b.siteId, photos7d: b.photos7d }))
      .sort((a, b) => b.photos7d - a.photos7d || a.siteId - b.siteId),
  };

  const alerts = [...rows.alerts].sort((a, b) => a.kind.localeCompare(b.kind) || a.companyId - b.companyId || a.ref.localeCompare(b.ref))
    .map((a) => ({ ...a.data, kind: a.kind, companyId: a.companyId, siteId: a.siteId, ref: a.ref }));

  return {
    period: f.period,
    summary,
    curve: portfolio.filter((p) => inRange(p.period)),
    byCompany,
    contracts: contractList,
    procurement,
    finance,
    intake,
    alerts,
  };
}

export type Panels = ReturnType<typeof buildPanels>;
