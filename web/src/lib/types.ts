/**
 * The parts of the API's JSON the screens use. Hand-written, but checked against the server's own
 * types by the root typecheck (test/web/api-types.test.ts), so a renamed or retyped field fails CI
 * instead of rendering "undefined".
 */

export type CompanyRole = 'site_staff' | 'project_admin' | 'finance' | 'company_manager' | 'system_admin';

export interface Me {
  id: number;
  name: string;
  email: string;
  isSystemAdmin: boolean;
  /** may open /holding/* (management_viewers) */
  holdingViewer: boolean;
}

export interface MyCompany {
  id: number;
  code: string;
  name: string;
  role: CompanyRole;
}

export interface Site {
  id: number;
  code: string;
  name: string;
  location: string | null;
  province: string | null;
  startDate: string | null;
  endDate: string | null;
  /** 'active' | 'closed' */
  status: string;
}

export type VendorStatus = 'active' | 'draft';

export interface Vendor {
  id: number;
  name: string;
  /** null unless the caller is finance or a manager (and when not recorded) */
  npwp: string | null;
  bankName: string | null;
  bankAccount: string | null;
  phone: string | null;
  defaultCategory: Category | null;
  /** days from the nota date to its due date; null = 30 */
  paymentTermsDays: number | null;
  /** draft = created by the bot from a nota, not yet checked */
  status: VendorStatus;
}

export interface Member {
  userId: number;
  email: string;
  name: string;
  role: CompanyRole;
  /** null = every site (a site_staff with null has none: assign sites) */
  siteIds: number[] | null;
}

export type ContractStatus = 'draft' | 'active' | 'completed' | 'terminated';

/** A contract with the addenda applied (GET /contracts, /contracts/:id). */
export interface Contract {
  id: number;
  siteId: number;
  number: string;
  employerName: string;
  /** as signed; the value in force is valueDppEffectiveCents */
  valueDppCents: number;
  ppnRateBp: number;
  retentionBp: number;
  advanceCents: number;
  signedAt: string | null;
  startDate: string | null;
  endDate: string | null;
  status: string;
  valueDppEffectiveCents: number;
  addendumDeltaCents: number;
  valueTotalCents: number;
  endDateEffective: string | null;
  daysLeft: number | null;
}

export interface ContractTerm {
  id: number;
  seq: number;
  name: string;
  percentBp: number;
  triggerProgressBp: number;
  dueDays: number;
}

export interface Addendum {
  id: number;
  number: string;
  signedAt: string;
  valueDeltaCents: number;
  endDateNew: string | null;
  note: string | null;
}

export interface ContractDetail extends Contract {
  terms: ContractTerm[];
  /** Σ termin = 100 % */
  termsComplete: boolean;
  addendums: Addendum[];
}

export interface BoqVersion {
  id: number;
  version: number;
  sourceFilename: string | null;
  totalCents: number;
  anomalies: unknown[];
}

export interface BoqItem {
  id: number;
  parentId: number | null;
  code: string;
  codePrinted: string | null;
  description: string;
  unit: string | null;
  qty: string | null;
  unitPriceCents: number | null;
  amountCents: number;
  /** 100 % = 100_000_000 */
  weightMicroPct: number;
  category: Category | null;
  level: number;
  isLeaf: boolean;
}

export interface BoqImportSummary {
  version: number;
  items: number;
  leaves: number;
  total: string;
  contractValueDpp: string;
  anomalies: Array<{ row: number; type: string; detail: string }>;
}

// --- intake review ---------------------------------------------------------------------------

export type IntakeStatus = 'perlu_konfirmasi' | 'perlu_cek' | 'terkonfirmasi' | 'ditolak';
export type Category = 'material' | 'upah' | 'alat' | 'subkon' | 'operasional' | 'lain';

export interface IntakeReviewInfo {
  fields?: Record<string, number>;
  flags?: string[];
  missing?: string[];
  nearDuplicates?: Array<{ rowId: string; distance: number }>;
}

