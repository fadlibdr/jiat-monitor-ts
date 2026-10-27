import { and, eq, sql } from 'drizzle-orm';
import { jobs } from '../db/schema.js';
import { withApp, type Db, type Tx } from '../db/tenant.js';

/**
 * Background jobs on Postgres (LLD §9 "queue database"; Redis only if the queue backs up > 1 min).
 * At-least-once: a handler may run again after a crash, so every handler is idempotent (the intake
 * handlers key on intake_events). `FOR UPDATE SKIP LOCKED` lets several workers share the table.
 */
export interface JobSpec {
  kind: string;
  /** required, possibly null for system-wide jobs: a tenant job without its company is refused (LLD §3) */
  companyId: number | null;
  payload?: Record<string, unknown>;
  runAt?: Date;
  maxAttempts?: number;
  /** jobs sharing a key never overtake each other, even after a retry moved run_at */
  serialKey?: string;
}

export interface Job {
  id: number;
  kind: string;
  companyId: number | null;
  payload: Record<string, unknown>;
  attempts: number;
  maxAttempts: number;
}

/** Thrown by a handler when retrying cannot help (bad payload, row gone): the job fails at once. */
export class PermanentJobError extends Error {
  override readonly name = 'PermanentJobError';
}

export interface HandlerSpec {
  run: (job: Job) => Promise<void>;
  /** delay before attempt n+1, seconds; the last value repeats. Default 30 s. */
  backoffSeconds?: readonly number[];
  /** called once when the job fails for good (LLD §9 "gagal permanen" column) */
  onGiveUp?: (job: Job, error: unknown) => Promise<void>;
}
export type Registry = Record<string, HandlerSpec>;

/** A lock older than this belongs to a crashed worker and may be taken over. */
const STALE_LOCK = sql`interval '15 minutes'`;

export async function enqueue(tx: Tx, spec: JobSpec): Promise<number> {
  if (spec.companyId === undefined) throw new Error(`job ${spec.kind}: company_id wajib (null untuk job sistem).`);
  const [row] = await tx.insert(jobs).values({
    kind: spec.kind,
    companyId: spec.companyId,
    payload: spec.payload ?? {},
    ...(spec.runAt ? { runAt: spec.runAt } : {}),
    ...(spec.maxAttempts ? { maxAttempts: spec.maxAttempts } : {}),
    ...(spec.serialKey ? { serialKey: spec.serialKey } : {}),
  }).returning({ id: jobs.id });
  return row!.id;
}

/** Enqueues unless a job with this dedupe key already exists (done, failed or pending). True when inserted. */
export async function enqueueOnce(tx: Tx, spec: JobSpec & { dedupeKey: string }): Promise<boolean> {
  if (spec.companyId === undefined) throw new Error(`job ${spec.kind}: company_id wajib (null untuk job sistem).`);
  const rows = await tx.insert(jobs).values({
    kind: spec.kind,
    companyId: spec.companyId,
    payload: spec.payload ?? {},
    dedupeKey: spec.dedupeKey,
    ...(spec.runAt ? { runAt: spec.runAt } : {}),
    ...(spec.maxAttempts ? { maxAttempts: spec.maxAttempts } : {}),
  }).onConflictDoNothing({ target: jobs.dedupeKey }).returning({ id: jobs.id });
  return rows.length > 0;
}

/** Takes the oldest due job, or null. Increments attempts as part of the claim. */
export async function claimNext(db: Db, workerId: string): Promise<Job | null> {
  const [row] = await withApp(db, (tx) =>
    tx.update(jobs)
      .set({ lockedAt: sql`now()`, lockedBy: workerId, attempts: sql`${jobs.attempts} + 1`, updatedAt: sql`now()` })
      .where(sql`${jobs.id} = (
        SELECT id FROM jobs
        WHERE done_at IS NULL AND failed_at IS NULL AND run_at <= now()
          AND (locked_at IS NULL OR locked_at < now() - ${STALE_LOCK})
          AND (serial_key IS NULL OR NOT EXISTS (
            SELECT 1 FROM jobs e
            WHERE e.serial_key = jobs.serial_key AND e.id < jobs.id AND e.done_at IS NULL AND e.failed_at IS NULL))
        ORDER BY run_at, id
        FOR UPDATE SKIP LOCKED
        LIMIT 1)`)
      .returning());
  if (!row) return null;
  return {
    id: row.id, kind: row.kind, companyId: row.companyId, payload: (row.payload ?? {}) as Record<string, unknown>,
    attempts: row.attempts, maxAttempts: row.maxAttempts,
  };
}

export async function completeJob(db: Db, job: Job, workerId: string): Promise<void> {
  await withApp(db, (tx) => tx.update(jobs)
    .set({ doneAt: sql`now()`, lockedAt: null, lockedBy: null, lastError: null, updatedAt: sql`now()` })
    .where(and(eq(jobs.id, job.id), eq(jobs.lockedBy, workerId))));
}

