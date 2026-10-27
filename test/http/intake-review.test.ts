import { randomBytes, randomUUID } from 'node:crypto';
import { and, eq } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { headerAuthenticator } from '../../src/auth/authenticator.js';
import {
  attachments, auditLogs, companies, companyUsers, sites, telegramChats, users, vendorInvoices, vendors,
  type VendorInvoiceStatus,
} from '../../src/db/schema.js';
import { withApp, withCompany, type Db } from '../../src/db/tenant.js';
import type { Category } from '../../src/domain/categories.js';
import { createApp } from '../../src/http/app.js';
import type { ObjectStorage } from '../../src/intake/storage.js';
import { createTestDb } from '../helpers/db.js';

/**
 * Review API (GET /intake/review, PATCH /intake/:rowId, GET /intake/:rowId/photo), vendors API and
 * the admin Telegram chat mapping over HTTP. Rows are seeded directly (withCompany, so RLS applies
 * to the seed as well); photos live in a Map-backed ObjectStorage handed to createApp.
 */

const TODAY = new Date('2026-10-27T03:00:00Z');
/** site s1 starts 2026-03-01 → V7 window is [2026-01-30, 2026-10-28] for TODAY */
const S1_START = '2026-03-01';

/** In-memory ObjectStorage: what the photo endpoint reads, with a record of every key asked for. */
class MapStorage implements ObjectStorage {
  readonly files = new Map<string, { bytes: Buffer; contentType: string }>();
  readonly reads: string[] = [];
  async put(key: string, bytes: Buffer, contentType: string): Promise<void> {
    this.files.set(key, { bytes: Buffer.from(bytes), contentType });
  }
  async get(key: string): Promise<Buffer> {
    this.reads.push(key);
    const f = this.files.get(key);
    if (!f) throw new Error(`no such object: ${key}`);
    return f.bytes;
  }
  async delete(key: string): Promise<void> {
    this.files.delete(key);
  }
}

let db: Db;
let close: () => Promise<void>;
let storage: MapStorage;
let app: ReturnType<typeof createApp>;
/** same database, no storage configured */
let appNoStorage: ReturnType<typeof createApp>;

let A = 0; let B = 0;
let admin = 0; let mgr = 0; let pa = 0; let paS1 = 0; let staff = 0; let fin = 0; let bob = 0;
let s1 = 0; let s2 = 0; let sB = 0;
let vSinar = 0; let vAlat = 0; let vB = 0;

const NPWP = '012345678901234';
const BANK_ACCOUNT = '123-456-7890';

const as = (userId: number) => ({ 'x-dev-user-id': String(userId) });
const send = (userId: number, method: string, body?: unknown) => ({
  method, headers: { ...as(userId), 'content-type': 'application/json' }, ...(body === undefined ? {} : { body: JSON.stringify(body) }),
});
async function data<T>(res: Response): Promise<T> {
  return ((await res.json()) as { data: T }).data;
}

/** Shape of a row as the review API returns it (subset the tests read). */
interface ApiRow {
  rowId: string;
  siteId: number;
  vendorId: number | null;
  vendorName: string | null;
  invoiceDate: string | null;
  docNumber: string | null;
  category: Category | null;
  totalCents: number;
  npwp: string | null;
  status: VendorInvoiceStatus;
  confirmedAt: string | null;
  confirmedBy: number | null;
  confidence: { flags?: string[] };
  [k: string]: unknown;
}

interface SeedOpts {
  companyId?: number;
  siteId?: number;
  vendorId?: number | null;
  vendorName?: string | null;
  invoiceDate?: string | null;
  category?: Category | null;
  totalCents?: number;
  dppCents?: number | null;
  ppnCents?: number | null;
  npwp?: string | null;
  docNumber?: string | null;
  status?: VendorInvoiceStatus;
  flags?: string[];
  /** stored in MapStorage + attachments; null = row without a photo */
  photo?: { bytes: Buffer; mime: string } | null;
}

/** One intake row (+ attachment + stored photo), written through RLS for its company. */
async function seedRow(o: SeedOpts = {}): Promise<{ rowId: string; id: number; path: string | null }> {
  const companyId = o.companyId ?? A;
  const siteId = o.siteId ?? s1;
  const photo = o.photo === undefined ? { bytes: randomBytes(64), mime: 'image/jpeg' } : o.photo;
  const sha = randomBytes(32).toString('hex');
  const path = photo ? `company-${companyId}/intake/2026/10/${sha}.${photo.mime === 'image/png' ? 'png' : 'jpg'}` : null;
  const seeded = await withCompany(db, companyId, async (tx) => {
    const [inv] = await tx.insert(vendorInvoices).values({
      companyId, siteId,
      vendorId: o.vendorId === undefined ? vSinarFor(companyId) : o.vendorId,
      vendorName: o.vendorName === undefined ? (companyId === A ? 'Toko Sinar Jaya' : 'UD Maju Bersama') : o.vendorName,
      invoiceDate: o.invoiceDate === undefined ? '2026-10-20' : o.invoiceDate,
      category: o.category === undefined ? 'material' : o.category,
      totalCents: o.totalCents ?? 1_500_000_00,
      dppCents: o.dppCents ?? null,
      ppnCents: o.ppnCents ?? null,
      npwp: o.npwp === undefined ? NPWP : o.npwp,
      docNumber: o.docNumber ?? null,
      status: o.status ?? 'perlu_konfirmasi',
      source: 'telegram',
      imageHash: sha,
      confidence: { flags: o.flags ?? [] },
    }).returning({ id: vendorInvoices.id, rowId: vendorInvoices.rowId });
    if (photo && path) {
      await tx.insert(attachments).values({
        companyId, siteId, attachableType: 'vendor_invoices', attachableId: inv!.id,
        path, mime: photo.mime, size: photo.bytes.length, sha256: sha,
      });
    }
    return inv!;
  });
  if (photo && path) await storage.put(path, photo.bytes, photo.mime);
  return { ...seeded, path };
}
const vSinarFor = (companyId: number) => (companyId === A ? vSinar : vB);

