import { defineConfig } from 'drizzle-kit';

// `drizzle-kit generate` needs no database; only push/migrate/studio read dbCredentials.
// No default credential: an unset DATABASE_URL_MIGRATE fails loudly instead of connecting somewhere.
const url = process.env['DATABASE_URL_MIGRATE'] ?? process.env['DATABASE_URL'];

export default defineConfig({
  dialect: 'postgresql',
  schema: './src/db/schema.ts',
  out: './drizzle',
  ...(url ? { dbCredentials: { url } } : {}),
});
