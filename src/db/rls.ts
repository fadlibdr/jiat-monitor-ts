import { TENANT_TABLES } from './schema.js';

/**
 * Row-Level Security DDL. Idempotent; run after the schema migration by the OWNER role.
 *
 * Roles
 *  - jiat_app      : the API's role. Sees/changes only rows of current_setting('app.company_id').
 *  - jiat_holding  : SELECT-only across companies, for management viewers (the only cross-company door).
 * Both are NOLOGIN and are assumed via `SET LOCAL ROLE` inside a transaction (see tenant.ts),
 * so the login role used by the pool must be a member of both and must NOT own the tables.
 */
export const APP_ROLE = 'jiat_app';
export const HOLDING_ROLE = 'jiat_holding';

export function rlsStatements(): string[] {
  const out: string[] = [
    `DO $$ BEGIN IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = '${APP_ROLE}') THEN CREATE ROLE ${APP_ROLE} NOLOGIN; END IF; END $$;`,
    `DO $$ BEGIN IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = '${HOLDING_ROLE}') THEN CREATE ROLE ${HOLDING_ROLE} NOLOGIN; END IF; END $$;`,
    `GRANT USAGE ON SCHEMA public TO ${APP_ROLE}, ${HOLDING_ROLE};`,
    // non-tenant tables: app may read/write, holding may read
    `GRANT SELECT, INSERT, UPDATE, DELETE ON companies, users, company_users, management_viewers TO ${APP_ROLE};`,
    `GRANT SELECT ON companies, users, company_users, management_viewers TO ${HOLDING_ROLE};`,
    `GRANT USAGE, SELECT ON ALL SEQUENCES IN SCHEMA public TO ${APP_ROLE};`,
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
    );
  }
  return out;
}
