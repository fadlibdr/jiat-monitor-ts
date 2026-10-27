import { is } from 'drizzle-orm';
import { getTableConfig, PgTable } from 'drizzle-orm/pg-core';
import { APP_ROLE, HOLDING_ROLE } from './rls.js';
import * as schema from './schema.js';

/**
 * Audit trail and row authorship, enforced in Postgres so no code path can skip it (LLD §2, §9;
 * HLD §8). Idempotent DDL, run after the schema migration by the OWNER role, like rls.ts.
 *
 *  - jiat_stamp   BEFORE INSERT/UPDATE on every table with created_by: fills created_by/updated_by
 *                 from `app.user_id` (set by withCompany) and keeps updated_at current.
 *  - jiat_audit   AFTER INSERT/UPDATE/DELETE on AUDITED_TABLES: before/after rows into audit_logs.
 *  - jiat_audit_event(...)  for events that are not row changes (holding access, chat corrections).
 *
 * Both audit writers are SECURITY DEFINER: the app role has SELECT on audit_logs (own company only)
 * and nothing else, so it can append through these functions but never edit or delete history.
 */

/**
 * Tables whose row changes are logged. boq_items/boq_schedules are bulk-derived from an audited
 * boq_versions row (one import = one log row instead of hundreds), so they are left out.
 */
export const AUDITED_TABLES = [
  'companies', 'company_users', 'management_viewers',
  'sites', 'contracts', 'contract_addendums', 'contract_terms', 'boq_versions',
] as const;

/** Every table with a created_by column gets the stamp trigger: derived, so a new table cannot be forgotten. */
export function stampedTables(): string[] {
  return (Object.values(schema) as unknown[])
    .filter((v): v is PgTable => is(v, PgTable))
    .map((t) => getTableConfig(t))
    .filter((cfg) => cfg.columns.some((c) => c.name === 'created_by'))
    .map((cfg) => cfg.name);
}

export function auditStatements(): string[] {
  const out: string[] = [
    `CREATE OR REPLACE FUNCTION jiat_stamp() RETURNS trigger LANGUAGE plpgsql AS $$
     DECLARE uid bigint := NULLIF(current_setting('app.user_id', true), '')::bigint;
     BEGIN
       IF TG_OP = 'INSERT' THEN
         NEW.created_by := uid;
       ELSE
         NEW.created_by := OLD.created_by;
         NEW.created_at := OLD.created_at;
       END IF;
       NEW.updated_by := uid;
       NEW.updated_at := now();
       RETURN NEW;
     END $$;`,
    `CREATE OR REPLACE FUNCTION jiat_audit() RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $$
     DECLARE r jsonb;
     BEGIN
       IF TG_OP = 'DELETE' THEN r := to_jsonb(OLD); ELSE r := to_jsonb(NEW); END IF;
       INSERT INTO audit_logs (company_id, user_id, action, auditable_type, auditable_id, before, after)
       VALUES (
         (r->>'company_id')::bigint,
         NULLIF(current_setting('app.user_id', true), '')::bigint,
         lower(TG_OP),
         TG_TABLE_NAME,
         (r->>'id')::bigint,
         CASE WHEN TG_OP <> 'INSERT' THEN to_jsonb(OLD) END,
         CASE WHEN TG_OP <> 'DELETE' THEN to_jsonb(NEW) END
       );
       RETURN NULL;
     END $$;`,
    `CREATE OR REPLACE FUNCTION jiat_audit_event(p_company bigint, p_user bigint, p_action text, p_type text, p_id bigint, p_meta jsonb, p_ip text)
     RETURNS void LANGUAGE sql SECURITY DEFINER SET search_path = public, pg_temp AS $$
       INSERT INTO audit_logs (company_id, user_id, action, auditable_type, auditable_id, meta, ip)
       VALUES (p_company, p_user, p_action, p_type, p_id, p_meta, p_ip);
     $$;`,
    `REVOKE ALL ON FUNCTION jiat_audit_event(bigint, bigint, text, text, bigint, jsonb, text) FROM PUBLIC;`,
    `GRANT EXECUTE ON FUNCTION jiat_audit_event(bigint, bigint, text, text, bigint, jsonb, text) TO ${APP_ROLE}, ${HOLDING_ROLE};`,
    // read-only for the app, own company only; owner (SECURITY DEFINER) bypasses RLS, so no FORCE here
    `REVOKE INSERT, UPDATE, DELETE, TRUNCATE ON audit_logs FROM ${APP_ROLE}, ${HOLDING_ROLE};`,
    `GRANT SELECT ON audit_logs TO ${APP_ROLE};`,
    `ALTER TABLE audit_logs ENABLE ROW LEVEL SECURITY;`,
    `DROP POLICY IF EXISTS audit_logs_company_read ON audit_logs;`,
    `CREATE POLICY audit_logs_company_read ON audit_logs FOR SELECT TO ${APP_ROLE}
       USING (company_id = NULLIF(current_setting('app.company_id', true), '')::bigint);`,
  ];
  for (const t of stampedTables()) {
    out.push(
      `DROP TRIGGER IF EXISTS ${t}_stamp ON ${t};`,
      `CREATE TRIGGER ${t}_stamp BEFORE INSERT OR UPDATE ON ${t} FOR EACH ROW EXECUTE FUNCTION jiat_stamp();`,
    );
  }
  for (const t of AUDITED_TABLES) {
    out.push(
      `DROP TRIGGER IF EXISTS ${t}_audit ON ${t};`,
      `CREATE TRIGGER ${t}_audit AFTER INSERT OR UPDATE OR DELETE ON ${t} FOR EACH ROW EXECUTE FUNCTION jiat_audit();`,
    );
  }
  return out;
}
