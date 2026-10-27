import { mkdtemp, readdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { OcrError, OcrParseError, OpenAiCompatibleOcr, parseModelJson } from '../../src/intake/ocr.js';
import { intakeKey, LocalDiskStorage } from '../../src/intake/storage.js';
import { TelegramBotApi, TelegramError } from '../../src/intake/telegram-api.js';

type Call = { url: string; init: RequestInit };
/** A fetch double that records calls and answers from a queue. */
function fakeFetch(answers: Array<Response | Error>): { fn: typeof fetch; calls: Call[] } {
  const calls: Call[] = [];
  const fn = (async (url: string | URL | Request, init?: RequestInit) => {
    calls.push({ url: String(url), init: init ?? {} });
    const a = answers.shift();
    if (!a) throw new Error('no more answers');
    if (a instanceof Error) throw a;
    return a;
  }) as typeof fetch;
  return { fn, calls };
}
const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });

describe('parseModelJson', () => {
  it('parses plain JSON and strips a ```json fence (LLD §6)', () => {
    expect(parseModelJson('{"a":1}')).toEqual({ a: 1 });
    expect(parseModelJson('```json\n{"a":1}\n```')).toEqual({ a: 1 });
    expect(parseModelJson('```\n{"a":2}\n```')).toEqual({ a: 2 });
  });
  it('empty, null or non-JSON text is an OcrParseError (→ tidak_terbaca), never empty fields', () => {
    for (const t of ['', '   ', null, undefined, 'Maaf, saya tidak bisa membaca', '{"a":']) {
      expect(() => parseModelJson(t)).toThrow(OcrParseError);
    }
  });
});

describe('OpenAiCompatibleOcr (fake server)', () => {
  const opts = (fetchFn: typeof fetch) => ({ baseUrl: 'https://ocr.test/v1/', apiKey: 'sk-test', modelStage1: 'small', modelStage2: 'large', fetchFn });
  const image = { bytes: Buffer.from('img'), mime: 'image/jpeg' };

  it('sends the image as a data URI with a strict JSON schema and returns the parsed answer', async () => {
    const f = fakeFetch([json({ choices: [{ message: { content: '{"doc_type":"nota","quality":0.9,"reason":""}' } }] })]);
    expect(await new OpenAiCompatibleOcr(opts(f.fn)).classify(image)).toEqual({ doc_type: 'nota', quality: 0.9, reason: '' });
    expect(f.calls[0]!.url).toBe('https://ocr.test/v1/chat/completions');
    const body = JSON.parse(String(f.calls[0]!.init.body)) as { model: string; response_format: { json_schema: { strict: boolean } }; messages: Array<{ content: unknown }> };
    expect(body.model).toBe('small');
    expect(body.response_format.json_schema.strict).toBe(true);
    expect(JSON.stringify(body.messages[1]!.content)).toContain('data:image/jpeg;base64,aW1n');
    expect((f.calls[0]!.init.headers as Record<string, string>)['authorization']).toBe('Bearer sk-test');
  });

  it('stage 2 uses the stage-2 model', async () => {
    const f = fakeFetch([json({ choices: [{ message: { content: '{}' } }] })]);
    await new OpenAiCompatibleOcr(opts(f.fn)).extract(image);
    expect((JSON.parse(String(f.calls[0]!.init.body)) as { model: string }).model).toBe('large');
  });

  it('HTTP errors and network failures are OcrError (retried); bad content and refusals are OcrParseError', async () => {
    await expect(new OpenAiCompatibleOcr(opts(fakeFetch([json({}, 503)]).fn)).classify(image)).rejects.toBeInstanceOf(OcrError);
    await expect(new OpenAiCompatibleOcr(opts(fakeFetch([new TypeError('fetch failed')]).fn)).classify(image)).rejects.toBeInstanceOf(OcrError);
    await expect(new OpenAiCompatibleOcr(opts(fakeFetch([new Response('<html>', { status: 200 })]).fn)).classify(image)).rejects.toBeInstanceOf(OcrError);
    await expect(new OpenAiCompatibleOcr(opts(fakeFetch([json({ choices: [{ message: { content: 'tidak tahu' } }] })]).fn)).classify(image)).rejects.toBeInstanceOf(OcrParseError);
    await expect(new OpenAiCompatibleOcr(opts(fakeFetch([json({ choices: [{ message: { content: null, refusal: 'no' } }] })]).fn)).classify(image)).rejects.toBeInstanceOf(OcrParseError);
  });

  it('refuses to start without an API key', () => {
    expect(() => new OpenAiCompatibleOcr({ ...opts(fetch), apiKey: '' })).toThrow(OcrError);
  });
});