/** The row as stored (owner of the data, not the API shape). */
async function dbRow(companyId: number, rowId: string) {
  return withCompany(db, companyId, async (tx) => {
    const rows = await tx.select().from(vendorInvoices).where(eq(vendorInvoices.rowId, rowId));
    return rows;
  });
}

async function listReview(userId: number, query = '', companyId = A): Promise<{ status: number; rows: ApiRow[] }> {
  const res = await app.request(`/companies/${companyId}/intake/review${query}`, { headers: as(userId) });
  if (res.status !== 200) return { status: res.status, rows: [] };
  return { status: 200, rows: await data<ApiRow[]>(res) };
}

const patch = (userId: number, rowId: string, body: unknown, companyId = A) =>
  app.request(`/companies/${companyId}/intake/${rowId}`, send(userId, 'PATCH', body));

beforeAll(async () => {
  ({ db, close } = await createTestDb());
  storage = new MapStorage();
  app = createApp({ db, auth: headerAuthenticator('test'), now: () => TODAY, storage });
  appNoStorage = createApp({ db, auth: headerAuthenticator('test'), now: () => TODAY });

  await withApp(db, async (tx) => {
    const cs = await tx.insert(companies).values([{ code: 'AAA', name: 'PT AAA' }, { code: 'BBB', name: 'PT BBB' }]).returning({ id: companies.id });
    [A, B] = [cs[0]!.id, cs[1]!.id];
    const us = await tx.insert(users).values([
      { email: 'admin@pii.test', name: 'Admin Sistem', isSystemAdmin: true },
      { email: 'mgr@a.test', name: 'Manager A' },
      { email: 'pa@a.test', name: 'Project Admin A' },
      { email: 'pa-s1@a.test', name: 'Project Admin Keerom' },
      { email: 'staff@a.test', name: 'Staff Keerom' },
      { email: 'fin@a.test', name: 'Finance A' },
      { email: 'bob@b.test', name: 'Bob B' },
    ]).returning({ id: users.id });
    [admin, mgr, pa, paS1, staff, fin, bob] = us.map((u) => u.id) as [number, number, number, number, number, number, number];
  });
  await withCompany(db, A, async (tx) => {
    const ss = await tx.insert(sites).values([
      { companyId: A, code: 'KRM', name: 'JIAT Keerom', startDate: S1_START },
      { companyId: A, code: 'BLM', name: 'JIAT Boalemo' },
    ]).returning({ id: sites.id });
    [s1, s2] = [ss[0]!.id, ss[1]!.id];
    const vs = await tx.insert(vendors).values([
      { companyId: A, name: 'Toko Sinar Jaya', npwp: NPWP, bankName: 'BRI', bankAccount: BANK_ACCOUNT, defaultCategory: 'material' },
      { companyId: A, name: 'CV Sewa Alat Mandiri', defaultCategory: 'alat' },
    ]).returning({ id: vendors.id });
    [vSinar, vAlat] = [vs[0]!.id, vs[1]!.id];
  });
  await withCompany(db, B, async (tx) => {
    const [s] = await tx.insert(sites).values({ companyId: B, code: 'MWU', name: 'JIAT Morowali Utara' }).returning({ id: sites.id });
    sB = s!.id;
    const [v] = await tx.insert(vendors).values({ companyId: B, name: 'UD Maju Bersama', npwp: '999999999999999', bankAccount: '999-999-999' }).returning({ id: vendors.id });
    vB = v!.id;
  });
  await withApp(db, (tx) => tx.insert(companyUsers).values([
    { userId: mgr, companyId: A, role: 'company_manager' },
    { userId: pa, companyId: A, role: 'project_admin' },
    { userId: paS1, companyId: A, role: 'project_admin', siteIds: [s1] },
    { userId: staff, companyId: A, role: 'site_staff', siteIds: [s1] },
    { userId: fin, companyId: A, role: 'finance' },
    { userId: bob, companyId: B, role: 'project_admin' },
  ]));
});
afterAll(async () => { await close(); });

