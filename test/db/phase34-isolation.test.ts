import { execFileSync } from 'node:child_process';
import { cpSync, existsSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { PGlite } from '@electric-sql/pglite';
import { pg_trgm } from '@electric-sql/pglite/contrib/pg_trgm';
import { and, eq, sql, type SQL } from 'drizzle-orm';
import { drizzle } from 'drizzle-orm/pglite';
import { migrate } from 'drizzle-orm/pglite/migrator';
import { generateDrizzleJson, generateMigration, pushSchema } from 'drizzle-kit/api';
import { HTTPException } from 'hono/http-exception';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { refreshCompany } from '../../src/dashboard/snapshot.js';
import { AUDITED_TABLES, stampedTables } from '../../src/db/audit.js';
import { postMigrationStatements } from '../../src/db/ddl.js';
import * as schema from '../../src/db/schema.js';
import {
  auditLogs, boqItems, boqVersions, companies, contracts, contractTerms, dailyDigests, dashAlerts, dashBalances, dashContracts,
  dashMonthly, dashProgress, dashRefreshes, dashVendors, documentSequences, goodsReceiptItems, goodsReceipts, jobs, payments,
  progressItems, progressReports, purchaseOrderItems, purchaseOrders, purchaseRequestItems, purchaseRequests, salesInvoices, sites,
  TENANT_TABLES, users, vendorInvoices, vendors,
} from '../../src/db/schema.js';
import { withApp, withCompany, withHoldingRead, type Db, type TenantCtx, type Tx } from '../../src/db/tenant.js';
import { enqueue, enqueueOnce } from '../../src/jobs/queue.js';
import { setMatch } from '../../src/procurement/matching.js';
import { nextDocNumber } from '../../src/procurement/docnumber.js';
import { asOwner, createTestDb } from '../helpers/db.js';

/**
 * Database isolation and audit for the tables added by Phase 3/4 + ops (document numbers, PR/PO/GR,
 * opname, termin invoices, payments, dashboard snapshots, daily digests, vendor_invoices.po_id/gr_id,
 * jobs.dedupe_key). Everything here is asserted against Postgres itself (PGlite), not the services:
 * the RLS policies must hold for a raw SQL string with a forgotten WHERE.
 *
 * World: company A with sites a1, a2 and company B with site b1. Every site gets one row in every
 * site-bound table (and its children); every company one row in each company-wide table.
 * alice = A's manager (unscoped), bob = A's site staff at a1, dave = A's finance, carol = B's manager.
 */

const ROOT = resolve(fileURLToPath(new URL('../..', import.meta.url)));

/** drizzle drivers differ: postgres-js returns an array, pglite returns { rows }. */
function rowsOf<T>(res: unknown): T[] {
  return Array.isArray(res) ? (res as T[]) : ((res as { rows: T[] }).rows ?? []);
}
async function q<T = Record<string, unknown>>(tx: Tx | Db, query: SQL | string): Promise<T[]> {
  return rowsOf<T>(await tx.execute(typeof query === 'string' ? sql.raw(query) : query));
}
/** message of the error and of its cause chain (drizzle wraps the driver error) */
function errText(e: unknown): string {
  const parts: string[] = [];
  let cur: unknown = e;
  for (let i = 0; cur && i < 5; i++) {
    parts.push(cur instanceof Error ? cur.message : String(cur));
    cur = cur instanceof Error ? cur.cause : undefined;
  }
  return parts.join(' | ');
}
async function failsWith(p: Promise<unknown>, re: RegExp): Promise<void> {
  let err: unknown = null;
  try { await p; } catch (e) { err = e; }
  expect(err, `expected an error matching ${re}`).not.toBeNull();
  expect(errText(err)).toMatch(re);
}
const RLS = /row-level security/;
const DENIED = /permission denied/;
const READ_ONLY = /read-only transaction/;

/** Runs fn in a company context and rolls it back, returning fn's result. */
class Rollback<T> extends Error { constructor(readonly value: T) { super('rollback'); } }
async function inRolledBack<T>(db: Db, ctx: number | TenantCtx, fn: (tx: Tx) => Promise<T>): Promise<T> {
  try {
    await withCompany(db, ctx, async (tx) => { throw new Rollback(await fn(tx)); });
  } catch (e) {
    if (e instanceof Rollback) return e.value as T;
    throw e;
  }
  throw new Error('unreachable');
}
/** Bare jiat_holding role WITHOUT the read-only transaction of withHoldingRead: only the grants stand in the way. */
async function asBareHolding<T>(db: Db, fn: (tx: Tx) => Promise<T>): Promise<T> {
  return db.transaction(async (tx) => {
    await tx.execute(sql.raw('SET LOCAL ROLE jiat_holding'));
    return fn(tx as Tx);
  });
}

/**
 * The new tenant tables. `key` identifies a row (unique together with company_id); `site` is the
 * site a row belongs to, evaluated as OWNER (null = company-wide table); child tables reach it through
 * their parent. `parent` lets a test re-point a child at a parent of another site.
 */
interface NewTable { name: string; key: string; site: string | null; parent?: { col: string; table: string } }
const NEW_TABLES: NewTable[] = [
  { name: 'document_sequences', key: `doc_type || ':' || year`, site: null },
  { name: 'purchase_requests', key: 'id::text', site: 'site_id' },
  { name: 'purchase_request_items', key: 'id::text', site: '(SELECT p.site_id FROM purchase_requests p WHERE p.id = pr_id)', parent: { col: 'pr_id', table: 'purchase_requests' } },
  { name: 'purchase_orders', key: 'id::text', site: 'site_id' },
  { name: 'purchase_order_items', key: 'id::text', site: '(SELECT p.site_id FROM purchase_orders p WHERE p.id = po_id)', parent: { col: 'po_id', table: 'purchase_orders' } },
  { name: 'goods_receipts', key: 'id::text', site: 'site_id' },
  { name: 'goods_receipt_items', key: 'id::text', site: '(SELECT g.site_id FROM goods_receipts g WHERE g.id = gr_id)', parent: { col: 'gr_id', table: 'goods_receipts' } },
  { name: 'progress_reports', key: 'id::text', site: 'site_id' },
  { name: 'progress_items', key: 'id::text', site: '(SELECT r.site_id FROM progress_reports r WHERE r.id = report_id)', parent: { col: 'report_id', table: 'progress_reports' } },
  { name: 'sales_invoices', key: 'id::text', site: 'site_id' },
  { name: 'payments', key: 'id::text', site: 'site_id' },
  { name: 'dash_contracts', key: 'contract_id::text', site: 'site_id' },
  { name: 'dash_progress', key: `contract_id || '@' || period`, site: 'site_id' },
  { name: 'dash_monthly', key: `site_id || '@' || period`, site: 'site_id' },
  { name: 'dash_balances', key: 'site_id::text', site: 'site_id' },
  { name: 'dash_vendors', key: `site_id || ':' || vendor_id`, site: 'site_id' },
  { name: 'dash_alerts', key: `kind || ':' || ref`, site: 'site_id' },
  { name: 'dash_refreshes', key: 'company_id::text', site: null },
  { name: 'daily_digests', key: 'id::text', site: null },
];
const SITE_BOUND = NEW_TABLES.filter((t) => t.site !== null);
const COMPANY_WIDE = NEW_TABLES.filter((t) => t.site === null);

/** Tables that carry company_id but are deliberately NOT tenant tables (each with its reason). */
const NON_TENANT_WITH_COMPANY = {
  audit_logs: 'own read policy; written only by SECURITY DEFINER triggers',
  company_users: 'membership is resolved before a company context exists',
  jobs: 'the worker claims across companies; handlers open withCompany themselves',
  telegram_chats: 'the webhook resolves the company from the chat before it has a context',
} as const;
/** Tenant tables with no site dimension at all: every member of the company sees them. */
const COMPANY_WIDE_TENANT = ['vendors', 'document_sequences', 'dash_refreshes', 'daily_digests'];

let db: Db;
let close: () => Promise<void>;
let A = 0; let B = 0;
let a1 = 0; let a2 = 0; let b1 = 0;
let alice = 0; let bob = 0; let dave = 0; let carol = 0;
/** per site: the ids the tests point at */
const ids: Record<number, { contract: number; term: number; boqItem: number; vendor: number; pr: number; prItem: number; po: number; poItem: number; gr: number; grItem: number; report: number; invoice: number; payment: number; vendorInvoice: string }> = {};
const NOW = new Date('2026-10-27T03:00:00Z');

async function seedSite(tx: Tx, companyId: number, siteId: number, vendorId: number, tag: string): Promise<void> {
  const [k] = await tx.insert(contracts).values({ companyId, siteId, number: `K-${tag}`, employerName: `BWS ${tag}`, valueDppCents: 1_000_000_00 }).returning();
  const [term] = await tx.insert(contractTerms).values({ companyId, contractId: k!.id, seq: 1, name: 'T1', percentBp: 10_000, triggerProgressBp: 0 }).returning();
  const [v] = await tx.insert(boqVersions).values({ companyId, contractId: k!.id, version: 1, totalCents: 1_000_000_00 }).returning();
  const [bi] = await tx.insert(boqItems).values({ companyId, versionId: v!.id, code: '1', description: 'Galian', amountCents: 1_000_000_00, weightMicroPct: 100_000_000, category: 'material' }).returning();
  const [pr] = await tx.insert(purchaseRequests).values({ companyId, siteId, contractId: k!.id, number: `PR-${tag}`, status: 'approved' }).returning();
  const [pri] = await tx.insert(purchaseRequestItems).values({ companyId, prId: pr!.id, boqItemId: bi!.id, description: 'Semen', qty: '10.0000' }).returning();
  const [po] = await tx.insert(purchaseOrders).values({
    companyId, siteId, vendorId, prId: pr!.id, contractId: k!.id, number: `PO-${tag}`, orderDate: '2026-09-01', status: 'partial',
    dppCents: 1_000_00, ppnCents: 110_00, totalCents: 1_110_00,
  }).returning();
  const [poi] = await tx.insert(purchaseOrderItems).values({ companyId, poId: po!.id, prItemId: pri!.id, boqItemId: bi!.id, description: 'Semen', qty: '10.0000', unitPriceCents: 100_00, amountCents: 1_000_00 }).returning();
  const [gr] = await tx.insert(goodsReceipts).values({ companyId, siteId, poId: po!.id, number: `GR-${tag}`, receivedAt: '2026-09-05' }).returning();
  const [gri] = await tx.insert(goodsReceiptItems).values({ companyId, grId: gr!.id, poItemId: poi!.id, qtyReceived: '4.0000' }).returning();
  const [rep] = await tx.insert(progressReports).values({ companyId, siteId, contractId: k!.id, period: '2026-09-01', status: 'approved' }).returning();
  await tx.insert(progressItems).values({ companyId, reportId: rep!.id, boqItemId: bi!.id, cumulativeMicroPct: 40_000_000 });
  const [inv] = await tx.insert(salesInvoices).values({
    companyId, siteId, contractId: k!.id, termId: term!.id, number: `INV-${tag}`, invoiceDate: '2026-09-30', dueDate: '2026-10-30',
    progressMicroPct: 40_000_000, dppCents: 1_000_000_00, advanceDeductionCents: 0, retentionCents: 0, ppnCents: 110_000_00, totalCents: 1_110_000_00,
  }).returning();
  const [pay] = await tx.insert(payments).values({ companyId, siteId, payableType: 'sales_invoices', payableId: inv!.id, paidAt: '2026-10-10', amountCents: 500_000_00, method: 'transfer' }).returning();
  const [vi] = await tx.insert(vendorInvoices).values({
    companyId, siteId, vendorId, vendorName: 'TB Maju', totalCents: 1_110_00, status: 'perlu_cek', source: 'manual', poId: po!.id, grId: gr!.id,
  }).returning();
  await tx.insert(dashContracts).values({
    contractId: k!.id, companyId, siteId, number: k!.number, employerName: k!.employerName, status: 'active', valueDppCents: 1_000_000_00,
    addendumDeltaCents: 0, valueDppEffectiveCents: 1_000_000_00, valueTotalCents: 1_110_000_00, termsTotal: 1, termsIssued: 1, termsReady: 0,
    commitment: { total: { budgetCents: 1, committedCents: 1, receivedCents: 0 }, byCategory: {} },
  });
  await tx.insert(dashProgress).values({ contractId: k!.id, period: '2026-09-01', companyId, siteId, plannedMicroPct: 50_000_000, actualMicroPct: 40_000_000, deviationMicroPct: -10_000_000 });
  await tx.insert(dashMonthly).values({ companyId, siteId, period: '2026-09-01', poIssuedCents: 1_110_00 });
  await tx.insert(dashBalances).values({ companyId, siteId, receivableCount: 1 });
  await tx.insert(dashVendors).values({ companyId, siteId, vendorId, vendorName: 'TB Maju', poValueCents: 1_110_00, undeliveredCents: 666_00 });
  await tx.insert(dashAlerts).values({ companyId, kind: 'po_lewat_30_hari', ref: `po:${po!.id}`, siteId, data: { poId: po!.id } });
  ids[siteId] = {
    contract: k!.id, term: term!.id, boqItem: bi!.id, vendor: vendorId, pr: pr!.id, prItem: pri!.id, po: po!.id, poItem: poi!.id,
    gr: gr!.id, grItem: gri!.id, report: rep!.id, invoice: inv!.id, payment: pay!.id, vendorInvoice: vi!.rowId,
  };
}

async function seedCompany(companyId: number, userId: number, siteCodes: string[]): Promise<number[]> {
  return withCompany(db, { companyId, userId }, async (tx) => {
    const ss = await tx.insert(sites).values(siteCodes.map((code) => ({ companyId, code, name: `Site ${code}` }))).returning({ id: sites.id });
    const [v] = await tx.insert(vendors).values({ companyId, name: `TB Maju ${companyId}` }).returning({ id: vendors.id });
    for (const [i, s] of ss.entries()) await seedSite(tx, companyId, s.id, v!.id, `${companyId}-${siteCodes[i]}`);
    await tx.insert(documentSequences).values({ companyId, docType: 'PR', year: 2026, lastNumber: 7 });
    await tx.insert(dashRefreshes).values({ companyId, refreshedAt: NOW });
    await tx.insert(dailyDigests).values({ companyId, digestDate: '2026-10-27', alertKeys: ['po_lewat_30_hari:po:1'], recipients: 1, sentAt: NOW });
    return ss.map((s) => s.id);
  });
}

/** Every row of a table as OWNER (RLS bypassed): "<company>/<key>" plus the row's site. */
async function ownerRows(t: NewTable): Promise<Array<{ ck: string; c: number; site: number | null }>> {
  const rows = await asOwner(db, () => q<{ c: number; k: string; s: number | null }>(db,
    `SELECT company_id::int AS c, (${t.key})::text AS k, ${t.site ? `(${t.site})::int` : 'NULL::int'} AS s FROM ${t.name}`));
  return rows.map((r) => ({ ck: `${r.c}/${r.k}`, c: Number(r.c), site: r.s === null ? null : Number(r.s) }));
}
async function visibleKeys(tx: Tx, t: NewTable): Promise<string[]> {
  return (await q<{ c: number; k: string }>(tx, `SELECT company_id::int AS c, (${t.key})::text AS k FROM ${t.name}`)).map((r) => `${r.c}/${r.k}`).sort();
}
async function ownerRowJson(t: NewTable, where: string): Promise<string> {
  const [row] = await asOwner(db, () => q<{ j: unknown }>(db, `SELECT to_jsonb(x) AS j FROM ${t.name} x WHERE ${where} LIMIT 1`));
  expect(row, `${t.name}: a row where ${where}`).toBeDefined();
  return JSON.stringify(row!.j);
}
const insertCopy = (t: NewTable, json: string) => sql`INSERT INTO ${sql.raw(t.name)} SELECT * FROM jsonb_populate_record(NULL::${sql.raw(t.name)}, ${json}::jsonb)`;

beforeAll(async () => {
  ({ db, close } = await createTestDb());
  await withApp(db, async (tx) => {
    [A, B] = (await tx.insert(companies).values([{ code: 'AAA', name: 'PT AAA' }, { code: 'BBB', name: 'PT BBB' }]).returning({ id: companies.id })).map((r) => r.id) as [number, number];
    const us = await tx.insert(users).values([
      { email: 'alice@a.test', name: 'Alice' }, { email: 'bob@a.test', name: 'Bob' }, { email: 'dave@a.test', name: 'Dave' }, { email: 'carol@b.test', name: 'Carol' },
    ]).returning({ id: users.id });
    [alice, bob, dave, carol] = us.map((u) => u.id) as [number, number, number, number];
  });
  [a1, a2] = (await seedCompany(A, alice, ['KRM', 'BLM'])) as [number, number];
  [b1] = (await seedCompany(B, carol, ['KRM'])) as [number];
});
afterAll(async () => { await close(); });

describe('every table with company_id is covered by TENANT_TABLES and the RLS policies (information_schema)', () => {
  const tablesWithColumn = async (col: string) => (await asOwner(db, () => q<{ t: string }>(db, sql`
    SELECT c.table_name AS t FROM information_schema.columns c JOIN information_schema.tables x USING (table_schema, table_name)
     WHERE c.table_schema = 'public' AND c.column_name = ${col} AND x.table_type = 'BASE TABLE'`))).map((r) => r.t).sort();

  it('company_id tables = TENANT_TABLES + the four documented exceptions; every new table is a tenant table', async () => {
    const withCompanyId = await tablesWithColumn('company_id');
    expect(withCompanyId).toEqual([...TENANT_TABLES, ...Object.keys(NON_TENANT_WITH_COMPANY)].sort());
    expect(new Set(TENANT_TABLES).size).toBe(TENANT_TABLES.length);
    for (const t of NEW_TABLES) expect(TENANT_TABLES as readonly string[]).toContain(t.name);
    // the four exceptions really are outside RLS-by-company (or, audit_logs, read-only for the app)
    const [audit] = await asOwner(db, () => q<{ force: boolean }>(db, `SELECT relforcerowsecurity AS force FROM pg_class WHERE relname = 'audit_logs'`));
    expect(audit?.force).toBe(false);
  });

  it('RLS is enabled AND forced on every tenant table (the owner-less app role cannot bypass it)', async () => {
    const rows = await asOwner(db, () => q<{ t: string; rls: boolean; force: boolean }>(db, `
      SELECT relname AS t, relrowsecurity AS rls, relforcerowsecurity AS force FROM pg_class
       WHERE relnamespace = 'public'::regnamespace AND relkind = 'r'`));
    for (const t of TENANT_TABLES) expect(rows.find((r) => r.t === t), t).toMatchObject({ rls: true, force: true });
  });

  it('every tenant table has the company policy (USING + WITH CHECK on app.company_id) and a SELECT-only holding policy', async () => {
    const pols = await asOwner(db, () => q<{ t: string; name: string; permissive: string; roles: string; cmd: string; qual: string | null; check: string | null }>(db, `
      SELECT tablename AS t, policyname AS name, permissive, roles::text AS roles, cmd, qual, with_check AS check
        FROM pg_policies WHERE schemaname = 'public'`));
    for (const t of TENANT_TABLES) {
      const iso = pols.find((p) => p.name === `${t}_company_isolation`);
      expect(iso, `${t}_company_isolation`).toMatchObject({ t, permissive: 'PERMISSIVE', roles: '{jiat_app}', cmd: 'ALL' });
      expect(iso!.qual).toMatch(/company_id = \(NULLIF\(current_setting\('app\.company_id'::text, true\)/);
      expect(iso!.check).toMatch(/company_id = \(NULLIF\(current_setting\('app\.company_id'::text, true\)/);
      const hold = pols.find((p) => p.name === `${t}_holding_read`);
      expect(hold, `${t}_holding_read`).toMatchObject({ t, roles: '{jiat_holding}', cmd: 'SELECT' });
      // no other permissive policy could widen what jiat_app sees
      const others = pols.filter((p) => p.t === t && p.permissive === 'PERMISSIVE' && p.name !== iso!.name && p.name !== hold!.name);
      expect(others, t).toEqual([]);
    }
  });

  it('SITE_SCOPE: every tenant table with site_id is scoped on it; tables without one reach a site through their parent, or are company-wide by design', async () => {
    const withSiteId = new Set(await tablesWithColumn('site_id'));
    const pols = await asOwner(db, () => q<{ t: string; permissive: string; roles: string; cmd: string; qual: string | null; check: string | null }>(db, `
      SELECT tablename AS t, permissive, roles::text AS roles, cmd, qual, with_check AS check FROM pg_policies
       WHERE schemaname = 'public' AND policyname LIKE '%\\_site\\_scope'`));
    const scope = new Map(pols.map((p) => [p.t, p]));
    /** the table a site check finally lands on (following EXISTS (... FROM parent ...)) */
    const reachesSite = (t: string, depth = 0): boolean => {
      const p = scope.get(t);
      if (!p || depth > 5) return false;
      if (t === 'sites') return /jiat_site_allowed\(id\)/.test(p.qual ?? ''); // a site is scoped on its own id
      if (withSiteId.has(t)) return /jiat_site_allowed\(site_id\)/.test(p.qual ?? '');
      const parent = /FROM (\w+) \w+\s+WHERE/.exec(p.qual ?? '')?.[1];
      return parent !== undefined && parent !== t && reachesSite(parent, depth + 1);
    };
    for (const t of TENANT_TABLES) {
      if (COMPANY_WIDE_TENANT.includes(t)) {
        expect(withSiteId.has(t), `${t} is company-wide but has a site_id column`).toBe(false);
        expect(scope.has(t), `${t} is company-wide but has a site policy`).toBe(false);
        continue;
      }
      const p = scope.get(t);
      expect(p, `${t}_site_scope`).toMatchObject({ permissive: 'RESTRICTIVE', roles: '{jiat_app}', cmd: 'ALL' });
      expect(p!.check, `${t}: WITH CHECK = USING`).toBe(p!.qual);
      expect(reachesSite(t), `${t}: site scope reaches a site_id`).toBe(true);
    }
    // the child tables of this change set go through the parent named in NEW_TABLES
    for (const t of NEW_TABLES.filter((x) => x.parent)) {
      expect(scope.get(t.name)!.qual).toContain(`FROM ${t.parent!.table} `);
      expect(scope.get(t.name)!.qual).toContain(`.${t.parent!.col})`);
    }
  });

  it('grants: jiat_app may read/write tenant tables but never TRUNCATE (which skips RLS); jiat_holding holds SELECT only, on every table', async () => {
    for (const t of TENANT_TABLES) {
      const [g] = await asOwner(db, () => q<Record<string, boolean>>(db, sql`
        SELECT has_table_privilege('jiat_app', ${t}, 'SELECT') AS app_s, has_table_privilege('jiat_app', ${t}, 'INSERT') AS app_i,
               has_table_privilege('jiat_app', ${t}, 'UPDATE') AS app_u, has_table_privilege('jiat_app', ${t}, 'DELETE') AS app_d,
               has_table_privilege('jiat_app', ${t}, 'TRUNCATE') AS app_t,
               has_table_privilege('jiat_holding', ${t}, 'SELECT') AS h_s, has_table_privilege('jiat_holding', ${t}, 'INSERT') AS h_i,
               has_table_privilege('jiat_holding', ${t}, 'UPDATE') AS h_u, has_table_privilege('jiat_holding', ${t}, 'DELETE') AS h_d,
               has_table_privilege('jiat_holding', ${t}, 'TRUNCATE') AS h_t`));
      expect(g, t).toEqual({ app_s: true, app_i: true, app_u: true, app_d: true, app_t: false, h_s: true, h_i: false, h_u: false, h_d: false, h_t: false });
    }
    const holdingWrites = await asOwner(db, () => q<{ t: string; p: string }>(db, `
      SELECT table_name AS t, privilege_type AS p FROM information_schema.role_table_grants
       WHERE grantee = 'jiat_holding' AND table_schema = 'public' AND privilege_type <> 'SELECT'`));
    expect(holdingWrites).toEqual([]);
  });

  it('audit/stamp triggers: sales_invoices and payments (and the other new documents) are audited; every new table with created_by is stamped', async () => {
    for (const t of ['sales_invoices', 'payments', 'purchase_requests', 'purchase_request_items', 'purchase_orders', 'purchase_order_items',
      'goods_receipts', 'goods_receipt_items', 'progress_reports', 'progress_items']) {
      expect(AUDITED_TABLES as readonly string[]).toContain(t);
    }
    const trig = (await asOwner(db, () => q<{ name: string }>(db, `SELECT tgname AS name FROM pg_trigger WHERE NOT tgisinternal`))).map((r) => r.name);
    for (const t of AUDITED_TABLES) expect(trig, `${t}_audit`).toContain(`${t}_audit`);
    const stamped = stampedTables();
    for (const t of ['purchase_requests', 'purchase_orders', 'goods_receipts', 'progress_reports', 'sales_invoices', 'payments', 'vendor_invoices']) {
      expect(stamped).toContain(t);
      expect(trig).toContain(`${t}_stamp`);
    }
  });
});

describe('company isolation: A and B never see or touch each other\'s rows in the new tables', () => {
  it('the seed put rows of both companies (and both sites of A) into every new table', async () => {
    for (const t of NEW_TABLES) {
      const all = await ownerRows(t);
      expect(new Set(all.map((r) => r.c)), t.name).toEqual(new Set([A, B]));
      if (t.site) expect(new Set(all.filter((r) => r.c === A).map((r) => r.site)), t.name).toEqual(new Set([a1, a2]));
    }
  });

  for (const t of NEW_TABLES) {
    it(`${t.name}: each company reads exactly its own rows (raw SQL, no WHERE); no context reads nothing`, async () => {
      const all = await ownerRows(t);
      for (const c of [A, B]) {
        const seen = await withCompany(db, c, (tx) => visibleKeys(tx, t));
        expect(seen).toEqual(all.filter((r) => r.c === c).map((r) => r.ck).sort());
      }
      expect(await withApp(db, (tx) => visibleKeys(tx, t))).toEqual([]);
    });

    it(`${t.name}: A cannot insert a row of B, update or delete B's rows, or move its own rows to B`, async () => {
      const bRow = await ownerRowJson(t, `company_id = ${B}`);
      await failsWith(withCompany(db, { companyId: A, userId: alice }, (tx) => tx.execute(insertCopy(t, bRow))), RLS);
      const before = (await ownerRows(t)).filter((r) => r.c === B).map((r) => r.ck).sort();
      const touched = await withCompany(db, { companyId: A, userId: alice }, async (tx) => ({
        updated: await q(tx, `UPDATE ${t.name} SET company_id = company_id WHERE company_id = ${B} RETURNING 1`),
        deleted: await q(tx, `DELETE FROM ${t.name} WHERE company_id = ${B} RETURNING 1`),
      }));
      expect(touched).toEqual({ updated: [], deleted: [] });
      expect((await ownerRows(t)).filter((r) => r.c === B).map((r) => r.ck).sort()).toEqual(before);
      // positive control: the same UPDATE reaches A's own rows
      const own = await inRolledBack(db, A, (tx) => q(tx, `UPDATE ${t.name} SET company_id = company_id WHERE company_id = ${A} RETURNING 1`));
      expect(own.length).toBeGreaterThan(0);
      await failsWith(withCompany(db, A, (tx) => tx.execute(sql.raw(`UPDATE ${t.name} SET company_id = ${B} WHERE company_id = ${A}`))), RLS);
    });
  }

  it('typed inserts for B from A\'s context are refused too (WITH CHECK), e.g. a termin invoice, a payment and a digest', async () => {
    const ctx = { companyId: A, userId: dave };
    await failsWith(withCompany(db, ctx, (tx) => tx.insert(payments).values({ companyId: B, siteId: b1, payableType: 'sales_invoices', payableId: ids[b1]!.invoice, paidAt: '2026-10-11', amountCents: 1, method: 'tunai' })), RLS);
    await failsWith(withCompany(db, ctx, (tx) => tx.insert(salesInvoices).values({
      companyId: B, siteId: b1, contractId: ids[b1]!.contract, termId: ids[b1]!.term, number: 'INV-X', invoiceDate: '2026-10-01', dueDate: '2026-10-31',
      progressMicroPct: 0, dppCents: 0, advanceDeductionCents: 0, retentionCents: 0, ppnCents: 0, totalCents: 0, status: 'cancelled',
    })), RLS);
    await failsWith(withCompany(db, ctx, (tx) => tx.insert(dailyDigests).values({ companyId: B, digestDate: '2026-10-28' })), RLS);
    await failsWith(withCompany(db, ctx, (tx) => tx.insert(dashRefreshes).values({ companyId: B, refreshedAt: NOW })), RLS);
  });

  it('document numbers: A\'s upsert bumps only A\'s counter; A cannot create or bump B\'s', async () => {
    const counter = async (c: number) => (await asOwner(db, () => db.select().from(documentSequences)
      .where(and(eq(documentSequences.companyId, c), eq(documentSequences.docType, 'PR'), eq(documentSequences.year, 2026)))))[0]!.lastNumber;
    const [bBefore, aBefore] = [await counter(B), await counter(A)];
    const n = await withCompany(db, { companyId: A, userId: alice }, (tx) => nextDocNumber(tx, A, 'PR', 'KRM', '2026-10-27'));
    expect(n).toContain(String(aBefore + 1));
    expect(await counter(A)).toBe(aBefore + 1);
    expect(await counter(B)).toBe(bBefore);
    // the same upsert with B's id from A's context: refused, never "found B's row and incremented it"
    await failsWith(withCompany(db, A, (tx) => nextDocNumber(tx, B, 'PR', 'KRM', '2026-10-27')), RLS);
    expect(await counter(B)).toBe(bBefore);
  });

  it('refreshCompany(A) rebuilds A\'s snapshot with unfiltered DELETEs: B\'s dashboard rows survive untouched', async () => {
    const dash = NEW_TABLES.filter((t) => t.name.startsWith('dash_'));
    const bBefore = await Promise.all(dash.map(async (t) => (await ownerRows(t)).filter((r) => r.c === B).map((r) => r.ck).sort()));
    await refreshCompany(db, A, NOW);
    const bAfter = await Promise.all(dash.map(async (t) => (await ownerRows(t)).filter((r) => r.c === B).map((r) => r.ck).sort()));
    expect(bAfter).toEqual(bBefore);
    for (const keys of bAfter) expect(keys.length).toBeGreaterThan(0);
    // and A's snapshot was rebuilt from A's data only
    const aContracts = await withCompany(db, A, (tx) => tx.select().from(dashContracts));
    expect(new Set(aContracts.map((r) => r.contractId))).toEqual(new Set([ids[a1]!.contract, ids[a2]!.contract]));
  });
});

describe('site scope: a site_staff member at a1 sees a1 only; child rows follow their parent', () => {
  const atA1 = () => ({ companyId: A, userId: bob, siteIds: [a1] });

  for (const t of NEW_TABLES) {
    it(`${t.name}: scoped to [a1] → a1 rows${t.site ? '' : ' (company-wide: all of A)'}; scoped to [] → ${t.site ? 'nothing' : 'still all of A'}`, async () => {
      const all = (await ownerRows(t)).filter((r) => r.c === A);
      expect(await withCompany(db, atA1(), (tx) => visibleKeys(tx, t)))
        .toEqual(all.filter((r) => r.site === null || r.site === a1).map((r) => r.ck).sort());
      expect(await withCompany(db, { companyId: A, userId: bob, siteIds: [] }, (tx) => visibleKeys(tx, t)))
        .toEqual(all.filter((r) => r.site === null).map((r) => r.ck).sort());
    });
  }

  for (const t of SITE_BOUND) {
    it(`${t.name}: [a1] cannot insert onto a2, update/delete a2 rows, or move an a1 row to a2`, async () => {
      const a2Row = await ownerRowJson(t, `company_id = ${A} AND (${t.site}) = ${a2}`);
      await failsWith(withCompany(db, atA1(), (tx) => tx.execute(insertCopy(t, a2Row))), RLS);
      const a2Keys = (await ownerRows(t)).filter((r) => r.c === A && r.site === a2).map((r) => r.ck.slice(r.ck.indexOf('/') + 1));
      const keyIn = `(${t.key})::text IN (${a2Keys.map((k) => `'${k.replace(/'/g, "''")}'`).join(',')})`;
      const touched = await inRolledBack(db, atA1(), async (tx) => ({
        updated: await q(tx, `UPDATE ${t.name} SET company_id = company_id WHERE ${keyIn} RETURNING 1`),
        deleted: await q(tx, `DELETE FROM ${t.name} WHERE ${keyIn} RETURNING 1`),
      }));
      expect(touched).toEqual({ updated: [], deleted: [] });
      // moving an a1 row onto a2 is a WITH CHECK violation, directly or by re-parenting a child
      const move = t.parent
        ? `UPDATE ${t.name} SET ${t.parent.col} = (SELECT id FROM ${t.parent.table} WHERE site_id = ${a2} LIMIT 1)`
        : `UPDATE ${t.name} SET site_id = ${a2}`;
      // (a2's parent is invisible to [a1], so the subquery yields NULL; resolve it as owner instead)
      const sqlMove = t.parent
        ? `UPDATE ${t.name} SET ${t.parent.col} = ${(await asOwner(db, () => q<{ id: number }>(db, `SELECT id::int AS id FROM ${t.parent!.table} WHERE site_id = ${a2} LIMIT 1`)))[0]!.id}`
        : move;
      await failsWith(withCompany(db, atA1(), (tx) => tx.execute(sql.raw(sqlMove))), RLS);
    });
  }

  it('a child row follows its parent: moving a PR, PO, GR or opname from a1 to a2 (by the manager) hides its items from a1 staff', async () => {
    const parents = [
      { parent: purchaseRequests, child: 'purchase_request_items', col: 'pr_id', id: ids[a1]!.pr },
      { parent: purchaseOrders, child: 'purchase_order_items', col: 'po_id', id: ids[a1]!.po },
      { parent: goodsReceipts, child: 'goods_receipt_items', col: 'gr_id', id: ids[a1]!.gr },
      { parent: progressReports, child: 'progress_items', col: 'report_id', id: ids[a1]!.report },
    ] as const;
    const seen = await inRolledBack(db, { companyId: A, userId: alice }, async (tx) => {
      for (const p of parents) await tx.update(p.parent).set({ siteId: a2 }).where(eq(p.parent.id, p.id));
      // a nested scope in the same transaction: the staff member's view after the move
      await tx.execute(sql`SELECT set_config('app.site_scope', 'list', true), set_config('app.site_ids', ${String(a1)}, true)`);
      const out: Record<string, number> = {};
      for (const p of parents) out[p.child] = (await q(tx, `SELECT 1 FROM ${p.child} WHERE ${p.col} = ${p.id}`)).length;
      return out;
    });
    expect(seen).toEqual({ purchase_request_items: 0, purchase_order_items: 0, goods_receipt_items: 0, progress_items: 0 });
    // rolled back: still visible at a1
    const after = await withCompany(db, atA1(), (tx) => tx.select().from(purchaseRequestItems).where(eq(purchaseRequestItems.prId, ids[a1]!.pr)));
    expect(after).toHaveLength(1);
  });

  it('[a1] cannot hang a child row under a parent of another company either (the EXISTS reads the parent through RLS)', async () => {
    await failsWith(withCompany(db, atA1(), (tx) => tx.insert(purchaseRequestItems).values({ companyId: A, prId: ids[b1]!.pr, description: 'x', qty: '1' })), RLS);
    await failsWith(withCompany(db, atA1(), (tx) => tx.insert(goodsReceiptItems).values({ companyId: A, grId: ids[b1]!.gr, poItemId: ids[a1]!.poItem, qtyReceived: '1' })), RLS);
    await failsWith(withCompany(db, atA1(), (tx) => tx.insert(progressItems).values({ companyId: A, reportId: ids[b1]!.report, boqItemId: ids[a1]!.boqItem, cumulativeMicroPct: 1 })), RLS);
  });
});

describe('holding read (jiat_holding): every company, SELECT only', () => {
  for (const t of NEW_TABLES) {
    it(`${t.name}: sees the rows of every company; INSERT/UPDATE/DELETE refused (read-only tx, and by grants on the bare role)`, async () => {
      const all = (await ownerRows(t)).map((r) => r.ck).sort();
      expect(await withHoldingRead(db, (tx) => visibleKeys(tx, t))).toEqual(all);
      const row = await ownerRowJson(t, `company_id = ${A}`);
      await failsWith(withHoldingRead(db, (tx) => tx.execute(insertCopy(t, row))), READ_ONLY);
      await failsWith(withHoldingRead(db, (tx) => tx.execute(sql.raw(`UPDATE ${t.name} SET company_id = company_id`))), READ_ONLY);
      await failsWith(withHoldingRead(db, (tx) => tx.execute(sql.raw(`DELETE FROM ${t.name}`))), READ_ONLY);
      await failsWith(asBareHolding(db, (tx) => tx.execute(insertCopy(t, row))), DENIED);
      await failsWith(asBareHolding(db, (tx) => tx.execute(sql.raw(`UPDATE ${t.name} SET company_id = company_id`))), DENIED);
      await failsWith(asBareHolding(db, (tx) => tx.execute(sql.raw(`DELETE FROM ${t.name}`))), DENIED);
      await failsWith(asBareHolding(db, (tx) => tx.execute(sql.raw(`TRUNCATE ${t.name} CASCADE`))), DENIED);
      expect((await ownerRows(t)).map((r) => r.ck).sort()).toEqual(all);
    });
  }

  it('holding reads vendor_invoices.po_id / gr_id of every company, but no audit_logs and no jobs', async () => {
    const vi = await withHoldingRead(db, (tx) => tx.select({ c: vendorInvoices.companyId, po: vendorInvoices.poId, gr: vendorInvoices.grId }).from(vendorInvoices));
    expect(vi.map((r) => r.po).sort()).toEqual([ids[a1]!.po, ids[a2]!.po, ids[b1]!.po].sort());
    await failsWith(withHoldingRead(db, (tx) => tx.select().from(auditLogs)), DENIED);
    await failsWith(withHoldingRead(db, (tx) => tx.select().from(jobs)), DENIED);
  });
});

describe('audit trail and authorship of termin invoices and payments', () => {
  const logsOf = (c: number, type: string, id: number) => withCompany(db, c, (tx) => tx.select().from(auditLogs)
    .where(and(eq(auditLogs.auditableType, type), eq(auditLogs.auditableId, id))).orderBy(auditLogs.id));

  it('the seed inserts were logged with the acting user, the company and the full row', async () => {
    const inv = await logsOf(A, 'sales_invoices', ids[a1]!.invoice);
    expect(inv).toHaveLength(1);
    expect(inv[0]).toMatchObject({ companyId: A, userId: alice, action: 'insert', before: null });
    expect(inv[0]!.after).toMatchObject({ number: `INV-${A}-KRM`, total_cents: 1_110_000_00, site_id: a1, created_by: alice });
    const pay = await logsOf(A, 'payments', ids[a1]!.payment);
    expect(pay).toHaveLength(1);
    expect(pay[0]).toMatchObject({ companyId: A, userId: alice, action: 'insert' });
    expect(pay[0]!.after).toMatchObject({ amount_cents: 500_000_00, payable_type: 'sales_invoices', payable_id: ids[a1]!.invoice });
  });

  it('every row inserted into an audited new table has exactly one insert log, in its own company', async () => {
    for (const t of ['purchase_requests', 'purchase_request_items', 'purchase_orders', 'purchase_order_items', 'goods_receipts',
      'goods_receipt_items', 'progress_reports', 'progress_items', 'sales_invoices', 'payments']) {
      const rows = await asOwner(db, () => q<{ id: number; c: number }>(db, `SELECT id::int AS id, company_id::int AS c FROM ${t}`));
      const logs = await asOwner(db, () => q<{ id: number; c: number }>(db, sql`
        SELECT auditable_id::int AS id, company_id::int AS c FROM audit_logs WHERE auditable_type = ${t} AND action = 'insert'`));
      expect(logs.map((l) => `${l.c}/${l.id}`).sort(), t).toEqual(rows.map((r) => `${r.c}/${r.id}`).sort());
    }
  });

  it('update and delete are logged with before/after; created_by is kept, updated_by is the new actor', async () => {
    await withCompany(db, { companyId: A, userId: dave }, async (tx) => {
      await tx.update(salesInvoices).set({ status: 'partial', createdBy: dave }).where(eq(salesInvoices.id, ids[a2]!.invoice));
      await tx.update(payments).set({ reference: 'TRF-001', createdBy: dave, updatedBy: alice }).where(eq(payments.id, ids[a2]!.payment));
    });
    const [inv] = await withCompany(db, A, (tx) => tx.select().from(salesInvoices).where(eq(salesInvoices.id, ids[a2]!.invoice)));
    expect(inv).toMatchObject({ status: 'partial', createdBy: alice, updatedBy: dave });
    const [pay] = await withCompany(db, A, (tx) => tx.select().from(payments).where(eq(payments.id, ids[a2]!.payment)));
    expect(pay).toMatchObject({ reference: 'TRF-001', createdBy: alice, updatedBy: dave });

    const invLogs = await logsOf(A, 'sales_invoices', ids[a2]!.invoice);
    expect(invLogs.map((l) => l.action)).toEqual(['insert', 'update']);
    expect(invLogs[1]).toMatchObject({ userId: dave });
    expect(invLogs[1]!.before).toMatchObject({ status: 'issued' });
    expect(invLogs[1]!.after).toMatchObject({ status: 'partial', updated_by: dave, created_by: alice });

    await withCompany(db, { companyId: A, userId: dave }, (tx) => tx.delete(payments).where(eq(payments.id, ids[a2]!.payment)));
    const payLogs = await logsOf(A, 'payments', ids[a2]!.payment);
    expect(payLogs.map((l) => l.action)).toEqual(['insert', 'update', 'delete']);
    expect(payLogs[2]).toMatchObject({ userId: dave, after: null });
    expect(payLogs[2]!.before).toMatchObject({ reference: 'TRF-001', amount_cents: 500_000_00 });
  });

  it('a system job (no user) is logged with user_id NULL and stamps updated_by NULL', async () => {
    await withCompany(db, A, (tx) => tx.update(salesInvoices).set({ status: 'paid' }).where(eq(salesInvoices.id, ids[a1]!.invoice)));
    const [inv] = await withCompany(db, A, (tx) => tx.select().from(salesInvoices).where(eq(salesInvoices.id, ids[a1]!.invoice)));
    expect(inv).toMatchObject({ status: 'paid', createdBy: alice, updatedBy: null });
    const logs = await logsOf(A, 'sales_invoices', ids[a1]!.invoice);
    expect(logs.at(-1)).toMatchObject({ action: 'update', userId: null });
  });

  it('a company reads only its own invoice/payment logs; site staff cannot write history', async () => {
    const seenByA = await withCompany(db, A, (tx) => tx.select({ c: auditLogs.companyId }).from(auditLogs)
      .where(sql`${auditLogs.auditableType} IN ('sales_invoices', 'payments')`));
    expect(seenByA.length).toBeGreaterThan(0);
    expect(new Set(seenByA.map((r) => r.c))).toEqual(new Set([A]));
    expect(await logsOf(A, 'sales_invoices', ids[b1]!.invoice)).toEqual([]);
    expect(await logsOf(B, 'sales_invoices', ids[b1]!.invoice)).toHaveLength(1);
    await failsWith(withCompany(db, { companyId: A, userId: bob, siteIds: [a1] }, (tx) =>
      tx.insert(auditLogs).values({ companyId: A, action: 'forged', auditableType: 'payments' })), DENIED);
  });

  it('a refused cross-company write leaves no audit row behind', async () => {
    const count = async () => (await asOwner(db, () => q<{ n: number }>(db, `SELECT count(*)::int AS n FROM audit_logs WHERE auditable_type = 'payments'`)))[0]!.n;
    const before = await count();
    await failsWith(withCompany(db, { companyId: A, userId: dave }, (tx) => tx.insert(payments).values({
      companyId: B, siteId: b1, payableType: 'sales_invoices', payableId: ids[b1]!.invoice, paidAt: '2026-10-12', amountCents: 9, method: 'giro',
    })), RLS);
    expect(await count()).toBe(before);
  });
});

describe('vendor_invoices.po_id / gr_id (three-way match)', () => {
  it('the link is only visible where the invoice is; the PO behind it is subject to its own RLS', async () => {
    const fromA1 = await withCompany(db, { companyId: A, userId: bob, siteIds: [a1] }, (tx) =>
      tx.select({ po: vendorInvoices.poId, gr: vendorInvoices.grId, poNumber: purchaseOrders.number })
        .from(vendorInvoices).leftJoin(purchaseOrders, eq(purchaseOrders.id, vendorInvoices.poId)));
    expect(fromA1).toEqual([{ po: ids[a1]!.po, gr: ids[a1]!.gr, poNumber: `PO-${A}-KRM` }]);
    const fromB = await withCompany(db, B, (tx) => tx.select({ po: vendorInvoices.poId }).from(vendorInvoices));
    expect(fromB).toEqual([{ po: ids[b1]!.po }]);
  });

  it('setMatch: another company\'s PO is "not found"; a PO at a site outside the scope is "not found"; a GR of another PO is refused', async () => {
    const code = async (p: Promise<unknown>) => { try { await p; return 0; } catch (e) { return e instanceof HTTPException ? e.status : -1; } };
    const row = ids[a1]!.vendorInvoice;
    expect(await code(withCompany(db, { companyId: A, userId: alice }, (tx) => setMatch(tx, row, { poId: ids[b1]!.po })))).toBe(404);
    expect(await code(withCompany(db, { companyId: A, userId: alice, siteIds: [a1] }, (tx) => setMatch(tx, row, { poId: ids[a2]!.po })))).toBe(404);
    expect(await code(withCompany(db, { companyId: A, userId: alice }, (tx) => setMatch(tx, row, { poId: ids[a1]!.po, grId: ids[b1]!.gr })))).toBe(409);
    // B cannot even find A's invoice row
    expect(await code(withCompany(db, { companyId: B, userId: carol }, (tx) => setMatch(tx, row, { poId: ids[b1]!.po })))).toBe(404);
    const [vi] = await asOwner(db, () => db.select().from(vendorInvoices).where(eq(vendorInvoices.rowId, row)));
    expect(vi).toMatchObject({ poId: ids[a1]!.po, grId: ids[a1]!.gr });
  });

  it('the FK keeps a matched PO / GR from disappearing under the invoice', async () => {
    await failsWith(inRolledBack(db, A, (tx) => tx.delete(goodsReceipts).where(eq(goodsReceipts.id, ids[a1]!.gr))), /foreign key/);
    await failsWith(inRolledBack(db, A, async (tx) => {
      await tx.update(vendorInvoices).set({ grId: null }).where(eq(vendorInvoices.rowId, ids[a1]!.vendorInvoice));
      await tx.delete(goodsReceipts).where(eq(goodsReceipts.poId, ids[a1]!.po));
      return tx.delete(purchaseOrders).where(eq(purchaseOrders.id, ids[a1]!.po));
    }), /foreign key/);
  });
});

describe('jobs.dedupe_key', () => {
  it('is UNIQUE in the database: a slot is enqueued once, whoever enqueues it; NULL keys never collide', async () => {
    const [con] = await asOwner(db, () => q<{ def: string }>(db, `
      SELECT pg_get_constraintdef(oid) AS def FROM pg_constraint WHERE conrelid = 'jobs'::regclass AND contype = 'u'`));
    expect(con?.def).toBe('UNIQUE (dedupe_key)');
    const key = 'dashboard.refresh@2026-10-27T03:00:00.000Z';
    expect(await withApp(db, (tx) => enqueueOnce(tx, { kind: 'dashboard.refresh', companyId: null, dedupeKey: key }))).toBe(true);
    expect(await withApp(db, (tx) => enqueueOnce(tx, { kind: 'dashboard.refresh', companyId: null, dedupeKey: key }))).toBe(false);
    expect(await withApp(db, (tx) => enqueueOnce(tx, { kind: 'dashboard.refresh', companyId: A, dedupeKey: key }))).toBe(false);
    await failsWith(withApp(db, (tx) => tx.insert(jobs).values({ kind: 'x', companyId: null, payload: {}, dedupeKey: key })), /unique|duplicate key/);
    await withApp(db, async (tx) => { await enqueue(tx, { kind: 'plain', companyId: A }); await enqueue(tx, { kind: 'plain', companyId: A }); });
    const rows = await asOwner(db, () => db.select({ k: jobs.dedupeKey, kind: jobs.kind }).from(jobs));
    expect(rows.filter((r) => r.k === key)).toHaveLength(1);
    expect(rows.filter((r) => r.kind === 'plain' && r.k === null)).toHaveLength(2);
  });
});

describe('migrations: no schema drift', () => {
  const drizzleDir = join(ROOT, 'drizzle');
  const journal = JSON.parse(readFileSync(join(drizzleDir, 'meta/_journal.json'), 'utf8')) as { entries: Array<{ idx: number; tag: string }> };
  const snapshotOf = (idx: number) => JSON.parse(readFileSync(join(drizzleDir, `meta/${String(idx).padStart(4, '0')}_snapshot.json`), 'utf8')) as { id: string; prevId: string };

  it('journal, SQL files and snapshots line up, and the snapshots form one chain', () => {
    const sqlFiles = readdirSync(drizzleDir).filter((f) => f.endsWith('.sql')).sort();
    expect(sqlFiles).toEqual(journal.entries.map((e) => `${e.tag}.sql`));
    journal.entries.forEach((e, i) => expect(e.idx).toBe(i));
    for (const e of journal.entries.slice(1)) expect(snapshotOf(e.idx).prevId).toBe(snapshotOf(e.idx - 1).id);
  });

  it('schema.ts vs the last snapshot: drizzle-kit would generate no statement', async () => {
    const last = journal.entries.at(-1)!;
    const prev = snapshotOf(last.idx);
    const cur = generateDrizzleJson(schema as unknown as Record<string, unknown>, prev.id);
    expect(await generateMigration(prev as never, cur as never)).toEqual([]);
  });

  it('`drizzle-kit generate` (the CLI) writes no new migration', () => {
    const tmp = mkdtempSync(join(tmpdir(), 'jiat-drift-'));
    try {
      cpSync(drizzleDir, join(tmp, 'drizzle'), { recursive: true });
      const config = join(tmp, 'drizzle.config.ts');
      // drizzle-kit resolves `out` relative to the working directory
      writeFileSync(config, `export default { dialect: 'postgresql', schema: './src/db/schema.ts', out: ${JSON.stringify(relative(ROOT, join(tmp, 'drizzle')))} };\n`);
      const out = execFileSync(process.execPath, [join(ROOT, 'node_modules/drizzle-kit/bin.cjs'), 'generate', '--config', config], {
        cwd: ROOT, encoding: 'utf8', timeout: 60_000, stdio: ['ignore', 'pipe', 'pipe'],
      });
      expect(out).toMatch(/No schema changes/);
      expect(readdirSync(join(tmp, 'drizzle')).filter((f) => f.endsWith('.sql')).sort()).toEqual(journal.entries.map((e) => `${e.tag}.sql`));
      expect(existsSync(join(tmp, 'drizzle', 'meta', `${String(journal.entries.length).padStart(4, '0')}_snapshot.json`))).toBe(false);
    } finally {
      rmSync(tmp, { recursive: true, force: true });
    }
  });

  it('the SQL migrations build the same database as the schema (columns, constraints, indexes), and the RLS/audit DDL applies on it', async () => {
    const describeDb = async (d: Db) => ({
      columns: (await q<Record<string, unknown>>(d, `
        SELECT table_name, column_name, data_type, character_maximum_length, numeric_precision, numeric_scale, is_nullable, column_default
          FROM information_schema.columns WHERE table_schema = 'public' ORDER BY table_name, column_name`)),
      constraints: (await q<Record<string, unknown>>(d, `
        SELECT conrelid::regclass::text AS t, conname, contype, pg_get_constraintdef(oid) AS def
          FROM pg_constraint WHERE connamespace = 'public'::regnamespace ORDER BY 1, 2`)),
      indexes: (await q<Record<string, unknown>>(d, `SELECT tablename, indexname, indexdef FROM pg_indexes WHERE schemaname = 'public' ORDER BY 1, 2`)),
    });
    const mk = async () => {
      const client = new PGlite({ extensions: { pg_trgm } });
      return { client, d: drizzle(client, { schema }) as unknown as Db };
    };
    const pushed = await mk();
    const migrated = await mk();
    try {
      await (await pushSchema(schema, pushed.d as never)).apply();
      await migrate(migrated.d as never, { migrationsFolder: drizzleDir });
      const [p, m] = [await describeDb(pushed.d), await describeDb(migrated.d)];
      expect(m.columns).toEqual(p.columns);
      expect(m.constraints).toEqual(p.constraints);
      expect(m.indexes).toEqual(p.indexes);
      for (const stmt of postMigrationStatements()) await migrated.d.execute(sql.raw(stmt));
      const [n] = await q<{ n: number }>(migrated.d, `SELECT count(*)::int AS n FROM pg_policies WHERE schemaname = 'public'`);
      const [expected] = await asOwner(db, () => q<{ n: number }>(db, `SELECT count(*)::int AS n FROM pg_policies WHERE schemaname = 'public'`));
      expect(n!.n).toBe(expected!.n);
    } finally {
      await pushed.client.close();
      await migrated.client.close();
    }
  });
});
