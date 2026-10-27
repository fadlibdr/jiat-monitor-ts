import type { ReactNode } from 'react';
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

export function ErrorNotice({ error, onRetry }: { error: Error; onRetry?: () => void }) {
  return (
    <div className="notice error" role="alert">
      {error instanceof ApiError ? error.message : 'Tidak dapat menghubungi server.'}
      {onRetry && <> <button type="button" className="linkish" onClick={onRetry}>Coba lagi</button></>}
    </div>
  );
}
