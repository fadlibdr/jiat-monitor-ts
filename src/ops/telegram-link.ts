import { createHash, randomInt } from 'node:crypto';
import { and, eq, gt, isNull, ne } from 'drizzle-orm';
import { telegramLinkCodes, users } from '../db/schema.js';
import { withApp, type Db } from '../db/tenant.js';
import { enqueue } from '../jobs/queue.js';

/**
 * Self-service link between a user and their Telegram account (docs/remaining-work.md §4.1): needed
 * so chat corrections are attributed (LLD §7) and so the bot may DM the DailyDigest (Telegram only
 * lets a bot message a user who has started a chat with it — "/start" is exactly that).
 *
 * The code is 10 characters from a 32-letter alphabet (50 bits), stored only as its sha256, valid
 * 15 minutes, usable once; asking for a new code voids the previous unused ones.
 */
export const LINK_CODE_TTL_MS = 15 * 60_000;
export const LINK_CODE_LENGTH = 10;
/** no 0/O, 1/I: codes are read off a screen and typed */
const ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
export const JOB_TELEGRAM_SEND = 'telegram.send';
/** "/start CODE" or "/start@BotName CODE" (Telegram deep links send "/start <payload>") */
export const START_COMMAND = /^\/start(?:@\w+)?\s+([A-Za-z0-9]{6,32})$/;

export const LINK_REPLY = {
  linked: 'Akun Telegram Anda sudah terhubung dengan JIAT Monitor.',
  invalid: 'Kode tidak berlaku atau sudah kedaluwarsa. Minta kode baru dari aplikasi.',
  taken: 'Akun Telegram ini sudah terhubung dengan pengguna lain. Hubungi admin.',
} as const;

const hash = (code: string) => createHash('sha256').update(code.toUpperCase()).digest('hex');

export function newLinkCode(): string {
  return Array.from({ length: LINK_CODE_LENGTH }, () => ALPHABET[randomInt(ALPHABET.length)]).join('');
}

/** A fresh code for the user; earlier unused codes stop working. */
export async function createLinkCode(db: Db, userId: number, now: Date): Promise<{ code: string; expiresAt: Date }> {
  const code = newLinkCode();
  const expiresAt = new Date(now.getTime() + LINK_CODE_TTL_MS);
  await withApp(db, async (tx) => {
    await tx.update(telegramLinkCodes).set({ usedAt: now }).where(and(eq(telegramLinkCodes.userId, userId), isNull(telegramLinkCodes.usedAt)));
    await tx.insert(telegramLinkCodes).values({ codeHash: hash(code), userId, expiresAt });
  }, userId);
  return { code, expiresAt };
}

/**
 * "/start <code>" from a private chat: links the sender's Telegram id to the code's user and queues
 * the bot's answer (the API process has no bot token; the worker sends it). Returns what happened.
 */
export async function redeemLinkCode(db: Db, code: string, telegramUserId: number, now: Date): Promise<keyof typeof LINK_REPLY> {
  return withApp(db, async (tx) => {
    const [row] = await tx.select().from(telegramLinkCodes)
      .where(and(eq(telegramLinkCodes.codeHash, hash(code)), isNull(telegramLinkCodes.usedAt), gt(telegramLinkCodes.expiresAt, now)))
      .for('update');
    let outcome: keyof typeof LINK_REPLY = 'invalid';
    if (row) {
      const [other] = await tx.select({ id: users.id }).from(users)
        .where(and(eq(users.telegramUserId, telegramUserId), ne(users.id, row.userId)));
      if (other) {
        outcome = 'taken';
      } else {
        await tx.update(users).set({ telegramUserId }).where(eq(users.id, row.userId));
        await tx.update(telegramLinkCodes).set({ usedAt: now }).where(eq(telegramLinkCodes.codeHash, row.codeHash));
        outcome = 'linked';
      }
    }
    // in a private chat the chat id is the user id
    await enqueue(tx, { kind: JOB_TELEGRAM_SEND, companyId: null, payload: { chatId: telegramUserId, text: LINK_REPLY[outcome] }, maxAttempts: 3 });
    return outcome;
  });
}
