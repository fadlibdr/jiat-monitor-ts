import { and, asc, desc, eq, type SQL } from 'drizzle-orm';
import { z } from 'zod';
import { goodsReceipts, PO_STATUSES, PR_STATUSES, purchaseOrders, purchaseRequests } from '../../db/schema.js';
import { withCompany } from '../../db/tenant.js';
import {
  approvePo, cancelPo, commitments, createPo, createPr, getPo, getPr, receive, transitionPr,
} from '../../procurement/service.js';
import { findContract } from './company.js';
import {
  APPROVE_ROLES, ContractParams, EDIT_ROLES, IdParam, jsonBody, requireRole, type App, type RouteDeps,
} from '../context.js';

const Qty = z.union([z.string().min(1).max(30), z.number().positive()]);
const Line = z.object({
  boqItemId: IdParam.optional(),
  description: z.string().min(1).max(500),
  qty: Qty,
  unit: z.string().max(20).optional(),
});
const PrBody = z.object({
  siteId: IdParam,
  contractId: IdParam.optional(),
  neededBy: z.iso.date().optional(),
  note: z.string().max(2000).optional(),
  items: z.array(Line.extend({ estPriceCents: z.number().int().min(0).optional() })).min(1).max(200),
});
const PoBody = z.object({
  siteId: IdParam,
  vendorId: IdParam,
  prId: IdParam.optional(),
  contractId: IdParam.optional(),
  orderDate: z.iso.date(),
  expectedDate: z.iso.date().optional(),
  ppnRateBp: z.number().int().min(0).max(10_000).optional(),
  note: z.string().max(2000).optional(),
  items: z.array(Line.extend({ prItemId: IdParam.optional(), unitPriceCents: z.number().int().min(0) })).min(1).max(200),
});
const GrBody = z.object({
  receivedAt: z.iso.date(),
  note: z.string().max(2000).optional(),
  items: z.array(z.object({ poItemId: IdParam, qtyReceived: Qty })).min(1).max(200),
});
const DocParams = z.object({ companyId: IdParam, id: IdParam });
const PrQuery = z.object({ status: z.enum(PR_STATUSES).optional(), siteId: IdParam.optional() });
const PoQuery = z.object({ status: z.enum(PO_STATUSES).optional(), siteId: IdParam.optional(), vendorId: IdParam.optional() });
const GrQuery = z.object({ poId: IdParam.optional() });

