import { withApp, type Db } from '../db/tenant.js';
import { WIB_OFFSET_MS, wibDate } from '../domain/date.js';
import { enqueueOnce } from './queue.js';

/**
 * Scheduled jobs (LLD §9 "Job terjadwal"). Every worker ticks once a minute and enqueues the CURRENT
 * slot of each schedule under a dedupe key, so a slot runs once however many workers tick, and a
 * worker that was down catches up on the day's slot when it starts (daily jobs) or on the next slot
 * (interval jobs). The queue then runs, retries and logs them like any other job.
 */
export type Schedule =
  | { kind: string; everyMinutes: number; maxAttempts?: number }
  /** "HH:MM" in WIB (UTC+7, no daylight saving) */
  | { kind: string; dailyAtWib: string; maxAttempts?: number };

const MINUTE = 60_000;

export { wibDate };

/** The slot `now` falls in (its dedupe key), or null while a daily job's time has not come today. */
export function currentSlot(s: Schedule, now: Date): string | null {
  if ('everyMinutes' in s) {
    if (!Number.isInteger(s.everyMinutes) || s.everyMinutes < 1) throw new RangeError(`${s.kind}: everyMinutes harus bilangan bulat ≥ 1`);
    const size = s.everyMinutes * MINUTE;
    return `${s.kind}@${new Date(Math.floor(now.getTime() / size) * size).toISOString()}`;
  }
  const m = /^([01]\d|2[0-3]):([0-5]\d)$/.exec(s.dailyAtWib);
  if (!m) throw new RangeError(`${s.kind}: dailyAtWib harus "HH:MM"`);
  const wib = new Date(now.getTime() + WIB_OFFSET_MS);
  const minutesNow = wib.getUTCHours() * 60 + wib.getUTCMinutes();
  if (minutesNow < Number(m[1]) * 60 + Number(m[2])) return null;
  return `${s.kind}@${wib.toISOString().slice(0, 10)}`;
}

/** Ticks at the start of every minute until `signal` aborts; a failed tick (database down) is logged and retried next minute. */
export async function runScheduler(opts: {
  db: Db; schedules: readonly Schedule[]; now: () => Date; signal: AbortSignal; log: (msg: string, meta: object) => void;
}): Promise<void> {
  while (!opts.signal.aborted) {
    try {
      const keys = await enqueueDue(opts.db, opts.schedules, opts.now());
      if (keys.length) opts.log('schedule_enqueued', { keys });
    } catch (e) {
      opts.log('schedule_tick_failed', { error: e instanceof Error ? `${e.name}: ${e.message}` : String(e) });
    }
    const wait = MINUTE - (opts.now().getTime() % MINUTE) + 50;
    await new Promise<void>((resolve) => {
      const t = setTimeout(resolve, wait);
      opts.signal.addEventListener('abort', () => { clearTimeout(t); resolve(); }, { once: true });
    });
  }
}

/** Enqueues every schedule's current slot that is not queued yet. Returns the keys it inserted. */
export async function enqueueDue(db: Db, schedules: readonly Schedule[], now: Date): Promise<string[]> {
  const inserted: string[] = [];
  for (const s of schedules) {
    const key = currentSlot(s, now);
    if (!key) continue;
    const fresh = await withApp(db, (tx) => enqueueOnce(tx, {
      kind: s.kind, companyId: null, dedupeKey: key, payload: { slot: key, at: now.toISOString() }, ...(s.maxAttempts ? { maxAttempts: s.maxAttempts } : {}),
    }));
    if (fresh) inserted.push(key);
  }
  return inserted;
}