describe('TelegramBotApi (fake server)', () => {
  const TOKEN = '123456:ABCdefGHIjklMNOpqrSTUvwxYZ_0123';

  it('getFile and sendMessage call the Bot API; replies use reply_parameters', async () => {
    const f = fakeFetch([json({ ok: true, result: { file_path: 'photos/a.jpg', file_size: 3 } }), json({ ok: true, result: { message_id: 77 } })]);
    const api = new TelegramBotApi(TOKEN, f.fn, 'https://tg.test');
    expect(await api.getFile('FILE')).toEqual({ filePath: 'photos/a.jpg', fileSize: 3 });
    expect(await api.sendMessage(-100, 'halo', 5)).toEqual({ messageId: 77 });
    expect(f.calls[1]!.url).toBe(`https://tg.test/bot${TOKEN}/sendMessage`);
    expect(JSON.parse(String(f.calls[1]!.init.body))).toEqual({ chat_id: -100, text: 'halo', reply_parameters: { message_id: 5, allow_sending_without_reply: true } });
  });

  it('errors never contain the bot token, whether the API says no or the network fails', async () => {
    const api = new TelegramBotApi(TOKEN, fakeFetch([json({ ok: false, description: 'Bad Request: chat not found' }, 400), new TypeError(`connect ECONNREFUSED https://tg.test/bot${TOKEN}`)]).fn, 'https://tg.test');
    const e1 = (await api.sendMessage(-1, 'x').catch((e: unknown) => e)) as Error;
    const e2 = (await api.getFile('F').catch((e: unknown) => e)) as Error;
    for (const e of [e1, e2]) {
      expect(e).toBeInstanceOf(TelegramError);
      expect(e.message).not.toContain(TOKEN.split(':')[1]);
    }
    expect(e1.message).toContain('chat not found');
  });

  it('downloadFile enforces the size limit inclusively, from the header and from the body', async () => {
    const big = new Response(Buffer.alloc(11), { status: 200, headers: { 'content-length': '11' } });
    const sneaky = new Response(Buffer.alloc(11), { status: 200 });
    const exact = new Response(Buffer.alloc(10, 1), { status: 200, headers: { 'content-length': '10' } });
    const empty = new Response(Buffer.alloc(0), { status: 200 });
    const missing = new Response('Not Found', { status: 404 });
    const api = new TelegramBotApi(TOKEN, fakeFetch([big, sneaky, exact, empty, missing]).fn, 'https://tg.test');
    await expect(api.downloadFile('photos/a.jpg', 10)).rejects.toThrow(/melebihi batas/);
    await expect(api.downloadFile('photos/a.jpg', 10)).rejects.toThrow(/melebihi batas/);
    expect(await api.downloadFile('photos/a.jpg', 10)).toHaveLength(10); // exactly the limit passes
    expect(await api.downloadFile('photos/a.jpg', 10)).toHaveLength(0); // empty is the job's problem (pHash refuses it)
    await expect(api.downloadFile('photos/a.jpg', 10)).rejects.toThrow(/HTTP 404/);
    await expect(api.downloadFile('../../etc/passwd', 10)).rejects.toThrow(/tidak valid/);
  });

  it('refuses a malformed token at construction', () => {
    expect(() => new TelegramBotApi('not-a-token')).toThrow(TelegramError);
  });
});

describe('LocalDiskStorage', () => {
  let root = '';
  beforeAll(async () => { root = await mkdtemp(join(tmpdir(), 'jiat-storage-')); });
  afterAll(async () => { await rm(root, { recursive: true, force: true }); });

  it('stores and reads back; never overwrites an existing original; delete is idempotent', async () => {
    const s = new LocalDiskStorage(root);
    await s.put('company-1/intake/2026/10/abc.jpg', Buffer.from('first'), 'image/jpeg');
    await s.put('company-1/intake/2026/10/abc.jpg', Buffer.from('second'), 'image/jpeg');
    expect((await s.get('company-1/intake/2026/10/abc.jpg')).toString()).toBe('first');
    await s.delete('company-1/intake/2026/10/abc.jpg');
    await s.delete('company-1/intake/2026/10/abc.jpg');
    await expect(s.get('company-1/intake/2026/10/abc.jpg')).rejects.toThrow();
  });

  it('writes atomically: no temp file is left behind, and concurrent puts of one key keep one complete copy', async () => {
    const s = new LocalDiskStorage(root);
    const bytes = Buffer.alloc(256 * 1024, 7);
    await Promise.all(Array.from({ length: 5 }, () => s.put('company-2/intake/2026/10/same.jpg', bytes, 'image/jpeg')));
    expect((await s.get('company-2/intake/2026/10/same.jpg')).equals(bytes)).toBe(true);
    expect((await readdir(join(root, 'company-2/intake/2026/10'))).filter((f) => f.endsWith('.tmp'))).toEqual([]);
  });

  it('refuses keys that could escape the root', async () => {
    const s = new LocalDiskStorage(root);
    for (const key of ['../x.jpg', '/etc/passwd', 'a//b.jpg', 'a/../../b.jpg', 'a/./b.jpg', '']) {
      await expect(s.put(key, Buffer.from('x'), 'image/jpeg')).rejects.toThrow(/tidak valid|di luar root/);
    }
  });

  it('intakeKey is content-addressed per company and month', () => {
    expect(intakeKey(7, 'ab'.repeat(32), 'image/png', new Date('2026-10-27T00:00:00Z'))).toBe(`company-7/intake/2026/10/${'ab'.repeat(32)}.png`);
    expect(intakeKey(7, 'cd'.repeat(32), 'image/jpeg', new Date('2026-01-01T00:00:00Z'))).toMatch(/2026\/01\/.*\.jpg$/);
  });
});
