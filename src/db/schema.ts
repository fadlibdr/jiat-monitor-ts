import { sql } from 'drizzle-orm';
import {
  bigint, bigserial, boolean, date, index, integer, jsonb, numeric, pgTable, primaryKey, smallint, text, timestamp, uniqueIndex, uuid, varchar,
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

// ---------------------------------------------------------------------------------------------
// Phase 2 — intake (LLD §2, §5–7)
// ---------------------------------------------------------------------------------------------

export const VENDOR_STATUSES = ['active', 'draft'] as const;
/** Master vendor per company (HLD §7). `draft` = created from a chat VENDOR correction, to be reviewed. */
export const vendors = pgTable('vendors', {
  id: bigserial('id', { mode: 'number' }).primaryKey(),
  companyId: bigint('company_id', { mode: 'number' }).notNull().references(() => companies.id),
  name: text('name').notNull(),
  npwp: varchar('npwp', { length: 16 }),
  bankName: text('bank_name'),
  bankAccount: varchar('bank_account', { length: 40 }),
  phone: varchar('phone', { length: 30 }),
  defaultCategory: varchar('default_category', { length: 20 }).$type<(typeof CATEGORIES)[number]>(),
  status: varchar('status', { length: 10 }).notNull().default('active').$type<(typeof VENDOR_STATUSES)[number]>(),
  ...authorship,
  ...timestamps,
}, (t) => [uniqueIndex('vendors_company_name').on(t.companyId, t.name)]);

/**
 * Telegram group → company + site (HLD §2: maintained by the system admin). Configuration, not tenant
 * data: the webhook must resolve the company *before* it has a company context, so no RLS here.
 */
export const telegramChats = pgTable('telegram_chats', {
  id: bigserial('id', { mode: 'number' }).primaryKey(),
  chatId: bigint('chat_id', { mode: 'number' }).notNull().unique(),
  companyId: bigint('company_id', { mode: 'number' }).notNull().references(() => companies.id),
  siteId: bigint('site_id', { mode: 'number' }).notNull().references(() => sites.id),
  title: text('title'),
  isActive: boolean('is_active').notNull().default(true),
  ...timestamps,
});

export const INTAKE_KINDS = ['photo', 'correction'] as const;
export const INTAKE_OUTCOMES = [
  'pending', 'tersimpan', 'tersimpan_tanpa_balasan', 'duplikat', 'tidak_terbaca', 'ocr_error', 'gagal',
  'koreksi_ok', 'koreksi_ditolak', 'diabaikan',
] as const;
export type IntakeOutcome = (typeof INTAKE_OUTCOMES)[number];

/**
 * One row per Telegram message the bot acts on. unique(chat_id, message_id) makes the webhook
 * idempotent: Telegram's re-delivery of the same update cannot create a second job (LLD §5).
 */
export const intakeEvents = pgTable('intake_events', {
  id: bigserial('id', { mode: 'number' }).primaryKey(),
  companyId: bigint('company_id', { mode: 'number' }).notNull().references(() => companies.id),
  siteId: bigint('site_id', { mode: 'number' }).notNull().references(() => sites.id),
  chatId: bigint('chat_id', { mode: 'number' }).notNull(),
  messageId: bigint('message_id', { mode: 'number' }).notNull(),
  /** Telegram `from.id` (not users.id) */
  fromUserId: bigint('from_user_id', { mode: 'number' }),
  kind: varchar('kind', { length: 12 }).notNull().$type<(typeof INTAKE_KINDS)[number]>(),
  /** photo: {fileId, mime}; correction: {text, replyToMessageId} — never the whole update */
  payload: jsonb('payload').notNull(),
  outcome: varchar('outcome', { length: 30 }).notNull().default('pending').$type<IntakeOutcome>(),
  vendorInvoiceId: bigint('vendor_invoice_id', { mode: 'number' }),
  /** message id of the bot's reply, so a later "reply" from staff resolves to this row */
  replyMessageId: bigint('reply_message_id', { mode: 'number' }),
  error: text('error'),
  ...timestamps,
}, (t) => [
  uniqueIndex('intake_events_chat_message').on(t.chatId, t.messageId),
  index('intake_events_chat_reply').on(t.chatId, t.replyMessageId),
  index('intake_events_company_created').on(t.companyId, t.createdAt),
]);

/** Original files, never cropped or overwritten (HLD §8). sha256 unique per company = V8. */
export const attachments = pgTable('attachments', {
  id: bigserial('id', { mode: 'number' }).primaryKey(),
  companyId: bigint('company_id', { mode: 'number' }).notNull().references(() => companies.id),
  /** for the V9 near-duplicate window (same site); null for files not tied to a site */
  siteId: bigint('site_id', { mode: 'number' }).references(() => sites.id),
  attachableType: varchar('attachable_type', { length: 40 }).notNull(),
  attachableId: bigint('attachable_id', { mode: 'number' }).notNull(),
  path: text('path').notNull(),
  mime: varchar('mime', { length: 100 }).notNull(),
  size: integer('size').notNull(),
  sha256: varchar('sha256', { length: 64 }).notNull(),
  phash: varchar('phash', { length: 16 }),
  telegramFileId: text('telegram_file_id'),
  telegramMessageId: bigint('telegram_message_id', { mode: 'number' }),
  ...authorship,
  ...timestamps,
}, (t) => [
  uniqueIndex('attachments_company_sha256').on(t.companyId, t.sha256),
  index('attachments_attachable').on(t.attachableType, t.attachableId),
  index('attachments_site_created').on(t.siteId, t.createdAt),
]);

export const VENDOR_INVOICE_STATUSES = ['perlu_konfirmasi', 'perlu_cek', 'terkonfirmasi', 'ditolak'] as const;
export type VendorInvoiceStatus = (typeof VENDOR_INVOICE_STATUSES)[number];

/**
 * Supplier receipts/invoices (nota, faktur, kwitansi). From Telegram intake or entered manually.
 * row_id is the public reference used in chat (#last-4-hex) and in PATCH /intake/:rowId; the
 * internal id never leaves the API (LLD §2).
 */
export const vendorInvoices = pgTable('vendor_invoices', {
  id: bigserial('id', { mode: 'number' }).primaryKey(),
  companyId: bigint('company_id', { mode: 'number' }).notNull().references(() => companies.id),
  siteId: bigint('site_id', { mode: 'number' }).notNull().references(() => sites.id),
  rowId: uuid('row_id').notNull().defaultRandom().unique(),
  vendorId: bigint('vendor_id', { mode: 'number' }).references(() => vendors.id),
  /** vendor name as read by OCR / typed in chat, kept even after vendor_id is matched */
  vendorName: text('vendor_name'),
  npwp: varchar('npwp', { length: 16 }),
  invoiceDate: date('invoice_date'),
  docNumber: varchar('doc_number', { length: 100 }),
  description: text('description'),
  category: varchar('category', { length: 20 }).$type<(typeof CATEGORIES)[number]>(),
  dppCents: bigint('dpp_cents', { mode: 'number' }),
  ppnCents: bigint('ppn_cents', { mode: 'number' }),
  totalCents: bigint('total_cents', { mode: 'number' }).notNull(),
  dueDate: date('due_date'),
  status: varchar('status', { length: 20 }).notNull().$type<VendorInvoiceStatus>(),
  source: varchar('source', { length: 10 }).notNull().$type<'telegram' | 'manual'>(),
  imageHash: varchar('image_hash', { length: 64 }),
  phash: varchar('phash', { length: 16 }),
  /** per-field OCR confidence, validation flags, missing fields, near-duplicate candidates */
  confidence: jsonb('confidence').$type<IntakeReview>().notNull().default(sql`'{}'::jsonb`),
  confirmedAt: timestamp('confirmed_at', { withTimezone: true }),
  confirmedBy: bigint('confirmed_by', { mode: 'number' }),
  ...authorship,
  ...timestamps,
}, (t) => [
  uniqueIndex('vendor_invoices_company_image').on(t.companyId, t.imageHash),
  // second fence (LLD §6): one confirmed invoice per vendor/date/total. Partial instead of DEFERRABLE:
  // it binds exactly when a row is confirmed, and rows with an unknown vendor are not affected.
  uniqueIndex('vendor_invoices_confirmed_unique').on(t.companyId, t.vendorId, t.invoiceDate, t.totalCents)
    .where(sql`status = 'terkonfirmasi'`),
  index('vendor_invoices_company_status').on(t.companyId, t.status),
  index('vendor_invoices_site').on(t.siteId),
]);

export interface IntakeReview {
  fields?: Record<string, number>;
  flags?: string[];
  missing?: string[];
  nearDuplicates?: Array<{ rowId: string; distance: number }>;
  /** what OCR read for subtotal/ppn/line items, so a TOTAL correction can re-run V4/V5 */
  extracted?: { subtotalCents: number | null; ppnCents: number | null; itemsCents: number | null };
}

// ---------------------------------------------------------------------------------------------
// Phase 3 — procurement and progress (LLD §2)
// ---------------------------------------------------------------------------------------------

/** One counter per company, document type and year; incremented by an atomic upsert (docnumber.ts). */
export const documentSequences = pgTable('document_sequences', {
  companyId: bigint('company_id', { mode: 'number' }).notNull().references(() => companies.id),
  docType: varchar('doc_type', { length: 10 }).notNull(),
  year: integer('year').notNull(),
  lastNumber: integer('last_number').notNull().default(0),
  ...timestamps,
}, (t) => [primaryKey({ columns: [t.companyId, t.docType, t.year] })]);

export const PR_STATUSES = ['draft', 'submitted', 'approved', 'rejected', 'closed'] as const;
export const purchaseRequests = pgTable('purchase_requests', {
  id: bigserial('id', { mode: 'number' }).primaryKey(),
  companyId: bigint('company_id', { mode: 'number' }).notNull().references(() => companies.id),
  siteId: bigint('site_id', { mode: 'number' }).notNull().references(() => sites.id),
  contractId: bigint('contract_id', { mode: 'number' }).references(() => contracts.id),
  number: varchar('number', { length: 40 }).notNull(),
  requestedBy: bigint('requested_by', { mode: 'number' }),
  neededBy: date('needed_by'),
  status: varchar('status', { length: 12 }).notNull().default('draft').$type<(typeof PR_STATUSES)[number]>(),
  note: text('note'),
  decidedBy: bigint('decided_by', { mode: 'number' }),
  decidedAt: timestamp('decided_at', { withTimezone: true }),
  ...authorship,
  ...timestamps,
}, (t) => [uniqueIndex('purchase_requests_company_number').on(t.companyId, t.number), index('purchase_requests_company_status').on(t.companyId, t.status)]);

export const purchaseRequestItems = pgTable('purchase_request_items', {
  id: bigserial('id', { mode: 'number' }).primaryKey(),
  companyId: bigint('company_id', { mode: 'number' }).notNull().references(() => companies.id),
  prId: bigint('pr_id', { mode: 'number' }).notNull().references(() => purchaseRequests.id, { onDelete: 'cascade' }),
  boqItemId: bigint('boq_item_id', { mode: 'number' }).references(() => boqItems.id),
  description: text('description').notNull(),
  qty: numeric('qty', { precision: 18, scale: 4 }).notNull(),
  unit: varchar('unit', { length: 20 }),
  estPriceCents: bigint('est_price_cents', { mode: 'number' }),
  ...timestamps,
}, (t) => [index('purchase_request_items_pr').on(t.prId)]);

/** draft → issued (approved by a manager, HLD §2) → partial / received by goods receipts; or cancelled. */
export const PO_STATUSES = ['draft', 'issued', 'partial', 'received', 'cancelled'] as const;
export const purchaseOrders = pgTable('purchase_orders', {
  id: bigserial('id', { mode: 'number' }).primaryKey(),
  companyId: bigint('company_id', { mode: 'number' }).notNull().references(() => companies.id),
  siteId: bigint('site_id', { mode: 'number' }).notNull().references(() => sites.id),
  vendorId: bigint('vendor_id', { mode: 'number' }).notNull().references(() => vendors.id),
  prId: bigint('pr_id', { mode: 'number' }).references(() => purchaseRequests.id),
  contractId: bigint('contract_id', { mode: 'number' }).references(() => contracts.id),
  number: varchar('number', { length: 40 }).notNull(),
  orderDate: date('order_date').notNull(),
  expectedDate: date('expected_date'),
  ppnRateBp: integer('ppn_rate_bp').notNull().default(1100),
  /** snapshot of Σ line amounts at write time, server-computed, never client-provided */
  dppCents: bigint('dpp_cents', { mode: 'number' }).notNull().default(0),
  ppnCents: bigint('ppn_cents', { mode: 'number' }).notNull().default(0),
  totalCents: bigint('total_cents', { mode: 'number' }).notNull().default(0),
  status: varchar('status', { length: 12 }).notNull().default('draft').$type<(typeof PO_STATUSES)[number]>(),
  approvedBy: bigint('approved_by', { mode: 'number' }),
  approvedAt: timestamp('approved_at', { withTimezone: true }),
  note: text('note'),
  ...authorship,
  ...timestamps,
}, (t) => [
  uniqueIndex('purchase_orders_company_number').on(t.companyId, t.number),
  index('purchase_orders_vendor').on(t.vendorId),
  index('purchase_orders_company_status').on(t.companyId, t.status),
]);

export const purchaseOrderItems = pgTable('purchase_order_items', {
  id: bigserial('id', { mode: 'number' }).primaryKey(),
  companyId: bigint('company_id', { mode: 'number' }).notNull().references(() => companies.id),
  poId: bigint('po_id', { mode: 'number' }).notNull().references(() => purchaseOrders.id, { onDelete: 'cascade' }),
  prItemId: bigint('pr_item_id', { mode: 'number' }).references(() => purchaseRequestItems.id),
  boqItemId: bigint('boq_item_id', { mode: 'number' }).references(() => boqItems.id),
  description: text('description').notNull(),
  qty: numeric('qty', { precision: 18, scale: 4 }).notNull(),
  unit: varchar('unit', { length: 20 }),
  unitPriceCents: bigint('unit_price_cents', { mode: 'number' }).notNull(),
  amountCents: bigint('amount_cents', { mode: 'number' }).notNull(),
  ...timestamps,
}, (t) => [index('purchase_order_items_po').on(t.poId), index('purchase_order_items_boq').on(t.boqItemId)]);

export const goodsReceipts = pgTable('goods_receipts', {
  id: bigserial('id', { mode: 'number' }).primaryKey(),
  companyId: bigint('company_id', { mode: 'number' }).notNull().references(() => companies.id),
  /** copied from the PO, so the site scope applies without a join */
  siteId: bigint('site_id', { mode: 'number' }).notNull().references(() => sites.id),
  poId: bigint('po_id', { mode: 'number' }).notNull().references(() => purchaseOrders.id),
  number: varchar('number', { length: 40 }).notNull(),
  receivedAt: date('received_at').notNull(),
  receivedBy: bigint('received_by', { mode: 'number' }),
  note: text('note'),
  ...authorship,
  ...timestamps,
}, (t) => [uniqueIndex('goods_receipts_company_number').on(t.companyId, t.number), index('goods_receipts_po').on(t.poId)]);

export const goodsReceiptItems = pgTable('goods_receipt_items', {
  id: bigserial('id', { mode: 'number' }).primaryKey(),
  companyId: bigint('company_id', { mode: 'number' }).notNull().references(() => companies.id),
  grId: bigint('gr_id', { mode: 'number' }).notNull().references(() => goodsReceipts.id, { onDelete: 'cascade' }),
  poItemId: bigint('po_item_id', { mode: 'number' }).notNull().references(() => purchaseOrderItems.id),
  qtyReceived: numeric('qty_received', { precision: 18, scale: 4 }).notNull(),
  note: text('note'),
  ...timestamps,
}, (t) => [index('goods_receipt_items_gr').on(t.grId), index('goods_receipt_items_po_item').on(t.poItemId)]);

/** Opname per contract per month: draft/rejected → submitted → approved by a manager (HLD §2). */
export const PROGRESS_STATUSES = ['draft', 'submitted', 'approved', 'rejected'] as const;
export const progressReports = pgTable('progress_reports', {
  id: bigserial('id', { mode: 'number' }).primaryKey(),
  companyId: bigint('company_id', { mode: 'number' }).notNull().references(() => companies.id),
  siteId: bigint('site_id', { mode: 'number' }).notNull().references(() => sites.id),
  contractId: bigint('contract_id', { mode: 'number' }).notNull().references(() => contracts.id),
  /** first day of the month */
  period: date('period').notNull(),
  reportedBy: bigint('reported_by', { mode: 'number' }),
  approvedBy: bigint('approved_by', { mode: 'number' }),
  approvedAt: timestamp('approved_at', { withTimezone: true }),
  status: varchar('status', { length: 12 }).notNull().default('draft').$type<(typeof PROGRESS_STATUSES)[number]>(),
  note: text('note'),
  ...authorship,
  ...timestamps,
}, (t) => [uniqueIndex('progress_reports_contract_period').on(t.contractId, t.period), index('progress_reports_company_status').on(t.companyId, t.status)]);

export const progressItems = pgTable('progress_items', {
  id: bigserial('id', { mode: 'number' }).primaryKey(),
  companyId: bigint('company_id', { mode: 'number' }).notNull().references(() => companies.id),
  reportId: bigint('report_id', { mode: 'number' }).notNull().references(() => progressReports.id, { onDelete: 'cascade' }),
  boqItemId: bigint('boq_item_id', { mode: 'number' }).notNull().references(() => boqItems.id),
  /** cumulative quantity done to date, when the item has a quantity */
  qtyDone: numeric('qty_done', { precision: 18, scale: 4 }),
  /** cumulative % of the item complete at the end of the period, micro-percent (100 % = 100_000_000) */
  cumulativeMicroPct: bigint('cumulative_micro_pct', { mode: 'number' }).notNull(),
  ...timestamps,
}, (t) => [uniqueIndex('progress_items_report_item').on(t.reportId, t.boqItemId)]);

// ---------------------------------------------------------------------------------------------
// Phase 4 — invoicing and dashboards (LLD §2, §8)
// ---------------------------------------------------------------------------------------------

/** Termin invoice to the employer. Amounts are computed at issue (domain/invoice.ts) and frozen. */
export const SALES_INVOICE_STATUSES = ['issued', 'partial', 'paid', 'cancelled'] as const;
export const salesInvoices = pgTable('sales_invoices', {
  id: bigserial('id', { mode: 'number' }).primaryKey(),
  companyId: bigint('company_id', { mode: 'number' }).notNull().references(() => companies.id),
  siteId: bigint('site_id', { mode: 'number' }).notNull().references(() => sites.id),
  contractId: bigint('contract_id', { mode: 'number' }).notNull().references(() => contracts.id),
  termId: bigint('term_id', { mode: 'number' }).notNull().references(() => contractTerms.id),
  number: varchar('number', { length: 40 }).notNull(),
  invoiceDate: date('invoice_date').notNull(),
  dueDate: date('due_date').notNull(),
  /** weighted physical progress (approved) when the invoice was issued, micro-percent */
  progressMicroPct: bigint('progress_micro_pct', { mode: 'number' }).notNull(),
  dppCents: bigint('dpp_cents', { mode: 'number' }).notNull(),
  advanceDeductionCents: bigint('advance_deduction_cents', { mode: 'number' }).notNull(),
  retentionCents: bigint('retention_cents', { mode: 'number' }).notNull(),
  ppnCents: bigint('ppn_cents', { mode: 'number' }).notNull(),
  totalCents: bigint('total_cents', { mode: 'number' }).notNull(),
  status: varchar('status', { length: 12 }).notNull().default('issued').$type<(typeof SALES_INVOICE_STATUSES)[number]>(),
  ...authorship,
  ...timestamps,
}, (t) => [
  uniqueIndex('sales_invoices_company_number').on(t.companyId, t.number),
  // one live invoice per termin; a cancelled one may be re-issued
  uniqueIndex('sales_invoices_term_live').on(t.termId).where(sql`status <> 'cancelled'`),
  index('sales_invoices_contract').on(t.contractId),
]);

export const PAYABLE_TYPES = ['sales_invoices', 'vendor_invoices'] as const;
export const PAYMENT_METHODS = ['transfer', 'tunai', 'giro', 'lain'] as const;
/** Money in (sales invoices) and out (vendor invoices). */
export const payments = pgTable('payments', {
  id: bigserial('id', { mode: 'number' }).primaryKey(),
  companyId: bigint('company_id', { mode: 'number' }).notNull().references(() => companies.id),
  /** site of the paid document, for the site scope and the per-site cash panel */
  siteId: bigint('site_id', { mode: 'number' }).notNull().references(() => sites.id),
  payableType: varchar('payable_type', { length: 20 }).notNull().$type<(typeof PAYABLE_TYPES)[number]>(),
  payableId: bigint('payable_id', { mode: 'number' }).notNull(),
  paidAt: date('paid_at').notNull(),
  amountCents: bigint('amount_cents', { mode: 'number' }).notNull(),
  method: varchar('method', { length: 12 }).notNull().$type<(typeof PAYMENT_METHODS)[number]>(),
  reference: varchar('reference', { length: 100 }),
  note: text('note'),
  ...authorship,
  ...timestamps,
}, (t) => [index('payments_payable').on(t.payableType, t.payableId), index('payments_company_paid').on(t.companyId, t.paidAt)]);

/**
 * Dashboard snapshots (LLD §8). The LLD's materialized views are implemented as tables written by
 * the RefreshDashboards job with the SAME functions the detail endpoints use, so "holding = Σ
 * detail" holds by construction and the S-curve carry-forward is not re-implemented in SQL. The
 * job replaces a company's rows in one transaction: readers see the old or the new snapshot,
 * never a mix. Holding reads them through jiat_holding (SELECT only).
 */
export const dashContracts = pgTable('dash_contracts', {
  contractId: bigint('contract_id', { mode: 'number' }).primaryKey().references(() => contracts.id),
  companyId: bigint('company_id', { mode: 'number' }).notNull().references(() => companies.id),
  siteId: bigint('site_id', { mode: 'number' }).notNull().references(() => sites.id),
  number: varchar('number', { length: 100 }).notNull(),
  employerName: text('employer_name').notNull(),
  status: varchar('status', { length: 20 }).notNull(),
  valueDppCents: bigint('value_dpp_cents', { mode: 'number' }).notNull(),
  addendumDeltaCents: bigint('addendum_delta_cents', { mode: 'number' }).notNull(),
  valueDppEffectiveCents: bigint('value_dpp_effective_cents', { mode: 'number' }).notNull(),
  valueTotalCents: bigint('value_total_cents', { mode: 'number' }).notNull(),
  endDateEffective: date('end_date_effective'),
  termsTotal: integer('terms_total').notNull(),
  termsIssued: integer('terms_issued').notNull(),
  /** termin whose progress trigger is reached but not yet invoiced */
  termsReady: integer('terms_ready').notNull(),
  plannedMicroPct: bigint('planned_micro_pct', { mode: 'number' }),
  actualMicroPct: bigint('actual_micro_pct', { mode: 'number' }),
  /** BOQ budget vs PO commitment vs received, total and per category (mockup "Komitmen vs BOQ") */
  commitment: jsonb('commitment').$type<DashCommitment>().notNull().default(sql`'{}'::jsonb`),
  refreshedAt: timestamp('refreshed_at', { withTimezone: true }).notNull(),
}, (t) => [index('dash_contracts_company').on(t.companyId)]);

export interface DashMoney { budgetCents: number; committedCents: number; receivedCents: number }
export interface DashCommitment { total?: DashMoney; byCategory?: Record<string, DashMoney> }

export const dashProgress = pgTable('dash_progress', {
  contractId: bigint('contract_id', { mode: 'number' }).notNull().references(() => contracts.id),
  period: date('period').notNull(),
  companyId: bigint('company_id', { mode: 'number' }).notNull().references(() => companies.id),
  siteId: bigint('site_id', { mode: 'number' }).notNull().references(() => sites.id),
  plannedMicroPct: bigint('planned_micro_pct', { mode: 'number' }).notNull(),
  actualMicroPct: bigint('actual_micro_pct', { mode: 'number' }),
  deviationMicroPct: bigint('deviation_micro_pct', { mode: 'number' }),
}, (t) => [primaryKey({ columns: [t.contractId, t.period] }), index('dash_progress_company').on(t.companyId)]);

/** Money per company × site × month (procurement, invoicing, cash, cost). */
export const dashMonthly = pgTable('dash_monthly', {
  companyId: bigint('company_id', { mode: 'number' }).notNull().references(() => companies.id),
  siteId: bigint('site_id', { mode: 'number' }).notNull().references(() => sites.id),
  period: date('period').notNull(),
  poIssuedCents: bigint('po_issued_cents', { mode: 'number' }).notNull().default(0),
  grReceivedCents: bigint('gr_received_cents', { mode: 'number' }).notNull().default(0),
  invoicedDppCents: bigint('invoiced_dpp_cents', { mode: 'number' }).notNull().default(0),
  invoicedTotalCents: bigint('invoiced_total_cents', { mode: 'number' }).notNull().default(0),
  cashInCents: bigint('cash_in_cents', { mode: 'number' }).notNull().default(0),
  cashOutCents: bigint('cash_out_cents', { mode: 'number' }).notNull().default(0),
  /** confirmed vendor invoices (realised cost) by category: {material: cents, …} */
  costByCategory: jsonb('cost_by_category').$type<Record<string, number>>().notNull().default(sql`'{}'::jsonb`),
}, (t) => [primaryKey({ columns: [t.companyId, t.siteId, t.period] })]);

/** Point-in-time balances per company × site (as of the refresh). */
export const dashBalances = pgTable('dash_balances', {
  companyId: bigint('company_id', { mode: 'number' }).notNull().references(() => companies.id),
  siteId: bigint('site_id', { mode: 'number' }).notNull().references(() => sites.id),
  receivable0to30Cents: bigint('receivable_0_30_cents', { mode: 'number' }).notNull().default(0),
  receivable31to60Cents: bigint('receivable_31_60_cents', { mode: 'number' }).notNull().default(0),
  receivable61to90Cents: bigint('receivable_61_90_cents', { mode: 'number' }).notNull().default(0),
  receivable90pCents: bigint('receivable_90p_cents', { mode: 'number' }).notNull().default(0),
  payableTotalCents: bigint('payable_total_cents', { mode: 'number' }).notNull().default(0),
  payableOverdueCents: bigint('payable_overdue_cents', { mode: 'number' }).notNull().default(0),
  prOpen: integer('pr_open').notNull().default(0),
  prWaiting: integer('pr_waiting').notNull().default(0),
  poOutstandingCents: bigint('po_outstanding_cents', { mode: 'number' }).notNull().default(0),
  poOverdueCount: integer('po_overdue_count').notNull().default(0),
  photos7d: integer('photos_7d').notNull().default(0),
  asked7d: integer('asked_7d').notNull().default(0),
  openKonfirmasi: integer('open_konfirmasi').notNull().default(0),
  openCek: integer('open_cek').notNull().default(0),
  medianConfirmMinutes7d: integer('median_confirm_minutes_7d'),
  refreshedAt: timestamp('refreshed_at', { withTimezone: true }).notNull(),
}, (t) => [primaryKey({ columns: [t.companyId, t.siteId] })]);

/** Top vendors per company by committed PO value, with what is not yet delivered. */
export const dashVendors = pgTable('dash_vendors', {
  companyId: bigint('company_id', { mode: 'number' }).notNull().references(() => companies.id),
  vendorId: bigint('vendor_id', { mode: 'number' }).notNull().references(() => vendors.id),
  vendorName: text('vendor_name').notNull(),
  poValueCents: bigint('po_value_cents', { mode: 'number' }).notNull(),
  undeliveredCents: bigint('undelivered_cents', { mode: 'number' }).notNull(),
}, (t) => [primaryKey({ columns: [t.companyId, t.vendorId] })]);

/** When each company's snapshot was last rebuilt ("data per HH:MM"; POST /holding/refresh guard). */
export const dashRefreshes = pgTable('dash_refreshes', {
  companyId: bigint('company_id', { mode: 'number' }).primaryKey().references(() => companies.id),
  refreshedAt: timestamp('refreshed_at', { withTimezone: true }).notNull(),
});

/**
 * Background jobs (LLD §9), Postgres-backed so the pilot needs no Redis. Not a tenant table: the
 * worker claims across companies, and every job carries company_id explicitly (LLD §3); handlers
 * run inside withCompany(job.companyId).
 */
export const jobs = pgTable('jobs', {
  id: bigserial('id', { mode: 'number' }).primaryKey(),
  kind: varchar('kind', { length: 50 }).notNull(),
  companyId: bigint('company_id', { mode: 'number' }).references(() => companies.id),
  payload: jsonb('payload').notNull().default(sql`'{}'::jsonb`),
  runAt: timestamp('run_at', { withTimezone: true }).notNull().defaultNow(),
  attempts: integer('attempts').notNull().default(0),
  maxAttempts: integer('max_attempts').notNull().default(3),
  lockedAt: timestamp('locked_at', { withTimezone: true }),
  lockedBy: text('locked_by'),
  lastError: text('last_error'),
  /** jobs with the same key run one at a time, in id order (e.g. corrections of one chat) */
  serialKey: text('serial_key'),
  doneAt: timestamp('done_at', { withTimezone: true }),
  failedAt: timestamp('failed_at', { withTimezone: true }),
  ...timestamps,
}, (t) => [
  index('jobs_due').on(t.runAt).where(sql`done_at IS NULL AND failed_at IS NULL`),
  index('jobs_serial_open').on(t.serialKey, t.id).where(sql`serial_key IS NOT NULL AND done_at IS NULL AND failed_at IS NULL`),
]);

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
  'vendors', 'intake_events', 'attachments', 'vendor_invoices',
  'document_sequences', 'purchase_requests', 'purchase_request_items', 'purchase_orders', 'purchase_order_items',
  'goods_receipts', 'goods_receipt_items', 'progress_reports', 'progress_items',
  'sales_invoices', 'payments', 'dash_contracts', 'dash_progress', 'dash_monthly', 'dash_balances', 'dash_vendors', 'dash_refreshes',
] as const;
