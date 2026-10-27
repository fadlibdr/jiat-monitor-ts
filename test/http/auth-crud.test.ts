import { eq } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { betterAuthAuthenticator, createAuth, type Auth } from '../../src/auth/better-auth.js';
import { users } from '../../src/db/schema.js';
import { withApp, type Db } from '../../src/db/tenant.js';
import { createApp } from '../../src/http/app.js';
import { createTestDb } from '../helpers/db.js';

const SECRET = 'test-secret-test-secret-test-secret-0123456789';
const BASE = 'http://localhost:3000';

let db: Db;
let close: () => Promise<void>;
let auth: Auth;
let app: ReturnType<typeof createApp>;

/** Sign in through Better Auth's real endpoint and return the session cookie header. */
async function signIn(email: string, password: string): Promise<string> {
  const res = await app.request('/api/auth/sign-in/email', {
    method: 'POST',
    headers: { 'content-type': 'application/json', origin: BASE },
    body: JSON.stringify({ email, password }),
  });
  if (res.status !== 200) throw new Error(`sign-in ${res.status}: ${await res.text()}`);
  const cookies = res.headers.getSetCookie().map((c) => c.split(';')[0]!).join('; ');
  if (!cookies.includes('jiat.session_token')) throw new Error(`no session cookie in: ${cookies}`);
  return cookies;
}
const json = (cookie: string, body?: unknown) => ({
  method: body === undefined ? 'GET' : 'POST',
  headers: { cookie, 'content-type': 'application/json' },
  ...(body === undefined ? {} : { body: JSON.stringify(body) }),
});

beforeAll(async () => {
  ({ db, close } = await createTestDb());
  auth = createAuth(db, { secret: SECRET, baseURL: BASE, allowSignUp: true, secureCookies: false });
  app = createApp({ db, auth: betterAuthAuthenticator(auth), betterAuth: auth });
});
afterAll(async () => { await close(); });

describe('Better Auth integration', () => {
  it('sign-up creates a serial-id user; sign-in returns an httpOnly session cookie; /me works with it', async () => {
    const up = await app.request('/api/auth/sign-up/email', {
      method: 'POST', headers: { 'content-type': 'application/json', origin: BASE },
      body: JSON.stringify({ email: 'alice@a.test', password: 'alice-password-123', name: 'Alice' }),
    });
    expect(up.status).toBe(200);
    const user = ((await up.json()) as { user: { id: string | number } }).user;
    expect(Number(user.id)).toBeGreaterThan(0);

    const res = await app.request('/api/auth/sign-in/email', {
      method: 'POST', headers: { 'content-type': 'application/json', origin: BASE },
      body: JSON.stringify({ email: 'alice@a.test', password: 'alice-password-123' }),
    });
    expect(res.status).toBe(200);
    const raw = res.headers.getSetCookie().find((c) => c.startsWith('jiat.session_token'))!;
    expect(raw).toMatch(/HttpOnly/i);
    expect(raw).toMatch(/SameSite=Lax/i);

    const cookie = await signIn('alice@a.test', 'alice-password-123');
    const me = await app.request('/me/companies', json(cookie));
    expect(me.status).toBe(200);
    expect(await me.json()).toEqual({ data: [] });
  });

  it('wrong password and no cookie are 401; a tampered cookie is 401', async () => {
    const bad = await app.request('/api/auth/sign-in/email', {
      method: 'POST', headers: { 'content-type': 'application/json', origin: BASE },
      body: JSON.stringify({ email: 'alice@a.test', password: 'wrong-password-123' }),
    });
    expect(bad.status).toBe(401);
    expect((await app.request('/me/companies')).status).toBe(401);
    expect((await app.request('/me/companies', json('jiat.session_token=forged.signature'))).status).toBe(401);
  });

  it('sign-out invalidates the server-side session (cookie cache disabled => DB is authoritative)', async () => {
    const cookie = await signIn('alice@a.test', 'alice-password-123');
    expect((await app.request('/me/companies', json(cookie))).status).toBe(200);
    const out = await app.request('/api/auth/sign-out', { method: 'POST', headers: { cookie, origin: BASE } });
    expect(out.status).toBe(200);
    expect((await app.request('/me/companies', json(cookie))).status).toBe(401);
  });

  it('password minimum is exactly 12: 11 characters rejected, 12 accepted', async () => {
    const signUp = (email: string, password: string) => app.request('/api/auth/sign-up/email', {
      method: 'POST', headers: { 'content-type': 'application/json', origin: BASE },
      body: JSON.stringify({ email, password, name: 'S' }),
    });
    expect((await signUp('eleven@a.test', 'a'.repeat(11))).status).toBe(400);
    expect((await signUp('twelve@a.test', 'a'.repeat(12))).status).toBe(200);
  });

  it('null / missing fields at sign-up and sign-in are 400, never 500', async () => {
    const post = (path: string, body: unknown) => app.request(path, {
      method: 'POST', headers: { 'content-type': 'application/json', origin: BASE }, body: JSON.stringify(body),
    });
    expect((await post('/api/auth/sign-up/email', { email: null, password: 'alice-password-123', name: 'X' })).status).toBe(400);
    expect((await post('/api/auth/sign-up/email', { email: 'x@a.test', password: null, name: 'X' })).status).toBe(400);
    expect((await post('/api/auth/sign-in/email', {})).status).toBe(400);
  });

  it('sign-in is rate limited per client IP: 5 attempts a minute, the 6th is 429; another IP is unaffected', async () => {
    const limited = createAuth(db, { secret: SECRET, baseURL: BASE, secureCookies: false, rateLimit: true });
    const limitedApp = createApp({ db, auth: betterAuthAuthenticator(limited), betterAuth: limited });
    const attempt = (ip: string) => limitedApp.request('/api/auth/sign-in/email', {
      method: 'POST', headers: { 'content-type': 'application/json', origin: BASE, 'x-forwarded-for': ip },
      body: JSON.stringify({ email: 'alice@a.test', password: 'wrong-password-123' }),
    });
    for (let i = 0; i < 5; i++) expect((await attempt('203.0.113.77')).status).toBe(401);
    expect((await attempt('203.0.113.77')).status).toBe(429);
    expect((await attempt('203.0.113.78')).status).toBe(401);
  });

  it('sign-up is disabled by default (allowSignUp false)', async () => {
    const closedAuth = createAuth(db, { secret: SECRET, baseURL: BASE, secureCookies: false });
    const closedApp = createApp({ db, auth: betterAuthAuthenticator(closedAuth), betterAuth: closedAuth });
    const up = await closedApp.request('/api/auth/sign-up/email', {
      method: 'POST', headers: { 'content-type': 'application/json', origin: BASE },
      body: JSON.stringify({ email: 'nobody@a.test', password: 'nobody-password-123', name: 'N' }),
    });
    expect(up.status).toBeGreaterThanOrEqual(400);
  });
});

