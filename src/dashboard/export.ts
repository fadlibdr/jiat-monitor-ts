import ExcelJS from 'exceljs';
import { wibStamp } from '../domain/date.js';
import type { Panels } from './panels.js';

/**
 * Holding export (LLD §8 "XLSX per panel"): one sheet per panel, built from the same panels the
 * API returns, so the file and the screen cannot disagree. Money is rupiah (cents / 100), progress
 * and ratios are percent. The monthly PDF is still open (docs/remaining-work.md §6).
 */
export interface Labels {
  company: (id: number) => string;
  site: (id: number) => string;
}

const RP = '#,##0';
const PCT = '0.0';
const rp = (cents: number | null | undefined) => (cents == null ? null : cents / 100);
const pctMicro = (micro: number | null | undefined) => (micro == null ? null : micro / 1_000_000);
const pctBp = (bp: number | null | undefined) => (bp == null ? null : bp / 100);

function sheet(wb: ExcelJS.Workbook, name: string, columns: Array<{ header: string; key: string; width?: number; numFmt?: string }>, rows: Array<Record<string, unknown>>) {
  const ws = wb.addWorksheet(name);
  ws.columns = columns.map((c) => ({ header: c.header, key: c.key, width: c.width ?? 16, style: c.numFmt ? { numFmt: c.numFmt } : {} }));
  ws.getRow(1).font = { bold: true };
  ws.views = [{ state: 'frozen', ySplit: 1 }];
  for (const r of rows) ws.addRow(r);
  return ws;
}

