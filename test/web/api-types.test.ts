import { describe, expect, it } from 'vitest';
import type { Panels as ServerPanels } from '../../src/dashboard/panels.js';
import type { VendorInvoiceRow } from '../../src/intake/review.js';
import type { ImportSummary } from '../../src/boq/importer.js';
import type {
  boqItems, boqVersions, contractAddendums, contractTerms, goodsReceipts, progressReports, salesInvoices, sites, vendors,
} from '../../src/db/schema.js';
import type { PaymentInput as ServerPaymentInput, payables, publicPayment, receivables, termsStatus } from '../../src/finance/service.js';
import type { getPo, getPr } from '../../src/procurement/service.js';
import type { getReport, getSchedule, sCurve } from '../../src/progress/service.js';
import type { withEffective } from '../../src/http/routes/company.js';
import type {
  Addendum, BoqImportSummary, BoqItem, BoqVersion, Contract, ContractTerm, GoodsReceipt, IntakeRow, Panels, Payable, Payment, PaymentInput,
  PlanEntry, ProgressReport, ProgressReportDetail, PurchaseOrderDetail, PurchaseRequestDetail, Receivable, SalesInvoice, SCurveData, Site,
  TermsStatus, Vendor,
} from '../../web/src/lib/types.js';

/**
 * The UI's hand-written API types (web/src/lib/types.ts) against the server's own: a field the
 * server renames or retypes makes one of these `false`, and assigning `true` to it fails the root
 * typecheck (CI) — instead of the screen showing "undefined" in production.
 */
type Assignable<From, To> = [From] extends [To] ? true : false;

const dashboardPanels: Assignable<ServerPanels, Panels> = true;
/** GET /intake/review rows: the table row without the internal id and company (publicRow) */
const intakeRow: Assignable<Omit<VendorInvoiceRow, 'id' | 'companyId'>, IntakeRow> = true;

/** master data: the stored rows (JSON dates are strings, as drizzle's `date` columns already are) */
const site: Assignable<typeof sites.$inferSelect, Site> = true;
const vendor: Assignable<typeof vendors.$inferSelect, Vendor> = true;
const contract: Assignable<Awaited<ReturnType<typeof withEffective>>[number], Contract> = true;
const term: Assignable<typeof contractTerms.$inferSelect, ContractTerm> = true;
const addendum: Assignable<typeof contractAddendums.$inferSelect, Addendum> = true;
const boqVersion: Assignable<typeof boqVersions.$inferSelect, BoqVersion> = true;
const boqItem: Assignable<typeof boqItems.$inferSelect, BoqItem> = true;
const importSummary: Assignable<ImportSummary, BoqImportSummary> = true;
/** procurement: what getPr / getPo answer, and the receipt rows */
const prDetail: Assignable<Awaited<ReturnType<typeof getPr>>, PurchaseRequestDetail> = true;
const poDetail: Assignable<Awaited<ReturnType<typeof getPo>>, PurchaseOrderDetail> = true;
const receipt: Assignable<typeof goodsReceipts.$inferSelect, GoodsReceipt> = true;
/** progress: report rows and detail, the stored plan, the S-curve */
const report: Assignable<typeof progressReports.$inferSelect, ProgressReport> = true;
const reportDetail: Assignable<Awaited<ReturnType<typeof getReport>>, ProgressReportDetail> = true;
const plan: Assignable<Awaited<ReturnType<typeof getSchedule>>[number], PlanEntry> = true;
const curve: Assignable<Awaited<ReturnType<typeof sCurve>>, SCurveData> = true;
/** invoicing: termin status, invoice rows, payments as the API shows them, aging rows; the payment body the other way */
const termsStat: Assignable<Awaited<ReturnType<typeof termsStatus>>, TermsStatus> = true;
const salesInvoice: Assignable<typeof salesInvoices.$inferSelect, SalesInvoice> = true;
const payment: Assignable<ReturnType<typeof publicPayment>, Payment> = true;
const receivable: Assignable<Awaited<ReturnType<typeof receivables>>[number], Receivable> = true;
const payable: Assignable<Awaited<ReturnType<typeof payables>>[number], Payable> = true;
const paymentInput: Assignable<PaymentInput, ServerPaymentInput> = true;

describe('web API types follow the server', () => {
  it('compiles (the check is the assignment above)', () => {
    expect([
      dashboardPanels, intakeRow, site, vendor, contract, term, addendum, boqVersion, boqItem, importSummary, prDetail, poDetail, receipt,
      report, reportDetail, plan, curve, termsStat, salesInvoice, payment, receivable, payable, paymentInput,
    ]).toEqual(Array(23).fill(true));
  });
});
