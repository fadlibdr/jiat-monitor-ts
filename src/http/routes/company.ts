import { and, asc, eq, inArray } from 'drizzle-orm';
import { HTTPException } from 'hono/http-exception';
import { z } from 'zod';
import { importBoq } from '../../boq/importer.js';
import { CATEGORIES } from '../../domain/categories.js';
import { boqItems, boqVersions, contractAddendums, contracts, contractTerms, sites } from '../../db/schema.js';
import { withCompany, type Tx } from '../../db/tenant.js';
import { daysLeft, effectiveContract, validateTerms } from '../../domain/contract.js';
import {
  ContractParams, EDIT_ROLES, IdParam, jsonBody, notFound, readUpload, requireRole, type App, type RouteDeps,
} from '../context.js';

const ImportQuery = z.object({ sheet: z.string().min(1).max(64).default('RAB') });
const BoqItemParams = z.object({ companyId: IdParam, contractId: IdParam, itemId: IdParam });
const BoqItemPatch = z.object({ category: z.enum(CATEGORIES).nullable() });
const SiteParams = z.object({ companyId: IdParam, siteId: IdParam });

const SiteBody = z.object({
  code: z.string().regex(/^[A-Z0-9-]{1,20}$/),
  name: z.string().min(2).max(200),
  location: z.string().max(500).optional(),
  province: z.string().max(100).optional(),
  startDate: z.iso.date().optional(),
  endDate: z.iso.date().optional(),
});
const SitePatch = SiteBody.omit({ code: true }).partial()
  .extend({ status: z.enum(['active', 'closed']).optional() })
  .refine((b) => Object.keys(b).length > 0, 'body kosong');

const CONTRACT_STATUSES = ['draft', 'active', 'completed', 'terminated'] as const;
const ContractBody = z.object({
  siteId: IdParam,
  number: z.string().min(1).max(100),
  employerName: z.string().min(2).max(200),
  valueDppCents: z.number().int().positive(),
  ppnRateBp: z.number().int().min(0).max(10_000).default(1100),
  retentionBp: z.number().int().min(0).max(10_000).default(0),
  advanceCents: z.number().int().min(0).default(0),
  signedAt: z.iso.date().optional(),
  startDate: z.iso.date().optional(),
  endDate: z.iso.date().optional(),
  status: z.enum(CONTRACT_STATUSES).default('active'),
});
/**
 * Written out instead of ContractBody.partial(): the body's defaults (ppn 11 %, status active…) must
 * never be applied to fields a PATCH did not send. The DPP itself changes only through an addendum.
 */
const ContractPatch = z.object({
  employerName: z.string().min(2).max(200).optional(),
  ppnRateBp: z.number().int().min(0).max(10_000).optional(),
  retentionBp: z.number().int().min(0).max(10_000).optional(),
  advanceCents: z.number().int().min(0).optional(),
  signedAt: z.iso.date().optional(),
  startDate: z.iso.date().optional(),
  endDate: z.iso.date().optional(),
  status: z.enum(CONTRACT_STATUSES).optional(),
}).refine((b) => Object.keys(b).length > 0, 'body kosong');

const TermBody = z.object({
  seq: z.number().int().min(1).max(99),
  name: z.string().min(1).max(100),
  percentBp: z.number().int().min(1).max(10_000),
  triggerProgressBp: z.number().int().min(0).max(10_000),
  dueDays: z.number().int().min(0).max(365).default(30),
});
const TermsBody = z.array(TermBody).max(50);

const AddendumBody = z.object({
  number: z.string().min(1).max(100),
  signedAt: z.iso.date(),
  valueDeltaCents: z.number().int().default(0),
  endDateNew: z.iso.date().optional(),
  note: z.string().max(2000).optional(),
}).refine((a) => a.valueDeltaCents !== 0 || a.endDateNew !== undefined, 'addendum harus mengubah nilai dan/atau tanggal selesai');

type ContractRow = typeof contracts.$inferSelect;
type AddendumRow = typeof contractAddendums.$inferSelect;

