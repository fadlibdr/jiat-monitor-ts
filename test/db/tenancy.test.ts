import { sql } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { companies, contracts, sites } from '../../src/db/schema.js';
import { MissingCompanyContext, withApp, withCompany, withHoldingRead, type Db } from '../../src/db/tenant.js';
import { createTestDb } from '../helpers/db.js';

/** drizzle drivers differ: postgres-js returns an array, pglite returns { rows }. */
function rowsOf<T>(res: unknown): T[] {
  return Array.isArray(res) ? (res as T[]) : ((res as { rows: T[] }).rows ?? []);
}
const rlsViolation = { cause: expect.objectContaining({ message: expect.stringMatching(/row-level security/) }) };

let db: Db;
let close: () => Promise<void>;
let a = 0;
let b = 0;

beforeAll(async () => {
  ({ db, close } = await createTestDb());
  [a, b] = await withApp(db, async (tx) => {
    const rows = await tx.insert(companies).values([{ code: 'AAA', name: 'PT AAA' }, { code: 'BBB', name: 'PT BBB' }]).returning({ id: companies.id });
    return rows.map((r) => r.id) as [number, number];
  });
  for (const c of [a, b]) {
    await withCompany(db, c, async (tx) => {
      const [site] = await tx.insert(sites).values({ companyId: c, code: 'KRM', name: `Keerom ${c}` }).returning({ id: sites.id });
      await tx.insert(contracts).values({ companyId: c, siteId: site!.id, number: 'K-1', employerName: 'BWS', valueDppCents: 1000_00 });
    });
  }
});
afterAll(async () => { await close(); });

describe('Postgres RLS tenancy', () => {
  it('a company context sees only its own rows on every tenant table', async () => {
    for (const [cid, other] of [[a, b], [b, a]] as const) {
      await withCompany(db, cid, async (tx) => {
        expect((await tx.select().from(sites)).map((s) => s.companyId)).toEqual([cid]);
        expect((await tx.select().from(contracts)).map((s) => s.companyId)).toEqual([cid]);
        expect(await tx.query.sites.findFirst({ where: (s, { eq }) => eq(s.companyId, other) })).toBeUndefined();
      });
    }
  });

  it('the same site code may exist in two companies (unique is per company)', async () => {
    const all = await withHoldingRead(db, (tx) => tx.select().from(sites));
    expect(all.filter((s) => s.code === 'KRM')).toHaveLength(2);
  });

  it('no company context => zero rows, never everything (app role, no app.company_id)', async () => {
    await withApp(db, async (tx) => {
      expect(await tx.select().from(sites)).toEqual([]);
      expect(await tx.select().from(contracts)).toEqual([]);
    });
  });

  it('writing a row for another company is rejected by WITH CHECK, inside and outside a transaction', async () => {
    await expect(
      withCompany(db, a, (tx) => tx.insert(sites).values({ companyId: b, code: 'Z', name: 'Z' })),
    ).rejects.toMatchObject(rlsViolation);
    await expect(
      withCompany(db, a, (tx) => tx.update(sites).set({ companyId: b })),
    ).rejects.toMatchObject(rlsViolation);
    // nothing leaked through
    const all = await withHoldingRead(db, (tx) => tx.select().from(sites));
    expect(all.map((s) => s.code).sort()).toEqual(['KRM', 'KRM']);
  });

  it('find-by-id across companies returns nothing', async () => {
    const bSite = await withCompany(db, b, (tx) => tx.query.sites.findFirst());
    const seenFromA = await withCompany(db, a, (tx) => tx.query.sites.findFirst({ where: (s, { eq }) => eq(s.id, bSite!.id) }));
    expect(seenFromA).toBeUndefined();
  });

  it('raw SQL inside the context is still scoped (a forgotten WHERE cannot leak)', async () => {
    const rows = await withCompany(db, a, async (tx) => rowsOf<{ company_id: number }>(await tx.execute(sql`SELECT company_id FROM contracts`)));
    expect(rows.map((r) => Number(r.company_id))).toEqual([a]);
  });

  it('holding read sees all companies but cannot write', async () => {
    const all = await withHoldingRead(db, (tx) => tx.select().from(contracts));
    expect(all.map((c) => c.companyId).sort()).toEqual([a, b].sort());
    await expect(withHoldingRead(db, (tx) => tx.insert(sites).values({ companyId: a, code: 'X', name: 'X' }))).rejects.toThrow();
  });

  it('context is transaction-local: the connection is clean afterwards', async () => {
    await withCompany(db, a, async (tx) => { await tx.select().from(sites); });
    const [row] = rowsOf<{ v: string | null }>(await db.execute(sql`SELECT current_setting('app.company_id', true) AS v`));
    expect(row?.v ?? '').toBe('');
  });

  it('rejects an invalid company id before touching the database', async () => {
    await expect(withCompany(db, 0, async () => 1)).rejects.toThrow(MissingCompanyContext);
    await expect(withCompany(db, Number.NaN, async () => 1)).rejects.toThrow(MissingCompanyContext);
  });
});
