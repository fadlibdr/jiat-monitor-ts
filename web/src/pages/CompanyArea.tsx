import { useEffect, useMemo, useState } from 'react';
import { DashboardPanels, type Names } from '../components/DashboardPanels';
import { Shell, type NavItem } from '../components/Shell';
import { ErrorNotice, Loading } from '../components/ui';
import { api } from '../lib/api';
import { currentMonthWib } from '../lib/format';
import {
  APPROVE_ROLES, can, DASHBOARD_ROLES, EDIT_ROLES, FINANCE_ROLES, MANAGE_ROLES, MASTER_ROLES, OPNAME_ROLES, PROGRESS_ROLES, REVIEW_ROLES, VENDOR_WRITE_ROLES,
} from '../lib/roles';
import { navigate } from '../lib/router';
import { ROLE_LABEL } from '../lib/status';
import { useAsync } from '../lib/useAsync';
import type { CompanyRole, Me, MyCompany } from '../lib/types';
import { IntakeReview } from './IntakeReview';
import { Procurement } from './Procurement';
import { Progress } from './Progress';
import { ContractDetail } from './master/ContractDetail';
import { Contracts } from './master/Contracts';
import { Members } from './master/Members';
import { Sites } from './master/Sites';
import { Vendors } from './master/Vendors';

export const COMPANY_VIEWS = ['home', 'intake', 'dashboard', 'progress', 'procurement', 'contracts', 'sites', 'vendors', 'members'] as const;
export type CompanyView = (typeof COMPANY_VIEWS)[number];

const VIEW: Record<Exclude<CompanyView, 'home'>, { label: string; roles: readonly CompanyRole[] }> = {
  dashboard: { label: 'Dashboard perusahaan', roles: DASHBOARD_ROLES },
  intake: { label: 'Review nota', roles: REVIEW_ROLES },
  progress: { label: 'Progres & opname', roles: PROGRESS_ROLES },
  procurement: { label: 'Pembelian', roles: MASTER_ROLES },
  contracts: { label: 'Kontrak', roles: MASTER_ROLES },
  sites: { label: 'Lokasi', roles: MASTER_ROLES },
  vendors: { label: 'Vendor', roles: MASTER_ROLES },
  members: { label: 'Anggota', roles: MASTER_ROLES },
};

/** Everything under /c/:companyId: the screens this role may open, in the shell. */
export function CompanyArea({ me, company, view, itemId, onSignOut }: {
  me: Me; company: MyCompany; view: CompanyView; itemId?: number | undefined; onSignOut: () => Promise<void>;
}) {
  const base = `/c/${company.id}`;
  const role = company.role;
  const item = (v: Exclude<CompanyView, 'home'>): NavItem[] => (can(role, VIEW[v].roles) ? [{ to: `${base}/${v}`, label: VIEW[v].label }] : []);
  const work = [...item('dashboard'), ...item('intake'), ...item('progress'), ...item('procurement')];
  const master = [...item('contracts'), ...item('sites'), ...item('vendors'), ...item('members')];
  const nav: Array<NavItem | { head: string }> = [
    { head: company.code }, ...work,
    ...(master.length ? [{ head: 'Data master' }, ...master] : []),
    { to: '/', label: 'Ganti ruang kerja' },
  ];

  // /c/:id opens the first screen the role has (after render: navigating updates the App's state)
  const landing = [...work, ...master][0];
  const redirect = view === 'home' && landing ? landing.to : null;
  useEffect(() => {
    if (redirect) navigate(redirect, { replace: true });
  }, [redirect]);
  if (redirect) return null;
  const allowed = view !== 'home' && can(role, VIEW[view].roles);
  const title = view === 'home' ? 'Beranda' : VIEW[view].label;

  return (
    <Shell
      me={me}
      context={company.name}
      nav={nav}
      current={`${base}/${view}`}
      onSignOut={onSignOut}
      roleNote={`peran: ${ROLE_LABEL[role] ?? role}`}
      crumbs={<>{company.name} › <b>{title}</b></>}
    >
      {!allowed && (
        <div className="notice">
          {role === 'site_staff'
            ? 'Staf site mengirim foto nota lewat bot Telegram di grup lokasi; di web, staf site mengisi opname di halaman Progres.'
            : 'Peran Anda tidak membuka halaman ini.'}
        </div>
      )}
      {allowed && view === 'intake' && <IntakeReview companyId={company.id} role={role} />}
      {allowed && view === 'dashboard' && <CompanyDashboard company={company} />}
      {allowed && view === 'contracts' && (itemId
        ? <ContractDetail key={itemId} companyId={company.id} contractId={itemId} canEdit={can(role, EDIT_ROLES)} />
        : <Contracts companyId={company.id} canEdit={can(role, EDIT_ROLES)} />)}
      {allowed && view === 'progress' && (
        <Progress companyId={company.id} canReport={can(role, OPNAME_ROLES)} canPlan={can(role, EDIT_ROLES)} canApprove={can(role, APPROVE_ROLES)} />
      )}
      {allowed && view === 'procurement' && <Procurement companyId={company.id} canEdit={can(role, EDIT_ROLES)} canApprove={can(role, APPROVE_ROLES)} />}
      {allowed && view === 'sites' && <Sites companyId={company.id} canEdit={can(role, EDIT_ROLES)} />}
      {allowed && view === 'vendors' && <Vendors companyId={company.id} canEdit={can(role, VENDOR_WRITE_ROLES)} seesPii={can(role, FINANCE_ROLES)} />}
      {allowed && view === 'members' && <Members companyId={company.id} canManage={can(role, MANAGE_ROLES)} />}
    </Shell>
  );
}

/** LLD §8 company dashboard: live, inside the caller's RLS and site scope. */
function CompanyDashboard({ company }: { company: MyCompany }) {
  const [month, setMonth] = useState(currentMonthWib());
  const sites = useAsync(() => api.sites(company.id), [company.id]);
  const dash = useAsync(() => api.companyDashboard(company.id, month), [company.id, month]);
  const names = useMemo<Names>(() => {
    const site = new Map((sites.data ?? []).map((s) => [s.id, s.name]));
    return { company: () => company.name, companyCode: () => company.code, site: (id) => site.get(id) ?? `#${id}` };
  }, [sites.data, company]);

  return (
    <>
      <div className="page-head">
        <div className="eyebrow">Dashboard perusahaan</div>
        <h1>{company.name}</h1>
      </div>
      <div className="filters">
        <label className="chip"><span>Periode</span>
          {/* the browser's clear button empties it: keep the shown month rather than fall back silently */}
          <input type="month" value={month} onChange={(e) => { if (e.target.value) setMonth(e.target.value); }} required />
        </label>
      </div>
      {dash.error && <ErrorNotice error={dash.error} onRetry={dash.reload} />}
      {dash.loading && !dash.data && <Loading what="dashboard" />}
      {dash.data && <div aria-busy={dash.loading}><DashboardPanels p={dash.data} names={names} multiCompany={false} /></div>}
    </>
  );
}
