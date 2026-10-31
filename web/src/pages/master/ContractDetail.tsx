import { useState, type FormEvent } from 'react';
import { Card, ErrorNotice, Kpi, Loading } from '../../components/ui';
import { api, ApiError } from '../../lib/api';
import { bpInput, decimalCents } from '../../lib/forms';
import { dateLabel, percentBp, percentMicro, qtyLabel, rupiah } from '../../lib/format';
import { CATEGORY_LABEL } from '../../lib/labels';
import {
  addendumBody, contractFormOf, contractPatchOf, emptyAddendum, termRowsOf, termsBody, type AddendumForm, type ContractForm, type TermRow,
} from '../../lib/master';
import { Link } from '../../lib/router';
import { useAsync } from '../../lib/useAsync';
import type { BoqItem, Category, ContractDetail as Detail } from '../../lib/types';
import { errorNote, Notice, type Note } from './common';
import { ContractDateFields, ContractMoneyFields } from './Contracts';

type Tab = 'data' | 'termin' | 'addendum' | 'boq';

/** "207600050.00" → "Rp 207.600.050"; anything else as it came */
const moneyText = (decimal: string) => {
  const cents = decimalCents(decimal);
  return cents === null ? decimal : rupiah(cents);
};
const TABS: Array<{ id: Tab; label: string }> = [
  { id: 'data', label: 'Data kontrak' }, { id: 'termin', label: 'Termin' }, { id: 'addendum', label: 'Addendum' }, { id: 'boq', label: 'BOQ / RAB' },
];

/** One contract: its data, termin schedule, addenda and BOQ (import + cost categories). */
export function ContractDetail({ companyId, contractId, canEdit }: { companyId: number; contractId: number; canEdit: boolean }) {
  const detail = useAsync(() => api.contract(companyId, contractId), [companyId, contractId]);
  const [tab, setTab] = useState<Tab>('data');
  const k = detail.data;

  return (
    <>
      <div className="page-head">
        <div className="eyebrow"><Link to={`/c/${companyId}/contracts`}>Kontrak</Link> › {k?.number ?? '…'}</div>
        <h1>{k ? k.employerName : 'Kontrak'}</h1>
      </div>
      {detail.error && <ErrorNotice error={detail.error} onRetry={detail.reload} />}
      {detail.loading && !k && <Loading what="kontrak" />}
      {k && (
        <>
          <div className="grid g4">
            <Kpi label="Nilai DPP berlaku" value={rupiah(k.valueDppEffectiveCents)} sub={k.addendumDeltaCents ? `termasuk addendum ${rupiah(k.addendumDeltaCents)}` : 'sesuai kontrak'} />
            <Kpi label="Dengan PPN" value={rupiah(k.valueTotalCents)} sub={`PPN ${percentBp(k.ppnRateBp)}`} />
            <Kpi label="Selesai" value={dateLabel(k.endDateEffective)} sub={k.daysLeft === null ? '—' : `sisa ${k.daysLeft} hari`} />
            <Kpi label="Termin" value={`${k.terms.length}`} sub={k.termsComplete ? 'jadwal lengkap (100%)' : 'jadwal belum 100%'} subTone={k.termsComplete ? 'green' : 'amber'} />
          </div>
          <Card>
            <div className="tabs" role="tablist" aria-label="Bagian kontrak">
              {TABS.map((t) => <button key={t.id} type="button" role="tab" aria-selected={tab === t.id} onClick={() => setTab(t.id)}>{t.label}</button>)}
            </div>
            {tab === 'data' && <DataTab key={`d${k.id}`} companyId={companyId} k={k} canEdit={canEdit} onSaved={detail.reload} />}
            {tab === 'termin' && <TermsTab key={`t${k.id}`} companyId={companyId} k={k} canEdit={canEdit} onSaved={detail.reload} />}
            {tab === 'addendum' && <AddendumTab companyId={companyId} k={k} canEdit={canEdit} onSaved={detail.reload} />}
            {tab === 'boq' && <BoqTab companyId={companyId} k={k} canEdit={canEdit} />}
          </Card>
        </>
      )}
    </>
  );
}

