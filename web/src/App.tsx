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
  /** notice: why the sign-in did not hold (e.g. "Akun dinonaktifkan.") */
  | { state: 'signed-out'; notice?: string }
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
      // 401: no session. 403 on /me: the account is deactivated (Better Auth still issued a cookie),
      // so say why instead of showing an empty sign-in form again
      if (e instanceof ApiError && e.status === 401) setSession({ state: 'signed-out' });
      else if (e instanceof ApiError && e.status === 403) setSession({ state: 'signed-out', notice: e.message });
      else setSession({ state: 'error', error: e instanceof Error ? e : new Error(String(e)) });
    }
  }, []);

  useEffect(() => {
    setUnauthorizedHandler(() => setSession({ state: 'signed-out' }));
    void load();
  }, [load]);

  /** Rejects when the server did not end the session; the caller (SignOutButton) shows that. */
  const signOut = useCallback(async () => {
    try {
      await api.signOut();
    } catch (e) {
      // 401: the session had already ended. Anything else (offline, 5xx, 429): the cookie may still
      // be valid, so the screen must not pretend the user is signed out.
      if (!(e instanceof ApiError && e.status === 401)) throw e;
    }
    setSession({ state: 'signed-out' });
    navigate('/', { replace: true });
  }, []);

  if (session.state === 'loading') return <div className="center"><Loading what="sesi" /></div>;
  if (session.state === 'error') return <div className="center"><ErrorNotice error={session.error} onRetry={() => { setSession({ state: 'loading' }); void load(); }} /></div>;
  if (session.state === 'signed-out') return <Login notice={session.notice} onSignedIn={() => { setSession({ state: 'loading' }); void load(); }} />;

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
    // keyed: going from one company straight to another (history) starts with empty state, not the previous company's
    return <CompanyArea key={company.id} me={me} company={company} view={view} onSignOut={signOut} />;
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
