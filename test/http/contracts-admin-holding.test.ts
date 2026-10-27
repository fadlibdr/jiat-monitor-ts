import { and, eq, sql } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { headerAuthenticator } from '../../src/auth/authenticator.js';
import { auditLogs, companies, companyUsers, contracts, managementViewers, sessions, sites, users } from '../../src/db/schema.js';
import { withApp, withCompany, type Db } from '../../src/db/tenant.js';
import { createApp } from '../../src/http/app.js';
import { asOwner, createTestDb } from '../helpers/db.js';

const TODAY = new Date('2026-10-27T03:00:00Z');

let db: Db;
let close: () => Promise<void>;
let app: ReturnType<typeof createApp>;
let A = 0; let B = 0;
let admin = 0; let mgr = 0; let staff = 0; let fin = 0; let boss = 0; let bob = 0;
let s1 = 0; let s2 = 0; let k1 = 0; let k2 = 0; let kB = 0;

const as = (userId: number) => ({ 'x-dev-user-id': String(userId) });
const send = (userId: number, method: string, body?: unknown) => ({
  method, headers: { ...as(userId), 'content-type': 'application/json' }, ...(body === undefined ? {} : { body: JSON.stringify(body) }),
});
async function data<T>(res: Response): Promise<T> {
  return ((await res.json()) as { data: T }).data;
}

beforeAll(async () => {
  ({ db, close } = await createTestDb());
  app = createApp({ db, auth: headerAuthenticator('test'), now: () => TODAY });
  await withApp(db, async (tx) => {
    const cs = await tx.insert(companies).values([{ code: 'AAA', name: 'PT AAA' }, { code: 'BBB', name: 'PT BBB' }]).returning({ id: companies.id });
    [A, B] = [cs[0]!.id, cs[1]!.id];
    const us = await tx.insert(users).values([
      { email: 'admin@pii.test', name: 'Admin', isSystemAdmin: true },
      { email: 'mgr@a.test', name: 'Manager' },
      { email: 'staff@a.test', name: 'Staff' },
      { email: 'fin@a.test', name: 'Finance' },
      { email: 'boss@h.test', name: 'Boss' },
      { email: 'bob@b.test', name: 'Bob' },
    ]).returning({ id: users.id });
    [admin, mgr, staff, fin, boss, bob] = us.map((u) => u.id) as [number, number, number, number, number, number];
    await tx.insert(managementViewers).values({ userId: boss, role: 'holding_viewer' });
  });
  await withCompany(db, A, async (tx) => {
    const ss = await tx.insert(sites).values([{ companyId: A, code: 'KRM', name: 'JIAT Keerom' }, { companyId: A, code: 'BLM', name: 'JIAT Boalemo' }]).returning({ id: sites.id });
    [s1, s2] = [ss[0]!.id, ss[1]!.id];
    const ks = await tx.insert(contracts).values([
      { companyId: A, siteId: s1, number: 'HK-KRM', employerName: 'BWS Papua', valueDppCents: 8_150_000_000_00, endDate: '2027-01-06' },
      { companyId: A, siteId: s2, number: 'HK-BLM', employerName: 'BWS Sulawesi II', valueDppCents: 6_420_000_000_00, endDate: '2026-11-30' },
    ]).returning({ id: contracts.id });
    [k1, k2] = [ks[0]!.id, ks[1]!.id];
  });
  kB = await withCompany(db, B, async (tx) => {
    const [s] = await tx.insert(sites).values({ companyId: B, code: 'MWU', name: 'JIAT Morowali Utara' }).returning({ id: sites.id });
    const [k] = await tx.insert(contracts).values({ companyId: B, siteId: s!.id, number: 'HK-MWU', employerName: 'BWS Sulawesi III', valueDppCents: 5_300_000_000_00, status: 'active' }).returning({ id: contracts.id });
    return k!.id;
  });
  await withApp(db, (tx) => tx.insert(companyUsers).values([
    { userId: mgr, companyId: A, role: 'company_manager' },
    { userId: staff, companyId: A, role: 'site_staff', siteIds: [s1] },
    { userId: fin, companyId: A, role: 'finance' },
    { userId: bob, companyId: B, role: 'project_admin' },
  ]));
});
afterAll(async () => { await close(); });

describe('site scope over HTTP', () => {
  it('site staff list only their site and its contract; another site\'s contract is a 404, not a 403', async () => {
    const ss = await data<Array<{ code: string }>>(await app.request(`/companies/${A}/sites`, { headers: as(staff) }));
    expect(ss.map((s) => s.code)).toEqual(['KRM']);
    const ks = await data<Array<{ number: string }>>(await app.request(`/companies/${A}/contracts`, { headers: as(staff) }));
    expect(ks.map((k) => k.number)).toEqual(['HK-KRM']);
    expect((await app.request(`/companies/${A}/contracts/${k2}`, { headers: as(staff) })).status).toBe(404);
    expect((await app.request(`/companies/${A}/contracts/${k2}/terms`, { headers: as(staff) })).status).toBe(404);
  });
});

