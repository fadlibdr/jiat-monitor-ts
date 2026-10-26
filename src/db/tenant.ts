import { sql, type ExtractTablesWithRelations } from 'drizzle-orm';
import type { PgDatabase, PgQueryResultHKT, PgTransaction } from 'drizzle-orm/pg-core';
import type * as schema from './schema.js';
import { APP_ROLE, HOLDING_ROLE } from './rls.js';

type Schema = typeof schema;
export type Db = PgDatabase<PgQueryResultHKT, Schema, ExtractTablesWithRelations<Schema>>;
export type Tx = PgTransaction<PgQueryResultHKT, Schema, ExtractTablesWithRelations<Schema>>;

export class MissingCompanyContext extends Error {
  override readonly name = 'MissingCompanyContext';
}

/**
 * Runs `fn` in a transaction as the restricted app role with app.company_id set.
 * Every query inside sees only that company's rows and can only write rows of that company —
 * enforced by Postgres, so a forgotten filter, a queue job, or a raw SQL string cannot leak.
 * SET LOCAL ends with the transaction; the pooled connection returns clean.
 */
export async function withCompany<T>(db: Db, companyId: number, fn: (tx: Tx) => Promise<T>): Promise<T> {
  if (!Number.isInteger(companyId) || companyId <= 0) throw new MissingCompanyContext(`company_id tidak valid: ${companyId}`);
  return db.transaction(async (tx) => {
    await tx.execute(sql.raw(`SET LOCAL ROLE ${APP_ROLE}`));
    await tx.execute(sql`SELECT set_config('app.company_id', ${String(companyId)}, true)`);
    return fn(tx as Tx);
  });
}

/** Read-only across all companies. The caller must have passed the holding gate (see auth/gates.ts). */
export async function withHoldingRead<T>(db: Db, fn: (tx: Tx) => Promise<T>): Promise<T> {
  return db.transaction(async (tx) => {
    await tx.execute(sql.raw(`SET LOCAL ROLE ${HOLDING_ROLE}`));
    await tx.execute(sql`SET LOCAL transaction_read_only = on`);
    return fn(tx as Tx);
  });
}

/** Non-tenant work (users, companies, memberships) as the app role, with no company context. */
export async function withApp<T>(db: Db, fn: (tx: Tx) => Promise<T>): Promise<T> {
  return db.transaction(async (tx) => {
    await tx.execute(sql.raw(`SET LOCAL ROLE ${APP_ROLE}`));
    return fn(tx as Tx);
  });
}
