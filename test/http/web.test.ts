import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { headerAuthenticator } from '../../src/auth/authenticator.js';
import { managementViewers, users } from '../../src/db/schema.js';
import { withApp, type Db } from '../../src/db/tenant.js';
import { createApp } from '../../src/http/app.js';
import { createTestDb } from '../helpers/db.js';

/** The browser UI served by the API under /app/, and GET /me which tells it who is signed in. */
let db: Db;
let close: () => Promise<void>;
let dist = '';
let app: ReturnType<typeof createApp>;
let ana = 0; let boss = 0;
const SHELL = '<!doctype html><html><head><script type="module" src="/app/assets/index-abc123.js"></script></head><body><div id="root"></div></body></html>';
const BUNDLE = 'console.log("app")';
const as = (userId: number) => ({ headers: { 'x-dev-user-id': String(userId) } });

beforeAll(async () => {
  ({ db, close } = await createTestDb());
  dist = await mkdtemp(join(tmpdir(), 'jiat-web-'));
  await mkdir(join(dist, 'assets'));
  await writeFile(join(dist, 'index.html'), SHELL);
  await writeFile(join(dist, 'assets', 'index-abc123.js'), BUNDLE);
  await writeFile(join(tmpdir(), 'jiat-web-secret.txt'), 'not for the web');
  [ana, boss] = await withApp(db, async (tx) => (await tx.insert(users).values([
    { email: 'ana@a.test', name: 'Ana' }, { email: 'boss@h.test', name: 'Boss', isSystemAdmin: true },
  ]).returning({ id: users.id })).map((u) => u.id) as [number, number]);
  await withApp(db, (tx) => tx.insert(managementViewers).values({ userId: boss, role: 'holding_viewer' }));
  app = createApp({ db, auth: headerAuthenticator('test'), webDistDir: dist });
});
afterAll(async () => {
  await close();
  await rm(dist, { recursive: true, force: true });
  await rm(join(tmpdir(), 'jiat-web-secret.txt'), { force: true });
});

describe('the UI under /app/', () => {
  it('serves the shell for /app/ and for any client route, never cached, with a strict CSP', async () => {
    for (const path of ['/app', '/app/', '/app/holding', '/app/c/3/intake']) {
      const res = await app.request(path);
      expect(res.status, path).toBe(200);
      expect(await res.text()).toBe(SHELL);
      expect(res.headers.get('cache-control')).toBe('no-cache');
      const csp = res.headers.get('content-security-policy') ?? '';
      expect(csp).toContain("script-src 'self'");
      expect(csp).toContain("frame-ancestors 'none'");
      expect(csp).not.toContain('unsafe-inline');
      expect(res.headers.get('x-frame-options')).toBe('DENY');
    }
  });

  it('serves hashed bundles for a year; a missing bundle is a 404, not the shell', async () => {
    const js = await app.request('/app/assets/index-abc123.js');
    expect(js.status).toBe(200);
    expect(js.headers.get('content-type')).toMatch(/javascript/);
    expect(js.headers.get('cache-control')).toBe('public, max-age=31536000, immutable');
    expect(await js.text()).toBe(BUNDLE);
    expect((await app.request('/app/assets/index-old999.js')).status).toBe(404);
  });

  it('never serves a file outside the build folder', async () => {
    for (const path of ['/app/assets/../../jiat-web-secret.txt', '/app/assets/%2e%2e/%2e%2e/jiat-web-secret.txt', '/app/assets/..%2f..%2fjiat-web-secret.txt']) {
      const res = await app.request(path);
      expect(await res.text(), path).not.toContain('not for the web');
    }
  });

  it('/ goes to the UI; the API keeps answering as before', async () => {
    const root = await app.request('/');
    expect(root.status).toBe(302);
    expect(root.headers.get('location')).toBe('/app/');
    expect((await app.request('/companies')).status).toBe(401);
    expect((await app.request('/health')).status).toBe(200);
  });

  it('without a build the API runs alone', async () => {
    const bare = createApp({ db, auth: headerAuthenticator('test'), webDistDir: join(dist, 'missing') });
    expect((await bare.request('/app/')).status).toBe(404);
  });
});

describe('GET /me', () => {
  it('401 without a session; the user, and whether the holding dashboard is theirs, with one', async () => {
    expect((await app.request('/me')).status).toBe(401);
    const me = await app.request('/me', as(ana));
    expect(await me.json()).toEqual({ data: { id: ana, name: 'Ana', email: 'ana@a.test', isSystemAdmin: false, holdingViewer: false } });
    expect(((await (await app.request('/me', as(boss))).json()) as { data: unknown }).data).toMatchObject({ isSystemAdmin: true, holdingViewer: true });
  });
});
