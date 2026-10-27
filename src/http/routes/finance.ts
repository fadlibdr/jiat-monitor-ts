import { and, desc, eq, type SQL } from 'drizzle-orm';
import { z } from 'zod';
import { PAYABLE_TYPES, PAYMENT_METHODS, payments, SALES_INVOICE_STATUSES, salesInvoices } from '../../db/schema.js';
import { withCompany } from '../../db/tenant.js';
import { AGING_BUCKETS } from '../../domain/invoice.js';
import {
  cancelSalesInvoice, issueTermInvoice, payables, receivables, recordPayment, termsStatus,
} from '../../finance/service.js';
import { findContract } from './company.js';
import { ContractParams, FINANCE_ROLES, IdParam, jsonBody, requireRole, type App, type RouteDeps } from '../context.js';

const FromTermBody = z.object({ contractId: IdParam, termId: IdParam, invoiceDate: z.iso.date() });
const Payment = z.object({
  paidAt: z.iso.date(),
  amountCents: z.number().int().positive().max(Number.MAX_SAFE_INTEGER),
  method: z.enum(PAYMENT_METHODS),
  reference: z.string().trim().min(1).max(100).optional(),
  note: z.string().max(2000).optional(),
});
const PaymentBody = z.discriminatedUnion('payableType', [
  Payment.extend({ payableType: z.literal('sales_invoices'), rowRef: IdParam }),
  Payment.extend({ payableType: z.literal('vendor_invoices'), rowRef: z.uuid() }),
]);
const InvoiceQuery = z.object({ contractId: IdParam.optional(), status: z.enum(SALES_INVOICE_STATUSES).optional() });
const PaymentQuery = z.object({ payableType: z.enum(PAYABLE_TYPES).optional(), payableId: IdParam.optional() });
const DocParams = z.object({ companyId: IdParam, id: IdParam });

/**
 * Termin invoices, payments, aging (HLD §4; LLD §4 POST /invoices/sales/from-term). Money pages are
 * finance's and the managers' (FINANCE_ROLES); the termin status of a contract is readable by every
 * member, since it only says which termin are reached and billed.
 */
export function registerFinanceRoutes(app: App, { db, now }: RouteDeps): void {
  const actor = (c: { get: (k: 'companyId' | 'userId') => number }) => ({ companyId: c.get('companyId'), userId: c.get('userId') });
  const finance = requireRole(FINANCE_ROLES);

  app.get('/companies/:companyId/contracts/:contractId/terms/status', async (c) => {
    const { contractId } = ContractParams.parse(c.req.param());
    const data = await withCompany(db, c.get('tenant'), async (tx) => {
      await findContract(tx, contractId);
      return termsStatus(tx, contractId);
    });
    return c.json({ data });
  });

  app.post('/companies/:companyId/invoices/sales/from-term', finance, async (c) => {
    const body = await jsonBody(c, FromTermBody);
    const row = await withCompany(db, c.get('tenant'), (tx) => issueTermInvoice(tx, actor(c), body));
    return c.json({ data: row }, 201);
  });
  app.get('/companies/:companyId/invoices/sales', finance, async (c) => {
    const q = InvoiceQuery.parse(c.req.query());
    const where: SQL[] = [];
    if (q.contractId) where.push(eq(salesInvoices.contractId, q.contractId));
    if (q.status) where.push(eq(salesInvoices.status, q.status));
    const rows = await withCompany(db, c.get('tenant'), (tx) =>
      tx.select().from(salesInvoices).where(where.length ? and(...where) : undefined).orderBy(desc(salesInvoices.invoiceDate), desc(salesInvoices.id)));
    return c.json({ data: rows });
  });
  app.post('/companies/:companyId/invoices/sales/:id/cancel', finance, async (c) => {
    const { id } = DocParams.parse(c.req.param());
    return c.json({ data: await withCompany(db, c.get('tenant'), (tx) => cancelSalesInvoice(tx, id)) });
  });

  app.post('/companies/:companyId/payments', finance, async (c) => {
    const body = await jsonBody(c, PaymentBody);
    const row = await withCompany(db, c.get('tenant'), (tx) => recordPayment(tx, { companyId: c.get('companyId') }, body));
    return c.json({ data: row }, 201);
  });
  app.get('/companies/:companyId/payments', finance, async (c) => {
    const q = PaymentQuery.parse(c.req.query());
    const where: SQL[] = [];
    if (q.payableType) where.push(eq(payments.payableType, q.payableType));
    if (q.payableId) where.push(eq(payments.payableId, q.payableId));
    const rows = await withCompany(db, c.get('tenant'), (tx) =>
      tx.select().from(payments).where(where.length ? and(...where) : undefined).orderBy(desc(payments.paidAt), desc(payments.id)));
    return c.json({ data: rows });
  });

  app.get('/companies/:companyId/receivables', finance, async (c) => {
    const rows = await withCompany(db, c.get('tenant'), (tx) => receivables(tx, now()));
    const buckets = Object.fromEntries(AGING_BUCKETS.map((b) => [b, rows.filter((r) => r.bucket === b).reduce((s, r) => s + r.balanceCents, 0)]));
    return c.json({ data: rows, totals: { balanceCents: rows.reduce((s, r) => s + r.balanceCents, 0), buckets } });
  });
  app.get('/companies/:companyId/payables', finance, async (c) => {
    const rows = await withCompany(db, c.get('tenant'), (tx) => payables(tx, now()));
    return c.json({
      data: rows,
      totals: { balanceCents: rows.reduce((s, r) => s + r.balanceCents, 0), overdueCents: rows.filter((r) => r.overdue).reduce((s, r) => s + r.balanceCents, 0) },
    });
  });
}
