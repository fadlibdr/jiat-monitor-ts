import { describe, expect, it } from 'vitest';
import type { Panels as ServerPanels } from '../../src/dashboard/panels.js';
import type { VendorInvoiceRow } from '../../src/intake/review.js';
import type { IntakeRow, Panels } from '../../web/src/lib/types.js';

/**
 * The UI's hand-written API types (web/src/lib/types.ts) against the server's own: a field the
 * server renames or retypes makes one of these `false`, and assigning `true` to it fails the root
 * typecheck (CI) — instead of the screen showing "undefined" in production.
 */
type Assignable<From, To> = [From] extends [To] ? true : false;

const dashboardPanels: Assignable<ServerPanels, Panels> = true;
/** GET /intake/review rows: the table row without the internal id and company (publicRow) */
const intakeRow: Assignable<Omit<VendorInvoiceRow, 'id' | 'companyId'>, IntakeRow> = true;

describe('web API types follow the server', () => {
  it('compiles (the check is the assignment above)', () => {
    expect([dashboardPanels, intakeRow]).toEqual([true, true]);
  });
});
