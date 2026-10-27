import { and, eq, isNotNull, lt } from 'drizzle-orm';
import { attachments, companies, jobs } from '../db/schema.js';
import { withApp, withCompany, type Db } from '../db/tenant.js';
import type { ObjectStorage } from '../intake/storage.js';

/**
 * PurgeFailedIntakeTemp (LLD §9, 02:00 WIB). The pipeline never writes a photo it rejects (stage 1
 * runs before storage.put), so what is left to sweep are files a crash orphaned: a photo stored
 * whose database transaction never committed, and temp files of an interrupted write. A file is
 * removed only when it is older than a day AND no attachment row points at it, so a save in
 * progress is never touched. Also clears finished jobs after 30 days (failed ones stay 90 days for
 * the post-mortem).
 */
export const ORPHAN_MIN_AGE_MS = 86_400_000;
export const DONE_JOBS_KEEP_DAYS = 30;
export const FAILED_JOBS_KEEP_DAYS = 90;

export interface PurgeDeps {
  db: Db;
  storage: ObjectStorage;
  log: (msg: string, meta: object) => void;
}

export async function purgeOrphanPhotos(deps: PurgeDeps, now: Date): Promise<{ scanned: number; removed: number }> {
  const list = deps.storage.list?.bind(deps.storage);
  if (!list) {
    deps.log('purge_skipped', { reason: 'storage cannot list' });
    return { scanned: 0, removed: 0 };
  }
  const ids = await withApp(deps.db, (tx) => tx.select({ id: companies.id }).from(companies));
  let scanned = 0;
  let removed = 0;
  for (const { id } of ids) {
    const referenced = new Set(await withCompany(deps.db, id, async (tx) =>
      (await tx.select({ path: attachments.path }).from(attachments)).map((a) => a.path)));
    for await (const o of list(`company-${id}/intake/`)) {
      scanned++;
      if (now.getTime() - o.modifiedAt.getTime() < ORPHAN_MIN_AGE_MS) continue;
      if (!o.key.endsWith('.tmp')) {
        if (referenced.has(o.key)) continue;
        // the set was read before the scan: a resent photo may have been attached to this very file since
        if (await isAttached(deps.db, id, o.key)) continue;
      }
      await deps.storage.delete(o.key);
      removed++;
      deps.log('purge_orphan_removed', { companyId: id, key: o.key });
    }
  }
  return { scanned, removed };
}

async function isAttached(db: Db, companyId: number, key: string): Promise<boolean> {
  const [row] = await withCompany(db, companyId, (tx) => tx.select({ id: attachments.id }).from(attachments).where(eq(attachments.path, key)).limit(1));
  return row !== undefined;
}

export async function purgeOldJobs(db: Db, now: Date): Promise<{ done: number; failed: number }> {
  const before = (days: number) => new Date(now.getTime() - days * 86_400_000);
  return withApp(db, async (tx) => {
    const done = await tx.delete(jobs).where(and(isNotNull(jobs.doneAt), lt(jobs.doneAt, before(DONE_JOBS_KEEP_DAYS)))).returning({ id: jobs.id });
    const failed = await tx.delete(jobs).where(and(isNotNull(jobs.failedAt), lt(jobs.failedAt, before(FAILED_JOBS_KEEP_DAYS)))).returning({ id: jobs.id });
    return { done: done.length, failed: failed.length };
  });
}
