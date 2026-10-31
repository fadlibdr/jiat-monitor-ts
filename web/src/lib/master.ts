import { bpInput, changedText, parseDays, parseIdrCents, parsePercentBp, parseSignedRupiah } from './forms.js';
import { amountPlain } from './format.js';
import type {
  AddendumInput, Category, Contract, ContractInput, ContractPatch, ContractTerm, Site, SiteInput, Vendor, VendorInput, VendorPatch, VendorStatus,
} from './types.js';

/**
 * Master-data forms: what the inputs hold → the request body, or the reason it cannot be sent. The
 * server validates again (and is the authority); these catch typing mistakes before a round trip
 * and keep PATCH bodies to what actually changed.
 */
export type Built<T> = { ok: true; body: T } | { ok: false; error: string };
const fail = (error: string): { ok: false; error: string } => ({ ok: false, error });

// --- sites ---

export interface SiteForm { code: string; name: string; location: string; province: string; startDate: string; endDate: string; status: string }

export const siteFormOf = (s?: Site): SiteForm => ({
  code: s?.code ?? '', name: s?.name ?? '', location: s?.location ?? '', province: s?.province ?? '',
  startDate: s?.startDate ?? '', endDate: s?.endDate ?? '', status: s?.status ?? 'active',
});

const SITE_CODE = /^[A-Z0-9-]{1,20}$/;
const datesInOrder = (start: string, end: string) => !start || !end || start <= end;

export function siteBody(f: SiteForm): Built<SiteInput> {
  const code = f.code.trim().toUpperCase();
  if (!SITE_CODE.test(code)) return fail('Kode lokasi: huruf besar, angka atau "-", paling banyak 20 karakter (mis. KRM).');
  if (f.name.trim().length < 2) return fail('Nama lokasi minimal 2 karakter.');
  if (!datesInOrder(f.startDate, f.endDate)) return fail('Tanggal selesai sebelum tanggal mulai.');
  const body: SiteInput = { code, name: f.name.trim() };
  if (f.location.trim()) body.location = f.location.trim();
  if (f.province.trim()) body.province = f.province.trim();
  if (f.startDate) body.startDate = f.startDate;
  if (f.endDate) body.endDate = f.endDate;
  return { ok: true, body };
}

/** The code is the site's key in Telegram groups and document numbers: it is not edited. */
export function sitePatchOf(s: Site, f: SiteForm): Built<Partial<SiteInput> & { status?: string }> {
  if (f.name.trim().length < 2) return fail('Nama lokasi minimal 2 karakter.');
  if (!datesInOrder(f.startDate, f.endDate)) return fail('Tanggal selesai sebelum tanggal mulai.');
  const body = changedText<'name' | 'location' | 'province' | 'startDate' | 'endDate' | 'status'>(
    s, f, ['name', 'location', 'province', 'startDate', 'endDate', 'status']) as Partial<SiteInput> & { status?: string };
  return Object.keys(body).length ? { ok: true, body } : fail('Tidak ada perubahan.');
}

// --- vendors ---

export interface VendorForm {
  name: string; phone: string; defaultCategory: Category | ''; paymentTermsDays: string; status: VendorStatus;
  npwp: string; bankName: string; bankAccount: string;
}

export const vendorFormOf = (v?: Vendor): VendorForm => ({
  name: v?.name ?? '', phone: v?.phone ?? '', defaultCategory: v?.defaultCategory ?? '',
  paymentTermsDays: v?.paymentTermsDays === null || v?.paymentTermsDays === undefined ? '' : String(v.paymentTermsDays),
  status: v?.status ?? 'active', npwp: v?.npwp ?? '', bankName: v?.bankName ?? '', bankAccount: v?.bankAccount ?? '',
});

function vendorChecks(f: VendorForm, seesPii: boolean): string | null {
  const name = f.name.trim().replace(/\s+/g, ' ');
  if (name.length < 2) return 'Nama vendor minimal 2 karakter.';
  if (f.phone.trim() && !/^\+?[0-9 -]{6,30}$/.test(f.phone.trim())) return 'Telepon: angka, spasi atau "-", 6–30 karakter.';
  if (parseDays(f.paymentTermsDays) === undefined) return 'Tempo pembayaran: 0–365 hari.';
  if (seesPii) {
    if (f.npwp.trim() && !/^\d{15,16}$/.test(f.npwp.trim())) return 'NPWP: 15 atau 16 angka tanpa titik.';
    if (f.bankAccount.trim() && !/^[0-9-]{5,40}$/.test(f.bankAccount.trim())) return 'Nomor rekening: angka atau "-", 5–40 karakter.';
  }
  return null;
}

