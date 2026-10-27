import { TENANT_TABLES } from './schema.js';

/**
 * Row-Level Security DDL. Idempotent; run after the schema migration by the OWNER role.
 *
 * Roles
 *  - jiat_app      : the API's role. Sees/changes only rows of current_setting('app.company_id').
 *  - jiat_holding  : SELECT-only across companies, for management viewers (the only cross-company door).
 * Both are NOLOGIN and are assumed via `SET LOCAL ROLE` inside a transaction (see tenant.ts),
 * so the login role used by the pool must be a member of both and must NOT own the tables.
 *
 * Site scope (HLD §2: site staff see only the sites they are assigned to) is a second, RESTRICTIVE
 * policy on top of the company policy. withCompany() sets `app.site_scope = 'list'` and
 * `app.site_ids = '3,7'` for a scoped member; unset means every site of the company.
 */
export const APP_ROLE = 'jiat_app';
export const HOLDING_ROLE = 'jiat_holding';

type TenantTable = (typeof TENANT_TABLES)[number];

const UNSCOPED = `jiat_site_unscoped()`;
const viaContract = `(${UNSCOPED} OR EXISTS (SELECT 1 FROM contracts c WHERE c.id = contract_id))`;

/**
 * How each tenant table reaches a site; `null` = company-wide data with no site dimension.
 * Typed over TENANT_TABLES, so adding a tenant table does not compile until its scope is decided.
 * The EXISTS forms read the parent through RLS, so they inherit the parent's site check.
 */
const SITE_SCOPE: Record<TenantTable, string | null> = {
  sites: `jiat_site_allowed(id)`,
  contracts: `jiat_site_allowed(site_id)`,
  contract_addendums: viaContract,
  contract_terms: viaContract,
  boq_versions: viaContract,
  boq_items: `(${UNSCOPED} OR EXISTS (SELECT 1 FROM boq_versions v WHERE v.id = version_id))`,
  boq_schedules: `(${UNSCOPED} OR EXISTS (SELECT 1 FROM boq_items b WHERE b.id = boq_item_id))`,
  vendors: null, // company-wide master data
  intake_events: `jiat_site_allowed(site_id)`,
  attachments: `(site_id IS NULL OR jiat_site_allowed(site_id))`,
  vendor_invoices: `jiat_site_allowed(site_id)`,
  document_sequences: null, // per company, no site dimension
  purchase_requests: `jiat_site_allowed(site_id)`,
  purchase_request_items: `(${UNSCOPED} OR EXISTS (SELECT 1 FROM purchase_requests p WHERE p.id = pr_id))`,
  purchase_orders: `jiat_site_allowed(site_id)`,
  purchase_order_items: `(${UNSCOPED} OR EXISTS (SELECT 1 FROM purchase_orders p WHERE p.id = po_id))`,
  goods_receipts: `jiat_site_allowed(site_id)`,
  goods_receipt_items: `(${UNSCOPED} OR EXISTS (SELECT 1 FROM goods_receipts g WHERE g.id = gr_id))`,
  progress_reports: `jiat_site_allowed(site_id)`,
  progress_items: `(${UNSCOPED} OR EXISTS (SELECT 1 FROM progress_reports r WHERE r.id = report_id))`,
  sales_invoices: `jiat_site_allowed(site_id)`,
  payments: `jiat_site_allowed(site_id)`,
  dash_contracts: `jiat_site_allowed(site_id)`,
  dash_progress: `jiat_site_allowed(site_id)`,
  dash_monthly: `jiat_site_allowed(site_id)`,
  dash_balances: `jiat_site_allowed(site_id)`,
  dash_vendors: `jiat_site_allowed(site_id)`,
  dash_alerts: `jiat_site_allowed(site_id)`,
  dash_refreshes: null,
  daily_digests: null,
};

export function rlsStatements(): string[] {
  const out: string[] = [
    `DO $$ BEGIN IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = '${APP_ROLE}') THEN CREATE ROLE ${APP_ROLE} NOLOGIN; END IF; END $$;`,
    `DO $$ BEGIN IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = '${HOLDING_ROLE}') THEN CREATE ROLE ${HOLDING_ROLE} NOLOGIN; END IF; END $$;`,
    // V10 vendor matching (similarity()); a trusted extension, so the database owner may create it
    `CREATE EXTENSION IF NOT EXISTS pg_trgm;`,
    `GRANT USAGE ON SCHEMA public TO ${APP_ROLE}, ${HOLDING_ROLE};`,
    // non-tenant tables: app may read/write, holding may read
    `GRANT SELECT, INSERT, UPDATE, DELETE ON companies, users, company_users, management_viewers, sessions, accounts, verifications, telegram_chats, jobs TO ${APP_ROLE};`,
    `GRANT SELECT ON companies, users, company_users, management_viewers TO ${HOLDING_ROLE};`,
    `GRANT USAGE, SELECT ON ALL SEQUENCES IN SCHEMA public TO ${APP_ROLE};`,
    `CREATE OR REPLACE FUNCTION jiat_site_unscoped() RETURNS boolean LANGUAGE sql STABLE AS $$
       SELECT coalesce(current_setting('app.site_scope', true), '') <> 'list'
     $$;`,
    // an empty list means "no site": string_to_array('') is NULL, and x = ANY('{}') is false
    `CREATE OR REPLACE FUNCTION jiat_site_allowed(site bigint) RETURNS boolean LANGUAGE sql STABLE AS $$
       SELECT jiat_site_unscoped()
           OR site = ANY(coalesce(string_to_array(NULLIF(current_setting('app.site_ids', true), ''), ',')::bigint[], '{}'::bigint[]))
     $$;`,
  ];
  for (const t of TENANT_TABLES) {
    out.push(
      `GRANT SELECT, INSERT, UPDATE, DELETE ON ${t} TO ${APP_ROLE};`,
      `GRANT SELECT ON ${t} TO ${HOLDING_ROLE};`,
      `ALTER TABLE ${t} ENABLE ROW LEVEL SECURITY;`,
      `ALTER TABLE ${t} FORCE ROW LEVEL SECURITY;`,
      `DROP POLICY IF EXISTS ${t}_company_isolation ON ${t};`,
      // current_setting(..., true) returns NULL when unset => no rows (never "everything")
      `CREATE POLICY ${t}_company_isolation ON ${t} TO ${APP_ROLE}
         USING (company_id = NULLIF(current_setting('app.company_id', true), '')::bigint)
         WITH CHECK (company_id = NULLIF(current_setting('app.company_id', true), '')::bigint);`,
      `DROP POLICY IF EXISTS ${t}_holding_read ON ${t};`,
      `CREATE POLICY ${t}_holding_read ON ${t} FOR SELECT TO ${HOLDING_ROLE} USING (true);`,
      `DROP POLICY IF EXISTS ${t}_site_scope ON ${t};`,
    );
    const scope = SITE_SCOPE[t];
    if (scope) {
      out.push(`CREATE POLICY ${t}_site_scope ON ${t} AS RESTRICTIVE TO ${APP_ROLE} USING (${scope}) WITH CHECK (${scope});`);
    }
  }
  return out;
}