// ---------------------------------------------------------------------------------------------
describe('GET /companies/:id/intake/review', () => {
  let open1 = ''; let open2 = ''; let open3 = ''; let confirmed = ''; let rejected = ''; let otherCompany = '';

  beforeAll(async () => {
    open1 = (await seedRow({ siteId: s1, status: 'perlu_konfirmasi', totalCents: 1_000_000_00 })).rowId;
    open2 = (await seedRow({ siteId: s1, status: 'perlu_cek', flags: ['arith_ppn'], dppCents: 1, ppnCents: 1, totalCents: 1_100_000_00 })).rowId;
    open3 = (await seedRow({ siteId: s2, status: 'perlu_konfirmasi', totalCents: 1_200_000_00 })).rowId;
    confirmed = (await seedRow({ siteId: s1, status: 'terkonfirmasi', totalCents: 1_300_000_00 })).rowId;
    rejected = (await seedRow({ siteId: s1, status: 'ditolak', totalCents: 1_400_000_00 })).rowId;
    otherCompany = (await seedRow({ companyId: B, siteId: sB, status: 'perlu_konfirmasi' })).rowId;
  });

  it('lists only open rows (perlu_konfirmasi, perlu_cek) by default, across all sites, never another company', async () => {
    const { status, rows } = await listReview(mgr, '?limit=200');
    expect(status).toBe(200);
    const ids = rows.map((r) => r.rowId);
    expect(ids).toEqual(expect.arrayContaining([open1, open2, open3]));
    expect(ids).not.toContain(confirmed);
    expect(ids).not.toContain(rejected);
    expect(ids).not.toContain(otherCompany);
    expect(rows.every((r) => r.status === 'perlu_konfirmasi' || r.status === 'perlu_cek')).toBe(true);
  });

  it('newest rows come first', async () => {
    const { rows } = await listReview(mgr, '?limit=200');
    const ids = rows.map((r) => r.rowId);
    expect(ids.indexOf(open3)).toBeLessThan(ids.indexOf(open2));
    expect(ids.indexOf(open2)).toBeLessThan(ids.indexOf(open1));
  });

  it('filters by status (closed rows are reachable explicitly)', async () => {
    const conf = await listReview(mgr, '?status=terkonfirmasi&limit=200');
    expect(conf.rows.map((r) => r.rowId)).toContain(confirmed);
    expect(conf.rows.every((r) => r.status === 'terkonfirmasi')).toBe(true);
    const rej = await listReview(mgr, '?status=ditolak&limit=200');
    expect(rej.rows.map((r) => r.rowId)).toEqual([rejected]);
    const cek = await listReview(mgr, '?status=perlu_cek&limit=200');
    expect(cek.rows.map((r) => r.rowId)).toContain(open2);
    expect(cek.rows.map((r) => r.rowId)).not.toContain(open1);
  });

  it('filters by siteId, alone and together with status', async () => {
    const onlyS2 = await listReview(mgr, `?siteId=${s2}&limit=200`);
    expect(onlyS2.rows.map((r) => r.rowId)).toEqual([open3]);
    const s1Confirmed = await listReview(mgr, `?siteId=${s1}&status=terkonfirmasi&limit=200`);
    expect(s1Confirmed.rows.map((r) => r.rowId)).toEqual([confirmed]);
    // a site of another company is not an error, just nothing (RLS)
    expect((await listReview(mgr, `?siteId=${sB}`)).rows).toEqual([]);
  });

  it('never exposes the internal id or companyId; rowId is the public reference', async () => {
    const res = await app.request(`/companies/${A}/intake/review?limit=200`, { headers: as(mgr) });
    const rows = await data<Array<Record<string, unknown>>>(res);
    expect(rows.length).toBeGreaterThan(0);
    for (const r of rows) {
      expect(r).not.toHaveProperty('id');
      expect(r).not.toHaveProperty('companyId');
      expect(r).not.toHaveProperty('company_id');
      expect(typeof r['rowId']).toBe('string');
      expect(r['rowId']).toMatch(/^[0-9a-f-]{36}$/);
    }
  });

  it('limit: 1 returns one row; 0 and 201 are 400; invalid status/siteId are 400', async () => {
    expect((await listReview(mgr, '?limit=1')).rows).toHaveLength(1);
    expect((await listReview(mgr, '?limit=0')).status).toBe(400);
    expect((await listReview(mgr, '?limit=201')).status).toBe(400);
    expect((await listReview(mgr, '?limit=200')).status).toBe(200);
    expect((await listReview(mgr, '?status=selesai')).status).toBe(400);
    expect((await listReview(mgr, '?siteId=abc')).status).toBe(400);
    expect((await listReview(mgr, '?siteId=0')).status).toBe(400);
  });

  it('site_staff gets 403; finance and project_admin may read', async () => {
    expect((await listReview(staff)).status).toBe(403);
    expect((await listReview(fin)).status).toBe(200);
    expect((await listReview(pa)).status).toBe(200);
  });

  it('a project_admin scoped to one site sees only that site, even when asking for another site', async () => {
    const { status, rows } = await listReview(paS1, '?limit=200');
    expect(status).toBe(200);
    const ids = rows.map((r) => r.rowId);
    expect(ids).toEqual(expect.arrayContaining([open1, open2]));
    expect(ids).not.toContain(open3);
    expect(rows.every((r) => r.siteId === s1)).toBe(true);
    expect((await listReview(paS1, `?siteId=${s2}`)).rows).toEqual([]);
  });

  it('401 without a principal; 403 for a member of another company and for the (non-member) system admin', async () => {
    expect((await app.request(`/companies/${A}/intake/review`)).status).toBe(401);
    expect((await listReview(bob)).status).toBe(403);
    expect((await listReview(admin)).status).toBe(403);
  });

  it('company B sees its own rows only', async () => {
    const { rows } = await listReview(bob, '?limit=200', B);
    expect(rows.map((r) => r.rowId)).toEqual([otherCompany]);
  });

  it('the receipt NPWP is visible to finance and managers, null for project_admin (HLD §8)', async () => {
    const forFinance = (await listReview(fin, '?limit=200')).rows.find((r) => r.rowId === open1)!;
    const forManager = (await listReview(mgr, '?limit=200')).rows.find((r) => r.rowId === open1)!;
    const forAdmin = (await listReview(pa, '?limit=200')).rows.find((r) => r.rowId === open1)!;
    expect(forFinance.npwp).toBe(NPWP);
    expect(forManager.npwp).toBe(NPWP);
    expect(forAdmin.npwp).toBeNull();
  });
});

