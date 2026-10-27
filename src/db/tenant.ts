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
 * Who is acting, for one transaction.
 *  - userId  : written to created_by/updated_by and audit_logs by the DB triggers (null = system job)
 *  - siteIds : null = every site of the company; an array limits every site-bound table to those
 *              sites (RESTRICTIVE policy in rls.ts); [] = no site at all.
 */
export interface TenantCtx {
  companyId: number;
  userId?: number | null;
  siteIds?: readonly number[] | null;
}

/**
 * Site scope of a membership (HLD §2), for TenantCtx.siteIds. site_staff see only the sites assigned
 * to them — none until assigned. Other roles see every site unless an explicit list was set.
 * Used by the HTTP membership middleware and by Telegram corrections, so both apply one rule.
 */
export function siteScopeFor(role: string, siteIds: number[] | null): number[] | null {
  if (role === 'site_staff') return siteIds ?? [];
  return siteIds;
}

/**
 * Runs `fn` in a transaction as the restricted app role with app.company_id set.
 * Every query inside sees only that company's rows and can only write rows of that company —
 * enforced by Postgres, so a forgotten filter, a queue job, or a raw SQL string cannot leak.
 * SET LOCAL ends with the transaction; the pooled connection returns clean.
 */
export async function withCompany<T>(db: Db, ctx: number | TenantCtx, fn: (tx: Tx) => Promise<T>): Promise<T> {
  const { companyId, userId = null, siteIds = null } = typeof ctx === 'number' ? { companyId: ctx } : ctx;
  if (!Number.isInteger(companyId) || companyId <= 0) throw new MissingCompanyContext(`company_id tidak valid: ${companyId}`);
  if (userId !== null && (!Number.isInteger(userId) || userId <= 0)) throw new MissingCompanyContext(`user_id tidak valid: ${userId}`);
  if (siteIds?.some((s) => !Number.isInteger(s) || s <= 0)) throw new MissingCompanyContext('site_ids tidak valid.');
  return db.transaction(async (tx) => {
    await tx.execute(sql.raw(`SET LOCAL ROLE ${APP_ROLE}`));
    await tx.execute(sql`SELECT set_config('app.company_id', ${String(companyId)}, true),
                                set_config('app.user_id', ${userId === null ? '' : String(userId)}, true),
                                set_config('app.site_scope', ${siteIds === null ? 'all' : 'list'}, true),
                                set_config('app.site_ids', ${siteIds === null ? '' : siteIds.join(',')}, true)`);
    return fn(tx as Tx);
  });
}

/** Read-only across all companies. The caller must have passed the holding gate (http/app.ts `requireHolding`). */
export async function withHoldingRead<T>(db: Db, fn: (tx: Tx) => Promise<T>): Promise<T> {
  return db.transaction(async (tx) => {
    await tx.execute(sql.raw(`SET LOCAL ROLE ${HOLDING_ROLE}`));
    await tx.execute(sql`SET LOCAL transaction_read_only = on`);
    return fn(tx as Tx);
  });
}

/**
 * Non-tenant work (users, companies, memberships) as the app role, with no company context.
 * `userId` attributes the change in audit_logs (memberships, viewers and companies are audited).
 */
export async function withApp<T>(db: Db, fn: (tx: Tx) => Promise<T>, userId: number | null = null): Promise<T> {
  return db.transaction(async (tx) => {
    await tx.execute(sql.raw(`SET LOCAL ROLE ${APP_ROLE}`));
    if (userId !== null) await tx.execute(sql`SELECT set_config('app.user_id', ${String(userId)}, true)`);
    return fn(tx as Tx);
  });
}
