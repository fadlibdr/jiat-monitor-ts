import { and, desc, eq, gte, inArray, isNotNull, sql } from 'drizzle-orm';
import { ZodError } from 'zod';
import { categoryFromDescription } from '../domain/categories.js';
import { parseCorrection, type Correction } from '../domain/correction.js';
import { hammingDistance, NEAR_DUPLICATE_MAX_DISTANCE } from '../domain/hamming.js';
import { checkStage1, validateReceipt, type ValidatorOptions } from '../domain/receipt-validator.js';
import {
  attachments, companyUsers, intakeEvents, sites, users, vendorInvoices,
  type IntakeOutcome, type IntakeReview, type VendorInvoiceStatus,
} from '../db/schema.js';
import { siteScopeFor, withApp, withCompany, type Db } from '../db/tenant.js';
import { PermanentJobError, type Job, type Registry } from '../jobs/queue.js';
import { perceptualHash, sha256Hex } from './hash.js';
import { OcrParseError, type OcrClient } from './ocr.js';
import {
  correctionReply, duplicateReply, REPLY, summaryReply, type ReplyRow,
} from './replies.js';
import { applyChanges, recomputeFlags, statusFor, type ApplyResult, type Change } from './review.js';
import { intakeKey, type ObjectStorage } from './storage.js';
import type { TelegramApi } from './telegram-api.js';
import { matchVendor } from './vendors.js';

/**
 * The Telegram → OCR → row pipeline (LLD §5–7), run by the worker. Every handler is idempotent on
 * its intake_events row: a re-run after a crash or a Telegram re-delivery finds the outcome already
 * final and does nothing.
 *
 * Order (HLD §5): sha256 duplicate check BEFORE OCR (costs nothing), stage 1 rejects fast, stage 2
 * reads, validation V1–V10, then row + attachment + event in one transaction, reply after commit.
 */
export const JOB_PHOTO = 'intake.photo';
export const JOB_CORRECTION = 'intake.correction';
/** LLD §9: photo 3 retries at 30/120/600 s; correction 2 retries. */
export const PHOTO_MAX_ATTEMPTS = 4;
export const CORRECTION_MAX_ATTEMPTS = 3;
export const NEAR_DUPLICATE_WINDOW_DAYS = 90;

export interface IntakeConfig extends ValidatorOptions {
  maxPhotoBytes: number;
}
export interface IntakeDeps {
  db: Db;
  telegram: TelegramApi;
  storage: ObjectStorage;
  ocr: OcrClient;
  now: () => Date;
  config: IntakeConfig;
  log: (msg: string, meta: object) => void;
}

const FINAL_PHOTO: readonly IntakeOutcome[] = ['tersimpan', 'tersimpan_tanpa_balasan', 'duplikat', 'tidak_terbaca', 'gagal'];
const FINAL_CORRECTION: readonly IntakeOutcome[] = ['koreksi_ok', 'koreksi_ditolak', 'diabaikan', 'gagal'];

type EventRow = typeof intakeEvents.$inferSelect;

export function intakeRegistry(deps: IntakeDeps): Registry {
  return {
    [JOB_PHOTO]: {
      run: (job) => processPhoto(deps, job),
      backoffSeconds: [30, 120, 600],
      onGiveUp: async (job, error) => {
        const ev = await giveUp(deps, job, FINAL_PHOTO, REPLY.failure, error);
        deps.log('intake_photo_failed', { companyId: job.companyId, chatId: ev?.chatId, messageId: ev?.messageId });
      },
    },
    [JOB_CORRECTION]: {
      run: (job) => processCorrection(deps, job),
      backoffSeconds: [10, 60],
      onGiveUp: async (job, error) => { await giveUp(deps, job, FINAL_CORRECTION, REPLY.correctionFailed, error); },
    },
  };
}

// ---------------------------------------------------------------------------------------------

