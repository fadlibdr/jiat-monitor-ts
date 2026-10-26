import { drizzle } from 'drizzle-orm/postgres-js';
import postgres from 'postgres';
import * as schema from './schema.js';

export function createDb(url: string) {
  if (!url) throw new Error('DATABASE_URL kosong.');
  const client = postgres(url, { max: 10, prepare: false, onnotice: () => {} });
  const db = drizzle(client, { schema });
  return { db, close: () => client.end({ timeout: 5 }) };
}
export type AppDb = ReturnType<typeof createDb>['db'];
