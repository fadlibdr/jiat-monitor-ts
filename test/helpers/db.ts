import { PGlite } from '@electric-sql/pglite';
import { pg_trgm } from '@electric-sql/pglite/contrib/pg_trgm';
import { sql } from 'drizzle-orm';
import { drizzle } from 'drizzle-orm/pglite';
import { pushSchema } from 'drizzle-kit/api';
import { postMigrationStatements } from '../../src/db/ddl.js';
import * as schema from '../../src/db/schema.js';
import type { Db } from '../../src/db/tenant.js';

/**
 * Fresh in-memory Postgres per test file. PGlite's default user is a superuser (bypasses RLS),
 * so after creating the schema as owner we create a non-owner login role `jiat_login` that is a
 * member of jiat_app/jiat_holding and run every test transaction via SET ROLE from there — the
 * same shape production uses (pool role ≠ table owner).
 */
export async function createTestDb(): Promise<{ db: Db; owner: Db; close: () => Promise<void> }> {
  const client = new PGlite({ extensions: { pg_trgm } });
  const owner = drizzle(client, { schema }) as unknown as Db;
  const { apply } = await pushSchema(schema, owner as never);
  await apply();
  for (const stmt of postMigrationStatements()) await owner.execute(sql.raw(stmt));
  await owner.execute(sql.raw(`CREATE ROLE jiat_login LOGIN`));
  await owner.execute(sql.raw(`GRANT jiat_app, jiat_holding TO jiat_login`));
  // Everything the tests do as "the app" goes through this wrapper; it is still the same PGlite
  // connection, so SET ROLE jiat_login first makes the subsequent SET LOCAL ROLE jiat_app non-owner.
  // Production: `ALTER ROLE <login> SET role = jiat_app` (db:migrate does this), so a fresh
  // connection already runs as jiat_app and Better Auth's own queries (outside withCompany) have
  // the right grants. Mirror that here.
  await owner.execute(sql.raw(`SET ROLE jiat_app`));
  return { db: owner, owner, close: () => client.close() };
}

/** Run DDL/seed as table owner (superuser) regardless of the current SET ROLE. */
export async function asOwner<T>(db: Db, fn: () => Promise<T>): Promise<T> {
  await db.execute(sql.raw('RESET ROLE'));
  try {
    return await fn();
  } finally {
    await db.execute(sql.raw('SET ROLE jiat_app'));
  }
}