export async function processPhoto(deps: IntakeDeps, job: Job): Promise<void> {
  const { db, telegram, storage, ocr, config } = deps;
  const ev = await loadEvent(deps, job);
  if (FINAL_PHOTO.includes(ev.outcome)) return;
  const companyId = ev.companyId;
  const { fileId, mime } = ev.payload as { fileId: string; mime: string };

  const file = await telegram.getFile(fileId);
  if (file.fileSize !== null && file.fileSize > config.maxPhotoBytes) {
    await finish(deps, job, 'tidak_terbaca', 'Foto terlalu besar. Kirim sebagai foto biasa (bukan file).');
    return;
  }
  const bytes = await telegram.downloadFile(file.filePath, config.maxPhotoBytes);
  const sha256 = sha256Hex(bytes);

  // V8 — exact duplicate, before paying for OCR
  const dup = await findBySha(deps, companyId, sha256);
  if (dup !== undefined) {
    await finish(deps, job, 'duplikat', duplicateReply(dup));
    return;
  }

  const image = { bytes, mime };
  const unreadable = (message?: string) => finish(deps, job, 'tidak_terbaca', message ?? 'Foto tidak terbaca. Mohon kirim ulang foto yang lebih jelas.');

  // stage 1 — V1 stops here without stage 2 and without keeping the hash (LLD §5)
  const s1 = await ocrCall(deps, job, () => ocr.classify(image));
  if (s1 === UNREADABLE) return void (await unreadable());
  const c1 = safe(() => checkStage1(s1, config));
  if (!c1 || !c1.ok) return void (await unreadable(c1 && !c1.ok ? c1.message : undefined));

  // stage 2 — V2–V7
  const s2 = await ocrCall(deps, job, () => ocr.extract(image));
  if (s2 === UNREADABLE) return void (await unreadable());
  const site = await withCompany(db, companyId, (tx) => tx.query.sites.findFirst({ where: eq(sites.id, ev.siteId) }));
  const siteStart = site?.startDate ? new Date(`${site.startDate}T00:00:00Z`) : null;
  const today = deps.now();
  const v = safe(() => validateReceipt(s1, s2, siteStart, today, config));
  if (!v) return void (await unreadable());
  if (v.decision === 'reject') return void (await unreadable(v.message));

  let phash: string;
  try {
    phash = await perceptualHash(bytes);
  } catch {
    return void (await unreadable());
  }

  // V9 — near-duplicates at the same site in the last 90 days; V10 — vendor; category fallback
  const { nearDuplicates, vendor } = await withCompany(db, companyId, async (tx) => {
    const since = new Date(today.getTime() - NEAR_DUPLICATE_WINDOW_DAYS * 86_400_000);
    const recent = await tx.select({ phash: attachments.phash, rowId: vendorInvoices.rowId })
      .from(attachments)
      .innerJoin(vendorInvoices, and(eq(attachments.attachableType, 'vendor_invoices'), eq(vendorInvoices.id, attachments.attachableId)))
      .where(and(eq(attachments.siteId, ev.siteId), gte(attachments.createdAt, since), isNotNull(attachments.phash)));
    const near = recent
      .map((r) => ({ rowId: r.rowId, distance: hammingDistance(phash, r.phash!) }))
      .filter((r) => r.distance <= NEAR_DUPLICATE_MAX_DISTANCE)
      .sort((a, b) => a.distance - b.distance);
    return { nearDuplicates: near, vendor: v.fields.vendorName ? await matchVendor(tx, v.fields.vendorName) : null };
  });

  const category = vendor?.defaultCategory ?? categoryFromDescription(v.fields.description);
  const row = {
    vendorId: vendor?.id ?? null,
    vendorName: v.fields.vendorName,
    invoiceDate: v.fields.invoiceDate,
    category,
    dppCents: v.fields.subtotalCents,
    ppnCents: v.fields.ppnCents,
    totalCents: v.totalCents,
  };
  // the validator's V4/V6 flags and V9 carry over; V3/V5/V7/category are re-derived by the same
  // function corrections use, so a row's flags never depend on which path last touched it
  const flags = recomputeFlags(row, [...v.flags, ...(nearDuplicates.length ? ['near_duplicate'] : [])], siteStart, today);
  const review: IntakeReview = {
    fields: v.fields.confidence,
    flags,
    missing: v.missing,
    nearDuplicates,
    extracted: { subtotalCents: v.fields.subtotalCents, ppnCents: v.fields.ppnCents, itemsCents: v.fields.itemsCents },
  };

  // original photo stored before the transaction; removed again if the transaction fails (LLD §9)
  const key = intakeKey(companyId, sha256, mime, today);
  await storage.put(key, bytes, mime);
  let saved: { rowId: string; status: VendorInvoiceStatus };
  try {
    saved = await withCompany(db, companyId, async (tx) => {
      const [inv] = await tx.insert(vendorInvoices).values({
        companyId, siteId: ev.siteId, ...row, npwp: v.npwp, docNumber: v.fields.docNumber, description: v.fields.description,
        status: statusFor(flags), source: 'telegram', imageHash: sha256, phash, confidence: review,
      }).returning({ id: vendorInvoices.id, rowId: vendorInvoices.rowId, status: vendorInvoices.status });
      await tx.insert(attachments).values({
        companyId, siteId: ev.siteId, attachableType: 'vendor_invoices', attachableId: inv!.id, path: key, mime, size: bytes.length,
        sha256, phash, telegramFileId: fileId, telegramMessageId: ev.messageId,
      });
      await tx.update(intakeEvents).set({ outcome: 'tersimpan', vendorInvoiceId: inv!.id, error: null, updatedAt: new Date() }).where(eq(intakeEvents.id, ev.id));
      return { rowId: inv!.rowId, status: inv!.status };
    });
  } catch (e) {
    const code = pgCode(e);
    if (code === '23505') {
      // the same photo was saved by a concurrent job between our V8 check and now: keep its file
      await finish(deps, job, 'duplikat', duplicateReply((await findBySha(deps, companyId, sha256)) ?? null));
      return;
    }
    // the key is content-addressed, so the file may belong to a committed row (an unknown COMMIT
    // outcome, or another event with the same bytes): delete it only when no attachment points at it
    try {
      if ((await findBySha(deps, companyId, sha256)) === undefined) await storage.delete(key);
    } catch {
      // database unreachable: an orphan file is harmless, deleting a committed original is not
    }
    // data errors (22xxx) and constraint errors (23xxx) repeat identically on every attempt: retrying
    // would only pay for OCR again, so fail now (onGiveUp asks staff to resend)
    if (code?.startsWith('22') || code?.startsWith('23')) throw new PermanentJobError(`data ditolak database (${code})`);
    throw e;
  }

  const reply = summaryReply({ rowId: saved.rowId, ...row, status: saved.status, flags });
  await replyAfterCommit(deps, ev, reply, 'tersimpan_tanpa_balasan');
}

