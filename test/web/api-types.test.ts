import { describe, expect, it } from 'vitest';
import type { Panels as ServerPanels } from '../../src/dashboard/panels.js';
import type { VendorInvoiceRow } from '../../src/intake/review.js';
import type { ImportSummary } from '../../src/boq/importer.js';
import type { boqItems, boqVersions, contractAddendums, contractTerms, goodsReceipts, progressReports, sites, vendors } from '../../src/db/schema.js';
import type { getPo, getPr } from '../../src/procurement/service.js';
import type { getReport, getSchedule, sCurve } from '../../src/progress/service.js';
import type { withEffective } from '../../src/http/routes/company.js';
import type {
  Addendum, BoqImportSummary, BoqItem, BoqVersion, Contract, ContractTerm, GoodsReceipt, IntakeRow, Panels, PlanEntry, ProgressReport,
  ProgressReportDetail, PurchaseOrderDetail, PurchaseRequestDetail, SCurveData, Site, Vendor,
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

describe('web API types follow the server', () => {
  it('compiles (the check is the assignment above)', () => {
    expect([
      dashboardPanels, intakeRow, site, vendor, contract, term, addendum, boqVersion, boqItem, importSummary, prDetail, poDetail, receipt,
      report, reportDetail, plan, curve,
    ]).toEqual(Array(17).fill(true));
  });
});
