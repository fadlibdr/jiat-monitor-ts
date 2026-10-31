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
}

export interface Vendor {
  id: number;
  name: string;
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
