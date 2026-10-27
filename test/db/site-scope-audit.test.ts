import { and, eq, sql } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  auditLogs, boqItems, boqVersions, companies, contracts, contractTerms, sites, users,
} from '../../src/db/schema.js';
import { withApp, withCompany, type Db } from '../../src/db/tenant.js';
import { stampedTables } from '../../src/db/audit.js';
import { asOwner, createTestDb } from '../helpers/db.js';

const rlsViolation = { cause: expect.objectContaining({ message: expect.stringMatching(/row-level security/) }) };
const permissionDenied = { cause: expect.objectContaining({ message: expect.stringMatching(/permission denied/) }) };

let db: Db;
let close: () => Promise<void>;
let A = 0;
let s1 = 0; let s2 = 0; // sites of A
let k1 = 0; let k2 = 0; // contracts on s1 / s2
let alice = 0; let bob = 0;

beforeAll(async () => {
  ({ db, close } = await createTestDb());
  await withApp(db, async (tx) => {
    [A] = (await tx.insert(companies).values({ code: 'AAA', name: 'PT AAA' }).returning({ id: companies.id })).map((r) => r.id) as [number];
    const us = await tx.insert(users).values([{ email: 'alice@a.test', name: 'Alice' }, { email: 'bob@a.test', name: 'Bob' }]).returning({ id: users.id });
    [alice, bob] = [us[0]!.id, us[1]!.id];
  });
  await withCompany(db, { companyId: A, userId: alice }, async (tx) => {
    const ss = await tx.insert(sites).values([{ companyId: A, code: 'KRM', name: 'Keerom' }, { companyId: A, code: 'BLM', name: 'Boalemo' }]).returning({ id: sites.id });
    [s1, s2] = [ss[0]!.id, ss[1]!.id];
    const ks = await tx.insert(contracts).values([
      { companyId: A, siteId: s1, number: 'K-1', employerName: 'BWS Papua', valueDppCents: 100_00 },
      { companyId: A, siteId: s2, number: 'K-2', employerName: 'BWS Sulawesi II', valueDppCents: 100_00 },
    ]).returning({ id: contracts.id });
    [k1, k2] = [ks[0]!.id, ks[1]!.id];
    for (const k of [k1, k2]) {
      await tx.insert(contractTerms).values({ companyId: A, contractId: k, seq: 1, name: 'T1', percentBp: 10_000, triggerProgressBp: 10_000 });
      const [v] = await tx.insert(boqVersions).values({ companyId: A, contractId: k, version: 1, totalCents: 100_00 }).returning({ id: boqVersions.id });
      await tx.insert(boqItems).values({ companyId: A, versionId: v!.id, code: '1', description: 'Item', amountCents: 100_00 });
    }
  });
});
afterAll(async () => { await close(); });

describe('site scope (RESTRICTIVE policy on top of company isolation)', () => {
  const scoped = (siteIds: number[] | null) => ({ companyId: A, userId: bob, siteIds });

  it('a scoped member sees only its sites, and everything hanging off them down the BOQ chain', async () => {
    await withCompany(db, scoped([s1]), async (tx) => {
      expect((await tx.select().from(sites)).map((s) => s.id)).toEqual([s1]);
      expect((await tx.select().from(contracts)).map((k) => k.id)).toEqual([k1]);
      expect((await tx.select().from(contractTerms)).map((t) => t.contractId)).toEqual([k1]);
      expect((await tx.select().from(boqVersions)).map((v) => v.contractId)).toEqual([k1]);
      expect(await tx.select().from(boqItems)).toHaveLength(1);
    });
  });

  it('an empty list means no site at all; null means every site of the company', async () => {
    await withCompany(db, scoped([]), async (tx) => {
      expect(await tx.select().from(sites)).toEqual([]);
      expect(await tx.select().from(boqItems)).toEqual([]);
    });
    await withCompany(db, scoped(null), async (tx) => {
      expect(await tx.select().from(sites)).toHaveLength(2);
      expect(await tx.select().from(boqItems)).toHaveLength(2);
    });
  });

  it('writing onto a site outside the scope is refused by WITH CHECK, directly and through a contract', async () => {
    await expect(withCompany(db, scoped([s1]), (tx) =>
      tx.insert(contracts).values({ companyId: A, siteId: s2, number: 'K-X', employerName: 'X', valueDppCents: 1 }))).rejects.toMatchObject(rlsViolation);
    await expect(withCompany(db, scoped([s1]), (tx) =>
      tx.insert(contractTerms).values({ companyId: A, contractId: k2, seq: 2, name: 'T2', percentBp: 1, triggerProgressBp: 1 }))).rejects.toMatchObject(rlsViolation);
  });

  it('rejects malformed site ids before touching the database', async () => {
    await expect(withCompany(db, { companyId: A, siteIds: [0] }, async () => 1)).rejects.toThrow(/site_ids/);
  });
});