// ---------------------------------------------------------------------------------------------

export async function processCorrection(deps: IntakeDeps, job: Job): Promise<void> {
  const { db } = deps;
  const ev = await loadEvent(deps, job);
  if (FINAL_CORRECTION.includes(ev.outcome)) return;
  const { text, replyToMessageId, replyToBot } = ev.payload as { text: string; replyToMessageId: number | null; replyToBot: boolean };
  const corr = parseCorrection(text, replyToBot);
  if (!corr) return void (await setOutcome(deps, ev, 'diabaikan'));

  // LLD §7: a sender who is not a member with access to this site is ignored, silently
  const sender = await resolveSender(deps, ev);
  if (!sender) return void (await setOutcome(deps, ev, 'diabaikan'));

  const rowId = await resolveRow(deps, ev, corr, replyToMessageId);
  if (!rowId) {
    // "#xxxx" typed on purpose deserves an answer; a reply to some other message (another bot's,
    // or a summary older than our records) is not addressed to us — stay quiet (LLD §7)
    if (corr.rowRef) return void (await finish(deps, job, 'koreksi_ditolak', REPLY.ambiguousRef));
    return void (await setOutcome(deps, ev, 'diabaikan'));
  }
  if ('error' in corr) return void (await finish(deps, job, 'koreksi_ditolak', REPLY.valueError(corr.error)));

  const change = toChange(corr);
  const ctx = { companyId: ev.companyId, userId: sender.userId, siteIds: sender.siteIds };
  const result: ApplyResult = await withCompany(db, ctx, async (tx) => {
    const r = await applyChanges(tx, rowId, [change], { channel: 'chat', userId: sender.userId, today: deps.now() });
    await tx.execute(sql`SELECT jiat_audit_event(${ev.companyId}, ${sender.userId}, 'chat_correction', 'vendor_invoices',
      ${r.row?.id ?? null}, ${JSON.stringify({ chatId: ev.chatId, messageId: ev.messageId, command: corr.command, ok: r.ok })}::jsonb, NULL)`);
    await tx.update(intakeEvents).set({
      outcome: r.ok ? 'koreksi_ok' : 'koreksi_ditolak', vendorInvoiceId: r.row?.id ?? null, updatedAt: new Date(),
    }).where(eq(intakeEvents.id, ev.id));
    return r;
  });

  let reply: string;
  if (result.ok) reply = correctionReply(toReplyRow(result.row), corr.command.toUpperCase());
  else if (result.reason === 'closed') reply = REPLY.alreadyConfirmed;
  else if (result.reason === 'confirm_blocked') reply = REPLY.confirmBlocked(result.flags ?? []);
  else if (result.reason === 'duplicate_confirmed') reply = REPLY.duplicateConfirmed;
  else reply = REPLY.ambiguousRef;
  await replyAfterCommit(deps, ev, reply, null);
}

