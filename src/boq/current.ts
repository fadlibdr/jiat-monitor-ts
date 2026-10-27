import { and, asc, eq, inArray } from 'drizzle-orm';
import { HTTPException } from 'hono/http-exception';
import { boqItems, boqVersions } from '../db/schema.js';
import type { Tx } from '../db/tenant.js';

export type BoqItemRow = typeof boqItems.$inferSelect;

/** Leaf items of the contract's current BOQ version (what opname, PR/PO lines and weights refer to). */
export async function currentLeaves(tx: Tx, contractId: number): Promise<BoqItemRow[]> {
  const [version] = await tx.select({ id: boqVersions.id }).from(boqVersions)
    .where(and(eq(boqVersions.contractId, contractId), eq(boqVersions.isCurrent, true)));
  if (!version) return [];
  return tx.select().from(boqItems)
    .where(and(eq(boqItems.versionId, version.id), eq(boqItems.isLeaf, true)))
    .orderBy(asc(boqItems.sortOrder));
}

/**
 * Lines may only point at leaves of the contract's current BOQ (a section or an older version
 * would double-count or vanish from the S-curve). 400 otherwise; ids of another company are
 * invisible through RLS and fail the same way.
 */
export async function assertCurrentLeaves(tx: Tx, contractId: number | null, ids: ReadonlyArray<number | null | undefined>): Promise<Map<number, BoqItemRow>> {
  const wanted = [...new Set(ids.filter((x): x is number => typeof x === 'number'))];
  const out = new Map<number, BoqItemRow>();
  if (!wanted.length) return out;
  if (contractId === null) throw new HTTPException(400, { message: 'boqItemId hanya boleh diisi bila contractId diisi.' });
  const leaves = await currentLeaves(tx, contractId);
  for (const l of leaves) if (wanted.includes(l.id)) out.set(l.id, l);
  const missing = wanted.filter((id) => !out.has(id));
  if (missing.length) throw new HTTPException(400, { message: `boqItemId bukan item daun BOQ aktif kontrak ini: ${missing.join(', ')}` });
  return out;
}

/** BOQ codes of items of any version (to carry progress and commitments over a re-import, by code). */
export async function codesOf(tx: Tx, itemIds: readonly number[]): Promise<Map<number, string>> {
  if (!itemIds.length) return new Map();
  const rows = await tx.select({ id: boqItems.id, code: boqItems.code }).from(boqItems).where(inArray(boqItems.id, [...new Set(itemIds)]));
  return new Map(rows.map((r) => [r.id, r.code]));
}
