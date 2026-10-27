import { and, asc, eq, ilike, inArray, max, type SQL } from 'drizzle-orm';
import type { Context } from 'hono';
import { HTTPException } from 'hono/http-exception';
import { z } from 'zod';
import { panelsToXlsx } from '../../dashboard/export.js';
import { buildPanels } from '../../dashboard/panels.js';
import { refreshAll, type SnapshotRows } from '../../dashboard/snapshot.js';
import {
  companies, contracts, dashAlerts, dashBalances, dashContracts, dashMonthly, dashProgress, dashRefreshes, dashVendors, sites,
} from '../../db/schema.js';
import { withHoldingRead, type Db } from '../../db/tenant.js';
import { IdParam, type App, type RouteDeps } from '../context.js';
import { withEffective } from './company.js';
import { parsePeriods } from './dashboard.js';

/** LLD §4 filters: companies[]=&site_id=&employer=&status=&period=&from=&to= */
const HoldingFilter = z.object({
  companies: z.array(IdParam).max(100).default([]),
  siteId: IdParam.optional(),
  employer: z.string().min(1).max(200).optional(),
  status: z.enum(['draft', 'active', 'completed', 'terminated']).optional(),
});
export type HoldingFilter = z.infer<typeof HoldingFilter>;

/** Accepts `companies[]=1&companies[]=2`, `companies=1&companies=2` and `companies=1,2`. */
export function parseHoldingFilter(c: Context): HoldingFilter {
  const raw = [...(c.req.queries('companies[]') ?? []), ...(c.req.queries('companies') ?? [])]
    .flatMap((v) => v.split(',')).map((v) => v.trim()).filter(Boolean);
  return HoldingFilter.parse({
    companies: raw,
    siteId: c.req.query('site_id') ?? c.req.query('siteId'),
    employer: c.req.query('employer'),
    status: c.req.query('status'),
  });
}

/** POST /holding/refresh at most once per minute (LLD §8). */
export const HOLDING_REFRESH_MIN_INTERVAL_MS = 60_000;

/** The stored snapshot of every company, read as jiat_holding (SELECT only). */
async function readSnapshot(db: Db) {
  return withHoldingRead(db, async (tx) => {
    const rows: SnapshotRows = {
      contracts: await tx.select().from(dashContracts),
      progress: await tx.select().from(dashProgress),
      monthly: await tx.select().from(dashMonthly),
      balances: await tx.select().from(dashBalances),
      vendors: await tx.select().from(dashVendors),
      alerts: await tx.select().from(dashAlerts),
    };
    const refreshes = await tx.select().from(dashRefreshes);
    const cs = await tx.select({ id: companies.id, code: companies.code, name: companies.name }).from(companies).orderBy(asc(companies.code));
    const ss = await tx.select({ id: sites.id, companyId: sites.companyId, code: sites.code, name: sites.name }).from(sites).orderBy(asc(sites.companyId), asc(sites.code));
    return { rows, refreshes, companies: cs, sites: ss };
  });
}

