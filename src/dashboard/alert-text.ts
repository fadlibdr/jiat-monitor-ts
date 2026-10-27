import { formatRupiah } from '../domain/money.js';
import type { AlertKind } from '../db/schema.js';

/** Alert labels (holding mockup "Peringatan") and one-line texts for the digest and the UI. */
export const ALERT_LABELS: Record<AlertKind, string> = {
  termin_jatuh_tempo: 'Termin jatuh tempo',
  termin_siap: 'Termin siap diajukan',
  vendor_overdue: 'Vendor overdue',
  deviasi_progres: 'Deviasi progres',
  po_lewat_30_hari: 'PO > 30 hari',
  kontrak_mendekati_batas: 'Kontrak mendekati batas',
};

const MONTHS = ['Januari', 'Februari', 'Maret', 'April', 'Mei', 'Juni', 'Juli', 'Agustus', 'September', 'Oktober', 'November', 'Desember'];
type Data = Record<string, string | number | null | undefined>;

const num = (v: unknown) => (typeof v === 'number' ? v : Number(v ?? 0));
const pct = (micro: unknown) => `${(num(micro) / 1_000_000).toFixed(1).replace('.', ',')}%`;
const points = (micro: unknown) => (num(micro) / 1_000_000).toFixed(1).replace('.', ',');
const month = (period: unknown) => {
  const m = /^(\d{4})-(\d{2})/.exec(String(period ?? ''));
  return m ? `${MONTHS[Number(m[2]) - 1]} ${m[1]}` : '—';
};
const text = (v: unknown, fallback = '—') => (v === null || v === undefined || v === '' ? fallback : String(v));

export function alertText(kind: AlertKind, d: Data): string {
  switch (kind) {
    case 'termin_jatuh_tempo': {
      const left = num(d.daysLeft);
      const when = left > 0 ? `jatuh tempo dalam ${left} hari` : left === 0 ? 'jatuh tempo hari ini' : `lewat jatuh tempo ${-left} hari`;
      return `${text(d.contractNumber)} · Termin ${text(d.termSeq, '?')} (${text(d.invoiceNumber)}) ${when}, sisa ${formatRupiah(num(d.balanceCents))}`;
    }
    case 'termin_siap':
      return `${text(d.contractNumber)} · progres ${pct(d.actualMicroPct)} melewati ambang Termin ${text(d.termSeq, '?')} (${(num(d.triggerBp) / 100).toString().replace('.', ',')}%)`;
    case 'vendor_overdue':
      return `${text(d.vendorName, 'Vendor tanpa nama')} · ${formatRupiah(num(d.overdueCents))} lewat ${num(d.maxDaysOverdue)} hari (${num(d.invoices)} nota)`;
    case 'deviasi_progres':
      return `${text(d.contractNumber)} · tertinggal ${points(-num(d.deviationMicroPct))} poin dari rencana ${month(d.period)}`;
    case 'po_lewat_30_hari':
      return `PO ${text(d.poNumber)}${d.firstItem ? ` ${String(d.firstItem).slice(0, 60)}` : ''}, ${num(d.ageDays)} hari belum diterima`;
    case 'kontrak_mendekati_batas':
      return `${text(d.contractNumber)} · sisa ${num(d.daysLeft)} hari, progres ${pct(d.actualMicroPct)}`;
  }
}
