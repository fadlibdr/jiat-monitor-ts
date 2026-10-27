import { asc, eq } from 'drizzle-orm';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { headerAuthenticator } from '../../src/auth/authenticator.js';
import { jobs, telegramLinkCodes, users } from '../../src/db/schema.js';
import { withApp, type Db } from '../../src/db/tenant.js';
import { createApp } from '../../src/http/app.js';
import type { TelegramApi } from '../../src/intake/telegram-api.js';
import { runOnce } from '../../src/jobs/queue.js';
import { opsRegistry } from '../../src/ops/registry.js';
import { LINK_CODE_LENGTH, LINK_CODE_TTL_MS, LINK_REPLY, newLinkCode } from '../../src/ops/telegram-link.js';
import { createTestDb } from '../helpers/db.js';

const SECRET = 'whsec-link-0123456789abcdefghijkl';
const BOT = 'jiat_monitor_bot';
const TG_ANA = 700_001;
const TG_BUDI = 700_002;
const GROUP_CHAT = -100_555;

let db: Db;
let close: () => Promise<void>;
let now = new Date('2026-10-27T03:00:00Z');
let app: ReturnType<typeof createApp>;
let ana = 0; let budi = 0;
let seq = 0;

class FakeTelegram implements TelegramApi {
  sent: Array<{ chatId: number; text: string }> = [];
  async getFile(): Promise<never> { throw new Error('unused'); }
  async downloadFile(): Promise<never> { throw new Error('unused'); }
  async sendMessage(chatId: number, text: string) { this.sent.push({ chatId, text }); return { messageId: this.sent.length }; }
}

const as = (userId: number) => ({ method: 'POST', headers: { 'x-dev-user-id': String(userId) } });
async function codeFor(userId: number): Promise<{ code: string; expiresAt: string; link: string | null }> {
  const res = await app.request('/me/telegram-link', as(userId));
  expect(res.status).toBe(201);
  return ((await res.json()) as { data: { code: string; expiresAt: string; link: string | null } }).data;
}
async function sendStart(text: string, from: number, chat = from): Promise<number> {
  const res = await app.request('/telegram/webhook', {
    method: 'POST', headers: { 'content-type': 'application/json', 'x-telegram-bot-api-secret-token': SECRET },
    body: JSON.stringify({ update_id: ++seq, message: { message_id: ++seq, chat: { id: chat }, from: { id: from }, text } }),
  });
  return res.status;
}
const telegramIdOf = async (userId: number) => (await withApp(db, (tx) => tx.select({ t: users.telegramUserId }).from(users).where(eq(users.id, userId))))[0]!.t;
async function deliverReplies(tg: FakeTelegram) {
  const reg = opsRegistry({ db, storage: { put: async () => {}, get: async () => Buffer.alloc(0), delete: async () => {} }, telegram: tg, digest: false, now: () => now, log: () => {} });
  while (await runOnce(db, reg, 'test')) { /* drain */ }
}

beforeAll(async () => {
  ({ db, close } = await createTestDb());
  [ana, budi] = await withApp(db, async (tx) => (await tx.insert(users).values([{ email: 'ana@a.test', name: 'Ana' }, { email: 'budi@a.test', name: 'Budi' }])
    .returning({ id: users.id })).map((u) => u.id) as [number, number]);
  app = createApp({ db, auth: headerAuthenticator('test'), telegramWebhookSecret: SECRET, telegramBotUsername: BOT, now: () => now });
});
beforeEach(async () => {
  now = new Date('2026-10-27T03:00:00Z');
  await withApp(db, async (tx) => {
    await tx.delete(jobs);
    await tx.delete(telegramLinkCodes);
    await tx.update(users).set({ telegramUserId: null });
  });
});
afterAll(async () => { await close(); });

describe('linking a Telegram account with "/start <code>"', () => {
  it('codes use the unambiguous alphabet and the configured length', () => {
    const codes = Array.from({ length: 50 }, newLinkCode);
    expect(codes.every((c) => c.length === LINK_CODE_LENGTH && /^[A-HJ-NP-Z2-9]+$/.test(c))).toBe(true);
    expect(new Set(codes).size).toBe(codes.length);
  });

  it('POST /me/telegram-link gives a code, its expiry and a t.me deep link; only the hash is stored; 401 without a session', async () => {
    const { code, expiresAt, link } = await codeFor(ana);
    expect(expiresAt).toBe(new Date(now.getTime() + LINK_CODE_TTL_MS).toISOString());
    expect(link).toBe(`https://t.me/${BOT}?start=${code}`);
    const stored = await withApp(db, (tx) => tx.select().from(telegramLinkCodes));
    expect(stored).toHaveLength(1);
    expect(JSON.stringify(stored)).not.toContain(code);
    expect((await app.request('/me/telegram-link', { method: 'POST' })).status).toBe(401);
  });

  it('"/start <code>" in a private chat links the sender, once; the bot confirms', async () => {
    const { code } = await codeFor(ana);
    expect(await sendStart(`/start ${code}`, TG_ANA)).toBe(200);
    expect(await telegramIdOf(ana)).toBe(TG_ANA);
    expect(await sendStart(`/start ${code}`, TG_BUDI)).toBe(200); // used: nothing changes for Budi
    expect(await telegramIdOf(budi)).toBeNull();
    const tg = new FakeTelegram();
    await deliverReplies(tg);
    expect(tg.sent).toEqual([{ chatId: TG_ANA, text: LINK_REPLY.linked }, { chatId: TG_BUDI, text: LINK_REPLY.invalid }]);
  });

  it('an expired code, a superseded code and a code sent in a group do nothing', async () => {
    const first = await codeFor(ana);
    const second = await codeFor(ana); // voids the first
    expect(await sendStart(`/start ${first.code}`, TG_ANA)).toBe(200);
    expect(await telegramIdOf(ana)).toBeNull();
    expect(await sendStart(`/start ${second.code}`, TG_ANA, GROUP_CHAT)).toBe(200);
    expect(await telegramIdOf(ana)).toBeNull();
    now = new Date(now.getTime() + LINK_CODE_TTL_MS);
    expect(await sendStart(`/start ${second.code}`, TG_ANA)).toBe(200);
    expect(await telegramIdOf(ana)).toBeNull();
  });

  it('a Telegram account already linked to another user is refused and stays where it was', async () => {
    const a = await codeFor(ana);
    await sendStart(`/start ${a.code}`, TG_ANA);
    const b = await codeFor(budi);
    await sendStart(`/start ${b.code}`, TG_ANA);
    expect([await telegramIdOf(ana), await telegramIdOf(budi)]).toEqual([TG_ANA, null]);
    const tg = new FakeTelegram();
    await deliverReplies(tg);
    expect(tg.sent.map((m) => m.text)).toEqual([LINK_REPLY.linked, LINK_REPLY.taken]);
  });

  it('other private messages to the bot are ignored (200, nothing stored or queued)', async () => {
    expect(await sendStart('halo bot', TG_ANA)).toBe(200);
    expect(await sendStart('/start', TG_ANA)).toBe(200);
    expect(await withApp(db, (tx) => tx.select().from(jobs).orderBy(asc(jobs.id)))).toEqual([]);
  });
});
