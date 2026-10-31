import type { CompanyRole } from './types.js';

/**
 * The server's role sets (src/http/context.ts, routes/intake.ts), mirrored so the screens offer only
 * what the API will accept; test/web/roles.test.ts fails if the two drift. The server stays the
 * authority: these only decide what to show.
 */
export const EDIT_ROLES: readonly CompanyRole[] = ['project_admin', 'company_manager', 'system_admin'];
export const FINANCE_ROLES: readonly CompanyRole[] = ['finance', 'company_manager', 'system_admin'];
export const MANAGE_ROLES: readonly CompanyRole[] = ['company_manager', 'system_admin'];
/** approve / reject a PR, approve or cancel a PO (HLD §2: the company manager) */
export const APPROVE_ROLES: readonly CompanyRole[] = ['company_manager', 'system_admin'];
/** intake review list: editors and finance (finance reads only) */
export const REVIEW_ROLES: readonly CompanyRole[] = ['project_admin', 'company_manager', 'system_admin', 'finance'];
/** company dashboard (LLD §4) */
export const DASHBOARD_ROLES = FINANCE_ROLES;
/** vendor master: editors and finance write; bank account and NPWP only FINANCE_ROLES */
export const VENDOR_WRITE_ROLES: readonly CompanyRole[] = ['project_admin', 'company_manager', 'system_admin', 'finance'];
/** create, fill and submit an opname report: site staff too (they measure on site) */
export const OPNAME_ROLES: readonly CompanyRole[] = ['site_staff', 'project_admin', 'company_manager', 'system_admin'];
/** the progress screen (reading the plan, reports and S-curve): every company role */
export const PROGRESS_ROLES: readonly CompanyRole[] = ['site_staff', 'project_admin', 'finance', 'company_manager', 'system_admin'];
/** master-data screens (reading): every role with a web screen; site staff work through Telegram */
export const MASTER_ROLES: readonly CompanyRole[] = ['project_admin', 'finance', 'company_manager', 'system_admin'];

export const can = (role: CompanyRole, roles: readonly CompanyRole[]): boolean => roles.includes(role);
