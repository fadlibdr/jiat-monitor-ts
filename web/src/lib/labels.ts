import type { Category, IntakeStatus } from './types.js';

/**
 * Words the server also uses (src/domain/categories.ts CATEGORY_LABEL, src/intake/replies.ts flag
 * texts in the chat replies). test/web/labels.test.ts keeps both sides the same.
 */
export const CATEGORY_LABEL: Record<Category, string> = {
  material: 'Material',
  upah: 'Upah / Jasa',
  alat: 'Peralatan',
  subkon: 'Subkontraktor',
  operasional: 'Operasional',
  lain: 'Lain-lain',
};

export const FLAG_TEXT: Record<string, string> = {
  field_kosong: 'vendor/tanggal belum terbaca',
  arith_items: 'jumlah per barang tidak cocok dengan subtotal',
  arith_ppn: 'subtotal + PPN tidak cocok dengan total',
  date_range: 'tanggal di luar masa proyek',
  near_duplicate: 'mirip nota lain yang sudah tercatat',
  npwp_format: 'NPWP tidak lengkap',
  kategori_kosong: 'kategori belum ditentukan',
};

export const INTAKE_STATUS_LABEL: Record<IntakeStatus, string> = {
  perlu_konfirmasi: 'Perlu konfirmasi',
  perlu_cek: 'Perlu cek',
  terkonfirmasi: 'Terkonfirmasi',
  ditolak: 'Ditolak',
};