export interface IntakeRow {
  rowId: string;
  siteId: number;
  vendorId: number | null;
  vendorName: string | null;
  /** null unless the caller is finance or a manager */
  npwp: string | null;
  invoiceDate: string | null;
  /** set on confirmation (vendor payment term) unless given */
  dueDate: string | null;
  docNumber: string | null;
  description: string | null;
  category: Category | null;
  dppCents: number | null;
  ppnCents: number | null;
  totalCents: number;
  status: IntakeStatus;
  source: 'telegram' | 'manual';
  confidence: IntakeReviewInfo;
  poId: number | null;
  grId: number | null;
}

export interface IntakePage {
  data: IntakeRow[];
  nextCursor: string | null;
}

/** PATCH /companies/:id/intake/:rowId — only what the reviewer changed. */
export interface IntakePatch {
  category?: Category;
  totalCents?: number | string;
  vendorId?: number;
  vendorName?: string;
  invoiceDate?: string;
  /** null clears it: a confirmed nota then gets its nota date + the vendor's payment term */
  dueDate?: string | null;
  docNumber?: string;
  status?: 'terkonfirmasi' | 'ditolak';
}

// --- dashboards ------------------------------------------------------------------------------

export interface CurvePoint {
  period: string;
  plannedMicroPct: number;
  actualMicroPct: number | null;
  deviationMicroPct: number | null;
}

export interface Money {
  budgetCents: number;
  committedCents: number;
  receivedCents: number;
}

export type AlertKind = 'termin_jatuh_tempo' | 'termin_siap' | 'vendor_overdue' | 'deviasi_progres' | 'po_lewat_30_hari' | 'kontrak_mendekati_batas';

export interface PanelAlert {
  kind: AlertKind;
  companyId: number;
  siteId: number;
  ref: string;
  /** "Termin jatuh tempo" */
  label: string;
  /** one line, already worded by the server (same text as the DailyDigest) */
  text: string;
}

export interface PanelContract {
  contractId: number;
  companyId: number;
  siteId: number;
  number: string;
  employerName: string;
  status: string;
  valueDppEffectiveCents: number;
  valueTotalCents: number;
  addendumDeltaCents: number;
  endDateEffective: string | null;
  daysLeft: number | null;
  termsIssued: number;
  termsTotal: number;
  termsReady: number;
  progress: CurvePoint | null;
}

export interface Panels {
  period: string;
  summary: {
    contracts: number;
    sites: number;
    companies: number;
    valueDppEffectiveCents: number;
    addendumDeltaCents: number;
    valueTotalCents: number;
    costRealisedCents: number;
    budgetCents: number;
    costOfBudgetBp: number | null;
    progress: CurvePoint | null;
  };
  curve: CurvePoint[];
  byCompany: Array<{ companyId: number; contracts: number; valueDppEffectiveCents: number; progress: CurvePoint | null }>;
  contracts: PanelContract[];
  procurement: {
    prOpen: number;
    prWaiting: number;
    poOutstandingCents: number;
    poOverdueCount: number;
    commitment: Money & {
      committedOfBudgetBp: number | null;
      byCategory: Array<Money & { category: string; committedOfBudgetBp: number | null; shareOfCommittedBp: number | null }>;
    };
    topVendors: Array<{ companyId: number; vendorId: number; vendorName: string; poValueCents: number; undeliveredCents: number }>;
  };
  finance: {
    receivableCents: number;
    receivableCount: number;
    aging: { d0_30: number; d31_60: number; d61_90: number; d90p: number };
    payableCents: number;
    payableOverdueCents: number;
    cash: { period: string; inCents: number; outCents: number; netCents: number };
    monthly: Array<{ period: string; cashInCents: number; cashOutCents: number }>;
  };
  intake: {
    photos7d: number;
    sitesWithPhotos: number;
    openKonfirmasi: number;
    openCek: number;
    asked7d: number;
    askRateBp: number | null;
    medianConfirmMinutes7d: number | null;
    perSite: Array<{ companyId: number; siteId: number; photos7d: number }>;
  };
  alerts: PanelAlert[];
}

