import { timingSafeEqual } from 'node:crypto';
import { sql } from 'drizzle-orm';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { headerAuthenticator } from '../../src/auth/authenticator.js';
import { companies, intakeEvents, jobs, sites, telegramChats } from '../../src/db/schema.js';
import { withApp, withCompany, type Db } from '../../src/db/tenant.js';
import { createApp } from '../../src/http/app.js';
import { secretMatches } from '../../src/http/routes/telegram.js';
import { CORRECTION_MAX_ATTEMPTS, JOB_CORRECTION, JOB_PHOTO, PHOTO_MAX_ATTEMPTS } from '../../src/intake/pipeline.js';
import { classifyUpdate } from '../../src/intake/telegram-update.js';
import { asOwner, createTestDb } from '../helpers/db.js';

// Pass-through spy on timingSafeEqual: lets the test see that secretMatches uses the constant-time
// primitive, while every other node:crypto user (PGlite, Better Auth, …) keeps the real module.
vi.mock('node:crypto', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:crypto')>();
  return { ...actual, timingSafeEqual: vi.fn(actual.timingSafeEqual) };
});

const SECRET = 'tg-webhook-secret-0123456789abcdef';
const WEBHOOK = '/telegram/webhook';

/** Telegram supergroup ids are large negatives; user ids exceed 2^31 — both must survive bigint columns. */
const CHAT_A = -1001000000001;
const CHAT_B = -1001000000002;
const CHAT_OFF = -1001000000003;
const CHAT_UNKNOWN = -1009999999999;
const STAFF_TG = 7_000_000_001;
const BOT_TG = 8_000_000_001;
const BOT_SUMMARY_MSG = 500;

let db: Db;
let close: () => Promise<void>;
let app: ReturnType<typeof createApp>;
let A = 0; let B = 0;
let siteA1 = 0; let siteA2 = 0; let siteB1 = 0;

// ---------------------------------------------------------------- update builders (Telegram Bot API shape)

let updateSeq = 1000;
const human = { id: STAFF_TG, is_bot: false, first_name: 'Budi', language_code: 'id' };
const botUser = { id: BOT_TG, is_bot: true, first_name: 'JIAT Bot', username: 'jiat_bot' };
const chat = (id: number) => ({ id, type: 'supergroup', title: 'JIAT Keerom — nota' });

function message(chatId: number, messageId: number, extra: Record<string, unknown>, from: Record<string, unknown> | null = human) {
  return {
    update_id: ++updateSeq,
    message: { message_id: messageId, date: 1_793_000_000, chat: chat(chatId), ...(from ? { from } : {}), ...extra },
  };
}

const PHOTO_SIZES = [
  { file_id: 'p-small', file_unique_id: 'u1', file_size: 1_200, width: 90, height: 120 },
  { file_id: 'p-large', file_unique_id: 'u3', file_size: 180_000, width: 960, height: 1280 },
  { file_id: 'p-medium', file_unique_id: 'u2', file_size: 24_000, width: 320, height: 427 },
];
const photoUpdate = (chatId: number, messageId: number, from: Record<string, unknown> | null = human) =>
  message(chatId, messageId, { photo: PHOTO_SIZES, caption: 'nota semen' }, from);
const textUpdate = (chatId: number, messageId: number, text: string, opts: { replyTo?: 'bot' | 'human'; from?: Record<string, unknown> } = {}) =>
  message(chatId, messageId, {
    text,
    ...(opts.replyTo ? {
      reply_to_message: {
        message_id: opts.replyTo === 'bot' ? BOT_SUMMARY_MSG : 77,
        date: 1_792_999_000,
        chat: chat(chatId),
        from: opts.replyTo === 'bot' ? botUser : { id: 7_000_000_099, is_bot: false, first_name: 'Ani' },
        text: 'Tersimpan #3f2a',
      },
    } : {}),
  }, opts.from ?? human);
const documentUpdate = (chatId: number, messageId: number, document: Record<string, unknown>) =>
  message(chatId, messageId, { document: { file_unique_id: 'd1', file_name: 'nota', ...document } });

// ---------------------------------------------------------------- HTTP + DB helpers

