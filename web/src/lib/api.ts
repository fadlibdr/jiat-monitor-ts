import type {
  HoldingDashboard, HoldingRefresh, IntakePage, IntakePatch, IntakeRow, IntakeStatus, Me, MyCompany, Panels, Site, TelegramLink, Vendor,
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


async function request<T>(method: string, path: string, body?: unknown): Promise<T> {
  // same origin: the session cookie is httpOnly and goes along by itself; nothing is kept in JS
  const res = await fetch(path, {
    method,
    credentials: 'same-origin',
    headers: body === undefined ? { accept: 'application/json' } : { accept: 'application/json', 'content-type': 'application/json' },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
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
  vendors: (companyId: number) => request<{ data: Vendor[] }>('GET', `/companies/${companyId}/vendors`).then((r) => r.data),

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
