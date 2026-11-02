import type { Built } from './master.js';
import type { AdminCompany, AdminUser, CompanyInput, CompanyPatch, TelegramChatInput, UserPatch } from './types.js';

/**
 * System-admin forms → request bodies, checked by the rules of routes/admin.ts (its zod schemas), so a
 * mistake is named before sending. The server stays the authority.
 */
const fail = (error: string): { ok: false; error: string } => ({ ok: false, error });
const EMAIL = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

export interface CompanyForm { code: string; name: string; npwp: string; address: string; bankName: string; bankAccount: string; docPrefix: string; managerEmail: string }

export const companyFormOf = (c?: AdminCompany): CompanyForm => ({
  code: c?.code ?? '', name: c?.name ?? '', npwp: c?.npwp ?? '', address: c?.address ?? '', bankName: c?.bankName ?? '',
  bankAccount: c?.bankAccount ?? '', docPrefix: c?.docPrefix ?? '', managerEmail: '',
});

/** "01.234.567.8-901.000" → "012345678901000": the NPWP as stored (15 or 16 digits); '' stays ''; null when not an NPWP */
export function npwpDigits(raw: string): string | null {
  const s = raw.trim();
  if (!s) return '';
  const digits = s.replace(/[.\-\s]/g, '');
  return /^\d{15,16}$/.test(digits) ? digits : null;
}

/** The profile fields (everything but code and the first manager), checked; '' = not given. */
function profile(f: CompanyForm): Built<Required<CompanyPatch>> {
  const name = f.name.trim();
  if (name.length < 2 || name.length > 200) return fail('Nama perusahaan 2–200 karakter.');
  const npwp = npwpDigits(f.npwp);
  if (npwp === null) return fail('NPWP harus 15 atau 16 digit (titik dan tanda hubung boleh).');
  const bankAccount = f.bankAccount.trim();
  if (bankAccount && !/^[0-9-]{5,40}$/.test(bankAccount)) return fail('Nomor rekening 5–40 angka (tanda hubung boleh).');
  if (f.address.trim().length > 1000) return fail('Alamat paling banyak 1000 karakter.');
  if (f.bankName.trim().length > 100) return fail('Nama bank paling banyak 100 karakter.');
  if (f.docPrefix.trim().length > 12) return fail('Prefiks dokumen paling banyak 12 karakter.');
  return { ok: true, body: { name, npwp, address: f.address.trim(), bankName: f.bankName.trim(), bankAccount, docPrefix: f.docPrefix.trim() } };
}

/** A new company; the code is upper-cased (it prefixes document numbers, e.g. INV/KRM/…). */
export function companyBody(f: CompanyForm): Built<CompanyInput> {
  const code = f.code.trim().toUpperCase();
  if (!/^[A-Z0-9]{2,8}$/.test(code)) return fail('Kode 2–8 huruf kapital atau angka.');
  const p = profile(f);
  if (!p.ok) return p;
  const managerEmail = f.managerEmail.trim();
  if (managerEmail && !EMAIL.test(managerEmail)) return fail('Email manajer tidak valid.');
  const body: CompanyInput = { code, name: p.body.name };
  for (const k of ['npwp', 'address', 'bankName', 'bankAccount', 'docPrefix'] as const) if (p.body[k]) body[k] = p.body[k];
  if (managerEmail) body.managerEmail = managerEmail;
  return { ok: true, body };
}

/**
 * Only the fields that changed. The API cannot clear a profile field (it takes strings, not null), so
 * emptying a stored one is refused here rather than silently kept.
 */
export function companyPatchOf(c: AdminCompany, f: CompanyForm): Built<CompanyPatch> {
  const p = profile(f);
  if (!p.ok) return p;
  const label: Record<keyof CompanyPatch, string> = { name: 'Nama', npwp: 'NPWP', address: 'Alamat', bankName: 'Nama bank', bankAccount: 'Nomor rekening', docPrefix: 'Prefiks dokumen' };
  const body: CompanyPatch = {};
  for (const k of Object.keys(label) as Array<keyof CompanyPatch>) {
    const now = p.body[k];
    const stored = c[k] ?? '';
    if (now === stored) continue;
    if (!now) return fail(`${label[k]} tidak bisa dikosongkan dari sini.`);
    body[k] = now;
  }
  if (Object.keys(body).length === 0) return fail('Tidak ada perubahan.');
  return { ok: true, body };
}

export interface UserForm { name: string; phone: string; telegramUserId: string }
export const userFormOf = (u: AdminUser): UserForm => ({ name: u.name, phone: u.phone ?? '', telegramUserId: u.telegramUserId === null ? '' : String(u.telegramUserId) });

/** Changed profile fields; an emptied phone or Telegram id is sent as null (it unlinks). */
export function userPatchOf(u: AdminUser, f: UserForm): Built<UserPatch> {
  const body: UserPatch = {};
  const name = f.name.trim();
  if (name !== u.name) {
    if (name.length < 2 || name.length > 200) return fail('Nama 2–200 karakter.');
    body.name = name;
  }
  const phone = f.phone.trim();
  if (phone !== (u.phone ?? '')) {
    if (phone && !/^\+?[0-9 -]{6,30}$/.test(phone)) return fail('Nomor HP 6–30 angka (boleh +, spasi, tanda hubung).');
    body.phone = phone || null;
  }
  const tg = f.telegramUserId.trim();
  if (tg !== (u.telegramUserId === null ? '' : String(u.telegramUserId))) {
    if (tg && !/^[1-9]\d{0,14}$/.test(tg)) return fail('ID Telegram adalah angka positif (lihat lewat @userinfobot).');
    body.telegramUserId = tg ? Number(tg) : null;
  }
  if (Object.keys(body).length === 0) return fail('Tidak ada perubahan.');
  return { ok: true, body };
}

export interface ChatForm { chatId: string; companyId: string; siteId: string; title: string }
export const emptyChat = (): ChatForm => ({ chatId: '', companyId: '', siteId: '', title: '' });

/** A Telegram group → company + site. Group chat ids are negative ("-1001234567890"); 0 is not one. */
export function chatBody(f: ChatForm): Built<TelegramChatInput> {
  const raw = f.chatId.trim();
  if (!/^-?[1-9]\d{0,15}$/.test(raw) || !Number.isSafeInteger(Number(raw))) return fail('Chat ID Telegram berupa angka, untuk grup biasanya diawali -100.');
  if (!f.companyId) return fail('Pilih perusahaan.');
  if (!f.siteId) return fail('Pilih lokasi.');
  const title = f.title.trim();
  if (title.length > 200) return fail('Judul paling banyak 200 karakter.');
  return { ok: true, body: { chatId: Number(raw), companyId: Number(f.companyId), siteId: Number(f.siteId), ...(title ? { title } : {}) } };
}
