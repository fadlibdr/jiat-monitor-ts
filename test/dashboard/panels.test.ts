import { describe, expect, it } from 'vitest';
import { alertText } from '../../src/dashboard/alert-text.js';
import { buildPanels, filterRows, weightedProgressAt } from '../../src/dashboard/panels.js';
import type { SnapshotRows } from '../../src/dashboard/snapshot.js';

/**
 * buildPanels on hand-made snapshot rows (no database): the rules the review round fixed —
 * portfolio progress compares each contract at its own reported month, cost against budget covers
 * the same contracts, per-termin alert refs survive the contract filter, alerts carry their words.
 */
const PCT = 1_000_000;
const TODAY = new Date('2026-10-27T03:00:00Z');
const ZERO = { budgetCents: 0, committedCents: 0, receivedCents: 0 };

type ContractRow = SnapshotRows['contracts'][number];
const contract = (o: Partial<ContractRow> & Pick<ContractRow, 'contractId' | 'companyId' | 'siteId'>): ContractRow => ({
  number: `K-${o.contractId}`, employerName: 'BWS Papua', status: 'active', valueDppCents: 1_000_000, addendumDeltaCents: 0, valueDppEffectiveCents: 1_000_000,
  valueTotalCents: 1_110_000, endDateEffective: '2027-06-30', termsTotal: 2, termsIssued: 0, termsReady: 0,
  commitment: { total: { ...ZERO, budgetCents: 100 }, byCategory: {} }, ...o,
});
const point = (contractId: number, companyId: number, period: string, planned: number, actual: number | null) => ({
  contractId, companyId, siteId: contractId, period, plannedMicroPct: planned * PCT, actualMicroPct: actual === null ? null : actual * PCT,
  deviationMicroPct: actual === null ? null : (actual - planned) * PCT,
});
const monthly = (companyId: number, siteId: number, cost: number) => ({
  companyId, siteId, period: '2026-10-01', poIssuedCents: 0, grReceivedCents: 0, invoicedDppCents: 0, invoicedTotalCents: 0, cashInCents: 0, cashOutCents: 0,
  costByCategory: { material: cost },
});
const rows = (r: Partial<SnapshotRows>): SnapshotRows => ({ contracts: [], progress: [], monthly: [], balances: [], vendors: [], alerts: [], ...r });

describe('portfolio progress', () => {
  // two contracts of equal value, two companies; A's October opname is not approved yet
  const r = rows({
    contracts: [contract({ contractId: 1, companyId: 1, siteId: 1 }), contract({ contractId: 2, companyId: 2, siteId: 2 })],
    progress: [
      point(1, 1, '2026-09-01', 40, 40), point(1, 1, '2026-10-01', 50, null),
      point(2, 2, '2026-09-01', 40, 40), point(2, 2, '2026-10-01', 50, 50),
    ],
  });
  const p = buildPanels(r, { period: '2026-10-01' }, TODAY);

  it('has no phantom lag: each contract is compared at its own latest reported month', () => {
    // A on plan at September (40/40), B on plan at October (50/50): the portfolio is on plan too
    expect(p.summary.progress).toEqual({ period: '2026-10-01', plannedMicroPct: 45 * PCT, actualMicroPct: 45 * PCT, deviationMicroPct: 0 });
    expect(p.byCompany.map((c) => c.progress?.deviationMicroPct)).toEqual([0, 0]);
  });

  it('weights by effective DPP, leaves out contracts with no approved actual, and is null when none has one', () => {
    expect(weightedProgressAt([
      { weightCents: 3, point: { period: '2026-10-01', plannedMicroPct: 60 * PCT, actualMicroPct: 50 * PCT, deviationMicroPct: -10 * PCT } },
      { weightCents: 1, point: { period: '2026-10-01', plannedMicroPct: 20 * PCT, actualMicroPct: 30 * PCT, deviationMicroPct: 10 * PCT } },
      { weightCents: 5, point: { period: '2026-10-01', plannedMicroPct: 90 * PCT, actualMicroPct: null, deviationMicroPct: null } },
      { weightCents: 0, point: { period: '2026-10-01', plannedMicroPct: 99 * PCT, actualMicroPct: 99 * PCT, deviationMicroPct: 0 } },
    ])).toEqual({ period: '2026-10-01', plannedMicroPct: 50 * PCT, actualMicroPct: 45 * PCT, deviationMicroPct: -5 * PCT });
    expect(weightedProgressAt([{ weightCents: 1, point: null }])).toBeNull();
  });

  it('before any opname the summary still shows the plan', () => {
    const fresh = buildPanels(rows({ contracts: [contract({ contractId: 3, companyId: 1, siteId: 3 })], progress: [point(3, 1, '2026-10-01', 10, null)] }), { period: '2026-10-01' }, TODAY);
    expect(fresh.summary.progress).toMatchObject({ plannedMicroPct: 10 * PCT, actualMicroPct: null });
  });
});

