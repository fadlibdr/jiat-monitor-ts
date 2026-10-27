import { spawn } from 'node:child_process';
import type { Context } from 'hono';
import { describe, expect, it } from 'vitest';
import { readUpload } from '../../src/http/app.js';

const CLI = 'src/cli/create-user.ts';

/** A File whose body cannot be read: simulates the client disconnecting mid-upload. */
class CutFile extends File {
  override arrayBuffer(): Promise<ArrayBuffer> {
    return Promise.reject(new Error('stream cut'));
  }
}

const LIMIT = 1024;
const FILENAME = 'rab.xlsx';

function fakeContext(form: FormData | (() => Promise<FormData>), contentLength?: number): Context {
  const formData = typeof form === 'function' ? form : async () => form;
  return {
    req: {
      header: (name: string) => (name === 'content-length' && contentLength !== undefined ? String(contentLength) : undefined),
      formData,
    },
  } as unknown as Context;
}
const withFile = (file: File) => { const fd = new FormData(); fd.append('file', file); return fd; };

describe('readUpload — I/O failure paths', () => {
  it('a body cut mid-stream rejects with the underlying error (onError turns it into a generic 500)', async () => {
    await expect(readUpload(fakeContext(withFile(new CutFile(['x'], FILENAME))), LIMIT)).rejects.toThrow('stream cut');
  });

  it('content-length gate is inclusive: exactly LIMIT is read, LIMIT + 1 is 413 before the body is touched', async () => {
    let read = false;
    const counting = fakeContext(async () => { read = true; return withFile(new File([Buffer.alloc(LIMIT)], FILENAME)); }, LIMIT);
    await expect(readUpload(counting, LIMIT)).resolves.toMatchObject({ name: FILENAME });
    expect(read).toBe(true);

    read = false;
    const over = fakeContext(async () => { read = true; return new FormData(); }, LIMIT + 1);
    await expect(readUpload(over, LIMIT)).rejects.toMatchObject({ status: 413 });
    expect(read).toBe(false);
  });

  it('file size gate is inclusive when content-length is absent: LIMIT ok, LIMIT + 1 is 413', async () => {
    await expect(readUpload(fakeContext(withFile(new File([Buffer.alloc(LIMIT)], FILENAME))), LIMIT)).resolves.toMatchObject({ bytes: expect.any(Buffer) });
    await expect(readUpload(fakeContext(withFile(new File([Buffer.alloc(LIMIT + 1)], FILENAME))), LIMIT)).rejects.toMatchObject({ status: 413 });
  });

  it('an empty file is accepted here (the parser then reports file_unreadable); an empty name becomes undefined', async () => {
    const r = await readUpload(fakeContext(withFile(new File([], ''))), LIMIT);
    expect(r.bytes.length).toBe(0);
    expect(r.name).toBeUndefined();
  });

  it('form without a "file" field, or a non-file "file" value, is 400', async () => {
    await expect(readUpload(fakeContext(new FormData()), LIMIT)).rejects.toMatchObject({ status: 400 });
    const fd = new FormData();
    fd.append('file', 'just a string');
    await expect(readUpload(fakeContext(fd), LIMIT)).rejects.toMatchObject({ status: 400 });
  });

  it('an unparseable multipart body is a 400, not a crash', async () => {
    const ctx = fakeContext(async () => { throw new TypeError('bad multipart'); });
    await expect(readUpload(ctx, LIMIT)).rejects.toMatchObject({ status: 400 });
  });
});

describe('create-user CLI — failure paths exit 1 with a readable message', () => {
  const env = (extra: Record<string, string>) => ({ ...process.env, DATABASE_URL: '', BETTER_AUTH_SECRET: '', BETTER_AUTH_URL: '', ...extra });
  /** Runs the CLI with `input` written to stdin, then stdin closed; returns exit code + stderr. */
  function cli(args: string[], input: string, extra: Record<string, string>): Promise<{ code: number; stderr: string }> {
    return new Promise((resolve, reject) => {
      const child = spawn('npx', ['tsx', CLI, ...args], { env: env(extra), cwd: process.cwd() });
      let stderr = '';
      child.stderr.setEncoding('utf8');
      child.stderr.on('data', (chunk: string) => { stderr += chunk; });
      child.on('error', reject);
      child.on('close', (code) => resolve({ code: code ?? -1, stderr }));
      child.stdin.end(input);
    });
  }
  const PASSWORD = 'password-123456';

  it('invalid email argument', async () => {
    const r = await cli(['not-an-email', 'Name'], PASSWORD, {});
    expect(r.code).toBe(1);
  });

  it('an unknown flag is refused before reading the password; --system-admin is accepted', async () => {
    const bad = await cli(['a@b.test', 'Name', '--admin'], PASSWORD, {});
    expect(bad.code).toBe(1);
    expect(bad.stderr).toMatch(/Opsi tidak dikenal: --admin/);
    const ok = await cli(['a@b.test', 'Name', '--system-admin'], PASSWORD, {});
    expect(ok.code).toBe(1);
    expect(ok.stderr).toMatch(/harus diisi/); // flag parsed, failing later on missing env
  });

  it('password boundary on stdin: empty and 11 chars rejected; 12 chars passes to the next check (env)', async () => {
    for (const pw of ['', 'a'.repeat(11)]) {
      const r = await cli(['a@b.test', 'Name'], pw, {});
      expect(r.code).toBe(1);
      expect(r.stderr).toMatch(/Password harus/);
    }
    const ok = await cli(['a@b.test', 'Name'], 'a'.repeat(12), {});
    expect(ok.code).toBe(1);
    expect(ok.stderr).toMatch(/harus diisi/); // past the password check, failing on missing env
  });

  it('missing env (DATABASE_URL / BETTER_AUTH_SECRET / BETTER_AUTH_URL)', async () => {
    const r = await cli(['a@b.test', 'Name'], PASSWORD, {});
    expect(r.code).toBe(1);
    expect(r.stderr).toMatch(/harus diisi/);
  });

  it('unreachable database -> DatabaseUnavailable, exit 1', async () => {
    const r = await cli(['a@b.test', 'Name'], PASSWORD, {
      DATABASE_URL: 'postgres://u:p@127.0.0.1:9/db', BETTER_AUTH_SECRET: 'x'.repeat(40), BETTER_AUTH_URL: 'http://localhost:3000',
    });
    expect(r.code).toBe(1);
    expect(r.stderr).toMatch(/Postgres tidak dapat dihubungi/);
  });
});
