import { and, asc, eq, sql } from 'drizzle-orm';
import sharp from 'sharp';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { headerAuthenticator } from '../../src/auth/authenticator.js';
import { hammingDistance } from '../../src/domain/hamming.js';
import {
  attachments, auditLogs, companies, companyUsers, intakeEvents, jobs, sites, telegramChats, users, vendorInvoices, vendors,
} from '../../src/db/schema.js';
import { withApp, withCompany, type Db } from '../../src/db/tenant.js';
import { createApp } from '../../src/http/app.js';
import { perceptualHash, sha256Hex } from '../../src/intake/hash.js';
import { OcrError, OcrParseError, type OcrClient, type OcrImage } from '../../src/intake/ocr.js';
import {
  intakeRegistry, JOB_CORRECTION, JOB_PHOTO, PHOTO_MAX_ATTEMPTS, type IntakeConfig, type IntakeDeps,
} from '../../src/intake/pipeline.js';
import { REPLY, shortRef } from '../../src/intake/replies.js';
import { intakeKey, type ObjectStorage } from '../../src/intake/storage.js';
import { TelegramError, type TelegramApi } from '../../src/intake/telegram-api.js';
import { enqueue, runOnce, type Registry, type RunResult } from '../../src/jobs/queue.js';
import { asOwner, createTestDb } from '../helpers/db.js';

/**
 * End-to-end intake (LLD §5–7): Telegram webhook → intake_events + job → worker (runOnce) →
 * OCR → validation V1–V10 → row + attachment + event in one transaction → reply after commit,
 * then chat corrections on the bot's reply. Real Postgres (PGlite) with RLS, real sharp images;
 * Telegram, OCR and object storage are in-memory fakes.
 */

// ---------------------------------------------------------------------------------------------
// clock and fixed data

const DAY_MS = 86_400_000;
/** Anchored on the real clock: attachments.created_at comes from the database's now(). */
const NOW = new Date();
const daysFromNow = (n: number) => new Date(NOW.getTime() + n * DAY_MS);
const isoDate = (d: Date) => d.toISOString().slice(0, 10);
const dmy = (d: Date) => { const s = isoDate(d); return `${s.slice(8, 10)}/${s.slice(5, 7)}/${s.slice(0, 4)}`; };

const SITE_START = isoDate(daysFromNow(-60));
const INVOICE_DAY = daysFromNow(-2);

const SECRET = 'whsec-test-0123456789abcdef';
const CHAT_A1 = -100_111; // company A, site KRM
const CHAT_A2 = -100_112; // company A, site BLM
const CHAT_A_OFF = -100_113; // company A, deactivated mapping
const CHAT_B = -100_221; // company B
const CHAT_UNKNOWN = -100_999;
const BOT_TG = 7_000_001;
const TG = { staff: 501, admin: 502, otherSite: 503, bob: 504, inactive: 505, finance: 506, stranger: 999 } as const;

/** PII the OCR may read off a receipt or that sits in the vendor master: must never reach a group chat. */
const OCR_BANK = '8800112233';
const OCR_NPWP_TEXT = '09.876.543.2-109.000';
const OCR_NPWP_DIGITS = '098765432109000';
const VENDOR_BANK = '7700445566';
const VENDOR_NPWP = '012345678901000';

/** Image seeds: pairwise pHash distance between any two is > 6 (checked by the first test). */
const SEED = { happy: 11, dup: 12, s1: 13, err: 14, parse: 15, near: 16, vendor: 17, vendor2: 18, ignored: 19, ref: 20, ref2: 21, closed: 22, flags: 23, fail: 24, txfail: 25, race: 26, rerun: 27, review: 28, fence: 29, fence2: 30, size: 31, cat: 32 } as const;

// ---------------------------------------------------------------------------------------------
// fakes

class FakeTelegram implements TelegramApi {
  readonly files = new Map<string, Buffer>();
  readonly sent: Array<{ chatId: number; text: string; replyTo: number | undefined; messageId: number }> = [];
  readonly getFileCalls: string[] = [];
  readonly downloads: string[] = [];
  /** declared size override per file id (what Telegram's getFile reports) */
  readonly declaredSize = new Map<string, number>();
  /** next N sendMessage calls throw */
  failSends = 0;
  private nextMessageId = 90_000;

  async getFile(fileId: string): Promise<{ filePath: string; fileSize: number | null }> {
    this.getFileCalls.push(fileId);
    const bytes = this.files.get(fileId);
    if (!bytes) throw new TelegramError(`getFile: unknown file ${fileId}`);
    return { filePath: `photos/${fileId}.jpg`, fileSize: this.declaredSize.get(fileId) ?? bytes.length };
  }

  async downloadFile(filePath: string, maxBytes: number): Promise<Buffer> {
    this.downloads.push(filePath);
    const id = filePath.replace(/^photos\//, '').replace(/\.jpg$/, '');
    const bytes = this.files.get(id);
    if (!bytes) throw new TelegramError('download: 404');
    if (bytes.length > maxBytes) throw new TelegramError('download: too large');
    return Buffer.from(bytes);
  }

  async sendMessage(chatId: number, text: string, replyToMessageId?: number): Promise<{ messageId: number }> {
    if (this.failSends > 0) {
      this.failSends--;
      throw new TelegramError('sendMessage: HTTP 502');
    }
    const messageId = ++this.nextMessageId;
    this.sent.push({ chatId, text, replyTo: replyToMessageId, messageId });
    return { messageId };
  }
}

/** Scripted OCR: each call takes the next answer of its stage; an Error in the script is thrown. */
class FakeOcr implements OcrClient {
  readonly stage1: unknown[] = [];
  readonly stage2: unknown[] = [];
  readonly calls: Array<{ stage: 'classify' | 'extract'; sha: string }> = [];
  /** runs once, right before the next extract() answers (to simulate a concurrent job) */
  beforeExtract: (() => Promise<void>) | null = null;

  script(s1: unknown, s2?: unknown): void {
    this.stage1.push(s1);
    if (s2 !== undefined) this.stage2.push(s2);
  }

  async classify(image: OcrImage): Promise<unknown> {
    this.calls.push({ stage: 'classify', sha: sha256Hex(image.bytes) });
    return take(this.stage1, 'classify');
  }

