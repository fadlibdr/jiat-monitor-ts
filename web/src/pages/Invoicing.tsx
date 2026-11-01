import { useState, type FormEvent } from 'react';
import { Card, ErrorNotice, Loading, Pill } from '../components/ui';
import { api } from '../lib/api';
import { dateLabel, percentBp, percentMicro, rupiah, todayWib } from '../lib/format';
import {
  AGING_LABEL, balanceAfter, cancellable, emptyPayment, INVOICE_LABEL, INVOICE_TONE, invoiceLines, METHOD_LABEL, nextBillable, paymentBody,
  type PaymentForm, type PaymentTarget,
} from '../lib/finance';
import { useAsync, type AsyncState } from '../lib/useAsync';
import type { AgingBucket, Contract, Payment, PaymentMethod, SalesInvoice, Site } from '../lib/types';
import { errorNote, Notice, type Note } from './master/common';

type Tab = 'termin' | 'tagihan' | 'piutang' | 'hutang';
type Panel = { kind: 'invoice'; id: number } | { kind: 'payable'; rowId: string };
type Lookups = { sites: Site[]; contracts: Contract[] };
const BUCKETS: AgingBucket[] = ['d0_30', 'd31_60', 'd61_90', 'd90p'];
const TABS: Array<[Tab, string]> = [['termin', 'Termin'], ['tagihan', 'Tagihan'], ['piutang', 'Piutang'], ['hutang', 'Hutang vendor']];

/**
 * Termin invoices to the employer, payments in and out, aging (HLD §4, §7). Finance and managers only
 * (every money endpoint is FINANCE_ROLES). Amounts are the server's; the screen never computes one.
 */
