import { count, sql } from 'drizzle-orm';
import type { PgTable } from 'drizzle-orm/pg-core';
import { expect } from 'vitest';
import { headerAuthenticator } from '../../src/auth/authenticator.js';
import {
  boqItems, boqVersions, companies, companyUsers, contractAddendums, contracts, contractTerms, progressItems, progressReports, sites, users,
  vendorInvoices, vendors, type VendorInvoiceStatus,
} from '../../src/db/schema.js';
import { withApp, withCompany, type Db, type Tx } from '../../src/db/tenant.js';
import { createApp } from '../../src/http/app.js';
import { asOwner, createTestDb } from '../helpers/db.js';

/**
 * Shared seed for the finance tests (one fresh PGlite per test file).
 *
 * Company A (doc prefix none): sites s1 (KRM) and s2 (JYP). Company B: site sB (BBB).
 * Members of A: mgr (company_manager), adm (project_admin), fin (finance, all sites),
 * finS1 (finance limited to s1), staff (site_staff at s1), staff2 (site_staff at s2), sys (system_admin role).
 * bobB is manager of B only. Vendors vA (company A) and vB (company B).
 *
 * Contracts are created per test with `contract()` (one current BOQ version with a single leaf of
 * weight 100 %), so a cumulative percent on that leaf IS the weighted contract progress, exactly.
 */
export interface World {
  db: Db;
  close: () => Promise<void>;
  app: ReturnType<typeof createApp>;
  clock: { now: Date };
  A: number; B: number;
  s1: number; s2: number; sB: number;
  vA: number; vB: number;
  u: { mgr: number; adm: number; fin: number; finS1: number; staff: number; staff2: number; sys: number; bobB: number };
}

export async function seedWorld(nowIso = '2026-10-27T03:00:00Z'): Promise<World> {
  const { db, close } = await createTestDb();
  const clock = { now: new Date(nowIso) };
  const app = createApp({ db, auth: headerAuthenticator('test'), now: () => clock.now });
  const w = { db, close, app, clock } as World;

  await withApp(db, async (tx) => {
    const cs = await tx.insert(companies).values([{ code: 'AAA', name: 'PT AAA' }, { code: 'BBB', name: 'PT BBB' }]).returning({ id: companies.id });
    [w.A, w.B] = cs.map((c) => c.id) as [number, number];
    const us = await tx.insert(users).values([
      { email: 'mgr@a.test', name: 'Manager' }, { email: 'adm@a.test', name: 'Admin proyek' }, { email: 'fin@a.test', name: 'Finance' },
      { email: 'fins1@a.test', name: 'Finance KRM' }, { email: 'staff@a.test', name: 'Staf KRM' }, { email: 'staff2@a.test', name: 'Staf JYP' },
      { email: 'sys@a.test', name: 'Sysadmin perusahaan' }, { email: 'bob@b.test', name: 'Bob B' },
    ]).returning({ id: users.id });
    const [mgr, adm, fin, finS1, staff, staff2, sys, bobB] = us.map((u) => u.id) as number[];
    w.u = { mgr: mgr!, adm: adm!, fin: fin!, finS1: finS1!, staff: staff!, staff2: staff2!, sys: sys!, bobB: bobB! };
  });
  await withCompany(db, w.A, async (tx) => {
    const ss = await tx.insert(sites).values([
      { companyId: w.A, code: 'KRM', name: 'JIAT Keerom' }, { companyId: w.A, code: 'JYP', name: 'JIAT Jayapura' },
    ]).returning({ id: sites.id });
    [w.s1, w.s2] = ss.map((s) => s.id) as [number, number];
    const [v] = await tx.insert(vendors).values({ companyId: w.A, name: 'PT Sumber Beton' }).returning({ id: vendors.id });
    w.vA = v!.id;
  });
  await withCompany(db, w.B, async (tx) => {
    const [s] = await tx.insert(sites).values({ companyId: w.B, code: 'BBB', name: 'Site B' }).returning({ id: sites.id });
    w.sB = s!.id;
    const [v] = await tx.insert(vendors).values({ companyId: w.B, name: 'PT Vendor B' }).returning({ id: vendors.id });
    w.vB = v!.id;
  });
  await withApp(db, (tx) => tx.insert(companyUsers).values([
    { userId: w.u.mgr, companyId: w.A, role: 'company_manager' },
    { userId: w.u.adm, companyId: w.A, role: 'project_admin' },
    { userId: w.u.fin, companyId: w.A, role: 'finance' },
    { userId: w.u.finS1, companyId: w.A, role: 'finance', siteIds: [w.s1] },
    { userId: w.u.staff, companyId: w.A, role: 'site_staff', siteIds: [w.s1] },
    { userId: w.u.staff2, companyId: w.A, role: 'site_staff', siteIds: [w.s2] },
    { userId: w.u.sys, companyId: w.A, role: 'system_admin' },
    { userId: w.u.bobB, companyId: w.B, role: 'company_manager' },
  ]));
  return w;
}

