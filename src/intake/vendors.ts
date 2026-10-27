import { and, eq, sql } from 'drizzle-orm';
import type { Category } from '../domain/categories.js';
import { vendors } from '../db/schema.js';
import type { Tx } from '../db/tenant.js';

/** V10 (LLD §6): trigram similarity ≥ 0.6 between the OCR'd name and vendors.name. */
export const VENDOR_MATCH_MIN = 0.6;

export interface VendorMatch { id: number; name: string; defaultCategory: Category | null; similarity: number }

/** Best vendor of the current company (RLS) for a name, or null below the threshold. */
export async function matchVendor(tx: Tx, name: string): Promise<VendorMatch | null> {
  const n = name.trim();
  if (!n) return null;
  const sim = sql<number>`similarity(lower(${vendors.name}), lower(${n}))`;
  const [row] = await tx
    .select({ id: vendors.id, name: vendors.name, defaultCategory: vendors.defaultCategory, similarity: sim })
    .from(vendors)
    .where(sql`${sim} >= ${VENDOR_MATCH_MIN}`)
    .orderBy(sql`${sim} DESC`, vendors.id)
    .limit(1);
  return row ? { ...row, similarity: Number(row.similarity) } : null;
}

/**
 * Vendor for a name typed in a chat correction (LLD §7 "VENDOR"): the matching vendor, or a new
 * one with status `draft` for the admin to complete. Idempotent on the exact name.
 */
export async function vendorForName(tx: Tx, companyId: number, name: string): Promise<VendorMatch> {
  const clean = name.trim().replace(/\s+/g, ' ');
  // callers validate; this guard keeps a blank master vendor out even if one does not
  if (clean.length < 2) throw new RangeError('Nama vendor kosong atau terlalu pendek.');
  const match = await matchVendor(tx, clean);
  if (match) return match;
  await tx.insert(vendors).values({ companyId, name: clean, status: 'draft' }).onConflictDoNothing({ target: [vendors.companyId, vendors.name] });
  const [row] = await tx.select({ id: vendors.id, name: vendors.name, defaultCategory: vendors.defaultCategory })
    .from(vendors).where(and(eq(vendors.companyId, companyId), eq(vendors.name, clean)));
  return { ...row!, similarity: 1 };
}
