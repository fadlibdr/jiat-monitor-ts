import { count, sql } from 'drizzle-orm';
import type { PgTable } from 'drizzle-orm/pg-core';
import { expect } from 'vitest';
import { headerAuthenticator } from '../../src/auth/authenticator.js';
import {
  boqItems, boqVersions, companies, companyUsers, contracts, managementViewers, sites, users, vendors,
} from '../../src/db/schema.js';
import { withApp, withCompany, type Db } from '../../src/db/tenant.js';
import { createApp } from '../../src/http/app.js';
import { asOwner, createTestDb } from '../helpers/db.js';

/**
 * Shared seed for the procurement tests (one fresh PGlite per test file).
 *
 * Company A: sites s1 (KRM) and s2 (JYP); contract K1 at s1 with BOQ v1
 *   I (section, not a leaf) → I.1 (material), I.2 (material); II.1 (subkon); III.1 (no category)
 * contract K2 at s2 with one leaf; contract K1b at s1 with one leaf (same site, other contract).
 * Company B: site sB (BBB), contract KB with one leaf, vendor vB, manager bobB.
 *
 * Members of A: mgr (company_manager), adm (project_admin, all sites), admS1 (project_admin limited to s1),
 * fin (finance), staff (site_staff at s1), staffNone (site_staff without sites), sys (system_admin role).
 * boss is a holding viewer and member of no company.
 */
