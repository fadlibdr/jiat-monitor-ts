/**
 * Creates a user with email+password through Better Auth (hashing, validation) regardless of
 * AUTH_ALLOW_SIGNUP. Password is read from stdin, never from argv (argv is visible in `ps`).
 *
 *   echo -n 'the-password' | npx tsx src/cli/create-user.ts admin@pii.co.id "Admin PII" [--system-admin]
 *
 * `--system-admin` bootstraps the first global admin (HLD §2 "Admin sistem"); further admins are
 * granted from the API (PATCH /admin/users/:id).
 */
import { eq } from 'drizzle-orm';
import { z } from 'zod';
import { createAuth } from '../auth/better-auth.js';
import { createDb } from '../db/client.js';
import { users } from '../db/schema.js';

const Args = z.tuple([z.email(), z.string().min(2).max(200)]);
const FLAGS = ['--system-admin'] as const;

async function main(): Promise<void> {
  const argv = process.argv.slice(2);
  const flags = argv.filter((a) => a.startsWith('--'));
  const unknown = flags.filter((f) => !(FLAGS as readonly string[]).includes(f));
  if (unknown.length) throw new Error(`Opsi tidak dikenal: ${unknown.join(' ')} (yang ada: ${FLAGS.join(' ')})`);
  const [email, name] = Args.parse(argv.filter((a) => !a.startsWith('--')));
  const systemAdmin = flags.includes('--system-admin');

  const password = (await readStdin()).trim();
  if (password.length < 12) throw new Error('Password harus ≥ 12 karakter (dibaca dari stdin).');
  const url = process.env['DATABASE_URL'];
  const secret = process.env['BETTER_AUTH_SECRET'];
  const baseURL = process.env['BETTER_AUTH_URL'];
  if (!url || !secret || !baseURL) throw new Error('DATABASE_URL, BETTER_AUTH_SECRET, BETTER_AUTH_URL harus diisi.');

  const { db, ping, close } = createDb(url);
  await ping();
  try {
    const auth = createAuth(db, { secret, baseURL, allowSignUp: true });
    const res = await auth.api.signUpEmail({ body: { email, name, password } });
    if (systemAdmin) await db.update(users).set({ isSystemAdmin: true }).where(eq(users.id, Number(res.user.id)));
    console.log(`Pengguna dibuat: id=${res.user.id} email=${res.user.email}${systemAdmin ? ' (admin sistem)' : ''}`);
  } finally {
    await close();
  }
}

function readStdin(): Promise<string> {
  return new Promise((resolve, reject) => {
    let data = '';
    process.stdin.setEncoding('utf8');
    process.stdin.on('data', (chunk) => { data += chunk; });
    process.stdin.on('end', () => resolve(data));
    process.stdin.on('error', reject);
  });
}

main().catch((e: unknown) => {
  console.error(e instanceof Error ? e.message : String(e));
  process.exit(1);
});