// ---------------------------------------------------------------------------------------------
describe('PATCH /companies/:id/intake/:rowId — corrections', () => {
  it('category: updates the same row (same internal id, same rowId) and clears kategori_kosong', async () => {
    const seeded = await seedRow({ category: null, flags: ['kategori_kosong'] });
    const res = await patch(pa, seeded.rowId, { category: 'alat' });
    expect(res.status).toBe(200);
    const row = await data<ApiRow>(res);
    expect(row).toMatchObject({ rowId: seeded.rowId, category: 'alat', status: 'perlu_konfirmasi' });
    expect(row.confidence.flags ?? []).not.toContain('kategori_kosong');
    const stored = await dbRow(A, seeded.rowId);
    expect(stored).toHaveLength(1);
    expect(stored[0]!.id).toBe(seeded.id);
    expect(stored[0]!.category).toBe('alat');
  });

  it('total as integer cents', async () => {
    const { rowId } = await seedRow({ totalCents: 1_000_000_00 });
    const row = await data<ApiRow>(await patch(pa, rowId, { totalCents: 245_000_000 }));
    expect(row.totalCents).toBe(245_000_000);
  });

  it('total as text "Rp 2.450.000,-" is Rp 2.450.000 (245 000 000 cents)', async () => {
    const { rowId } = await seedRow({ totalCents: 1_000_000_00 });
    const res = await patch(pa, rowId, { totalCents: 'Rp 2.450.000,-' });
    expect(res.status).toBe(200);
    expect((await data<ApiRow>(res)).totalCents).toBe(245_000_000);
    expect((await dbRow(A, rowId))[0]!.totalCents).toBe(245_000_000);
  });

  it('a TOTAL correction recomputes V5: subtotal + PPN = new total clears arith_ppn and the row leaves perlu_cek', async () => {
    const { rowId } = await seedRow({
      dppCents: 2_000_000_00, ppnCents: 220_000_00, totalCents: 2_450_000_00, status: 'perlu_cek', flags: ['arith_ppn'],
    });
    const fixed = await data<ApiRow>(await patch(pa, rowId, { totalCents: 'Rp 2.220.000,-' }));
    expect(fixed.totalCents).toBe(222_000_000);
    expect(fixed.confidence.flags ?? []).not.toContain('arith_ppn');
    expect(fixed.status).toBe('perlu_konfirmasi');
    // and back: a total that no longer matches sets the flag again
    const broken = await data<ApiRow>(await patch(pa, rowId, { totalCents: 300_000_000 }));
    expect(broken.confidence.flags).toContain('arith_ppn');
    expect(broken.status).toBe('perlu_cek');
  });

  it('near_duplicate is sticky: corrections do not clear it (it cannot be re-derived)', async () => {
    const { rowId } = await seedRow({ status: 'perlu_cek', flags: ['near_duplicate'] });
    const row = await data<ApiRow>(await patch(pa, rowId, { docNumber: 'NT-001' }));
    expect(row.confidence.flags).toContain('near_duplicate');
    expect(row.status).toBe('perlu_cek');
    expect(row.docNumber).toBe('NT-001');
  });

  it('invoiceDate in DD/MM/YYYY is stored as ISO and V7 is recomputed', async () => {
    const { rowId } = await seedRow({ invoiceDate: '2025-12-01', status: 'perlu_cek', flags: ['date_range'] });
    const row = await data<ApiRow>(await patch(pa, rowId, { invoiceDate: '21/10/2026' }));
    expect(row.invoiceDate).toBe('2026-10-21');
    expect(row.confidence.flags ?? []).not.toContain('date_range');
    expect(row.status).toBe('perlu_konfirmasi');
  });

  it('V7 boundaries: site start − 30 d and today + 1 d are inside, one day beyond either is date_range', async () => {
    const { rowId } = await seedRow();
    const flagsFor = async (d: string) => (await data<ApiRow>(await patch(pa, rowId, { invoiceDate: d }))).confidence.flags ?? [];
    expect(await flagsFor('30/01/2026')).not.toContain('date_range');
    expect(await flagsFor('29/01/2026')).toContain('date_range');
    expect(await flagsFor('28/10/2026')).not.toContain('date_range');
    expect(await flagsFor('29/10/2026')).toContain('date_range');
  });

  it('vendorName unknown to the company creates a draft vendor and links it; field_kosong clears', async () => {
    const { rowId } = await seedRow({ vendorId: null, vendorName: null, category: 'material', status: 'perlu_cek', flags: ['field_kosong'] });
    const res = await patch(pa, rowId, { vendorName: '  CV Karya   Baru Abadi ' });
    expect(res.status).toBe(200);
    const row = await data<ApiRow>(res);
    expect(row.vendorName).toBe('CV Karya Baru Abadi');
    expect(row.vendorId).toEqual(expect.any(Number));
    expect(row.confidence.flags ?? []).not.toContain('field_kosong');
    expect(row.status).toBe('perlu_konfirmasi');
    const [v] = await withCompany(db, A, (tx) => tx.select().from(vendors).where(eq(vendors.id, row.vendorId!)));
    expect(v).toMatchObject({ companyId: A, name: 'CV Karya Baru Abadi', status: 'draft', defaultCategory: null });

    // the same name again reuses the draft (no second vendor)
    const second = await seedRow({ vendorId: null, vendorName: null, flags: ['field_kosong'], status: 'perlu_cek' });
    const again = await data<ApiRow>(await patch(pa, second.rowId, { vendorName: 'CV Karya Baru Abadi' }));
    expect(again.vendorId).toBe(row.vendorId);
    const drafts = await withCompany(db, A, (tx) => tx.select().from(vendors).where(eq(vendors.name, 'CV Karya Baru Abadi')));
    expect(drafts).toHaveLength(1);
  });

  it('vendorName matching an existing vendor (V10) links it and takes its default category only when the row has none', async () => {
    const noCat = await seedRow({ vendorId: null, vendorName: null, category: null, flags: ['field_kosong', 'kategori_kosong'], status: 'perlu_cek' });
    const row = await data<ApiRow>(await patch(pa, noCat.rowId, { vendorName: 'TOKO SINAR JAYA' }));
    expect(row).toMatchObject({ vendorId: vSinar, vendorName: 'Toko Sinar Jaya', category: 'material', status: 'perlu_konfirmasi' });
    expect(row.confidence.flags ?? []).toEqual([]);

    const withCat = await seedRow({ vendorId: null, vendorName: null, category: 'alat', flags: ['field_kosong'], status: 'perlu_cek' });
    const kept = await data<ApiRow>(await patch(pa, withCat.rowId, { vendorName: 'toko sinar jaya' }));
    expect(kept).toMatchObject({ vendorId: vSinar, category: 'alat' });
  });

  it('vendorName equal to a vendor of ANOTHER company creates a draft in this company, never links across', async () => {
    const { rowId } = await seedRow({ vendorId: null, vendorName: null, flags: ['field_kosong'], status: 'perlu_cek' });
    const row = await data<ApiRow>(await patch(pa, rowId, { vendorName: 'UD Maju Bersama' }));
    expect(row.vendorId).not.toBe(vB);
    const [v] = await withCompany(db, A, (tx) => tx.select().from(vendors).where(eq(vendors.id, row.vendorId!)));
    expect(v).toMatchObject({ companyId: A, status: 'draft' });
  });

  it('vendorId of this company links the vendor; a vendorId of another company is 404 and the row is unchanged', async () => {
    const { rowId } = await seedRow({ vendorId: null, vendorName: 'tulisan tangan', category: null, flags: ['kategori_kosong'] });
    const linked = await data<ApiRow>(await patch(pa, rowId, { vendorId: vAlat }));
    expect(linked).toMatchObject({ vendorId: vAlat, vendorName: 'CV Sewa Alat Mandiri', category: 'alat' });

    const other = await seedRow({ vendorId: null, vendorName: 'x' });
    expect((await patch(pa, other.rowId, { vendorId: vB })).status).toBe(404);
    expect((await dbRow(A, other.rowId))[0]!.vendorId).toBeNull();
  });

  it('every correction is audited with the acting user and before/after', async () => {
    const seeded = await seedRow({ category: 'material' });
    expect((await patch(pa, seeded.rowId, { category: 'subkon' })).status).toBe(200);
    const logs = await withCompany(db, A, (tx) => tx.select().from(auditLogs).where(and(
      eq(auditLogs.auditableType, 'vendor_invoices'), eq(auditLogs.auditableId, seeded.id), eq(auditLogs.action, 'update'),
    )));
    expect(logs).toHaveLength(1);
    expect(logs[0]!.userId).toBe(pa);
    expect((logs[0]!.before as { category: string }).category).toBe('material');
    expect((logs[0]!.after as { category: string }).category).toBe('subkon');
  });

  it('invalid bodies are 400 and change nothing', async () => {
    const { rowId } = await seedRow({ totalCents: 1_000_000_00, invoiceDate: '2026-10-20', category: 'material' });
    for (const body of [
      {}, { category: 'semen' }, { totalCents: 0 }, { totalCents: -5 }, { totalCents: 12.5 }, { totalCents: 'Rp 0' },
      { totalCents: 'dua juta' }, { totalCents: '' }, { invoiceDate: '31/02/2026' }, { invoiceDate: '21/10/26' },
      { vendorName: 'x' }, { status: 'perlu_cek' }, { docNumber: '' },
    ]) {
      const res = await patch(pa, rowId, body);
      expect(res.status, JSON.stringify(body)).toBe(400);
    }
    expect((await dbRow(A, rowId))[0]).toMatchObject({ totalCents: 1_000_000_00, invoiceDate: '2026-10-20', category: 'material', docNumber: null });
  });

  it('a non-uuid rowId is 400; an unknown rowId is 404', async () => {
    expect((await patch(pa, 'not-a-uuid', { category: 'alat' })).status).toBe(400);
    expect((await patch(pa, '1234', { category: 'alat' })).status).toBe(400);
    expect((await patch(pa, randomUUID(), { category: 'alat' })).status).toBe(404);
  });

  it('site_staff and finance cannot PATCH (403); a scoped project_admin gets 404 for another site; another company 404', async () => {
    const onS2 = await seedRow({ siteId: s2, category: 'material' });
    expect((await patch(staff, onS2.rowId, { category: 'alat' })).status).toBe(403);
    expect((await patch(fin, onS2.rowId, { category: 'alat' })).status).toBe(403);
    expect((await patch(paS1, onS2.rowId, { category: 'alat' })).status).toBe(404);
    // B's admin, through B's path, cannot reach A's row (RLS), and A's path is 403 for him
    expect((await patch(bob, onS2.rowId, { category: 'alat' }, B)).status).toBe(404);
    expect((await patch(bob, onS2.rowId, { category: 'alat' })).status).toBe(403);
    expect((await dbRow(A, onS2.rowId))[0]!.category).toBe('material');
    // the scoped admin can still correct a row on their own site
    const onS1 = await seedRow({ siteId: s1, category: 'material' });
    expect((await patch(paS1, onS1.rowId, { category: 'alat' })).status).toBe(200);
  });

  it('the PATCH response hides the internal id/companyId and the receipt NPWP for project_admin', async () => {
    const { rowId } = await seedRow({ npwp: NPWP });
    const row = await data<Record<string, unknown>>(await patch(pa, rowId, { docNumber: 'INV-77' }));
    expect(row).not.toHaveProperty('id');
    expect(row).not.toHaveProperty('companyId');
    expect(row['rowId']).toBe(rowId);
    expect(row['npwp']).toBeNull();
  });
});

