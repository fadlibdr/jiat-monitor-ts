import { mkdtemp, rm, utimes, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { eq, sql } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  attachments, companies, companyUsers, contracts, contractTerms, dailyDigests, intakeEvents, jobs, salesInvoices, sites, users, vendorInvoices,
} from '../../src/db/schema.js';
import { isSerializationFailure, withApp, withCompany, type Db } from '../../src/db/tenant.js';
import { LocalDiskStorage } from '../../src/intake/storage.js';
import { RecipientUnreachableError, TelegramError, type TelegramApi } from '../../src/intake/telegram-api.js';
import type { Job } from '../../src/jobs/queue.js';
import { currentSlot, enqueueDue, wibDate, type Schedule } from '../../src/jobs/schedule.js';
import { sendCompanyDigest } from '../../src/ops/digest.js';
import { purgeOldJobs, purgeOrphanPhotos } from '../../src/ops/purge.js';
import { JOB_DAILY_DIGEST, JOB_DASHBOARD_REFRESH, opsRegistry, slotDate } from '../../src/ops/registry.js';
import { refreshAll } from '../../src/dashboard/snapshot.js';
import { asOwner, createTestDb } from '../helpers/db.js';

const at = (iso: string) => new Date(iso);

describe('currentSlot (WIB = UTC+7, no daylight saving)', () => {
  const refresh: Schedule = { kind: 'dashboard.refresh', everyMinutes: 15 };
  const digest: Schedule = { kind: 'ops.daily_digest', dailyAtWib: '07:00' };

  it('interval jobs: the slot is the start of the current N-minute window', () => {
    expect(currentSlot(refresh, at('2026-10-27T07:29:59.999Z'))).toBe('dashboard.refresh@2026-10-27T07:15:00.000Z');
    expect(currentSlot(refresh, at('2026-10-27T07:30:00.000Z'))).toBe('dashboard.refresh@2026-10-27T07:30:00.000Z');
  });

  it('daily jobs: null before the WIB time, then the WIB date until midnight WIB', () => {
    expect(currentSlot(digest, at('2026-10-26T23:59:59Z'))).toBeNull(); // 06:59 WIB on the 27th
    expect(currentSlot(digest, at('2026-10-27T00:00:00Z'))).toBe('ops.daily_digest@2026-10-27'); // 07:00 WIB
    expect(currentSlot(digest, at('2026-10-27T16:59:59Z'))).toBe('ops.daily_digest@2026-10-27'); // 23:59 WIB
    expect(currentSlot(digest, at('2026-10-27T17:00:00Z'))).toBeNull(); // 00:00 WIB on the 28th
    expect(wibDate(at('2026-10-27T17:00:00Z'))).toBe('2026-10-28');
  });

  it('refuses malformed schedules', () => {
    expect(() => currentSlot({ kind: 'x', everyMinutes: 0 }, new Date(0))).toThrow(RangeError);
    expect(() => currentSlot({ kind: 'x', dailyAtWib: '7:00' }, new Date(0))).toThrow(RangeError);
    expect(() => currentSlot({ kind: 'x', dailyAtWib: '24:00' }, new Date(0))).toThrow(RangeError);
  });
});

let db: Db;
let close: () => Promise<void>;
let A = 0; let s1 = 0; let K = 0;
let dir = '';

beforeAll(async () => {
  ({ db, close } = await createTestDb());
  dir = await mkdtemp(join(tmpdir(), 'jiat-purge-'));
  await withApp(db, async (tx) => {
    const [c] = await tx.insert(companies).values({ code: 'AAA', name: 'PT AAA' }).returning({ id: companies.id });
    A = c!.id;
    const us = await tx.insert(users).values([
      { email: 'mgr@a.test', name: 'Manager', telegramUserId: 111 },
      { email: 'adm@a.test', name: 'Admin', telegramUserId: 222 },
      { email: 'fin@a.test', name: 'Finance', telegramUserId: 333 },
      { email: 'old@a.test', name: 'Inactive admin', telegramUserId: 444, isActive: false },
      { email: 'nolink@a.test', name: 'Admin without Telegram' },
    ]).returning({ id: users.id });
    await tx.insert(companyUsers).values([
      { userId: us[0]!.id, companyId: A, role: 'company_manager' },
      { userId: us[1]!.id, companyId: A, role: 'project_admin' },
      { userId: us[2]!.id, companyId: A, role: 'finance' },
      { userId: us[3]!.id, companyId: A, role: 'project_admin' },
      { userId: us[4]!.id, companyId: A, role: 'project_admin' },
    ]);
  });
  await withCompany(db, A, async (tx) => {
    const [s] = await tx.insert(sites).values({ companyId: A, code: 'KRM', name: 'JIAT Keerom' }).returning({ id: sites.id });
    s1 = s!.id;
    const [k] = await tx.insert(contracts).values({ companyId: A, siteId: s1, number: 'HK-KRM', employerName: 'BWS Papua', valueDppCents: 100_000_00, endDate: '2026-11-10', status: 'active' }).returning({ id: contracts.id });
    K = k!.id;
  });
});
afterAll(async () => {
  await close();
  await rm(dir, { recursive: true, force: true });
});

