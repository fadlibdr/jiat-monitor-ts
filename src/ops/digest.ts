import { and, eq, gte, inArray, isNotNull, isNull, lt, or, sql } from 'drizzle-orm';
import { alertText, ALERT_LABELS } from '../dashboard/alert-text.js';
import { computeSnapshot } from '../dashboard/snapshot.js';
import { companies, companyUsers, dailyDigests, intakeEvents, users, vendorInvoices, type AlertKind } from '../db/schema.js';
import { siteScopeFor, withApp, withCompany, type Db } from '../db/tenant.js';
import { RecipientUnreachableError, type TelegramApi } from '../intake/telegram-api.js';
import { wibDate } from '../jobs/schedule.js';

/**
 * DailyDigest (LLD §9, 07:00 WIB): to the admins of each company — rows that need checking, intake
 * that failed in the last 24 hours, and alerts that are NEW since the previous digest. Sent by the
 * bot as a private message to project admins and managers who have a linked Telegram account
 * (users.telegram_user_id) and have started the bot. No bank account or NPWP, like every reply.
 *
 * Each recipient sees only the sites their membership covers (company_users.site_ids, as in the
 * app), and only managers see money owed or owing.
 */
export const DIGEST_ROLES = ['project_admin', 'company_manager'] as const;
const MONEY_ALERTS: ReadonlySet<AlertKind> = new Set(['termin_jatuh_tempo', 'vendor_overdue']);
const MAX_ALERT_LINES = 15;
const DAY = 86_400_000;
/** How long a worker may hold a company's digest before another may take it over (a crashed worker's claim lapses). */
export const DIGEST_CLAIM_MS = 15 * 60_000;

export interface DigestDeps {
  db: Db;
  telegram: TelegramApi;
  log: (msg: string, meta: object) => void;
}

export interface DigestContent {
  companyName: string;
  date: string;
  perluCek: number;
  perluKonfirmasi: number;
  failed24h: number;
  unreadable24h: number;
  newAlerts: Array<{ kind: AlertKind; text: string }>;
  openAlerts: number;
}

export function digestText(c: DigestContent): string {
  const lines = [
    `Ringkasan harian ${c.companyName} — ${c.date}`,
    `• Nota perlu cek: ${c.perluCek} · perlu konfirmasi: ${c.perluKonfirmasi}`,
    `• Intake 24 jam: ${c.failed24h} gagal diproses, ${c.unreadable24h} foto tidak terbaca`,
    c.newAlerts.length ? `• Peringatan baru (${c.newAlerts.length}), aktif ${c.openAlerts}:` : `• Tidak ada peringatan baru (aktif ${c.openAlerts}).`,
    ...c.newAlerts.slice(0, MAX_ALERT_LINES).map((a) => `  – ${ALERT_LABELS[a.kind]}: ${a.text}`),
  ];
  if (c.newAlerts.length > MAX_ALERT_LINES) lines.push(`  … dan ${c.newAlerts.length - MAX_ALERT_LINES} lainnya di dashboard.`);
  return lines.join('\n');
}

/** What a company's digest is built from: every site, filtered per recipient afterwards. */
interface Prepared {
  open: Array<{ siteId: number; status: string; n: number }>;
  intake: Array<{ siteId: number; outcome: string; n: number }>;
  alerts: Array<{ kind: AlertKind; siteId: number; isNew: boolean; text: string }>;
  delivered: number[];
}

export type DigestResult = 'sent' | 'already_sent' | 'in_progress' | 'no_recipients' | 'undeliverable';

/**
 * One company's digest for the WIB day of `now`. Idempotent per company and day: a worker claims the
 * day's row before sending (a second worker answers 'in_progress'), every delivery is recorded as it
 * happens, and a retry after a crash or a transient Telegram failure sends only to those not reached.
 */
