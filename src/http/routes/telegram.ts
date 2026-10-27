import { timingSafeEqual } from 'node:crypto';
import { and, eq } from 'drizzle-orm';
import { parseCorrection } from '../../domain/correction.js';
import { intakeEvents, telegramChats } from '../../db/schema.js';
import { withApp, withCompany, type Db } from '../../db/tenant.js';
import { CORRECTION_MAX_ATTEMPTS, JOB_CORRECTION, JOB_PHOTO, PHOTO_MAX_ATTEMPTS } from '../../intake/pipeline.js';
import { classifyUpdate } from '../../intake/telegram-update.js';
import { enqueue } from '../../jobs/queue.js';
import type { App } from '../context.js';

/**
 * POST /telegram/webhook (LLD §4–5). No session: Telegram authenticates with the secret token it
 * echoes in `X-Telegram-Bot-Api-Secret-Token` (set via setWebhook). The handler only records the
 * message and enqueues a job, then answers 200 — every other answer makes Telegram re-send.
 *
 *  - wrong/missing secret → 403;  webhook not configured → 404
 *  - unknown or inactive chat → 200, nothing stored (LLD §8)
 *  - text that is not a correction → 200, nothing stored (the group stays quiet, chat text is not kept)
 *  - same (chat_id, message_id) again → 200, no second job (unique index, ON CONFLICT DO NOTHING)
 */
export function registerTelegramWebhook(app: App, { db, secret }: { db: Db; secret: string | undefined }): void {
  app.post('/telegram/webhook', async (c) => {
    if (!secret) return c.json({ error: 'not_found' }, 404);
    if (!secretMatches(c.req.header('x-telegram-bot-api-secret-token'), secret)) return c.json({ error: 'forbidden' }, 403);

    let update: unknown;
    try {
      update = await c.req.json();
    } catch {
      return c.body(null, 200); // malformed: re-sending would not fix it
    }
    const msg = classifyUpdate(update);
    if (!msg) return c.body(null, 200);
    if (msg.kind === 'text' && !parseCorrection(msg.text, msg.replyToBot)) return c.body(null, 200);

    const chat = await withApp(db, (tx) => tx.query.telegramChats.findFirst({
      where: and(eq(telegramChats.chatId, msg.chatId), eq(telegramChats.isActive, true)),
    }));
    if (!chat) return c.body(null, 200);

    await withCompany(db, chat.companyId, async (tx) => {
      const payload = msg.kind === 'photo'
        ? { fileId: msg.fileId, mime: msg.mime, fileSize: msg.fileSize }
        : { text: msg.text, replyToMessageId: msg.replyToMessageId, replyToBot: msg.replyToBot };
      const [ev] = await tx.insert(intakeEvents).values({
        companyId: chat.companyId, siteId: chat.siteId, chatId: msg.chatId, messageId: msg.messageId, fromUserId: msg.fromId,
        kind: msg.kind === 'photo' ? 'photo' : 'correction', payload,
      }).onConflictDoNothing({ target: [intakeEvents.chatId, intakeEvents.messageId] }).returning({ id: intakeEvents.id });
      if (!ev) return; // Telegram re-delivery: already recorded and queued
      await enqueue(tx, msg.kind === 'photo'
        ? { kind: JOB_PHOTO, companyId: chat.companyId, payload: { intakeEventId: ev.id }, maxAttempts: PHOTO_MAX_ATTEMPTS }
        : { kind: JOB_CORRECTION, companyId: chat.companyId, payload: { intakeEventId: ev.id }, maxAttempts: CORRECTION_MAX_ATTEMPTS });
    });
    return c.body(null, 200);
  });
}

/** Constant-time comparison (no early exit on the first differing byte). */
export function secretMatches(got: string | undefined, expected: string): boolean {
  if (!got) return false;
  const a = Buffer.from(got);
  const b = Buffer.from(expected);
  return a.length === b.length && timingSafeEqual(a, b);
}