describe('enqueueDue', () => {
  it('enqueues each slot once, however many workers tick', async () => {
    const schedules: Schedule[] = [{ kind: 'dashboard.refresh', everyMinutes: 15 }, { kind: 'ops.daily_digest', dailyAtWib: '07:00' }];
    const now = at('2026-10-27T00:05:00Z'); // 07:05 WIB
    const ticks = await Promise.all([enqueueDue(db, schedules, now), enqueueDue(db, schedules, now)]);
    expect(ticks.flat().sort()).toEqual(['dashboard.refresh@2026-10-27T00:00:00.000Z', 'ops.daily_digest@2026-10-27']);
    expect(await enqueueDue(db, schedules, at('2026-10-27T00:14:00Z'))).toEqual([]);
    expect(await enqueueDue(db, schedules, at('2026-10-27T00:15:00Z'))).toEqual(['dashboard.refresh@2026-10-27T00:15:00.000Z']);
    const rows = await withApp(db, (tx) => tx.select({ key: jobs.dedupeKey, companyId: jobs.companyId }).from(jobs));
    expect(rows).toHaveLength(3);
    expect(rows.every((r) => r.companyId === null)).toBe(true);
  });
});

class FakeTelegram implements TelegramApi {
  sent: Array<{ chatId: number; text: string }> = [];
  /** 403: blocked or never started — permanent */
  failFor = new Set<number>();
  /** network error / 429 / 5xx — worth a retry */
  flakyFor = new Set<number>();
  async getFile(): Promise<never> { throw new Error('unused'); }
  async downloadFile(): Promise<never> { throw new Error('unused'); }
  async sendMessage(chatId: number, text: string) {
    if (this.failFor.has(chatId)) throw new RecipientUnreachableError('sendMessage: Forbidden: bot was blocked by the user');
    if (this.flakyFor.has(chatId)) throw new TelegramError('sendMessage: Too Many Requests: retry after 5');
    this.sent.push({ chatId, text });
    return { messageId: this.sent.length };
  }
}

