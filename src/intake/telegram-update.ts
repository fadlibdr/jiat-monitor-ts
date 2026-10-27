import { z } from 'zod';

/**
 * The parts of a Telegram `Update` the intake reads (Bot API: Update → Message). Lenient: unknown
 * fields are ignored, and an update we do not understand is "nothing to do", never an error —
 * the webhook must answer 200 to everything or Telegram keeps re-sending it (LLD §9).
 */
const User = z.object({ id: z.number().int(), is_bot: z.boolean().optional() });
const PhotoSize = z.object({ file_id: z.string(), file_size: z.number().int().optional(), width: z.number().int(), height: z.number().int() });
const Message = z.object({
  message_id: z.number().int(),
  chat: z.object({ id: z.number().int(), title: z.string().optional() }),
  from: User.optional(),
  date: z.number().int().optional(),
  text: z.string().optional(),
  caption: z.string().optional(),
  photo: z.array(PhotoSize).optional(),
  document: z.object({ file_id: z.string(), mime_type: z.string().optional(), file_size: z.number().int().optional() }).optional(),
  reply_to_message: z.object({ message_id: z.number().int(), from: User.optional() }).optional(),
});
const Update = z.object({ update_id: z.number().int(), message: Message.optional() });

export type IncomingMessage =
  | { kind: 'photo'; chatId: number; messageId: number; fromId: number | null; fileId: string; mime: string; fileSize: number | null }
  | { kind: 'text'; chatId: number; messageId: number; fromId: number | null; text: string; replyToMessageId: number | null; replyToBot: boolean };

const IMAGE_MIME = /^image\/(jpeg|png|webp)$/;

/**
 * Update → what the intake should act on, or null (edited messages, stickers, joins, bots…).
 * A photo arrives in several sizes: the largest (last) is the one to read. An image sent "as file"
 * (document, better quality) is accepted too.
 */
export function classifyUpdate(raw: unknown): IncomingMessage | null {
  const parsed = Update.safeParse(raw);
  if (!parsed.success || !parsed.data.message) return null;
  const m = parsed.data.message;
  if (m.from?.is_bot) return null; // never react to bots, including ourselves
  const base = { chatId: m.chat.id, messageId: m.message_id, fromId: m.from?.id ?? null };

  if (m.photo?.length) {
    const largest = m.photo.reduce((a, b) => (b.width * b.height > a.width * a.height ? b : a));
    return { kind: 'photo', ...base, fileId: largest.file_id, mime: 'image/jpeg', fileSize: largest.file_size ?? null };
  }
  if (m.document && IMAGE_MIME.test(m.document.mime_type ?? '')) {
    return { kind: 'photo', ...base, fileId: m.document.file_id, mime: m.document.mime_type!, fileSize: m.document.file_size ?? null };
  }
  if (m.text?.trim()) {
    return {
      kind: 'text', ...base, text: m.text,
      replyToMessageId: m.reply_to_message?.message_id ?? null,
      replyToBot: m.reply_to_message?.from?.is_bot === true,
    };
  }
  return null;
}
