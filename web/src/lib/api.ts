import type {
  Addendum, BoqImportSummary, BoqItem, BoqVersion, Category, CompanyRole, Contract, ContractDetail, ContractTerm, HoldingDashboard,
  HoldingRefresh, IntakePage, IntakePatch, IntakeRow, IntakeStatus, Me, Member, MyCompany, Panels, Site, TelegramLink, Vendor,
  AddendumInput, ContractInput, ContractPatch, SiteInput, VendorInput, VendorPatch,
  GoodsReceipt, GrInput, PoInput, PoStatus, PrInput, PurchaseOrder, PurchaseOrderDetail, PurchaseRequest, PurchaseRequestDetail,
} from './types';
import { errorMessage } from './errors';

/** An API answer other than 2xx, with the server's Indonesian message when it sent one. */
export class ApiError extends Error {
  constructor(readonly status: number, message: string, readonly code: string | null = null, readonly body: unknown = null) {
    super(message);
    this.name = 'ApiError';
  }

  /** Validation flags a 409 from the intake review carries ("Belum bisa dikonfirmasi"). */
  get flags(): string[] {
    const f = (this.body as { flags?: unknown } | null)?.flags;
    return Array.isArray(f) ? f.filter((x): x is string => typeof x === 'string') : [];
  }
}

/** Called on any 401 so the app can drop its session state and show the sign-in screen. */
let onUnauthorized: () => void = () => {};
export function setUnauthorizedHandler(fn: () => void): void {
  onUnauthorized = fn;
}


async function request<T>(method: string, path: string, body?: unknown, extraHeaders: Record<string, string> = {}): Promise<T> {
  // same origin: the session cookie is httpOnly and goes along by itself; nothing is kept in JS.
  // A FormData body (file upload) sets its own multipart content type.
  const form = body instanceof FormData;
  const res = await fetch(path, {
    method,
    credentials: 'same-origin',
    headers: { accept: 'application/json', ...(body === undefined || form ? {} : { 'content-type': 'application/json' }), ...extraHeaders },
    ...(body === undefined ? {} : { body: form ? body : JSON.stringify(body) }),
  });
  if (res.status === 401) onUnauthorized();
  const text = await res.text();
  let json: unknown = null;
  if (text) {
    try {
      json = JSON.parse(text);
    } catch {
      json = null;
    }
  }
  if (!res.ok) {
    const code = (json as { error?: unknown } | null)?.error;
    throw new ApiError(res.status, errorMessage(res.status, res.headers.get('content-type'), text, json), typeof code === 'string' ? code : null, json);
  }
  return json as T;
}

const qs = (params: Record<string, string | number | undefined | null>) => {
  const p = new URLSearchParams();
  for (const [k, v] of Object.entries(params)) if (v !== undefined && v !== null && v !== '') p.set(k, String(v));
  const s = p.toString();
  return s ? `?${s}` : '';
};

export interface HoldingQuery {
  companyId?: number | undefined;
  siteId?: number | undefined;
  period?: string | undefined;
  employer?: string | undefined;
  status?: string | undefined;
}

const holdingParams = (q: HoldingQuery) => ({ companies: q.companyId, site_id: q.siteId, period: q.period, employer: q.employer, status: q.status });