// ---------------------------------------------------------------------------------------------
describe('PATCH /companies/:id/intake/:rowId — confirm and reject', () => {
  it('admin may confirm with arith_ppn and near_duplicate open (has seen photo and candidates)', async () => {
    const { rowId, id } = await seedRow({
      vendorId: vSinar, invoiceDate: '2026-10-21', totalCents: 2_450_000_00, dppCents: 2_000_000_00, ppnCents: 220_000_00,
      status: 'perlu_cek', flags: ['arith_ppn', 'near_duplicate'],
    });
    const res = await patch(pa, rowId, { status: 'terkonfirmasi' });
    expect(res.status).toBe(200);
    const row = await data<ApiRow>(res);
    expect(row.status).toBe('terkonfirmasi');
    expect(row.confirmedBy).toBe(pa);
    expect(row.confirmedAt).not.toBeNull();
    expect(row.confidence.flags).toEqual(expect.arrayContaining(['arith_ppn', 'near_duplicate']));
    const [stored] = await dbRow(A, rowId);
    expect(stored).toMatchObject({ id, status: 'terkonfirmasi', confirmedBy: pa });
    // a confirmed row leaves the default review list
    expect((await listReview(mgr, '?limit=200')).rows.map((r) => r.rowId)).not.toContain(rowId);
  });

  it('confirm without a category is 409 confirm_blocked with the blocking flags; the row stays open', async () => {
    const { rowId } = await seedRow({ category: null, flags: ['kategori_kosong'], totalCents: 3_100_000_00 });
    const res = await patch(pa, rowId, { status: 'terkonfirmasi' });
    expect(res.status).toBe(409);
    const body = (await res.json()) as { error: string; flags: string[] };
    expect(body.error).toBe('confirm_blocked');
    expect(body.flags).toEqual(['kategori_kosong']);
    expect((await dbRow(A, rowId))[0]).toMatchObject({ status: 'perlu_konfirmasi', confirmedAt: null, confirmedBy: null });
  });

  it('confirm without a vendor is 409 confirm_blocked with field_kosong', async () => {
    const { rowId } = await seedRow({ vendorId: null, vendorName: null, status: 'perlu_cek', flags: ['field_kosong'], totalCents: 3_200_000_00 });
    const res = await patch(pa, rowId, { status: 'terkonfirmasi' });
    expect(res.status).toBe(409);
    const body = (await res.json()) as { error: string; flags: string[] };
    expect(body.error).toBe('confirm_blocked');
    expect(body.flags).toContain('field_kosong');
    expect((await dbRow(A, rowId))[0]!.status).toBe('perlu_cek');
  });

  it('confirm without an invoice date is 409 confirm_blocked with field_kosong', async () => {
    const { rowId } = await seedRow({ invoiceDate: null, status: 'perlu_cek', flags: ['field_kosong'], totalCents: 3_300_000_00 });
    const res = await patch(pa, rowId, { status: 'terkonfirmasi' });
    expect(res.status).toBe(409);
    expect(((await res.json()) as { flags: string[] }).flags).toContain('field_kosong');
  });

  it('a PATCH answered 409 changes nothing: no draft vendor is left behind by a blocked confirm', async () => {
    const { rowId } = await seedRow({ vendorId: null, vendorName: null, category: null, status: 'perlu_cek', flags: ['field_kosong', 'kategori_kosong'], totalCents: 3_350_000_00 });
    const res = await patch(pa, rowId, { vendorName: 'CV Tidak Pernah Ada', status: 'terkonfirmasi' });
    expect(res.status).toBe(409);
    expect(((await res.json()) as { flags: string[] }).flags).toEqual(['kategori_kosong']);
    expect((await dbRow(A, rowId))[0]).toMatchObject({ vendorId: null, vendorName: null, status: 'perlu_cek' });
    const leftovers = await withCompany(db, A, (tx) => tx.select().from(vendors).where(eq(vendors.name, 'CV Tidak Pernah Ada')));
    expect(leftovers).toEqual([]);
  });

  it('filling the missing category and confirming in one PATCH succeeds', async () => {
    const { rowId } = await seedRow({ category: null, flags: ['kategori_kosong'], totalCents: 3_400_000_00 });
    const res = await patch(pa, rowId, { category: 'operasional', status: 'terkonfirmasi' });
    expect(res.status).toBe(200);
    expect(await data<ApiRow>(res)).toMatchObject({ category: 'operasional', status: 'terkonfirmasi' });
  });

  it('a row known only by vendor name is linked to a master vendor when confirmed', async () => {
    const { rowId } = await seedRow({ vendorId: null, vendorName: 'Toko Sinar Jaya', totalCents: 3_500_000_00 });
    const row = await data<ApiRow>(await patch(pa, rowId, { status: 'terkonfirmasi' }));
    expect(row).toMatchObject({ status: 'terkonfirmasi', vendorId: vSinar });
  });

  it('confirming a second row with the same vendor + date + total is 409 duplicate_confirmed; the second row stays open', async () => {
    const first = await seedRow({ vendorId: vSinar, invoiceDate: '2026-10-15', totalCents: 4_000_000_00 });
    const second = await seedRow({ vendorId: vSinar, invoiceDate: '2026-10-15', totalCents: 4_000_000_00 });
    expect((await patch(pa, first.rowId, { status: 'terkonfirmasi' })).status).toBe(200);
    const res = await patch(pa, second.rowId, { status: 'terkonfirmasi' });
    expect(res.status).toBe(409);
    expect(((await res.json()) as { error: string }).error).toBe('duplicate_confirmed');
    expect((await dbRow(A, second.rowId))[0]!.status).toBe('perlu_konfirmasi');
    // a different total is a different invoice
    const third = await seedRow({ vendorId: vSinar, invoiceDate: '2026-10-15', totalCents: 4_000_000_01 });
    expect((await patch(pa, third.rowId, { status: 'terkonfirmasi' })).status).toBe(200);
  });

  it('a status change on a terkonfirmasi row is 409 closed (neither re-confirm nor reject)', async () => {
    const { rowId } = await seedRow({ totalCents: 5_000_000_00 });
    expect((await patch(pa, rowId, { status: 'terkonfirmasi' })).status).toBe(200);
    for (const status of ['ditolak', 'terkonfirmasi']) {
      const res = await patch(pa, rowId, { status });
      expect(res.status).toBe(409);
      expect(((await res.json()) as { error: string }).error).toBe('closed');
    }
    expect((await dbRow(A, rowId))[0]!.status).toBe('terkonfirmasi');
  });

  it('the review screen may still fix data on a confirmed row; it stays terkonfirmasi', async () => {
    const { rowId } = await seedRow({ totalCents: 5_100_000_00 });
    expect((await patch(pa, rowId, { status: 'terkonfirmasi' })).status).toBe(200);
    const res = await patch(pa, rowId, { docNumber: 'FKT-2026-001' });
    expect(res.status).toBe(200);
    expect(await data<ApiRow>(res)).toMatchObject({ docNumber: 'FKT-2026-001', status: 'terkonfirmasi' });
  });

  it('reject: ditolak leaves the default list, appears under ?status=ditolak, and can no longer be confirmed', async () => {
    const { rowId } = await seedRow({ totalCents: 5_200_000_00 });
    const res = await patch(pa, rowId, { status: 'ditolak' });
    expect(res.status).toBe(200);
    expect((await data<ApiRow>(res)).status).toBe('ditolak');
    expect((await listReview(mgr, '?limit=200')).rows.map((r) => r.rowId)).not.toContain(rowId);
    expect((await listReview(mgr, '?status=ditolak&limit=200')).rows.map((r) => r.rowId)).toContain(rowId);
    const again = await patch(pa, rowId, { status: 'terkonfirmasi' });
    expect(again.status).toBe(409);
    expect(((await again.json()) as { error: string }).error).toBe('closed');
  });
});

