/**
 * Background worker (LLD §9): runs queued jobs — the Telegram intake (photo + correction) and the
 * scheduled jobs (dashboard refresh every HOLDING_MV_REFRESH_MINUTES, DailyDigest 07:00 WIB, purge
 * 02:00 WIB). A separate process from the API, kept alive by the process manager on the VPS; several
 * workers may run: the queue hands each job to one (FOR UPDATE SKIP LOCKED) and each scheduled slot
 * is enqueued once (jobs.dedupe_key).
 *
 *   npm run worker
 */
import { hostname } from 'node:os';
import { z } from 'zod';
import { createDb, DatabaseUnavailable } from './db/client.js';
import { OpenAiCompatibleOcr } from './intake/ocr.js';
import { intakeRegistry } from './intake/pipeline.js';
import { LocalDiskStorage } from './intake/storage.js';
import { TelegramBotApi } from './intake/telegram-api.js';
import { runWorker, type Registry } from './jobs/queue.js';
import { runScheduler } from './jobs/schedule.js';
import { opsRegistry, opsSchedules } from './ops/registry.js';

const Env = z.object({
  DATABASE_URL: z.string().min(1, 'DATABASE_URL harus diisi (lihat .env.example).'),
  TELEGRAM_BOT_TOKEN: z.string().min(1, 'TELEGRAM_BOT_TOKEN harus diisi.'),
  OCR_BASE_URL: z.url({ message: 'OCR_BASE_URL harus URL endpoint OpenAI-compatible (…/v1).' }),
  OCR_API_KEY: z.string().min(1, 'OCR_API_KEY harus diisi.'),
  OCR_MODEL_STAGE1: z.string().min(1),
  OCR_MODEL_STAGE2: z.string().min(1),
  STORAGE_DIR: z.string().min(1, 'STORAGE_DIR harus diisi (folder foto asli).'),
  INTAKE_QUALITY_MIN: z.coerce.number().min(0).max(1).default(0.45),
  INTAKE_TOTAL_CONFIDENCE_MIN: z.coerce.number().min(0).max(1).default(0.7),
  INTAKE_MAX_PHOTO_MB: z.coerce.number().positive().max(20).default(10),
  WORKER_POLL_MS: z.coerce.number().int().min(100).default(1000),
  HOLDING_MV_REFRESH_MINUTES: z.coerce.number().int().min(1).max(1440).default(15),
  DAILY_DIGEST: z.enum(['0', '1']).default('1'),
});

/** One JSON object per line, with company/chat/message ids and never photo bytes or account numbers (LLD §9). */
function log(msg: string, meta: object = {}): void {
  console.log(JSON.stringify({ time: new Date().toISOString(), level: msg.endsWith('failed') ? 'error' : 'info', msg, ...meta }));
}

async function main(): Promise<void> {
  const env = Env.parse(process.env);
  const { db, ping, close } = createDb(env.DATABASE_URL);
  await ping();

  const telegram = new TelegramBotApi(env.TELEGRAM_BOT_TOKEN);
  const storage = new LocalDiskStorage(env.STORAGE_DIR);
  const now = () => new Date();
  const digest = env.DAILY_DIGEST === '1';
  const registry: Registry = {
    ...intakeRegistry({
      db,
      telegram,
      storage,
      ocr: new OpenAiCompatibleOcr({ baseUrl: env.OCR_BASE_URL, apiKey: env.OCR_API_KEY, modelStage1: env.OCR_MODEL_STAGE1, modelStage2: env.OCR_MODEL_STAGE2 }),
      now,
      config: { qualityMin: env.INTAKE_QUALITY_MIN, totalConfidenceMin: env.INTAKE_TOTAL_CONFIDENCE_MIN, maxPhotoBytes: env.INTAKE_MAX_PHOTO_MB * 1024 * 1024 },
      log,
    }),
    ...opsRegistry({ db, storage, telegram: digest ? telegram : undefined, now, log }),
  };
  const schedules = opsSchedules({ refreshMinutes: env.HOLDING_MV_REFRESH_MINUTES, digest });

  const ac = new AbortController();
  for (const sig of ['SIGINT', 'SIGTERM'] as const) process.on(sig, () => { log('worker_stopping', { signal: sig }); ac.abort(); });
  const workerId = `${hostname()}:${process.pid}`;
  log('worker_started', { workerId, kinds: Object.keys(registry), schedules: schedules.map((s) => s.kind) });
  try {
    await Promise.all([
      runWorker({ db, registry, workerId, pollMs: env.WORKER_POLL_MS, signal: ac.signal, log }),
      runScheduler({ db, schedules, now, signal: ac.signal, log }),
    ]);
  } finally {
    await close();
  }
}

main().catch((e: unknown) => {
  if (e instanceof z.ZodError) console.error('Konfigurasi env tidak valid:', e.issues.map((i) => `${i.path.join('.')}: ${i.message}`).join('; '));
  else if (e instanceof DatabaseUnavailable) console.error(`${e.name}: ${e.message}`);
  else console.error(e instanceof Error ? `${e.name}: ${e.message}` : String(e));
  process.exit(1);
});
