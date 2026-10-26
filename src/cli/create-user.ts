/**
 * Creates a user with email+password through Better Auth (hashing, validation) regardless of
 * AUTH_ALLOW_SIGNUP. Password is read from stdin, never from argv (argv is visible in `ps`).
 *
 *   echo -n 'the-password' | npx tsx src/cli/create-user.ts admin@pii.co.id "Admin PII"
 */
import { z } from 'zod';
import { createAuth } from '../auth/better-auth.js';
import { createDb } from '../db/client.js';

const Args = z.tuple([z.email(), z.string().min(2).max(200)]);

async function main(): Promise<void> {
  const [email, name] = Args.parse(process.argv.slice(2));
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
    console.log(`Pengguna dibuat: id=${res.user.id} email=${res.user.email}`);
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