// ---------------------------------------------------------------------------------------------
describe('GET /companies/:id/intake/:rowId/photo', () => {
  it('returns the stored bytes with the stored mime type, private and nosniff', async () => {
    const bytes = randomBytes(256);
    const { rowId, path } = await seedRow({ photo: { bytes, mime: 'image/png' } });
    const res = await app.request(`/companies/${A}/intake/${rowId}/photo`, { headers: as(pa) });
    expect(res.status).toBe(200);
    expect(res.headers.get('content-type')).toBe('image/png');
    expect(res.headers.get('x-content-type-options')).toBe('nosniff');
    expect(res.headers.get('cache-control')).toMatch(/private/);
    expect(Buffer.from(await res.arrayBuffer()).equals(bytes)).toBe(true);
    expect(storage.reads.at(-1)).toBe(path);
  });

  it('a JPEG row answers image/jpeg; finance may view the photo too', async () => {
    const bytes = randomBytes(32);
    const { rowId } = await seedRow({ photo: { bytes, mime: 'image/jpeg' } });
    const res = await app.request(`/companies/${A}/intake/${rowId}/photo`, { headers: as(fin) });
    expect(res.status).toBe(200);
    expect(res.headers.get('content-type')).toBe('image/jpeg');
    expect(Buffer.from(await res.arrayBuffer()).equals(bytes)).toBe(true);
  });

  it('another company\'s row is 404 through that company\'s path (RLS), 403 through ours', async () => {
    const { rowId } = await seedRow();
    const reads = storage.reads.length;
    expect((await app.request(`/companies/${B}/intake/${rowId}/photo`, { headers: as(bob) })).status).toBe(404);
    expect((await app.request(`/companies/${A}/intake/${rowId}/photo`, { headers: as(bob) })).status).toBe(403);
    expect(storage.reads.length).toBe(reads); // storage never touched
  });

  it('a scoped project_admin gets 404 for a photo on another site; site_staff 403', async () => {
    const { rowId } = await seedRow({ siteId: s2 });
    expect((await app.request(`/companies/${A}/intake/${rowId}/photo`, { headers: as(paS1) })).status).toBe(404);
    expect((await app.request(`/companies/${A}/intake/${rowId}/photo`, { headers: as(staff) })).status).toBe(403);
  });

  it('a row without an attachment, an unknown rowId → 404; a malformed rowId → 400', async () => {
    const { rowId } = await seedRow({ photo: null });
    expect((await app.request(`/companies/${A}/intake/${rowId}/photo`, { headers: as(pa) })).status).toBe(404);
    expect((await app.request(`/companies/${A}/intake/${randomUUID()}/photo`, { headers: as(pa) })).status).toBe(404);
    expect((await app.request(`/companies/${A}/intake/xyz/photo`, { headers: as(pa) })).status).toBe(400);
  });

  it('without configured storage the endpoint answers 503', async () => {
    const { rowId } = await seedRow();
    expect((await appNoStorage.request(`/companies/${A}/intake/${rowId}/photo`, { headers: as(pa) })).status).toBe(503);
  });
});