function toChange(corr: Exclude<Correction, { error: string }>): Change {
  switch (corr.command) {
    case 'kategori': return { field: 'category', value: corr.value };
    case 'total': return { field: 'totalCents', value: corr.value };
    case 'vendor': return { field: 'vendorName', value: corr.value };
    case 'tanggal': return { field: 'invoiceDate', value: corr.value };
    case 'nomor': return { field: 'docNumber', value: corr.value };
    case 'ok': return { field: 'status', value: 'terkonfirmasi' };
    case 'tolak': return { field: 'status', value: 'ditolak' };
  }
}

/** Telegram user → member of the chat's company with access to the chat's site, or null. */
async function resolveSender(deps: IntakeDeps, ev: EventRow): Promise<{ userId: number; siteIds: number[] | null } | null> {
  if (ev.fromUserId === null) return null;
  return withApp(deps.db, async (tx) => {
    const [m] = await tx.select({ userId: users.id, role: companyUsers.role, siteIds: companyUsers.siteIds, isActive: users.isActive })
      .from(users).innerJoin(companyUsers, eq(companyUsers.userId, users.id))
      .where(and(eq(users.telegramUserId, ev.fromUserId!), eq(companyUsers.companyId, ev.companyId)));
    if (!m || !m.isActive) return null;
    const scope = siteScopeFor(m.role, m.siteIds);
    if (scope !== null && !scope.includes(ev.siteId)) return null;
    return { userId: m.userId, siteIds: scope };
  });
}

/** A "#xxxx" also finds rows closed this recently, so staff get "sudah dikonfirmasi" rather than "not found". */
const CLOSED_REF_WINDOW_DAYS = 30;

/**
 * Reply to a bot summary → that summary's row. Else "#xxxx" → the one row at this site ending in
 * xxxx: open rows first, then rows closed in the last 30 days (4 hex digits collide across years).
 */
async function resolveRow(deps: IntakeDeps, ev: EventRow, corr: Correction, replyToMessageId: number | null): Promise<string | null> {
  return withCompany(deps.db, ev.companyId, async (tx) => {
    if (replyToMessageId !== null) {
      const [src] = await tx.select({ rowId: vendorInvoices.rowId })
        .from(intakeEvents).innerJoin(vendorInvoices, eq(vendorInvoices.id, intakeEvents.vendorInvoiceId))
        .where(and(eq(intakeEvents.chatId, ev.chatId), eq(intakeEvents.replyMessageId, replyToMessageId)))
        .orderBy(desc(intakeEvents.id)).limit(1);
      if (src) return src.rowId;
    }
    if (corr.rowRef) {
      const byRef = sql`right(replace(${vendorInvoices.rowId}::text, '-', ''), 4) = ${corr.rowRef}`;
      const open = await tx.select({ rowId: vendorInvoices.rowId }).from(vendorInvoices).where(and(
        eq(vendorInvoices.siteId, ev.siteId), inArray(vendorInvoices.status, ['perlu_konfirmasi', 'perlu_cek']), byRef,
      )).limit(2);
      if (open.length) return open.length === 1 ? open[0]!.rowId : null;
      const since = new Date(deps.now().getTime() - CLOSED_REF_WINDOW_DAYS * 86_400_000);
      const closed = await tx.select({ rowId: vendorInvoices.rowId }).from(vendorInvoices).where(and(
        eq(vendorInvoices.siteId, ev.siteId), inArray(vendorInvoices.status, ['terkonfirmasi', 'ditolak']), gte(vendorInvoices.updatedAt, since), byRef,
      )).limit(2);
      if (closed.length === 1) return closed[0]!.rowId;
    }
    return null;
  });
}

// ---------------------------------------------------------------------------------------------

const UNREADABLE = Symbol('unreadable');

/**
 * OCR call with the LLD §9 error contract: a model answer that is not JSON (or does not fit the
 * schema) is "tidak terbaca"; a transport/provider error marks ocr_error and is retried.
 */
async function ocrCall(deps: IntakeDeps, job: Job, call: () => Promise<unknown>): Promise<unknown> {
  try {
    return await call();
  } catch (e) {
    if (e instanceof OcrParseError) return UNREADABLE;
    await withCompany(deps.db, job.companyId!, (tx) =>
      tx.update(intakeEvents).set({ outcome: 'ocr_error', error: String(e).slice(0, 500), updatedAt: new Date() })
        .where(eq(intakeEvents.id, Number(job.payload['intakeEventId']))));
    throw e;
  }
}