describe('company / site / contract / member CRUD with role authorization', () => {
  let alice = '';
  let bob = '';
  let companyId = 0;
  let siteId = 0;

  beforeAll(async () => {
    await app.request('/api/auth/sign-up/email', {
      method: 'POST', headers: { 'content-type': 'application/json', origin: BASE },
      body: JSON.stringify({ email: 'bob@b.test', password: 'bob-password-12345', name: 'Bob' }),
    });
    // HLD §2: companies are created by the (global) system admin; alice is one, bob is not
    await withApp(db, (tx) => tx.update(users).set({ isSystemAdmin: true }).where(eq(users.email, 'alice@a.test')));
    alice = await signIn('alice@a.test', 'alice-password-123');
    bob = await signIn('bob@b.test', 'bob-password-12345');
  });

  it('POST /admin/companies: system admin only; managerEmail becomes company_manager; the admin alone is not a member; duplicate is 409', async () => {
    expect((await app.request('/admin/companies', json(bob, { code: 'PII', name: 'PT Pelita Inovasi Internusa' }))).status).toBe(403);
    const bad = await app.request('/admin/companies', json(alice, { code: 'lower', name: 'X' }));
    expect(bad.status).toBe(400);
    const res = await app.request('/admin/companies', json(alice, { code: 'PII', name: 'PT Pelita Inovasi Internusa', managerEmail: 'alice@a.test' }));
    expect(res.status).toBe(201);
    companyId = ((await res.json()) as { data: { id: number } }).data.id;
    expect((await app.request('/admin/companies', json(alice, { code: 'XYZ', name: 'PT Tanpa Manajer' }))).status).toBe(201);
    const me = (await (await app.request('/me/companies', json(alice))).json()) as { data: Array<{ id: number; role: string }> };
    expect(me.data).toEqual([{ id: companyId, code: 'PII', name: 'PT Pelita Inovasi Internusa', role: 'company_manager' }]);
    expect((await app.request('/admin/companies', json(alice, { code: 'PII', name: 'Dup' }))).status).toBe(409);
  });

  it('non-member bob gets 403 on every company route; manager alice adds bob as site_staff', async () => {
    expect((await app.request(`/companies/${companyId}/sites`, json(bob))).status).toBe(403);
    const unknown = await app.request(`/companies/${companyId}/members`, json(alice, { email: 'nobody@x.test', role: 'site_staff' }));
    expect(unknown.status).toBe(404);
    const add = await app.request(`/companies/${companyId}/members`, json(alice, { email: 'bob@b.test', role: 'site_staff' }));
    expect(add.status).toBe(201);
    const list = (await (await app.request(`/companies/${companyId}/members`, json(bob))).json()) as { data: Array<{ email: string; role: string }> };
    expect(list.data.map((m) => [m.email, m.role]).sort()).toEqual([['alice@a.test', 'company_manager'], ['bob@b.test', 'site_staff']]);
  });

  it('site_staff may not create sites/members (403) and sees only the sites assigned via siteIds (none until assigned); manager may create', async () => {
    expect((await app.request(`/companies/${companyId}/sites`, json(bob, { code: 'KRM', name: 'Keerom' }))).status).toBe(403);
    expect((await app.request(`/companies/${companyId}/members`, json(bob, { email: 'alice@a.test', role: 'site_staff' }))).status).toBe(403);
    const site = await app.request(`/companies/${companyId}/sites`, json(alice, { code: 'KRM', name: 'Keerom', province: 'Papua', startDate: '2026-01-10' }));
    expect(site.status).toBe(201);
    siteId = ((await site.json()) as { data: { id: number } }).data.id;
    expect((await app.request(`/companies/${companyId}/sites`, json(alice, { code: 'KRM', name: 'Dup' }))).status).toBe(409);
    const sitesOf = async (cookie: string) =>
      ((await (await app.request(`/companies/${companyId}/sites`, json(cookie))).json()) as { data: Array<{ code: string }> }).data.map((s) => s.code);
    expect(await sitesOf(bob)).toEqual([]); // site_staff sees no site until assigned (HLD §2)
    await app.request(`/companies/${companyId}/members`, json(alice, { email: 'bob@b.test', role: 'site_staff', siteIds: [siteId] }));
    expect(await sitesOf(bob)).toEqual(['KRM']);
  });

  it('POST contracts derives valueTotalCents from DPP × PPN (never stored) and refuses a foreign site', async () => {
    const res = await app.request(`/companies/${companyId}/contracts`, json(alice, {
      siteId, number: 'K-1', employerName: 'BWS Papua', valueDppCents: 1_000_000_00, ppnRateBp: 1100,
    }));
    expect(res.status).toBe(201);
    const k = ((await res.json()) as { data: { valueDppCents: number; valueTotalCents: number } }).data;
    expect(k.valueTotalCents).toBe(1_110_000_00);
    expect((await app.request(`/companies/${companyId}/contracts`, json(alice, { siteId: 999_999, number: 'K-2', employerName: 'BWS', valueDppCents: 100 }))).status).toBe(404);
    expect((await app.request(`/companies/${companyId}/contracts`, json(alice, { siteId, number: 'K-3', employerName: 'BWS', valueDppCents: 0 }))).status).toBe(400);
    expect((await app.request(`/companies/${companyId}/contracts`, json(alice, { siteId, number: 'K-4', employerName: 'BWS', valueDppCents: 1 }))).status).toBe(201);
  });

  it('null or missing body fields on CRUD routes are 400 with zod issues, not 500', async () => {
    const r1 = await app.request(`/companies/${companyId}/sites`, json(alice, { code: null, name: 'X' }));
    expect(r1.status).toBe(400);
    expect(await r1.json()).toMatchObject({ error: 'invalid_request' });
    expect((await app.request(`/companies/${companyId}/contracts`, json(alice, { siteId, number: 'K-9', employerName: 'X' }))).status).toBe(400);
    expect((await app.request(`/companies/${companyId}/members`, json(alice, { email: 'bob@b.test', role: 'ceo' }))).status).toBe(400);
    expect((await app.request('/admin/companies', json(alice, null))).status).toBe(400);
  });

  it('malformed JSON body is 400 invalid_json; an unexpected server error is a generic 500 without the message', async () => {
    const bad = await app.request('/admin/companies', { method: 'POST', headers: { cookie: alice, 'content-type': 'application/json' }, body: '{not json' });
    expect(bad.status).toBe(400);
    expect(await bad.json()).toMatchObject({ error: 'invalid_json' });

    const boom = createApp({ db, auth: { authenticate: async () => { throw new Error('db exploded: secret detail'); } } });
    const res = await boom.request('/me/companies');
    expect(res.status).toBe(500);
    const body = await res.text();
    expect(body).toContain('internal');
    expect(body).not.toContain('secret detail');
  });

  it('role update via members endpoint is an upsert (bob promoted to project_admin can now create a site)', async () => {
    const up = await app.request(`/companies/${companyId}/members`, json(alice, { email: 'bob@b.test', role: 'project_admin' }));
    expect(up.status).toBe(201);
    expect((await app.request(`/companies/${companyId}/sites`, json(bob, { code: 'WMN', name: 'Wamena' }))).status).toBe(201);
  });
});
