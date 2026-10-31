import { useState, type FormEvent } from 'react';
import { Card, ErrorNotice, Loading, Pill } from '../components/ui';
import { api } from '../lib/api';
import { dateLabel, qtyLabel, rupiah } from '../lib/format';
import { emptyLine, grBody, lineTotalCents, poBody, poFormFromPr, prBody, receiptRows, type LineForm, type PoForm, type PrForm } from '../lib/procurement';
import { useAsync } from '../lib/useAsync';
import type { Contract, PoStatus, PrStatus, PurchaseOrderDetail, PurchaseRequestDetail, Site, Vendor } from '../lib/types';
import { errorNote, Notice, type Note } from './master/common';

const PR_LABEL: Record<PrStatus, string> = { draft: 'Draf', submitted: 'Diajukan', approved: 'Disetujui', rejected: 'Ditolak', closed: 'Sudah jadi PO' };
const PR_TONE: Record<PrStatus, 'plain' | 'amber' | 'green' | 'red'> = { draft: 'plain', submitted: 'amber', approved: 'green', rejected: 'red', closed: 'plain' };
const PO_LABEL: Record<PoStatus, string> = { draft: 'Draf', issued: 'Terbit', partial: 'Diterima sebagian', received: 'Diterima', cancelled: 'Dibatalkan' };
const PO_TONE: Record<PoStatus, 'plain' | 'amber' | 'green' | 'red'> = { draft: 'plain', issued: 'amber', partial: 'amber', received: 'green', cancelled: 'red' };

/** "2026-10" (WIB month) is not a date; today in WIB as "YYYY-MM-DD" */
const todayWib = () => new Date(Date.now() + 7 * 3_600_000).toISOString().slice(0, 10);

type Lookups = { sites: Site[]; vendors: Vendor[]; contracts: Contract[] };
type Panel = { kind: 'new-pr' } | { kind: 'new-po'; from?: PoForm } | { kind: 'pr'; id: number } | { kind: 'po'; id: number };

/**
 * PR → PO → GR (HLD §4). Admins write and receive; managers approve a PR, approve (issue) or cancel a
 * PO. Amounts and "more than ordered" use the server's own quantity code (lib/procurement.ts).
 */
