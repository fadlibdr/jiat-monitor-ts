/**
 * The slice of the Telegram Bot API the intake uses. The pipeline depends on this interface only;
 * tests pass a fake, production passes TelegramBotApi.
 */
export interface TelegramApi {
  getFile(fileId: string): Promise<{ filePath: string; fileSize: number | null }>;
  downloadFile(filePath: string, maxBytes: number): Promise<Buffer>;
  /** Plain text (no parse_mode: nothing typed by staff or read by OCR can inject markup). */
  sendMessage(chatId: number, text: string, replyToMessageId?: number): Promise<{ messageId: number }>;
}

/** Transport or API failure. Never carries the bot token (it is part of every Bot API URL). */
export class TelegramError extends Error {
  override readonly name: string = 'TelegramError';
}

/** The file is larger than the Bot API will serve (20 MB): retrying cannot help. */
export class FileTooBigError extends TelegramError {
  override readonly name = 'FileTooBigError';
}

type Fetch = typeof fetch;

export class TelegramBotApi implements TelegramApi {
  constructor(
    private readonly token: string,
    private readonly fetchFn: Fetch = fetch,
    private readonly baseUrl = 'https://api.telegram.org',
    private readonly timeoutMs = 30_000,
  ) {
    if (!/^\d+:[\w-]{20,}$/.test(token)) throw new TelegramError('TELEGRAM_BOT_TOKEN tidak berformat <id>:<secret>.');
  }

  async getFile(fileId: string) {
    let r: { file_path?: string; file_size?: number };
    try {
      r = await this.call<{ file_path?: string; file_size?: number }>('getFile', { file_id: fileId });
    } catch (e) {
      // "Bad Request: file is too big": the Bot API serves files up to 20 MB only — not transient
      if (e instanceof TelegramError && /file is too big/i.test(e.message)) throw new FileTooBigError(e.message);
      throw e;
    }
    if (!r.file_path) throw new FileTooBigError('getFile: file_path kosong (berkas > 20 MB).');
    return { filePath: r.file_path, fileSize: r.file_size ?? null };
  }

  async downloadFile(filePath: string, maxBytes: number): Promise<Buffer> {
    if (!/^[\w./-]+$/.test(filePath) || filePath.includes('..')) throw new TelegramError('file_path tidak valid.');
    const res = await this.fetch(`${this.baseUrl}/file/bot${this.token}/${filePath}`, { method: 'GET' }, 'download');
    if (!res.ok) throw new TelegramError(`download: HTTP ${res.status}`);
    const declared = Number(res.headers.get('content-length') ?? 0);
    if (declared > maxBytes) throw new TelegramError(`download: ${declared} byte melebihi batas ${maxBytes}`);
    const bytes = Buffer.from(await res.arrayBuffer());
    if (bytes.length > maxBytes) throw new TelegramError(`download: ${bytes.length} byte melebihi batas ${maxBytes}`);
    return bytes;
  }

  async sendMessage(chatId: number, text: string, replyToMessageId?: number) {
    const r = await this.call<{ message_id: number }>('sendMessage', {
      chat_id: chatId,
      text,
      ...(replyToMessageId ? { reply_parameters: { message_id: replyToMessageId, allow_sending_without_reply: true } } : {}),
    });
    return { messageId: r.message_id };
  }

  private async call<T>(method: string, body: Record<string, unknown>): Promise<T> {
    const res = await this.fetch(`${this.baseUrl}/bot${this.token}/${method}`, {
      method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body),
    }, method);
    let json: { ok?: boolean; result?: T; description?: string };
    try {
      json = (await res.json()) as typeof json;
    } catch {
      throw new TelegramError(`${method}: HTTP ${res.status}, body bukan JSON`);
    }
    if (!json.ok || json.result === undefined) throw new TelegramError(`${method}: ${json.description ?? `HTTP ${res.status}`}`);
    return json.result;
  }

  /** fetch with a timeout; errors are rewritten so the URL (and so the token) never reaches a log. */
  private async fetch(url: string, init: RequestInit, label: string): Promise<Response> {
    try {
      return await this.fetchFn(url, { ...init, signal: AbortSignal.timeout(this.timeoutMs) });
    } catch (e) {
      throw new TelegramError(`${label}: ${e instanceof Error ? e.name : 'gagal'}`);
    }
  }
}
