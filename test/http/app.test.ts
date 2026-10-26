import ExcelJS from 'exceljs';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { headerAuthenticator } from '../../src/auth/authenticator.js';
import { companies, companyUsers, contracts, managementViewers, sites, users } from '../../src/db/schema.js';
import { withApp, withCompany, type Db } from '../../src/db/tenant.js';
import { createApp } from '../../src/http/app.js';
import { createTestDb } from '../helpers/db.js';

let db: Db;
let close: () => Promise<void>;
let app: ReturnType<typeof createApp>;
let A = 0; let B = 0; // companies
let alice = 0; let bob = 0; let boss = 0; // users: alice∈A, bob∈B, boss=holding viewer only
let contractA = 0;

async function xlsx(rows: Array<Array<string | number | null>>): Promise<Blob> {
  const wb = new ExcelJS.Workbook();
  const ws = wb.addWorksheet('RAB');
  ws.addRow(['No', 'Uraian', 'Satuan', 'Volume', 'Harga Satuan', 'Jumlah']);
  for (const r of rows) ws.addRow(r);
  return new Blob([Buffer.from(await wb.xlsx.writeBuffer())], { type: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet' });
}
function form(file: Blob, name = 'rab.xlsx'): FormData {
  const fd = new FormData();
  fd.append('file', file, name);
  return fd;
}
const as = (userId: number) => ({ 'x-dev-user-id': String(userId) });

beforeAll(async () => {
  ({ db, close } = await createTestDb());
  app = createApp({ db, auth: headerAuthenticator('test'), maxUploadBytes: 64 * 1024 });
  await withApp(db, async (tx) => {
    const cs = await tx.insert(companies).values([{ code: 'AAA', name: 'PT AAA' }, { code: 'BBB', name: 'PT BBB' }]).returning({ id: companies.id });
    [A, B] = [cs[0]!.id, cs[1]!.id];
    const us = await tx.insert(users).values([
      { email: 'alice@a.test', name: 'Alice' }, { email: 'bob@b.test', name: 'Bob' }, { email: 'boss@h.test', name: 'Boss' },
    ]).returning({ id: users.id });
    [alice, bob, boss] = [us[0]!.id, us[1]!.id, us[2]!.id];
    await tx.insert(companyUsers).values([{ userId: alice, companyId: A, role: 'project_admin' }, { userId: bob, companyId: B, role: 'site_staff' }]);
    await tx.insert(managementViewers).values({ userId: boss, role: 'holding_viewer' });
  });
  contractA = await withCompany(db, A, async (tx) => {
    const [s] = await tx.insert(sites).values({ companyId: A, code: 'KRM', name: 'Keerom' }).returning({ id: sites.id });
    const [k] = await tx.insert(contracts).values({ companyId: A, siteId: s!.id, number: 'K-1', employerName: 'BWS', valueDppCents: 10_000_00 }).returning({ id: contracts.id });
    return k!.id;
  });
});
afterAll(async () => { await close(); });

describe('HTTP: authentication and company authorization', () => {
  it('GET /health needs nothing', async () => {
    expect((await app.request('/health')).status).toBe(200);
  });
  it('401 without a principal', async () => {
    expect((await app.request('/me/companies')).status).toBe(401);
    expect((await app.request(`/companies/${A}/contracts/${contractA}/boq`)).status).toBe(401);
  });
  it('GET /me/companies lists only the caller\'s memberships', async () => {
    const res = await app.request('/me/companies', { headers: as(alice) });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ data: [{ id: A, code: 'AAA', name: 'PT AAA', role: 'project_admin' }] });
  });
  it('403 when the path names a company the user is not a member of (even a valid one)', async () => {
    const res = await app.request(`/companies/${B}/contracts/${contractA}/boq`, { headers: as(alice) });
    expect(res.status).toBe(403);
  });
  it('403 for a holding viewer on company routes: holding is read-only elsewhere, never a company context', async () => {
    expect((await app.request(`/companies/${A}/contracts/${contractA}/boq`, { headers: as(boss) })).status).toBe(403);
  });
  it('holding viewer lists all companies; a member cannot', async () => {
    const ok = await app.request('/holding/companies', { headers: as(boss) });
    expect(ok.status).toBe(200);
    expect(((await ok.json()) as { data: unknown[] }).data).toHaveLength(2);
    expect((await app.request('/holding/companies', { headers: as(alice) })).status).toBe(403);
  });
  it('400 on a non-numeric id (zod at the boundary)', async () => {
    const res = await app.request(`/companies/abc/contracts/1/boq`, { headers: as(alice) });
    expect(res.status).toBe(400);
    expect(await res.json()).toMatchObject({ error: 'invalid_request' });
  });
});