/** PR → PO → GR (HLD §4). Office roles write; managers approve (HLD §2). */
export function registerProcurementRoutes(app: App, { db, now }: RouteDeps): void {
  const today = () => now().toISOString().slice(0, 10);
  const actor = (c: { get: (k: 'companyId' | 'userId') => number }) => ({ companyId: c.get('companyId'), userId: c.get('userId') });

  // --- purchase requests ---
  app.get('/companies/:companyId/purchase-requests', async (c) => {
    const q = PrQuery.parse(c.req.query());
    const where: SQL[] = [];
    if (q.status) where.push(eq(purchaseRequests.status, q.status));
    if (q.siteId) where.push(eq(purchaseRequests.siteId, q.siteId));
    const rows = await withCompany(db, c.get('tenant'), (tx) =>
      tx.select().from(purchaseRequests).where(where.length ? and(...where) : undefined).orderBy(desc(purchaseRequests.createdAt)));
    return c.json({ data: rows });
  });
  app.post('/companies/:companyId/purchase-requests', requireRole(EDIT_ROLES), async (c) => {
    const body = await jsonBody(c, PrBody);
    const pr = await withCompany(db, c.get('tenant'), (tx) => createPr(tx, actor(c), body, today()));
    return c.json({ data: pr }, 201);
  });
  app.get('/companies/:companyId/purchase-requests/:id', async (c) => {
    const { id } = DocParams.parse(c.req.param());
    return c.json({ data: await withCompany(db, c.get('tenant'), (tx) => getPr(tx, id)) });
  });
  app.post('/companies/:companyId/purchase-requests/:id/submit', requireRole(EDIT_ROLES), async (c) => {
    const { id } = DocParams.parse(c.req.param());
    return c.json({ data: await withCompany(db, c.get('tenant'), (tx) => transitionPr(tx, id, 'submit', c.get('userId'))) });
  });
  for (const action of ['approve', 'reject'] as const) {
    app.post(`/companies/:companyId/purchase-requests/:id/${action}`, requireRole(APPROVE_ROLES), async (c) => {
      const { id } = DocParams.parse(c.req.param());
      return c.json({ data: await withCompany(db, c.get('tenant'), (tx) => transitionPr(tx, id, action, c.get('userId'))) });
    });
  }

  // --- purchase orders ---
  app.get('/companies/:companyId/purchase-orders', async (c) => {
    const q = PoQuery.parse(c.req.query());
    const where: SQL[] = [];
    if (q.status) where.push(eq(purchaseOrders.status, q.status));
    if (q.siteId) where.push(eq(purchaseOrders.siteId, q.siteId));
    if (q.vendorId) where.push(eq(purchaseOrders.vendorId, q.vendorId));
    const rows = await withCompany(db, c.get('tenant'), (tx) =>
      tx.select().from(purchaseOrders).where(where.length ? and(...where) : undefined).orderBy(desc(purchaseOrders.orderDate), desc(purchaseOrders.id)));
    return c.json({ data: rows });
  });
  app.post('/companies/:companyId/purchase-orders', requireRole(EDIT_ROLES), async (c) => {
    const body = await jsonBody(c, PoBody);
    const po = await withCompany(db, c.get('tenant'), (tx) => createPo(tx, actor(c), body));
    return c.json({ data: po }, 201);
  });
  app.get('/companies/:companyId/purchase-orders/:id', async (c) => {
    const { id } = DocParams.parse(c.req.param());
    return c.json({ data: await withCompany(db, c.get('tenant'), (tx) => getPo(tx, id)) });
  });
  app.post('/companies/:companyId/purchase-orders/:id/approve', requireRole(APPROVE_ROLES), async (c) => {
    const { id } = DocParams.parse(c.req.param());
    return c.json({ data: await withCompany(db, c.get('tenant'), (tx) => approvePo(tx, id, c.get('userId'))) });
  });
  app.post('/companies/:companyId/purchase-orders/:id/cancel', requireRole(APPROVE_ROLES), async (c) => {
    const { id } = DocParams.parse(c.req.param());
    return c.json({ data: await withCompany(db, c.get('tenant'), (tx) => cancelPo(tx, id)) });
  });

  // --- goods receipts ---
  app.post('/companies/:companyId/purchase-orders/:id/receipts', requireRole(EDIT_ROLES), async (c) => {
    const { id } = DocParams.parse(c.req.param());
    const body = await jsonBody(c, GrBody);
    const gr = await withCompany(db, c.get('tenant'), (tx) => receive(tx, actor(c), id, body));
    return c.json({ data: gr }, 201);
  });
  app.get('/companies/:companyId/goods-receipts', async (c) => {
    const q = GrQuery.parse(c.req.query());
    const rows = await withCompany(db, c.get('tenant'), (tx) =>
      tx.select().from(goodsReceipts).where(q.poId ? eq(goodsReceipts.poId, q.poId) : undefined).orderBy(desc(goodsReceipts.receivedAt), asc(goodsReceipts.id)));
    return c.json({ data: rows });
  });

  // --- commitment vs BOQ ---
  app.get('/companies/:companyId/contracts/:contractId/commitments', async (c) => {
    const { contractId } = ContractParams.parse(c.req.param());
    const data = await withCompany(db, c.get('tenant'), async (tx) => {
      await findContract(tx, contractId);
      return commitments(tx, contractId);
    });
    return c.json({ data });
  });
}
