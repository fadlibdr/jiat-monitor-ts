import { useEffect, useState, type AnchorHTMLAttributes, type MouseEvent, type ReactNode } from 'react';

/**
 * A minimal history router for a handful of screens under the /app/ base (vite `base`). Paths inside
 * the app are written without the base: navigate('/holding') → /app/holding.
 */
const BASE = import.meta.env.BASE_URL.replace(/\/$/, '');
const CHANGE = 'jiat:navigate';

function current(): string {
  const p = window.location.pathname;
  const inner = p.startsWith(BASE) ? p.slice(BASE.length) : p;
  return inner === '' ? '/' : inner;
}

export function href(to: string): string {
  return `${BASE}${to.startsWith('/') ? to : `/${to}`}`;
}

export function navigate(to: string, opts: { replace?: boolean } = {}): void {
  const url = href(to);
  if (opts.replace) window.history.replaceState(null, '', url);
  else window.history.pushState(null, '', url);
  window.dispatchEvent(new Event(CHANGE));
  window.scrollTo(0, 0);
}

export function usePath(): string {
  const [path, setPath] = useState(current);
  useEffect(() => {
    const update = () => setPath(current());
    window.addEventListener('popstate', update);
    window.addEventListener(CHANGE, update);
    return () => {
      window.removeEventListener('popstate', update);
      window.removeEventListener(CHANGE, update);
    };
  }, []);
  return path;
}

export { match } from './match';

type LinkProps = Omit<AnchorHTMLAttributes<HTMLAnchorElement>, 'href'> & { to: string; children: ReactNode };

/** <a> that navigates inside the app; ctrl/cmd-click and middle-click still open a new tab. */
export function Link({ to, children, onClick, ...rest }: LinkProps) {
  const go = (e: MouseEvent<HTMLAnchorElement>) => {
    onClick?.(e);
    if (e.defaultPrevented || e.button !== 0 || e.metaKey || e.ctrlKey || e.shiftKey || e.altKey) return;
    e.preventDefault();
    navigate(to);
  };
  return <a href={href(to)} onClick={go} {...rest}>{children}</a>;
}