/** Runs a pure validator step; a ZodError (contract broken) becomes null = tidak terbaca. */
function safe<T>(fn: () => T): T | null {
  try {
    return fn();
  } catch (e) {
    if (e instanceof ZodError) return null;
    throw e;
  }
}

async function loadEvent(deps: IntakeDeps, job: Job): Promise<EventRow> {
  const id = Number(job.payload['intakeEventId']);
  if (!job.companyId || !Number.isInteger(id) || id <= 0) throw new PermanentJobError('payload intake tanpa company_id / intakeEventId');
  const ev = await withCompany(deps.db, job.companyId, (tx) => tx.query.intakeEvents.findFirst({ where: eq(intakeEvents.id, id) }));
  if (!ev) throw new PermanentJobError(`intake_event ${id} tidak ada`);
  return ev;
}

/** row_id of the vendor invoice that already holds this photo, null if the photo exists unattached, undefined if new. */
async function findBySha(deps: IntakeDeps, companyId: number, sha256: string): Promise<string | null | undefined> {
  return withCompany(deps.db, companyId, async (tx) => {
    const [a] = await tx.select({ attachableId: attachments.attachableId, type: attachments.attachableType })
      .from(attachments).where(eq(attachments.sha256, sha256)).limit(1);
    if (!a) return undefined;
    if (a.type !== 'vendor_invoices') return null;
    const [inv] = await tx.select({ rowId: vendorInvoices.rowId }).from(vendorInvoices).where(eq(vendorInvoices.id, a.attachableId));
    return inv?.rowId ?? null;
  });
}

async function setOutcome(deps: IntakeDeps, ev: EventRow, outcome: IntakeOutcome, error: string | null = null): Promise<void> {
  await withCompany(deps.db, ev.companyId, (tx) =>
    tx.update(intakeEvents).set({ outcome, error, updatedAt: new Date() }).where(eq(intakeEvents.id, ev.id)));
}

/**
 * The job failed for good. Never overwrites an outcome that is already final (e.g. the row was
 * saved and only a later step failed) and never sends a failure reply after a success reply.
 */
async function giveUp(deps: IntakeDeps, job: Job, finals: readonly IntakeOutcome[], reply: string, error: unknown): Promise<EventRow | null> {
  const ev = await loadEvent(deps, job).catch(() => null);
  if (!ev || finals.includes(ev.outcome)) return ev;
  return finish(deps, job, 'gagal', reply, String(error).slice(0, 500));
}

/** Final outcome first (so a reply failure cannot cause a second processing), then the reply. */
async function finish(deps: IntakeDeps, job: Job, outcome: IntakeOutcome, reply: string, error: string | null = null): Promise<EventRow | null> {
  const ev = await loadEvent(deps, job).catch(() => null);
  if (!ev) return null;
  await setOutcome(deps, ev, outcome, error);
  await replyAfterCommit(deps, ev, reply, null);
  return ev;
}

/**
 * Sends a reply to the message that triggered the event. A failed send never undoes the commit:
 * for a saved photo the outcome becomes `tersimpan_tanpa_balasan` (LLD §9).
 */
async function replyAfterCommit(deps: IntakeDeps, ev: EventRow, text: string, onFailure: IntakeOutcome | null): Promise<void> {
  try {
    const sent = await deps.telegram.sendMessage(ev.chatId, text, ev.messageId);
    await withCompany(deps.db, ev.companyId, (tx) =>
      tx.update(intakeEvents).set({ replyMessageId: sent.messageId, updatedAt: new Date() }).where(eq(intakeEvents.id, ev.id)));
  } catch (e) {
    deps.log('intake_reply_failed', { companyId: ev.companyId, chatId: ev.chatId, messageId: ev.messageId, error: e instanceof Error ? e.name : 'error' });
    if (onFailure) await setOutcome(deps, ev, onFailure);
  }
}

function toReplyRow(r: typeof vendorInvoices.$inferSelect): ReplyRow {
  return {
    rowId: r.rowId, vendorName: r.vendorName, invoiceDate: r.invoiceDate, totalCents: r.totalCents,
    category: r.category, status: r.status, flags: r.confidence.flags ?? [],
  };
}

function pgCode(err: unknown): string | undefined {
  return (err as { code?: string; cause?: { code?: string } })?.cause?.code ?? (err as { code?: string })?.code;
}