export async function panelsToXlsx(p: Panels, labels: Labels, meta: { refreshedAt: Date | null; generatedAt: Date }): Promise<Buffer> {
  const wb = new ExcelJS.Workbook();
  wb.creator = 'JIAT Monitoring';
  wb.created = meta.generatedAt;
  const s = p.summary;

  sheet(wb, 'Ringkasan', [{ header: 'Ukuran', key: 'k', width: 40 }, { header: 'Nilai', key: 'v', width: 22 }], [
    { k: 'Periode', v: p.period.slice(0, 7) },
    { k: 'Data per', v: meta.refreshedAt ? wibStamp(meta.refreshedAt) : '—' },
    { k: 'Kontrak', v: s.contracts },
    { k: 'Lokasi', v: s.sites },
    { k: 'Perusahaan', v: s.companies },
    { k: 'Nilai kontrak DPP termasuk adendum (Rp)', v: rp(s.valueDppEffectiveCents) },
    { k: 'Adendum (Rp)', v: rp(s.addendumDeltaCents) },
    { k: 'Nilai kontrak termasuk PPN (Rp)', v: rp(s.valueTotalCents) },
    { k: 'Realisasi biaya DPP (Rp)', v: rp(s.costRealisedCents) },
    { k: 'Anggaran BOQ (Rp)', v: rp(s.budgetCents) },
    { k: 'Realisasi / anggaran (%)', v: pctBp(s.costOfBudgetBp) },
    { k: `Progres tertimbang (%) per ${s.progress?.period.slice(0, 7) ?? '—'}`, v: pctMicro(s.progress?.actualMicroPct) },
    { k: 'Rencana (%)', v: pctMicro(s.progress?.plannedMicroPct) },
    { k: 'Deviasi (poin)', v: pctMicro(s.progress?.deviationMicroPct) },
  ]);

  sheet(wb, 'Per perusahaan', [
    { header: 'Perusahaan', key: 'company', width: 30 }, { header: 'Kontrak', key: 'contracts', width: 10 },
    { header: 'Nilai DPP (Rp)', key: 'value', width: 20, numFmt: RP }, { header: 'Progres (%)', key: 'actual', numFmt: PCT },
    { header: 'Rencana (%)', key: 'planned', numFmt: PCT }, { header: 'Deviasi (poin)', key: 'dev', numFmt: PCT },
  ], p.byCompany.map((b) => ({
    company: labels.company(b.companyId), contracts: b.contracts, value: rp(b.valueDppEffectiveCents),
    actual: pctMicro(b.progress?.actualMicroPct), planned: pctMicro(b.progress?.plannedMicroPct), dev: pctMicro(b.progress?.deviationMicroPct),
  })));

  sheet(wb, 'Kontrak', [
    { header: 'Perusahaan', key: 'company', width: 24 }, { header: 'Lokasi', key: 'site', width: 24 }, { header: 'No. kontrak', key: 'number', width: 30 },
    { header: 'Pemberi kerja', key: 'employer', width: 26 }, { header: 'Status', key: 'status', width: 12 },
    { header: 'Nilai DPP (Rp)', key: 'value', width: 20, numFmt: RP }, { header: 'Progres (%)', key: 'actual', numFmt: PCT },
    { header: 'Deviasi (poin)', key: 'dev', numFmt: PCT }, { header: 'Termin terbit', key: 'terms', width: 12 }, { header: 'Termin siap', key: 'ready', width: 12 },
    { header: 'Selesai', key: 'end', width: 12 }, { header: 'Sisa hari', key: 'left', width: 10 },
  ], p.contracts.map((k) => ({
    company: labels.company(k.companyId), site: labels.site(k.siteId), number: k.number, employer: k.employerName, status: k.status,
    value: rp(k.valueDppEffectiveCents), actual: pctMicro(k.progress?.actualMicroPct), dev: pctMicro(k.progress?.deviationMicroPct),
    terms: `${k.termsIssued} / ${k.termsTotal}`, ready: k.termsReady, end: k.endDateEffective, left: k.daysLeft,
  })));

  sheet(wb, 'Kurva S', [
    { header: 'Bulan', key: 'period', width: 12 }, { header: 'Rencana (%)', key: 'planned', numFmt: PCT },
    { header: 'Realisasi (%)', key: 'actual', numFmt: PCT }, { header: 'Deviasi (poin)', key: 'dev', numFmt: PCT },
  ], p.curve.map((c) => ({ period: c.period.slice(0, 7), planned: pctMicro(c.plannedMicroPct), actual: pctMicro(c.actualMicroPct), dev: pctMicro(c.deviationMicroPct) })));

  const pr = p.procurement;
  sheet(wb, 'Pembelian', [
    { header: 'Kategori', key: 'category', width: 20 }, { header: 'Anggaran BOQ (Rp)', key: 'budget', width: 20, numFmt: RP },
    { header: 'Komitmen PO (Rp)', key: 'committed', width: 20, numFmt: RP }, { header: 'Diterima (Rp)', key: 'received', width: 20, numFmt: RP },
    { header: 'Komitmen / anggaran (%)', key: 'ofBudget', width: 22, numFmt: PCT }, { header: 'Porsi komitmen (%)', key: 'share', width: 18, numFmt: PCT },
  ], [
    ...pr.commitment.byCategory.map((b) => ({
      category: b.category, budget: rp(b.budgetCents), committed: rp(b.committedCents), received: rp(b.receivedCents),
      ofBudget: pctBp(b.committedOfBudgetBp), share: pctBp(b.shareOfCommittedBp),
    })),
    { category: 'TOTAL', budget: rp(pr.commitment.budgetCents), committed: rp(pr.commitment.committedCents), received: rp(pr.commitment.receivedCents), ofBudget: pctBp(pr.commitment.committedOfBudgetBp), share: 100 },
    {},
    { category: 'PR terbuka', budget: pr.prOpen }, { category: 'PR menunggu persetujuan', budget: pr.prWaiting },
    { category: 'PO outstanding (Rp)', budget: rp(pr.poOutstandingCents) }, { category: 'PO > 30 hari', budget: pr.poOverdueCount },
  ]);

  sheet(wb, 'Vendor terbesar', [
    { header: 'Vendor', key: 'vendor', width: 30 }, { header: 'Perusahaan', key: 'company', width: 24 },
    { header: 'Nilai PO (Rp)', key: 'po', width: 20, numFmt: RP }, { header: 'Belum diterima (Rp)', key: 'undelivered', width: 20, numFmt: RP },
  ], pr.topVendors.map((v) => ({ vendor: v.vendorName, company: labels.company(v.companyId), po: rp(v.poValueCents), undelivered: rp(v.undeliveredCents) })));

  const fin = p.finance;
  sheet(wb, 'Invoicing & kas', [{ header: 'Ukuran', key: 'k', width: 34 }, { header: 'Nilai', key: 'v', width: 20, numFmt: RP }], [
    { k: 'Piutang termin (Rp)', v: rp(fin.receivableCents) }, { k: 'Tagihan terbuka', v: fin.receivableCount },
    { k: 'Umur 0–30 (Rp)', v: rp(fin.aging.d0_30) }, { k: 'Umur 31–60 (Rp)', v: rp(fin.aging.d31_60) },
    { k: 'Umur 61–90 (Rp)', v: rp(fin.aging.d61_90) }, { k: 'Umur > 90 (Rp)', v: rp(fin.aging.d90p) },
    { k: 'Hutang vendor (Rp)', v: rp(fin.payableCents) }, { k: 'Lewat jatuh tempo (Rp)', v: rp(fin.payableOverdueCents) },
    { k: `Kas masuk ${fin.cash.period.slice(0, 7)} (Rp)`, v: rp(fin.cash.inCents) }, { k: `Kas keluar ${fin.cash.period.slice(0, 7)} (Rp)`, v: rp(fin.cash.outCents) },
    { k: `Kas bersih ${fin.cash.period.slice(0, 7)} (Rp)`, v: rp(fin.cash.netCents) },
  ]);
  sheet(wb, 'Arus bulanan', [
    { header: 'Bulan', key: 'period', width: 12 }, { header: 'PO terbit (Rp)', key: 'po', width: 18, numFmt: RP },
    { header: 'Barang diterima (Rp)', key: 'gr', width: 18, numFmt: RP }, { header: 'Tagihan terbit (Rp)', key: 'inv', width: 18, numFmt: RP },
    { header: 'Kas masuk (Rp)', key: 'in', width: 18, numFmt: RP }, { header: 'Kas keluar (Rp)', key: 'out', width: 18, numFmt: RP },
    { header: 'Biaya (Rp)', key: 'cost', width: 18, numFmt: RP },
  ], fin.monthly.map((m) => ({ period: m.period.slice(0, 7), po: rp(m.poIssuedCents), gr: rp(m.grReceivedCents), inv: rp(m.invoicedTotalCents), in: rp(m.cashInCents), out: rp(m.cashOutCents), cost: rp(m.costCents) })));

  const it = p.intake;
  sheet(wb, 'Intake lapangan', [{ header: 'Ukuran', key: 'k', width: 34 }, { header: 'Nilai', key: 'v', width: 16 }], [
    { k: 'Foto masuk, 7 hari', v: it.photos7d }, { k: 'Perlu konfirmasi', v: it.openKonfirmasi }, { k: 'Perlu cek', v: it.openCek },
    { k: 'Ask rate (%)', v: pctBp(it.askRateBp) }, { k: 'Median menit sampai terkonfirmasi', v: it.medianConfirmMinutes7d },
    ...it.perSite.map((x) => ({ k: `Foto 7 hari · ${labels.company(x.companyId)} · ${labels.site(x.siteId)}`, v: x.photos7d })),
  ]);

  sheet(wb, 'Peringatan', [
    { header: 'Jenis', key: 'kind', width: 24 }, { header: 'Perusahaan', key: 'company', width: 24 }, { header: 'Lokasi', key: 'site', width: 24 },
    { header: 'Rincian', key: 'detail', width: 80 },
  ], p.alerts.map((a) => ({
    // the same words as the dashboard and the digest, never raw cents or micro-percent
    kind: a.label, company: labels.company(a.companyId), site: labels.site(a.siteId), detail: a.text,
  })));

  return Buffer.from(await wb.xlsx.writeBuffer());
}