let n = 0;
export interface ContractOpts {
  company?: number; site?: number; valueDppCents?: number; ppnRateBp?: number; retentionBp?: number; advanceCents?: number;
}
export interface TermSpec { seq: number; percentBp: number; triggerProgressBp: number; dueDays?: number }

/** Contract + current BOQ v1 with one leaf "L" (weight 100 %) + the given termin schedule. */
export async function contract(w: World, opts: ContractOpts = {}, terms: TermSpec[] = []): Promise<{ K: number; leaf: number; terms: Record<number, number> }> {
  const company = opts.company ?? w.A;
  const site = opts.site ?? (company === w.A ? w.s1 : w.sB);
  return withCompany(w.db, company, async (tx) => {
    const i = ++n;
    const [k] = await tx.insert(contracts).values({
      companyId: company, siteId: site, number: `HK-${i}`, employerName: 'BWS Papua', valueDppCents: opts.valueDppCents ?? 1_000_000_00,
      ppnRateBp: opts.ppnRateBp ?? 1100, retentionBp: opts.retentionBp ?? 0, advanceCents: opts.advanceCents ?? 0, status: 'active',
    }).returning({ id: contracts.id });
    const [v] = await tx.insert(boqVersions).values({ companyId: company, contractId: k!.id, version: 1, totalCents: opts.valueDppCents ?? 1_000_000_00 }).returning({ id: boqVersions.id });
    const [l] = await tx.insert(boqItems).values({
      companyId: company, versionId: v!.id, code: 'L', description: 'Pekerjaan', amountCents: opts.valueDppCents ?? 1_000_000_00, weightMicroPct: 100_000_000,
    }).returning({ id: boqItems.id });
    const ids: Record<number, number> = {};
    if (terms.length) {
      const rows = await tx.insert(contractTerms).values(terms.map((t) => ({
        companyId: company, contractId: k!.id, seq: t.seq, name: `Termin ${t.seq}`, percentBp: t.percentBp, triggerProgressBp: t.triggerProgressBp, dueDays: t.dueDays ?? 30,
      }))).returning({ id: contractTerms.id, seq: contractTerms.seq });
      for (const r of rows) ids[r.seq] = r.id;
    }
    return { K: k!.id, leaf: l!.id, terms: ids };
  });
}

/** An APPROVED opname for `period` (YYYY-MM-01) with the single leaf at `micro` (micro-percent). */
export async function approvedProgress(w: World, K: number, leaf: number, period: string, micro: number, company = w.A): Promise<void> {
  await withCompany(w.db, company, async (tx) => {
    const [k] = await tx.select({ siteId: contracts.siteId }).from(contracts).where(sql`${contracts.id} = ${K}`);
    const [r] = await tx.insert(progressReports).values({
      companyId: company, siteId: k!.siteId, contractId: K, period, status: 'approved', approvedAt: new Date(),
    }).returning({ id: progressReports.id });
    await tx.insert(progressItems).values({ companyId: company, reportId: r!.id, boqItemId: leaf, cumulativeMicroPct: micro });
  });
}

/** A NOT approved (submitted) opname: must not count for the termin trigger. */
export async function submittedProgress(w: World, K: number, leaf: number, period: string, micro: number, company = w.A): Promise<void> {
  await withCompany(w.db, company, async (tx) => {
    const [k] = await tx.select({ siteId: contracts.siteId }).from(contracts).where(sql`${contracts.id} = ${K}`);
    const [r] = await tx.insert(progressReports).values({
      companyId: company, siteId: k!.siteId, contractId: K, period, status: 'submitted',
    }).returning({ id: progressReports.id });
    await tx.insert(progressItems).values({ companyId: company, reportId: r!.id, boqItemId: leaf, cumulativeMicroPct: micro });
  });
}

