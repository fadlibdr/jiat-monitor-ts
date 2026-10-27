import { eq, sql } from 'drizzle-orm';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { companies, jobs } from '../../src/db/schema.js';
import { withApp, type Db } from '../../src/db/tenant.js';
import {
  claimNext, enqueue, ERROR_TEXT_MAX, errorText, PermanentJobError, runOnce, runWorker, type Job, type Registry,
} from '../../src/jobs/queue.js';
import { asOwner, createTestDb } from '../helpers/db.js';

let db: Db;
let close: () => Promise<void>;
let A = 0;

const ONE_HOUR_MS = 3_600_000;
/** first backoff step under test is 30 s; allow 5 s for the test's own run time */
const FIRST_BACKOFF_MS = 30_000;
const CLOCK_SLACK_MS = 5_000;

/** Pretend time passed: make every pending job due now. */
const makeDue = () => asOwner(db, () => db.execute(sql`UPDATE jobs SET run_at = now() - interval '1 second' WHERE done_at IS NULL AND failed_at IS NULL`));
const jobRow = async (id: number) => (await withApp(db, (tx) => tx.select().from(jobs).where(eq(jobs.id, id))))[0]!;

beforeAll(async () => {
  ({ db, close } = await createTestDb());
  A = await withApp(db, async (tx) => (await tx.insert(companies).values({ code: 'AAA', name: 'PT AAA' }).returning({ id: companies.id }))[0]!.id);
});
beforeEach(async () => { await asOwner(db, () => db.execute(sql`DELETE FROM jobs`)); });
afterAll(async () => { await close(); });

describe('enqueue / claim', () => {
  it('claims the oldest due job first and counts the attempt; a future job is not due', async () => {
    const first = await withApp(db, (tx) => enqueue(tx, { kind: 'k', companyId: A, payload: { n: 1 } }));
    await withApp(db, (tx) => enqueue(tx, { kind: 'k', companyId: A, payload: { n: 2 } }));
    await withApp(db, (tx) => enqueue(tx, { kind: 'k', companyId: A, runAt: new Date(Date.now() + ONE_HOUR_MS) }));
    const j = await claimNext(db, 'w1');
    expect(j).toMatchObject({ id: first, kind: 'k', companyId: A, payload: { n: 1 }, attempts: 1, maxAttempts: 3 });
    expect((await claimNext(db, 'w1'))!.payload).toEqual({ n: 2 });
    expect(await claimNext(db, 'w1')).toBeNull(); // the third is in the future, the first two are locked
  });

  it('a lock younger than 15 minutes is respected; an older one (crashed worker) is taken over', async () => {
    const id = await withApp(db, (tx) => enqueue(tx, { kind: 'k', companyId: A }));
    await claimNext(db, 'crashed');
    expect(await claimNext(db, 'w2')).toBeNull();
    await asOwner(db, () => db.execute(sql`UPDATE jobs SET locked_at = now() - interval '14 minutes 59 seconds' WHERE id = ${id}`));
    expect(await claimNext(db, 'w2')).toBeNull();
    await asOwner(db, () => db.execute(sql`UPDATE jobs SET locked_at = now() - interval '15 minutes 1 second' WHERE id = ${id}`));
    expect(await claimNext(db, 'w2')).toMatchObject({ id, attempts: 2 });
  });

  it('a job without payload gets an empty object', async () => {
    await withApp(db, (tx) => enqueue(tx, { kind: 'k', companyId: A }));
    expect((await claimNext(db, 'w'))!.payload).toEqual({});
  });

  it('a job must state its company (null is allowed only explicitly, for system jobs)', async () => {
    await expect(withApp(db, (tx) => enqueue(tx, { kind: 'k' } as never))).rejects.toThrow(/company_id wajib/);
    expect(await withApp(db, (tx) => enqueue(tx, { kind: 'system', companyId: null }))).toBeGreaterThan(0);
  });
});