describe('DailyDigest', () => {
  const now = at('2026-10-27T00:00:00Z'); // 07:00 WIB
  const log = () => {};

  beforeAll(async () => {
    await withCompany(db, A, async (tx) => {
      const [t] = await tx.insert(contractTerms).values({ companyId: A, contractId: K, seq: 1, name: 'Termin 1', percentBp: 3000, triggerProgressBp: 0 }).returning({ id: contractTerms.id });
      await tx.insert(salesInvoices).values({
        companyId: A, siteId: s1, contractId: K, termId: t!.id, number: 'INV/KRM/2026/001', invoiceDate: '2026-10-20', dueDate: '2026-11-03',
        progressMicroPct: 0, dppCents: 3_000_000, advanceDeductionCents: 0, retentionCents: 0, ppnCents: 330_000, totalCents: 3_330_000,
      });
      await tx.insert(vendorInvoices).values([
        { companyId: A, siteId: s1, totalCents: 1000, status: 'perlu_cek', source: 'manual' },
        { companyId: A, siteId: s1, totalCents: 2000, status: 'perlu_cek', source: 'manual' },
        { companyId: A, siteId: s1, totalCents: 3000, status: 'perlu_konfirmasi', source: 'manual' },
      ]);
      const ev = (messageId: number, outcome: 'gagal' | 'ocr_error' | 'tidak_terbaca', createdAt: Date) =>
        ({ companyId: A, siteId: s1, chatId: -100, messageId, kind: 'photo' as const, payload: {}, outcome, createdAt });
      await tx.insert(intakeEvents).values([
        ev(1, 'gagal', at('2026-10-26T12:00:00Z')), ev(2, 'ocr_error', at('2026-10-26T20:00:00Z')),
        ev(3, 'tidak_terbaca', at('2026-10-26T21:00:00Z')), ev(4, 'gagal', at('2026-10-25T12:00:00Z')),
      ]);
    });
  });

  it('managers get every new alert, project admins not the money ones; finance, inactive and unlinked users get nothing', async () => {
    const tg = new FakeTelegram();
    expect(await sendCompanyDigest({ db, telegram: tg, log }, A, now)).toBe('sent');
    expect(tg.sent.map((m) => m.chatId).sort()).toEqual([111, 222]);
    const mgr = tg.sent.find((m) => m.chatId === 111)!.text;
    const adm = tg.sent.find((m) => m.chatId === 222)!.text;
    expect(mgr).toContain('Ringkasan harian PT AAA — 2026-10-27');
    expect(mgr).toContain('Nota perlu cek: 2 · perlu konfirmasi: 1');
    expect(mgr).toContain('Intake 24 jam: 2 gagal diproses, 1 foto tidak terbaca');
    expect(mgr).toMatch(/Termin jatuh tempo: HK-KRM · Termin 1 \(INV\/KRM\/2026\/001\) jatuh tempo dalam 7 hari, sisa Rp/);
    expect(mgr).toContain('Kontrak mendekati batas: HK-KRM · sisa 14 hari, progres 0,0%');
    expect(adm).not.toContain('Termin jatuh tempo');
    expect(adm).toContain('Kontrak mendekati batas');
    expect(adm).toContain('aktif 1');
  });

  it('runs once per WIB day; the next day only NEW alerts are listed', async () => {
    const tg = new FakeTelegram();
    expect(await sendCompanyDigest({ db, telegram: tg, log }, A, at('2026-10-27T05:00:00Z'))).toBe('already_sent');
    expect(tg.sent).toEqual([]);
    expect(await sendCompanyDigest({ db, telegram: tg, log }, A, at('2026-10-28T00:00:00Z'))).toBe('sent');
    expect(tg.sent.find((m) => m.chatId === 111)!.text).toContain('Tidak ada peringatan baru (aktif 2).');
    expect(tg.sent.find((m) => m.chatId === 222)!.text).toContain('Tidak ada peringatan baru (aktif 1).');
  });

  it('one blocked admin does not stop the others; when everyone blocked the bot it is recorded, not retried daily', async () => {
    const tg = new FakeTelegram();
    tg.failFor.add(222);
    const logs: Array<[string, object]> = [];
    const keep = (msg: string, meta: object) => { logs.push([msg, meta]); };
    expect(await sendCompanyDigest({ db, telegram: tg, log: keep }, A, at('2026-10-29T00:00:00Z'))).toBe('sent');
    expect(tg.sent.map((m) => m.chatId)).toEqual([111]);
    // ops can see WHO blocked the bot
    expect(logs.find(([m]) => m === 'digest_send_failed')?.[1]).toMatchObject({ companyId: A, permanent: true, userId: expect.any(Number) });

    const blocked = new FakeTelegram();
    blocked.failFor.add(111).add(222);
    expect(await sendCompanyDigest({ db, telegram: blocked, log }, A, at('2026-10-30T00:00:00Z'))).toBe('undeliverable');
    const [row] = await withCompany(db, A, (tx) => tx.select().from(dailyDigests).where(eq(dailyDigests.digestDate, '2026-10-30')));
    expect(row!.sentAt).not.toBeNull();
    expect(row!.claimedUntil).toBeNull();
  });

  it('a transient failure is retried, and the retry does not send again to those already reached', async () => {
    const flaky = new FakeTelegram();
    flaky.flakyFor.add(111);
    await expect(sendCompanyDigest({ db, telegram: flaky, log }, A, at('2026-10-31T00:00:00Z'))).rejects.toThrow(/gagal sementara/);
    expect(flaky.sent.map((m) => m.chatId)).toEqual([222]);
    const [row] = await withCompany(db, A, (tx) => tx.select().from(dailyDigests).where(eq(dailyDigests.digestDate, '2026-10-31')));
    expect(row).toMatchObject({ sentAt: null, claimedUntil: null, deliveredChatIds: [222] });

    const retry = new FakeTelegram();
    expect(await sendCompanyDigest({ db, telegram: retry, log }, A, at('2026-10-31T00:05:00Z'))).toBe('sent');
    expect(retry.sent.map((m) => m.chatId)).toEqual([111]);
  });

  it('two workers on the same day: one sends, the other sees the claim; a crashed worker\'s claim lapses', async () => {
    const day = at('2026-11-01T00:00:00Z');
    const tg = new FakeTelegram();
    const results = await Promise.all([sendCompanyDigest({ db, telegram: tg, log }, A, day), sendCompanyDigest({ db, telegram: tg, log }, A, day)]);
    expect(results.sort()).toEqual(expect.arrayContaining(['sent']));
    expect(results.filter((r) => r === 'sent')).toHaveLength(1);
    expect(results.some((r) => r === 'in_progress' || r === 'already_sent')).toBe(true);
    expect(tg.sent.map((m) => m.chatId).sort()).toEqual([111, 222]);

    // a worker died holding 2026-11-02 (claim in the future, nothing sent): others wait, then take over
    await withCompany(db, A, (tx) => tx.insert(dailyDigests).values({ companyId: A, digestDate: '2026-11-02', claimedUntil: at('2026-11-02T00:15:00Z') }));
    const later = new FakeTelegram();
    expect(await sendCompanyDigest({ db, telegram: later, log }, A, at('2026-11-02T00:10:00Z'))).toBe('in_progress');
    expect(await sendCompanyDigest({ db, telegram: later, log }, A, at('2026-11-02T00:16:00Z'))).toBe('sent');
    expect(later.sent).toHaveLength(2);
  });

  it('a recipient limited to some sites gets only those sites\' alerts and counts', async () => {
    let s2 = 0;
    await withCompany(db, A, async (tx) => {
      const [s] = await tx.insert(sites).values({ companyId: A, code: 'BLM', name: 'JIAT Boalemo' }).returning({ id: sites.id });
      s2 = s!.id;
      await tx.insert(vendorInvoices).values({ companyId: A, siteId: s2, totalCents: 4000, status: 'perlu_cek', source: 'manual' });
    });
    await withApp(db, async (tx) => {
      const [u] = await tx.insert(users).values({ email: 'blm@a.test', name: 'Boalemo admin', telegramUserId: 555 }).returning({ id: users.id });
      const [m] = await tx.insert(users).values({ email: 'blm-mgr@a.test', name: 'Boalemo manager', telegramUserId: 666 }).returning({ id: users.id });
      await tx.insert(companyUsers).values([
        { userId: u!.id, companyId: A, role: 'project_admin', siteIds: [s2] },
        { userId: m!.id, companyId: A, role: 'company_manager', siteIds: [s2] },
      ]);
    });
    const tg = new FakeTelegram();
    expect(await sendCompanyDigest({ db, telegram: tg, log }, A, at('2026-11-03T00:00:00Z'))).toBe('sent');
    const scoped = tg.sent.find((m) => m.chatId === 555)!.text;
    const scopedMgr = tg.sent.find((m) => m.chatId === 666)!.text;
    const whole = tg.sent.find((m) => m.chatId === 111)!.text;
    // Keerom (s1) has 2 perlu cek, the termin due and the contract near its end; Boalemo (s2) one perlu cek and nothing else
    expect(scoped).toContain('Nota perlu cek: 1 · perlu konfirmasi: 0');
    expect(scoped).toContain('Intake 24 jam: 0 gagal diproses, 0 foto tidak terbaca');
    expect(scoped).toContain('aktif 0');
    expect(scoped).not.toContain('HK-KRM');
    expect(scopedMgr).not.toContain('HK-KRM');
    expect(scopedMgr).not.toContain('INV/KRM');
    expect(whole).toContain('Nota perlu cek: 3');
  });

  it('a digest slot that runs after midnight WIB is dropped, not sent as the next day\'s', async () => {
    const tg = new FakeTelegram();
    const logs: string[] = [];
    const registry = opsRegistry({
      db, storage: new LocalDiskStorage(dir), telegram: tg, digest: true, now: () => at('2026-11-04T17:30:00Z'), // 00:30 WIB on the 5th
      log: (msg) => { logs.push(msg); },
    });
    await registry[JOB_DAILY_DIGEST]!.run({ payload: { slot: 'ops.daily_digest@2026-11-04' } } as unknown as Job);
    expect(logs).toEqual(['digest_slot_stale']);
    expect(tg.sent).toEqual([]);
    expect(slotDate({ slot: 'ops.daily_digest@2026-11-04' })).toBe('2026-11-04');
    expect(slotDate({ slot: 'dashboard.refresh@2026-11-04T00:15:00.000Z' })).toBeNull();
    expect(slotDate(null)).toBeNull();
  });
});

