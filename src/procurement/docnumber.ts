import { eq, sql } from 'drizzle-orm';
import { formatDocNumber } from '../domain/invoice.js';
import { companies, documentSequences } from '../db/schema.js';
import type { Tx } from '../db/tenant.js';

/**
 * Next document number for the current company (LLD §3: sequences are per company and locked
 * while numbering). One atomic upsert: concurrent callers serialize on the counter row, the
 * loser waits and gets the next value, and a rolled-back transaction gives its number back.
 */
export async function nextDocNumber(tx: Tx, companyId: number, docType: string, siteCode: string | null, date: string): Promise<string> {
  const year = Number(date.slice(0, 4));
  const [row] = await tx.insert(documentSequences)
    .values({ companyId, docType, year, lastNumber: 1 })
    .onConflictDoUpdate({
      target: [documentSequences.companyId, documentSequences.docType, documentSequences.year],
      set: { lastNumber: sql`${documentSequences.lastNumber} + 1`, updatedAt: sql`now()` },
    })
    .returning({ seq: documentSequences.lastNumber });
  const [company] = await tx.select({ prefix: companies.docPrefix }).from(companies).where(eq(companies.id, companyId));
  return formatDocNumber({ prefix: company?.prefix ?? null, docType, siteCode, year, seq: row!.seq });
}