function DataTab({ companyId, k, canEdit, onSaved }: { companyId: number; k: Detail; canEdit: boolean; onSaved: () => void }) {
  const [form, setForm] = useState<ContractForm>(() => contractFormOf(k));
  const set = (key: keyof ContractForm, v: string) => setForm((f) => ({ ...f, [key]: v }));
  const [busy, setBusy] = useState(false);
  const [note, setNote] = useState<Note>();

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    const built = contractPatchOf(k, form);
    if (!built.ok) { setNote({ tone: 'error', text: built.error }); return; }
    setBusy(true);
    setNote(undefined);
    try {
      await api.patchContract(companyId, k.id, built.body);
      setNote({ tone: 'ok', text: 'Data kontrak disimpan.' });
      onSaved();
    } catch (err) {
      setNote(errorNote(err));
    } finally {
      setBusy(false);
    }
  };

  return (
    <form onSubmit={submit} className="narrow">
      <Notice note={note} />
      <p className="small muted">Nilai DPP kontrak ({rupiah(k.valueDppCents)} saat tanda tangan) hanya berubah lewat addendum.</p>
      <fieldset disabled={!canEdit || busy} className="plain">
        <label className="field"><span>Pemberi kerja</span>
          <input type="text" value={form.employerName} maxLength={200} required onChange={(e) => set('employerName', e.target.value)} />
        </label>
        <ContractMoneyFields form={form} set={set} withDpp={false} />
        <ContractDateFields form={form} set={set} />
        {canEdit && <div className="actions"><button type="submit" className="btn primary">Simpan</button></div>}
      </fieldset>
    </form>
  );
}

const emptyTerm = (): TermRow => ({ name: '', percent: '', trigger: '', dueDays: '30' });

/** The whole schedule is saved at once; rows in screen order are termin 1, 2, … */
function TermsTab({ companyId, k, canEdit, onSaved }: { companyId: number; k: Detail; canEdit: boolean; onSaved: () => void }) {
  const [rows, setRows] = useState<TermRow[]>(() => termRowsOf(k.terms));
  const [busy, setBusy] = useState(false);
  const [note, setNote] = useState<Note>();
  const edit = (i: number, key: keyof TermRow, v: string) => setRows((rs) => rs.map((r, j) => (j === i ? { ...r, [key]: v } : r)));
  const built = termsBody(rows);
  const totalBp = built.ok ? built.body.reduce((s, t) => s + t.percentBp, 0) : null;

  const save = async () => {
    if (!built.ok) { setNote({ tone: 'error', text: built.error }); return; }
    setBusy(true);
    setNote(undefined);
    try {
      const r = await api.putTerms(companyId, k.id, built.body);
      setRows(termRowsOf(r.data));
      setNote(r.complete ? { tone: 'ok', text: 'Jadwal termin disimpan (lengkap 100%).' } : { tone: 'ok', text: `Jadwal termin disimpan; baru ${percentBp(r.totalBp)} dari nilai kontrak.` });
      onSaved();
    } catch (err) {
      // a termin already invoiced cannot be removed: the API answers 409
      setNote(errorNote(err));
    } finally {
      setBusy(false);
    }
  };

  return (
    <div>
      <Notice note={note} />
      <p className="small muted">Nilai tiap termin dihitung saat ditagih dari nilai DPP berlaku × persen; ambang progres = progres fisik tertimbang minimum untuk menagih.</p>
      <fieldset disabled={!canEdit || busy} className="plain">
        <div className="table-wrap">
          <table>
            <thead><tr><th>#</th><th>Nama</th><th className="num">Persen nilai</th><th className="num">Ambang progres</th><th className="num">Jatuh tempo (hari)</th>{canEdit && <th />}</tr></thead>
            <tbody>
              {rows.map((r, i) => (
                <tr key={i}>
                  <td>{i + 1}</td>
                  <td><input type="text" aria-label={`Nama termin ${i + 1}`} value={r.name} maxLength={100} onChange={(e) => edit(i, 'name', e.target.value)} /></td>
                  <td className="num"><input type="text" inputMode="decimal" className="mono small-input" aria-label={`Persen termin ${i + 1}`} value={r.percent} onChange={(e) => edit(i, 'percent', e.target.value)} />%</td>
                  <td className="num"><input type="text" inputMode="decimal" className="mono small-input" aria-label={`Ambang termin ${i + 1}`} value={r.trigger} onChange={(e) => edit(i, 'trigger', e.target.value)} />%</td>
                  <td className="num"><input type="text" inputMode="numeric" className="mono small-input" aria-label={`Jatuh tempo termin ${i + 1}`} value={r.dueDays} onChange={(e) => edit(i, 'dueDays', e.target.value)} /></td>
                  {canEdit && <td><button type="button" className="linkish" onClick={() => setRows((rs) => rs.filter((_, j) => j !== i))}>hapus</button></td>}
                </tr>
              ))}
            </tbody>
          </table>
        </div>
        <p className="small">
          Jumlah: <b>{totalBp === null ? '—' : `${bpInput(totalBp)}%`}</b>
          {totalBp !== null && totalBp < 10_000 && <span className="t-amber"> · kurang {bpInput(10_000 - totalBp)}%</span>}
          {!built.ok && rows.length > 0 && <span className="t-red"> · {built.error}</span>}
        </p>
        {canEdit && (
          <div className="actions">
            <button type="button" className="btn" onClick={() => setRows((rs) => [...rs, emptyTerm()])}>Tambah termin</button>
            <button type="button" className="btn primary" onClick={() => void save()}>Simpan jadwal</button>
          </div>
        )}
      </fieldset>
    </div>
  );
}

