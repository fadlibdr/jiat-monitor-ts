import { sql } from 'drizzle-orm';
import {
  bigint, bigserial, boolean, date, index, integer, jsonb, numeric, pgTable, primaryKey, smallint, text, timestamp, uniqueIndex, varchar,
} from 'drizzle-orm/pg-core';
import { CATEGORIES } from '../domain/categories.js';

/**
 * Multi-company tenancy is enforced by Postgres Row-Level Security (see rls.ts), not by the ORM:
 * every tenant table carries company_id and a policy `company_id = current_setting('app.company_id')`.
 * The app connects as a role that is NOT the table owner, so RLS cannot be bypassed from code.
 */

const timestamps = {
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
};

export const companies = pgTable('companies', {
  id: bigserial('id', { mode: 'number' }).primaryKey(),
  code: varchar('code', { length: 8 }).notNull().unique(),
  name: text('name').notNull(),
  npwp: varchar('npwp', { length: 16 }),
  address: text('address'),
  docPrefix: varchar('doc_prefix', { length: 12 }),
  ...timestamps,
});

/** Standalone identity (no ERP). Sessions/passwords are handled by the auth library (see src/auth). */
export const users = pgTable('users', {
  id: bigserial('id', { mode: 'number' }).primaryKey(),
  email: text('email').notNull().unique(),
  name: text('name').notNull(),
  isActive: boolean('is_active').notNull().default(true),
  ...timestamps,
});

export const COMPANY_ROLES = ['site_staff', 'project_admin', 'finance', 'company_manager', 'system_admin'] as const;
export type CompanyRole = (typeof COMPANY_ROLES)[number];

export const companyUsers = pgTable('company_users', {
  userId: bigint('user_id', { mode: 'number' }).notNull().references(() => users.id, { onDelete: 'cascade' }),
  companyId: bigint('company_id', { mode: 'number' }).notNull().references(() => companies.id, { onDelete: 'cascade' }),
  role: varchar('role', { length: 30 }).notNull().$type<CompanyRole>(),
  siteIds: jsonb('site_ids').$type<number[]>(),
  ...timestamps,
}, (t) => [primaryKey({ columns: [t.userId, t.companyId] })]);

export const MANAGEMENT_ROLES = ['holding_viewer', 'direksi'] as const;
export const managementViewers = pgTable('management_viewers', {
  id: bigserial('id', { mode: 'number' }).primaryKey(),
  userId: bigint('user_id', { mode: 'number' }).notNull().unique().references(() => users.id, { onDelete: 'cascade' }),
  role: varchar('role', { length: 20 }).notNull().$type<(typeof MANAGEMENT_ROLES)[number]>(),
  grantedBy: bigint('granted_by', { mode: 'number' }).references(() => users.id, { onDelete: 'set null' }),
  grantedAt: timestamp('granted_at', { withTimezone: true }),
  ...timestamps,
});

export const sites = pgTable('sites', {
  id: bigserial('id', { mode: 'number' }).primaryKey(),
  companyId: bigint('company_id', { mode: 'number' }).notNull().references(() => companies.id),
  code: varchar('code', { length: 20 }).notNull(),
  name: text('name').notNull(),
  location: text('location'),
  province: varchar('province', { length: 100 }),
  startDate: date('start_date'),
  endDate: date('end_date'),
  status: varchar('status', { length: 20 }).notNull().default('active'),
  ...timestamps,
}, (t) => [uniqueIndex('sites_company_code').on(t.companyId, t.code)]);

export const contracts = pgTable('contracts', {
  id: bigserial('id', { mode: 'number' }).primaryKey(),
  companyId: bigint('company_id', { mode: 'number' }).notNull().references(() => companies.id),
  siteId: bigint('site_id', { mode: 'number' }).notNull().references(() => sites.id),
  number: varchar('number', { length: 100 }).notNull(),
  employerName: text('employer_name').notNull(),
  /** cents, not numeric: integer arithmetic end to end (L8: value_total is derived, see ppnRateBp) */
  valueDppCents: bigint('value_dpp_cents', { mode: 'number' }).notNull(),
  /** basis points: 1100 = 11 % */
  ppnRateBp: integer('ppn_rate_bp').notNull().default(1100),
  signedAt: date('signed_at'),
  startDate: date('start_date'),
  endDate: date('end_date'),
  status: varchar('status', { length: 20 }).notNull().default('active'),
  ...timestamps,
}, (t) => [uniqueIndex('contracts_company_number').on(t.companyId, t.number), index('contracts_company_site').on(t.companyId, t.siteId)]);

