import { useState, type ReactNode } from 'react';
import { ApiError } from '../lib/api';

export type Tone = 'red' | 'amber' | 'green' | 'blue' | 'plain';

export function Pill({ tone = 'plain', children }: { tone?: Tone; children: ReactNode }) {
  return <span className={`pill ${tone}`}>{children}</span>;
}

export function Card({ title, eyebrow, id, children, className = '' }: { title?: ReactNode; eyebrow?: ReactNode; id?: string; children: ReactNode; className?: string }) {
  return (
    <section className={`card ${className}`} id={id} aria-label={typeof title === 'string' ? title : undefined}>
      {title !== undefined && <h2>{title}{eyebrow !== undefined && <span className="eyebrow">{eyebrow}</span>}</h2>}
      {children}
    </section>
  );
}

export function Kpi({ label, value, sub, subTone }: { label: string; value: ReactNode; sub?: ReactNode; subTone?: Tone }) {
  return (
    <div className="card kpi">
      <div className="eyebrow">{label}</div>
      <div className="value">{value}</div>
      {sub !== undefined && <div className={`sub ${toneText(subTone)}`}>{sub}</div>}
    </div>
  );
}

export function Mini({ label, value, sub, subTone }: { label: string; value: ReactNode; sub?: ReactNode; subTone?: Tone }) {
  return (
    <div className="mini">
      <div className="eyebrow">{label}</div>
      <div className="value">{value}</div>
      {sub !== undefined && <div className={`sub ${toneText(subTone)}`}>{sub}</div>}
    </div>
  );
}

export function toneText(tone: Tone | undefined): string {
  return tone === 'red' ? 't-red' : tone === 'amber' ? 't-amber' : tone === 'green' ? 't-green' : '';
}

/** A horizontal bar filled to `fraction` (0..1, clamped). */
export function Bar({ fraction, label }: { fraction: number; label: string }) {
  const pct = Math.max(0, Math.min(1, Number.isFinite(fraction) ? fraction : 0)) * 100;
  return (
    <div className="bar" role="meter" aria-label={label} aria-valuemin={0} aria-valuemax={100} aria-valuenow={Math.round(pct)}>
      <i style={{ width: `${pct}%` }} />
    </div>
  );
}

export function Loading({ what = 'data' }: { what?: string }) {
  return <div className="loading" role="status">Memuat {what}…</div>;
}

/**
 * "Keluar". If the server did not end the session (offline, server error), the user stays signed in
 * and is told so: on a shared site-office PC a sign-in screen over a live session is worse than an error.
 */
export function SignOutButton({ onSignOut, className }: { onSignOut: () => Promise<void>; className?: string }) {
  const [busy, setBusy] = useState(false);
  const [failed, setFailed] = useState(false);
  const click = async () => {
    setBusy(true);
    setFailed(false);
    try {
      await onSignOut(); // on success the signed-in screens, this button included, unmount
    } catch {
      setFailed(true);
      setBusy(false);
    }
  };
  return (
    <>
      <button type="button" className={className} onClick={() => void click()} disabled={busy}>{busy ? 'Keluar…' : 'Keluar'}</button>
      {failed && <span className="signout-error" role="alert">Gagal keluar; sesi masih aktif. Periksa koneksi lalu coba lagi.</span>}
    </>
  );
}

export function ErrorNotice({ error, onRetry }: { error: Error; onRetry?: () => void }) {
  return (
    <div className="notice error" role="alert">
      {error instanceof ApiError ? error.message : 'Tidak dapat menghubungi server.'}
      {onRetry && <> <button type="button" className="linkish" onClick={onRetry}>Coba lagi</button></>}
    </div>
  );
}