export function Procurement({ companyId, canEdit, canApprove }: { companyId: number; canEdit: boolean; canApprove: boolean }) {
  const [tab, setTab] = useState<'pr' | 'po'>('pr');
  const [panel, setPanel] = useState<Panel>();
  const [flash, setFlash] = useState<Note>();
  const lookups = useAsync(async (): Promise<Lookups> => {
    const [sites, vendors, contracts] = await Promise.all([api.sites(companyId), api.vendors(companyId), api.contracts(companyId)]);
    return { sites, vendors, contracts };
  }, [companyId]);
  const prs = useAsync(() => api.purchaseRequests(companyId), [companyId]);
  const pos = useAsync(() => api.purchaseOrders(companyId), [companyId]);
  const lk = lookups.data ?? { sites: [], vendors: [], contracts: [] };
  const siteName = (id: number) => lk.sites.find((s) => s.id === id)?.name ?? `#${id}`;
  const vendorName = (id: number) => lk.vendors.find((v) => v.id === id)?.name ?? `#${id}`;
  const open = (p: Panel | undefined) => { setFlash(undefined); setPanel(p); };

  return (
    <>
      <div className="page-head">
        <div className="eyebrow">Pembelian</div>
        <h1>Permintaan &amp; pesanan</h1>
      </div>
      <div className="review">
        <Card>
          <div className="tabs" role="tablist" aria-label="Dokumen">
            <button type="button" role="tab" aria-selected={tab === 'pr'} onClick={() => { setTab('pr'); open(undefined); }}>Permintaan (PR)</button>
            <button type="button" role="tab" aria-selected={tab === 'po'} onClick={() => { setTab('po'); open(undefined); }}>Pesanan (PO)</button>
          </div>
          <Notice note={flash} />
          {tab === 'pr' && (
            <>
              {canEdit && <p><button type="button" className="btn" onClick={() => open({ kind: 'new-pr' })}>Buat PR</button></p>}
              {prs.error && <ErrorNotice error={prs.error} onRetry={prs.reload} />}
              {prs.loading && !prs.data && <Loading what="PR" />}
              {prs.data && prs.data.length === 0 && <div className="empty">Belum ada permintaan pembelian.</div>}
              {prs.data && prs.data.length > 0 && (
                <div className="table-wrap">
                  <table>
                    <thead><tr><th>Nomor</th><th>Lokasi</th><th>Dibutuhkan</th><th>Status</th></tr></thead>
                    <tbody>
                      {prs.data.map((p) => (
                        <tr key={p.id} className={`selectable ${panel?.kind === 'pr' && panel.id === p.id ? 'selected' : ''}`} tabIndex={0}
                          onClick={() => open({ kind: 'pr', id: p.id })} onKeyDown={(e) => { if (e.key === 'Enter') open({ kind: 'pr', id: p.id }); }}>
                          <td className="code">{p.number}</td>
                          <td>{siteName(p.siteId)}</td>
                          <td>{dateLabel(p.neededBy)}</td>
                          <td><Pill tone={PR_TONE[p.status]}>{PR_LABEL[p.status]}</Pill></td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              )}
            </>
          )}
          {tab === 'po' && (
            <>
              {canEdit && <p><button type="button" className="btn" onClick={() => open({ kind: 'new-po' })}>Buat PO</button></p>}
              {pos.error && <ErrorNotice error={pos.error} onRetry={pos.reload} />}
              {pos.loading && !pos.data && <Loading what="PO" />}
              {pos.data && pos.data.length === 0 && <div className="empty">Belum ada pesanan pembelian.</div>}
              {pos.data && pos.data.length > 0 && (
                <div className="table-wrap">
                  <table>
                    <thead><tr><th>Nomor</th><th>Vendor</th><th>Lokasi</th><th>Tanggal</th><th className="num">Total</th><th>Status</th></tr></thead>
                    <tbody>
                      {pos.data.map((p) => (
                        <tr key={p.id} className={`selectable ${panel?.kind === 'po' && panel.id === p.id ? 'selected' : ''}`} tabIndex={0}
                          onClick={() => open({ kind: 'po', id: p.id })} onKeyDown={(e) => { if (e.key === 'Enter') open({ kind: 'po', id: p.id }); }}>
                          <td className="code">{p.number}</td>
                          <td>{vendorName(p.vendorId)}</td>
                          <td>{siteName(p.siteId)}</td>
                          <td>{dateLabel(p.orderDate)}</td>
                          <td className="num">{rupiah(p.totalCents)}</td>
                          <td><Pill tone={PO_TONE[p.status]}>{PO_LABEL[p.status]}</Pill></td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              )}
            </>
          )}
        </Card>
        <div className="detail">
          {!panel && <Card><div className="empty">Pilih dokumen, atau buat yang baru.</div></Card>}
          {panel?.kind === 'new-pr' && (
            <NewPr companyId={companyId} lk={lk} onSaved={(id, number) => { prs.reload(); setPanel({ kind: 'pr', id }); setFlash({ tone: 'ok', text: `${number} dibuat (draf).` }); }} />
          )}
          {panel?.kind === 'new-po' && (
            <NewPo key={panel.from?.prId ?? 'blank'} companyId={companyId} lk={lk} initial={panel.from}
              onSaved={(id, number) => { pos.reload(); prs.reload(); setTab('po'); setPanel({ kind: 'po', id }); setFlash({ tone: 'ok', text: `${number} dibuat (draf, menunggu persetujuan).` }); }} />
          )}
          {panel?.kind === 'pr' && (
            <PrDetail key={panel.id} companyId={companyId} id={panel.id} lk={lk} canEdit={canEdit} canApprove={canApprove}
              onChanged={prs.reload} onMakePo={(pr) => { setTab('po'); open({ kind: 'new-po', from: poFormFromPr(pr, todayWib()) }); }} />
          )}
          {panel?.kind === 'po' && (
            <PoDetail key={panel.id} companyId={companyId} id={panel.id} lk={lk} canEdit={canEdit} canApprove={canApprove} onChanged={() => { pos.reload(); prs.reload(); }} />
          )}
        </div>
      </div>
    </>
  );
}

/** BOQ leaves of a contract, for tying a line to a BOQ item (commitment vs budget); none without a contract. */
function useBoqLeaves(companyId: number, contractId: string) {
  const boq = useAsync(() => (contractId ? api.boq(companyId, Number(contractId)) : Promise.resolve(null)), [companyId, contractId]);
  return (boq.data?.items ?? []).filter((i) => i.isLeaf);
}

function LinesEditor({ lines, setLines, boqLeaves, priceLabel }: {
  lines: LineForm[]; setLines: (f: (ls: LineForm[]) => LineForm[]) => void; boqLeaves: Array<{ id: number; code: string; description: string }>; priceLabel: string;
}) {
  const edit = (i: number, k: keyof LineForm, v: string) => setLines((ls) => ls.map((l, j) => (j === i ? { ...l, [k]: v } : l)));
  const total = lines.reduce<number | null>((s, l) => { const t = lineTotalCents(l); return s === null || t === null ? null : s + t; }, 0);
  return (
    <div>
      <div className="table-wrap">
        <table>
          <thead><tr><th>Uraian</th>{boqLeaves.length > 0 && <th>Item BOQ</th>}<th className="num">Volume</th><th>Sat.</th><th className="num">{priceLabel}</th><th className="num">Jumlah</th><th /></tr></thead>
          <tbody>
            {lines.map((l, i) => {
              const t = lineTotalCents(l);
              return (
                <tr key={i}>
                  <td><input type="text" aria-label={`Uraian ${i + 1}`} value={l.description} maxLength={500} onChange={(e) => edit(i, 'description', e.target.value)} /></td>
                  {boqLeaves.length > 0 && (
                    <td>
                      <select aria-label={`Item BOQ ${i + 1}`} value={l.boqItemId} onChange={(e) => edit(i, 'boqItemId', e.target.value)}>
                        <option value="">— tidak —</option>
                        {boqLeaves.map((b) => <option key={b.id} value={b.id}>{b.code} {b.description}</option>)}
                      </select>
                    </td>
                  )}
                  <td className="num"><input type="text" inputMode="decimal" className="mono small-input" aria-label={`Volume ${i + 1}`} value={l.qty} onChange={(e) => edit(i, 'qty', e.target.value)} /></td>
                  <td><input type="text" className="small-input" aria-label={`Satuan ${i + 1}`} value={l.unit} maxLength={20} onChange={(e) => edit(i, 'unit', e.target.value)} /></td>
                  <td className="num"><input type="text" inputMode="decimal" className="mono" aria-label={`Harga ${i + 1}`} value={l.price} onChange={(e) => edit(i, 'price', e.target.value)} /></td>
                  <td className="num">{t === null ? '—' : rupiah(t)}</td>
                  <td><button type="button" className="linkish" onClick={() => setLines((ls) => ls.filter((_, j) => j !== i))}>hapus</button></td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
      <p className="small">
        <button type="button" className="btn" onClick={() => setLines((ls) => [...ls, emptyLine()])}>Tambah baris</button>
        {' '}Jumlah (DPP): <b>{total === null ? '—' : rupiah(total)}</b>
      </p>
    </div>
  );
}

function NewPr({ companyId, lk, onSaved }: { companyId: number; lk: Lookups; onSaved: (id: number, number: string) => void }) {
  const [form, setForm] = useState<PrForm>(() => ({ siteId: lk.sites.length === 1 ? String(lk.sites[0]!.id) : '', contractId: '', neededBy: '', note: '', lines: [emptyLine()] }));
  const set = (k: 'siteId' | 'contractId' | 'neededBy' | 'note', v: string) => setForm((f) => ({ ...f, [k]: v }));
  const leaves = useBoqLeaves(companyId, form.contractId);
  const [busy, setBusy] = useState(false);
  const [note, setNote] = useState<Note>();
  const contracts = lk.contracts.filter((k) => !form.siteId || String(k.siteId) === form.siteId);

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    const built = prBody(form);
    if (!built.ok) { setNote({ tone: 'error', text: built.error }); return; }
    setBusy(true);
    try {
      const pr = await api.createPr(companyId, built.body);
      onSaved(pr.id, pr.number);
    } catch (err) {
      setNote(errorNote(err));
      setBusy(false);
    }
  };

  return (
    <Card title="Permintaan pembelian baru">
      <Notice note={note} />
      <form onSubmit={submit}>
        <fieldset disabled={busy} className="plain">
          <div className="row2">
            <label className="field"><span>Lokasi</span>
              <select value={form.siteId} onChange={(e) => { set('siteId', e.target.value); set('contractId', ''); }}>
                <option value="">— pilih —</option>
                {lk.sites.map((s) => <option key={s.id} value={s.id}>{s.name}</option>)}
              </select>
            </label>
            <label className="field"><span>Kontrak (untuk item BOQ)</span>
              <select value={form.contractId} onChange={(e) => set('contractId', e.target.value)}>
                <option value="">— tanpa kontrak —</option>
                {contracts.map((k) => <option key={k.id} value={k.id}>{k.number}</option>)}
              </select>
            </label>
          </div>
          <label className="field"><span>Dibutuhkan tanggal</span>
            <input type="date" value={form.neededBy} onChange={(e) => set('neededBy', e.target.value)} />
          </label>
          <LinesEditor lines={form.lines} setLines={(f) => setForm((x) => ({ ...x, lines: f(x.lines) }))} boqLeaves={leaves} priceLabel="Perkiraan harga" />
          <label className="field"><span>Catatan</span>
            <input type="text" value={form.note} maxLength={2000} onChange={(e) => set('note', e.target.value)} />
          </label>
          <div className="actions"><button type="submit" className="btn primary">Simpan draf</button></div>
        </fieldset>
      </form>
    </Card>
  );
}

function NewPo({ companyId, lk, initial, onSaved }: { companyId: number; lk: Lookups; initial: PoForm | undefined; onSaved: (id: number, number: string) => void }) {
  const [form, setForm] = useState<PoForm>(() => initial ?? {
    siteId: lk.sites.length === 1 ? String(lk.sites[0]!.id) : '', vendorId: '', contractId: '', orderDate: todayWib(), expectedDate: '', note: '', lines: [emptyLine()],
  });
  const set = (k: 'siteId' | 'vendorId' | 'contractId' | 'orderDate' | 'expectedDate' | 'note', v: string) => setForm((f) => ({ ...f, [k]: v }));
  const leaves = useBoqLeaves(companyId, form.contractId);
  const [busy, setBusy] = useState(false);
  const [note, setNote] = useState<Note>();
  const contracts = lk.contracts.filter((k) => !form.siteId || String(k.siteId) === form.siteId);

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    const built = poBody(form);
    if (!built.ok) { setNote({ tone: 'error', text: built.error }); return; }
    setBusy(true);
    try {
      const po = await api.createPo(companyId, built.body);
      onSaved(po.id, po.number);
    } catch (err) {
      setNote(errorNote(err));
      setBusy(false);
    }
  };

  return (
    <Card title={initial?.prId ? 'PO dari permintaan' : 'Pesanan pembelian baru'}>
      <Notice note={note} />
      <form onSubmit={submit}>
        <fieldset disabled={busy} className="plain">
          <div className="row2">
            <label className="field"><span>Lokasi</span>
              <select value={form.siteId} disabled={Boolean(initial?.prId)} onChange={(e) => { set('siteId', e.target.value); set('contractId', ''); }}>
                <option value="">— pilih —</option>
                {lk.sites.map((s) => <option key={s.id} value={s.id}>{s.name}</option>)}
              </select>
            </label>
            <label className="field"><span>Vendor</span>
              <select value={form.vendorId} onChange={(e) => set('vendorId', e.target.value)}>
                <option value="">— pilih —</option>
                {lk.vendors.filter((v) => v.status === 'active').map((v) => <option key={v.id} value={v.id}>{v.name}</option>)}
              </select>
            </label>
          </div>
          <label className="field"><span>Kontrak (untuk item BOQ)</span>
            <select value={form.contractId} onChange={(e) => set('contractId', e.target.value)}>
              <option value="">— tanpa kontrak —</option>
              {contracts.map((k) => <option key={k.id} value={k.id}>{k.number}</option>)}
            </select>
          </label>
          <div className="row2">
            <label className="field"><span>Tanggal PO</span>
              <input type="date" value={form.orderDate} required onChange={(e) => set('orderDate', e.target.value)} />
            </label>
            <label className="field"><span>Perkiraan kirim</span>
              <input type="date" value={form.expectedDate} min={form.orderDate || undefined} onChange={(e) => set('expectedDate', e.target.value)} />
            </label>
          </div>
          <LinesEditor lines={form.lines} setLines={(f) => setForm((x) => ({ ...x, lines: f(x.lines) }))} boqLeaves={leaves} priceLabel="Harga satuan" />
          <p className="small muted">Nilai PO dihitung server (volume × harga, PPN dari tarif PO); draf ini perlu disetujui manajer sebelum terbit.</p>
          <label className="field"><span>Catatan</span>
            <input type="text" value={form.note} maxLength={2000} onChange={(e) => set('note', e.target.value)} />
          </label>
          <div className="actions"><button type="submit" className="btn primary">Simpan draf PO</button></div>
        </fieldset>
      </form>
    </Card>
  );
}

function PrDetail({ companyId, id, lk, canEdit, canApprove, onChanged, onMakePo }: {
  companyId: number; id: number; lk: Lookups; canEdit: boolean; canApprove: boolean; onChanged: () => void; onMakePo: (pr: PurchaseRequestDetail) => void;
}) {
  const pr = useAsync(() => api.purchaseRequest(companyId, id), [companyId, id]);
  const [busy, setBusy] = useState(false);
  const [note, setNote] = useState<Note>();
  const act = async (action: 'submit' | 'approve' | 'reject', done: string) => {
    setBusy(true);
    setNote(undefined);
    try {
      await api.prAction(companyId, id, action);
      setNote({ tone: 'ok', text: done });
      pr.reload();
      onChanged();
    } catch (err) {
      setNote(errorNote(err));
    } finally {
      setBusy(false);
    }
  };
  const d = pr.data;
  return (
    <Card title={d?.number ?? 'Permintaan'} eyebrow={d ? lk.sites.find((s) => s.id === d.siteId)?.name : undefined}>
      <Notice note={note} />
      {pr.error && <ErrorNotice error={pr.error} onRetry={pr.reload} />}
      {pr.loading && !d && <Loading what="PR" />}
      {d && (
        <>
          <p className="small">
            <Pill tone={PR_TONE[d.status]}>{PR_LABEL[d.status]}</Pill>
            {d.neededBy && <> · dibutuhkan {dateLabel(d.neededBy)}</>}
            {d.contractId && <> · kontrak {lk.contracts.find((k) => k.id === d.contractId)?.number ?? `#${d.contractId}`}</>}
          </p>
          <div className="table-wrap">
            <table>
              <thead><tr><th>Uraian</th><th className="num">Volume</th><th>Sat.</th><th className="num">Perkiraan harga</th></tr></thead>
              <tbody>
                {d.items.map((i) => (
                  <tr key={i.id}><td>{i.description}</td><td className="num mono">{qtyLabel(i.qty)}</td><td>{i.unit ?? ''}</td><td className="num">{i.estPriceCents === null ? '—' : rupiah(i.estPriceCents)}</td></tr>
                ))}
              </tbody>
            </table>
          </div>
          {d.note && <p className="small muted">{d.note}</p>}
          <div className="actions">
            {canEdit && (d.status === 'draft' || d.status === 'rejected') && (
              <button type="button" className="btn primary" disabled={busy} onClick={() => void act('submit', 'PR diajukan untuk persetujuan.')}>Ajukan</button>
            )}
            {canApprove && d.status === 'submitted' && (
              <>
                <button type="button" className="btn primary" disabled={busy} onClick={() => void act('approve', 'PR disetujui.')}>Setujui</button>
                <button type="button" className="btn danger" disabled={busy} onClick={() => void act('reject', 'PR ditolak.')}>Tolak</button>
              </>
            )}
            {canEdit && d.status === 'approved' && <button type="button" className="btn primary" onClick={() => onMakePo(d)}>Buat PO dari PR ini</button>}
          </div>
          {!canApprove && d.status === 'submitted' && <p className="small muted">Menunggu persetujuan manajer.</p>}
        </>
      )}
    </Card>
  );
}

function PoDetail({ companyId, id, lk, canEdit, canApprove, onChanged }: {
  companyId: number; id: number; lk: Lookups; canEdit: boolean; canApprove: boolean; onChanged: () => void;
}) {
  const po = useAsync(() => api.purchaseOrder(companyId, id), [companyId, id]);
  const receipts = useAsync(() => api.goodsReceipts(companyId, id), [companyId, id]);
  const [busy, setBusy] = useState(false);
  const [note, setNote] = useState<Note>();
  const act = async (action: 'approve' | 'cancel', done: string) => {
    if (action === 'cancel' && !window.confirm('Batalkan PO ini? Komitmen anggarannya dilepas.')) return;
    setBusy(true);
    setNote(undefined);
    try {
      await api.poAction(companyId, id, action);
      setNote({ tone: 'ok', text: done });
      po.reload();
      onChanged();
    } catch (err) {
      setNote(errorNote(err));
    } finally {
      setBusy(false);
    }
  };
  const d = po.data;
  const canReceive = canEdit && d && (d.status === 'issued' || d.status === 'partial');
  return (
    <Card title={d?.number ?? 'Pesanan'} eyebrow={d ? lk.vendors.find((v) => v.id === d.vendorId)?.name : undefined}>
      <Notice note={note} />
      {po.error && <ErrorNotice error={po.error} onRetry={po.reload} />}
      {po.loading && !d && <Loading what="PO" />}
      {d && (
        <>
          <p className="small">
            <Pill tone={PO_TONE[d.status]}>{PO_LABEL[d.status]}</Pill> · {dateLabel(d.orderDate)} · {lk.sites.find((s) => s.id === d.siteId)?.name}
          </p>
          <div className="table-wrap">
            <table>
              <thead><tr><th>Uraian</th><th className="num">Dipesan</th><th className="num">Diterima</th><th>Sat.</th><th className="num">Harga</th><th className="num">Jumlah</th></tr></thead>
              <tbody>
                {d.items.map((i) => (
                  <tr key={i.id}>
                    <td>{i.description}</td><td className="num mono">{qtyLabel(i.qty)}</td><td className="num mono">{qtyLabel(i.qtyReceived)}</td>
                    <td>{i.unit ?? ''}</td><td className="num">{rupiah(i.unitPriceCents)}</td><td className="num">{rupiah(i.amountCents)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          <p className="small">DPP {rupiah(d.dppCents)} · PPN {rupiah(d.ppnCents)} · <b>Total {rupiah(d.totalCents)}</b></p>
          <div className="actions">
            {canApprove && d.status === 'draft' && <button type="button" className="btn primary" disabled={busy} onClick={() => void act('approve', 'PO disetujui dan terbit.')}>Setujui &amp; terbitkan</button>}
            {canApprove && (d.status === 'draft' || d.status === 'issued') && <button type="button" className="btn danger" disabled={busy} onClick={() => void act('cancel', 'PO dibatalkan.')}>Batalkan</button>}
          </div>
          {!canApprove && d.status === 'draft' && <p className="small muted">Menunggu persetujuan manajer.</p>}
          {canReceive && (
            <ReceiveForm key={`${d.id}:${d.status}:${receipts.data?.length ?? 0}`} companyId={companyId} po={d}
              onReceived={(number) => { setNote({ tone: 'ok', text: `Penerimaan ${number} disimpan.` }); po.reload(); receipts.reload(); onChanged(); }} />
          )}
          {(receipts.data?.length ?? 0) > 0 && (
            <>
              <h2 className="h3">Penerimaan</h2>
              <ul className="small">{receipts.data!.map((g) => <li key={g.id}><span className="mono">{g.number}</span> · {dateLabel(g.receivedAt)}{g.note ? ` · ${g.note}` : ''}</li>)}</ul>
            </>
          )}
        </>
      )}
    </Card>
  );
}

/** A goods receipt: per line what arrived (starts at what is still to come). One key per form, so a resubmit cannot receive twice. */
function ReceiveForm({ companyId, po, onReceived }: { companyId: number; po: PurchaseOrderDetail; onReceived: (grNumber: string) => void }) {
  const rows = receiptRows(po);
  const [typed, setTyped] = useState<Record<number, string>>(() => Object.fromEntries(rows.map((r) => [r.poItemId, r.remaining === '0' ? '' : r.remaining])));
  const [receivedAt, setReceivedAt] = useState(todayWib());
  const [memo, setMemo] = useState('');
  const [key] = useState(() => crypto.randomUUID());
  const [busy, setBusy] = useState(false);
  const [note, setNote] = useState<Note>();

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    const built = grBody(po, typed, receivedAt, memo);
    if (!built.ok) { setNote({ tone: 'error', text: built.error }); return; }
    setBusy(true);
    try {
      const gr = await api.receive(companyId, po.id, built.body, key);
      onReceived(gr.number); // the form remounts (new key) for the next delivery
    } catch (err) {
      setNote(errorNote(err));
      setBusy(false);
    }
  };

  return (
    <form onSubmit={submit} style={{ marginTop: 14 }}>
      <h2 className="h3">Terima barang</h2>
      <Notice note={note} />
      <fieldset disabled={busy} className="plain">
        <div className="table-wrap">
          <table>
            <thead><tr><th>Uraian</th><th className="num">Sisa</th><th className="num">Diterima sekarang</th></tr></thead>
            <tbody>
              {rows.map((r) => (
                <tr key={r.poItemId}>
                  <td>{r.description}</td>
                  <td className="num mono">{r.remaining} {r.unit ?? ''}</td>
                  <td className="num"><input type="text" inputMode="decimal" className="mono small-input" aria-label={`Diterima ${r.description}`} value={typed[r.poItemId] ?? ''}
                    disabled={r.remaining === '0'} onChange={(e) => setTyped((t) => ({ ...t, [r.poItemId]: e.target.value }))} /></td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
        <div className="row2">
          <label className="field"><span>Tanggal terima</span>
            <input type="date" value={receivedAt} required onChange={(e) => setReceivedAt(e.target.value)} />
          </label>
          <label className="field"><span>Catatan (mis. no. surat jalan)</span>
            <input type="text" value={memo} maxLength={2000} onChange={(e) => setMemo(e.target.value)} />
          </label>
        </div>
        <div className="actions"><button type="submit" className="btn primary">Simpan penerimaan</button></div>
      </fieldset>
    </form>
  );
}