/** Bank account and NPWP are only sent by finance / managers: the API refuses them (403) from anyone else. */
export function vendorBody(f: VendorForm, seesPii: boolean): Built<VendorInput> {
  const err = vendorChecks(f, seesPii);
  if (err) return fail(err);
  const body: VendorInput = { name: f.name.trim().replace(/\s+/g, ' ') };
  if (f.phone.trim()) body.phone = f.phone.trim();
  if (f.defaultCategory) body.defaultCategory = f.defaultCategory;
  const days = parseDays(f.paymentTermsDays);
  if (typeof days === 'number') body.paymentTermsDays = days;
  if (seesPii) {
    if (f.npwp.trim()) body.npwp = f.npwp.trim();
    if (f.bankName.trim()) body.bankName = f.bankName.trim();
    if (f.bankAccount.trim()) body.bankAccount = f.bankAccount.trim();
  }
  return { ok: true, body };
}

export function vendorPatchOf(v: Vendor, f: VendorForm, seesPii: boolean): Built<VendorPatch> {
  const err = vendorChecks(f, seesPii);
  if (err) return fail(err);
  const body: VendorPatch = {};
  const name = f.name.trim().replace(/\s+/g, ' ');
  if (name !== v.name) body.name = name;
  if (f.status !== v.status) body.status = f.status;
  const text = changedText<'phone' | 'npwp' | 'bankName' | 'bankAccount'>(
    v, f, seesPii ? ['phone', 'npwp', 'bankName', 'bankAccount'] : ['phone'], ['phone', 'npwp', 'bankName', 'bankAccount']);
  Object.assign(body, text);
  if ((f.defaultCategory || null) !== v.defaultCategory) body.defaultCategory = f.defaultCategory || null;
  const days = parseDays(f.paymentTermsDays) as number | null;
  if (days !== v.paymentTermsDays) body.paymentTermsDays = days;
  return Object.keys(body).length ? { ok: true, body } : fail('Tidak ada perubahan.');
}

// --- contracts ---

export interface ContractForm {
  siteId: string; number: string; employerName: string; valueDpp: string; ppn: string; retention: string; advance: string;
  signedAt: string; startDate: string; endDate: string; status: string;
}

export const contractFormOf = (k?: Contract): ContractForm => ({
  siteId: k ? String(k.siteId) : '', number: k?.number ?? '', employerName: k?.employerName ?? '',
  valueDpp: k ? amountPlain(k.valueDppCents) : '', ppn: bpInput(k?.ppnRateBp ?? 1100), retention: bpInput(k?.retentionBp ?? 0),
  advance: k ? amountPlain(k.advanceCents) : '0', signedAt: k?.signedAt ?? '', startDate: k?.startDate ?? '',
  endDate: k?.endDate ?? '', status: k?.status ?? 'active',
});

type Terms = { ppnRateBp: number; retentionBp: number; advanceCents: number };
function contractTerms(f: ContractForm): Built<Terms> {
  const ppnRateBp = parsePercentBp(f.ppn);
  if (ppnRateBp === null) return fail('PPN: persen 0–100, mis. 11.');
  const retentionBp = parsePercentBp(f.retention);
  if (retentionBp === null) return fail('Retensi: persen 0–100, mis. 5.');
  const advanceCents = f.advance.trim() === '' ? 0 : parseIdrCents(f.advance);
  if (advanceCents === null) return fail('Uang muka tidak terbaca (tulis mis. 815.000.000).');
  if (!datesInOrder(f.startDate, f.endDate)) return fail('Tanggal selesai sebelum tanggal mulai.');
  return { ok: true, body: { ppnRateBp, retentionBp, advanceCents } };
}

export function contractBody(f: ContractForm): Built<ContractInput> {
  if (!f.siteId) return fail('Pilih lokasi kontrak.');
  if (!f.number.trim()) return fail('Nomor kontrak wajib diisi.');
  if (f.employerName.trim().length < 2) return fail('Pemberi kerja minimal 2 karakter.');
  const valueDppCents = parseIdrCents(f.valueDpp);
  if (!valueDppCents) return fail('Nilai DPP tidak terbaca atau 0 (tulis mis. 8.150.000.000).');
  const t = contractTerms(f);
  if (!t.ok) return t;
  if (t.body.advanceCents > valueDppCents) return fail('Uang muka melebihi nilai DPP kontrak.');
  const body: ContractInput = { siteId: Number(f.siteId), number: f.number.trim(), employerName: f.employerName.trim(), valueDppCents, ...t.body, status: f.status };
  if (f.signedAt) body.signedAt = f.signedAt;
  if (f.startDate) body.startDate = f.startDate;
  if (f.endDate) body.endDate = f.endDate;
  return { ok: true, body };
}

