import type { ReactNode } from 'react';
import { Link } from '../lib/router';
import { SignOutButton } from './ui';
import type { Me } from '../lib/types';

export interface NavItem {
  to: string;
  label: string;
  /** an in-page anchor ("#kontrak") instead of a route */
  anchor?: boolean;
}

/** Navy sidebar + sticky top bar of the mockup. */
export function Shell({ me, context, nav, current, crumbs, roleNote, actions, onSignOut, children }: {
  me: Me;
  /** "Holding" or the company name, under the logo */
  context: string;
  nav: Array<NavItem | { head: string }>;
  current: string;
  crumbs: ReactNode;
  roleNote: string;
  actions?: ReactNode;
  onSignOut: () => Promise<void>;
  children: ReactNode;
}) {
  return (
    <div className="shell">
      <aside className="sidebar">
        <div className="brand">
          <Link to="/" style={{ textDecoration: 'none' }}><b>JIAT<i>.</i></b></Link>
          <div className="eyebrow">Monitoring proyek · {context}</div>
        </div>
        <nav className="nav" aria-label="Navigasi utama">
          {nav.map((item, i) => ('head' in item
            ? <div className="nav-head" key={`h${i}`}>{item.head}</div>
            : item.anchor
              ? <a key={item.to} href={item.to}>{item.label}</a>
              : <Link key={item.to} to={item.to} aria-current={current === item.to ? 'page' : undefined}>{item.label}</Link>))}
        </nav>
        <div className="whoami">
          <strong>{me.name || me.email}</strong>
          <span>{roleNote}</span>
          <SignOutButton onSignOut={onSignOut} />
        </div>
      </aside>
      <div className="main">
        <header className="topbar">
          <div className="crumbs">{crumbs}</div>
          {actions}
        </header>
        <main className="content">{children}</main>
      </div>
    </div>
  );
}
