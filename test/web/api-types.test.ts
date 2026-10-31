import { describe, expect, it } from 'vitest';
import type { Panels as ServerPanels } from '../../src/dashboard/panels.js';
import type { VendorInvoiceRow } from '../../src/intake/review.js';
import type { ImportSummary } from '../../src/boq/importer.js';
import type { boqItems, boqVersions, contractAddendums, contractTerms, sites, vendors } from '../../src/db/schema.js';
import type { withEffective } from '../../src/http/routes/company.js';
import type {
  Addendum, BoqImportSummary, BoqItem, BoqVersion, Contract, ContractTerm, IntakeRow, Panels, Site, Vendor,
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

describe('web API types follow the server', () => {
  it('compiles (the check is the assignment above)', () => {
    expect([dashboardPanels, intakeRow, site, vendor, contract, term, addendum, boqVersion, boqItem, importSummary]).toEqual(Array(10).fill(true));
  });
});
