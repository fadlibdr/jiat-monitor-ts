import { useState } from 'react';
import { ErrorNotice } from '../components/ui';
import { api, ApiError } from '../lib/api';
import { instantLabel } from '../lib/format';
import { Link } from '../lib/router';
import { ROLE_LABEL } from '../lib/status';
import type { Me, MyCompany, TelegramLink } from '../lib/types';

/** Company picker after sign-in, plus the holding entry and Telegram linking. */
export function Home({ me, companies, onSignOut }: { me: Me; companies: MyCompany[]; onSignOut: () => void }) {
  return (
    <div className="center">
      <div style={{ width: '100%', maxWidth: 560 }}>
        <div className="brand" style={{ padding: '0 0 16px' }}><b style={{ color: 'var(--navy-deep)', fontFamily: 'var(--display)', fontSize: 22 }}>JIAT<span style={{ color: 'var(--amber)' }}>.</span></b></div>
        <h1 style={{ fontSize: 22 }}>Halo, {me.name || me.email}</h1>
        <p className="muted">Pilih ruang kerja.</p>
        <div className="picker">
          {me.holdingViewer && (
            <Link to="/holding"><span><b>Dashboard holding</b><br /><span className="muted small">Konsolidasi seluruh perusahaan · baca saja</span></span><span aria-hidden>→</span></Link>
          )}
          {companies.map((c) => (
            <Link key={c.id} to={`/c/${c.id}`}>
              <span><b>{c.name}</b><br /><span className="muted small">{c.code} · {ROLE_LABEL[c.role] ?? c.role}</span></span>
              <span aria-hidden>→</span>
            </Link>
          ))}
          {!me.holdingViewer && companies.length === 0 && (
            <div className="notice">Akun Anda belum terdaftar di perusahaan mana pun. Hubungi admin sistem.</div>
          )}
        </div>
        <TelegramLinkBox />
        <p style={{ marginTop: 20 }}><button type="button" className="linkish" onClick={onSignOut}>Keluar</button></p>
      </div>
    </div>
  );
}

/** One-time code for "/start <code>" to the bot: links the Telegram account and opens the private chat for the daily digest. */
function TelegramLinkBox() {
  const [link, setLink] = useState<TelegramLink>();
  const [error, setError] = useState<Error>();
  const [busy, setBusy] = useState(false);
  const create = async () => {
    setBusy(true);
    setError(undefined);
    try {
      setLink(await api.telegramLink());
    } catch (e) {
      setError(e instanceof Error ? e : new ApiError(0, String(e)));
    } finally {
      setBusy(false);
    }
  };
  return (
    <section className="card" style={{ marginTop: 18 }} aria-label="Hubungkan Telegram">
      <h2 style={{ fontSize: 16, marginBottom: 6 }}>Telegram</h2>
      <p className="muted small" style={{ marginTop: 0 }}>Hubungkan akun Telegram untuk menerima ringkasan harian pukul 07.00 WIB.</p>
      {error && <ErrorNotice error={error} />}
      {link ? (
        <div>
          <p>Kirim ke bot: <span className="mono" style={{ fontSize: 16 }}>/start {link.code}</span></p>
          {link.link && <p><a href={link.link} target="_blank" rel="noopener noreferrer">Buka di Telegram →</a></p>}
          <p className="muted small">Kode berlaku sampai {instantLabel(link.expiresAt)} WIB dan hanya bisa dipakai sekali.</p>
        </div>
      ) : (
        <button type="button" className="btn" onClick={create} disabled={busy}>{busy ? 'Membuat kode…' : 'Buat kode penghubung'}</button>
      )}
    </section>
  );
}
