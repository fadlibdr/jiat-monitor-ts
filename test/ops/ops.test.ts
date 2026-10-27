import { mkdtemp, rm, utimes, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { eq } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  attachments, companies, companyUsers, contracts, contractTerms, dailyDigests, intakeEvents, jobs, salesInvoices, sites, users, vendorInvoices,
} from '../../src/db/schema.js';
import { withApp, withCompany, type Db } from '../../src/db/tenant.js';
import { LocalDiskStorage } from '../../src/intake/storage.js';
import type { TelegramApi } from '../../src/intake/telegram-api.js';
import { currentSlot, enqueueDue, wibDate, type Schedule } from '../../src/jobs/schedule.js';
import { sendCompanyDigest } from '../../src/ops/digest.js';
import { purgeOldJobs, purgeOrphanPhotos } from '../../src/ops/purge.js';
import { createTestDb } from '../helpers/db.js';

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
  failFor = new Set<number>();
  async getFile(): Promise<never> { throw new Error('unused'); }
  async downloadFile(): Promise<never> { throw new Error('unused'); }
  async sendMessage(chatId: number, text: string) {
    if (this.failFor.has(chatId)) throw new Error('Forbidden: bot was blocked by the user');
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

  it('one blocked admin does not stop the others; nobody reachable → error, and the retry sends it', async () => {
    const tg = new FakeTelegram();
    tg.failFor.add(222);
    expect(await sendCompanyDigest({ db, telegram: tg, log }, A, at('2026-10-29T00:00:00Z'))).toBe('sent');
    expect(tg.sent.map((m) => m.chatId)).toEqual([111]);

    const down = new FakeTelegram();
    down.failFor.add(111).add(222);
    await expect(sendCompanyDigest({ db, telegram: down, log }, A, at('2026-10-30T00:00:00Z'))).rejects.toThrow(/tidak ada penerima/);
    const [row] = await withCompany(db, A, (tx) => tx.select().from(dailyDigests).where(eq(dailyDigests.digestDate, '2026-10-30')));
    expect(row!.sentAt).toBeNull();
    const up = new FakeTelegram();
    expect(await sendCompanyDigest({ db, telegram: up, log }, A, at('2026-10-30T01:00:00Z'))).toBe('sent');
    expect(up.sent).toHaveLength(2);
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
