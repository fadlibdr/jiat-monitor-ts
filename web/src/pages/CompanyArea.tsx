import { useEffect, useMemo, useState } from 'react';
import { DashboardPanels, type Names } from '../components/DashboardPanels';
import { Shell, type NavItem } from '../components/Shell';
import { ErrorNotice, Loading } from '../components/ui';
import { api } from '../lib/api';
import { currentMonthWib } from '../lib/format';
import { navigate } from '../lib/router';
import { ROLE_LABEL } from '../lib/status';
import { useAsync } from '../lib/useAsync';
import type { CompanyRole, Me, MyCompany } from '../lib/types';
import { IntakeReview } from './IntakeReview';

/** Server role sets (src/http/context.ts): the review list and the company dashboard. */
const REVIEW_ROLES: readonly CompanyRole[] = ['project_admin', 'finance', 'company_manager', 'system_admin'];
const DASHBOARD_ROLES: readonly CompanyRole[] = ['finance', 'company_manager', 'system_admin'];

export type CompanyView = 'home' | 'intake' | 'dashboard';

/** Everything under /c/:companyId: the screens this role may open, in the shell. */
export function CompanyArea({ me, company, view, onSignOut }: { me: Me; company: MyCompany; view: CompanyView; onSignOut: () => void }) {
  const base = `/c/${company.id}`;
  const nav: Array<NavItem | { head: string }> = [{ head: company.code }];
  if (DASHBOARD_ROLES.includes(company.role)) nav.push({ to: `${base}/dashboard`, label: 'Dashboard perusahaan' });
  if (REVIEW_ROLES.includes(company.role)) nav.push({ to: `${base}/intake`, label: 'Review nota' });
  nav.push({ to: '/', label: 'Ganti ruang kerja' });

  // /c/:id opens the first screen the role has (after render: navigating updates the App's state)
  const landing = nav.find((n): n is NavItem => 'to' in n && n.to !== '/');
  const redirect = view === 'home' && landing ? landing.to : null;
  useEffect(() => {
    if (redirect) navigate(redirect, { replace: true });
  }, [redirect]);
  if (redirect) return null;
  const allowed = view === 'intake' ? REVIEW_ROLES.includes(company.role) : view === 'dashboard' ? DASHBOARD_ROLES.includes(company.role) : false;
  const title = view === 'intake' ? 'Review nota' : view === 'dashboard' ? 'Dashboard perusahaan' : 'Beranda';

  return (
    <Shell
      me={me}
      context={company.name}
      nav={nav}
      current={`${base}/${view}`}
      onSignOut={onSignOut}
      roleNote={`peran: ${ROLE_LABEL[company.role] ?? company.role}`}
      crumbs={<>{company.name} › <b>{title}</b></>}
    >
      {!allowed && (
        <div className="notice">
          {company.role === 'site_staff'
            ? 'Staf site mengirim foto nota dan opname lewat bot Telegram di grup lokasi. Belum ada layar web untuk peran ini.'
            : 'Peran Anda tidak membuka halaman ini.'}
        </div>
      )}
      {allowed && view === 'intake' && <IntakeReview companyId={company.id} role={company.role} />}
      {allowed && view === 'dashboard' && <CompanyDashboard company={company} />}
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
          <input type="month" value={month} onChange={(e) => setMonth(e.target.value)} required />
        </label>
      </div>
      {dash.error && <ErrorNotice error={dash.error} onRetry={dash.reload} />}
      {dash.loading && !dash.data && <Loading what="dashboard" />}
      {dash.data && <div aria-busy={dash.loading}><DashboardPanels p={dash.data} names={names} multiCompany={false} /></div>}
    </>
  );
}