export async function sendCompanyDigest(deps: DigestDeps, companyId: number, now: Date): Promise<DigestResult> {
  const date = wibDate(now);
  const claimUntil = new Date(now.getTime() + DIGEST_CLAIM_MS);
  // 1. claim the day (READ COMMITTED: a second worker sees the first one's claim and steps back)
  const claim = await withCompany(deps.db, companyId, async (tx): Promise<{ delivered: number[] } | DigestResult> => {
    await tx.insert(dailyDigests).values({ companyId, digestDate: date }).onConflictDoNothing();
    const [claimed] = await tx.update(dailyDigests).set({ claimedUntil: claimUntil })
      .where(and(
        eq(dailyDigests.companyId, companyId), eq(dailyDigests.digestDate, date), isNull(dailyDigests.sentAt),
        or(isNull(dailyDigests.claimedUntil), lt(dailyDigests.claimedUntil, now)),
      ))
      .returning({ delivered: dailyDigests.deliveredChatIds });
    if (claimed) return claimed;
    const [row] = await tx.select({ sentAt: dailyDigests.sentAt }).from(dailyDigests)
      .where(and(eq(dailyDigests.companyId, companyId), eq(dailyDigests.digestDate, date)));
    return row?.sentAt ? 'already_sent' : 'in_progress';
  });
  if (typeof claim === 'string') return claim;

  // 2. read everything in one snapshot, so counts and alerts agree with each other
  const prepared = await withCompany(deps.db, companyId, async (tx): Promise<Prepared & { keys: string[] }> => {
    const [prev] = await tx.select({ keys: dailyDigests.alertKeys }).from(dailyDigests)
      .where(and(eq(dailyDigests.companyId, companyId), sql`${dailyDigests.digestDate} < ${date}`, isNotNull(dailyDigests.sentAt)))
      .orderBy(sql`${dailyDigests.digestDate} DESC`).limit(1);
    const reported = new Set(prev?.keys ?? []);
    const { alerts } = await computeSnapshot(tx, companyId, now);
    const open = await tx.select({ siteId: vendorInvoices.siteId, status: vendorInvoices.status, n: sql<number>`count(*)::int` }).from(vendorInvoices)
      .where(inArray(vendorInvoices.status, ['perlu_cek', 'perlu_konfirmasi'])).groupBy(vendorInvoices.siteId, vendorInvoices.status);
    const since = new Date(now.getTime() - DAY);
    const intake = await tx.select({ siteId: intakeEvents.siteId, outcome: intakeEvents.outcome, n: sql<number>`count(*)::int` }).from(intakeEvents)
      .where(and(eq(intakeEvents.kind, 'photo'), gte(intakeEvents.createdAt, since), inArray(intakeEvents.outcome, ['gagal', 'ocr_error', 'tidak_terbaca'])))
      .groupBy(intakeEvents.siteId, intakeEvents.outcome);
    return {
      open,
      intake,
      alerts: alerts.map((a) => ({ kind: a.kind, siteId: a.siteId, isNew: !reported.has(`${a.kind}:${a.ref}`), text: alertText(a.kind, a.data) })),
      delivered: claim.delivered,
      keys: alerts.map((a) => `${a.kind}:${a.ref}`),
    };
  }, { snapshot: true, readOnly: true });
  // 3. the ledger keeps every alert of the company, so "new" tomorrow means new to the company whoever saw it
  await withCompany(deps.db, companyId, (tx) => tx.update(dailyDigests).set({ alertKeys: prepared.keys }).where(dayRow(companyId, date)));

  const { recipients, companyName } = await withApp(deps.db, async (tx) => {
    const [c] = await tx.select({ name: companies.name }).from(companies).where(eq(companies.id, companyId));
    const rs = await tx.select({ userId: users.id, telegramUserId: users.telegramUserId, role: companyUsers.role, siteIds: companyUsers.siteIds })
      .from(companyUsers).innerJoin(users, eq(users.id, companyUsers.userId))
      .where(and(eq(companyUsers.companyId, companyId), inArray(companyUsers.role, [...DIGEST_ROLES]), eq(users.isActive, true), isNotNull(users.telegramUserId)));
    return {
      recipients: rs.map((r) => ({ userId: r.userId, chatId: r.telegramUserId!, money: r.role === 'company_manager', scope: siteScopeFor(r.role, r.siteIds) })),
      companyName: c?.name ?? `#${companyId}`,
    };
  });
  if (!recipients.length) {
    deps.log('digest_no_recipients', { companyId });
    await finish(deps.db, companyId, date, now);
    return 'no_recipients';
  }

  const delivered = new Set(prepared.delivered);
  const unreachable: number[] = [];
  let transient = 0;
  for (const r of recipients) {
    if (delivered.has(r.chatId)) continue;
    try {
      await deps.telegram.sendMessage(r.chatId, digestText(contentFor(prepared, r, companyName, date)));
    } catch (e) {
      const permanent = e instanceof RecipientUnreachableError;
      if (permanent) unreachable.push(r.userId);
      else transient++;
      // the user id, so ops know whom to ask to (re)start the bot; never the message text
      deps.log('digest_send_failed', { companyId, userId: r.userId, permanent, error: e instanceof Error ? e.message : String(e) });
      continue;
    }
    delivered.add(r.chatId);
    await recordDelivery(deps.db, companyId, date, [...delivered], claimUntil);
  }
  if (transient) {
    // let the job's retry send to the rest; the ones reached are not sent to again
    await release(deps.db, companyId, date);
    throw new Error(`digest perusahaan ${companyId}: ${transient} penerima gagal sementara, dicoba lagi`);
  }
  await finish(deps.db, companyId, date, now);
  if (delivered.size === 0) {
    // everyone blocked the bot or never started it: retrying daily cannot help, so it is not a job failure
    deps.log('digest_undeliverable', { companyId, userIds: unreachable });
    return 'undeliverable';
  }
  return 'sent';
}