export interface World {
  db: Db;
  close: () => Promise<void>;
  app: ReturnType<typeof createApp>;
  clock: { now: Date };
  A: number; B: number;
  s1: number; s2: number; sB: number;
  K1: number; K1b: number; K2: number; KB: number;
  K1v1: number;
  leaf: { section: number; I1: number; I2: number; II1: number; III1: number; K1b: number; K2: number; KB: number };
  v1: number; v2: number; vDraft: number; vB: number;
  u: { mgr: number; adm: number; admS1: number; fin: number; staff: number; staffNone: number; sys: number; bobB: number; boss: number };
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
      { email: 'mgr@a.test', name: 'Manager' }, { email: 'adm@a.test', name: 'Admin proyek' }, { email: 'adms1@a.test', name: 'Admin KRM' },
      { email: 'fin@a.test', name: 'Finance' }, { email: 'staff@a.test', name: 'Staf KRM' }, { email: 'none@a.test', name: 'Staf tanpa site' },
      { email: 'sys@a.test', name: 'Sysadmin perusahaan' }, { email: 'bob@b.test', name: 'Bob B' }, { email: 'boss@h.test', name: 'Boss' },
    ]).returning({ id: users.id });
    const [mgr, adm, admS1, fin, staff, staffNone, sys, bobB, boss] = us.map((u) => u.id) as number[];
    w.u = { mgr: mgr!, adm: adm!, admS1: admS1!, fin: fin!, staff: staff!, staffNone: staffNone!, sys: sys!, bobB: bobB!, boss: boss! };
    await tx.insert(managementViewers).values({ userId: w.u.boss, role: 'holding_viewer' });
  });

  await withCompany(db, w.A, async (tx) => {
    const ss = await tx.insert(sites).values([
      { companyId: w.A, code: 'KRM', name: 'JIAT Keerom' }, { companyId: w.A, code: 'JYP', name: 'JIAT Jayapura' },
    ]).returning({ id: sites.id });
    [w.s1, w.s2] = ss.map((s) => s.id) as [number, number];
    const ks = await tx.insert(contracts).values([
      { companyId: w.A, siteId: w.s1, number: 'HK-KRM', employerName: 'BWS Papua', valueDppCents: 1_050_000_00, status: 'active' },
      { companyId: w.A, siteId: w.s2, number: 'HK-JYP', employerName: 'BWS Papua', valueDppCents: 500_000_00, status: 'active' },
      { companyId: w.A, siteId: w.s1, number: 'HK-KRM-2', employerName: 'Pemda Keerom', valueDppCents: 200_000_00, status: 'active' },
    ]).returning({ id: contracts.id });
    [w.K1, w.K2, w.K1b] = ks.map((k) => k.id) as [number, number, number];
    const vs = await tx.insert(boqVersions).values([
      { companyId: w.A, contractId: w.K1, version: 1, totalCents: 1_050_000_00 },
      { companyId: w.A, contractId: w.K2, version: 1, totalCents: 500_000_00 },
      { companyId: w.A, contractId: w.K1b, version: 1, totalCents: 200_000_00 },
    ]).returning({ id: boqVersions.id });
    const [v1, vK2, vK1b] = vs.map((v) => v.id) as [number, number, number];
    w.K1v1 = v1;
    const [section] = await tx.insert(boqItems).values({
      companyId: w.A, versionId: v1, code: 'I', description: 'Pekerjaan struktur', amountCents: 700_000_00, isLeaf: false, level: 0, sortOrder: 1,
    }).returning({ id: boqItems.id });
    const leaves = await tx.insert(boqItems).values([
      { companyId: w.A, versionId: v1, parentId: section!.id, code: 'I.1', description: 'Pekerjaan beton', amountCents: 600_000_00, category: 'material', level: 1, sortOrder: 2 },
      { companyId: w.A, versionId: v1, parentId: section!.id, code: 'I.2', description: 'Besi tulangan', amountCents: 100_000_00, category: 'material', level: 1, sortOrder: 3 },
      { companyId: w.A, versionId: v1, code: 'II.1', description: 'Pengeboran', amountCents: 300_000_00, category: 'subkon', level: 0, sortOrder: 4 },
      { companyId: w.A, versionId: v1, code: 'III.1', description: 'Lain-lain', amountCents: 50_000_00, level: 0, sortOrder: 5 },
      { companyId: w.A, versionId: vK2, code: 'I.1', description: 'Pipa transmisi', amountCents: 500_000_00, category: 'material', sortOrder: 1 },
      { companyId: w.A, versionId: vK1b, code: 'I.1', description: 'Jalan akses', amountCents: 200_000_00, category: 'material', sortOrder: 1 },
    ]).returning({ id: boqItems.id });
    const [I1, I2, II1, III1, K2leaf, K1bleaf] = leaves.map((l) => l.id) as number[];
    w.leaf = { section: section!.id, I1: I1!, I2: I2!, II1: II1!, III1: III1!, K2: K2leaf!, K1b: K1bleaf!, KB: 0 };
    const vds = await tx.insert(vendors).values([
      { companyId: w.A, name: 'PT Sumber Beton' }, { companyId: w.A, name: 'CV Alat Berat' }, { companyId: w.A, name: 'Toko Baru', status: 'draft' },
    ]).returning({ id: vendors.id });
    [w.v1, w.v2, w.vDraft] = vds.map((v) => v.id) as [number, number, number];
  });

  await withCompany(db, w.B, async (tx) => {
    const [s] = await tx.insert(sites).values({ companyId: w.B, code: 'BBB', name: 'Site B' }).returning({ id: sites.id });
    w.sB = s!.id;
    const [k] = await tx.insert(contracts).values({ companyId: w.B, siteId: w.sB, number: 'HK-B', employerName: 'Pemda B', valueDppCents: 100_000_00 }).returning({ id: contracts.id });
    w.KB = k!.id;
    const [v] = await tx.insert(boqVersions).values({ companyId: w.B, contractId: w.KB, version: 1, totalCents: 100_000_00 }).returning({ id: boqVersions.id });
    const [l] = await tx.insert(boqItems).values({ companyId: w.B, versionId: v!.id, code: 'I.1', description: 'B leaf', amountCents: 100_000_00 }).returning({ id: boqItems.id });
    w.leaf.KB = l!.id;
    const [vd] = await tx.insert(vendors).values({ companyId: w.B, name: 'PT Vendor B' }).returning({ id: vendors.id });
    w.vB = vd!.id;
  });

  await withApp(db, (tx) => tx.insert(companyUsers).values([
    { userId: w.u.mgr, companyId: w.A, role: 'company_manager' },
    { userId: w.u.adm, companyId: w.A, role: 'project_admin' },
    { userId: w.u.admS1, companyId: w.A, role: 'project_admin', siteIds: [w.s1] },
    { userId: w.u.fin, companyId: w.A, role: 'finance' },
    { userId: w.u.staff, companyId: w.A, role: 'site_staff', siteIds: [w.s1] },
    { userId: w.u.staffNone, companyId: w.A, role: 'site_staff' },
    { userId: w.u.sys, companyId: w.A, role: 'system_admin' },
    { userId: w.u.bobB, companyId: w.B, role: 'company_manager' },
  ]));
  return w;
}