export interface HoldingMeta {
  /** oldest snapshot among the selected companies (JSON: ISO string) */
  refreshedAt: string | null;
  companies: Array<{ id: number; code: string; name: string }>;
  sites: Array<{ id: number; companyId: number; code: string; name: string }>;
}

export interface HoldingDashboard {
  data: Panels;
  meta: HoldingMeta;
}

/** POST /holding/refresh */
export interface HoldingRefresh {
  refreshedAt: string;
  /** companies whose refresh failed: their previous snapshot is still the one shown */
  staleCompanyIds: number[];
}

export interface TelegramLink {
  code: string;
  expiresAt: string;
  link: string | null;
}

// --- request bodies (master data) ---

export interface SiteInput {
  code: string;
  name: string;
  location?: string;
  province?: string;
  startDate?: string;
  endDate?: string;
}

export interface VendorInput {
  name: string;
  phone?: string;
  defaultCategory?: Category;
  paymentTermsDays?: number;
  npwp?: string;
  bankName?: string;
  bankAccount?: string;
}

/** null clears a field */
export type VendorPatch = {
  name?: string;
  status?: 'active' | 'draft';
  phone?: string | null;
  defaultCategory?: Category | null;
  paymentTermsDays?: number | null;
  npwp?: string | null;
  bankName?: string | null;
  bankAccount?: string | null;
};

export interface ContractInput {
  siteId: number;
  number: string;
  employerName: string;
  valueDppCents: number;
  ppnRateBp?: number;
  retentionBp?: number;
  advanceCents?: number;
  signedAt?: string;
  startDate?: string;
  endDate?: string;
  status?: string;
}

/** the DPP changes only through an addendum */
export type ContractPatch = Partial<Omit<ContractInput, 'siteId' | 'number' | 'valueDppCents'>>;

export interface AddendumInput {
  number: string;
  signedAt: string;
  valueDeltaCents?: number;
  endDateNew?: string;
  note?: string;
}

// --- procurement (PR → PO → GR) ---

export type PrStatus = 'draft' | 'submitted' | 'approved' | 'rejected' | 'closed';
export type PoStatus = 'draft' | 'issued' | 'partial' | 'received' | 'cancelled';

export interface PurchaseRequest {
  id: number;
  siteId: number;
  contractId: number | null;
  number: string;
  neededBy: string | null;
  status: PrStatus;
  note: string | null;
}

export interface PrItem {
  id: number;
  boqItemId: number | null;
  description: string;
  /** numeric(18,4) text, e.g. "12.5000" */
  qty: string;
  unit: string | null;
  estPriceCents: number | null;
}

export interface PurchaseRequestDetail extends PurchaseRequest { items: PrItem[] }

export interface PurchaseOrder {
  id: number;
  siteId: number;
  vendorId: number;
  prId: number | null;
  contractId: number | null;
  number: string;
  orderDate: string;
  expectedDate: string | null;
  ppnRateBp: number;
  dppCents: number;
  ppnCents: number;
  totalCents: number;
  status: PoStatus;
  note: string | null;
}

export interface PoItem {
  id: number;
  prItemId: number | null;
  boqItemId: number | null;
  description: string;
  qty: string;
  unit: string | null;
  unitPriceCents: number;
  amountCents: number;
  /** Σ goods receipts so far, numeric text */
  qtyReceived: string;
}

export interface PurchaseOrderDetail extends PurchaseOrder { items: PoItem[] }

export interface GoodsReceipt {
  id: number;
  poId: number;
  number: string;
  receivedAt: string;
  note: string | null;
}

export interface PrLineInput { boqItemId?: number; description: string; qty: string; unit?: string; estPriceCents?: number }
export interface PrInput { siteId: number; contractId?: number; neededBy?: string; note?: string; items: PrLineInput[] }
export interface PoLineInput { boqItemId?: number; prItemId?: number; description: string; qty: string; unit?: string; unitPriceCents: number }
export interface PoInput {
  siteId: number; vendorId: number; prId?: number; contractId?: number; orderDate: string; expectedDate?: string; note?: string; items: PoLineInput[];
}
export interface GrInput { receivedAt: string; note?: string; items: Array<{ poItemId: number; qtyReceived: string }> }