describe('termin schedule (PUT replaces the whole schedule)', () => {
  const url = () => `/companies/${A}/contracts/${k1}/terms`;
  const t = (seq: number, percentBp: number, triggerProgressBp: number) => ({ seq, name: `Termin ${seq}`, percentBp, triggerProgressBp });

  it('refuses Σ > 100 % and a decreasing trigger with 400, writing nothing', async () => {
    const res = await app.request(url(), send(mgr, 'PUT', [t(1, 6000, 3000), t(2, 5000, 2000)]));
    expect(res.status).toBe(400);
    expect(await res.text()).toMatch(/melebihi 100%.*|ambang progres/);
    expect(await data<unknown[]>(await app.request(url(), { headers: as(mgr) }))).toEqual([]);
  });

  it('a draft is stored but not complete; the full schedule is complete; GET returns it by seq', async () => {
    const draft = await app.request(url(), send(mgr, 'PUT', [t(2, 3000, 5000), t(1, 3000, 2500)]));
    expect(draft.status).toBe(200);
    expect(await draft.json()).toMatchObject({ complete: false, totalBp: 6000 });
    const full = await app.request(url(), send(mgr, 'PUT', [t(1, 3000, 2500), t(2, 3000, 5000), t(3, 4000, 10000)]));
    expect(await full.json()).toMatchObject({ complete: true, totalBp: 10000 });
    const got = (await (await app.request(url(), { headers: as(staff) })).json()) as { data: Array<{ seq: number; dueDays: number }>; complete: boolean };
    expect(got.data.map((x) => x.seq)).toEqual([1, 2, 3]);
    expect(got.data[0]!.dueDays).toBe(30);
    expect(got.complete).toBe(true);
  });

  it('site staff and finance cannot edit the schedule (403)', async () => {
    expect((await app.request(url(), send(staff, 'PUT', []))).status).toBe(403);
    expect((await app.request(url(), send(fin, 'PUT', []))).status).toBe(403);
  });
});

describe('addenda and the effective contract', () => {
  const url = () => `/companies/${A}/contracts/${k2}/addendums`;

  it('an addendum must change value and/or end date', async () => {
    expect((await app.request(url(), send(mgr, 'POST', { number: 'ADD-0', signedAt: '2026-09-01' }))).status).toBe(400);
  });

  it('applies to the effective value, end date and days left; the original DPP is untouched', async () => {
    const res = await app.request(url(), send(mgr, 'POST', { number: 'ADD-1', signedAt: '2026-09-01', valueDeltaCents: 1_200_000_000_00, endDateNew: '2026-12-15' }));
    expect(res.status).toBe(201);
    const k = await data<Record<string, unknown>>(await app.request(`/companies/${A}/contracts/${k2}`, { headers: as(mgr) }));
    expect(k).toMatchObject({
      valueDppCents: 6_420_000_000_00, addendumDeltaCents: 1_200_000_000_00, valueDppEffectiveCents: 7_620_000_000_00,
      valueTotalCents: 8_458_200_000_00, endDateEffective: '2026-12-15', daysLeft: 49,
    });
    expect((k['addendums'] as unknown[])).toHaveLength(1);
  });

  it('a duplicate number is 409; a delta that takes the DPP to ≤ 0 is 400 and not stored', async () => {
    expect((await app.request(url(), send(mgr, 'POST', { number: 'ADD-1', signedAt: '2026-09-02', valueDeltaCents: 1 }))).status).toBe(409);
    expect((await app.request(url(), send(mgr, 'POST', { number: 'ADD-2', signedAt: '2026-09-03', valueDeltaCents: -9_000_000_000_00 }))).status).toBe(400);
    expect(await data<unknown[]>(await app.request(url(), { headers: as(mgr) }))).toHaveLength(1);
  });
});

