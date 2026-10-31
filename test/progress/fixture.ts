import { eq } from 'drizzle-orm';
import { expect } from 'vitest';
import { headerAuthenticator } from '../../src/auth/authenticator.js';
import { boqItems, boqSchedules, boqVersions, companies, companyUsers, contracts, progressItems, progressReports, sites, users } from '../../src/db/schema.js';
import { withApp, withCompany, type Db, type Tx } from '../../src/db/tenant.js';
import { createApp } from '../../src/http/app.js';
import { createReport, putReportItems, transitionReport, type OpnameInput } from '../../src/progress/service.js';
import { createTestDb } from '../helpers/db.js';

/**
 * Shared seed for the progress tests: company A with two sites (s1, s2), company B with one site,
 * and one member per role. Contracts + BOQ are created per test group with `seedContract` so the
 * unique (contract, period) report key and the plan never leak between groups.
 */
export interface World {
  db: Db;
  close: () => Promise<void>;
  app: ReturnType<typeof createApp>;
  A: number; B: number; s1: number; s2: number; sB: number;
  mgr: number; adm: number; fin: number; staff1: number; staff2: number; staffNone: number; mgrB: number; sys: number;
}

export async function createWorld(): Promise<World> {
  const { db, close } = await createTestDb();
  const app = createApp({ db, auth: headerAuthenticator('test'), now: () => new Date('2026-10-27T03:00:00Z') });
  const w = { db, close, app } as World;
  await withApp(db, async (tx) => {
    const cs = await tx.insert(companies).values([{ code: 'AAA', name: 'PT AAA' }, { code: 'BBB', name: 'PT BBB' }]).returning({ id: companies.id });
    [w.A, w.B] = cs.map((c) => c.id) as [number, number];
    const us = await tx.insert(users).values([
      { email: 'mgr@a.test', name: 'Manager A' }, { email: 'adm@a.test', name: 'Admin proyek A' }, { email: 'fin@a.test', name: 'Finance A' },
      { email: 'staff1@a.test', name: 'Staf site 1' }, { email: 'staff2@a.test', name: 'Staf site 2' }, { email: 'staff0@a.test', name: 'Staf tanpa site' },
      { email: 'mgr@b.test', name: 'Manager B' }, { email: 'sys@a.test', name: 'Sysadmin A' },
    ]).returning({ id: users.id });
    [w.mgr, w.adm, w.fin, w.staff1, w.staff2, w.staffNone, w.mgrB, w.sys] = us.map((u) => u.id) as [number, number, number, number, number, number, number, number];
  });
  await withCompany(db, w.A, async (tx) => {
    const ss = await tx.insert(sites).values([{ companyId: w.A, code: 'S1', name: 'Site 1' }, { companyId: w.A, code: 'S2', name: 'Site 2' }]).returning({ id: sites.id });
    [w.s1, w.s2] = ss.map((s) => s.id) as [number, number];
  });
  await withCompany(db, w.B, async (tx) => {
    const [s] = await tx.insert(sites).values({ companyId: w.B, code: 'SB', name: 'Site B' }).returning({ id: sites.id });
    w.sB = s!.id;
  });
  await withApp(db, (tx) => tx.insert(companyUsers).values([
    { userId: w.mgr, companyId: w.A, role: 'company_manager' },
    { userId: w.adm, companyId: w.A, role: 'project_admin' },
    { userId: w.fin, companyId: w.A, role: 'finance' },
    { userId: w.staff1, companyId: w.A, role: 'site_staff', siteIds: [w.s1] },
    { userId: w.staff2, companyId: w.A, role: 'site_staff', siteIds: [w.s2] },
    { userId: w.staffNone, companyId: w.A, role: 'site_staff' },
    { userId: w.mgrB, companyId: w.B, role: 'company_manager' },
    { userId: w.sys, companyId: w.A, role: 'system_admin' },
  ]));
  return w;
}

export interface LeafSpec { code: string; weight: number; qty?: string | null; isLeaf?: boolean }

/** I (section) → I.1 (100 m³, 60 %), II.1 (no volume, 40 %). */
export const DEFAULT_LEAVES: LeafSpec[] = [
  { code: 'I', weight: 60_000_000, isLeaf: false },
  { code: 'I.1', weight: 60_000_000, qty: '100.0000' },
  { code: 'II.1', weight: 40_000_000, qty: null },
];

let seq = 0;
export interface Seeded { K: number; versionId: number; ids: Record<string, number> }