describe('realised cost against the BOQ budget', () => {
  // contract 1 active at site 1, contract 2 completed at site 2; each site has 80 of cost, each budget is 100
  const r = rows({
    contracts: [contract({ contractId: 1, companyId: 1, siteId: 1 }), contract({ contractId: 2, companyId: 1, siteId: 2, status: 'completed' })],
    monthly: [monthly(1, 1, 80), monthly(1, 2, 80)],
  });

  it('with a status filter, only the filtered contracts\' sites count (80 of 100, not 160 of 100)', () => {
    const p = buildPanels(r, { period: '2026-10-01', status: 'active' }, TODAY);
    expect(p.summary).toMatchObject({ contracts: 1, costRealisedCents: 80, budgetCents: 100, costOfBudgetBp: 8_000 });
  });

  it('with an employer filter likewise; without a contract filter every site counts', () => {
    const byEmployer = buildPanels({ ...r, contracts: [r.contracts[0]!, { ...r.contracts[1]!, employerName: 'BWS Sulawesi II' }] }, { period: '2026-10-01', employer: 'papua' }, TODAY);
    expect(byEmployer.summary.costRealisedCents).toBe(80);
    expect(buildPanels(r, { period: '2026-10-01' }, TODAY).summary).toMatchObject({ costRealisedCents: 160, budgetCents: 200, costOfBudgetBp: 8_000 });
  });
});

describe('alerts', () => {
  const alert = (ref: string, contractId: number) => ({
    companyId: 1, kind: 'termin_siap' as const, ref, siteId: 1, data: { contractId, contractNumber: `K-${contractId}`, termSeq: 2, triggerBp: 5000, actualMicroPct: 55 * PCT },
  });
  const r = rows({
    contracts: [contract({ contractId: 1, companyId: 1, siteId: 1 }), contract({ contractId: 2, companyId: 1, siteId: 1, status: 'completed' })],
    alerts: [alert('contract:1:term:2', 1), alert('contract:2:term:2', 2)],
  });

  it('per-termin refs follow the contract filter (contract 12 is not contract 1)', () => {
    expect(filterRows(r, { period: '2026-10-01', status: 'active' }).alerts.map((a) => a.ref)).toEqual(['contract:1:term:2']);
    expect(filterRows({ ...r, alerts: [alert('contract:12:term:1', 12)] }, { period: '2026-10-01' }).alerts).toEqual([]);
  });

  it('carry their label and the same one-line text as the digest', () => {
    const [a] = buildPanels(r, { period: '2026-10-01', status: 'active' }, TODAY).alerts;
    expect(a).toMatchObject({ kind: 'termin_siap', label: 'Termin siap diajukan', text: 'K-1 · progres 55,0% melewati ambang Termin 2 (50%)' });
  });

  it('a contract past its end date reads "lewat batas", not "sisa -40 hari"', () => {
    const t = (daysLeft: number) => alertText('kontrak_mendekati_batas', { contractNumber: 'K-1', daysLeft, actualMicroPct: 60 * PCT });
    expect(t(12)).toBe('K-1 · sisa 12 hari, progres 60,0%');
    expect(t(0)).toBe('K-1 · berakhir hari ini, progres 60,0%');
    expect(t(-40)).toBe('K-1 · lewat batas 40 hari, progres 60,0%');
  });
});
