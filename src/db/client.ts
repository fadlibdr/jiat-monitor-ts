import { sql } from 'drizzle-orm';
import { drizzle } from 'drizzle-orm/postgres-js';
import postgres from 'postgres';
import * as schema from './schema.js';

export class DatabaseUnavailable extends Error {
  override readonly name = 'DatabaseUnavailable';
}

export function createDb(url: string, opts: { connectTimeoutSeconds?: number } = {}) {
  if (!url) throw new DatabaseUnavailable('DATABASE_URL kosong.');
  const client = postgres(url, { max: 10, prepare: false, connect_timeout: opts.connectTimeoutSeconds ?? 10, onnotice: () => {} });
  const db = drizzle(client, { schema });
  return {
    db,
    /** Fails fast with a readable message instead of a stack trace on first query. */
    async ping(): Promise<void> {
      try {
        await db.execute(sql`SELECT 1`);
      } catch (e) {
        throw new DatabaseUnavailable(`Postgres tidak dapat dihubungi: ${e instanceof Error ? e.message : String(e)}`, { cause: e });
      }
    },
    close: () => client.end({ timeout: 5 }),
  };
}
export type AppDb = ReturnType<typeof createDb>['db'];
