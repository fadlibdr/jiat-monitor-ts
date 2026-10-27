import { CATEGORY_LABEL, type Category } from '../domain/categories.js';
import { formatRupiah } from '../domain/money.js';

/**
 * Every text the bot sends to a group. HLD §8 / UU 27/2022: a reply never carries a bank account
 * or an NPWP. That is enforced by construction — `ReplyRow` has no field that could hold one —
 * and by a test that feeds a row with those values through every builder.
 */
export interface ReplyRow {
  rowId: string;
  vendorName: string | null;
  invoiceDate: string | null;
  totalCents: number;
  category: Category | null;
  status: string;
  flags: readonly string[];
}

/** Short public reference: last 4 hex of the row uuid (LLD §7 "#xxxx"). */
export function shortRef(rowId: string): string {
  return rowId.replace(/-/g, '').slice(-4).toLowerCase();
}

const FLAG_TEXT: Record<string, string> = {
  field_kosong: 'vendor/tanggal belum terbaca',
  arith_items: 'jumlah per barang tidak cocok dengan subtotal',
  arith_ppn: 'subtotal + PPN tidak cocok dengan total',
  date_range: 'tanggal di luar masa proyek',
  near_duplicate: 'mirip nota lain yang sudah tercatat',
  npwp_format: 'NPWP tidak lengkap',
  kategori_kosong: 'kategori belum ditentukan',
};

export function flagText(flags: readonly string[]): string[] {
  return flags.map((f) => FLAG_TEXT[f] ?? f);
}

function idDate(iso: string | null): string {
  return iso ? `${iso.slice(8, 10)}/${iso.slice(5, 7)}/${iso.slice(0, 4)}` : '—';
}

export function summaryReply(r: ReplyRow): string {
  const lines = [
    `Tercatat #${shortRef(r.rowId)}`,
    `Vendor: ${r.vendorName ?? '—'}`,
    `Tanggal: ${idDate(r.invoiceDate)}`,
    `Total: ${formatRupiah(r.totalCents)}`,
    `Kategori: ${r.category ? CATEGORY_LABEL[r.category] : '—'}`,
  ];
  const issues = flagText(r.flags.filter((f) => f !== 'npwp_format'));
  if (issues.length) lines.push(`Perlu dicek: ${issues.join('; ')}`);
  lines.push('Balas pesan ini dengan OK bila benar, atau koreksi: TOTAL 2450000 · VENDOR nama · TANGGAL 21/06/2026 · KATEGORI material · NOMOR INV-1 · TOLAK');
  return lines.join('\n');
}

export function duplicateReply(rowId: string | null): string {
  return rowId ? `Nota ini sudah tercatat (#${shortRef(rowId)}).` : 'Nota ini sudah tercatat.';
}

export function correctionReply(r: ReplyRow, what: string): string {
  if (r.status === 'terkonfirmasi') return `#${shortRef(r.rowId)} terkonfirmasi: ${r.vendorName ?? '—'}, ${formatRupiah(r.totalCents)}.`;
  if (r.status === 'ditolak') return `#${shortRef(r.rowId)} ditolak. Foto tetap disimpan.`;
  const issues = flagText(r.flags.filter((f) => f !== 'npwp_format'));
  return `#${shortRef(r.rowId)} ${what} diperbarui. Total ${formatRupiah(r.totalCents)}.${issues.length ? ` Masih perlu: ${issues.join('; ')}.` : ' Balas OK untuk konfirmasi.'}`;
}

export const REPLY = {
  /** sent only once every retry is used up: nothing will retry it, so ask for a resend */
  failure: 'Sistem sedang gangguan; foto ini belum tercatat. Mohon kirim ulang foto ini beberapa saat lagi.',
  correctionFailed: 'Koreksi gagal diproses, hubungi admin.',
  alreadyConfirmed: 'Nota ini sudah dikonfirmasi; ubah lewat admin.',
  ambiguousRef: 'Kode # tidak ditemukan atau lebih dari satu nota cocok. Balas langsung ke pesan ringkasan nota.',
  confirmBlocked: (flags: readonly string[]) => `Belum bisa dikonfirmasi: ${flagText(flags).join('; ')}.`,
  duplicateConfirmed: 'Sudah ada nota terkonfirmasi dengan vendor, tanggal, dan total yang sama.',
  valueError: (detail: string) => `Koreksi tidak terbaca: ${detail}.`,
} as const;