function AddendumTab({ companyId, k, canEdit, onSaved }: { companyId: number; k: Detail; canEdit: boolean; onSaved: () => void }) {
  const [form, setForm] = useState<AddendumForm>(emptyAddendum);
  const set = (key: keyof AddendumForm, v: string) => setForm((f) => ({ ...f, [key]: v }));
  const [busy, setBusy] = useState(false);
  const [note, setNote] = useState<Note>();

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    const built = addendumBody(form);
    if (!built.ok) { setNote({ tone: 'error', text: built.error }); return; }
    setBusy(true);
    setNote(undefined);
    try {
      const r = await api.addAddendum(companyId, k.id, built.body);
      setForm(emptyAddendum());
      setNote({ tone: 'ok', text: `Addendum ${r.addendum.number} dicatat; nilai DPP berlaku ${rupiah(r.contract.valueDppEffectiveCents)}.` });
      onSaved();
    } catch (err) {
      setNote(errorNote(err));
    } finally {
      setBusy(false);
    }
  };

  return (
    <div>
      {k.addendums.length === 0 ? <div className="empty">Belum ada addendum.</div> : (
        <div className="table-wrap">
          <table>
            <thead><tr><th>Nomor</th><th>Tanggal</th><th className="num">Perubahan nilai</th><th>Selesai baru</th><th>Catatan</th></tr></thead>
            <tbody>
              {k.addendums.map((a) => (
                <tr key={a.id}>
                  <td className="code">{a.number}</td>
                  <td>{dateLabel(a.signedAt)}</td>
                  <td className={`num ${a.valueDeltaCents < 0 ? 't-red' : ''}`}>{a.valueDeltaCents ? rupiah(a.valueDeltaCents) : '—'}</td>
                  <td>{dateLabel(a.endDateNew)}</td>
                  <td>{a.note ?? ''}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
      {canEdit && (
        <form onSubmit={submit} className="narrow" style={{ marginTop: 16 }}>
          <h2 className="h3">Catat addendum</h2>
          <Notice note={note} />
          <fieldset disabled={busy} className="plain">
            <div className="row2">
              <label className="field"><span>Nomor addendum</span>
                <input type="text" value={form.number} maxLength={100} required onChange={(e) => set('number', e.target.value)} />
              </label>
              <label className="field"><span>Tanggal tanda tangan</span>
                <input type="date" value={form.signedAt} required onChange={(e) => set('signedAt', e.target.value)} />
              </label>
            </div>
            <div className="row2">
              <label className="field"><span>Perubahan nilai DPP (Rp; minus = kurang)</span>
                <input type="text" inputMode="decimal" className="mono" value={form.delta} placeholder="1.200.000.000" onChange={(e) => set('delta', e.target.value)} />
              </label>
              <label className="field"><span>Tanggal selesai baru</span>
                <input type="date" value={form.endDateNew} onChange={(e) => set('endDateNew', e.target.value)} />
              </label>
            </div>
            <label className="field"><span>Catatan</span>
              <input type="text" value={form.note} maxLength={2000} onChange={(e) => set('note', e.target.value)} />
            </label>
            <div className="actions"><button type="submit" className="btn primary">Catat addendum</button></div>
          </fieldset>
        </form>
      )}
    </div>
  );
}

/**
 * The BOQ in force and a new import. An import is refused whole (nothing written) unless Σ items =
 * the DPP in force exactly; the server's reason is shown as is. Categories can be corrected per item
 * and are kept by code on later imports.
 */
function BoqTab({ companyId, k, canEdit }: { companyId: number; k: Detail; canEdit: boolean }) {
  const boq = useAsync(() => api.boq(companyId, k.id), [companyId, k.id]);
  const [file, setFile] = useState<File>();
  const [sheet, setSheet] = useState('RAB');
  const [busy, setBusy] = useState(false);
  const [note, setNote] = useState<Note>();

  const upload = async (e: FormEvent) => {
    e.preventDefault();
    if (!file) { setNote({ tone: 'error', text: 'Pilih berkas .xlsx.' }); return; }
    setBusy(true);
    setNote(undefined);
    try {
      const s = await api.importBoq(companyId, k.id, file, sheet.trim() || 'RAB');
      setNote({
        tone: 'ok',
        text: `BOQ versi ${s.version} diimpor: ${s.items} baris, ${s.leaves} item, total ${moneyText(s.total)} (= nilai kontrak).`,
        detail: s.anomalies.slice(0, 20).map((a) => `baris ${a.row}: ${a.detail}`),
      });
      boq.reload();
    } catch (err) {
      const sheets = err instanceof ApiError ? (err.body as { details?: { sheets?: unknown } } | null)?.details?.sheets : undefined;
      setNote({ ...errorNote(err), ...(Array.isArray(sheets) ? { detail: [`Sheet yang ada: ${sheets.join(', ')}`] } : {}) });
    } finally {
      setBusy(false);
    }
  };

  return (
    <div>
      {canEdit && (
        <form onSubmit={upload} className="narrow">
          <h2 className="h3">Impor RAB (.xlsx)</h2>
          <Notice note={note} />
          <fieldset disabled={busy} className="plain">
            <div className="row2">
              <label className="field"><span>Berkas</span>
                <input type="file" accept=".xlsx,application/vnd.openxmlformats-officedocument.spreadsheetml.sheet" onChange={(e) => setFile(e.target.files?.[0])} />
              </label>
              <label className="field"><span>Nama sheet</span>
                <input type="text" value={sheet} maxLength={64} onChange={(e) => setSheet(e.target.value)} />
              </label>
            </div>
            <p className="small muted">Total item harus sama persis dengan nilai DPP berlaku ({rupiah(k.valueDppEffectiveCents)}); jika tidak, tidak ada yang disimpan.</p>
            <div className="actions"><button type="submit" className="btn primary">{busy ? 'Mengimpor…' : 'Impor'}</button></div>
          </fieldset>
        </form>
      )}
      {boq.error && <ErrorNotice error={boq.error} onRetry={boq.reload} />}
      {boq.loading && boq.data === undefined && <Loading what="BOQ" />}
      {boq.data === null && <div className="empty">Belum ada BOQ untuk kontrak ini.</div>}
      {boq.data && (
        <>
          <p className="small">
            Versi <b>{boq.data.version.version}</b>{boq.data.version.sourceFilename ? ` · ${boq.data.version.sourceFilename}` : ''} · total {rupiah(boq.data.version.totalCents)}
            {boq.data.version.anomalies.length > 0 && <span className="t-amber"> · {boq.data.version.anomalies.length} catatan impor</span>}
          </p>
          <div className="table-wrap">
            <table>
              <thead><tr><th>Kode</th><th>Uraian</th><th>Sat.</th><th className="num">Volume</th><th className="num">Jumlah</th><th className="num">Bobot</th><th>Kategori</th></tr></thead>
              <tbody>
                {boq.data.items.map((it) => <BoqRow key={it.id} companyId={companyId} contractId={k.id} item={it} canEdit={canEdit} />)}
              </tbody>
            </table>
          </div>
        </>
      )}
    </div>
  );
}

/** One BOQ line; a changed category is saved at once (and kept by code on re-import). */
function BoqRow({ companyId, contractId, item, canEdit }: { companyId: number; contractId: number; item: BoqItem; canEdit: boolean }) {
  const [category, setCategory] = useState<Category | ''>(item.category ?? '');
  const [state, setState] = useState<'idle' | 'saving' | 'saved' | 'error'>('idle');
  const change = async (next: Category | '') => {
    const before = category;
    setCategory(next);
    setState('saving');
    try {
      await api.setBoqCategory(companyId, contractId, item.id, next || null);
      setState('saved');
    } catch {
      setCategory(before); // the server kept the old one: show what is stored
      setState('error');
    }
  };
  return (
    <tr className={item.isLeaf ? '' : 'section'}>
      <td className="code" style={{ paddingLeft: 8 + item.level * 12 }}>{item.codePrinted ?? item.code}</td>
      <td>{item.description}</td>
      <td>{item.unit ?? ''}</td>
      <td className="num mono">{qtyLabel(item.qty)}</td>
      <td className="num">{rupiah(item.amountCents)}</td>
      <td className="num">{item.isLeaf ? percentMicro(item.weightMicroPct) : ''}</td>
      <td>
        {canEdit ? (
          <select aria-label={`Kategori ${item.code}`} value={category} disabled={state === 'saving'} onChange={(e) => void change(e.target.value as Category | '')}>
            <option value="">—</option>
            {(Object.keys(CATEGORY_LABEL) as Category[]).map((c) => <option key={c} value={c}>{CATEGORY_LABEL[c]}</option>)}
          </select>
        ) : (category ? CATEGORY_LABEL[category] : '—')}
        {state === 'error' && <span className="t-red small"> gagal</span>}
        {state === 'saved' && <span className="t-green small"> ✓</span>}
      </td>
    </tr>
  );
}