export function registerCompanyRoutes(app: App, { db, maxUploadBytes, now }: RouteDeps): void {
  // --- sites ---
  app.get('/companies/:companyId/sites', async (c) => {
    const rows = await withCompany(db, c.get('tenant'), (tx) => tx.select().from(sites).orderBy(asc(sites.code)));
    return c.json({ data: rows });
  });
  app.post('/companies/:companyId/sites', requireRole(EDIT_ROLES), async (c) => {
    const body = await jsonBody(c, SiteBody);
    const companyId = c.get('companyId');
    const [row] = await withCompany(db, c.get('tenant'), (tx) => tx.insert(sites).values({ ...body, companyId }).returning());
    return c.json({ data: row }, 201);
  });
  app.patch('/companies/:companyId/sites/:siteId', requireRole(EDIT_ROLES), async (c) => {
    const { siteId } = SiteParams.parse(c.req.param());
    const body = await jsonBody(c, SitePatch);
    const [row] = await withCompany(db, c.get('tenant'), (tx) => tx.update(sites).set(body).where(eq(sites.id, siteId)).returning());
    if (!row) notFound('Site tidak ditemukan pada perusahaan ini.');
    return c.json({ data: row });
  });

  // --- contracts ---
  app.get('/companies/:companyId/contracts', async (c) => {
    const rows = await withCompany(db, c.get('tenant'), async (tx) => {
      const ks = await tx.select().from(contracts).orderBy(asc(contracts.number));
      return withEffective(tx, ks, now());
    });
    return c.json({ data: rows });
  });
  app.post('/companies/:companyId/contracts', requireRole(EDIT_ROLES), async (c) => {
    const body = await jsonBody(c, ContractBody);
    const companyId = c.get('companyId');
    if (body.advanceCents > body.valueDppCents) throw new HTTPException(400, { message: 'Uang muka melebihi nilai DPP kontrak.' });
    const row = await withCompany(db, c.get('tenant'), async (tx) => {
      // the site must be this company's (RLS makes another company's site invisible => 404)
      const site = await tx.query.sites.findFirst({ where: eq(sites.id, body.siteId) });
      if (!site) notFound('Site tidak ditemukan pada perusahaan ini.');
      const [k] = await tx.insert(contracts).values({ ...body, companyId }).returning();
      return (await withEffective(tx, [k!], now()))[0]!;
    });
    return c.json({ data: row }, 201);
  });
  app.get('/companies/:companyId/contracts/:contractId', async (c) => {
    const { contractId } = ContractParams.parse(c.req.param());
    const data = await withCompany(db, c.get('tenant'), async (tx) => {
      const k = await findContract(tx, contractId);
      const [effective] = await withEffective(tx, [k], now());
      const terms = await tx.select().from(contractTerms).where(eq(contractTerms.contractId, contractId)).orderBy(asc(contractTerms.seq));
      const addendums = await tx.select().from(contractAddendums).where(eq(contractAddendums.contractId, contractId)).orderBy(asc(contractAddendums.signedAt));
      return { ...effective!, terms, termsComplete: validateTerms(terms).complete, addendums };
    });
    return c.json({ data });
  });
  app.patch('/companies/:companyId/contracts/:contractId', requireRole(EDIT_ROLES), async (c) => {
    const { contractId } = ContractParams.parse(c.req.param());
    const body = await jsonBody(c, ContractPatch);
    const row = await withCompany(db, c.get('tenant'), async (tx) => {
      const k = await findContract(tx, contractId);
      if (body.advanceCents !== undefined) {
        const [e] = await withEffective(tx, [k], now());
        if (body.advanceCents > e!.valueDppEffectiveCents) throw new HTTPException(400, { message: 'Uang muka melebihi nilai DPP kontrak.' });
      }
      const [updated] = await tx.update(contracts).set(body).where(eq(contracts.id, contractId)).returning();
      return (await withEffective(tx, [updated!], now()))[0]!;
    });
    return c.json({ data: row });
  });

  // --- termin: the whole schedule is replaced at once, so Σ percent is checked on the final state ---
  app.get('/companies/:companyId/contracts/:contractId/terms', async (c) => {
    const { contractId } = ContractParams.parse(c.req.param());
    const terms = await withCompany(db, c.get('tenant'), async (tx) => {
      await findContract(tx, contractId);
      return tx.select().from(contractTerms).where(eq(contractTerms.contractId, contractId)).orderBy(asc(contractTerms.seq));
    });
    const { complete, totalBp } = validateTerms(terms);
    return c.json({ data: terms, complete, totalBp });
  });
  app.put('/companies/:companyId/contracts/:contractId/terms', requireRole(EDIT_ROLES), async (c) => {
    const { contractId } = ContractParams.parse(c.req.param());
    const body = await jsonBody(c, TermsBody);
    const check = validateTerms(body);
    if (check.errors.length) throw new HTTPException(400, { message: check.errors.join('; ') });
    const companyId = c.get('companyId');
    const terms = await withCompany(db, c.get('tenant'), async (tx) => {
      await findContract(tx, contractId);
      // a termin already invoiced is referenced by sales_invoices: the FK makes this delete fail (409)
      await tx.delete(contractTerms).where(eq(contractTerms.contractId, contractId));
      if (!body.length) return [];
      return tx.insert(contractTerms).values(body.map((t) => ({ ...t, companyId, contractId }))).returning();
    });
    return c.json({ data: terms.sort((a, b) => a.seq - b.seq), complete: check.complete, totalBp: check.totalBp });
  });

  // --- addenda ---
  app.get('/companies/:companyId/contracts/:contractId/addendums', async (c) => {
    const { contractId } = ContractParams.parse(c.req.param());
    const rows = await withCompany(db, c.get('tenant'), async (tx) => {
      await findContract(tx, contractId);
      return tx.select().from(contractAddendums).where(eq(contractAddendums.contractId, contractId)).orderBy(asc(contractAddendums.signedAt));
    });
    return c.json({ data: rows });
  });
  app.post('/companies/:companyId/contracts/:contractId/addendums', requireRole(EDIT_ROLES), async (c) => {
    const { contractId } = ContractParams.parse(c.req.param());
    const body = await jsonBody(c, AddendumBody);
    const companyId = c.get('companyId');
    const data = await withCompany(db, c.get('tenant'), async (tx) => {
      const k = await findContract(tx, contractId);
      const [addendum] = await tx.insert(contractAddendums).values({ ...body, companyId, contractId }).returning();
      const [effective] = await withEffective(tx, [k], now());
      if (effective!.valueDppEffectiveCents <= 0) throw new HTTPException(400, { message: 'Nilai DPP kontrak setelah addendum harus > 0.' });
      return { addendum, contract: effective };
    });
    return c.json({ data }, 201);
  });

  // --- BOQ ---
  app.post('/companies/:companyId/contracts/:contractId/boq/import', requireRole(EDIT_ROLES), async (c) => {
    const { contractId } = ContractParams.parse(c.req.param());
    const { sheet } = ImportQuery.parse(c.req.query());
    const file = await readUpload(c, maxUploadBytes);
    const summary = await withCompany(db, c.get('tenant'), (tx) =>
      importBoq(tx, contractId, file.bytes, { sheet, filename: file.name, importedBy: c.get('userId') }),
    );
    return c.json({ data: summary }, 201);
  });
  app.get('/companies/:companyId/contracts/:contractId/boq', async (c) => {
    const { contractId } = ContractParams.parse(c.req.param());
    const result = await withCompany(db, c.get('tenant'), async (tx) => {
      const version = await tx.query.boqVersions.findFirst({ where: and(eq(boqVersions.contractId, contractId), eq(boqVersions.isCurrent, true)) });
      if (!version) return null;
      const items = await tx.select().from(boqItems).where(eq(boqItems.versionId, version.id)).orderBy(asc(boqItems.sortOrder));
      return { version, items };
    });
    if (!result) notFound('Belum ada BOQ untuk kontrak ini.');
    return c.json({ data: result });
  });
  /** Corrects the cost category of an item of the CURRENT version; kept by code on later re-imports. */
  app.patch('/companies/:companyId/contracts/:contractId/boq/items/:itemId', requireRole(EDIT_ROLES), async (c) => {
    const { contractId, itemId } = BoqItemParams.parse(c.req.param());
    const { category } = await jsonBody(c, BoqItemPatch);
    const row = await withCompany(db, c.get('tenant'), async (tx) => {
      await findContract(tx, contractId);
      const [current] = await tx.select({ id: boqVersions.id }).from(boqVersions)
        .where(and(eq(boqVersions.contractId, contractId), eq(boqVersions.isCurrent, true)));
      if (!current) return null;
      const [updated] = await tx.update(boqItems).set({ category })
        .where(and(eq(boqItems.id, itemId), eq(boqItems.versionId, current.id))).returning();
      return updated ?? null;
    });
    if (!row) notFound('Item BOQ tidak ditemukan pada versi aktif kontrak ini.');
    return c.json({ data: row });
  });
}

/** Through RLS: another company's contract, or a site outside the caller's scope, is a 404. */
export async function findContract(tx: Tx, contractId: number): Promise<ContractRow> {
  const k = await tx.query.contracts.findFirst({ where: eq(contracts.id, contractId) });
  if (!k) notFound('Kontrak tidak ditemukan pada perusahaan ini.');
  return k;
}

/** Contract rows plus the derived effective value, end date and days left (addenda applied). */
export async function withEffective(tx: Tx, ks: ContractRow[], today: Date) {
  const ids = ks.map((k) => k.id);
  const adds: AddendumRow[] = ids.length
    ? await tx.select().from(contractAddendums).where(inArray(contractAddendums.contractId, ids))
    : [];
  return ks.map((k) => {
    const e = effectiveContract(k, adds.filter((a) => a.contractId === k.id));
    return { ...k, ...e, daysLeft: daysLeft(e.endDateEffective, today) };
  });
}