/** Schedules the next attempt, or fails the job for good. Returns which. */
export async function failJob(db: Db, job: Job, workerId: string, error: unknown, spec?: HandlerSpec): Promise<'retry' | 'failed'> {
  const message = errorText(error);
  const permanent = error instanceof PermanentJobError || job.attempts >= job.maxAttempts;
  if (permanent) {
    await withApp(db, (tx) => tx.update(jobs)
      .set({ failedAt: sql`now()`, lockedAt: null, lockedBy: null, lastError: message, updatedAt: sql`now()` })
      .where(and(eq(jobs.id, job.id), eq(jobs.lockedBy, workerId))));
    return 'failed';
  }
  const backoff = spec?.backoffSeconds?.length ? spec.backoffSeconds : [30];
  const delay = backoff[Math.min(job.attempts - 1, backoff.length - 1)]!;
  await withApp(db, (tx) => tx.update(jobs)
    .set({ runAt: sql`now() + make_interval(secs => ${delay})`, lockedAt: null, lockedBy: null, lastError: message, updatedAt: sql`now()` })
    .where(and(eq(jobs.id, job.id), eq(jobs.lockedBy, workerId))));
  return 'retry';
}

export interface RunResult { jobId: number; kind: string; result: 'done' | 'retry' | 'failed' }

/** Claims and runs one job. Null when nothing is due. */
export async function runOnce(db: Db, registry: Registry, workerId: string, log: (msg: string, meta: object) => void = () => {}): Promise<RunResult | null> {
  const job = await claimNext(db, workerId);
  if (!job) return null;
  const spec = registry[job.kind];
  let ran = false;
  try {
    if (!spec) throw new PermanentJobError(`jenis job tidak dikenal: ${job.kind}`);
    await spec.run(job);
    ran = true;
  } catch (e) {
    const result = await failJob(db, job, workerId, e, spec);
    log('job_failed', { jobId: job.id, kind: job.kind, companyId: job.companyId, attempt: job.attempts, result, error: errorText(e) });
    if (result === 'failed' && spec?.onGiveUp) {
      try {
        await spec.onGiveUp(job, e);
      } catch (hookError) {
        log('job_give_up_hook_failed', { jobId: job.id, kind: job.kind, error: errorText(hookError) });
      }
    }
    return { jobId: job.id, kind: job.kind, result };
  }
  // outside the try: if marking it done fails (database blip), the work is NOT a failure — the job
  // stays locked, is taken over after the stale-lock timeout and re-runs idempotently
  if (ran) await completeJob(db, job, workerId);
  return { jobId: job.id, kind: job.kind, result: 'done' };
}

export interface WorkerOptions {
  db: Db;
  registry: Registry;
  workerId: string;
  pollMs?: number;
  signal: AbortSignal;
  log?: (msg: string, meta: object) => void;
}

/** Runs jobs until `signal` aborts; sleeps `pollMs` when the queue is empty. */
export async function runWorker({ db, registry, workerId, pollMs = 1000, signal, log = () => {} }: WorkerOptions): Promise<void> {
  while (!signal.aborted) {
    let ran: RunResult | null = null;
    try {
      ran = await runOnce(db, registry, workerId, log);
    } catch (e) {
      log('worker_loop_error', { error: errorText(e) }); // e.g. database briefly unreachable
    }
    if (!ran) await sleep(pollMs, signal);
  }
}

function sleep(ms: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve) => {
    const t = setTimeout(resolve, ms);
    signal.addEventListener('abort', () => { clearTimeout(t); resolve(); }, { once: true });
  });
}

/** Longest error text kept in jobs.last_error / logs before it is cut (plus "…"). */
export const ERROR_TEXT_MAX = 1000;

/**
 * Error text for jobs.last_error and logs: name + message, bounded. Query wrappers (Drizzle) put the
 * SQL and its bound parameters in their own message and the database's reason in `cause`: the
 * innermost cause is reported instead, so the log says *why* (e.g. "value too long …") and does
 * not copy parameter values (row data) into logs.
 */
export function errorText(e: unknown): string {
  const innermost = (x: unknown) => {
    let root: unknown = x;
    for (let depth = 0; depth < 5 && root instanceof Error && root.cause instanceof Error; depth++) root = root.cause;
    return root instanceof Error ? `${root.name}: ${root.message}` : String(root);
  };
  // AggregateError (several companies failed): its own message says how many, the entries say why
  const s = e instanceof AggregateError
    ? `${e.name}: ${e.message} [${e.errors.map((x) => `${x instanceof Error ? x.message : String(x)}: ${innermost(x)}`).join('; ')}]`
    : innermost(e);
  return s.length > ERROR_TEXT_MAX ? `${s.slice(0, ERROR_TEXT_MAX)}…` : s;
}
