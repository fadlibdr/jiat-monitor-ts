import { useCallback, useEffect, useState } from 'react';
import { ErrorNotice, Loading } from './components/ui';
import { api, ApiError, setUnauthorizedHandler } from './lib/api';
import { match, navigate, usePath } from './lib/router';
import type { Me, MyCompany } from './lib/types';
import { CompanyArea, type CompanyView } from './pages/CompanyArea';
import { HoldingDashboard } from './pages/HoldingDashboard';
import { Home } from './pages/Home';
import { Login } from './pages/Login';

type Session =
  | { state: 'loading' }
  | { state: 'signed-out' }
  | { state: 'error'; error: Error }
  | { state: 'signed-in'; me: Me; companies: MyCompany[] };

export function App() {
  const path = usePath();
  const [session, setSession] = useState<Session>({ state: 'loading' });

  const load = useCallback(async () => {
    try {
      const [me, companies] = await Promise.all([api.me(), api.myCompanies()]);
      setSession({ state: 'signed-in', me, companies });
    } catch (e) {
      if (e instanceof ApiError && (e.status === 401 || e.status === 403)) setSession({ state: 'signed-out' });
      else setSession({ state: 'error', error: e instanceof Error ? e : new Error(String(e)) });
    }
  }, []);

  useEffect(() => {
    setUnauthorizedHandler(() => setSession({ state: 'signed-out' }));
    void load();
  }, [load]);

  const signOut = useCallback(async () => {
    try {
      await api.signOut();
    } finally {
      setSession({ state: 'signed-out' });
      navigate('/', { replace: true });
    }
  }, []);

  if (session.state === 'loading') return <div className="center"><Loading what="sesi" /></div>;
  if (session.state === 'error') return <div className="center"><ErrorNotice error={session.error} onRetry={() => { setSession({ state: 'loading' }); void load(); }} /></div>;
  if (session.state === 'signed-out') return <Login onSignedIn={() => { setSession({ state: 'loading' }); void load(); }} />;

  const { me, companies } = session;
  if (path === '/holding') {
    return me.holdingViewer ? <HoldingDashboard me={me} onSignOut={signOut} /> : <NotFound text="Halaman holding hanya untuk holding viewer." />;
  }
  const c = match('/c/:companyId', path) ?? match('/c/:companyId/:view', path);
  if (c) {
    const company = companies.find((x) => String(x.id) === c['companyId']);
    const view = (c['view'] ?? 'home') as CompanyView;
    if (!company) return <NotFound text="Anda tidak terdaftar pada perusahaan ini." />;
    if (!['home', 'intake', 'dashboard'].includes(view)) return <NotFound text="Halaman tidak ditemukan." />;
    return <CompanyArea me={me} company={company} view={view} onSignOut={signOut} />;
  }
  if (path !== '/') return <NotFound text="Halaman tidak ditemukan." />;
  return <Home me={me} companies={companies} onSignOut={signOut} />;
}

function NotFound({ text }: { text: string }) {
  return (
    <div className="center">
      <div className="card auth-card">
        <p>{text}</p>
        <button type="button" className="btn" onClick={() => navigate('/')}>Kembali ke beranda</button>
      </div>
    </div>
  );
}