  async extract(image: OcrImage): Promise<unknown> {
    this.calls.push({ stage: 'extract', sha: sha256Hex(image.bytes) });
    const hook = this.beforeExtract;
    this.beforeExtract = null;
    if (hook) await hook();
    return take(this.stage2, 'extract');
  }
}
function take(queue: unknown[], name: string): unknown {
  if (queue.length === 0) throw new Error(`unexpected OCR ${name} call`);
  const answer = queue.shift();
  if (answer instanceof Error) throw answer;
  return structuredClone(answer);
}

class MemStorage implements ObjectStorage {
  readonly objects = new Map<string, Buffer>();
  readonly puts: string[] = [];
  readonly deletes: string[] = [];
  async put(key: string, bytes: Buffer, _contentType: string): Promise<void> {
    this.puts.push(key);
    this.objects.set(key, Buffer.from(bytes));
  }
  async get(key: string): Promise<Buffer> {
    const b = this.objects.get(key);
    if (!b) throw new Error(`no object ${key}`);
    return b;
  }
  async delete(key: string): Promise<void> {
    this.deletes.push(key);
    this.objects.delete(key);
  }
}

// ---------------------------------------------------------------------------------------------
// OCR answers

const S1_OK = { doc_type: 'nota', quality: 0.9, reason: '' };

interface S2 {
  vendor: string | null;
  total: string | null;
  totalConfidence: number;
  date: string | null;
  description: string | null;
  subtotal: string | null;
  ppn: string | null;
  npwp: string | null;
  bank: string | null;
  docNumber: string | null;
  items: Array<{ desc: string; amount: string | null }>;
}
/** A stage-2 answer in the text-only contract the prompt asks for. */
function s2(o: Partial<S2> = {}): unknown {
  const v: S2 = {
    vendor: 'Toko Sinar Jaya', total: 'Rp 2.405.000,-', totalConfidence: 0.92, date: dmy(INVOICE_DAY),
    description: 'Semen Tiga Roda 50 sak', subtotal: null, ppn: null, npwp: null, bank: null, docNumber: 'NT-0042', items: [], ...o,
  };
  const f = (value: string | null, confidence = value === null ? 0 : 0.93) => ({ value, confidence });
  return {
    invoice_date: f(v.date), vendor_name: f(v.vendor), doc_number: f(v.docNumber), description: f(v.description),
    line_items: v.items, subtotal: f(v.subtotal), ppn: f(v.ppn), total: f(v.total, v.totalConfidence), npwp: f(v.npwp), bank_account: f(v.bank),
  };
}

// ---------------------------------------------------------------------------------------------
// images

/** A synthetic "receipt": text-like bars and a block, deterministic per seed. */
async function receipt(seed: number, opts: { width?: number; quality?: number } = {}): Promise<Buffer> {
  const w = 400; const h = 600;
  const raw = Buffer.alloc(w * h, 255);
  let s = seed;
  const rnd = () => { s = (s * 1103515245 + 12345) % 2 ** 31; return s; };
  for (let line = 0; line < 20; line++) {
    const len = 60 + (rnd() % 300);
    const x0 = 20 + (rnd() % 60);
    const y0 = 40 + line * 26;
    for (let y = y0; y < y0 + 10; y++) for (let x = x0; x < Math.min(w, x0 + len); x++) raw[y * w + x] = 30;
  }
  const bx = rnd() % 300; const by = rnd() % 500;
  for (let y = by; y < by + 80; y++) for (let x = bx; x < bx + 90; x++) raw[y * w + x] = 0;
  let img = sharp(raw, { raw: { width: w, height: h, channels: 1 } });
  if (opts.width) img = img.resize(opts.width);
  return img.jpeg({ quality: opts.quality ?? 85 }).toBuffer();
}

// ---------------------------------------------------------------------------------------------
// state

let db: Db;
let close: () => Promise<void>;
let A = 0; let B = 0;
let s1 = 0; let s2Site = 0; let sB = 0;
let staffId = 0; let adminId = 0; let otherSiteId = 0; let financeId = 0;
let vendorSB = 0; let vendorB = 0;

let tg: FakeTelegram;
let ocr: FakeOcr;
let storage: MemStorage;
let logs: Array<{ msg: string; meta: object }>;
let clock: Date;
let config: IntakeConfig;
let reg: Registry;
let app: ReturnType<typeof createApp>;
let seq = 1000;

beforeAll(async () => {
  ({ db, close } = await createTestDb());
  await withApp(db, async (tx) => {
    const cs = await tx.insert(companies).values([{ code: 'AAA', name: 'PT AAA' }, { code: 'BBB', name: 'PT BBB' }]).returning({ id: companies.id });
    [A, B] = [cs[0]!.id, cs[1]!.id];
    const us = await tx.insert(users).values([
      { email: 'staff@a.test', name: 'Staff KRM', telegramUserId: TG.staff },
      { email: 'admin@a.test', name: 'Admin Proyek', telegramUserId: TG.admin },
      { email: 'blm@a.test', name: 'Staff BLM', telegramUserId: TG.otherSite },
      { email: 'bob@b.test', name: 'Bob', telegramUserId: TG.bob },
      { email: 'gone@a.test', name: 'Gone', telegramUserId: TG.inactive, isActive: false },
      { email: 'fin@a.test', name: 'Finance', telegramUserId: TG.finance },
    ]).returning({ id: users.id });
    [staffId, adminId, otherSiteId] = [us[0]!.id, us[1]!.id, us[2]!.id];
    financeId = us[5]!.id;
    (globalThis as { __bob?: number; __gone?: number }).__bob = us[3]!.id;
    (globalThis as { __bob?: number; __gone?: number }).__gone = us[4]!.id;
  });
  await withCompany(db, A, async (tx) => {
    const ss = await tx.insert(sites).values([
      { companyId: A, code: 'KRM', name: 'JIAT Keerom', startDate: SITE_START },
      { companyId: A, code: 'BLM', name: 'JIAT Boalemo', startDate: SITE_START },
    ]).returning({ id: sites.id });
    [s1, s2Site] = [ss[0]!.id, ss[1]!.id];
    const [v] = await tx.insert(vendors).values({
      companyId: A, name: 'PT Sumber Beton', defaultCategory: 'material', bankName: 'BRI', bankAccount: VENDOR_BANK, npwp: VENDOR_NPWP,
    }).returning({ id: vendors.id });
    vendorSB = v!.id;
  });
  await withCompany(db, B, async (tx) => {
    const [s] = await tx.insert(sites).values({ companyId: B, code: 'MWU', name: 'JIAT Morowali Utara', startDate: SITE_START }).returning({ id: sites.id });
    sB = s!.id;
    const [v] = await tx.insert(vendors).values({ companyId: B, name: 'CV Maju Jaya', defaultCategory: 'alat' }).returning({ id: vendors.id });
    vendorB = v!.id;
  });
  const g = globalThis as { __bob?: number; __gone?: number };
  await withApp(db, (tx) => tx.insert(companyUsers).values([
    { userId: staffId, companyId: A, role: 'site_staff', siteIds: [s1] },
    { userId: adminId, companyId: A, role: 'project_admin' },
    { userId: otherSiteId, companyId: A, role: 'site_staff', siteIds: [s2Site] },
    { userId: g.__bob!, companyId: B, role: 'project_admin' },
    { userId: g.__gone!, companyId: A, role: 'finance' },
    { userId: financeId, companyId: A, role: 'finance' },
  ]));
  await withApp(db, (tx) => tx.insert(telegramChats).values([
    { chatId: CHAT_A1, companyId: A, siteId: s1, title: 'Nota KRM' },
    { chatId: CHAT_A2, companyId: A, siteId: s2Site, title: 'Nota BLM' },
    { chatId: CHAT_A_OFF, companyId: A, siteId: s1, title: 'Lama', isActive: false },
    { chatId: CHAT_B, companyId: B, siteId: sB, title: 'Nota MWU' },
  ]));
});

beforeEach(async () => {
  await asOwner(db, async () => {
    await db.execute(sql`TRUNCATE intake_events, attachments, vendor_invoices, jobs, audit_logs`);
    await db.execute(sql`DELETE FROM vendors WHERE status = 'draft'`);
  });
  tg = new FakeTelegram();
  ocr = new FakeOcr();
  storage = new MemStorage();
  logs = [];
  clock = NOW;
  config = { qualityMin: 0.45, totalConfidenceMin: 0.7, maxPhotoBytes: 5 * 1024 * 1024 };
  const deps: IntakeDeps = { db, telegram: tg, storage, ocr, now: () => clock, config, log: (msg, meta) => { logs.push({ msg, meta }); } };
  reg = intakeRegistry(deps);
  app = createApp({ db, auth: headerAuthenticator('test'), telegramWebhookSecret: SECRET, storage, now: () => clock });
});

afterAll(async () => { await close(); });

// ---------------------------------------------------------------------------------------------
// helpers

const owner = <T>(fn: () => Promise<T>) => asOwner(db, fn);

function postUpdate(update: unknown, secret: string | null = SECRET): Promise<Response> {
  const headers: Record<string, string> = { 'content-type': 'application/json' };
  if (secret !== null) headers['x-telegram-bot-api-secret-token'] = secret;
  return Promise.resolve(app.request('/telegram/webhook', { method: 'POST', headers, body: JSON.stringify(update) }));
}

function photoUpdate(messageId: number, fileId: string, size: number, chat: number, from: number): unknown {
  return {
    update_id: ++seq,
    message: {
      message_id: messageId, chat: { id: chat }, from: { id: from }, date: 1_700_000_000,
      // Telegram sends several sizes; the largest is the one to read
      photo: [{ file_id: `${fileId}-thumb`, width: 90, height: 135, file_size: 900 }, { file_id: fileId, width: 400, height: 600, file_size: size }],
    },
  };
}

/** Posts a photo message through the webhook; returns its Telegram message id. */
async function sendPhoto(bytes: Buffer, opts: { chat?: number; from?: number } = {}): Promise<number> {
  const messageId = ++seq;
  const fileId = `file-${messageId}`;
  tg.files.set(fileId, bytes);
  const res = await postUpdate(photoUpdate(messageId, fileId, bytes.length, opts.chat ?? CHAT_A1, opts.from ?? TG.staff));
  expect(res.status).toBe(200);
  return messageId;
}

/** Posts a text message; by default a reply to a bot message when `replyTo` is given. */
async function sendText(text: string, opts: { chat?: number; from?: number | null; replyTo?: number; replyToBot?: boolean } = {}): Promise<number> {
  const messageId = ++seq;
  const message: Record<string, unknown> = { message_id: messageId, chat: { id: opts.chat ?? CHAT_A1 }, date: 1_700_000_000, text };
  if (opts.from !== null) message['from'] = { id: opts.from ?? TG.staff };
  if (opts.replyTo !== undefined) {
    const toBot = opts.replyToBot ?? true;
    message['reply_to_message'] = { message_id: opts.replyTo, from: toBot ? { id: BOT_TG, is_bot: true } : { id: TG.admin, is_bot: false } };
  }
  const res = await postUpdate({ update_id: ++seq, message });
  expect(res.status).toBe(200);
  return messageId;
}

/** Runs due jobs until the queue has nothing due. */
async function drain(): Promise<RunResult[]> {
  const out: RunResult[] = [];
  for (let i = 0; i < 25; i++) {
    const r = await runOnce(db, reg, 'test-worker', (msg, meta) => { logs.push({ msg, meta }); });
    if (!r) return out;
    out.push(r);
  }
  throw new Error('queue did not drain');
}

const makeDue = () => owner(() => db.execute(sql`UPDATE jobs SET run_at = now() - interval '1 second' WHERE done_at IS NULL AND failed_at IS NULL`));
const allJobs = () => owner(() => db.select().from(jobs).orderBy(asc(jobs.id)));
const allEvents = () => owner(() => db.select().from(intakeEvents).orderBy(asc(intakeEvents.id)));
const allInvoices = () => owner(() => db.select().from(vendorInvoices).orderBy(asc(vendorInvoices.id)));
const allAttachments = () => owner(() => db.select().from(attachments).orderBy(asc(attachments.id)));
const invoicesOf = (companyId: number) => withCompany(db, companyId, (tx) => tx.select().from(vendorInvoices).orderBy(asc(vendorInvoices.id)));
const chatCorrectionAudits = () => owner(() => db.select().from(auditLogs).where(eq(auditLogs.action, 'chat_correction')).orderBy(asc(auditLogs.id)));

async function eventOf(chatId: number, messageId: number) {
  const [e] = await owner(() => db.select().from(intakeEvents).where(and(eq(intakeEvents.chatId, chatId), eq(intakeEvents.messageId, messageId))));
  return e;
}

/** The last bot message sent in reply to `messageId`. */
function replyTo(messageId: number) {
  const r = [...tg.sent].reverse().find((m) => m.replyTo === messageId);
  if (!r) throw new Error(`no bot reply to message ${messageId}; sent: ${JSON.stringify(tg.sent)}`);
  return r;
}

/** HLD §8 / UU 27/2022: no bank account or NPWP in a group message, in any formatting. */
function expectNoPii(text: string): void {
  const digits = text.replace(/\D/g, '');
  for (const secret of [OCR_BANK, OCR_NPWP_DIGITS, VENDOR_BANK, VENDOR_NPWP]) {
    expect(text).not.toContain(secret);
    expect(digits).not.toContain(secret);
  }
  expect(text).not.toContain(OCR_NPWP_TEXT);
  expect(text).not.toMatch(/npwp|rekening|\bBCA\b|\bBRI\b/i);
}

/** Sends one readable photo and runs its job; returns the saved row and the bot's summary message. */
async function savedPhoto(seed: number, answer: unknown = s2(), opts: { chat?: number; from?: number; companyId?: number } = {}) {
  const img = await receipt(seed);
  ocr.script(S1_OK, answer);
  const photoMsg = await sendPhoto(img, opts);
  expect(await drain()).toEqual([expect.objectContaining({ kind: JOB_PHOTO, result: 'done' })]);
  const ev = (await eventOf(opts.chat ?? CHAT_A1, photoMsg))!;
  expect(ev.outcome).toBe('tersimpan');
  const [row] = await owner(() => db.select().from(vendorInvoices).where(eq(vendorInvoices.id, ev.vendorInvoiceId!)));
  return { img, photoMsg, row: row!, summary: replyTo(photoMsg), event: ev };
}

const rowById = async (id: number) => (await owner(() => db.select().from(vendorInvoices).where(eq(vendorInvoices.id, id))))[0]!;

// =============================================================================================

describe('test fixtures', () => {
  it('distinct seeds are far apart in pHash (> 6) and a quality-40 re-encode stays near (≤ 6) with different bytes', async () => {
    const seeds = Object.values(SEED);
    expect(new Set(seeds).size).toBe(seeds.length);
    const hashes = await Promise.all(seeds.map(async (s) => perceptualHash(await receipt(s))));
    for (let i = 0; i < hashes.length; i++) {
      for (let j = i + 1; j < hashes.length; j++) expect(hammingDistance(hashes[i]!, hashes[j]!)).toBeGreaterThan(6);
    }
    const original = await receipt(SEED.near);
    const copy = await receipt(SEED.near, { quality: 40 });
    expect(sha256Hex(copy)).not.toBe(sha256Hex(original));
    expect(hammingDistance(await perceptualHash(original), await perceptualHash(copy))).toBeLessThanOrEqual(6);
  });
});

describe('webhook → intake_events + job', () => {
  it('a wrong or missing secret token is 403 and stores nothing', async () => {
    const img = await receipt(SEED.happy);
    tg.files.set('file-x', img);
    expect((await postUpdate(photoUpdate(1, 'file-x', img.length, CHAT_A1, TG.staff), 'wrong-secret')).status).toBe(403);
    expect((await postUpdate(photoUpdate(2, 'file-x', img.length, CHAT_A1, TG.staff), null)).status).toBe(403);
    expect(await allEvents()).toEqual([]);
    expect(await allJobs()).toEqual([]);
  });

  it('a photo from an unmapped or a deactivated group is answered 200 and nothing is stored or queued', async () => {
    const img = await receipt(SEED.happy);
    await sendPhoto(img, { chat: CHAT_UNKNOWN });
    await sendPhoto(img, { chat: CHAT_A_OFF });
    expect(await allEvents()).toEqual([]);
    expect(await allJobs()).toEqual([]);
    expect(await drain()).toEqual([]);
    expect(ocr.calls).toEqual([]);
    expect(tg.sent).toEqual([]);
  });

  it('a re-delivered update (same chat_id + message_id) creates no second event and no second job', async () => {
    const img = await receipt(SEED.happy);
    tg.files.set('file-redeliver', img);
    const update = photoUpdate(4242, 'file-redeliver', img.length, CHAT_A1, TG.staff);
    expect((await postUpdate(update)).status).toBe(200);
    expect((await postUpdate(update)).status).toBe(200);
    const events = await allEvents();
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({ companyId: A, siteId: s1, chatId: CHAT_A1, messageId: 4242, fromUserId: TG.staff, kind: 'photo', outcome: 'pending' });
    // the largest size is the one queued, never the thumbnail; the raw update is not kept
    expect(events[0]!.payload).toEqual({ fileId: 'file-redeliver', mime: 'image/jpeg', fileSize: img.length });
    const queued = await allJobs();
    expect(queued).toHaveLength(1);
    expect(queued[0]).toMatchObject({ kind: JOB_PHOTO, companyId: A, payload: { intakeEventId: events[0]!.id }, maxAttempts: PHOTO_MAX_ATTEMPTS });
  });

  it('text that is neither a reply to the bot nor carries #xxxx is not stored (the group stays quiet)', async () => {
    await sendText('TOTAL 2450000');
    await sendText('TOTAL 2450000', { replyTo: 77, replyToBot: false });
    await sendText('ok makasih', { replyTo: 77 });
    expect(await allEvents()).toEqual([]);
    expect(await allJobs()).toEqual([]);
  });
});

describe('LLD flow: photo → row → TOTAL correction → OK', () => {
  it('saves a readable photo as perlu_konfirmasi and replies with a summary that has no bank account or NPWP, even though OCR read both', async () => {
    const img = await receipt(SEED.happy);
    ocr.script(S1_OK, s2({ npwp: OCR_NPWP_TEXT, bank: `BCA ${OCR_BANK} a.n. Sinar Jaya` }));
    const photoMsg = await sendPhoto(img);
    expect(await drain()).toEqual([expect.objectContaining({ kind: JOB_PHOTO, result: 'done' })]);

    const rows = await invoicesOf(A);
    expect(rows).toHaveLength(1);
    const row = rows[0]!;
    expect(row).toMatchObject({
      siteId: s1, status: 'perlu_konfirmasi', source: 'telegram', vendorName: 'Toko Sinar Jaya', vendorId: null,
      invoiceDate: isoDate(INVOICE_DAY), category: 'material', totalCents: 240_500_000, docNumber: 'NT-0042',
      npwp: OCR_NPWP_DIGITS, imageHash: sha256Hex(img), confirmedAt: null,
    });
    expect(row.phash).toMatch(/^[0-9a-f]{16}$/);
    expect(row.confidence.flags).toEqual([]);
    // the bank account read by OCR is dropped: stored nowhere
    expect(JSON.stringify(row)).not.toContain(OCR_BANK);

    // OCR saw the downloaded original, stage 1 then stage 2
    expect(ocr.calls.map((c) => c.stage)).toEqual(['classify', 'extract']);
    expect(ocr.calls.every((c) => c.sha === sha256Hex(img))).toBe(true);

    expect(tg.sent).toHaveLength(1);
    const summary = tg.sent[0]!;
    expect(summary).toMatchObject({ chatId: CHAT_A1, replyTo: photoMsg });
    expect(summary.text).toContain(`#${shortRef(row.rowId)}`);
    expect(summary.text).toContain('Rp 2.405.000');
    expectNoPii(summary.text);

    const ev = await eventOf(CHAT_A1, photoMsg);
    expect(ev).toMatchObject({ outcome: 'tersimpan', vendorInvoiceId: row.id, replyMessageId: summary.messageId, error: null });
    expect(JSON.stringify(ev)).not.toContain(OCR_BANK);

    const atts = await allAttachments();
    expect(atts).toHaveLength(1);
    expect(atts[0]).toMatchObject({
      companyId: A, siteId: s1, attachableType: 'vendor_invoices', attachableId: row.id, mime: 'image/jpeg', size: img.length,
      sha256: sha256Hex(img), phash: row.phash, telegramMessageId: photoMsg,
    });
    expect(atts[0]!.path).toBe(intakeKey(A, sha256Hex(img), 'image/jpeg', clock));
    expect(storage.objects.get(atts[0]!.path)?.equals(img)).toBe(true);
  });

  it('"TOTAL 2450000" in reply to the bot summary updates the SAME row, and "OK" in reply to the correction confirms it; both are audited', async () => {
    const { row, summary } = await savedPhoto(SEED.happy);

    const totalMsg = await sendText('TOTAL 2450000', { replyTo: summary.messageId });
    expect(await drain()).toEqual([expect.objectContaining({ kind: JOB_CORRECTION, result: 'done' })]);
    const afterTotal = await invoicesOf(A);
    expect(afterTotal).toHaveLength(1);
    expect(afterTotal[0]).toMatchObject({ id: row.id, rowId: row.rowId, totalCents: 245_000_000, status: 'perlu_konfirmasi' });
    expect(await eventOf(CHAT_A1, totalMsg)).toMatchObject({ kind: 'correction', outcome: 'koreksi_ok', vendorInvoiceId: row.id });
    const totalReply = replyTo(totalMsg);
    expect(totalReply.chatId).toBe(CHAT_A1);
    expect(totalReply.text).toContain(`#${shortRef(row.rowId)}`);
    expect(totalReply.text).toContain('Rp 2.450.000');
    expectNoPii(totalReply.text);

    const okMsg = await sendText('OK', { replyTo: totalReply.messageId });
    await drain();
    const confirmed = await invoicesOf(A);
    expect(confirmed).toHaveLength(1);
    expect(confirmed[0]).toMatchObject({ id: row.id, status: 'terkonfirmasi', totalCents: 245_000_000, confirmedBy: staffId });
    expect(confirmed[0]!.confirmedAt).toBeInstanceOf(Date);
    // a confirmed invoice always points at a master vendor (a draft is created for an unknown one)
    expect(confirmed[0]!.vendorId).not.toBeNull();
    expect(await eventOf(CHAT_A1, okMsg)).toMatchObject({ outcome: 'koreksi_ok', vendorInvoiceId: row.id });
    expect(replyTo(okMsg).text).toMatch(/terkonfirmasi/);
    expectNoPii(replyTo(okMsg).text);

    const audits = await chatCorrectionAudits();
    expect(audits.map((a) => ({ companyId: a.companyId, userId: a.userId, type: a.auditableType, id: a.auditableId, meta: a.meta }))).toEqual([
      { companyId: A, userId: staffId, type: 'vendor_invoices', id: row.id, meta: expect.objectContaining({ chatId: CHAT_A1, messageId: totalMsg, command: 'total', ok: true }) },
      { companyId: A, userId: staffId, type: 'vendor_invoices', id: row.id, meta: expect.objectContaining({ chatId: CHAT_A1, messageId: okMsg, command: 'ok', ok: true }) },
    ]);
    const rowUpdates = await owner(() => db.select().from(auditLogs).where(and(
      eq(auditLogs.auditableType, 'vendor_invoices'), eq(auditLogs.action, 'update'), eq(auditLogs.auditableId, row.id))));
    expect(rowUpdates).toHaveLength(2);
    expect(rowUpdates.every((a) => a.userId === staffId)).toBe(true);
  });

  it('a TOTAL correction re-runs V5: a misread total flagged arith_ppn (perlu_cek) is cleared once subtotal + PPN = total', async () => {
    const { row, summary } = await savedPhoto(SEED.flags, s2({ subtotal: 'Rp 2.207.207', ppn: 'Rp 242.793', total: 'Rp 2.405.000' }));
    expect(row.status).toBe('perlu_cek');
    expect(row.confidence.flags).toContain('arith_ppn');
    expect(summary.text).toMatch(/subtotal \+ PPN tidak cocok/);

    // OK is refused while the flag is open
    const ok1 = await sendText('OK', { replyTo: summary.messageId });
    await drain();
    expect(replyTo(ok1).text).toMatch(/Belum bisa dikonfirmasi/);
    expect(await eventOf(CHAT_A1, ok1)).toMatchObject({ outcome: 'koreksi_ditolak' });
    expect((await rowById(row.id)).status).toBe('perlu_cek');

    await sendText('TOTAL Rp 2.450.000,-', { replyTo: summary.messageId });
    await drain();
    const fixed = await rowById(row.id);
    expect(fixed).toMatchObject({ totalCents: 245_000_000, status: 'perlu_konfirmasi' });
    expect(fixed.confidence.flags).not.toContain('arith_ppn');

    const ok2 = await sendText('OK', { replyTo: summary.messageId });
    await drain();
    expect((await rowById(row.id)).status).toBe('terkonfirmasi');
    expect(await eventOf(CHAT_A1, ok2)).toMatchObject({ outcome: 'koreksi_ok' });
  });
});

describe('V8: exact duplicate before OCR', () => {
  it('identical bytes sent again are answered "sudah tercatat" with the first row\'s reference; OCR is not called and nothing new is stored', async () => {
    const { img, row } = await savedPhoto(SEED.dup);
    const ocrCallsBefore = ocr.calls.length;
    const putsBefore = storage.puts.length;

    const again = await sendPhoto(img); // a new Telegram message with the same bytes
    expect(await drain()).toEqual([expect.objectContaining({ kind: JOB_PHOTO, result: 'done' })]);
    expect(ocr.calls).toHaveLength(ocrCallsBefore);
    expect(await eventOf(CHAT_A1, again)).toMatchObject({ outcome: 'duplikat', vendorInvoiceId: null });
    const reply = replyTo(again);
    expect(reply.text).toMatch(/sudah tercatat/);
    expect(reply.text).toContain(`#${shortRef(row.rowId)}`);
    expect(await allInvoices()).toHaveLength(1);
    expect(await allAttachments()).toHaveLength(1);
    expect(storage.puts).toHaveLength(putsBefore);
  });

  it('V8 is per company: the same bytes at another site of the company are a duplicate, in another company they are a new receipt', async () => {
    const { img } = await savedPhoto(SEED.dup);
    const otherSite = await sendPhoto(img, { chat: CHAT_A2, from: TG.otherSite });
    await drain();
    expect(await eventOf(CHAT_A2, otherSite)).toMatchObject({ outcome: 'duplikat' });

    ocr.script(S1_OK, s2());
    const otherCompany = await sendPhoto(img, { chat: CHAT_B, from: TG.bob });
    await drain();
    expect(await eventOf(CHAT_B, otherCompany)).toMatchObject({ outcome: 'tersimpan' });
    expect(await invoicesOf(B)).toHaveLength(1);
    expect(await invoicesOf(A)).toHaveLength(1);
  });
});

describe('stage 1 and unreadable answers', () => {
  it('bukan_dokumen → tidak_terbaca with a request for a new photo; no stage 2, no row, no attachment, no file, and the hash is not kept', async () => {
    const img = await receipt(SEED.s1);
    ocr.script({ doc_type: 'bukan_dokumen', quality: 0.95, reason: 'foto selfie' });
    const msg = await sendPhoto(img);
    expect(await drain()).toEqual([expect.objectContaining({ result: 'done' })]);
    expect(ocr.calls.map((c) => c.stage)).toEqual(['classify']);
    expect(await eventOf(CHAT_A1, msg)).toMatchObject({ outcome: 'tidak_terbaca', vendorInvoiceId: null });
    expect(replyTo(msg).text).toMatch(/kirim ulang/i);
    expect(await allInvoices()).toEqual([]);
    expect(await allAttachments()).toEqual([]);
    expect(storage.puts).toEqual([]);

    // the same bytes again are read, not refused as "sudah tercatat"
    ocr.script(S1_OK, s2());
    const again = await sendPhoto(img);
    await drain();
    expect(await eventOf(CHAT_A1, again)).toMatchObject({ outcome: 'tersimpan' });
    expect(await allInvoices()).toHaveLength(1);
  });

  it('quality boundary: 0.44 and a missing quality are rejected, exactly 0.45 is read', async () => {
    const img = await receipt(SEED.s1);
    ocr.script({ doc_type: 'nota', quality: 0.44, reason: 'buram' });
    const low = await sendPhoto(img);
    await drain();
    expect(await eventOf(CHAT_A1, low)).toMatchObject({ outcome: 'tidak_terbaca' });

    ocr.script({ doc_type: 'nota', quality: null, reason: '' });
    const missing = await sendPhoto(img);
    await drain();
    expect(await eventOf(CHAT_A1, missing)).toMatchObject({ outcome: 'tidak_terbaca' });
    expect(ocr.calls.filter((c) => c.stage === 'extract')).toHaveLength(0);

    ocr.script({ doc_type: 'nota', quality: 0.45, reason: '' }, s2());
    const edge = await sendPhoto(img);
    await drain();
    expect(await eventOf(CHAT_A1, edge)).toMatchObject({ outcome: 'tersimpan' });
  });

  it('a stage-1 answer that breaks the contract (wrong types) is tidak_terbaca, not an error', async () => {
    const img = await receipt(SEED.s1);
    ocr.script({ doc_type: 'nota', quality: 'tinggi' });
    const msg = await sendPhoto(img);
    expect(await drain()).toEqual([expect.objectContaining({ result: 'done' })]);
    expect(await eventOf(CHAT_A1, msg)).toMatchObject({ outcome: 'tidak_terbaca' });
    expect(await allInvoices()).toEqual([]);
  });

  it('OcrParseError (model answered, not JSON) at stage 1 or stage 2 → tidak_terbaca, not retried, nothing stored', async () => {
    const img = await receipt(SEED.parse);
    ocr.script(new OcrParseError('Jawaban OCR bukan JSON.'));
    const m1 = await sendPhoto(img);
    expect(await drain()).toEqual([expect.objectContaining({ result: 'done' })]);
    expect(await eventOf(CHAT_A1, m1)).toMatchObject({ outcome: 'tidak_terbaca' });
    expect(replyTo(m1).text).toMatch(/kirim ulang/i);

    ocr.script(S1_OK, new OcrParseError('Jawaban OCR bukan JSON.'));
    const m2 = await sendPhoto(img);
    expect(await drain()).toEqual([expect.objectContaining({ result: 'done' })]);
    expect(await eventOf(CHAT_A1, m2)).toMatchObject({ outcome: 'tidak_terbaca' });

    const js = await allJobs();
    expect(js.every((j) => j.doneAt !== null && j.failedAt === null && j.attempts === 1)).toBe(true);
    expect(await allInvoices()).toEqual([]);
    expect(await allAttachments()).toEqual([]);
    expect(storage.puts).toEqual([]);
  });

  it('V2: a total read with confidence 0.69 is rejected, 0.70 is accepted; an empty total is rejected', async () => {
    const img = await receipt(SEED.parse);
    ocr.script(S1_OK, s2({ totalConfidence: 0.69 }));
    const low = await sendPhoto(img);
    ocr.script(S1_OK, s2({ total: null }));
    const none = await sendPhoto(img);
    ocr.script(S1_OK, s2({ total: 'Rp 0' }));
    const zero = await sendPhoto(img);
    await drain();
    for (const m of [low, none, zero]) {
      expect(await eventOf(CHAT_A1, m)).toMatchObject({ outcome: 'tidak_terbaca' });
      expect(replyTo(m).text).toMatch(/Total tidak terbaca/);
    }
    expect(await allInvoices()).toEqual([]);

    ocr.script(S1_OK, s2({ totalConfidence: 0.7 }));
    const edge = await sendPhoto(img);
    await drain();
    expect(await eventOf(CHAT_A1, edge)).toMatchObject({ outcome: 'tersimpan' });
  });

  it('bytes that are not an image end as tidak_terbaca and store nothing', async () => {
    ocr.script(S1_OK, s2());
    const msg = await sendPhoto(Buffer.from('this is not a jpeg'));
    expect(await drain()).toEqual([expect.objectContaining({ result: 'done' })]);
    expect(await eventOf(CHAT_A1, msg)).toMatchObject({ outcome: 'tidak_terbaca' });
    expect(await allInvoices()).toEqual([]);
    expect(storage.puts).toEqual([]);
  });

  it('photo size boundary: a file exactly at the limit is read; one byte over is refused before download and OCR', async () => {
    const img = await receipt(SEED.size);
    config.maxPhotoBytes = img.length;
    ocr.script(S1_OK, s2());
    const exact = await sendPhoto(img);
    await drain();
    expect(await eventOf(CHAT_A1, exact)).toMatchObject({ outcome: 'tersimpan' });

    const big = await receipt(SEED.size, { quality: 95 });
    expect(big.length).toBeGreaterThan(img.length);
    const downloadsBefore = tg.downloads.length;
    const over = await sendPhoto(big);
    await drain();
    expect(await eventOf(CHAT_A1, over)).toMatchObject({ outcome: 'tidak_terbaca' });
    expect(replyTo(over).text).toMatch(/terlalu besar/);
    expect(tg.downloads).toHaveLength(downloadsBefore);
    expect(ocr.calls.filter((c) => c.stage === 'classify')).toHaveLength(1);
  });
});

describe('OCR transport errors: ocr_error, retry, give up', () => {
  const expectRunAtIn = async (seconds: number) => {
    const [j] = await owner(() => db.select().from(jobs).where(sql`done_at IS NULL AND failed_at IS NULL`));
    const delta = j!.runAt.getTime() - Date.now();
    expect(delta).toBeGreaterThan((seconds - 5) * 1000);
    expect(delta).toBeLessThan((seconds + 5) * 1000);
  };

  it('OcrError marks the event ocr_error and retries at 30/120/600 s; after attempt 4 the outcome is gagal, one failure reply is sent and the admin log fires', async () => {
    const img = await receipt(SEED.err);
    for (let i = 0; i < PHOTO_MAX_ATTEMPTS; i++) ocr.script(new OcrError('OCR stage1: HTTP 503'));
    const msg = await sendPhoto(img);

    for (const backoff of [30, 120, 600]) {
      expect(await drain()).toEqual([expect.objectContaining({ kind: JOB_PHOTO, result: 'retry' })]);
      const ev = await eventOf(CHAT_A1, msg);
      expect(ev).toMatchObject({ outcome: 'ocr_error' });
      expect(ev!.error).toMatch(/OcrError/);
      await expectRunAtIn(backoff);
      expect(tg.sent).toEqual([]); // nothing said to the group while retrying
      await makeDue();
    }
    expect(await drain()).toEqual([expect.objectContaining({ kind: JOB_PHOTO, result: 'failed' })]);
    expect(ocr.calls).toHaveLength(PHOTO_MAX_ATTEMPTS);

    const [j] = await allJobs();
    expect(j).toMatchObject({ attempts: PHOTO_MAX_ATTEMPTS });
    expect(j!.failedAt).toBeInstanceOf(Date);
    expect(await eventOf(CHAT_A1, msg)).toMatchObject({ outcome: 'gagal' });
    expect(tg.sent).toHaveLength(1);
    expect(tg.sent[0]).toMatchObject({ chatId: CHAT_A1, replyTo: msg, text: REPLY.failure });
    expect(logs.find((l) => l.msg === 'intake_photo_failed')?.meta).toMatchObject({ companyId: A, chatId: CHAT_A1, messageId: msg });
    expect(await allInvoices()).toEqual([]);
    expect(await allAttachments()).toEqual([]);
    expect(storage.puts).toEqual([]);

    await makeDue();
    expect(await drain()).toEqual([]);
  });

  it('the reply after giving up does not promise a retry that will never happen', async () => {
    const img = await receipt(SEED.err);
    for (let i = 0; i < PHOTO_MAX_ATTEMPTS; i++) ocr.script(new OcrError('OCR stage1: timeout'));
    const msg = await sendPhoto(img);
    for (let i = 0; i < PHOTO_MAX_ATTEMPTS; i++) { await drain(); await makeDue(); }
    expect(await eventOf(CHAT_A1, msg)).toMatchObject({ outcome: 'gagal' });
    const text = replyTo(msg).text;
    // the job is dead: telling staff "akan dicoba lagi, tidak perlu kirim ulang" loses the receipt
    expect(text).not.toMatch(/akan dicoba lagi/i);
    expect(text).not.toMatch(/tidak perlu kirim ulang/i);
  });

  it('an OcrError at stage 2 followed by success on the retry saves the row once and clears the error', async () => {
    const img = await receipt(SEED.err);
    ocr.script(S1_OK, new OcrError('OCR stage2: HTTP 429'));
    const msg = await sendPhoto(img);
    expect(await drain()).toEqual([expect.objectContaining({ result: 'retry' })]);
    expect(await eventOf(CHAT_A1, msg)).toMatchObject({ outcome: 'ocr_error' });
    expect(storage.puts).toEqual([]);

    ocr.script(S1_OK, s2());
    await makeDue();
    expect(await drain()).toEqual([expect.objectContaining({ result: 'done' })]);
    expect(await eventOf(CHAT_A1, msg)).toMatchObject({ outcome: 'tersimpan', error: null });
    expect(await allInvoices()).toHaveLength(1);
    expect(tg.sent).toHaveLength(1);
  });
});

describe('V9: near-duplicate (pHash ≤ 6, same site, 90 days)', () => {
  it('a re-encoded copy of an earlier photo is saved with near_duplicate and perlu_cek, naming the earlier row; chat OK is refused', async () => {
    const first = await savedPhoto(SEED.near);
    const copy = await receipt(SEED.near, { quality: 40 });
    ocr.script(S1_OK, s2());
    const msg = await sendPhoto(copy);
    await drain();
    const ev = await eventOf(CHAT_A1, msg);
    expect(ev).toMatchObject({ outcome: 'tersimpan' }); // different bytes: not a V8 duplicate
    const row = await rowById(ev!.vendorInvoiceId!);
    expect(row.status).toBe('perlu_cek');
    expect(row.confidence.flags).toContain('near_duplicate');
    expect(row.confidence.nearDuplicates).toEqual([{ rowId: first.row.rowId, distance: hammingDistance(first.row.phash!, row.phash!) }]);
    expect(replyTo(msg).text).toMatch(/mirip nota lain/);

    const ok = await sendText('OK', { replyTo: replyTo(msg).messageId });
    await drain();
    expect(replyTo(ok).text).toMatch(/Belum bisa dikonfirmasi.*mirip nota lain/);
    expect((await rowById(row.id)).status).toBe('perlu_cek');
  });

  it('the same copy sent to another site\'s group is not flagged', async () => {
    await savedPhoto(SEED.near);
    ocr.script(S1_OK, s2());
    const msg = await sendPhoto(await receipt(SEED.near, { quality: 40 }), { chat: CHAT_A2, from: TG.otherSite });
    await drain();
    const row = await rowById((await eventOf(CHAT_A2, msg))!.vendorInvoiceId!);
    expect(row.siteId).toBe(s2Site);
    expect(row.status).toBe('perlu_konfirmasi');
    expect(row.confidence.flags).not.toContain('near_duplicate');
    expect(row.confidence.nearDuplicates).toEqual([]);
  });

  it('window: a copy 89 days later is flagged, one 91 days later is not', async () => {
    await savedPhoto(SEED.near);
    clock = daysFromNow(89);
    ocr.script(S1_OK, s2());
    const m89 = await sendPhoto(await receipt(SEED.near, { quality: 40 }));
    await drain();
    expect((await rowById((await eventOf(CHAT_A1, m89))!.vendorInvoiceId!)).confidence.flags).toContain('near_duplicate');

    clock = daysFromNow(91);
    ocr.script(S1_OK, s2());
    const m91 = await sendPhoto(await receipt(SEED.near, { width: 380 }));
    await drain();
    const late = await rowById((await eventOf(CHAT_A1, m91))!.vendorInvoiceId!);
    expect(late.confidence.flags).not.toContain('near_duplicate');
    expect(late.status).toBe('perlu_konfirmasi');
  });
});

describe('V10: vendor by trigram, category fallback', () => {
  it('"PT. Sumber Beton" matches vendor "PT Sumber Beton"; the vendor default category wins over a keyword; vendor PII stays out of the reply', async () => {
    const { row, summary } = await savedPhoto(SEED.vendor, s2({ vendor: 'PT. Sumber Beton', description: 'Sewa excavator 2 hari' }));
    expect(row).toMatchObject({ vendorId: vendorSB, vendorName: 'PT. Sumber Beton', category: 'material', status: 'perlu_konfirmasi' });
    expectNoPii(summary.text);
  });

  it('an unmatched vendor keeps vendor_id null and takes the whole-word keyword category', async () => {
    const { row } = await savedPhoto(SEED.vendor2, s2({ vendor: 'Toko Bangunan Makmur', description: 'Sewa excavator 2 hari' }));
    expect(row).toMatchObject({ vendorId: null, vendorName: 'Toko Bangunan Makmur', category: 'alat' });
  });

  it('another company\'s vendor is never matched; with no keyword the category is null and chat OK waits for KATEGORI', async () => {
    const { row, summary } = await savedPhoto(SEED.cat, s2({ vendor: 'CV Maju Jaya', description: 'Pembelian barang' }));
    expect(row).toMatchObject({ vendorId: null, category: null, status: 'perlu_konfirmasi' });
    expect(row.confidence.flags).toEqual(['kategori_kosong']);
    expect(summary.text).toMatch(/kategori belum ditentukan/);

    const ok1 = await sendText('OK', { replyTo: summary.messageId });
    await drain();
    expect(replyTo(ok1).text).toBe(REPLY.confirmBlocked(['kategori_kosong']));
    expect((await rowById(row.id)).status).toBe('perlu_konfirmasi');

    await sendText('KATEGORI peralatan', { replyTo: summary.messageId });
    await drain();
    expect(await rowById(row.id)).toMatchObject({ category: 'alat', status: 'perlu_konfirmasi' });

    await sendText('OK', { replyTo: summary.messageId });
    await drain();
    const confirmed = await rowById(row.id);
    expect(confirmed.status).toBe('terkonfirmasi');
    // the master vendor it now points at belongs to company A, never B's "CV Maju Jaya"
    expect(confirmed.vendorId).not.toBe(vendorB);
    const [v] = await withCompany(db, A, (tx) => tx.select().from(vendors).where(eq(vendors.id, confirmed.vendorId!)));
    expect(v).toMatchObject({ companyId: A, name: 'CV Maju Jaya', status: 'draft' });
  });
});

describe('corrections: who may correct', () => {
  it('ignores, silently, senders without a Telegram link, non-members, members without access to the site, inactive users and messages without a sender', async () => {
    const { row, summary } = await savedPhoto(SEED.ignored);
    const sentBefore = tg.sent.length;
    const cases: Array<{ from: number | null; why: string }> = [
      { from: TG.stranger, why: 'no users.telegram_user_id link' },
      { from: TG.bob, why: 'member of another company only' },
      { from: TG.otherSite, why: 'site_staff of another site' },
      { from: TG.inactive, why: 'deactivated account' },
      { from: null, why: 'no from at all' },
    ];
    for (const c of cases) {
      const msg = await sendText('TOTAL 999000', { replyTo: summary.messageId, from: c.from });
      expect(await drain(), c.why).toEqual([expect.objectContaining({ kind: JOB_CORRECTION, result: 'done' })]);
      expect(await eventOf(CHAT_A1, msg), c.why).toMatchObject({ outcome: 'diabaikan' });
    }
    expect(tg.sent).toHaveLength(sentBefore);
    expect(await rowById(row.id)).toMatchObject({ totalCents: row.totalCents, status: row.status });
    expect(await chatCorrectionAudits()).toEqual([]);

    // control: a finance member (every site) is accepted
    const fin = await sendText('TOTAL 999000', { replyTo: summary.messageId, from: TG.finance });
    await drain();
    expect(await eventOf(CHAT_A1, fin)).toMatchObject({ outcome: 'koreksi_ok' });
    expect((await rowById(row.id)).totalCents).toBe(99_900_000);
  });
});

describe('corrections: which row', () => {
  it('"#xxxx" (last 4 hex of row_id) resolves the row without a reply, in either case', async () => {
    const { row } = await savedPhoto(SEED.ref);
    const ref = shortRef(row.rowId);
    const m1 = await sendText(`#${ref} TOTAL 2450000`);
    await drain();
    expect(await eventOf(CHAT_A1, m1)).toMatchObject({ outcome: 'koreksi_ok', vendorInvoiceId: row.id });
    expect((await rowById(row.id)).totalCents).toBe(245_000_000);
    expect(replyTo(m1).text).toContain(`#${ref}`);

    const m2 = await sendText(`OK #${ref.toUpperCase()}`);
    await drain();
    expect(await eventOf(CHAT_A1, m2)).toMatchObject({ outcome: 'koreksi_ok' });
    expect((await rowById(row.id)).status).toBe('terkonfirmasi');
    expect(await invoicesOf(A)).toHaveLength(1);
  });

  it('an unknown "#xxxx" and a "#xxxx" sent from another site\'s group are refused with the ambiguity reply and change nothing', async () => {
    const { row } = await savedPhoto(SEED.ref);
    const ref = shortRef(row.rowId);
    const unknownRef = ref === '0000' ? '0001' : '0000';
    const m1 = await sendText(`#${unknownRef} TOTAL 2450000`);
    const m2 = await sendText(`#${ref} TOTAL 2450000`, { chat: CHAT_A2, from: TG.admin });
    await drain();
    expect(await eventOf(CHAT_A1, m1)).toMatchObject({ outcome: 'koreksi_ditolak' });
    expect(await eventOf(CHAT_A2, m2)).toMatchObject({ outcome: 'koreksi_ditolak' });
    expect(replyTo(m1).text).toBe(REPLY.ambiguousRef);
    expect(replyTo(m2).text).toBe(REPLY.ambiguousRef);
    expect(await rowById(row.id)).toMatchObject({ totalCents: row.totalCents });
  });

  it('two open rows ending in the same 4 hex: "#xxxx" is ambiguous, a reply to the bot summary still resolves', async () => {
    const a = await savedPhoto(SEED.ref);
    const b = await savedPhoto(SEED.ref2, s2({ vendor: 'Toko Lain', description: 'Pasir 3 m3' }));
    const ref = shortRef(a.row.rowId);
    const collided = `${b.row.rowId.slice(0, -4)}${a.row.rowId.slice(-4)}`;
    await owner(() => db.update(vendorInvoices).set({ rowId: collided }).where(eq(vendorInvoices.id, b.row.id)));

    const amb = await sendText(`#${ref} TOTAL 1500000`);
    await drain();
    expect(replyTo(amb).text).toBe(REPLY.ambiguousRef);
    expect((await rowById(a.row.id)).totalCents).toBe(a.row.totalCents);
    expect((await rowById(b.row.id)).totalCents).toBe(b.row.totalCents);

    const viaReply = await sendText(`#${ref} TOTAL 1500000`, { replyTo: a.summary.messageId });
    await drain();
    expect(await eventOf(CHAT_A1, viaReply)).toMatchObject({ outcome: 'koreksi_ok', vendorInvoiceId: a.row.id });
    expect((await rowById(a.row.id)).totalCents).toBe(150_000_000);
    expect((await rowById(b.row.id)).totalCents).toBe(b.row.totalCents);
  });
});

describe('corrections: closed rows and command values', () => {
  it('a correction on a terkonfirmasi row (reply to the summary) is refused with "sudah dikonfirmasi; ubah lewat admin", changes nothing, and is audited', async () => {
    const { row, summary } = await savedPhoto(SEED.closed);
    await sendText('OK', { replyTo: summary.messageId });
    await drain();
    const confirmed = await rowById(row.id);
    expect(confirmed.status).toBe('terkonfirmasi');

    const late = await sendText('TOTAL 1000', { replyTo: summary.messageId });
    await drain();
    expect(replyTo(late).text).toMatch(/sudah dikonfirmasi.*ubah lewat admin/i);
    expect(await eventOf(CHAT_A1, late)).toMatchObject({ outcome: 'koreksi_ditolak' });
    expect(await rowById(row.id)).toMatchObject({ totalCents: confirmed.totalCents, status: 'terkonfirmasi', confirmedBy: staffId });
    const audits = await chatCorrectionAudits();
    expect(audits.at(-1)).toMatchObject({ userId: staffId, auditableId: row.id, meta: expect.objectContaining({ command: 'total', ok: false }) });

    // a second OK is refused the same way (no re-confirmation, confirmed_at kept)
    const again = await sendText('OK', { replyTo: summary.messageId });
    await drain();
    expect(replyTo(again).text).toBe(REPLY.alreadyConfirmed);
    expect((await rowById(row.id)).confirmedAt).toEqual(confirmed.confirmedAt);
  });

  it('a "#xxxx" correction on a terkonfirmasi row is refused with the same "sudah dikonfirmasi; ubah lewat admin" answer', async () => {
    const { row, summary } = await savedPhoto(SEED.closed);
    await sendText('OK', { replyTo: summary.messageId });
    await drain();
    expect((await rowById(row.id)).status).toBe('terkonfirmasi');

    const msg = await sendText(`#${shortRef(row.rowId)} TOTAL 1000`);
    await drain();
    expect(await eventOf(CHAT_A1, msg)).toMatchObject({ outcome: 'koreksi_ditolak' });
    expect((await rowById(row.id)).totalCents).toBe(row.totalCents);
    expect(replyTo(msg).text).toBe(REPLY.alreadyConfirmed);
  });

  it('TOLAK closes the row as ditolak; later corrections are refused', async () => {
    const { row, summary } = await savedPhoto(SEED.closed);
    const t = await sendText('TOLAK', { replyTo: summary.messageId });
    await drain();
    expect((await rowById(row.id)).status).toBe('ditolak');
    expect(replyTo(t).text).toMatch(/ditolak/);
    const late = await sendText('OK', { replyTo: summary.messageId });
    await drain();
    expect(await eventOf(CHAT_A1, late)).toMatchObject({ outcome: 'koreksi_ditolak' });
    expect((await rowById(row.id)).status).toBe('ditolak');
  });

  it('unreadable values (TOTAL 0, TOTAL dua juta, KATEGORI makanan, TANGGAL 31/02/2026) are refused with the reason and change nothing', async () => {
    const { row, summary } = await savedPhoto(SEED.closed);
    const cases: Array<[string, RegExp]> = [
      ['TOTAL 0', /total tidak terbaca/],
      ['TOTAL dua juta', /total tidak terbaca/],
      ['KATEGORI makanan', /kategori tidak dikenal/],
      ['TANGGAL 31/02/2026', /tanggal tidak terbaca/],
    ];
    for (const [text, why] of cases) {
      const m = await sendText(text, { replyTo: summary.messageId });
      await drain();
      expect(await eventOf(CHAT_A1, m), text).toMatchObject({ outcome: 'koreksi_ditolak' });
      expect(replyTo(m).text, text).toMatch(why);
    }
    expect(await rowById(row.id)).toMatchObject({ totalCents: row.totalCents, category: row.category, invoiceDate: row.invoiceDate, status: row.status });
  });

  it('TANGGAL outside the project window raises date_range (perlu_cek); a valid date clears it; VENDOR with an unknown name creates a draft vendor', async () => {
    const { row, summary } = await savedPhoto(SEED.closed);
    await sendText('TANGGAL 01/01/2020', { replyTo: summary.messageId });
    await drain();
    const out = await rowById(row.id);
    expect(out).toMatchObject({ invoiceDate: '2020-01-01', status: 'perlu_cek' });
    expect(out.confidence.flags).toContain('date_range');

    await sendText(`TANGGAL ${dmy(daysFromNow(-1))}`, { replyTo: summary.messageId });
    await drain();
    const back = await rowById(row.id);
    expect(back).toMatchObject({ invoiceDate: isoDate(daysFromNow(-1)), status: 'perlu_konfirmasi' });
    expect(back.confidence.flags).not.toContain('date_range');

    await sendText('VENDOR Toko Baru Sentosa', { replyTo: summary.messageId });
    await drain();
    const withVendor = await rowById(row.id);
    const [draft] = await withCompany(db, A, (tx) => tx.select().from(vendors).where(eq(vendors.name, 'Toko Baru Sentosa')));
    expect(draft).toMatchObject({ companyId: A, status: 'draft' });
    expect(withVendor).toMatchObject({ vendorId: draft!.id, vendorName: 'Toko Baru Sentosa' });
  });

  it('second fence: a second receipt with the same vendor, date and total cannot be confirmed in chat', async () => {
    const answer = s2({ vendor: 'PT. Sumber Beton', description: 'Beton K-225 3 m3', total: 'Rp 4.500.000' });
    const a = await savedPhoto(SEED.fence, answer);
    const b = await savedPhoto(SEED.fence2, answer);
    expect([a.row.vendorId, b.row.vendorId]).toEqual([vendorSB, vendorSB]);

    await sendText('OK', { replyTo: a.summary.messageId });
    await drain();
    expect((await rowById(a.row.id)).status).toBe('terkonfirmasi');

    const okB = await sendText('OK', { replyTo: b.summary.messageId });
    await drain();
    expect(replyTo(okB).text).toBe(REPLY.duplicateConfirmed);
    expect(await eventOf(CHAT_A1, okB)).toMatchObject({ outcome: 'koreksi_ditolak' });
    expect((await rowById(b.row.id)).status).toBe('perlu_konfirmasi');
  });
});

describe('failures around the transaction', () => {
  it('sendMessage throwing after the save keeps the row, sets tersimpan_tanpa_balasan and does not retry; "#xxxx" still reaches the row', async () => {
    const img = await receipt(SEED.fail);
    ocr.script(S1_OK, s2());
    tg.failSends = 1;
    const msg = await sendPhoto(img);
    expect(await drain()).toEqual([expect.objectContaining({ kind: JOB_PHOTO, result: 'done' })]);
    const ev = await eventOf(CHAT_A1, msg);
    expect(ev).toMatchObject({ outcome: 'tersimpan_tanpa_balasan', replyMessageId: null });
    expect(ev!.vendorInvoiceId).not.toBeNull();
    expect(await allInvoices()).toHaveLength(1);
    expect(await allAttachments()).toHaveLength(1);
    expect(storage.objects.size).toBe(1);
    expect(tg.sent).toEqual([]);
    expect(logs.map((l) => l.msg)).toContain('intake_reply_failed');
    expect(JSON.stringify(logs)).not.toContain(OCR_BANK);

    await makeDue();
    expect(await drain()).toEqual([]);
    expect(ocr.calls).toHaveLength(2);

    const row = await rowById(ev!.vendorInvoiceId!);
    const ok = await sendText(`#${shortRef(row.rowId)} OK`);
    await drain();
    expect(await eventOf(CHAT_A1, ok)).toMatchObject({ outcome: 'koreksi_ok' });
    expect((await rowById(row.id)).status).toBe('terkonfirmasi');
  });

  it('when the DB transaction fails the uploaded original is deleted again, nothing is half-written, and the retry saves it', async () => {
    const img = await receipt(SEED.txfail);
    await owner(async () => {
      await db.execute(sql.raw(`CREATE OR REPLACE FUNCTION test_fail_attachment() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION 'simulated write failure'; END $$`));
      await db.execute(sql.raw(`CREATE TRIGGER test_fail_attachment BEFORE INSERT ON attachments FOR EACH ROW EXECUTE FUNCTION test_fail_attachment()`));
    });
    let msg = 0;
    try {
      ocr.script(S1_OK, s2());
      msg = await sendPhoto(img);
      expect(await drain()).toEqual([expect.objectContaining({ kind: JOB_PHOTO, result: 'retry' })]);
    } finally {
      await owner(() => db.execute(sql.raw(`DROP TRIGGER IF EXISTS test_fail_attachment ON attachments`)));
    }
    const key = intakeKey(A, sha256Hex(img), 'image/jpeg', clock);
    expect(storage.puts).toEqual([key]);
    expect(storage.deletes).toEqual([key]);
    expect(storage.objects.size).toBe(0);
    expect(await allInvoices()).toEqual([]);
    expect(await allAttachments()).toEqual([]);
    const ev = await eventOf(CHAT_A1, msg);
    expect(ev).toMatchObject({ vendorInvoiceId: null });
    expect(ev!.outcome).not.toBe('tersimpan');
    expect(tg.sent).toEqual([]);
    expect((await allJobs())[0]!.lastError).toMatch(/simulated write failure/);

    ocr.script(S1_OK, s2());
    await makeDue();
    expect(await drain()).toEqual([expect.objectContaining({ result: 'done' })]);
    expect(await eventOf(CHAT_A1, msg)).toMatchObject({ outcome: 'tersimpan' });
    expect(await allInvoices()).toHaveLength(1);
    expect(storage.objects.get(key)?.equals(img)).toBe(true);
  });

  it('the same photo saved by a concurrent job between the V8 check and the insert ends as duplikat and keeps the shared file', async () => {
    const img = await receipt(SEED.race);
    const sha = sha256Hex(img);
    const key = intakeKey(A, sha, 'image/jpeg', clock);
    let otherRowId = '';
    ocr.beforeExtract = async () => {
      await owner(async () => {
        const [inv] = await db.insert(vendorInvoices).values({
          companyId: A, siteId: s1, totalCents: 100_00, status: 'perlu_konfirmasi', source: 'telegram', imageHash: sha,
        }).returning();
        otherRowId = inv!.rowId;
        await db.insert(attachments).values({
          companyId: A, siteId: s1, attachableType: 'vendor_invoices', attachableId: inv!.id, path: key, mime: 'image/jpeg', size: img.length, sha256: sha,
        });
      });
      storage.objects.set(key, Buffer.from(img)); // the other job's upload
    };
    ocr.script(S1_OK, s2());
    const msg = await sendPhoto(img);
    expect(await drain()).toEqual([expect.objectContaining({ result: 'done' })]);
    expect(await eventOf(CHAT_A1, msg)).toMatchObject({ outcome: 'duplikat' });
    expect(replyTo(msg).text).toContain(`#${shortRef(otherRowId)}`);
    expect(await allInvoices()).toHaveLength(1);
    expect(storage.deletes).toEqual([]);
    expect(storage.objects.get(key)?.equals(img)).toBe(true);
  });
});

describe('idempotent jobs', () => {
  it('re-running a photo job on an event that is already final (tersimpan, tidak_terbaca, duplikat) does nothing', async () => {
    const saved = await savedPhoto(SEED.rerun);
    ocr.script({ doc_type: 'bukan_dokumen', quality: 0.9, reason: '' });
    const unread = await sendPhoto(await receipt(SEED.s1));
    const dup = await sendPhoto(saved.img);
    await drain();
    const events = [saved.event, (await eventOf(CHAT_A1, unread))!, (await eventOf(CHAT_A1, dup))!];
    expect(events.map((e) => e.outcome)).toEqual(['tersimpan', 'tidak_terbaca', 'duplikat']);

    const before = { ocr: ocr.calls.length, sent: tg.sent.length, getFile: tg.getFileCalls.length, puts: storage.puts.length };
    for (const e of events) await withApp(db, (tx) => enqueue(tx, { kind: JOB_PHOTO, companyId: A, payload: { intakeEventId: e.id } }));
    expect(await drain()).toEqual(events.map(() => expect.objectContaining({ kind: JOB_PHOTO, result: 'done' })));
    expect({ ocr: ocr.calls.length, sent: tg.sent.length, getFile: tg.getFileCalls.length, puts: storage.puts.length }).toEqual(before);
    expect(await allInvoices()).toHaveLength(1);
    expect(await allAttachments()).toHaveLength(1);
    expect((await allEvents()).map((e) => e.outcome)).toEqual(['tersimpan', 'tidak_terbaca', 'duplikat']);
  });

  it('re-running a correction job on a final event neither re-applies, re-audits nor re-replies', async () => {
    const { row, summary } = await savedPhoto(SEED.rerun);
    const t = await sendText('TOTAL 2450000', { replyTo: summary.messageId });
    await drain();
    const ev = (await eventOf(CHAT_A1, t))!;
    expect(ev.outcome).toBe('koreksi_ok');
    const sent = tg.sent.length;
    const audits = (await chatCorrectionAudits()).length;
    const updatedAt = (await rowById(row.id)).updatedAt;

    await withApp(db, (tx) => enqueue(tx, { kind: JOB_CORRECTION, companyId: A, payload: { intakeEventId: ev.id } }));
    expect(await drain()).toEqual([expect.objectContaining({ kind: JOB_CORRECTION, result: 'done' })]);
    expect(tg.sent).toHaveLength(sent);
    expect(await chatCorrectionAudits()).toHaveLength(audits);
    expect((await rowById(row.id)).updatedAt).toEqual(updatedAt);
  });

  it('a job whose intake event does not exist fails at once (no retries)', async () => {
    await withApp(db, (tx) => enqueue(tx, { kind: JOB_PHOTO, companyId: A, payload: { intakeEventId: 987_654 }, maxAttempts: PHOTO_MAX_ATTEMPTS }));
    expect(await drain()).toEqual([expect.objectContaining({ result: 'failed' })]);
    expect((await allJobs())[0]).toMatchObject({ attempts: 1 });
    expect(tg.sent).toEqual([]);
  });
});

describe('after intake: review API on the same data', () => {
  it('the photo route serves the exact original; the receipt NPWP is shown to finance but not to a project admin; internal ids never leave the API', async () => {
    const { img, row } = await savedPhoto(SEED.review, s2({ npwp: OCR_NPWP_TEXT, bank: `BCA ${OCR_BANK}` }));
    const as = (userId: number) => ({ headers: { 'x-dev-user-id': String(userId) } });

    const photo = await app.request(`/companies/${A}/intake/${row.rowId}/photo`, as(adminId));
    expect(photo.status).toBe(200);
    expect(photo.headers.get('content-type')).toBe('image/jpeg');
    expect(Buffer.from(await photo.arrayBuffer()).equals(img)).toBe(true);

    const finRes = await app.request(`/companies/${A}/intake/review`, as(financeId));
    const finBody = (await finRes.json()) as { data: Array<Record<string, unknown>> };
    expect(finBody.data).toHaveLength(1);
    expect(finBody.data[0]).toMatchObject({ rowId: row.rowId, npwp: OCR_NPWP_DIGITS });
    expect(finBody.data[0]).not.toHaveProperty('id');
    expect(finBody.data[0]).not.toHaveProperty('companyId');
    expect(JSON.stringify(finBody)).not.toContain(OCR_BANK);

    const adminRes = await app.request(`/companies/${A}/intake/review`, as(adminId));
    const adminText = await adminRes.text();
    expect(adminRes.status).toBe(200);
    expect(adminText).toContain(row.rowId);
    expect(adminText).not.toContain(OCR_NPWP_DIGITS);
    expect(adminText).not.toContain(OCR_BANK);
  });
});