export function client(w: World) {
  const send = (userId: number, method: string, body?: unknown) => ({
    method, headers: { 'x-dev-user-id': String(userId), 'content-type': 'application/json' }, ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
  /** request against company A (or `company`) */
  const call = (userId: number, method: string, path: string, body?: unknown, company = w.A) =>
    w.app.request(`/companies/${company}${path}`, send(userId, method, body));
  async function ok<T>(res: Response | Promise<Response>, status = 200): Promise<T> {
    const r = await res;
    const text = await r.text();
    expect(r.status, text).toBe(status);
    return (JSON.parse(text) as { data: T }).data;
  }
  /** asserts the status and returns the parsed body (for messages) */
  async function fails(res: Response | Promise<Response>, status: number): Promise<{ message?: string; error?: string }> {
    const r = await res;
    const text = await r.text();
    expect(r.status, text).toBe(status);
    try { return JSON.parse(text) as { message?: string }; } catch { return { message: text }; }
  }
  return { send, call, ok, fails };
}

/** Row count of a table across all companies (owner, bypasses RLS). */
export async function rows(w: World, table: PgTable): Promise<number> {
  return asOwner(w.db, async () => {
    const [r] = await w.db.select({ n: count() }).from(table);
    return Number(r!.n);
  });
}

/** Last number of a (company, type, year) sequence, 0 when the row does not exist yet. */
export async function seqOf(w: World, companyId: number, docType: string, year: number): Promise<number> {
  return asOwner(w.db, async () => {
    const r = await w.db.execute(sql`SELECT last_number FROM document_sequences WHERE company_id = ${companyId} AND doc_type = ${docType} AND year = ${year}`);
    const row = (r as unknown as { rows: Array<{ last_number: number }> }).rows[0];
    return row ? Number(row.last_number) : 0;
  });
}

export type Po = {
  id: number; number: string; status: string; siteId: number; vendorId: number; prId: number | null; contractId: number | null;
  dppCents: number; ppnCents: number; totalCents: number; ppnRateBp: number; approvedBy: number | null; approvedAt: string | null;
  items: Array<{ id: number; boqItemId: number | null; prItemId: number | null; qty: string; unitPriceCents: number; amountCents: number; qtyReceived?: string }>;
};
export type Pr = {
  id: number; number: string; status: string; siteId: number; contractId: number | null; requestedBy: number | null;
  decidedBy: number | null; decidedAt: string | null;
  items: Array<{ id: number; boqItemId: number | null; qty: string; estPriceCents: number | null; description: string }>;
};
export type Gr = { id: number; number: string; poId: number; siteId: number; poStatus: string; items: Array<{ poItemId: number; qtyReceived: string }> };

/** Draft PO through the API (adm), optionally approved by mgr. */
export async function makePo(w: World, body: Record<string, unknown>, opts: { approve?: boolean; as?: number } = {}): Promise<Po> {
  const { call, ok } = client(w);
  const po = await ok<Po>(call(opts.as ?? w.u.adm, 'POST', '/purchase-orders', { orderDate: '2026-10-01', ...body }), 201);
  if (opts.approve) await ok(call(w.u.mgr, 'POST', `/purchase-orders/${po.id}/approve`));
  return po;
}
