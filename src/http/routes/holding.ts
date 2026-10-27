import { and, asc, eq, ilike, inArray, type SQL } from 'drizzle-orm';
import type { Context } from 'hono';
import { z } from 'zod';
import { companies, contracts, sites } from '../../db/schema.js';
import { withHoldingRead } from '../../db/tenant.js';
import { IdParam, type App, type RouteDeps } from '../context.js';
import { withEffective } from './company.js';

/** LLD §4 filters: companies[]=&site_id=&employer=&status= (from/to arrive with the period views). */
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
}

/** `%` and `_` typed by the user are literal characters, not wildcards. */
function escapeLike(s: string): string {
  return s.replace(/[\\%_]/g, (ch) => `\\${ch}`);
}
