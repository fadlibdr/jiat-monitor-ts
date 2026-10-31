import { useState, type FormEvent } from 'react';
import { SCurve } from '../components/SCurve';
import { Card, ErrorNotice, Loading, Pill } from '../components/ui';
import { api } from '../lib/api';
import { currentMonthWib, monthLong, percentMicro, points, qtyLabel } from '../lib/format';
import {
  curvePoints, nextMonth, opnameBody, opnameRows, planRowsOf, rowMicro, scheduleBody, type OpnameRow, type PlanRow,
} from '../lib/progress';
import { useAsync } from '../lib/useAsync';
import type { BoqItem, Contract, ProgressReport, ProgressStatus } from '../lib/types';
import { errorNote, Notice, type Note } from './master/common';

const STATUS_LABEL: Record<ProgressStatus, string> = { draft: 'Draf', submitted: 'Diajukan', approved: 'Disetujui', rejected: 'Ditolak' };
const STATUS_TONE: Record<ProgressStatus, 'plain' | 'amber' | 'green' | 'red'> = { draft: 'plain', submitted: 'amber', approved: 'green', rejected: 'red' };

type Panel = { kind: 'new' } | { kind: 'report'; id: number } | { kind: 'plan' };

/**
 * Physical progress per contract (HLD §4 Progres): the S-curve (plan vs approved opname), the monthly
 * opname reports, and the plan. Site staff and admins write opname, managers approve it; admins and
 * managers set the plan. Only approved reports move the actual curve.
 */
export function Progress({ companyId, canReport, canPlan, canApprove }: { companyId: number; canReport: boolean; canPlan: boolean; canApprove: boolean }) {
  const contracts = useAsync(() => api.contracts(companyId), [companyId]);
  const [chosen, setChosen] = useState<number>();
  const list = contracts.data ?? [];
  const contract = list.find((k) => k.id === chosen) ?? list[0];

  return (
    <>
      <div className="page-head">
        <div className="eyebrow">Progres</div>
        <h1>Opname &amp; kurva S</h1>
      </div>
      {contracts.error && <ErrorNotice error={contracts.error} onRetry={contracts.reload} />}
      {contracts.loading && !contracts.data && <Loading what="kontrak" />}
      {contracts.data && list.length === 0 && <div className="empty">Belum ada kontrak yang bisa Anda lihat.</div>}
      {contract && (
        <>
          <div className="filters">
            <label className="chip"><span>Kontrak</span>
              <select value={contract.id} onChange={(e) => setChosen(Number(e.target.value))}>
                {list.map((k) => <option key={k.id} value={k.id}>{k.number} — {k.employerName}</option>)}
              </select>
            </label>
          </div>
          <ContractProgress key={contract.id} companyId={companyId} contract={contract} canReport={canReport} canPlan={canPlan} canApprove={canApprove} />
        </>
      )}
    </>
  );
}

