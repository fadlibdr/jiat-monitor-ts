import { and, eq, gte, inArray, isNotNull, sql } from 'drizzle-orm';
import { alertText, ALERT_LABELS } from '../dashboard/alert-text.js';
import { computeSnapshot } from '../dashboard/snapshot.js';
import { companies, companyUsers, dailyDigests, intakeEvents, users, vendorInvoices, type AlertKind } from '../db/schema.js';
import { withApp, withCompany, type Db } from '../db/tenant.js';
import type { TelegramApi } from '../intake/telegram-api.js';
import { wibDate } from '../jobs/schedule.js';

/**
 * DailyDigest (LLD §9, 07:00 WIB): to the admins of each company — rows that need checking, intake
 * that failed in the last 24 hours, and alerts that are NEW since the previous digest. Sent by the
 * bot as a private message to project admins and managers who have a linked Telegram account
 * (users.telegram_user_id) and have started the bot. No bank account or NPWP, like every reply.
 */
export const DIGEST_ROLES = ['project_admin', 'company_manager'] as const;
const MONEY_ALERTS: ReadonlySet<AlertKind> = new Set(['termin_jatuh_tempo', 'vendor_overdue']);
const MAX_ALERT_LINES = 15;
const DAY = 86_400_000;

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

/** One company's digest for the WIB day of `now`. Idempotent per company and day. */
export async function sendCompanyDigest(deps: DigestDeps, companyId: number, now: Date): Promise<'sent' | 'already_sent' | 'no_recipients'> {
  const date = wibDate(now);
  const prepared = await withCompany(deps.db, companyId, async (tx) => {
    const [done] = await tx.select().from(dailyDigests).where(and(eq(dailyDigests.companyId, companyId), eq(dailyDigests.digestDate, date)));
    if (done?.sentAt) return null;
    const [prev] = await tx.select({ keys: dailyDigests.alertKeys }).from(dailyDigests)
      .where(and(eq(dailyDigests.companyId, companyId), sql`${dailyDigests.digestDate} < ${date}`, isNotNull(dailyDigests.sentAt)))
      .orderBy(sql`${dailyDigests.digestDate} DESC`).limit(1);
    const reported = new Set(prev?.keys ?? []);
    const { alerts } = await computeSnapshot(tx, companyId, now);
    const open = await tx.select({ status: vendorInvoices.status, n: sql<number>`count(*)::int` }).from(vendorInvoices)
      .where(inArray(vendorInvoices.status, ['perlu_cek', 'perlu_konfirmasi'])).groupBy(vendorInvoices.status);
    const since = new Date(now.getTime() - DAY);
    const intake = await tx.select({ outcome: intakeEvents.outcome, n: sql<number>`count(*)::int` }).from(intakeEvents)
      .where(and(eq(intakeEvents.kind, 'photo'), gte(intakeEvents.createdAt, since), inArray(intakeEvents.outcome, ['gagal', 'ocr_error', 'tidak_terbaca'])))
      .groupBy(intakeEvents.outcome);
    const count = <T extends { n: number }>(rows: T[], pick: (r: T) => boolean) => rows.filter(pick).reduce((s, r) => s + r.n, 0);
    const keys = alerts.map((a) => `${a.kind}:${a.ref}`);
    await tx.insert(dailyDigests).values({ companyId, digestDate: date, alertKeys: keys })
      .onConflictDoUpdate({ target: [dailyDigests.companyId, dailyDigests.digestDate], set: { alertKeys: keys } });
    return {
      perluCek: count(open, (r) => r.status === 'perlu_cek'),
      perluKonfirmasi: count(open, (r) => r.status === 'perlu_konfirmasi'),
      failed24h: count(intake, (r) => r.outcome === 'gagal' || r.outcome === 'ocr_error'),
      unreadable24h: count(intake, (r) => r.outcome === 'tidak_terbaca'),
      newAlerts: alerts.filter((a) => !reported.has(`${a.kind}:${a.ref}`)).map((a) => ({ kind: a.kind, text: alertText(a.kind, a.data) })),
      openAlerts: alerts.length,
      openAlertsNoMoney: alerts.filter((a) => !MONEY_ALERTS.has(a.kind)).length,
    };
  });
  if (!prepared) return 'already_sent';

  const { recipients, companyName } = await withApp(deps.db, async (tx) => {
    const [c] = await tx.select({ name: companies.name }).from(companies).where(eq(companies.id, companyId));
    const rs = await tx.select({ telegramUserId: users.telegramUserId, role: companyUsers.role }).from(companyUsers).innerJoin(users, eq(users.id, companyUsers.userId))
      .where(and(eq(companyUsers.companyId, companyId), inArray(companyUsers.role, [...DIGEST_ROLES]), eq(users.isActive, true), isNotNull(users.telegramUserId)));
    return { recipients: rs.map((r) => ({ chatId: r.telegramUserId!, money: r.role === 'company_manager' })), companyName: c?.name ?? `#${companyId}` };
  });
  if (!recipients.length) {
    deps.log('digest_no_recipients', { companyId });
    await markSent(deps.db, companyId, date, 0, now);
    return 'no_recipients';
  }
  // receivables and vendor debts are finance's and the managers' (as on the company dashboard)
  const full = digestText({ companyName, date, ...prepared });
  const noMoney = digestText({
    companyName, date, ...prepared, newAlerts: prepared.newAlerts.filter((a) => !MONEY_ALERTS.has(a.kind)), openAlerts: prepared.openAlertsNoMoney,
  });
  let delivered = 0;
  for (const { chatId, money } of recipients) {
    try {
      await deps.telegram.sendMessage(chatId, money ? full : noMoney);
      delivered++;
    } catch (e) {
      // typically 403: the admin never started the bot or blocked it; the others still get theirs
      deps.log('digest_send_failed', { companyId, error: e instanceof Error ? e.message : String(e) });
    }
  }
  if (!delivered) throw new Error(`digest company ${companyId}: tidak ada penerima yang bisa dikirimi`);
  await markSent(deps.db, companyId, date, delivered, now);
  return 'sent';
}

async function markSent(db: Db, companyId: number, date: string, recipients: number, now: Date) {
  await withCompany(db, companyId, (tx) => tx.update(dailyDigests).set({ recipients, sentAt: now })
    .where(and(eq(dailyDigests.companyId, companyId), eq(dailyDigests.digestDate, date))));
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
      failures.push(new Error(`company ${id}`, { cause: e }));
    }
  }
  if (failures.length) throw new AggregateError(failures, `digest gagal untuk ${failures.length} dari ${ids.length} perusahaan`);
  return tally;
}
