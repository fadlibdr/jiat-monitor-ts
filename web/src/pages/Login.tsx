import { useState, type FormEvent } from 'react';
import { api, ApiError } from '../lib/api';

/** Email + password against Better Auth (/api/auth/sign-in/email); the session is an httpOnly cookie. */
export function Login({ notice, onSignedIn }: { notice?: string | undefined; onSignedIn: () => void }) {
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | undefined>(notice);

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    setBusy(true);
    setError(undefined);
    try {
      await api.signIn(email.trim(), password);
      setPassword('');
      onSignedIn();
    } catch (err) {
      // one message for unknown email and wrong password: no hint which of the two it was
      setError(err instanceof ApiError
        ? err.status === 429 ? 'Terlalu banyak percobaan. Tunggu satu menit.' : err.status === 401 || err.status === 400 ? 'Email atau kata sandi salah.' : err.message
        : 'Tidak dapat menghubungi server.');
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="center">
      <form className="card auth-card" onSubmit={submit} aria-labelledby="login-title">
        <div className="brand"><b>JIAT<i>.</i></b><div className="eyebrow">Monitoring proyek</div></div>
        <h1 id="login-title" style={{ fontSize: 20, marginBottom: 16 }}>Masuk</h1>
        {error && <div className="notice error" role="alert">{error}</div>}
        <label className="field"><span>Email</span>
          <input type="email" autoComplete="username" required value={email} onChange={(e) => setEmail(e.target.value)} />
        </label>
        <label className="field"><span>Kata sandi</span>
          <input type="password" autoComplete="current-password" required minLength={12} value={password} onChange={(e) => setPassword(e.target.value)} />
        </label>
        <button className="btn primary" type="submit" disabled={busy} style={{ width: '100%', justifyContent: 'center' }}>
          {busy ? 'Memproses…' : 'Masuk'}
        </button>
        <p className="muted small" style={{ marginTop: 14, marginBottom: 0 }}>Akun dibuat oleh admin sistem. Lupa kata sandi? Hubungi admin.</p>
      </form>
    </div>
  );
}
