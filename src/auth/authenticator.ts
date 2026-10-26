import type { Context } from 'hono';

/**
 * Resolves the caller of a request. The HTTP layer depends only on this interface.
 *
 * Production adapter (next integration step): Better Auth (session in httpOnly cookie, validated
 * server-side per request) mapped onto `users.id`. Until then `headerAuthenticator` exists for tests
 * and local development ONLY and refuses to start in production.
 */
export interface Principal { userId: number }
export interface Authenticator {
  authenticate(c: Context): Promise<Principal | null>;
}

/** Trusts `X-Dev-User-Id`. Dev/test only — guarded. */
export function headerAuthenticator(env: string | undefined = process.env['NODE_ENV']): Authenticator {
  if (env === 'production') throw new Error('headerAuthenticator tidak boleh dipakai di production.');
  return {
    async authenticate(c) {
      const raw = c.req.header('x-dev-user-id');
      if (!raw || !/^\d+$/.test(raw)) return null;
      return { userId: Number(raw) };
    },
  };
}