describe('dashboard refresh job', () => {
  it('one company failing does not stop the others; the job fails naming the company and its reason', async () => {
    const [b] = await withApp(db, (tx) => tx.insert(companies).values({ code: 'BBB', name: 'PT BBB' }).returning({ id: companies.id }));
    // a database refusal for A's snapshot only
    await asOwner(db, async () => {
      await db.execute(sql.raw(`CREATE FUNCTION zz_refuse() RETURNS trigger LANGUAGE plpgsql AS $$
        BEGIN IF NEW.company_id = ${A} THEN RAISE EXCEPTION 'refresh refused for the test'; END IF; RETURN NEW; END $$`));
      await db.execute(sql.raw('CREATE TRIGGER zz_refuse BEFORE INSERT ON dash_refreshes FOR EACH ROW EXECUTE FUNCTION zz_refuse()'));
    });
    try {
      const summary = await refreshAll(db, at('2026-11-05T00:00:00Z'));
      expect(summary).toMatchObject({ companies: 2, refreshed: 1, skipped: 0 });
      expect(summary.failed).toEqual([{ companyId: A, error: expect.stringContaining('refresh refused for the test') }]);

      const logs: Array<[string, object]> = [];
      const registry = opsRegistry({
        db, storage: new LocalDiskStorage(dir), telegram: new FakeTelegram(), digest: false, now: () => at('2026-11-05T00:15:00Z'),
        log: (msg, meta) => { logs.push([msg, meta]); },
      });
      await expect(registry[JOB_DASHBOARD_REFRESH]!.run({ payload: {} } as unknown as Job)).rejects.toThrow(new RegExp(`perusahaan ${A}: .*refresh refused`));
      expect(logs.find(([m]) => m === 'refresh_company_failed')?.[1]).toMatchObject({ companyId: A });
      expect(logs.find(([m]) => m === 'dashboard_refreshed')?.[1]).toMatchObject({ refreshed: 1, failed: 1 });
    } finally {
      await asOwner(db, async () => {
        await db.execute(sql.raw('DROP TRIGGER zz_refuse ON dash_refreshes'));
        await db.execute(sql.raw('DROP FUNCTION zz_refuse()'));
        // B's snapshot rows reference it; the owner bypasses RLS to clean up
        await db.execute(sql`DELETE FROM dash_refreshes WHERE company_id = ${b!.id}`);
        await db.execute(sql`DELETE FROM companies WHERE id = ${b!.id}`);
      });
    }
  });

  it('a REPEATABLE READ write that lost to a concurrent refresh counts as stepped aside, not as a failure', () => {
    expect(isSerializationFailure({ code: '40001' })).toBe(true);
    expect(isSerializationFailure(new Error('Failed query', { cause: Object.assign(new Error('could not serialize access'), { code: '40001' }) }))).toBe(true);
    expect(isSerializationFailure({ code: '40P01' })).toBe(false);
    expect(isSerializationFailure(null)).toBe(false);
  });
});