describe('HTTP: BOQ import', () => {
  const url = () => `/companies/${A}/contracts/${contractA}/boq/import`;

  it('404 before any import', async () => {
    expect((await app.request(`/companies/${A}/contracts/${contractA}/boq`, { headers: as(alice) })).status).toBe(404);
  });
  it('400 when the body is not multipart or has no "file"', async () => {
    expect((await app.request(url(), { method: 'POST', headers: as(alice), body: 'x' })).status).toBe(400);
    expect((await app.request(url(), { method: 'POST', headers: as(alice), body: new FormData() })).status).toBe(400);
  });
  it('422 with the typed import error and nothing written when totals mismatch', async () => {
    const res = await app.request(url(), { method: 'POST', headers: as(alice), body: form(await xlsx([['1', 'Item', 'm', 10, 1000, 9_999]])) });
    expect(res.status).toBe(422);
    expect(await res.json()).toMatchObject({ error: 'total_mismatch', details: { diff: '-1.00' } });
    expect((await app.request(`/companies/${A}/contracts/${contractA}/boq`, { headers: as(alice) })).status).toBe(404);
  });
  it('422 file_unreadable for a non-xlsx upload', async () => {
    const res = await app.request(url(), { method: 'POST', headers: as(alice), body: form(new Blob(['nope']), 'rab.xlsx') });
    expect(res.status).toBe(422);
    expect(await res.json()).toMatchObject({ error: 'file_unreadable' });
  });
  it('upload limit is inclusive: exactly 64 KiB passes the size gate (then fails as unreadable), 64 KiB + 1 is 413', async () => {
    const LIMIT = 64 * 1024;
    const atLimit = await app.request(url(), { method: 'POST', headers: as(alice), body: form(new Blob([Buffer.alloc(LIMIT)])) });
    expect(atLimit.status).toBe(422);
    expect(await atLimit.json()).toMatchObject({ error: 'file_unreadable' });
    const overLimit = await app.request(url(), { method: 'POST', headers: as(alice), body: form(new Blob([Buffer.alloc(LIMIT + 1)])) });
    expect(overLimit.status).toBe(413);
  });
  it('201 imports, then GET returns the current version with items; a second import makes version 2', async () => {
    const body = () => xlsx([['1', 'Item', 'm', 10, 1000, 10_000]]).then((f) => form(f, 'keerom.xlsx'));
    const r1 = await app.request(url(), { method: 'POST', headers: as(alice), body: await body() });
    expect(r1.status).toBe(201);
    expect(await r1.json()).toMatchObject({ data: { version: 1, items: 1, total: '10000.00', diff: '0.00' } });

    const get = await app.request(`/companies/${A}/contracts/${contractA}/boq`, { headers: as(alice) });
    expect(get.status).toBe(200);
    const json = (await get.json()) as { data: { version: { version: number; isCurrent: boolean; importedBy: number; sourceFilename: string }; items: Array<{ code: string }> } };
    expect(json.data.version).toMatchObject({ version: 1, isCurrent: true, importedBy: alice, sourceFilename: 'keerom.xlsx' });
    expect(json.data.items.map((i) => i.code)).toEqual(['1']);

    const r2 = await app.request(url(), { method: 'POST', headers: as(alice), body: await body() });
    expect(await r2.json()).toMatchObject({ data: { version: 2 } });
  });
  it('bob (company B) cannot import into or read company A\'s contract', async () => {
    expect((await app.request(url(), { method: 'POST', headers: as(bob), body: form(await xlsx([['1', 'x', 'm', 1, 1, 1]])) })).status).toBe(403);
    expect((await app.request(`/companies/${A}/contracts/${contractA}/boq`, { headers: as(bob) })).status).toBe(403);
  });
});

describe('headerAuthenticator guard', () => {
  it('refuses to be constructed in production', () => {
    expect(() => headerAuthenticator('production')).toThrow(/production/);
  });
});
