import type { Context } from 'hono';
import { z } from 'zod';
import { buildPanels } from '../../dashboard/panels.js';
import { computeSnapshot } from '../../dashboard/snapshot.js';
import type { AlertKind } from '../../db/schema.js';
import { withCompany } from '../../db/tenant.js';
import { periodOf } from '../../domain/scurve.js';
import { FINANCE_ROLES, IdParam, type App, type RouteDeps } from '../context.js';

/** "2026-10" or "2026-10-01" → "2026-10-01"; anything else is a 400. */
export const Month = z.string().transform((raw, ctx) => {
  const p = periodOf(raw);
  if (!p) ctx.addIssue({ code: 'custom', message: 'Bulan harus berformat YYYY-MM.' });
  return p ?? '';
});

const DashQuery = z.object({
  period: Month.optional(),
  from: Month.optional(),
  to: Month.optional(),
  siteId: IdParam.optional(),
});

/** period / from / to / site_id of a dashboard request; the period defaults to the current month. */
export function parsePeriods(c: Context, today: Date) {
  const q = DashQuery.parse({
    period: c.req.query('period'), from: c.req.query('from'), to: c.req.query('to'),
    siteId: c.req.query('site_id') ?? c.req.query('siteId'),
  });
  return { ...q, period: q.period ?? `${today.toISOString().slice(0, 7)}-01` };
}

/** Alerts that show money owed or owing: finance's and the managers' only, like the finance panel. */
const MONEY_ALERTS: ReadonlySet<AlertKind> = new Set(['termin_jatuh_tempo', 'vendor_overdue']);

/**
 * Company dashboard (LLD §8 "GET /dashboard/company"), live from the transaction tables inside the
 * caller's RLS and site scope, through the same aggregation the holding snapshot uses.
 */
export function registerDashboardRoutes(app: App, { db, now }: RouteDeps): void {
  app.get('/companies/:companyId/dashboard', async (c) => {
    const today = now();
    const f = parsePeriods(c, today);
    // one snapshot for the ~25 reads, so a termin issued or a payment recorded meanwhile is seen everywhere or nowhere
    const rows = await withCompany(db, c.get('tenant'), (tx) => computeSnapshot(tx, c.get('companyId'), today), { snapshot: true, readOnly: true });
    const panels = buildPanels(rows, f, today);
    const money = FINANCE_ROLES.includes(c.get('role'));
    return c.json({
      data: {
        ...panels,
        finance: money ? panels.finance : null,
        alerts: money ? panels.alerts : panels.alerts.filter((a) => !MONEY_ALERTS.has(a.kind)),
      },
    });
  });
}