/** B3: imports create a new version; nothing is deleted, item ids stay stable for progress rows. */
export const boqVersions = pgTable('boq_versions', {
  id: bigserial('id', { mode: 'number' }).primaryKey(),
  companyId: bigint('company_id', { mode: 'number' }).notNull().references(() => companies.id),
  contractId: bigint('contract_id', { mode: 'number' }).notNull().references(() => contracts.id),
  version: integer('version').notNull(),
  isCurrent: boolean('is_current').notNull().default(true),
  sourceFilename: text('source_filename'),
  sourceSha256: varchar('source_sha256', { length: 64 }),
  totalCents: bigint('total_cents', { mode: 'number' }).notNull(),
  anomalies: jsonb('anomalies').$type<unknown[]>().notNull().default(sql`'[]'::jsonb`),
  importedBy: bigint('imported_by', { mode: 'number' }).references(() => users.id, { onDelete: 'set null' }),
  ...timestamps,
}, (t) => [
  uniqueIndex('boq_versions_contract_version').on(t.contractId, t.version),
  // at most one current version per contract
  uniqueIndex('boq_versions_contract_current').on(t.contractId).where(sql`is_current`),
]);

export const boqItems = pgTable('boq_items', {
  id: bigserial('id', { mode: 'number' }).primaryKey(),
  companyId: bigint('company_id', { mode: 'number' }).notNull().references(() => companies.id),
  versionId: bigint('version_id', { mode: 'number' }).notNull().references(() => boqVersions.id, { onDelete: 'cascade' }),
  parentId: bigint('parent_id', { mode: 'number' }),
  code: varchar('code', { length: 80 }).notNull(),
  codePrinted: varchar('code_printed', { length: 40 }),
  description: text('description').notNull(),
  unit: varchar('unit', { length: 20 }),
  qty: numeric('qty', { precision: 18, scale: 4 }),
  unitPriceCents: bigint('unit_price_cents', { mode: 'number' }),
  amountCents: bigint('amount_cents', { mode: 'number' }).notNull(),
  /** millionths of a percent: 100 % = 100_000_000 (integer, Σ leaves = exactly 100 %) */
  weightMicroPct: bigint('weight_micro_pct', { mode: 'number' }).notNull().default(0),
  category: varchar('category', { length: 20 }).$type<(typeof CATEGORIES)[number]>(),
  level: smallint('level').notNull().default(0),
  isLeaf: boolean('is_leaf').notNull().default(true),
  sortOrder: integer('sort_order').notNull().default(0),
  ...timestamps,
}, (t) => [uniqueIndex('boq_items_version_code').on(t.versionId, t.code), index('boq_items_parent').on(t.parentId), index('boq_items_company_version').on(t.companyId, t.versionId)]);

export const boqSchedules = pgTable('boq_schedules', {
  id: bigserial('id', { mode: 'number' }).primaryKey(),
  companyId: bigint('company_id', { mode: 'number' }).notNull().references(() => companies.id),
  boqItemId: bigint('boq_item_id', { mode: 'number' }).notNull().references(() => boqItems.id, { onDelete: 'cascade' }),
  period: date('period').notNull(),
  plannedMicroPct: bigint('planned_micro_pct', { mode: 'number' }).notNull(),
  ...timestamps,
}, (t) => [uniqueIndex('boq_schedules_item_period').on(t.boqItemId, t.period)]);

/** Every table whose rows belong to one company. rls.ts applies the policy to each. */
export const TENANT_TABLES = ['sites', 'contracts', 'boq_versions', 'boq_items', 'boq_schedules'] as const;
