import { describe, expect, it } from 'vitest';
import { headerAuthenticator } from '../../src/auth/authenticator.js';
import { createApp } from '../../src/http/app.js';
import { createLogger, redact } from '../../src/log.js';
import { createTestDb } from '../helpers/db.js';

describe('structured log', () => {
  it('redacts bank accounts, NPWP, tokens, passwords and cookies at any depth; bytes become a length', () => {
    expect(redact({
      vendor: { name: 'PT A', bankAccount: '1234567890', npwp: '012345678901234', nested: [{ bank_account: 'x', rekening: 'y' }] },
      TELEGRAM_BOT_TOKEN: 't', password: 'p', headers: { authorization: 'Bearer z', Cookie: 'c' }, apiKey: 'k',
      photo: Buffer.from('abc'), at: new Date('2026-10-27T00:00:00Z'), err: new TypeError('boom'),
    })).toEqual({
      vendor: { name: 'PT A', bankAccount: '[redacted]', npwp: '[redacted]', nested: [{ bank_account: '[redacted]', rekening: '[redacted]' }] },
      TELEGRAM_BOT_TOKEN: '[redacted]', password: '[redacted]', headers: { authorization: '[redacted]', Cookie: '[redacted]' }, apiKey: '[redacted]',
      photo: '[3 bytes]', at: '2026-10-27T00:00:00.000Z', err: 'TypeError: boom',
    });
  });

  it('passes primitives, null and empty containers through; stops at depth 6', () => {
    expect([redact(null), redact(undefined), redact('x'), redact(0), redact({}), redact([])]).toEqual([null, undefined, 'x', 0, {}, []]);
    expect(redact({ a: { b: { c: { d: { e: { f: { g: 1 } } } } } } })).toEqual({ a: { b: { c: { d: { e: { f: '[depth]' } } } } } });
  });

  it('a logger called without metadata still writes time, level, msg and the base fields', () => {
    const lines: string[] = [];
    createLogger({ service: 's' }, (l) => lines.push(l))('started');
    const o = JSON.parse(lines[0]!) as Record<string, unknown>;
    expect(Object.keys(o).sort()).toEqual(['level', 'msg', 'service', 'time']);
    expect([o['level'], o['msg'], o['service']]).toEqual(['info', 'started', 's']);
  });

  it('writes one JSON line with level from the message name', () => {
    const lines: string[] = [];
    const log = createLogger({ service: 'test' }, (l) => lines.push(l));
    log('job_failed', { jobId: 1 });
    log('purge_skipped');
    log('http_request', { status: 200 });
    expect(lines.map((l) => JSON.parse(l) as { level: string; service: string; msg: string }).map((o) => [o.level, o.service, o.msg]))
      .toEqual([['error', 'test', 'job_failed'], ['warn', 'test', 'purge_skipped'], ['info', 'test', 'http_request']]);
  });

  it('the API logs each request (no query string) and an unhandled error with the database reason, not the SQL parameters', async () => {
    const { db, close } = await createTestDb();
    const lines: Array<Record<string, unknown>> = [];
    const app = createApp({ db, auth: headerAuthenticator('test'), log: (msg, meta) => lines.push({ msg, ...meta }) });
    app.get('/boom', () => { throw new Error('Failed query: select secret from x params: 4111111111', { cause: new Error('connection reset') }); });
    expect((await app.request('/me/companies?email=a@b.c')).status).toBe(401);
    expect((await app.request('/boom')).status).toBe(500);
    await app.request('/health');
    await close();
    expect(lines).toContainEqual(expect.objectContaining({ msg: 'http_request', method: 'GET', path: '/me/companies', status: 401 }));
    const unhandled = lines.find((l) => l['msg'] === 'unhandled')!;
    expect(unhandled['error']).toBe('Error: connection reset');
    expect(JSON.stringify(lines)).not.toMatch(/4111111111|email=/);
    expect(lines.some((l) => l['path'] === '/health')).toBe(false);
  });
});
