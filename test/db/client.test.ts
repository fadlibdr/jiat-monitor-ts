import { describe, expect, it } from 'vitest';
import { createDb, DatabaseUnavailable } from '../../src/db/client.js';

describe('createDb — connection failure paths', () => {
  it('rejects an empty DATABASE_URL before opening anything', () => {
    expect(() => createDb('')).toThrow(DatabaseUnavailable);
  });

  it('ping() reports an unreachable Postgres as DatabaseUnavailable with the cause attached', async () => {
    // port 9 (discard) on localhost: nothing listens there, so the connection is refused immediately
    const { ping, close } = createDb('postgres://u:p@127.0.0.1:9/db', { connectTimeoutSeconds: 2 });
    const err = await ping().catch((e: unknown) => e);
    expect(err).toBeInstanceOf(DatabaseUnavailable);
    expect((err as Error).message).toMatch(/Postgres tidak dapat dihubungi/);
    expect((err as Error).cause).toBeDefined();
    await close();
  });
});
