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

/**
 * Who wrote the row. Never set by the app: the `jiat_stamp` trigger (audit.ts) fills them from
 * `app.user_id`, which withCompany() sets per transaction, and also keeps updated_at current.
 */
const authorship = {
  createdBy: bigint('created_by', { mode: 'number' }),
  updatedBy: bigint('updated_by', { mode: 'number' }),
};

export const companies = pgTable('companies', {
  id: bigserial('id', { mode: 'number' }).primaryKey(),
  code: varchar('code', { length: 8 }).notNull().unique(),
  name: text('name').notNull(),
  npwp: varchar('npwp', { length: 16 }),
  address: text('address'),
  bankName: text('bank_name'),
  bankAccount: varchar('bank_account', { length: 40 }),
  logoPath: text('logo_path'),
  docPrefix: varchar('doc_prefix', { length: 12 }),
  ...timestamps,
});

/**
 * Standalone identity (no ERP). users/sessions/accounts/verifications are the Better Auth core
 * models (serial ids via `advanced.database.generateId: "serial"`); passwords live hashed in
 * accounts.password, sessions are server-side rows referenced by an httpOnly cookie.
 */
export const users = pgTable('users', {
  id: bigserial('id', { mode: 'number' }).primaryKey(),
  email: text('email').notNull().unique(),
  name: text('name').notNull(),
  emailVerified: boolean('email_verified').notNull().default(false),
  image: text('image'),
  isActive: boolean('is_active').notNull().default(true),
  phone: varchar('phone', { length: 30 }),
  /** Telegram `from.id`; links chat corrections to a user so non-members can be ignored (LLD §7). */
  telegramUserId: bigint('telegram_user_id', { mode: 'number' }).unique(),
  /** HLD §2 "Admin sistem": global, manages companies/users/roles/Telegram mapping, not transaction data. */
  isSystemAdmin: boolean('is_system_admin').notNull().default(false),
  ...timestamps,
});

export const sessions = pgTable('sessions', {
  id: bigserial('id', { mode: 'number' }).primaryKey(),
  userId: bigint('user_id', { mode: 'number' }).notNull().references(() => users.id, { onDelete: 'cascade' }),
  token: text('token').notNull().unique(),
  expiresAt: timestamp('expires_at', { withTimezone: true }).notNull(),
  ipAddress: text('ip_address'),
  userAgent: text('user_agent'),
  ...timestamps,
}, (t) => [index('sessions_user').on(t.userId)]);

export const accounts = pgTable('accounts', {
  id: bigserial('id', { mode: 'number' }).primaryKey(),
  userId: bigint('user_id', { mode: 'number' }).notNull().references(() => users.id, { onDelete: 'cascade' }),
  accountId: text('account_id').notNull(),
  providerId: text('provider_id').notNull(),
  accessToken: text('access_token'),
  refreshToken: text('refresh_token'),
  idToken: text('id_token'),
  accessTokenExpiresAt: timestamp('access_token_expires_at', { withTimezone: true }),
  refreshTokenExpiresAt: timestamp('refresh_token_expires_at', { withTimezone: true }),
  scope: text('scope'),
  password: text('password'),
  ...timestamps,
}, (t) => [index('accounts_user').on(t.userId)]);

export const verifications = pgTable('verifications', {
  id: bigserial('id', { mode: 'number' }).primaryKey(),
  identifier: text('identifier').notNull(),
  value: text('value').notNull(),
  expiresAt: timestamp('expires_at', { withTimezone: true }).notNull(),
  ...timestamps,
}, (t) => [index('verifications_identifier').on(t.identifier)]);

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
  ...authorship,
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
  /**
   * Retention withheld from every termin, in basis points of the termin DPP (500 = 5 %).
   * Not in LLD §2 (sales_invoices.retention had no source); added so termin invoices need no manual input.
   */
  retentionBp: integer('retention_bp').notNull().default(0),
  /** Uang muka received (DPP, cents). Recovered from each termin in proportion to the termin percent. */
  advanceCents: bigint('advance_cents', { mode: 'number' }).notNull().default(0),
  signedAt: date('signed_at'),
  startDate: date('start_date'),
  endDate: date('end_date'),
  status: varchar('status', { length: 20 }).notNull().default('active'),
  ...authorship,
  ...timestamps,
}, (t) => [uniqueIndex('contracts_company_number').on(t.companyId, t.number), index('contracts_company_site').on(t.companyId, t.siteId)]);

/** Addenda change value and/or end date; the effective contract is derived, the original is never edited. */
export const contractAddendums = pgTable('contract_addendums', {
  id: bigserial('id', { mode: 'number' }).primaryKey(),
  companyId: bigint('company_id', { mode: 'number' }).notNull().references(() => companies.id),
  contractId: bigint('contract_id', { mode: 'number' }).notNull().references(() => contracts.id),
  number: varchar('number', { length: 100 }).notNull(),
  signedAt: date('signed_at').notNull(),
  /** signed DPP change in cents (negative = pekerjaan kurang) */
  valueDeltaCents: bigint('value_delta_cents', { mode: 'number' }).notNull().default(0),
  endDateNew: date('end_date_new'),
  note: text('note'),
  ...authorship,
  ...timestamps,
}, (t) => [uniqueIndex('contract_addendums_contract_number').on(t.contractId, t.number), index('contract_addendums_contract').on(t.contractId)]);

/**
 * Payment terms (termin). The termin amount is derived from the effective DPP × percent when the
 * invoice is issued (LLD stored amount_dpp; deriving it keeps it right after an addendum).
 */
export const contractTerms = pgTable('contract_terms', {
  id: bigserial('id', { mode: 'number' }).primaryKey(),
  companyId: bigint('company_id', { mode: 'number' }).notNull().references(() => companies.id),
  contractId: bigint('contract_id', { mode: 'number' }).notNull().references(() => contracts.id),
  seq: smallint('seq').notNull(),
  name: text('name').notNull(),
  /** share of the contract DPP, basis points (2000 = 20 %) */
  percentBp: integer('percent_bp').notNull(),
  /** weighted physical progress at which the termin may be invoiced, basis points (4000 = 40 %) */
  triggerProgressBp: integer('trigger_progress_bp').notNull(),
  dueDays: integer('due_days').notNull().default(30),
  ...authorship,
  ...timestamps,
}, (t) => [uniqueIndex('contract_terms_contract_seq').on(t.contractId, t.seq)]);

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

/**
 * Append-only. The app role has no INSERT/UPDATE/DELETE grant: rows are written only by the
 * SECURITY DEFINER trigger/function in audit.ts (data changes, chat corrections, holding access).
 */
export const auditLogs = pgTable('audit_logs', {
  id: bigserial('id', { mode: 'number' }).primaryKey(),
  /** null for holding access (cross-company) */
  companyId: bigint('company_id', { mode: 'number' }),
  userId: bigint('user_id', { mode: 'number' }),
  action: varchar('action', { length: 30 }).notNull(),
  auditableType: varchar('auditable_type', { length: 60 }),
  auditableId: bigint('auditable_id', { mode: 'number' }),
  before: jsonb('before'),
  after: jsonb('after'),
  meta: jsonb('meta'),
  ip: text('ip'),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
}, (t) => [index('audit_logs_auditable').on(t.auditableType, t.auditableId), index('audit_logs_user_created').on(t.userId, t.createdAt)]);

/** Every table whose rows belong to one company. rls.ts applies the policy to each. */
export const TENANT_TABLES = [
  'sites', 'contracts', 'contract_addendums', 'contract_terms', 'boq_versions', 'boq_items', 'boq_schedules',
] as const;