/** Number, site and DPP are not edited here: the DPP changes only through an addendum. */
export function contractPatchOf(k: Contract, f: ContractForm): Built<ContractPatch> {
  if (f.employerName.trim().length < 2) return fail('Pemberi kerja minimal 2 karakter.');
  const t = contractTerms(f);
  if (!t.ok) return t;
  if (t.body.advanceCents > k.valueDppEffectiveCents) return fail('Uang muka melebihi nilai DPP kontrak.');
  const body: ContractPatch = {};
  if (f.employerName.trim() !== k.employerName) body.employerName = f.employerName.trim();
  if (t.body.ppnRateBp !== k.ppnRateBp) body.ppnRateBp = t.body.ppnRateBp;
  if (t.body.retentionBp !== k.retentionBp) body.retentionBp = t.body.retentionBp;
  if (t.body.advanceCents !== k.advanceCents) body.advanceCents = t.body.advanceCents;
  for (const key of ['signedAt', 'startDate', 'endDate'] as const) {
    if (f[key] && f[key] !== k[key]) body[key] = f[key];
  }
  if (f.status !== k.status) body.status = f.status;
  return Object.keys(body).length ? { ok: true, body } : fail('Tidak ada perubahan.');
}

// --- termin ---

export interface TermRow { name: string; percent: string; trigger: string; dueDays: string }

export const termRowsOf = (terms: readonly ContractTerm[]): TermRow[] =>
  [...terms].sort((a, b) => a.seq - b.seq).map((t) => ({ name: t.name, percent: bpInput(t.percentBp), trigger: bpInput(t.triggerProgressBp), dueDays: String(t.dueDays) }));

/** Rows in screen order become seq 1, 2, …; the server checks Σ ≤ 100 % and non-decreasing triggers again. */
export function termsBody(rows: readonly TermRow[]): Built<Array<Omit<ContractTerm, 'id'>>> {
  const out: Array<Omit<ContractTerm, 'id'>> = [];
  for (const [i, r] of rows.entries()) {
    const seq = i + 1;
    if (!r.name.trim()) return fail(`Termin ${seq}: nama wajib diisi.`);
    const percentBp = parsePercentBp(r.percent);
    if (!percentBp) return fail(`Termin ${seq}: persen nilai 0,01–100.`);
    const triggerProgressBp = parsePercentBp(r.trigger);
    if (triggerProgressBp === null) return fail(`Termin ${seq}: ambang progres 0–100 %.`);
    const dueDays = parseDays(r.dueDays);
    if (typeof dueDays !== 'number') return fail(`Termin ${seq}: jatuh tempo 0–365 hari.`);
    out.push({ seq, name: r.name.trim(), percentBp, triggerProgressBp, dueDays });
  }
  for (let i = 1; i < out.length; i++) {
    if (out[i]!.triggerProgressBp < out[i - 1]!.triggerProgressBp) return fail(`Ambang progres termin ${i + 1} lebih kecil dari termin ${i}.`);
  }
  const total = out.reduce((s, t) => s + t.percentBp, 0);
  if (total > 10_000) return fail(`Jumlah persen termin ${bpInput(total)}% melebihi 100%.`);
  return { ok: true, body: out };
}

// --- addenda ---

export interface AddendumForm { number: string; signedAt: string; delta: string; endDateNew: string; note: string }
export const emptyAddendum = (): AddendumForm => ({ number: '', signedAt: '', delta: '', endDateNew: '', note: '' });

/** The value change may be negative (pekerjaan kurang); an addendum must change the value and/or the end date. */
export function addendumBody(f: AddendumForm): Built<AddendumInput> {
  if (!f.number.trim()) return fail('Nomor addendum wajib diisi.');
  if (!f.signedAt) return fail('Tanggal tanda tangan wajib diisi.');
  const delta = f.delta.trim() === '' ? 0 : parseSignedRupiah(f.delta);
  if (delta === null) return fail('Perubahan nilai tidak terbaca (tulis mis. 1.200.000.000 atau -250.000.000).');
  if (delta === 0 && !f.endDateNew) return fail('Addendum harus mengubah nilai dan/atau tanggal selesai.');
  const body: AddendumInput = { number: f.number.trim(), signedAt: f.signedAt };
  if (delta !== 0) body.valueDeltaCents = delta;
  if (f.endDateNew) body.endDateNew = f.endDateNew;
  if (f.note.trim()) body.note = f.note.trim();
  return { ok: true, body };
}
