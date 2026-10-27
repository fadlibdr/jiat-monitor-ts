import { refreshAll } from '../dashboard/snapshot.js';
import type { Db } from '../db/tenant.js';
import type { ObjectStorage } from '../intake/storage.js';
import type { TelegramApi } from '../intake/telegram-api.js';
import { PermanentJobError, type Registry } from '../jobs/queue.js';
import type { Schedule } from '../jobs/schedule.js';
import { sendAllDigests } from './digest.js';
import { purgeOldJobs, purgeOrphanPhotos } from './purge.js';
import { JOB_TELEGRAM_SEND } from './telegram-link.js';

/**
 * Scheduled jobs of LLD §9 other than the intake. BackupDatabase is NOT here on purpose: pg_dump
 * must read every company's rows, which the worker's RLS-bound role cannot (and should not) do; it
 * runs from the host's cron with its own credentials (scripts/backup-db.sh, README "Operasional").
 */
export const JOB_DASHBOARD_REFRESH = 'dashboard.refresh';
export const JOB_DAILY_DIGEST = 'ops.daily_digest';
export const JOB_PURGE = 'ops.purge';

export function opsSchedules(cfg: { refreshMinutes: number; digest: boolean }): Schedule[] {
  return [
    // a failed refresh is superseded by the next slot: one retry is enough
    { kind: JOB_DASHBOARD_REFRESH, everyMinutes: cfg.refreshMinutes, maxAttempts: 2 },
    ...(cfg.digest ? [{ kind: JOB_DAILY_DIGEST, dailyAtWib: '07:00', maxAttempts: 3 }] : []),
    { kind: JOB_PURGE, dailyAtWib: '02:00', maxAttempts: 2 },
  ];
}

export interface OpsDeps {
  db: Db;
  storage: ObjectStorage;
  telegram: TelegramApi;
  /** DAILY_DIGEST=1 */
  digest: boolean;
  now: () => Date;
  log: (msg: string, meta: object) => void;
}

export function opsRegistry(deps: OpsDeps): Registry {
  const telegram = deps.telegram;
  const registry: Registry = {
    // replies queued by the API, which holds no bot token (e.g. the answer to "/start <code>")
    [JOB_TELEGRAM_SEND]: {
      run: async (job) => {
        const { chatId, text } = job.payload as { chatId?: unknown; text?: unknown };
        if (typeof chatId !== 'number' || typeof text !== 'string') throw new PermanentJobError('telegram.send: payload tidak valid');
        await telegram.sendMessage(chatId, text);
      },
      backoffSeconds: [30, 300],
    },
    [JOB_DASHBOARD_REFRESH]: {
      run: async () => { deps.log('dashboard_refreshed', await refreshAll(deps.db, deps.now())); },
      backoffSeconds: [60],
    },
    [JOB_PURGE]: {
      run: async () => {
        const photos = await purgeOrphanPhotos(deps, deps.now());
        const jobs = await purgeOldJobs(deps.db, deps.now());
        deps.log('purge_done', { photos, jobs });
      },
      backoffSeconds: [600],
    },
  };
  if (deps.digest) {
    registry[JOB_DAILY_DIGEST] = {
      run: async () => { deps.log('digest_done', await sendAllDigests({ db: deps.db, telegram, log: deps.log }, deps.now())); },
      backoffSeconds: [300, 900],
    };
  }
  return registry;
}
