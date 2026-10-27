import { auditStatements } from './audit.js';
import { rlsStatements } from './rls.js';

/**
 * Everything drizzle-kit does not generate (roles, RLS policies, functions, triggers), in the order
 * it must run: roles and policies first, then the audit functions that grant to those roles.
 * Idempotent; run by the OWNER after every migration (db:migrate) and by the test harness.
 */
export function postMigrationStatements(): string[] {
  return [...rlsStatements(), ...auditStatements()];
}