function post(body: unknown, opts: { secret?: string | null; raw?: string; to?: ReturnType<typeof createApp> } = {}) {
  const headers: Record<string, string> = { 'content-type': 'application/json' };
  const secret = opts.secret === undefined ? SECRET : opts.secret;
  if (secret !== null) headers['x-telegram-bot-api-secret-token'] = secret;
  return (opts.to ?? app).request(WEBHOOK, { method: 'POST', headers, body: opts.raw ?? JSON.stringify(body) });
}

/** Read as table owner (bypasses RLS) so a row stored under the wrong company is still seen. */
const allEvents = () => asOwner(db, () => db.select().from(intakeEvents).orderBy(intakeEvents.id));
const allJobs = () => asOwner(db, () => db.select().from(jobs).orderBy(jobs.id));
async function expectNothingStored(): Promise<void> {
  expect(await allEvents()).toEqual([]);
  expect(await allJobs()).toEqual([]);
}

beforeAll(async () => {
  ({ db, close } = await createTestDb());
  app = createApp({ db, auth: headerAuthenticator('test'), telegramWebhookSecret: SECRET });
  [A, B] = await withApp(db, async (tx) => {
    const cs = await tx.insert(companies).values([{ code: 'AAA', name: 'PT AAA' }, { code: 'BBB', name: 'PT BBB' }]).returning({ id: companies.id });
    return [cs[0]!.id, cs[1]!.id];
  });
  [siteA1, siteA2] = await withCompany(db, A, async (tx) => {
    const ss = await tx.insert(sites).values([
      { companyId: A, code: 'KRM', name: 'JIAT Keerom' },
      { companyId: A, code: 'BLM', name: 'JIAT Boalemo' },
    ]).returning({ id: sites.id });
    return [ss[0]!.id, ss[1]!.id];
  });
  siteB1 = await withCompany(db, B, async (tx) =>
    (await tx.insert(sites).values({ companyId: B, code: 'MWU', name: 'JIAT Morowali Utara' }).returning({ id: sites.id }))[0]!.id);
  await withApp(db, (tx) => tx.insert(telegramChats).values([
    { chatId: CHAT_A, companyId: A, siteId: siteA1, title: 'Nota KRM' },
    { chatId: CHAT_B, companyId: B, siteId: siteB1, title: 'Nota MWU' },
    { chatId: CHAT_OFF, companyId: A, siteId: siteA2, title: 'Nota BLM (lama)', isActive: false },
  ]));
});
beforeEach(async () => {
  await asOwner(db, async () => {
    await db.execute(sql`DELETE FROM jobs`);
    await db.execute(sql`DELETE FROM intake_events`);
  });
  vi.mocked(timingSafeEqual).mockClear();
});
afterAll(async () => { await close(); });

// ================================================================ secretMatches

describe('secretMatches (constant-time secret comparison)', () => {
  it('accepts only the exact secret', () => {
    expect(secretMatches(SECRET, SECRET)).toBe(true);
    expect(secretMatches('abc', 'abc')).toBe(true);
  });

  it('a missing or empty header never matches, even against an empty expected secret', () => {
    expect(secretMatches(undefined, SECRET)).toBe(false);
    expect(secretMatches('', SECRET)).toBe(false);
    expect(secretMatches(undefined, '')).toBe(false);
    expect(secretMatches('', '')).toBe(false);
  });

  it('different lengths (prefix, extension, one byte short) are false and never throw', () => {
    // crypto.timingSafeEqual throws RangeError on unequal lengths: the guard must come first
    expect(() => secretMatches(SECRET.slice(0, -1), SECRET)).not.toThrow();
    expect(secretMatches(SECRET.slice(0, -1), SECRET)).toBe(false);
    expect(secretMatches(`${SECRET}x`, SECRET)).toBe(false);
    expect(secretMatches('a', SECRET)).toBe(false);
    expect(secretMatches(SECRET, 'a')).toBe(false);
  });

  it('same character count but different byte length (multi-byte UTF-8) is false and never throws', () => {
    expect(() => secretMatches('é', 'e')).not.toThrow();
    expect(secretMatches('é', 'e')).toBe(false);
    expect(secretMatches('e', 'é')).toBe(false);
    expect(secretMatches('é', 'é')).toBe(true);
  });

  it('a difference in the first or the last byte is rejected alike', () => {
    expect(secretMatches(`X${SECRET.slice(1)}`, SECRET)).toBe(false);
    expect(secretMatches(`${SECRET.slice(0, -1)}X`, SECRET)).toBe(false);
  });

  it('equal-length inputs are compared with crypto.timingSafeEqual (no early exit)', () => {
    const spy = vi.mocked(timingSafeEqual);
    spy.mockClear();
    secretMatches(`X${SECRET.slice(1)}`, SECRET);
    expect(spy).toHaveBeenCalledTimes(1);
    const [a, b] = spy.mock.calls[0]!;
    expect(Buffer.from(a as Uint8Array).toString()).toBe(`X${SECRET.slice(1)}`);
    expect(Buffer.from(b as Uint8Array).toString()).toBe(SECRET);
    spy.mockClear();
    secretMatches('short', SECRET);
    expect(spy).not.toHaveBeenCalled(); // unequal lengths are decided by the length guard alone
  });
});