// ---------------------------------------------------------------------------------------------
describe('vendors API: bank account and NPWP only for finance and managers', () => {
  type VendorApi = { id: number; name: string; npwp: string | null; bankName: string | null; bankAccount: string | null; status: string };
  const list = async (userId: number, companyId = A) => {
    const res = await app.request(`/companies/${companyId}/vendors`, { headers: as(userId) });
    return { status: res.status, rows: res.status === 200 ? await data<VendorApi[]>(res) : [] };
  };

  it('project_admin and site_staff see null bank account / bank name / NPWP', async () => {
    for (const who of [pa, staff]) {
      const { status, rows } = await list(who);
      expect(status).toBe(200);
      const v = rows.find((r) => r.id === vSinar)!;
      expect(v).toMatchObject({ name: 'Toko Sinar Jaya', npwp: null, bankName: null, bankAccount: null });
    }
  });

  it('finance and company_manager see them', async () => {
    for (const who of [fin, mgr]) {
      const v = (await list(who)).rows.find((r) => r.id === vSinar)!;
      expect(v).toMatchObject({ npwp: NPWP, bankName: 'BRI', bankAccount: BANK_ACCOUNT });
    }
  });

  it('lists only the caller\'s company vendors', async () => {
    const a = (await list(mgr)).rows.map((r) => r.id);
    expect(a).toContain(vSinar);
    expect(a).not.toContain(vB);
    const b = (await list(bob, B)).rows.map((r) => r.id);
    expect(b).toContain(vB);
    expect(b).not.toContain(vSinar);
  });

  it('project_admin may not write bank data or NPWP it cannot see (403, nothing written); without them the vendor is created', async () => {
    const pii = { npwp: '1234567890123456', bankName: 'Mandiri', bankAccount: '987654321' };
    for (const [field, value] of Object.entries(pii)) {
      const res = await app.request(`/companies/${A}/vendors`, send(pa, 'POST', { name: 'PT Beton Prima', [field]: value }));
      expect(res.status, field).toBe(403);
    }
    expect((await list(fin)).rows.some((r) => r.name === 'PT Beton Prima')).toBe(false);
    const res = await app.request(`/companies/${A}/vendors`, send(pa, 'POST', { name: 'PT Beton Prima', defaultCategory: 'material' }));
    expect(res.status).toBe(201);
    expect(await data<VendorApi>(res)).toMatchObject({ name: 'PT Beton Prima', npwp: null, bankAccount: null, status: 'active' });
  });

  it('PATCH of bank data: project_admin 403 and unchanged; finance may correct it and sees the change', async () => {
    const before = (await list(fin)).rows.find((r) => r.id === vAlat)!;
    expect((await app.request(`/companies/${A}/vendors/${vAlat}`, send(pa, 'PATCH', { bankAccount: '555-000-111', bankName: 'BNI' }))).status).toBe(403);
    expect((await list(fin)).rows.find((r) => r.id === vAlat)).toMatchObject({ bankAccount: before.bankAccount, bankName: before.bankName });
    const res = await app.request(`/companies/${A}/vendors/${vAlat}`, send(fin, 'PATCH', { bankAccount: '555-000-111', bankName: 'BNI' }));
    expect(res.status).toBe(200);
    expect(await data<VendorApi>(res)).toMatchObject({ bankAccount: '555-000-111', bankName: 'BNI' });
    // project_admin still manages the non-sensitive fields
    expect((await app.request(`/companies/${A}/vendors/${vAlat}`, send(pa, 'PATCH', { phone: '0812 3456 789' }))).status).toBe(200);
  });

  it('names are trimmed and collapsed like vendorForName; blank names 400; a 31-character phone 400', async () => {
    expect((await app.request(`/companies/${A}/vendors`, send(pa, 'POST', { name: '   ' }))).status).toBe(400);
    expect((await app.request(`/companies/${A}/vendors`, send(pa, 'POST', { name: ' Toko  Sinar   Jaya ' }))).status).toBe(409);
    expect((await app.request(`/companies/${A}/vendors`, send(pa, 'POST', { name: 'Toko Telepon', phone: `+${'1'.repeat(30)}` }))).status).toBe(400);
    const ok = await app.request(`/companies/${A}/vendors`, send(pa, 'POST', { name: 'Toko Telepon', phone: `+${'1'.repeat(29)}` }));
    expect(ok.status).toBe(201);
  });

  it('invalid NPWP / bank account, duplicate name → 400/409; site_staff cannot create (403)', async () => {
    expect((await app.request(`/companies/${A}/vendors`, send(pa, 'POST', { name: 'Toko X', npwp: '12345678901234' }))).status).toBe(400);
    expect((await app.request(`/companies/${A}/vendors`, send(pa, 'POST', { name: 'Toko Y', bankAccount: '12ab' }))).status).toBe(400);
    expect((await app.request(`/companies/${A}/vendors`, send(pa, 'POST', { name: 'Toko Sinar Jaya' }))).status).toBe(409);
    expect((await app.request(`/companies/${A}/vendors`, send(staff, 'POST', { name: 'Toko Z' }))).status).toBe(403);
  });

  it('PATCH of another company\'s vendor is 404 and leaves it untouched', async () => {
    expect((await app.request(`/companies/${A}/vendors/${vB}`, send(mgr, 'PATCH', { name: 'Diambil Alih' }))).status).toBe(404);
    expect((await list(bob, B)).rows.find((r) => r.id === vB)!.name).toBe('UD Maju Bersama');
  });
});