export async function addendum(w: World, K: number, valueDeltaCents: number, signedAt = '2026-10-01', company = w.A): Promise<void> {
  await withCompany(w.db, company, (tx) => tx.insert(contractAddendums).values({
    companyId: company, contractId: K, number: `ADD-${++n}`, signedAt, valueDeltaCents,
  }));
}

export async function vendorInvoice(
  w: World,
  o: { status: VendorInvoiceStatus; totalCents: number; dueDate?: string | null; invoiceDate?: string; site?: number; company?: number },
): Promise<{ id: number; rowId: string }> {
  const company = o.company ?? w.A;
  return withCompany(w.db, company, async (tx) => {
    const [r] = await tx.insert(vendorInvoices).values({
      companyId: company, siteId: o.site ?? (company === w.A ? w.s1 : w.sB), vendorId: company === w.A ? w.vA : w.vB, vendorName: 'Vendor',
      totalCents: o.totalCents, invoiceDate: o.invoiceDate ?? '2026-10-01', dueDate: o.dueDate ?? null, status: o.status, source: 'manual',
    }).returning({ id: vendorInvoices.id, rowId: vendorInvoices.rowId });
    return r!;
  });
}

/** Service-level transaction in company A (unscoped unless siteIds given). */
export function inCompany(w: World, company?: number, siteIds: number[] | null = null) {
  return <T>(fn: (tx: Tx) => Promise<T>) => withCompany(w.db, { companyId: company ?? w.A, userId: w.u.fin, siteIds }, fn);
}

/** Row count of a table across all companies (owner, bypasses RLS). */
export async function rows(w: World, table: PgTable): Promise<number> {
  return asOwner(w.db, async () => {
    const [r] = await w.db.select({ n: count() }).from(table);
    return Number(r!.n);
  });
}

export async function seqOf(w: World, companyId: number, docType: string, year: number): Promise<number> {
  return asOwner(w.db, async () => {
    const r = await w.db.execute(sql`SELECT last_number FROM document_sequences WHERE company_id = ${companyId} AND doc_type = ${docType} AND year = ${year}`);
    const row = (r as unknown as { rows: Array<{ last_number: number }> }).rows[0];
    return row ? Number(row.last_number) : 0;
  });
}

/** The service throws hono HTTPException; assert its status (and optionally message). */
export async function rejects(p: Promise<unknown>, status: number, message?: RegExp): Promise<void> {
  const err = await p.then(() => null, (e: unknown) => e);
  expect(err, `expected HTTP ${status}, call succeeded`).not.toBeNull();
  expect((err as { status?: number }).status, String(err)).toBe(status);
  if (message) expect((err as Error).message).toMatch(message);
}

/** a × b / d, rounded half away from zero — written independently of src/domain/contract.ts mulDiv. */
export function rhaz(a: number, b: number, d: number): number {
  const p = BigInt(a) * BigInt(b);
  const D = BigInt(d);
  const neg = (p < 0n) !== (D < 0n);
  const ap = p < 0n ? -p : p;
  const aD = D < 0n ? -D : D;
  const q = (ap * 2n + aD) / (aD * 2n);
  return Number(neg ? -q : q);
}

// --- HTTP ---

export function client(w: World) {
  const send = (userId: number, method: string, body?: unknown) => ({
    method, headers: { 'x-dev-user-id': String(userId), 'content-type': 'application/json' }, ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
  const call = (userId: number, method: string, path: string, body?: unknown, company = w.A) =>
    w.app.request(`/companies/${company}${path}`, send(userId, method, body));
  async function ok<T>(res: Response | Promise<Response>, status = 200): Promise<T> {
    const r = await res;
    const text = await r.text();
    expect(r.status, text).toBe(status);
    return (JSON.parse(text) as { data: T }).data;
  }
  async function body<T>(res: Response | Promise<Response>, status = 200): Promise<T> {
    const r = await res;
    const text = await r.text();
    expect(r.status, text).toBe(status);
    return JSON.parse(text) as T;
  }
  async function fails(res: Response | Promise<Response>, status: number): Promise<{ message?: string; error?: string }> {
    const r = await res;
    const text = await r.text();
    expect(r.status, text).toBe(status);
    try { return JSON.parse(text) as { message?: string }; } catch { return { message: text }; }
  }
  return { send, call, ok, body, fails };
}

export type SalesInvoice = {
  id: number; number: string; status: string; siteId: number; contractId: number; termId: number; invoiceDate: string; dueDate: string;
  progressMicroPct: number; dppCents: number; advanceDeductionCents: number; retentionCents: number; ppnCents: number; totalCents: number;
};
