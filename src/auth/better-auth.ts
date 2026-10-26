import { drizzleAdapter } from '@better-auth/drizzle-adapter';
import { betterAuth } from 'better-auth';
import type { Context } from 'hono';
import { accounts, sessions, users, verifications } from '../db/schema.js';
import type { Db } from '../db/tenant.js';
import type { Authenticator } from './authenticator.js';

export interface AuthOptions {
  secret: string; // BETTER_AUTH_SECRET: ≥ 32 chars, from env only
  baseURL: string; // where this API is served, e.g. https://jiat.example.co.id
  trustedOrigins?: string[]; // browser origins allowed to call /api/auth
  allowSignUp?: boolean; // default false: users are created by an admin / CLI, not self-service
  secureCookies?: boolean; // default: true in production
}

/**
 * Better Auth instance: email+password, server-side sessions in `sessions`, httpOnly cookie,
 * serial ids so `session.user.id` === users.id (bigint) used by company_users.
 */
export function createAuth(db: Db, opt: AuthOptions) {
  if (!opt.secret || opt.secret.length < 32) throw new Error('BETTER_AUTH_SECRET harus ≥ 32 karakter.');
  return betterAuth({
    secret: opt.secret,
    baseURL: opt.baseURL,
    basePath: '/api/auth',
    trustedOrigins: opt.trustedOrigins ?? [],
    database: drizzleAdapter(db, {
      provider: 'pg',
      schema: { user: users, session: sessions, account: accounts, verification: verifications },
    }),
    emailAndPassword: {
      enabled: true,
      disableSignUp: !(opt.allowSignUp ?? false),
      minPasswordLength: 12,
    },
    session: {
      expiresIn: 60 * 60 * 24 * 7, // 7 days
      updateAge: 60 * 60 * 24, // refresh at most daily
      cookieCache: { enabled: false }, // every protected request hits the sessions table (server-side validation)
    },
    advanced: {
      database: { generateId: 'serial' },
      cookiePrefix: 'jiat',
      ...(opt.secureCookies !== undefined ? { useSecureCookies: opt.secureCookies } : {}),
    },
  });
}
export type Auth = ReturnType<typeof createAuth>;

/** Authenticator backed by Better Auth sessions (cookie → sessions row → users.id). */
export function betterAuthAuthenticator(auth: Auth): Authenticator {
  return {
    async authenticate(c: Context) {
      const session = await auth.api.getSession({ headers: c.req.raw.headers });
      if (!session) return null;
      const id = Number(session.user.id);
      if (!Number.isInteger(id) || id <= 0) return null;
      return { userId: id };
    },
  };
}