describe('runOnce: retry, give up, permanent errors', () => {
  it('retries with the configured backoff, then gives up once and calls onGiveUp exactly once', async () => {
    const seen: number[] = [];
    let gaveUp: Job | null = null;
    const registry: Registry = {
      flaky: { run: async (job) => { seen.push(job.attempts); throw new Error('OCR timeout'); }, backoffSeconds: [30, 120, 600], onGiveUp: async (job) => { gaveUp = job; } },
    };
    const id = await withApp(db, (tx) => enqueue(tx, { kind: 'flaky', companyId: A, maxAttempts: 4 }));
    expect(await runOnce(db, registry, 'w')).toMatchObject({ jobId: id, result: 'retry' });
    const afterFirst = await jobRow(id);
    expect(afterFirst.lastError).toBe('Error: OCR timeout');
    expect(afterFirst.runAt.getTime() - Date.now()).toBeGreaterThan(FIRST_BACKOFF_MS - CLOCK_SLACK_MS);
    expect(await runOnce(db, registry, 'w')).toBeNull(); // not due yet
    for (const expected of ['retry', 'retry', 'failed'] as const) {
      await makeDue();
      expect(await runOnce(db, registry, 'w')).toMatchObject({ result: expected });
    }
    expect(seen).toEqual([1, 2, 3, 4]);
    expect(gaveUp).toMatchObject({ id, attempts: 4 });
    expect((await jobRow(id)).failedAt).not.toBeNull();
    await makeDue();
    expect(await runOnce(db, registry, 'w')).toBeNull();
  });

  it('a PermanentJobError fails at once; an unknown kind fails at once; success marks the job done', async () => {
    const registry: Registry = {
      bad: { run: async () => { throw new PermanentJobError('payload rusak'); } },
      good: { run: async () => {} },
    };
    const bad = await withApp(db, (tx) => enqueue(tx, { kind: 'bad', companyId: A }));
    const unknown = await withApp(db, (tx) => enqueue(tx, { kind: 'nope', companyId: A }));
    const good = await withApp(db, (tx) => enqueue(tx, { kind: 'good', companyId: A }));
    expect((await runOnce(db, registry, 'w'))!).toMatchObject({ jobId: bad, result: 'failed' });
    expect((await runOnce(db, registry, 'w'))!).toMatchObject({ jobId: unknown, result: 'failed' });
    expect((await jobRow(unknown)).lastError).toMatch(/tidak dikenal/);
    expect((await runOnce(db, registry, 'w'))!).toMatchObject({ jobId: good, result: 'done' });
    expect((await jobRow(good)).doneAt).not.toBeNull();
  });

  it('a failing onGiveUp hook is logged, not thrown', async () => {
    const logs: string[] = [];
    const registry: Registry = { x: { run: async () => { throw new PermanentJobError('x'); }, onGiveUp: async () => { throw new Error('telegram down'); } } };
    await withApp(db, (tx) => enqueue(tx, { kind: 'x', companyId: A }));
    expect(await runOnce(db, registry, 'w', (m) => logs.push(m))).toMatchObject({ result: 'failed' });
    expect(logs).toEqual(['job_failed', 'job_give_up_hook_failed']);
  });
});

describe('serial keys (corrections of one chat stay in order)', () => {
  it('jobs without a key, and a single keyed job, are claimed normally', async () => {
    const plain = await withApp(db, (tx) => enqueue(tx, { kind: 'k', companyId: A }));
    const keyed = await withApp(db, (tx) => enqueue(tx, { kind: 'k', companyId: A, serialKey: 'chat:-9' }));
    expect((await claimNext(db, 'w'))!.id).toBe(plain);
    expect((await claimNext(db, 'w'))!.id).toBe(keyed);
  });

  it('a job waits for every earlier open job with the same key, even when it is due first', async () => {
    const order: number[] = [];
    let failFirst = true;
    const registry: Registry = {
      c: {
        run: async (job) => {
          if (job.payload['n'] === 1 && failFirst) { failFirst = false; throw new Error('transient'); }
          order.push(job.payload['n'] as number);
        },
        backoffSeconds: [60],
      },
    };
    await withApp(db, (tx) => enqueue(tx, { kind: 'c', companyId: A, payload: { n: 1 }, serialKey: 'chat:-1' }));
    await withApp(db, (tx) => enqueue(tx, { kind: 'c', companyId: A, payload: { n: 2 }, serialKey: 'chat:-1' }));
    await withApp(db, (tx) => enqueue(tx, { kind: 'c', companyId: A, payload: { n: 3 }, serialKey: 'chat:-2' }));
    expect(await runOnce(db, registry, 'w')).toMatchObject({ result: 'retry' }); // n=1 pushed back 60 s
    expect(await runOnce(db, registry, 'w')).toMatchObject({ result: 'done' }); // n=3: another chat, free to run
    expect(await runOnce(db, registry, 'w')).toBeNull(); // n=2 is due but waits behind n=1
    await makeDue();
    await runOnce(db, registry, 'w');
    await runOnce(db, registry, 'w');
    expect(order).toEqual([3, 1, 2]);
  });
});

describe('runWorker', () => {
  it('drains due jobs and stops when aborted', async () => {
    const done: number[] = [];
    const ac = new AbortController();
    const registry: Registry = { k: { run: async (job) => { done.push(job.payload['n'] as number); if (done.length === 3) ac.abort(); } } };
    for (const n of [1, 2, 3]) await withApp(db, (tx) => enqueue(tx, { kind: 'k', companyId: A, payload: { n } }));
    await runWorker({ db, registry, workerId: 'w', pollMs: 10, signal: ac.signal });
    expect(done).toEqual([1, 2, 3]);
  });
});

describe('errorText', () => {
  it('keeps exactly ERROR_TEXT_MAX characters, cuts one more (with "…"), and handles non-errors and empty text', () => {
    expect(errorText('x'.repeat(ERROR_TEXT_MAX))).toHaveLength(ERROR_TEXT_MAX);
    const cut = errorText('x'.repeat(ERROR_TEXT_MAX + 1));
    expect(cut).toHaveLength(ERROR_TEXT_MAX + 1);
    expect(cut.endsWith('…')).toBe(true);
    expect(errorText(new Error('boom'))).toBe('Error: boom');
    expect(errorText('')).toBe('');
    expect(errorText(null)).toBe('null');
  });

  it('reports the innermost cause (the database reason), not the wrapper with SQL and parameters', () => {
    const pg = new Error('value too long for type character varying(100)');
    const wrapped = new Error('Failed query: insert into "vendor_invoices" … params: 12345,secret', { cause: pg });
    expect(errorText(wrapped)).toBe('Error: value too long for type character varying(100)');
  });
});