// ---------------------------------------------------------------------------------------------
describe('admin: Telegram chat → company + site mapping', () => {
  type ChatApi = { id: number; chatId: number; companyId: number; siteId: number; title: string | null; isActive: boolean };
  const CHAT = -1001234567890;
  let chatRow = 0;
  const listChats = async () => data<ChatApi[]>(await app.request('/admin/telegram-chats', { headers: as(admin) }));

  it('the system admin maps a group to a site of that company (201) and it is listed', async () => {
    const res = await app.request('/admin/telegram-chats', send(admin, 'POST', { chatId: CHAT, companyId: A, siteId: s1, title: 'Nota Keerom' }));
    expect(res.status).toBe(201);
    const row = await data<ChatApi>(res);
    expect(row).toMatchObject({ chatId: CHAT, companyId: A, siteId: s1, title: 'Nota Keerom', isActive: true });
    chatRow = row.id;
    expect((await listChats()).map((c) => c.chatId)).toContain(CHAT);
  });

  it('a site of another company is 404 and nothing is stored', async () => {
    const chatId = -1001234567891;
    const res = await app.request('/admin/telegram-chats', send(admin, 'POST', { chatId, companyId: A, siteId: sB }));
    expect(res.status).toBe(404);
    expect((await listChats()).map((c) => c.chatId)).not.toContain(chatId);
    // the same site under its own company is fine
    expect((await app.request('/admin/telegram-chats', send(admin, 'POST', { chatId, companyId: B, siteId: sB }))).status).toBe(201);
  });

  it('an unknown company is 404', async () => {
    expect((await app.request('/admin/telegram-chats', send(admin, 'POST', { chatId: -1001234567892, companyId: 999_999, siteId: s1 }))).status).toBe(404);
  });

  it('the same chat id twice is 409; chatId 0, a fractional id or a missing siteId are 400', async () => {
    expect((await app.request('/admin/telegram-chats', send(admin, 'POST', { chatId: CHAT, companyId: A, siteId: s2 }))).status).toBe(409);
    expect((await app.request('/admin/telegram-chats', send(admin, 'POST', { chatId: 0, companyId: A, siteId: s1 }))).status).toBe(400);
    expect((await app.request('/admin/telegram-chats', send(admin, 'POST', { chatId: -1.5, companyId: A, siteId: s1 }))).status).toBe(400);
    expect((await app.request('/admin/telegram-chats', send(admin, 'POST', { chatId: -100123, companyId: A }))).status).toBe(400);
  });

  it('PATCH moves the group to another site of the same company, renames, deactivates', async () => {
    const res = await app.request(`/admin/telegram-chats/${chatRow}`, send(admin, 'PATCH', { siteId: s2, title: null, isActive: false }));
    expect(res.status).toBe(200);
    expect(await data<ChatApi>(res)).toMatchObject({ id: chatRow, chatId: CHAT, companyId: A, siteId: s2, title: null, isActive: false });
  });

  it('PATCH to a site of another company is 404 and the mapping is unchanged', async () => {
    const res = await app.request(`/admin/telegram-chats/${chatRow}`, send(admin, 'PATCH', { siteId: sB }));
    expect(res.status).toBe(404);
    const [stored] = await withApp(db, (tx) => tx.select().from(telegramChats).where(eq(telegramChats.id, chatRow)));
    expect(stored).toMatchObject({ companyId: A, siteId: s2 });
  });

  it('PATCH of an unknown mapping is 404; an empty body is 400', async () => {
    expect((await app.request('/admin/telegram-chats/999999', send(admin, 'PATCH', { isActive: true }))).status).toBe(404);
    expect((await app.request(`/admin/telegram-chats/${chatRow}`, send(admin, 'PATCH', {}))).status).toBe(400);
  });

  it('non-admins (manager, project_admin, finance) get 403 on list, create and patch', async () => {
    for (const who of [mgr, pa, fin]) {
      expect((await app.request('/admin/telegram-chats', { headers: as(who) })).status).toBe(403);
      expect((await app.request('/admin/telegram-chats', send(who, 'POST', { chatId: -1001234567899, companyId: A, siteId: s1 }))).status).toBe(403);
      expect((await app.request(`/admin/telegram-chats/${chatRow}`, send(who, 'PATCH', { isActive: true }))).status).toBe(403);
    }
    expect((await app.request('/admin/telegram-chats')).status).toBe(401);
    const [stored] = await withApp(db, (tx) => tx.select().from(telegramChats).where(eq(telegramChats.id, chatRow)));
    expect(stored!.isActive).toBe(false);
  });
});
