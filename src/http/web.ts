import { existsSync, readFileSync, statSync } from 'node:fs';
import { readFile, stat } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { serveStatic } from '@hono/node-server/serve-static';
import type { Context } from 'hono';
import { secureHeaders } from 'hono/secure-headers';
import type { App } from './context.js';

/** Where the single-page UI lives: web/ builds to web/dist with `base: '/app/'` (web/vite.config.ts). */
export const WEB_BASE = '/app';

/**
 * The browser UI, from the same origin as the API: the session cookie (httpOnly, SameSite=Lax) goes
 * along by itself, no CORS. Hashed bundles under /app/assets are cached for a year; every other
 * /app path is a client route and gets index.html (never cached, so a deploy is picked up at once).
 * CSP: scripts, styles, images and API calls from this origin only — the build has no inline script.
 */
export function registerWeb(app: App, distDir: string): boolean {
  const root = resolve(distDir);
  const indexPath = join(root, 'index.html');
  if (!existsSync(indexPath)) return false;
  // A rebuild in place replaces the bundles (vite empties dist/): serve the new shell as soon as it is
  // written, not the one read at startup that points at deleted bundles. While index.html is missing
  // mid-build, the last good shell is served.
  let shellHtml = readFileSync(indexPath, 'utf8');
  let shellMtimeMs = statSync(indexPath).mtimeMs;
  const currentShell = async (): Promise<string> => {
    try {
      const s = await stat(indexPath);
      if (s.mtimeMs !== shellMtimeMs) {
        const html = await readFile(indexPath, 'utf8');
        if (html.trim()) {
          shellHtml = html;
          shellMtimeMs = s.mtimeMs;
        }
      }
    } catch {
      // ENOENT during a rebuild: keep the last good shell (a new one is picked up on the next request)
    }
    return shellHtml;
  };

  const headers = secureHeaders({
    contentSecurityPolicy: {
      defaultSrc: ["'self'"],
      scriptSrc: ["'self'"],
      styleSrc: ["'self'"],
      imgSrc: ["'self'", 'data:', 'blob:'],
      connectSrc: ["'self'"],
      fontSrc: ["'self'"],
      objectSrc: ["'none'"],
      baseUri: ["'self'"],
      formAction: ["'self'"],
      frameAncestors: ["'none'"],
    },
    xFrameOptions: 'DENY',
    referrerPolicy: 'same-origin',
  });

  app.get('/', (c) => c.redirect(`${WEB_BASE}/`, 302));
  app.use(WEB_BASE, headers);
  app.use(`${WEB_BASE}/*`, headers);
  // names carry a content hash: a file never changes under its name (set after serveStatic answered)
  app.use(`${WEB_BASE}/assets/*`, async (c, next) => {
    await next();
    if (c.res.status === 200) c.res.headers.set('Cache-Control', 'public, max-age=31536000, immutable');
  });
  app.get(`${WEB_BASE}/assets/*`, serveStatic({ root, rewriteRequestPath: (p) => p.slice(WEB_BASE.length) }));
  // a missing bundle is a 404, not the app shell (a stale tab after a deploy must not run HTML as JS)
  app.get(`${WEB_BASE}/assets/*`, (c) => c.text('Not found', 404));
  const shell = async (c: Context) => c.html(await currentShell(), 200, { 'Cache-Control': 'no-cache' });
  app.get(WEB_BASE, shell);
  app.get(`${WEB_BASE}/*`, shell);
  return true;
}