describe('purge', () => {
  it('removes old orphans and temp files; keeps referenced and recent files', async () => {
    const storage = new LocalDiskStorage(dir);
    const key = (name: string) => `company-${A}/intake/2026/09/${name}`;
    await storage.put(key('kept.jpg'), Buffer.from('a'), 'image/jpeg');
    await storage.put(key('orphan.jpg'), Buffer.from('b'), 'image/jpeg');
    await storage.put(key('fresh-orphan.jpg'), Buffer.from('c'), 'image/jpeg');
    await writeFile(join(dir, key('crashed.jpg.0b8e.tmp')), 'partial');
    const old = at('2026-10-20T00:00:00Z');
    for (const n of ['kept.jpg', 'orphan.jpg', 'crashed.jpg.0b8e.tmp']) await utimes(join(dir, key(n)), old, old);
    await withCompany(db, A, (tx) => tx.insert(attachments).values({
      companyId: A, siteId: s1, attachableType: 'vendor_invoices', attachableId: 1, path: key('kept.jpg'), mime: 'image/jpeg', size: 1, sha256: 'a'.repeat(64),
    }));

    const r = await purgeOrphanPhotos({ db, storage, log: () => {} }, at('2026-10-27T19:00:00Z'));
    expect(r).toEqual({ scanned: 4, removed: 2 });
    const left: string[] = [];
    for await (const o of storage.list(`company-${A}/intake/`)) left.push(o.key);
    expect(left.sort()).toEqual([key('fresh-orphan.jpg'), key('kept.jpg')]);
  });

  it('a photo stored again (resent after a save that never committed) looks new, so the sweep spares it', async () => {
    const storage = new LocalDiskStorage(dir);
    const k = `company-${A}/intake/2026/09/${'d'.repeat(64)}.jpg`;
    await storage.put(k, Buffer.from('d'), 'image/jpeg');
    const old = at('2026-09-01T00:00:00Z');
    await utimes(join(dir, k), old, old);
    await storage.put(k, Buffer.from('d'), 'image/jpeg'); // EEXIST: same content-addressed key
    const listed: Array<{ key: string; modifiedAt: Date }> = [];
    for await (const o of storage.list(`company-${A}/intake/2026/09/`)) if (o.key === k) listed.push(o);
    expect(listed[0]!.modifiedAt.getTime()).toBeGreaterThan(old.getTime());
  });

  it('a file attached after the sweep read the attachment list is not deleted (re-checked before each delete)', async () => {
    const disk = new LocalDiskStorage(dir);
    const k = `company-${A}/intake/2026/08/${'e'.repeat(64)}.jpg`;
    await disk.put(k, Buffer.from('e'), 'image/jpeg');
    const old = at('2026-08-01T00:00:00Z');
    await utimes(join(dir, k), old, old);
    // the attachment commits while the sweep is listing (it already holds its stale "referenced" set)
    const racing = {
      put: disk.put.bind(disk), get: disk.get.bind(disk), delete: disk.delete.bind(disk),
      async *list(prefix: string) {
        let attached = false;
        for await (const o of disk.list(prefix)) {
          if (o.key === k && !attached) {
            attached = true;
            await withCompany(db, A, (tx) => tx.insert(attachments).values({
              companyId: A, siteId: s1, attachableType: 'vendor_invoices', attachableId: 2, path: k, mime: 'image/jpeg', size: 1, sha256: 'e'.repeat(64),
            }));
          }
          yield o;
        }
      },
    };
    await purgeOrphanPhotos({ db, storage: racing, log: () => {} }, at('2026-10-27T19:00:00Z'));
    expect((await disk.get(k)).toString()).toBe('e');
  });

  it('a company without an intake folder is fine', async () => {
    const storage = new LocalDiskStorage(join(dir, 'empty'));
    expect(await purgeOrphanPhotos({ db, storage, log: () => {} }, new Date())).toEqual({ scanned: 0, removed: 0 });
  });

  it('deletes done jobs after 30 days and failed jobs after 90; keeps pending ones', async () => {
    const now = at('2026-10-27T19:00:00Z');
    const daysAgo = (d: number) => new Date(now.getTime() - d * 86_400_000);
    await withApp(db, (tx) => tx.delete(jobs));
    await withApp(db, (tx) => tx.insert(jobs).values([
      { kind: 'k', doneAt: daysAgo(31) }, { kind: 'k', doneAt: daysAgo(29) },
      { kind: 'k', failedAt: daysAgo(91) }, { kind: 'k', failedAt: daysAgo(89) }, { kind: 'k' },
    ]));
    expect(await purgeOldJobs(db, now)).toEqual({ done: 1, failed: 1 });
    expect(await withApp(db, (tx) => tx.select().from(jobs))).toHaveLength(3);
  });
});
