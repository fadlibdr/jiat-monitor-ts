import { and, desc, eq, type SQL } from 'drizzle-orm';
import { z } from 'zod';
import { progressReports, PROGRESS_STATUSES } from '../../db/schema.js';
import { withCompany } from '../../db/tenant.js';
import {
  createReport, getReport, getSchedule, putReportItems, putSchedule, sCurve, transitionReport,
} from '../../progress/service.js';
import { findContract } from './company.js';
import {
  APPROVE_ROLES, ContractParams, EDIT_ROLES, IdParam, jsonBody, OPNAME_ROLES, requireRole, type App, type RouteDeps,
} from '../context.js';

/** A plan line's month: 2000–2099 (a typo like 0202 or 9999 would stretch every S-curve over centuries). */
const PlanPeriod = z.string().regex(/^20\d{2}-\d{2}(-\d{2})?$/, 'periode YYYY-MM antara 2000 dan 2099');
/** At least one line: an empty PUT would silently bring back an older BOQ version's plan (see currentPlan). */
const ScheduleBody = z.array(z.object({
  code: z.string().min(1).max(80).nullable(),
  period: PlanPeriod,
  plannedPct: z.number().min(0).max(100),
})).min(1, 'rencana kosong').max(20_000);
const ReportBody = z.object({ contractId: IdParam, period: z.string().regex(/^\d{4}-\d{2}(-\d{2})?$/), note: z.string().max(2000).optional() });
const OpnameBody = z.array(z.object({
  boqItemId: IdParam.optional(),
  code: z.string().min(1).max(80).optional(),
  qtyDone: z.union([z.string().min(1).max(30), z.number().min(0)]).optional(),
  cumulativePct: z.number().min(0).max(100).optional(),
}).refine((l) => (l.boqItemId !== undefined) !== (l.code !== undefined), 'isi boqItemId atau code (salah satu)')
  .refine((l) => (l.qtyDone !== undefined) !== (l.cumulativePct !== undefined), 'isi qtyDone atau cumulativePct (salah satu)')).max(5_000);
const ReportParams = z.object({ companyId: IdParam, id: IdParam });
const ReportQuery = z.object({ contractId: IdParam.optional(), status: z.enum(PROGRESS_STATUSES).optional() });

/** Plan, opname and S-curve (HLD §4 Progres). Site staff enter opname; managers approve. */
export function registerProgressRoutes(app: App, { db }: RouteDeps): void {
  app.get('/companies/:companyId/contracts/:contractId/boq/schedule', async (c) => {
    const { contractId } = ContractParams.parse(c.req.param());
    const data = await withCompany(db, c.get('tenant'), async (tx) => { await findContract(tx, contractId); return getSchedule(tx, contractId); });
    return c.json({ data });
  });
  app.put('/companies/:companyId/contracts/:contractId/boq/schedule', requireRole(EDIT_ROLES), async (c) => {
    const { contractId } = ContractParams.parse(c.req.param());
    const body = await jsonBody(c, ScheduleBody);
    const data = await withCompany(db, c.get('tenant'), async (tx) => {
      await findContract(tx, contractId);
      return putSchedule(tx, c.get('companyId'), contractId, body);
    });
    return c.json({ data });
  });
  app.get('/companies/:companyId/contracts/:contractId/s-curve', async (c) => {
    const { contractId } = ContractParams.parse(c.req.param());
    const data = await withCompany(db, c.get('tenant'), async (tx) => { await findContract(tx, contractId); return sCurve(tx, contractId); });
    return c.json({ data });
  });

  app.get('/companies/:companyId/progress-reports', async (c) => {
    const q = ReportQuery.parse(c.req.query());
    const where: SQL[] = [];
    if (q.contractId) where.push(eq(progressReports.contractId, q.contractId));
    if (q.status) where.push(eq(progressReports.status, q.status));
    const rows = await withCompany(db, c.get('tenant'), (tx) =>
      tx.select().from(progressReports).where(where.length ? and(...where) : undefined).orderBy(desc(progressReports.period)));
    return c.json({ data: rows });
  });
  app.post('/companies/:companyId/progress-reports', requireRole(OPNAME_ROLES), async (c) => {
    const body = await jsonBody(c, ReportBody);
    const row = await withCompany(db, c.get('tenant'), (tx) => createReport(tx, { companyId: c.get('companyId'), userId: c.get('userId') }, body));
    return c.json({ data: row }, 201);
  });
  app.get('/companies/:companyId/progress-reports/:id', async (c) => {
    const { id } = ReportParams.parse(c.req.param());
    return c.json({ data: await withCompany(db, c.get('tenant'), (tx) => getReport(tx, id)) });
  });
  app.put('/companies/:companyId/progress-reports/:id/items', requireRole(OPNAME_ROLES), async (c) => {
    const { id } = ReportParams.parse(c.req.param());
    const body = await jsonBody(c, OpnameBody);
    const data = await withCompany(db, c.get('tenant'), (tx) => putReportItems(tx, c.get('companyId'), id, body));
    return c.json({ data });
  });
  app.post('/companies/:companyId/progress-reports/:id/submit', requireRole(OPNAME_ROLES), async (c) => {
    const { id } = ReportParams.parse(c.req.param());
    return c.json({ data: await withCompany(db, c.get('tenant'), (tx) => transitionReport(tx, id, 'submit', c.get('userId'))) });
  });
  for (const action of ['approve', 'reject'] as const) {
    app.post(`/companies/:companyId/progress-reports/:id/${action}`, requireRole(APPROVE_ROLES), async (c) => {
      const { id } = ReportParams.parse(c.req.param());
      return c.json({ data: await withCompany(db, c.get('tenant'), (tx) => transitionReport(tx, id, action, c.get('userId'))) });
    });
  }
}