/** The digest one recipient may read: their sites only, money alerts for managers only. */
function contentFor(p: Prepared, r: { money: boolean; scope: number[] | null }, companyName: string, date: string): DigestContent {
  const inScope = (siteId: number) => r.scope === null || r.scope.includes(siteId);
  const sum = <T extends { siteId: number; n: number }>(rows: T[], pick: (row: T) => boolean) =>
    rows.filter((row) => inScope(row.siteId) && pick(row)).reduce((s, row) => s + row.n, 0);
  const visible = p.alerts.filter((a) => inScope(a.siteId) && (r.money || !MONEY_ALERTS.has(a.kind)));
  return {
    companyName,
    date,
    perluCek: sum(p.open, (row) => row.status === 'perlu_cek'),
    perluKonfirmasi: sum(p.open, (row) => row.status === 'perlu_konfirmasi'),
    failed24h: sum(p.intake, (row) => row.outcome === 'gagal' || row.outcome === 'ocr_error'),
    unreadable24h: sum(p.intake, (row) => row.outcome === 'tidak_terbaca'),
    newAlerts: visible.filter((a) => a.isNew).map((a) => ({ kind: a.kind, text: a.text })),
    openAlerts: visible.length,
  };
}

const dayRow = (companyId: number, date: string) => and(eq(dailyDigests.companyId, companyId), eq(dailyDigests.digestDate, date));

/** Recorded right after each delivery (its own transaction), and the claim extended. */
async function recordDelivery(db: Db, companyId: number, date: string, chatIds: number[], claimUntil: Date) {
  await withCompany(db, companyId, (tx) => tx.update(dailyDigests).set({ deliveredChatIds: chatIds, recipients: chatIds.length, claimedUntil: claimUntil }).where(dayRow(companyId, date)));
}

async function release(db: Db, companyId: number, date: string) {
  await withCompany(db, companyId, (tx) => tx.update(dailyDigests).set({ claimedUntil: null }).where(dayRow(companyId, date)));
}

async function finish(db: Db, companyId: number, date: string, now: Date) {
  await withCompany(db, companyId, (tx) => tx.update(dailyDigests).set({ sentAt: now, claimedUntil: null }).where(dayRow(companyId, date)));
}

/** Every company; one company failing does not stop the others (reported together at the end). */
export async function sendAllDigests(deps: DigestDeps, now: Date): Promise<Record<string, number>> {
  const ids = await withApp(deps.db, (tx) => tx.select({ id: companies.id }).from(companies));
  const tally: Record<string, number> = {};
  const failures: Error[] = [];
  for (const { id } of ids) {
    try {
      const r = await sendCompanyDigest(deps, id, now);
      tally[r] = (tally[r] ?? 0) + 1;
    } catch (e) {
      deps.log('digest_company_failed', { companyId: id, error: e instanceof Error ? e.message : String(e) });
      failures.push(new Error(`company ${id}`, { cause: e }));
    }
  }
  if (failures.length) throw new AggregateError(failures, `digest gagal untuk ${failures.length} dari ${ids.length} perusahaan`);
  return tally;
}