// ================================================================ classifyUpdate

describe('classifyUpdate', () => {
  it('a photo picks the largest size by area even when Telegram does not list it last', () => {
    expect(classifyUpdate(photoUpdate(CHAT_A, 10))).toEqual({
      kind: 'photo', chatId: CHAT_A, messageId: 10, fromId: STAFF_TG, fileId: 'p-large', mime: 'image/jpeg', fileSize: 180_000,
    });
  });

  it('the largest size is chosen by width × height, not by width or file size alone', () => {
    const u = message(CHAT_A, 11, {
      photo: [
        { file_id: 'wide', file_size: 900_000, width: 1600, height: 100 }, // 160 000 px, biggest file
        { file_id: 'tall', file_size: 50_000, width: 500, height: 500 }, // 250 000 px
      ],
    });
    expect(classifyUpdate(u)).toMatchObject({ kind: 'photo', fileId: 'tall', fileSize: 50_000 });
  });

  it('a single photo size without file_size gives fileSize null', () => {
    const u = message(CHAT_A, 12, { photo: [{ file_id: 'only', width: 640, height: 480 }] });
    expect(classifyUpdate(u)).toMatchObject({ kind: 'photo', fileId: 'only', fileSize: null });
  });

  it('edited_message and channel_post are ignored, even when they carry a photo or a correction', () => {
    const edited = { update_id: 1, edited_message: photoUpdate(CHAT_A, 13).message };
    const editedText = { update_id: 2, edited_message: textUpdate(CHAT_A, 14, 'TOTAL 2.450.000', { replyTo: 'bot' }).message };
    const channel = { update_id: 3, channel_post: photoUpdate(CHAT_A, 15).message };
    expect(classifyUpdate(edited)).toBeNull();
    expect(classifyUpdate(editedText)).toBeNull();
    expect(classifyUpdate(channel)).toBeNull();
  });

  it('a message sent by a bot (including ourselves) is ignored', () => {
    expect(classifyUpdate(photoUpdate(CHAT_A, 16, botUser))).toBeNull();
    expect(classifyUpdate(textUpdate(CHAT_A, 17, '#abcd OK', { from: botUser }))).toBeNull();
  });

  it('a message without a sender (anonymous admin) keeps fromId null', () => {
    expect(classifyUpdate(photoUpdate(CHAT_A, 18, null))).toMatchObject({ kind: 'photo', fromId: null });
  });

  it('an image sent as a file (jpeg/png/webp document) is a photo with its own mime; other documents are ignored', () => {
    for (const mime of ['image/jpeg', 'image/png', 'image/webp']) {
      expect(classifyUpdate(documentUpdate(CHAT_A, 19, { file_id: 'doc-1', mime_type: mime, file_size: 2_000_000 })))
        .toEqual({ kind: 'photo', chatId: CHAT_A, messageId: 19, fromId: STAFF_TG, fileId: 'doc-1', mime, fileSize: 2_000_000 });
    }
    expect(classifyUpdate(documentUpdate(CHAT_A, 20, { file_id: 'doc-2', mime_type: 'image/png' }))).toMatchObject({ fileSize: null });
    for (const mime of ['application/pdf', 'image/gif', 'image/png; x', 'text/plain', '']) {
      expect(classifyUpdate(documentUpdate(CHAT_A, 21, { file_id: 'doc-3', mime_type: mime }))).toBeNull();
    }
    expect(classifyUpdate(documentUpdate(CHAT_A, 22, { file_id: 'doc-4' }))).toBeNull(); // no mime_type at all
  });

  it('text keeps the reply target and whether it replies to a bot', () => {
    expect(classifyUpdate(textUpdate(CHAT_A, 23, 'TOTAL 2.450.000', { replyTo: 'bot' }))).toEqual({
      kind: 'text', chatId: CHAT_A, messageId: 23, fromId: STAFF_TG, text: 'TOTAL 2.450.000', replyToMessageId: BOT_SUMMARY_MSG, replyToBot: true,
    });
    expect(classifyUpdate(textUpdate(CHAT_A, 24, 'TOTAL 2.450.000', { replyTo: 'human' }))).toMatchObject({ replyToMessageId: 77, replyToBot: false });
    expect(classifyUpdate(textUpdate(CHAT_A, 25, '#abcd OK'))).toMatchObject({ kind: 'text', replyToMessageId: null, replyToBot: false });
  });

  it('empty or whitespace-only text, an empty photo list and service messages are nothing to do', () => {
    expect(classifyUpdate(textUpdate(CHAT_A, 26, ''))).toBeNull();
    expect(classifyUpdate(textUpdate(CHAT_A, 27, '   \n\t'))).toBeNull();
    expect(classifyUpdate(message(CHAT_A, 28, { photo: [] }))).toBeNull();
    expect(classifyUpdate(message(CHAT_A, 29, { new_chat_members: [{ id: 1, is_bot: false, first_name: 'X' }] }))).toBeNull();
    expect(classifyUpdate(message(CHAT_A, 30, { sticker: { file_id: 's', width: 512, height: 512 } }))).toBeNull();
  });

  it('a photo wins over its caption, so a captioned receipt is never read as a correction', () => {
    const u = message(CHAT_A, 31, { photo: PHOTO_SIZES, caption: '#abcd OK', text: '#abcd OK' });
    expect(classifyUpdate(u)).toMatchObject({ kind: 'photo', fileId: 'p-large' });
  });

  it('anything that is not a Telegram update is null, never an exception', () => {
    for (const raw of [null, undefined, '', 'update', 42, true, [], {}, { update_id: '1' }, { update_id: 1.5 },
      { update_id: 1, message: null }, { update_id: 1, message: { message_id: 1 } },
      { update_id: 1, message: { message_id: 'x', chat: { id: CHAT_A }, text: '#abcd OK' } },
      { update_id: 1, callback_query: { id: 'q', data: 'ok' } }]) {
      expect(() => classifyUpdate(raw)).not.toThrow();
      expect(classifyUpdate(raw)).toBeNull();
    }
  });
});