export function Invoicing({ companyId }: { companyId: number }) {
  const [tab, setTab] = useState<Tab>('termin');
  const [panel, setPanel] = useState<Panel>();
  const [flash, setFlash] = useState<Note>();
  /** bumped after a vendor payment, so the payables list beside the detail reloads */
  const [payablesVersion, setPayablesVersion] = useState(0);
  const lookups = useAsync(async (): Promise<Lookups> => {
    const [sites, contracts] = await Promise.all([api.sites(companyId), api.contracts(companyId)]);
    return { sites, contracts };
  }, [companyId]);
  const invoices = useAsync(() => api.salesInvoices(companyId), [companyId]);
  const lk = lookups.data ?? { sites: [], contracts: [] };
  const contractNo = (id: number) => lk.contracts.find((k) => k.id === id)?.number ?? `#${id}`;
  const show = (t: Tab, p?: Panel) => { setFlash(undefined); setTab(t); setPanel(p); };
  const today = todayWib();

  return (
    <>
      <div className="page-head">
        <div className="eyebrow">Keuangan</div>
        <h1>Tagihan &amp; pembayaran</h1>
      </div>
      {lookups.error && <ErrorNotice error={lookups.error} onRetry={lookups.reload} />}
      <div className="review">
        <Card>
          <div className="tabs" role="tablist" aria-label="Keuangan">
            {TABS.map(([t, label]) => <button key={t} type="button" role="tab" aria-selected={tab === t} onClick={() => show(t)}>{label}</button>)}
          </div>
          <Notice note={flash} />
          {tab === 'termin' && (
            <TerminTab companyId={companyId} contracts={lk.contracts} loading={lookups.loading && !lookups.data}
              onIssued={(inv) => {
                invoices.reload();
                setTab('tagihan');
                setPanel({ kind: 'invoice', id: inv.id });
                setFlash({ tone: 'ok', text: `Tagihan ${inv.number} terbit: ${rupiah(inv.totalCents)}, jatuh tempo ${dateLabel(inv.dueDate)}.` });
              }} />
          )}
          {tab === 'tagihan' && (
            <>
              {invoices.error && <ErrorNotice error={invoices.error} onRetry={invoices.reload} />}
              {invoices.loading && !invoices.data && <Loading what="tagihan" />}
              {invoices.data && invoices.data.length === 0 && <div className="empty">Belum ada tagihan termin. Terbitkan dari tab Termin.</div>}
              {invoices.data && invoices.data.length > 0 && (
                <div className="table-wrap">
                  <table>
                    <thead><tr><th>Nomor</th><th>Kontrak</th><th>Tanggal</th><th>Jatuh tempo</th><th className="num">Jumlah</th><th>Status</th></tr></thead>
                    <tbody>
                      {invoices.data.map((i) => (
                        <tr key={i.id} className={`selectable ${panel?.kind === 'invoice' && panel.id === i.id ? 'selected' : ''}`} tabIndex={0}
                          onClick={() => show('tagihan', { kind: 'invoice', id: i.id })} onKeyDown={(e) => { if (e.key === 'Enter') show('tagihan', { kind: 'invoice', id: i.id }); }}>
                          <td className="code">{i.number}</td>
                          <td className="small">{contractNo(i.contractId)}</td>
                          <td>{dateLabel(i.invoiceDate)}</td>
                          <td className={(i.status === 'issued' || i.status === 'partial') && i.dueDate < today ? 't-red' : ''}>{dateLabel(i.dueDate)}</td>
                          <td className="num">{rupiah(i.totalCents)}</td>
                          <td><Pill tone={INVOICE_TONE[i.status]}>{INVOICE_LABEL[i.status]}</Pill></td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              )}
            </>
          )}
          {tab === 'piutang' && <ReceivablesTab companyId={companyId} contractNo={contractNo} onOpen={(id) => show('tagihan', { kind: 'invoice', id })} />}
          {tab === 'hutang' && (
            <PayablesTab companyId={companyId} version={payablesVersion} selected={panel?.kind === 'payable' ? panel.rowId : undefined}
              onOpen={(rowId) => show('hutang', { kind: 'payable', rowId })} />
          )}
        </Card>
        <div className="detail">
          {!panel && <Card><div className="empty">{tab === 'hutang' ? 'Pilih nota vendor untuk membayar.' : 'Pilih tagihan untuk melihat rincian dan pembayaran.'}</div></Card>}
          {panel?.kind === 'invoice' && (
            <InvoiceDetail key={panel.id} companyId={companyId} id={panel.id} invoice={invoices} contractNo={contractNo}
              onChanged={(text) => { invoices.reload(); if (text) setFlash({ tone: 'ok', text }); }} />
          )}
          {panel?.kind === 'payable' && (
            <PayableDetail key={panel.rowId} companyId={companyId} rowId={panel.rowId} onPaid={() => setPayablesVersion((v) => v + 1)} />
          )}
        </div>
      </div>
    </>
  );
}

function TerminTab({ companyId, contracts, loading, onIssued }: {
  companyId: number; contracts: readonly Contract[]; loading: boolean; onIssued: (inv: { id: number; number: string; totalCents: number; dueDate: string }) => void;
}) {
  const [chosen, setChosen] = useState<number>();
  const contract = contracts.find((k) => k.id === chosen) ?? contracts[0];
  if (loading) return <Loading what="kontrak" />;
  if (!contract) return <div className="empty">Belum ada kontrak.</div>;
  return (
    <>
      <div className="filters">
        <label className="chip"><span>Kontrak</span>
          <select value={contract.id} onChange={(e) => setChosen(Number(e.target.value))}>
            {contracts.map((k) => <option key={k.id} value={k.id}>{k.number} — {k.employerName}</option>)}
          </select>
        </label>
      </div>
      <TermsOfContract key={contract.id} companyId={companyId} contractId={contract.id} onIssued={onIssued} />
    </>
  );
}

function TermsOfContract({ companyId, contractId, onIssued }: {
  companyId: number; contractId: number; onIssued: (inv: { id: number; number: string; totalCents: number; dueDate: string }) => void;
}) {
  const status = useAsync(() => api.termsStatus(companyId, contractId), [companyId, contractId]);
  const [invoiceDate, setInvoiceDate] = useState(todayWib());
  const [busy, setBusy] = useState(false);
  const [note, setNote] = useState<Note>();
  const s = status.data;
  const next = s ? nextBillable(s.terms, s.actualMicroPct) : null;

  const issue = async (e: FormEvent) => {
    e.preventDefault();
    if (!next?.ready) return;
    if (!invoiceDate) { setNote({ tone: 'error', text: 'Tanggal tagihan wajib diisi.' }); return; }
    setBusy(true);
    setNote(undefined);
    try {
      const inv = await api.issueTermInvoice(companyId, { contractId, termId: next.term.id, invoiceDate });
      status.reload();
      onIssued(inv);
    } catch (err) {
      setNote(errorNote(err));
    } finally {
      setBusy(false);
    }
  };

  return (
    <>
      <Notice note={note} />
      {status.error && <ErrorNotice error={status.error} onRetry={status.reload} />}
      {status.loading && !s && <Loading what="termin" />}
      {s && s.terms.length === 0 && <div className="empty">Kontrak ini belum punya jadwal termin. Atur di halaman kontrak.</div>}
      {s && s.terms.length > 0 && (
        <>
          <p className="small">Progres fisik disetujui: <b>{percentMicro(s.actualMicroPct)}</b></p>
          <div className="table-wrap">
            <table>
              <thead><tr><th>#</th><th>Termin</th><th className="num">Porsi</th><th className="num">Ambang progres</th><th>Status</th></tr></thead>
              <tbody>
                {s.terms.map((t) => (
                  <tr key={t.id}>
                    <td>{t.seq}</td>
                    <td>{t.name}</td>
                    <td className="num">{percentBp(t.percentBp)}</td>
                    <td className="num">{percentBp(t.triggerProgressBp)}</td>
                    <td>
                      {t.invoiced ? <Pill tone="green">Ditagih {t.invoiceNumber}</Pill>
                        : t.reached ? <Pill tone="amber">Siap ditagih</Pill> : <Pill>Belum tercapai</Pill>}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          {!next && <p className="small muted">Semua termin sudah ditagih.</p>}
          {next && (
            <form onSubmit={(e) => void issue(e)}>
              <fieldset disabled={busy}>
                <label className="field"><span>Tanggal tagihan</span>
                  <input type="date" value={invoiceDate} onChange={(e) => setInvoiceDate(e.target.value)} required />
                </label>
                {next.reason && <p className="small muted">{next.reason}</p>}
                <p className="small muted">Nilai (DPP, potongan uang muka, retensi, PPN) dihitung server dari kontrak dan adendum yang berlaku; jatuh tempo {next.term.dueDays} hari.</p>
                <div className="actions">
                  <button type="submit" className="btn primary" disabled={!next.ready}>Terbitkan tagihan termin {next.term.seq}</button>
                </div>
              </fieldset>
            </form>
          )}
        </>
      )}
    </>
  );
}

/** `invoice` comes from the page's list (there is no single-invoice GET); onChanged reloads that list. */
function InvoiceDetail({ companyId, id, invoice, contractNo, onChanged }: {
  companyId: number; id: number; invoice: AsyncState<SalesInvoice[]>; contractNo: (id: number) => string; onChanged: (text?: string) => void;
}) {
  const pays = useAsync(() => api.payments(companyId, 'sales_invoices', id), [companyId, id]);
  const [busy, setBusy] = useState(false);
  const [note, setNote] = useState<Note>();
  const d = invoice.data?.find((i) => i.id === id);
  const balance = d && pays.data ? balanceAfter(d.totalCents, pays.data) : null;

  const cancel = async () => {
    if (!d || !window.confirm(`Batalkan ${d.number}? Termin ini bisa ditagih ulang.`)) return;
    setBusy(true);
    setNote(undefined);
    try {
      await api.cancelSalesInvoice(companyId, id);
      onChanged(`${d.number} dibatalkan.`);
    } catch (err) {
      setNote(errorNote(err));
    } finally {
      setBusy(false);
    }
  };

  return (
    <Card title={d?.number ?? 'Tagihan'} eyebrow={d ? contractNo(d.contractId) : undefined}>
      <Notice note={note} />
      {invoice.error && <ErrorNotice error={invoice.error} onRetry={invoice.reload} />}
      {invoice.loading && !d && <Loading what="tagihan" />}
      {invoice.data && !d && <div className="empty">Tagihan tidak ditemukan.</div>}
      {d && (
        <>
          <p className="small">
            <Pill tone={INVOICE_TONE[d.status]}>{INVOICE_LABEL[d.status]}</Pill> · {dateLabel(d.invoiceDate)} · jatuh tempo {dateLabel(d.dueDate)}
            {' '}· progres saat terbit {percentMicro(d.progressMicroPct)}
          </p>
          <table>
            <tbody>
              {invoiceLines(d).map((l, k, all) => (
                <tr key={l.label} className={k === all.length - 1 ? 'total' : ''}>
                  <td>{k === all.length - 1 ? <b>{l.label}</b> : l.label}</td>
                  <td className="num">{k === all.length - 1 ? <b>{rupiah(l.cents)}</b> : rupiah(l.cents)}</td>
                </tr>
              ))}
            </tbody>
          </table>
          <h3>Pembayaran</h3>
          <PaymentsList pays={pays} />
          {balance !== null && d.status !== 'cancelled' && <p className="small">Sisa tagihan: <b>{rupiah(balance)}</b></p>}
          {balance !== null && balance > 0 && (d.status === 'issued' || d.status === 'partial') && (
            <PaymentFormView companyId={companyId} target={{ payableType: 'sales_invoices', rowRef: id }} balanceCents={balance} label="Catat pembayaran masuk"
              onPaid={(text) => { pays.reload(); onChanged(text); }} />
          )}
          {cancellable(d) && (
            <div className="actions">
              <button type="button" className="btn danger" disabled={busy} onClick={() => void cancel()}>Batalkan tagihan</button>
            </div>
          )}
        </>
      )}
    </Card>
  );
}

function PaymentsList({ pays }: { pays: AsyncState<Payment[]> }) {
  if (pays.error) return <ErrorNotice error={pays.error} onRetry={pays.reload} />;
  if (pays.loading && !pays.data) return <Loading what="pembayaran" />;
  if (!pays.data || pays.data.length === 0) return <p className="small muted">Belum ada pembayaran.</p>;
  return (
    <div className="table-wrap">
      <table>
        <thead><tr><th>Tanggal</th><th>Cara</th><th className="num">Jumlah</th></tr></thead>
        <tbody>
          {pays.data.map((p) => (
            <tr key={p.id}>
              <td>{dateLabel(p.paidAt)}</td>
              <td>{METHOD_LABEL[p.method]}{p.reference && <div className="small muted">{p.reference}</div>}</td>
              <td className="num">{rupiah(p.amountCents)}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

/** One form = one Idempotency-Key: a double click or a retry after a lost answer records the payment once. */
function PaymentFormView({ companyId, target, balanceCents, label, onPaid }: {
  companyId: number; target: PaymentTarget; balanceCents: number; label: string; onPaid: (text: string) => void;
}) {
  const [form, setForm] = useState<PaymentForm>(emptyPayment(todayWib()));
  const [key, setKey] = useState(() => crypto.randomUUID());
  const [busy, setBusy] = useState(false);
  const [note, setNote] = useState<Note>();
  const setField = (k: keyof PaymentForm, v: string) => setForm((f) => ({ ...f, [k]: v }));

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    const built = paymentBody(form, target, balanceCents);
    if (!built.ok) { setNote({ tone: 'error', text: built.error }); return; }
    setBusy(true);
    setNote(undefined);
    try {
      const p = await api.recordPayment(companyId, built.body, key);
      setForm(emptyPayment(todayWib()));
      setKey(crypto.randomUUID());
      onPaid(p.replayed
        ? `Pembayaran ini sudah tercatat sebelumnya; sisa ${rupiah(p.balanceCents)}.`
        : `Pembayaran ${rupiah(p.amountCents)} dicatat; sisa ${rupiah(p.balanceCents)}.`);
    } catch (err) {
      setNote(errorNote(err));
    } finally {
      setBusy(false);
    }
  };

  return (
    <form onSubmit={(e) => void submit(e)}>
      <h3>{label}</h3>
      <Notice note={note} />
      <fieldset disabled={busy}>
        <label className="field"><span>Tanggal bayar</span>
          <input type="date" value={form.paidAt} onChange={(e) => setField('paidAt', e.target.value)} required />
        </label>
        <label className="field"><span>Jumlah (Rp)</span>
          <input type="text" inputMode="decimal" value={form.amount} placeholder={rupiah(balanceCents)} onChange={(e) => setField('amount', e.target.value)} />
        </label>
        <label className="field"><span>Cara bayar</span>
          <select value={form.method} onChange={(e) => setField('method', e.target.value as PaymentMethod)}>
            {Object.entries(METHOD_LABEL).map(([m, l]) => <option key={m} value={m}>{l}</option>)}
          </select>
        </label>
        <label className="field"><span>Referensi</span>
          <input type="text" value={form.reference} maxLength={100} placeholder="no. bukti transfer / giro" onChange={(e) => setField('reference', e.target.value)} />
        </label>
        <label className="field"><span>Catatan</span>
          <input type="text" value={form.note} maxLength={2000} onChange={(e) => setField('note', e.target.value)} />
        </label>
        <div className="actions"><button type="submit" className="btn primary">Simpan pembayaran</button></div>
      </fieldset>
    </form>
  );
}

function ReceivablesTab({ companyId, contractNo, onOpen }: { companyId: number; contractNo: (id: number) => string; onOpen: (id: number) => void }) {
  const r = useAsync(() => api.receivables(companyId), [companyId]);
  if (r.error) return <ErrorNotice error={r.error} onRetry={r.reload} />;
  if (r.loading && !r.data) return <Loading what="piutang" />;
  if (!r.data) return null;
  return (
    <>
      <p className="small">Piutang terbuka: <b>{rupiah(r.data.totals.balanceCents)}</b></p>
      <div className="filters">
        {BUCKETS.map((b) => <span key={b} className="chip"><span>{AGING_LABEL[b]}</span> <b>{rupiah(r.data!.totals.buckets[b] ?? 0)}</b></span>)}
      </div>
      {r.data.data.length === 0 && <div className="empty">Tidak ada piutang terbuka.</div>}
      {r.data.data.length > 0 && (
        <div className="table-wrap">
          <table>
            <thead><tr><th>Nomor</th><th>Kontrak</th><th>Tanggal</th><th className="num">Umur</th><th className="num">Sisa</th></tr></thead>
            <tbody>
              {r.data.data.map((x) => (
                <tr key={x.id} className="selectable" tabIndex={0} onClick={() => onOpen(x.id)} onKeyDown={(e) => { if (e.key === 'Enter') onOpen(x.id); }}>
                  <td className="code">{x.number}</td>
                  <td className="small">{contractNo(x.contractId)}</td>
                  <td>{dateLabel(x.invoiceDate)}</td>
                  <td className="num">{x.ageDays} hari</td>
                  <td className="num">{rupiah(x.balanceCents)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </>
  );
}

function PayablesTab({ companyId, version, selected, onOpen }: { companyId: number; version: number; selected: string | undefined; onOpen: (rowId: string) => void }) {
  const r = useAsync(() => api.payables(companyId), [companyId, version]);
  if (r.error) return <ErrorNotice error={r.error} onRetry={r.reload} />;
  if (r.loading && !r.data) return <Loading what="hutang" />;
  if (!r.data) return null;
  return (
    <>
      <p className="small">
        Hutang ke vendor (nota terkonfirmasi): <b>{rupiah(r.data.totals.balanceCents)}</b>
        {r.data.totals.overdueCents > 0 && <> · <span className="t-red">lewat jatuh tempo {rupiah(r.data.totals.overdueCents)}</span></>}
      </p>
      {r.data.data.length === 0 && <div className="empty">Tidak ada nota vendor yang belum dibayar.</div>}
      {r.data.data.length > 0 && (
        <div className="table-wrap">
          <table>
            <thead><tr><th>Vendor</th><th>Tanggal</th><th>Jatuh tempo</th><th className="num">Sisa</th></tr></thead>
            <tbody>
              {r.data.data.map((x) => (
                <tr key={x.rowId} className={`selectable ${selected === x.rowId ? 'selected' : ''}`} tabIndex={0}
                  onClick={() => onOpen(x.rowId)} onKeyDown={(e) => { if (e.key === 'Enter') onOpen(x.rowId); }}>
                  <td>{x.vendorName ?? '—'}</td>
                  <td>{dateLabel(x.invoiceDate)}</td>
                  <td className={x.overdue ? 't-red' : ''}>{dateLabel(x.dueDate)}</td>
                  <td className="num">{rupiah(x.balanceCents)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </>
  );
}

function PayableDetail({ companyId, rowId, onPaid }: { companyId: number; rowId: string; onPaid: () => void }) {
  const list = useAsync(async () => (await api.payables(companyId)).data.find((p) => p.rowId === rowId) ?? null, [companyId, rowId]);
  const pays = useAsync(() => api.payments(companyId, 'vendor_invoices', rowId), [companyId, rowId]);
  const [flash, setFlash] = useState<Note>();
  const d = list.data;
  const balance = d && pays.data ? balanceAfter(d.totalCents, pays.data) : null;
  return (
    <Card title={d?.vendorName ?? 'Nota vendor'} eyebrow={d ? `jatuh tempo ${dateLabel(d.dueDate)}` : undefined}>
      <Notice note={flash} />
      {list.error && <ErrorNotice error={list.error} onRetry={list.reload} />}
      {list.loading && !d && <Loading what="nota" />}
      {list.data === null && <div className="empty">Nota ini sudah lunas atau tidak lagi terkonfirmasi.</div>}
      {d && (
        <>
          <p className="small">Nota {dateLabel(d.invoiceDate)} · jumlah <b>{rupiah(d.totalCents)}</b>{d.overdue && <> · <span className="t-red">lewat jatuh tempo</span></>}</p>
          <h3>Pembayaran</h3>
          <PaymentsList pays={pays} />
          {balance !== null && <p className="small">Sisa: <b>{rupiah(balance)}</b></p>}
          {balance !== null && balance > 0 && (
            <PaymentFormView companyId={companyId} target={{ payableType: 'vendor_invoices', rowRef: rowId }} balanceCents={balance} label="Catat pembayaran ke vendor"
              onPaid={(text) => { setFlash({ tone: 'ok', text }); pays.reload(); onPaid(); }} />
          )}
        </>
      )}
    </Card>
  );
}