describe('PATCH contract / site', () => {
  it('changes only the fields sent (defaults are never re-applied) and refuses an advance above the DPP', async () => {
    const before = await data<{ ppnRateBp: number; status: string }>(await app.request(`/companies/${A}/contracts/${k1}`, { headers: as(mgr) }));
    const res = await app.request(`/companies/${A}/contracts/${k1}`, send(mgr, 'PATCH', { retentionBp: 500, advanceCents: 1_630_000_000_00 }));
    expect(res.status).toBe(200);
    expect(await data(res)).toMatchObject({ retentionBp: 500, advanceCents: 1_630_000_000_00, ppnRateBp: before.ppnRateBp, status: before.status });
    expect((await app.request(`/companies/${A}/contracts/${k1}`, send(mgr, 'PATCH', { advanceCents: 9_000_000_000_00 }))).status).toBe(400);
  });

  it('the DPP is not patchable: a body with only valueDppCents is empty after parsing (400)', async () => {
    expect((await app.request(`/companies/${A}/contracts/${k1}`, send(mgr, 'PATCH', { valueDppCents: 1 }))).status).toBe(400);
  });

  it('null is not "unset": null fields, a null body and a null addendum end date are 400', async () => {
    expect((await app.request(`/companies/${A}/contracts/${k1}`, send(mgr, 'PATCH', { endDate: null }))).status).toBe(400);
    expect((await app.request(`/companies/${A}/contracts/${k1}`, send(mgr, 'PATCH', null))).status).toBe(400);
    expect((await app.request(`/companies/${A}/contracts/${k1}/addendums`, send(mgr, 'POST', { number: 'ADD-N', signedAt: '2026-09-01', endDateNew: null }))).status).toBe(400);
    expect((await app.request(`/companies/${A}/contracts/${k1}/terms`, send(mgr, 'PUT', null))).status).toBe(400);
  });

  it('PATCH site: managers may, site staff may not', async () => {
    expect((await app.request(`/companies/${A}/sites/${s1}`, send(staff, 'PATCH', { name: 'X' }))).status).toBe(403);
    const res = await app.request(`/companies/${A}/sites/${s1}`, send(mgr, 'PATCH', { status: 'closed' }));
    expect(await data(res)).toMatchObject({ status: 'closed', code: 'KRM', updatedBy: mgr });
  });

  it('every change is in the company audit log with the acting user', async () => {
    const logs = await withCompany(db, A, (tx) => tx.select().from(auditLogs).where(and(eq(auditLogs.auditableType, 'sites'), eq(auditLogs.action, 'update'))));
    expect(logs.at(-1)).toMatchObject({ userId: mgr, auditableId: s1 });
  });
});

describe('members', () => {
  const url = () => `/companies/${A}/members`;

  it('the last company_manager can be neither removed nor demoted (409); with a second manager it can', async () => {
    expect((await app.request(`${url()}/${mgr}`, send(mgr, 'DELETE'))).status).toBe(409);
    expect((await app.request(url(), send(mgr, 'POST', { email: 'mgr@a.test', role: 'project_admin' }))).status).toBe(409);
    // with fin as a second manager, either one may step down …
    expect((await app.request(url(), send(mgr, 'POST', { email: 'fin@a.test', role: 'company_manager' }))).status).toBe(201);
    expect((await app.request(url(), send(fin, 'POST', { email: 'fin@a.test', role: 'finance' }))).status).toBe(201);
    // … which leaves mgr as the only manager again
    expect((await app.request(`${url()}/${mgr}`, send(mgr, 'DELETE'))).status).toBe(409);
  });

  it('DELETE of a non-member is 404; staff cannot delete (403)', async () => {
    expect((await app.request(`${url()}/${bob}`, send(mgr, 'DELETE'))).status).toBe(404);
    expect((await app.request(`${url()}/${fin}`, send(staff, 'DELETE'))).status).toBe(403);
  });
});

describe('holding', () => {
  it('lists every company\'s contracts with company, site and effective values; filters narrow it', async () => {
    const all = await data<Array<{ number: string; company: { code: string }; site: { code: string }; valueDppEffectiveCents: number }>>(
      await app.request('/holding/contracts', { headers: as(boss) }));
    expect(all.map((k) => k.number).sort()).toEqual(['HK-BLM', 'HK-KRM', 'HK-MWU']);
    expect(all.find((k) => k.number === 'HK-BLM')).toMatchObject({ company: { code: 'AAA' }, site: { code: 'BLM' }, valueDppEffectiveCents: 7_620_000_000_00 });

    const onlyB = await data<Array<{ id: number }>>(await app.request(`/holding/contracts?companies[]=${B}`, { headers: as(boss) }));
    expect(onlyB.map((k) => k.id)).toEqual([kB]);
    const byEmployer = await data<Array<{ number: string }>>(await app.request('/holding/contracts?employer=papua', { headers: as(boss) }));
    expect(byEmployer.map((k) => k.number)).toEqual(['HK-KRM']);
    const literal = await data<unknown[]>(await app.request('/holding/contracts?employer=%25', { headers: as(boss) }));
    expect(literal).toEqual([]); // "%" is a literal, not a wildcard
  });

  it('non-holding users are refused (403) and nothing is logged for them; every holding request is logged', async () => {
    expect((await app.request('/holding/contracts', { headers: as(mgr) })).status).toBe(403);
    const rows = await asOwner(db, () => db.execute(sql`SELECT user_id, meta FROM audit_logs WHERE action = 'holding_access' ORDER BY id`));
    const list = (Array.isArray(rows) ? rows : (rows as { rows: unknown[] }).rows) as Array<{ user_id: number | string; meta: { path: string; query: Record<string, string[]> } }>;
    expect(list.length).toBeGreaterThanOrEqual(4);
    expect(list.every((r) => Number(r.user_id) === boss)).toBe(true);
    expect(list.some((r) => r.meta.path === '/holding/contracts' && r.meta.query['employer']?.[0] === 'papua')).toBe(true);
  });

  it('company routes stay closed to a holding viewer (holding is not a company context)', async () => {
    expect((await app.request(`/companies/${A}/contracts`, { headers: as(boss) })).status).toBe(403);
  });
});

