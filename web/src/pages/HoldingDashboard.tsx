import { useMemo, useState } from 'react';
import { DashboardPanels, type Names } from '../components/DashboardPanels';
import { Shell } from '../components/Shell';
import { ErrorNotice, Loading } from '../components/ui';
import { api, ApiError, type HoldingQuery } from '../lib/api';
import { currentMonthWib, instantLabel } from '../lib/format';
import { CONTRACT_STATUS_LABEL } from '../lib/status';
import { useAsync } from '../lib/useAsync';
import type { HoldingMeta, Me } from '../lib/types';

const NAV = [
  { to: '#ringkasan', label: 'Dashboard konsolidasi', anchor: true },
  { to: '#kontrak', label: 'Kontrak', anchor: true },
  { to: '#pembelian', label: 'Pembelian', anchor: true },
  { to: '#progres', label: 'Progres fisik', anchor: true },
  { to: '#keuangan', label: 'Invoicing & kas', anchor: true },
  { to: '#intake', label: 'Intake lapangan', anchor: true },
  { to: '#peringatan', label: 'Peringatan', anchor: true },
];

export function namesFrom(meta: HoldingMeta): Names {
  const company = new Map(meta.companies.map((c) => [c.id, c]));
  const site = new Map(meta.sites.map((s) => [s.id, s.name]));
  return {
    company: (id) => company.get(id)?.name ?? `#${id}`,
    companyCode: (id) => company.get(id)?.code ?? `#${id}`,
    site: (id) => site.get(id) ?? `#${id}`,
  };
}

/** LLD §8 holding dashboard: every company, read-only, from the stored snapshot. */
export function HoldingDashboard({ me, onSignOut }: { me: Me; onSignOut: () => void }) {
  const [companyId, setCompanyId] = useState<number>();
  const [siteId, setSiteId] = useState<number>();
  const [month, setMonth] = useState(currentMonthWib());
  const [employerDraft, setEmployerDraft] = useState('');
  const [employer, setEmployer] = useState('');
  const [status, setStatus] = useState('active');
  const [notice, setNotice] = useState<{ tone: 'ok' | 'error' | 'info'; text: string }>();
  const [refreshing, setRefreshing] = useState(false);

  const query: HoldingQuery = { companyId, siteId, period: month || undefined, employer: employer || undefined, status: status || undefined };
  const { data, error, loading, reload } = useAsync(() => api.holdingDashboard(query), [companyId, siteId, month, employer, status]);
  const names = useMemo(() => (data ? namesFrom(data.meta) : undefined), [data]);
  const sites = data?.meta.sites.filter((s) => companyId === undefined || s.companyId === companyId) ?? [];

  const refresh = async () => {
    setRefreshing(true);
    setNotice(undefined);
    try {
      const r = await api.holdingRefresh();
      setNotice({ tone: 'ok', text: `Data disegarkan ${instantLabel(r.refreshedAt)} WIB.` });
      reload();
    } catch (e) {
      setNotice({ tone: e instanceof ApiError && e.status === 429 ? 'info' : 'error', text: e instanceof ApiError ? e.message : 'Tidak dapat menghubungi server.' });
    } finally {
      setRefreshing(false);
    }
  };

  return (
    <Shell
      me={me}
      context="Holding"
      nav={NAV}
      current=""
      onSignOut={onSignOut}
      roleNote="peran: holding viewer · baca saja"
      crumbs={<>Holding › <b>Dashboard konsolidasi</b></>}
      actions={(
        <>
          <span className="stamp">data per {instantLabel(data?.meta.refreshedAt)}</span>
          <button type="button" className="btn" onClick={refresh} disabled={refreshing}>{refreshing ? 'Menyegarkan…' : 'Segarkan data'}</button>
          <a className="btn primary" href={api.holdingExportUrl(query)} download>Unduh laporan</a>
        </>
      )}
    >
      <div className="page-head">
        <div className="eyebrow">Dashboard konsolidasi</div>
        <h1>{companyId === undefined ? 'Seluruh perusahaan' : names?.company(companyId)}, {siteId === undefined ? 'seluruh lokasi' : names?.site(siteId)}</h1>
      </div>

      <div className="filters" role="group" aria-label="Filter">
        <label className="chip"><span>Perusahaan</span>
          <select value={companyId ?? ''} onChange={(e) => { setCompanyId(e.target.value ? Number(e.target.value) : undefined); setSiteId(undefined); }}>
            <option value="">Semua ({data?.meta.companies.length ?? '…'})</option>
            {data?.meta.companies.map((c) => <option key={c.id} value={c.id}>{c.name}</option>)}
          </select>
        </label>
        <label className="chip"><span>Lokasi</span>
          <select value={siteId ?? ''} onChange={(e) => setSiteId(e.target.value ? Number(e.target.value) : undefined)}>
            <option value="">Semua ({sites.length})</option>
            {sites.map((s) => <option key={s.id} value={s.id}>{s.name}</option>)}
          </select>
        </label>
        <label className="chip"><span>Periode</span>
          <input type="month" value={month} onChange={(e) => setMonth(e.target.value)} required />
        </label>
        <label className="chip"><span>Pemberi kerja</span>
          <input
            type="text" placeholder="Semua" value={employerDraft} maxLength={200}
            onChange={(e) => setEmployerDraft(e.target.value)}
            onBlur={() => setEmployer(employerDraft.trim())}
            onKeyDown={(e) => { if (e.key === 'Enter') setEmployer(employerDraft.trim()); }}
          />
        </label>
        <label className="chip"><span>Status kontrak</span>
          <select value={status} onChange={(e) => setStatus(e.target.value)}>
            <option value="">Semua</option>
            {Object.entries(CONTRACT_STATUS_LABEL).map(([v, l]) => <option key={v} value={v}>{l}</option>)}
          </select>
        </label>
      </div>

      {notice && <div className={`notice ${notice.tone === 'info' ? '' : notice.tone}`} role="status">{notice.text}</div>}
      {error && <ErrorNotice error={error} onRetry={reload} />}
      {loading && !data && <Loading what="dashboard" />}
      {data && names && (
        <div aria-busy={loading}>
          <DashboardPanels p={data.data} names={names} multiCompany />
          <div className="foot">
            <span>Angka berasal dari snapshot agregasi (dash_*); setiap akses halaman ini tercatat di audit log.</span>
            <span className="mono">data per {instantLabel(data.meta.refreshedAt)}</span>
          </div>
        </div>
      )}
    </Shell>
  );
}
