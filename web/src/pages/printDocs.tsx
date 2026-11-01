import { PrintSheet } from '../components/PrintSheet';
import { invoiceLines } from '../lib/finance';
import { dateLabel, percentBp, percentMicro, qtyLabel, rupiah } from '../lib/format';
import { terbilangRupiah } from '../lib/terbilang';
import type { Contract, PurchaseOrderDetail, SalesInvoice } from '../lib/types';

/** Printed termin invoice: the server's frozen amounts, the total in words, a signature line. */
export function InvoiceSheet({ invoice: d, companyName, contract }: { invoice: SalesInvoice; companyName: string; contract: Contract | undefined }) {
  return (
    <PrintSheet>
      <div className="ps-head"><div className="ps-company">{companyName}</div><h1>Tagihan termin</h1></div>
      <dl className="ps-meta">
        <dt>Nomor</dt><dd>{d.number}</dd>
        <dt>Tanggal</dt><dd>{dateLabel(d.invoiceDate)}</dd>
        <dt>Kepada</dt><dd>{contract?.employerName ?? '—'}</dd>
        <dt>Jatuh tempo</dt><dd>{dateLabel(d.dueDate)}</dd>
        <dt>Kontrak</dt><dd>{contract?.number ?? `#${d.contractId}`}</dd>
        <dt>Progres fisik</dt><dd>{percentMicro(d.progressMicroPct)} (disetujui)</dd>
      </dl>
      <table>
        <tbody>
          {invoiceLines(d).map((l, k, all) => (
            <tr key={l.label} className={k === all.length - 1 ? 'ps-total' : ''}><td>{l.label}</td><td className="num">{rupiah(l.cents)}</td></tr>
          ))}
        </tbody>
      </table>
      <p className="ps-words"><i>Terbilang:</i> {terbilangRupiah(d.totalCents)}</p>
      <div className="ps-sign"><div /><div>Hormat kami,<br />{companyName}<div className="ps-line">( ............................................ )</div></div></div>
    </PrintSheet>
  );
}

/** Printed purchase order for the vendor: lines, DPP / PPN / total, the total in words, two signature lines. */
export function PoSheet({ po: d, companyName, vendorName, siteName }: { po: PurchaseOrderDetail; companyName: string; vendorName: string; siteName: string }) {
  return (
    <PrintSheet>
      <div className="ps-head"><div className="ps-company">{companyName}</div><h1>Pesanan pembelian (PO)</h1></div>
      <dl className="ps-meta">
        <dt>Nomor</dt><dd>{d.number}</dd>
        <dt>Tanggal</dt><dd>{dateLabel(d.orderDate)}</dd>
        <dt>Kepada</dt><dd>{vendorName}</dd>
        <dt>Dikirim ke</dt><dd>{siteName}</dd>
        <dt>Paling lambat</dt><dd>{d.expectedDate ? dateLabel(d.expectedDate) : '—'}</dd>
      </dl>
      <table>
        <thead><tr><th>No</th><th>Uraian</th><th className="num">Volume</th><th>Sat.</th><th className="num">Harga satuan</th><th className="num">Jumlah</th></tr></thead>
        <tbody>
          {d.items.map((i, k) => (
            <tr key={i.id}>
              <td>{k + 1}</td><td>{i.description}</td><td className="num">{qtyLabel(i.qty)}</td><td>{i.unit ?? ''}</td>
              <td className="num">{rupiah(i.unitPriceCents)}</td><td className="num">{rupiah(i.amountCents)}</td>
            </tr>
          ))}
          <tr><td colSpan={5} className="num">DPP</td><td className="num">{rupiah(d.dppCents)}</td></tr>
          <tr><td colSpan={5} className="num">PPN {percentBp(d.ppnRateBp)}</td><td className="num">{rupiah(d.ppnCents)}</td></tr>
          <tr className="ps-total"><td colSpan={5} className="num">Total</td><td className="num">{rupiah(d.totalCents)}</td></tr>
        </tbody>
      </table>
      <p className="ps-words"><i>Terbilang:</i> {terbilangRupiah(d.totalCents)}</p>
      {d.note && <p>Catatan: {d.note}</p>}
      <div className="ps-sign">
        <div>Dipesan oleh,<br />{companyName}<div className="ps-line">( ............................................ )</div></div>
        <div>Diterima vendor,<br />{vendorName}<div className="ps-line">( ............................................ )</div></div>
      </div>
    </PrintSheet>
  );
}