// ================================================================ POST /telegram/webhook

describe('POST /telegram/webhook — secret token', () => {
  it('answers 404 when the webhook secret is not configured (absent or empty), whatever the header', async () => {
    const noSecret = createApp({ db, auth: headerAuthenticator('test') });
    const emptySecret = createApp({ db, auth: headerAuthenticator('test'), telegramWebhookSecret: '' });
    for (const to of [noSecret, emptySecret]) {
      expect((await post(photoUpdate(CHAT_A, 100), { to })).status).toBe(404);
      expect((await post(photoUpdate(CHAT_A, 100), { to, secret: null })).status).toBe(404);
      expect((await post(photoUpdate(CHAT_A, 100), { to, secret: '' })).status).toBe(404);
    }
    await expectNothingStored();
  });

  it('a missing, empty, wrong, truncated or extended secret is 403 and stores nothing', async () => {
    for (const secret of [null, '', 'wrong', SECRET.slice(0, -1), `${SECRET}x`, SECRET.toUpperCase(), `X${SECRET.slice(1)}`]) {
      const res = await post(photoUpdate(CHAT_A, 101), { secret });
      expect(res.status, `secret ${JSON.stringify(secret)}`).toBe(403);
    }
    await expectNothingStored();
  });

  it('the secret is checked before the body is read: malformed JSON with a wrong secret is 403', async () => {
    expect((await post(null, { secret: 'wrong', raw: '{not json' })).status).toBe(403);
    expect((await post(null, { secret: null, raw: '' })).status).toBe(403);
  });

  it('the right secret is enough: no user session is needed (Telegram sends no cookie)', async () => {
    const res = await post(photoUpdate(CHAT_A, 102));
    expect(res.status).toBe(200);
    expect(await allEvents()).toHaveLength(1);
  });
});