describe('admin (global system admin)', () => {
  it('everything under /admin is 403 for non-admins, including company managers', async () => {
    expect((await app.request('/admin/users', { headers: as(mgr) })).status).toBe(403);
    expect((await app.request('/admin/companies', { headers: as(mgr) })).status).toBe(403);
  });

  it('links a Telegram id to a user; the same Telegram id on another user is 409', async () => {
    const res = await app.request(`/admin/users/${staff}`, send(admin, 'PATCH', { telegramUserId: 777001 }));
    expect(await data(res)).toMatchObject({ id: staff, telegramUserId: 777001 });
    expect((await app.request(`/admin/users/${mgr}`, send(admin, 'PATCH', { telegramUserId: 777001 }))).status).toBe(409);
  });

  it('null clears a nullable profile field (Telegram link, phone) but not a required one', async () => {
    await app.request(`/admin/users/${fin}`, send(admin, 'PATCH', { telegramUserId: 777002, phone: '+62 811 000' }));
    const cleared = await app.request(`/admin/users/${fin}`, send(admin, 'PATCH', { telegramUserId: null, phone: null }));
    expect(await data(cleared)).toMatchObject({ telegramUserId: null, phone: null });
    expect((await app.request(`/admin/users/${fin}`, send(admin, 'PATCH', { name: null }))).status).toBe(400);
  });

  it('cannot deactivate or demote itself; deactivating a user ends its sessions and locks it out (403)', async () => {
    expect((await app.request(`/admin/users/${admin}`, send(admin, 'PATCH', { isActive: false }))).status).toBe(409);
    expect((await app.request(`/admin/users/${admin}`, send(admin, 'PATCH', { isSystemAdmin: false }))).status).toBe(409);
    await withApp(db, (tx) => tx.insert(sessions).values({ userId: staff, token: 'staff-session', expiresAt: new Date(Date.now() + 3_600_000) }));
    expect((await app.request(`/admin/users/${staff}`, send(admin, 'PATCH', { isActive: false }))).status).toBe(200);
    expect(await withApp(db, (tx) => tx.select().from(sessions).where(eq(sessions.userId, staff)))).toEqual([]);
    const locked = await app.request('/me/companies', { headers: as(staff) });
    expect(locked.status).toBe(403);
  });

  it('grants and revokes holding access; the grant records who and when', async () => {
    const grant = await app.request('/admin/management-viewers', send(admin, 'POST', { email: 'mgr@a.test', role: 'direksi' }));
    expect(grant.status).toBe(201);
    expect(await data(grant)).toMatchObject({ userId: mgr, role: 'direksi', grantedBy: admin });
    expect((await app.request('/holding/companies', { headers: as(mgr) })).status).toBe(200);
    expect((await app.request(`/admin/management-viewers/${mgr}`, send(admin, 'DELETE'))).status).toBe(204);
    expect((await app.request('/holding/companies', { headers: as(mgr) })).status).toBe(403);
    expect((await app.request(`/admin/management-viewers/${mgr}`, send(admin, 'DELETE'))).status).toBe(404);
  });

  it('admin manages members of any company without being a member; company data stays closed to it', async () => {
    const add = await app.request(`/admin/companies/${B}/members`, send(admin, 'POST', { email: 'staff@a.test', role: 'site_staff' }));
    expect(add.status).toBe(201);
    expect((await app.request(`/admin/companies/999999/members`, { headers: as(admin) })).status).toBe(404);
    expect((await app.request(`/companies/${B}/contracts`, { headers: as(admin) })).status).toBe(403);
  });

  it('PATCH company updates profile fields; an unknown company is 404', async () => {
    const res = await app.request(`/admin/companies/${A}`, send(admin, 'PATCH', { bankName: 'Bank Papua', bankAccount: '123-456-789' }));
    expect(await data(res)).toMatchObject({ bankName: 'Bank Papua', bankAccount: '123-456-789', code: 'AAA' });
    expect((await app.request('/admin/companies/999999', send(admin, 'PATCH', { name: 'X Y' }))).status).toBe(404);
  });
});