/** Read-only, all companies; the /holding/* gate (requireHolding) has already checked and logged the caller. */
export function registerHoldingRoutes(app: App, { db, now }: RouteDeps): void {
  app.get('/holding/companies', async (c) => {
    const rows = await withHoldingRead(db, (tx) =>
      tx.select({ id: companies.id, code: companies.code, name: companies.name }).from(companies).orderBy(asc(companies.code)),
    );
    return c.json({ data: rows });
  });

  app.get('/holding/contracts', async (c) => {
    const f = parseHoldingFilter(c);
    const where: SQL[] = [];
    if (f.companies.length) where.push(inArray(contracts.companyId, f.companies));
    if (f.siteId) where.push(eq(contracts.siteId, f.siteId));
    if (f.employer) where.push(ilike(contracts.employerName, `%${escapeLike(f.employer)}%`));
    if (f.status) where.push(eq(contracts.status, f.status));
    const rows = await withHoldingRead(db, async (tx) => {
      const ks = await tx.select().from(contracts).where(where.length ? and(...where) : undefined).orderBy(asc(contracts.companyId), asc(contracts.number));
      const withValues = await withEffective(tx, ks, now());
      const cs = await tx.select({ id: companies.id, code: companies.code, name: companies.name }).from(companies);
      const ss = await tx.select({ id: sites.id, code: sites.code, name: sites.name }).from(sites);
      return withValues.map((k) => ({
        ...k,
        company: cs.find((x) => x.id === k.companyId) ?? null,
        site: ss.find((x) => x.id === k.siteId) ?? null,
      }));
    });
    return c.json({ data: rows });
  });

  /** Panels from the snapshot + the "data per HH:MM" stamp (the OLDEST snapshot among the selected companies). */
  const panelsFor = async (c: Context) => {
    const today = now();
    const f = { ...parseHoldingFilter(c), ...parsePeriods(c, today) };
    const snap = await readSnapshot(db);
    const panels = buildPanels(snap.rows, f, today);
    const selected = f.companies.length ? snap.refreshes.filter((r) => f.companies.includes(r.companyId)) : snap.refreshes;
    const stamps = selected.map((r) => r.refreshedAt.getTime());
    const meta = {
      refreshedAt: stamps.length ? new Date(Math.min(...stamps)) : null,
      companies: snap.companies,
      sites: snap.sites,
    };
    return { panels, meta };
  };

  app.get('/holding/dashboard', async (c) => {
    const { panels, meta } = await panelsFor(c);
    return c.json({ data: panels, meta });
  });
  app.get('/holding/summary', async (c) => {
    const { panels: p, meta } = await panelsFor(c);
    return c.json({ data: { period: p.period, summary: p.summary, curve: p.curve, byCompany: p.byCompany }, meta });
  });
  app.get('/holding/progress', async (c) => {
    const { panels: p, meta } = await panelsFor(c);
    return c.json({ data: { period: p.period, curve: p.curve, byCompany: p.byCompany, contracts: p.contracts }, meta });
  });
  for (const panel of ['procurement', 'finance', 'intake', 'alerts'] as const) {
    app.get(`/holding/${panel}`, async (c) => {
      const { panels: p, meta } = await panelsFor(c);
      return c.json({ data: p[panel], meta });
    });
  }

  app.get('/holding/export', async (c) => {
    const format = c.req.query('format') ?? 'xlsx';
    if (format !== 'xlsx') throw new HTTPException(400, { message: 'Format ekspor yang tersedia: xlsx.' });
    const { panels, meta } = await panelsFor(c);
    const company = new Map(meta.companies.map((x) => [x.id, x.name]));
    const site = new Map(meta.sites.map((x) => [x.id, x.name]));
    const body = await panelsToXlsx(panels, {
      company: (id) => company.get(id) ?? `#${id}`,
      site: (id) => site.get(id) ?? `#${id}`,
    }, { refreshedAt: meta.refreshedAt, generatedAt: now() });
    return c.body(new Uint8Array(body), 200, {
      'Content-Type': 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
      'Content-Disposition': `attachment; filename="dashboard-holding-${panels.period.slice(0, 7)}.xlsx"`,
    });
  });

  /**
   * "Segarkan data": rebuilds every company's snapshot now. Recomputing is not a write a viewer
   * makes to anyone's data, so read-only holding viewers may press it; at most once per minute.
   */
  app.post('/holding/refresh', async (c) => {
    const at = now();
    const [last] = await withHoldingRead(db, (tx) => tx.select({ at: max(dashRefreshes.refreshedAt) }).from(dashRefreshes));
    const waitMs = last?.at ? HOLDING_REFRESH_MIN_INTERVAL_MS - (at.getTime() - last.at.getTime()) : 0;
    if (waitMs > 0) {
      return c.json({ error: 'too_many_requests', message: 'Data baru saja disegarkan; coba lagi sebentar.' }, 429, { 'Retry-After': String(Math.ceil(waitMs / 1000)) });
    }
    const result = await refreshAll(db, at);
    return c.json({ data: { ...result, refreshedAt: at.toISOString() } });
  });
}

/** `%` and `_` typed by the user are literal characters, not wildcards. */
function escapeLike(s: string): string {
  return s.replace(/[\\%_]/g, (ch) => `\\${ch}`);
}