export const api = {
  signIn: (email: string, password: string) => request<unknown>('POST', '/api/auth/sign-in/email', { email, password }),
  signOut: () => request<unknown>('POST', '/api/auth/sign-out', {}),
  me: () => request<{ data: Me }>('GET', '/me').then((r) => r.data),
  myCompanies: () => request<{ data: MyCompany[] }>('GET', '/me/companies').then((r) => r.data),
  telegramLink: () => request<{ data: TelegramLink }>('POST', '/me/telegram-link').then((r) => r.data),

  sites: (companyId: number) => request<{ data: Site[] }>('GET', `/companies/${companyId}/sites`).then((r) => r.data),
  createSite: (companyId: number, body: SiteInput) => request<{ data: Site }>('POST', `/companies/${companyId}/sites`, body).then((r) => r.data),
  patchSite: (companyId: number, siteId: number, body: Partial<SiteInput> & { status?: string }) =>
    request<{ data: Site }>('PATCH', `/companies/${companyId}/sites/${siteId}`, body).then((r) => r.data),

  vendors: (companyId: number) => request<{ data: Vendor[] }>('GET', `/companies/${companyId}/vendors`).then((r) => r.data),
  createVendor: (companyId: number, body: VendorInput) => request<{ data: Vendor }>('POST', `/companies/${companyId}/vendors`, body).then((r) => r.data),
  patchVendor: (companyId: number, vendorId: number, body: VendorPatch) =>
    request<{ data: Vendor }>('PATCH', `/companies/${companyId}/vendors/${vendorId}`, body).then((r) => r.data),

  members: (companyId: number) => request<{ data: Member[] }>('GET', `/companies/${companyId}/members`).then((r) => r.data),
  /** upsert: adds the member, or changes the role / sites of an existing one */
  putMember: (companyId: number, body: { email: string; role: CompanyRole; siteIds?: number[] }) =>
    request<unknown>('POST', `/companies/${companyId}/members`, body),
  removeMember: (companyId: number, userId: number) => request<unknown>('DELETE', `/companies/${companyId}/members/${userId}`),

  contracts: (companyId: number) => request<{ data: Contract[] }>('GET', `/companies/${companyId}/contracts`).then((r) => r.data),
  createContract: (companyId: number, body: ContractInput) =>
    request<{ data: Contract }>('POST', `/companies/${companyId}/contracts`, body).then((r) => r.data),
  contract: (companyId: number, contractId: number) =>
    request<{ data: ContractDetail }>('GET', `/companies/${companyId}/contracts/${contractId}`).then((r) => r.data),
  patchContract: (companyId: number, contractId: number, body: ContractPatch) =>
    request<{ data: Contract }>('PATCH', `/companies/${companyId}/contracts/${contractId}`, body).then((r) => r.data),
  /** replaces the whole termin schedule */
  putTerms: (companyId: number, contractId: number, terms: Array<Omit<ContractTerm, 'id'>>) =>
    request<{ data: ContractTerm[]; complete: boolean; totalBp: number }>('PUT', `/companies/${companyId}/contracts/${contractId}/terms`, terms),
  addAddendum: (companyId: number, contractId: number, body: AddendumInput) =>
    request<{ data: { addendum: Addendum; contract: Contract } }>('POST', `/companies/${companyId}/contracts/${contractId}/addendums`, body).then((r) => r.data),
  /** null when the contract has no BOQ yet (404) */
  boq: (companyId: number, contractId: number) =>
    request<{ data: { version: BoqVersion; items: BoqItem[] } }>('GET', `/companies/${companyId}/contracts/${contractId}/boq`)
      .then((r) => r.data, (e: unknown) => { if (e instanceof ApiError && e.status === 404) return null; throw e; }),
  importBoq: (companyId: number, contractId: number, file: File, sheet: string) => {
    const body = new FormData();
    body.set('file', file);
    return request<{ data: BoqImportSummary }>('POST', `/companies/${companyId}/contracts/${contractId}/boq/import${qs({ sheet })}`, body).then((r) => r.data);
  },
  purchaseRequests: (companyId: number) => request<{ data: PurchaseRequest[] }>('GET', `/companies/${companyId}/purchase-requests`).then((r) => r.data),
  purchaseRequest: (companyId: number, id: number) =>
    request<{ data: PurchaseRequestDetail }>('GET', `/companies/${companyId}/purchase-requests/${id}`).then((r) => r.data),
  createPr: (companyId: number, body: PrInput) => request<{ data: PurchaseRequestDetail }>('POST', `/companies/${companyId}/purchase-requests`, body).then((r) => r.data),
  /** submit: admins; approve / reject: managers */
  prAction: (companyId: number, id: number, action: 'submit' | 'approve' | 'reject') =>
    request<{ data: PurchaseRequest }>('POST', `/companies/${companyId}/purchase-requests/${id}/${action}`, {}).then((r) => r.data),
  purchaseOrders: (companyId: number) => request<{ data: PurchaseOrder[] }>('GET', `/companies/${companyId}/purchase-orders`).then((r) => r.data),
  purchaseOrder: (companyId: number, id: number) =>
    request<{ data: PurchaseOrderDetail }>('GET', `/companies/${companyId}/purchase-orders/${id}`).then((r) => r.data),
  createPo: (companyId: number, body: PoInput) => request<{ data: PurchaseOrderDetail }>('POST', `/companies/${companyId}/purchase-orders`, body).then((r) => r.data),
  /** approve (draft → issued) or cancel (only without receipts): managers */
  poAction: (companyId: number, id: number, action: 'approve' | 'cancel') =>
    request<{ data: PurchaseOrder }>('POST', `/companies/${companyId}/purchase-orders/${id}/${action}`, {}).then((r) => r.data),
  /** the key makes a resubmitted form return the first receipt instead of receiving twice */
  receive: (companyId: number, poId: number, body: GrInput, idempotencyKey: string) =>
    request<{ data: GoodsReceipt & { poStatus: PoStatus } }>('POST', `/companies/${companyId}/purchase-orders/${poId}/receipts`, body, { 'idempotency-key': idempotencyKey })
      .then((r) => r.data),
  goodsReceipts: (companyId: number, poId: number) =>
    request<{ data: GoodsReceipt[] }>('GET', `/companies/${companyId}/goods-receipts${qs({ poId })}`).then((r) => r.data),

  setBoqCategory: (companyId: number, contractId: number, itemId: number, category: Category | null) =>
    request<{ data: BoqItem }>('PATCH', `/companies/${companyId}/contracts/${contractId}/boq/items/${itemId}`, { category }).then((r) => r.data),

  intakeReview: (companyId: number, q: { status?: IntakeStatus | undefined; siteId?: number | undefined; cursor?: string | null | undefined }) =>
    request<IntakePage>('GET', `/companies/${companyId}/intake/review${qs({ status: q.status, siteId: q.siteId, cursor: q.cursor })}`),
  patchIntake: (companyId: number, rowId: string, patch: IntakePatch) =>
    request<{ data: IntakeRow }>('PATCH', `/companies/${companyId}/intake/${rowId}`, patch).then((r) => r.data),
  intakePhotoUrl: (companyId: number, rowId: string) => `/companies/${companyId}/intake/${rowId}/photo`,

  companyDashboard: (companyId: number, period: string) =>
    request<{ data: Panels }>('GET', `/companies/${companyId}/dashboard${qs({ period })}`).then((r) => r.data),

  holdingDashboard: (q: HoldingQuery) => request<HoldingDashboard>('GET', `/holding/dashboard${qs(holdingParams(q))}`),
  holdingRefresh: () => request<{ data: HoldingRefresh }>('POST', '/holding/refresh').then((r) => r.data),
  holdingExportUrl: (q: HoldingQuery) => `/holding/export${qs({ ...holdingParams(q), format: 'xlsx' })}`,
};