describe('POST /telegram/webhook — chat mapping', () => {
  it('an unknown chat is answered 200 and nothing is stored (photo or correction)', async () => {
    expect((await post(photoUpdate(CHAT_UNKNOWN, 200))).status).toBe(200);
    expect((await post(textUpdate(CHAT_UNKNOWN, 201, 'TOTAL 2.450.000', { replyTo: 'bot' }))).status).toBe(200);
    expect((await post(textUpdate(CHAT_UNKNOWN, 202, '#abcd OK'))).status).toBe(200);
    await expectNothingStored();
  });

  it('an inactive chat is answered 200 and nothing is stored', async () => {
    expect((await post(photoUpdate(CHAT_OFF, 210))).status).toBe(200);
    expect((await post(textUpdate(CHAT_OFF, 211, 'OK #abcd'))).status).toBe(200);
    await expectNothingStored();
  });

  it('a photo stores an intake_event and a photo job under the chat\'s company and site', async () => {
    const res = await post(photoUpdate(CHAT_A, 220));
    expect(res.status).toBe(200);

    const evs = await allEvents();
    expect(evs).toHaveLength(1);
    const ev = evs[0]!;
    expect(ev).toMatchObject({
      companyId: A, siteId: siteA1, chatId: CHAT_A, messageId: 220, fromUserId: STAFF_TG, kind: 'photo', outcome: 'pending',
      vendorInvoiceId: null, replyMessageId: null, error: null,
    });
    // the largest size, never the whole update (no caption, no sender name)
    expect(ev.payload).toEqual({ fileId: 'p-large', mime: 'image/jpeg', fileSize: 180_000 });

    const js = await allJobs();
    expect(js).toHaveLength(1);
    expect(js[0]).toMatchObject({
      kind: JOB_PHOTO, companyId: A, payload: { intakeEventId: ev.id }, attempts: 0, maxAttempts: PHOTO_MAX_ATTEMPTS,
      doneAt: null, failedAt: null, lockedAt: null,
    });
    expect(js[0]!.runAt.getTime()).toBeLessThanOrEqual(Date.now() + 1_000); // due at once
  });

  it('a chat of another company lands in that company only (RLS sees it there and nowhere else)', async () => {
    expect((await post(photoUpdate(CHAT_B, 230))).status).toBe(200);
    const [ev] = await allEvents();
    expect(ev).toMatchObject({ companyId: B, siteId: siteB1, chatId: CHAT_B, messageId: 230 });
    expect((await allJobs())[0]).toMatchObject({ kind: JOB_PHOTO, companyId: B, payload: { intakeEventId: ev!.id } });

    expect(await withCompany(db, B, (tx) => tx.select({ id: intakeEvents.id }).from(intakeEvents))).toEqual([{ id: ev!.id }]);
    expect(await withCompany(db, A, (tx) => tx.select({ id: intakeEvents.id }).from(intakeEvents))).toEqual([]);
  });

  it('a sender without `from` is stored with from_user_id null', async () => {
    expect((await post(photoUpdate(CHAT_A, 240, null))).status).toBe(200);
    expect((await allEvents())[0]).toMatchObject({ messageId: 240, fromUserId: null });
  });
});