describe('audit trail and authorship (Postgres triggers)', () => {
  it('stamps created_by/updated_by from the acting user and keeps created_by on update', async () => {
    const [before] = await withCompany(db, A, (tx) => tx.select().from(sites).where(eq(sites.id, s1)));
    expect(before).toMatchObject({ createdBy: alice, updatedBy: alice });
    await withCompany(db, { companyId: A, userId: bob }, (tx) =>
      tx.update(sites).set({ name: 'Keerom I', createdBy: bob }).where(eq(sites.id, s1)));
    const [after] = await withCompany(db, A, (tx) => tx.select().from(sites).where(eq(sites.id, s1)));
    expect(after).toMatchObject({ name: 'Keerom I', createdBy: alice, updatedBy: bob });
    expect(after!.updatedAt.getTime()).toBeGreaterThanOrEqual(before!.updatedAt.getTime());
    expect(after!.createdAt.getTime()).toBe(before!.createdAt.getTime());
  });

  it('logs insert/update/delete with before/after rows and the acting user, readable only within the company', async () => {
    await withCompany(db, { companyId: A, userId: bob }, (tx) => tx.delete(contractTerms).where(eq(contractTerms.contractId, k2)));
    const logs = await withCompany(db, A, (tx) => tx.select().from(auditLogs).where(eq(auditLogs.auditableType, 'sites')));
    const update = logs.find((l) => l.action === 'update' && l.auditableId === s1);
    expect(update).toMatchObject({ companyId: A, userId: bob });
    expect(update!.before).toMatchObject({ name: 'Keerom' });
    expect(update!.after).toMatchObject({ name: 'Keerom I' });
    const del = await withCompany(db, A, (tx) => tx.select().from(auditLogs)
      .where(and(eq(auditLogs.auditableType, 'contract_terms'), eq(auditLogs.action, 'delete'))));
    expect(del).toHaveLength(1);
    expect(del[0]!.after).toBeNull();
    // no company context => none of A's log rows
    expect(await withApp(db, (tx) => tx.select().from(auditLogs))).toEqual([]);
  });

  it('the app role can neither write, edit nor erase history directly', async () => {
    await expect(withCompany(db, A, (tx) => tx.insert(auditLogs).values({ companyId: A, action: 'forged' }))).rejects.toMatchObject(permissionDenied);
    await expect(withCompany(db, A, (tx) => tx.update(auditLogs).set({ action: 'x' }))).rejects.toMatchObject(permissionDenied);
    await expect(withCompany(db, A, (tx) => tx.delete(auditLogs))).rejects.toMatchObject(permissionDenied);
    const n = await asOwner(db, () => db.execute(sql`SELECT count(*)::int AS n FROM audit_logs WHERE action = 'forged'`));
    expect(JSON.stringify(n)).toContain('"n":0');
  });

  it('every table with created_by gets the stamp trigger (derived from the schema, not a list)', () => {
    expect(stampedTables().sort()).toEqual(['contract_addendums', 'contract_terms', 'contracts', 'sites']);
  });
});