/** A contract on `site` with a current BOQ v1 built from `leaves` (null = contract without BOQ). */
export async function seedContract(w: World, company: number, site: number, leaves: LeafSpec[] | null = DEFAULT_LEAVES): Promise<Seeded> {
  return withCompany(w.db, company, async (tx) => {
    const n = ++seq;
    const [k] = await tx.insert(contracts).values({
      companyId: company, siteId: site, number: `K-${n}`, employerName: 'BWS Papua', valueDppCents: 1_000_000_000_00, status: 'active',
    }).returning({ id: contracts.id });
    const ids: Record<string, number> = {};
    let versionId = 0;
    if (leaves) {
      const [v] = await tx.insert(boqVersions).values({ companyId: company, contractId: k!.id, version: 1, totalCents: 1_000_000_000_00 }).returning({ id: boqVersions.id });
      versionId = v!.id;
      const rows = await tx.insert(boqItems).values(leaves.map((l, i) => ({
        companyId: company, versionId, code: l.code, description: `Item ${l.code}`, qty: l.qty ?? null,
        amountCents: l.weight * 10, weightMicroPct: l.weight, isLeaf: l.isLeaf ?? true, level: l.isLeaf === false ? 0 : 1, sortOrder: i + 1,
      }))).returning({ id: boqItems.id, code: boqItems.code });
      for (const r of rows) ids[r.code] = r.id;
    }
    return { K: k!.id, versionId, ids };
  });
}

// --- HTTP ---

export const send = (userId: number, method: string, body?: unknown) => ({
  method, headers: { 'x-dev-user-id': String(userId), 'content-type': 'application/json' }, ...(body === undefined ? {} : { body: JSON.stringify(body) }),
});

export function http(w: World) {
  const req = (userId: number, method: string, path: string, body?: unknown, company = w.A) =>
    w.app.request(`/companies/${company}${path}`, send(userId, method, body));
  async function ok<T>(res: Response | Promise<Response>, status = 200): Promise<T> {
    const r = await res;
    const text = await r.text();
    expect(r.status, text).toBe(status);
    return (JSON.parse(text) as { data: T }).data;
  }
  async function code(res: Response | Promise<Response>): Promise<number> {
    return (await res).status;
  }
  return { req, ok, code };
}

// --- service-level helpers (company A, unscoped, acting as the manager) ---

export function svc(w: World) {
  const inA = <T>(fn: (tx: Tx) => Promise<T>, userId = w.mgr) => withCompany(w.db, { companyId: w.A, userId }, fn);
  /** create + fill + submit + approve one report, in one transaction */
  const approved = (K: number, period: string, lines: OpnameInput[]) => inA(async (tx) => {
    const r = await createReport(tx, { companyId: w.A, userId: w.mgr }, { contractId: K, period });
    await putReportItems(tx, w.A, r.id, lines);
    await transitionReport(tx, r.id, 'submit', w.mgr);
    return transitionReport(tx, r.id, 'approve', w.mgr);
  });
  /** create + fill (draft), optionally submit */
  const drafted = (K: number, period: string, lines: OpnameInput[], submit = false) => inA(async (tx) => {
    const r = await createReport(tx, { companyId: w.A, userId: w.mgr }, { contractId: K, period });
    await putReportItems(tx, w.A, r.id, lines);
    return submit ? transitionReport(tx, r.id, 'submit', w.mgr) : r;
  });
  const reportsOf = (K: number) => inA((tx) => tx.select().from(progressReports).where(eq(progressReports.contractId, K)));
  const itemsOf = (reportId: number) => inA((tx) => tx.select().from(progressItems).where(eq(progressItems.reportId, reportId)));
  const schedulesOf = (ids: number[]) => inA(async (tx) => {
    const all = await tx.select().from(boqSchedules);
    return all.filter((s) => ids.includes(s.boqItemId));
  });
  return { inA, approved, drafted, reportsOf, itemsOf, schedulesOf };
}

/** The service throws hono HTTPException; assert its status (and optionally message). */
export async function rejects(p: Promise<unknown>, status: number, message?: RegExp): Promise<void> {
  const err = await p.then(() => null, (e: unknown) => e);
  expect(err, `expected HTTP ${status}, call succeeded`).not.toBeNull();
  expect((err as { status?: number }).status, String(err)).toBe(status);
  if (message) expect((err as Error).message).toMatch(message);
}