describe('POST /telegram/webhook — idempotency per (chat_id, message_id)', () => {
  it('the same photo message delivered twice gives exactly one event and one job', async () => {
    expect((await post(photoUpdate(CHAT_A, 300))).status).toBe(200);
    expect((await post(photoUpdate(CHAT_A, 300))).status).toBe(200);
    const evs = await allEvents();
    expect(evs).toHaveLength(1);
    const js = await allJobs();
    expect(js).toHaveLength(1);
    expect(js[0]!.payload).toEqual({ intakeEventId: evs[0]!.id });
  });

  it('the same correction delivered twice gives exactly one event and one job', async () => {
    const u = textUpdate(CHAT_A, 301, 'TOTAL 2.450.000', { replyTo: 'bot' });
    expect((await post(u)).status).toBe(200);
    expect((await post(u)).status).toBe(200);
    expect(await allEvents()).toHaveLength(1);
    expect(await allJobs()).toHaveLength(1);
  });

  it('two overlapping deliveries of one message still give one event and one job, both answered 200', async () => {
    const u = photoUpdate(CHAT_A, 302);
    const [r1, r2] = await Promise.all([post(u), post(u)]);
    expect([r1.status, r2.status]).toEqual([200, 200]);
    expect(await allEvents()).toHaveLength(1);
    expect(await allJobs()).toHaveLength(1);
  });

  it('the key is the pair: the same message_id in another chat is a different message', async () => {
    await post(photoUpdate(CHAT_A, 303));
    await post(photoUpdate(CHAT_B, 303));
    const evs = await allEvents();
    expect(evs.map((e) => [e.chatId, e.companyId])).toEqual([[CHAT_A, A], [CHAT_B, B]]);
    expect((await allJobs()).map((j) => j.companyId)).toEqual([A, B]);
  });

  it('if the job cannot be queued the event is rolled back and the answer is not 200, so Telegram\'s retry is processed', async () => {
    await asOwner(db, async () => {
      await db.execute(sql.raw(`CREATE OR REPLACE FUNCTION test_fail_job_insert() RETURNS trigger LANGUAGE plpgsql AS $$
        BEGIN RAISE EXCEPTION 'queue unavailable'; END $$`));
      await db.execute(sql.raw(`CREATE TRIGGER test_fail_job_insert BEFORE INSERT ON jobs FOR EACH ROW EXECUTE FUNCTION test_fail_job_insert()`));
    });
    const quiet = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    let failed: Response;
    try {
      failed = await post(photoUpdate(CHAT_A, 304));
    } finally {
      quiet.mockRestore();
      await asOwner(db, async () => {
        await db.execute(sql.raw(`DROP TRIGGER IF EXISTS test_fail_job_insert ON jobs`));
        await db.execute(sql.raw(`DROP FUNCTION IF EXISTS test_fail_job_insert()`));
      });
    }
    expect(failed.status).not.toBe(200);
    await expectNothingStored(); // no orphan event that would swallow the re-delivery

    expect((await post(photoUpdate(CHAT_A, 304))).status).toBe(200);
    expect(await allEvents()).toHaveLength(1);
    expect(await allJobs()).toHaveLength(1);
  });
});