function ContractProgress({ companyId, contract, canReport, canPlan, canApprove }: {
  companyId: number; contract: Contract; canReport: boolean; canPlan: boolean; canApprove: boolean;
}) {
  const boq = useAsync(() => api.boq(companyId, contract.id), [companyId, contract.id]);
  const curve = useAsync(() => api.sCurve(companyId, contract.id), [companyId, contract.id]);
  const reports = useAsync(() => api.progressReports(companyId, contract.id), [companyId, contract.id]);
  const [panel, setPanel] = useState<Panel>();
  const [flash, setFlash] = useState<Note>();
  const selectPanel = (p: Panel | undefined) => { setFlash(undefined); setPanel(p); };

  const items = boq.data?.items ?? [];
  const noBoq = boq.data === null;
  const selected = panel?.kind === 'report' ? reports.data?.find((r) => r.id === panel.id) : undefined;
  const pts = curve.data ? curvePoints(curve.data) : [];
  const latest = [...pts].reverse().find((p) => p.actualMicroPct !== null);
  const shownMonth = selected?.period ?? latest?.period ?? `${currentMonthWib()}-01`;

  return (
    <div className="review">
      <Card title="Kurva S" eyebrow={contract.number}>
        <Notice note={flash} />
        {curve.error && <ErrorNotice error={curve.error} onRetry={curve.reload} />}
        {curve.loading && !curve.data && <Loading what="kurva S" />}
        {curve.data && <SCurve points={pts} period={shownMonth} />}
        {latest && (
          <p className="small">
            Realisasi disetujui terakhir ({monthLong(latest.period)}): <b>{percentMicro(latest.actualMicroPct)}</b>
            {' '}· rencana {percentMicro(latest.plannedMicroPct)} · deviasi {points(latest.deviationMicroPct)} poin
          </p>
        )}
        {noBoq && <div className="notice">Kontrak ini belum punya BOQ. Impor BOQ di halaman kontrak dulu; rencana dan opname dicatat per item BOQ.</div>}
        {boq.error && <ErrorNotice error={boq.error} onRetry={boq.reload} />}
        {!noBoq && boq.data && (canReport || canPlan) && (
          <div className="actions">
            {canReport && <button type="button" className="btn" onClick={() => selectPanel({ kind: 'new' })}>Buat laporan opname</button>}
            {canPlan && <button type="button" className="btn" onClick={() => selectPanel({ kind: 'plan' })}>Ubah rencana</button>}
          </div>
        )}
        <h3>Laporan opname</h3>
        {reports.error && <ErrorNotice error={reports.error} onRetry={reports.reload} />}
        {reports.loading && !reports.data && <Loading what="laporan" />}
        {reports.data && reports.data.length === 0 && <div className="empty">Belum ada laporan opname.</div>}
        {reports.data && reports.data.length > 0 && (
          <div className="table-wrap">
            <table>
              <thead><tr><th>Periode</th><th>Status</th><th>Catatan</th></tr></thead>
              <tbody>
                {reports.data.map((r) => (
                  <tr key={r.id} className={`selectable ${panel?.kind === 'report' && panel.id === r.id ? 'selected' : ''}`} tabIndex={0}
                    onClick={() => selectPanel({ kind: 'report', id: r.id })} onKeyDown={(e) => { if (e.key === 'Enter') selectPanel({ kind: 'report', id: r.id }); }}>
                    <td>{monthLong(r.period)}</td>
                    <td><Pill tone={STATUS_TONE[r.status]}>{STATUS_LABEL[r.status]}</Pill></td>
                    <td className="small">{r.note ?? ''}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </Card>
      <div className="detail">
        {!panel && <Card><div className="empty">Pilih laporan untuk melihat atau mengisi opname.</div></Card>}
        {panel?.kind === 'new' && (
          <NewReport companyId={companyId} contractId={contract.id} existing={reports.data ?? []}
            onOpen={(id) => selectPanel({ kind: 'report', id })}
            onSaved={(r) => { reports.reload(); setPanel({ kind: 'report', id: r.id }); setFlash({ tone: 'ok', text: `Laporan ${monthLong(r.period)} dibuat (draf). Isi progres per item, lalu ajukan.` }); }} />
        )}
        {panel?.kind === 'report' && boq.data && (
          <ReportDetail key={panel.id} companyId={companyId} id={panel.id} items={items} canReport={canReport} canApprove={canApprove}
            onChanged={() => { setFlash(undefined); reports.reload(); curve.reload(); }} />
        )}
        {panel?.kind === 'plan' && boq.data && (
          <PlanEditor companyId={companyId} contractId={contract.id} items={items}
            onSaved={(text) => { curve.reload(); setFlash({ tone: 'ok', text }); setPanel(undefined); }} />
        )}
      </div>
    </div>
  );
}

function NewReport({ companyId, contractId, existing, onOpen, onSaved }: {
  companyId: number; contractId: number; existing: readonly ProgressReport[]; onOpen: (id: number) => void; onSaved: (r: ProgressReport) => void;
}) {
  const [month, setMonth] = useState(currentMonthWib());
  const [text, setText] = useState('');
  const [busy, setBusy] = useState(false);
  const [note, setNote] = useState<Note>();
  const already = existing.find((r) => r.period.slice(0, 7) === month);

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    if (!month) { setNote({ tone: 'error', text: 'Pilih bulan laporan.' }); return; }
    if (already) return;
    setBusy(true);
    try {
      onSaved(await api.createProgressReport(companyId, { contractId, period: month, ...(text.trim() ? { note: text.trim() } : {}) }));
    } catch (err) {
      setNote(errorNote(err));
    } finally {
      setBusy(false);
    }
  };
  return (
    <Card title="Laporan opname baru">
      <Notice note={note} />
      <form onSubmit={(e) => void submit(e)}>
        <fieldset disabled={busy}>
          <label className="field"><span>Bulan</span>
            <input type="month" value={month} onChange={(e) => setMonth(e.target.value)} required />
          </label>
          {already && (
            <p className="small">
              Laporan {monthLong(already.period)} sudah ada ({STATUS_LABEL[already.status]}).{' '}
              <button type="button" className="btn" onClick={() => onOpen(already.id)}>Buka laporan itu</button>
            </p>
          )}
          <label className="field"><span>Catatan</span>
            <input type="text" value={text} maxLength={2000} onChange={(e) => setText(e.target.value)} />
          </label>
          <p className="small muted">Satu laporan per kontrak per bulan. Progres diisi kumulatif sampai akhir bulan.</p>
          <div className="actions"><button type="submit" className="btn primary" disabled={!!already}>Buat draf</button></div>
        </fieldset>
      </form>
    </Card>
  );
}

function ReportDetail({ companyId, id, items, canReport, canApprove, onChanged }: {
  companyId: number; id: number; items: readonly BoqItem[]; canReport: boolean; canApprove: boolean; onChanged: () => void;
}) {
  const report = useAsync(() => api.progressReport(companyId, id), [companyId, id]);
  const d = report.data;
  return (
    <Card title={d ? `Opname ${monthLong(d.period)}` : 'Laporan opname'}>
      {report.error && <ErrorNotice error={report.error} onRetry={report.reload} />}
      {report.loading && !d && <Loading what="laporan" />}
      {d && (
        <OpnameEditor companyId={companyId} id={id} status={d.status} note={d.note}
          initial={opnameRows(items, d.items)} canReport={canReport} canApprove={canApprove}
          onChanged={() => { report.reload(); onChanged(); }} />
      )}
    </Card>
  );
}

/** Mounted once the report is loaded, so typing is never overwritten by a reload after saving. */
function OpnameEditor({ companyId, id, status, note: reportNote, initial, canReport, canApprove, onChanged }: {
  companyId: number; id: number; status: ProgressStatus; note: string | null; initial: OpnameRow[]; canReport: boolean; canApprove: boolean; onChanged: () => void;
}) {
  const [rows, setRows] = useState(initial);
  const [dirty, setDirty] = useState(false);
  const [filter, setFilter] = useState('');
  const [busy, setBusy] = useState(false);
  const [note, setNote] = useState<Note>();
  const editable = canReport && (status === 'draft' || status === 'rejected');
  const q = filter.trim().toLowerCase();
  const shown = rows.filter((r) => !q || r.code.toLowerCase().includes(q) || r.description.toLowerCase().includes(q));
  const reported = rows.filter((r) => r.value.trim()).length;
  const edit = (code: string, value: string) => { setDirty(true); setRows((rs) => rs.map((r) => (r.code === code ? { ...r, value } : r))); };

  /** save (when changed), then the workflow action, as one click */
  const run = async (action: 'save' | 'submit' | 'approve' | 'reject') => {
    setNote(undefined);
    const built = action === 'save' || (action === 'submit' && dirty) ? opnameBody(rows) : null;
    if (built && !built.ok) { setNote({ tone: 'error', text: built.error }); return; }
    setBusy(true);
    try {
      if (built?.ok) { await api.putProgressItems(companyId, id, built.body); setDirty(false); }
      if (action !== 'save') await api.progressAction(companyId, id, action);
      const done = { save: 'Progres disimpan.', submit: 'Laporan diajukan untuk persetujuan.', approve: 'Laporan disetujui; kurva S diperbarui.', reject: 'Laporan ditolak; pelapor bisa memperbaikinya.' };
      setNote({ tone: 'ok', text: done[action] });
      onChanged();
    } catch (err) {
      setNote(errorNote(err));
    } finally {
      setBusy(false);
    }
  };

  return (
    <>
      <Notice note={note} />
      <p className="small">
        <Pill tone={STATUS_TONE[status]}>{STATUS_LABEL[status]}</Pill> · {reported} dari {rows.length} item diisi
        {reportNote && <> · {reportNote}</>}
      </p>
      {rows.length > 10 && (
        <label className="field"><span>Cari item</span>
          <input type="search" value={filter} onChange={(e) => setFilter(e.target.value)} placeholder="kode atau uraian" />
        </label>
      )}
      <div className="table-wrap">
        <table>
          <thead><tr><th>Item</th><th className="num">Kumulatif</th><th className="num">%</th></tr></thead>
          <tbody>
            {shown.map((r) => (
              <tr key={r.code}>
                <td>
                  <span className="code">{r.code}</span> {r.description}
                  <div className="small muted">{r.qty === null ? 'diisi dalam %' : `volume BOQ ${qtyLabel(r.qty)} ${r.unit ?? ''}`}</div>
                </td>
                <td className="num">
                  {editable
                    ? <input className="num" type="text" inputMode="decimal" aria-label={`Progres ${r.code}`} value={r.value}
                        placeholder={r.mode === 'qty' ? 'volume' : '%'} onChange={(e) => edit(r.code, e.target.value)} />
                    : r.value ? `${r.value}${r.mode === 'pct' ? ' %' : ` ${r.unit ?? ''}`}` : '—'}
                </td>
                <td className="num">{percentMicro(rowMicro(r))}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      {editable && <p className="small muted">Kosongkan item yang tidak diukur bulan ini. Progres kumulatif tidak boleh turun dari bulan yang sudah disetujui.</p>}
      <div className="actions">
        {editable && (
          <>
            <button type="button" className="btn" disabled={busy || !dirty} onClick={() => void run('save')}>Simpan</button>
            <button type="button" className="btn primary" disabled={busy} onClick={() => void run('submit')}>Ajukan</button>
          </>
        )}
        {canApprove && status === 'submitted' && (
          <>
            <button type="button" className="btn primary" disabled={busy} onClick={() => void run('approve')}>Setujui</button>
            <button type="button" className="btn danger" disabled={busy} onClick={() => void run('reject')}>Tolak</button>
          </>
        )}
      </div>
      {!canApprove && status === 'submitted' && <p className="small muted">Menunggu persetujuan manajer.</p>}
    </>
  );
}

function PlanEditor({ companyId, contractId, items, onSaved }: {
  companyId: number; contractId: number; items: readonly BoqItem[]; onSaved: (text: string) => void;
}) {
  const leafCodes = items.filter((i) => i.isLeaf).map((i) => i.code);
  const schedule = useAsync(() => api.schedule(companyId, contractId), [companyId, contractId]);
  return (
    <Card title="Rencana (kurva S)">
      {schedule.error && <ErrorNotice error={schedule.error} onRetry={schedule.reload} />}
      {schedule.loading && !schedule.data && <Loading what="rencana" />}
      {schedule.data && <PlanForm companyId={companyId} contractId={contractId} leafCodes={leafCodes} start={planRowsOf(schedule.data, leafCodes)} onSaved={onSaved} />}
    </Card>
  );
}

function PlanForm({ companyId, contractId, leafCodes, start, onSaved }: {
  companyId: number; contractId: number; leafCodes: readonly string[]; start: { rows: PlanRow[]; tooLarge: boolean }; onSaved: (text: string) => void;
}) {
  const [rows, setRows] = useState<PlanRow[]>(start.rows.length ? start.rows : [{ code: '', month: currentMonthWib(), pct: '' }]);
  const [busy, setBusy] = useState(false);
  const [note, setNote] = useState<Note>();
  const edit = (i: number, k: keyof PlanRow, v: string) => setRows((rs) => rs.map((r, j) => (j === i ? { ...r, [k]: v } : r)));
  const addMonth = () => setRows((rs) => {
    const last = rs[rs.length - 1];
    return [...rs, { code: last?.code ?? '', month: last ? nextMonth(last.month) : currentMonthWib(), pct: '' }];
  });

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    const built = scheduleBody(rows, leafCodes);
    if (!built.ok) { setNote({ tone: 'error', text: built.error }); return; }
    setBusy(true);
    try {
      const r = await api.putSchedule(companyId, contractId, built.body);
      onSaved(`Rencana disimpan: ${r.items} item BOQ, ${r.points} titik item × bulan.`);
    } catch (err) {
      setNote(errorNote(err));
      setBusy(false);
    }
  };

  return (
    <form onSubmit={(e) => void submit(e)}>
      <Notice note={note} />
      {start.tooLarge && <div className="notice">Rencana per item tersimpan terlalu besar untuk diubah di sini; kurva S tetap memakainya. Menyimpan formulir ini menggantinya seluruhnya.</div>}
      <p className="small muted">
        Rencana kumulatif (%) di akhir tiap bulan. Kode kosong = berlaku untuk semua item (kurva S tingkat kontrak); isi kode untuk
        rencana item tertentu, yang menimpa baris kosong pada bulan yang sama. Menyimpan mengganti seluruh rencana.
      </p>
      <fieldset disabled={busy}>
        <datalist id="plan-codes">{leafCodes.map((c) => <option key={c} value={c} />)}</datalist>
        <div className="table-wrap">
          <table>
            <thead><tr><th>Kode item</th><th>Bulan</th><th className="num">Rencana kumulatif %</th><th /></tr></thead>
            <tbody>
              {rows.map((r, i) => (
                <tr key={i}>
                  <td><input type="text" list="plan-codes" value={r.code} placeholder="semua item" aria-label={`Kode baris ${i + 1}`} onChange={(e) => edit(i, 'code', e.target.value)} /></td>
                  <td><input type="month" value={r.month} aria-label={`Bulan baris ${i + 1}`} onChange={(e) => edit(i, 'month', e.target.value)} /></td>
                  <td className="num"><input className="num" type="text" inputMode="decimal" value={r.pct} aria-label={`Rencana baris ${i + 1}`} onChange={(e) => edit(i, 'pct', e.target.value)} /></td>
                  <td><button type="button" className="btn" aria-label={`Hapus baris ${i + 1}`} onClick={() => setRows((rs) => rs.filter((_, j) => j !== i))}>×</button></td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
        <div className="actions">
          <button type="button" className="btn" onClick={addMonth}>Tambah bulan</button>
          <button type="submit" className="btn primary">Simpan rencana</button>
        </div>
      </fieldset>
    </form>
  );
}