describe('POST /telegram/webhook — what is kept', () => {
  it('chat text that is not a correction is answered 200 and not stored', async () => {
    const texts: Array<[string, { replyTo?: 'bot' | 'human' }]> = [
      ['selamat pagi, semen sudah datang', {}],
      ['TOTAL 2.450.000', {}], // a command, but neither a reply to the bot nor a #ref
      ['TOTAL 2.450.000', { replyTo: 'human' }], // replying to a colleague is not replying to the bot
      ['#abcd', {}], // a ref without a command
      ['#abcde OK', {}], // 5 hex digits is not a row ref
      ['#wxyz OK', {}], // not hex
      ['siap pak', { replyTo: 'bot' }], // reply to the bot but no command
    ];
    let id = 400;
    for (const [text, opts] of texts) {
      expect((await post(textUpdate(CHAT_A, id++, text, opts))).status, text).toBe(200);
    }
    await expectNothingStored();
  });

  it('a reply to the bot\'s summary with a command is stored as a correction and queued', async () => {
    expect((await post(textUpdate(CHAT_A, 410, 'TOTAL 2.450.000', { replyTo: 'bot' }))).status).toBe(200);
    const [ev] = await allEvents();
    expect(ev).toMatchObject({ companyId: A, siteId: siteA1, chatId: CHAT_A, messageId: 410, fromUserId: STAFF_TG, kind: 'correction', outcome: 'pending' });
    expect(ev!.payload).toEqual({ text: 'TOTAL 2.450.000', replyToMessageId: BOT_SUMMARY_MSG, replyToBot: true });
    const js = await allJobs();
    expect(js).toHaveLength(1);
    expect(js[0]).toMatchObject({ kind: JOB_CORRECTION, companyId: A, payload: { intakeEventId: ev!.id }, maxAttempts: CORRECTION_MAX_ATTEMPTS });
  });

  it('a text with a "#xxxx" row reference is a correction without being a reply (any case, either position)', async () => {
    expect((await post(textUpdate(CHAT_A, 420, '#abcd OK'))).status).toBe(200);
    expect((await post(textUpdate(CHAT_A, 421, 'kategori material #AB12'))).status).toBe(200);
    const evs = await allEvents();
    expect(evs.map((e) => [e.messageId, e.kind])).toEqual([[420, 'correction'], [421, 'correction']]);
    expect(evs[0]!.payload).toEqual({ text: '#abcd OK', replyToMessageId: null, replyToBot: false });
    expect((await allJobs()).map((j) => j.kind)).toEqual([JOB_CORRECTION, JOB_CORRECTION]);
  });

  it('a recognised command with an unreadable value is still queued, so the bot can say why', async () => {
    expect((await post(textUpdate(CHAT_A, 430, 'TOTAL banyak', { replyTo: 'bot' }))).status).toBe(200);
    expect((await allEvents())[0]).toMatchObject({ kind: 'correction', payload: { text: 'TOTAL banyak' } });
    expect(await allJobs()).toHaveLength(1);
  });

  it('an image sent as a document is accepted as a photo with its mime type', async () => {
    expect((await post(documentUpdate(CHAT_A, 440, { file_id: 'doc-png', mime_type: 'image/png', file_size: 3_400_000 }))).status).toBe(200);
    const [ev] = await allEvents();
    expect(ev).toMatchObject({ kind: 'photo', messageId: 440, companyId: A, siteId: siteA1 });
    expect(ev!.payload).toEqual({ fileId: 'doc-png', mime: 'image/png', fileSize: 3_400_000 });
    expect((await allJobs())[0]).toMatchObject({ kind: JOB_PHOTO, payload: { intakeEventId: ev!.id } });
  });

  it('a PDF (or any non-image) document is answered 200 and ignored', async () => {
    expect((await post(documentUpdate(CHAT_A, 450, { file_id: 'doc-pdf', mime_type: 'application/pdf', file_size: 90_000 }))).status).toBe(200);
    expect((await post(documentUpdate(CHAT_A, 451, { file_id: 'doc-x' }))).status).toBe(200);
    await expectNothingStored();
  });

  it('malformed JSON, an empty body and JSON that is not an update are answered 200 with nothing stored', async () => {
    for (const raw of ['{not json', '', '{"update_id": 1, "message": ', 'null', '[]', '{}', '"text"', '42',
      JSON.stringify({ update_id: 1, message: { message_id: 'x', chat: { id: CHAT_A }, photo: PHOTO_SIZES } })]) {
      expect((await post(null, { raw })).status, raw).toBe(200);
    }
    await expectNothingStored();
  });

  it('a message from a bot is ignored (photo or correction)', async () => {
    expect((await post(photoUpdate(CHAT_A, 460, botUser))).status).toBe(200);
    expect((await post(textUpdate(CHAT_A, 461, '#abcd OK', { from: botUser }))).status).toBe(200);
    await expectNothingStored();
  });

  it('edited messages and updates without a message (member changes, button presses) are ignored', async () => {
    const edited = { update_id: ++updateSeq, edited_message: textUpdate(CHAT_A, 470, 'TOTAL 2.450.000', { replyTo: 'bot' }).message };
    const editedPhoto = { update_id: ++updateSeq, edited_message: photoUpdate(CHAT_A, 471).message };
    const member = { update_id: ++updateSeq, my_chat_member: { chat: chat(CHAT_A), from: human, date: 1, old_chat_member: {}, new_chat_member: {} } };
    const button = { update_id: ++updateSeq, callback_query: { id: 'cb', from: human, data: 'ok' } };
    for (const u of [edited, editedPhoto, member, button]) expect((await post(u)).status).toBe(200);
    await expectNothingStored();
  });
});
