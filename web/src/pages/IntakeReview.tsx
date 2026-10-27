import { useEffect, useMemo, useState, type FormEvent } from 'react';
import { Card, ErrorNotice, Loading, Pill } from '../components/ui';
import { api, ApiError } from '../lib/api';
import { amountPlain, dateLabel, rupiah, shortRef } from '../lib/format';
import { CATEGORY_LABEL, FLAG_TEXT, INTAKE_STATUS_LABEL as STATUS_LABEL } from '../lib/labels';
import { useAsync } from '../lib/useAsync';
import type { Category, CompanyRole, IntakePatch, IntakeRow, IntakeStatus, Site, Vendor } from '../lib/types';

const STATUS_TONE: Record<IntakeStatus, 'amber' | 'red' | 'green' | 'plain'> = {
  perlu_konfirmasi: 'amber', perlu_cek: 'red', terkonfirmasi: 'green', ditolak: 'plain',
};
const TABS: Array<{ status: IntakeStatus | undefined; label: string }> = [
  { status: undefined, label: 'Terbuka' },
  { status: 'perlu_cek', label: 'Perlu cek' },
  { status: 'perlu_konfirmasi', label: 'Perlu konfirmasi' },
  { status: 'terkonfirmasi', label: 'Terkonfirmasi' },
  { status: 'ditolak', label: 'Ditolak' },
];
/** Who may change a row (server: EDIT_ROLES on PATCH); finance reviews read-only. */
const EDIT_ROLES: readonly CompanyRole[] = ['project_admin', 'company_manager', 'system_admin'];

/** LLD §7 IntakeReview: rows the bot could not settle, with the photo, the flags and the same corrections as in chat. */
export function IntakeReview({ companyId, role }: { companyId: number; role: CompanyRole }) {
  const [tab, setTab] = useState<IntakeStatus | undefined>(undefined);
  const [siteId, setSiteId] = useState<number>();
  const [rows, setRows] = useState<IntakeRow[]>([]);
  const [cursor, setCursor] = useState<string | null>(null);
  const [more, setMore] = useState<{ busy: boolean; error?: Error }>({ busy: false });
  const [selected, setSelected] = useState<string>();
  const canEdit = EDIT_ROLES.includes(role);

  const lookups = useAsync(() => Promise.all([api.sites(companyId), api.vendors(companyId)]), [companyId]);
  const first = useAsync(() => api.intakeReview(companyId, { status: tab, siteId }), [companyId, tab, siteId]);
  useEffect(() => {
    if (!first.data) return;
    setRows(first.data.data);
    setCursor(first.data.nextCursor);
    setSelected((s) => (s && first.data!.data.some((r) => r.rowId === s) ? s : first.data!.data[0]?.rowId));
  }, [first.data]);

  const loadMore = async () => {
    if (!cursor) return;
    setMore({ busy: true });
    try {
      const page = await api.intakeReview(companyId, { status: tab, siteId, cursor });
      setRows((rs) => [...rs, ...page.data]);
      setCursor(page.nextCursor);
      setMore({ busy: false });
    } catch (e) {
      setMore({ busy: false, error: e instanceof Error ? e : new Error(String(e)) });
    }
  };

  const [sites, vendors] = lookups.data ?? [[], []];
  const siteName = useMemo(() => new Map(sites.map((s) => [s.id, s.name])), [sites]);
  const row = rows.find((r) => r.rowId === selected);

  /** A saved row: replace it, or drop it from an "open" list once it is closed. */
  const onSaved = (r: IntakeRow) => {
    const stillListed = tab === undefined ? r.status === 'perlu_konfirmasi' || r.status === 'perlu_cek' : r.status === tab;
    setRows((rs) => (stillListed ? rs.map((x) => (x.rowId === r.rowId ? r : x)) : rs.filter((x) => x.rowId !== r.rowId)));
    if (!stillListed) {
      const i = rows.findIndex((x) => x.rowId === r.rowId);
      setSelected(rows[i + 1]?.rowId ?? rows[i - 1]?.rowId);
    }
  };

  return (
    <>
      <div className="page-head">
        <div className="eyebrow">Intake lapangan</div>
        <h1>Review nota</h1>
      </div>
      <div className="filters">
        <label className="chip"><span>Lokasi</span>
          <select value={siteId ?? ''} onChange={(e) => setSiteId(e.target.value ? Number(e.target.value) : undefined)}>
            <option value="">Semua ({sites.length})</option>
            {sites.map((s) => <option key={s.id} value={s.id}>{s.name}</option>)}
          </select>
        </label>
        {!canEdit && <span className="pill blue plain">Peran Anda hanya dapat melihat</span>}
      </div>

      <div className="review">
        <Card>
          <div className="tabs" role="tablist" aria-label="Status nota">
            {TABS.map((t) => (
              <button key={t.label} type="button" role="tab" aria-selected={tab === t.status} onClick={() => { setTab(t.status); setSelected(undefined); }}>{t.label}</button>
            ))}
          </div>
          {first.error && <ErrorNotice error={first.error} onRetry={first.reload} />}
          {first.loading && rows.length === 0 && <Loading what="nota" />}
          {!first.loading && rows.length === 0 && !first.error && <div className="empty">Tidak ada nota pada daftar ini.</div>}
          {rows.length > 0 && (
            <div className="table-wrap">
              <table>
                <thead><tr><th>Ref</th><th>Lokasi</th><th>Vendor</th><th>Tanggal</th><th className="num">Total</th><th>Status</th></tr></thead>
                <tbody>
                  {rows.map((r) => (
                    <tr
                      key={r.rowId}
                      className={`selectable ${r.rowId === selected ? 'selected' : ''}`}
                      onClick={() => setSelected(r.rowId)}
                      onKeyDown={(e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); setSelected(r.rowId); } }}
                      tabIndex={0}
                      aria-selected={r.rowId === selected}
                    >
                      <td className="code">{shortRef(r.rowId)}</td>
                      <td>{siteName.get(r.siteId) ?? `#${r.siteId}`}</td>
                      <td>{r.vendorName ?? <span className="muted">belum terbaca</span>}</td>
                      <td>{dateLabel(r.invoiceDate)}</td>
                      <td className="num">{rupiah(r.totalCents)}</td>
                      <td><Pill tone={STATUS_TONE[r.status]}>{STATUS_LABEL[r.status]}</Pill></td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
          {more.error && <ErrorNotice error={more.error} onRetry={loadMore} />}
          {cursor && (
            <p><button type="button" className="btn ghost" onClick={loadMore} disabled={more.busy}>{more.busy ? 'Memuat…' : 'Muat lagi'}</button></p>
          )}
        </Card>

        <div className="detail">
          {row
            ? <RowDetail key={`${row.rowId}:${row.status}`} companyId={companyId} row={row} sites={sites} vendors={vendors} canEdit={canEdit} onSaved={onSaved} />
            : <Card><div className="empty">Pilih nota untuk melihat foto dan memperbaikinya.</div></Card>}
        </div>
      </div>
    </>
  );
}

function RowDetail({ companyId, row, sites, vendors, canEdit, onSaved }: {
  companyId: number; row: IntakeRow; sites: Site[]; vendors: Vendor[]; canEdit: boolean; onSaved: (r: IntakeRow) => void;
}) {
  const closed = row.status === 'terkonfirmasi' || row.status === 'ditolak';
  const [vendorId, setVendorId] = useState(row.vendorId ? String(row.vendorId) : '');
  const [vendorName, setVendorName] = useState(row.vendorName ?? '');
  const [invoiceDate, setInvoiceDate] = useState(row.invoiceDate ?? '');
  const [dueDate, setDueDate] = useState(row.dueDate ?? '');
  const [total, setTotal] = useState(amountPlain(row.totalCents));
  const [docNumber, setDocNumber] = useState(row.docNumber ?? '');
  const [category, setCategory] = useState<Category | ''>(row.category ?? '');
  const [busy, setBusy] = useState(false);
  const [result, setResult] = useState<{ tone: 'ok' | 'error'; text: string; flags?: string[] }>();
  const [photoFailed, setPhotoFailed] = useState(false);
  const flags = row.confidence.flags ?? [];
  const readOnly = !canEdit || closed;

  /** Only the fields the reviewer changed, as the API expects. */
  const changes = (): IntakePatch => {
    const p: IntakePatch = {};
    if (vendorId && Number(vendorId) !== row.vendorId) p.vendorId = Number(vendorId);
    else if (!vendorId && vendorName.trim() && vendorName.trim() !== (row.vendorName ?? '')) p.vendorName = vendorName.trim();
    if (invoiceDate && invoiceDate !== row.invoiceDate) p.invoiceDate = invoiceDate;
    if (dueDate && dueDate !== row.dueDate) p.dueDate = dueDate;
    const typed = total.trim();
    if (typed && typed !== amountPlain(row.totalCents)) p.totalCents = typed; // the server parses "2.450.000" / "Rp 2.450.000,-"
    if (docNumber.trim() && docNumber.trim() !== (row.docNumber ?? '')) p.docNumber = docNumber.trim();
    if (category && category !== row.category) p.category = category;
    return p;
  };

  const send = async (patch: IntakePatch, done: string) => {
    if (Object.keys(patch).length === 0) {
      setResult({ tone: 'error', text: 'Tidak ada perubahan.' });
      return;
    }
    setBusy(true);
    setResult(undefined);
    try {
      const saved = await api.patchIntake(companyId, row.rowId, patch);
      setResult({ tone: 'ok', text: done });
      onSaved(saved);
    } catch (e) {
      setResult(e instanceof ApiError
        ? { tone: 'error', text: e.message, flags: e.flags }
        : { tone: 'error', text: 'Tidak dapat menghubungi server.' });
    } finally {
      setBusy(false);
    }
  };

  const save = (e: FormEvent) => { e.preventDefault(); void send(changes(), 'Perubahan tersimpan.'); };
  const confirm = () => void send({ ...changes(), status: 'terkonfirmasi' }, 'Nota dikonfirmasi.');
  const reject = () => {
    if (window.confirm(`Tolak nota ${shortRef(row.rowId)}? Nota yang ditolak tidak dihitung sebagai biaya.`)) void send({ status: 'ditolak' }, 'Nota ditolak.');
  };

  return (
    <Card title={<>Nota <span className="mono">{shortRef(row.rowId)}</span></>} eyebrow={sites.find((s) => s.id === row.siteId)?.name}>
      {photoFailed
        ? <div className="notice">Foto tidak tersedia.</div>
        : <img className="photo" src={api.intakePhotoUrl(companyId, row.rowId)} alt={`Foto nota ${shortRef(row.rowId)}`} onError={() => setPhotoFailed(true)} />}

      {flags.length > 0 && (
        <div className="flags" aria-label="Tanda validasi">
          {flags.map((f) => <Pill key={f} tone="amber">{FLAG_TEXT[f] ?? f}</Pill>)}
        </div>
      )}
      {(row.confidence.nearDuplicates?.length ?? 0) > 0 && (
        <p className="small muted">Mirip: {row.confidence.nearDuplicates!.map((d) => `${shortRef(d.rowId)} (jarak ${d.distance})`).join(', ')}</p>
      )}
      {result && (
        <div className={`notice ${result.tone}`} role="status">
          {result.text}
          {result.flags && result.flags.length > 0 && <ul>{result.flags.map((f) => <li key={f}>{FLAG_TEXT[f] ?? f}</li>)}</ul>}
        </div>
      )}

      <form onSubmit={save}>
        <fieldset disabled={readOnly || busy} style={{ border: 0, padding: 0, margin: 0 }}>
          <label className="field"><span>Vendor</span>
            <select value={vendorId} onChange={(e) => setVendorId(e.target.value)}>
              <option value="">— tidak dari daftar —</option>
              {vendors.map((v) => <option key={v.id} value={v.id}>{v.name}</option>)}
            </select>
          </label>
          {!vendorId && (
            <label className="field"><span>Nama vendor (seperti tertulis)</span>
              <input type="text" value={vendorName} minLength={2} maxLength={200} onChange={(e) => setVendorName(e.target.value)} />
            </label>
          )}
          <div className="row2">
            <label className="field"><span>Tanggal nota</span>
              <input type="date" value={invoiceDate} onChange={(e) => setInvoiceDate(e.target.value)} />
            </label>
            <label className="field"><span>Total (Rp)</span>
              <input type="text" inputMode="decimal" className="mono" value={total} onChange={(e) => setTotal(e.target.value)} />
            </label>
          </div>
          <label className="field"><span>Jatuh tempo (kosong = tanggal nota + tempo vendor)</span>
            <input type="date" value={dueDate} min={invoiceDate || undefined} onChange={(e) => setDueDate(e.target.value)} />
          </label>
          <div className="row2">
            <label className="field"><span>Nomor nota</span>
              <input type="text" value={docNumber} maxLength={100} onChange={(e) => setDocNumber(e.target.value)} />
            </label>
            <label className="field"><span>Kategori</span>
              <select value={category} onChange={(e) => setCategory(e.target.value as Category | '')}>
                <option value="">— pilih —</option>
                {(Object.keys(CATEGORY_LABEL) as Category[]).map((c) => <option key={c} value={c}>{CATEGORY_LABEL[c]}</option>)}
              </select>
            </label>
          </div>
          {row.npwp && <p className="small muted">NPWP pada nota: <span className="mono">{row.npwp}</span></p>}
          {!readOnly && (
            <div className="actions">
              <button type="button" className="btn primary" onClick={confirm}>Konfirmasi</button>
              <button type="submit" className="btn">Simpan</button>
              <button type="button" className="btn danger" onClick={reject}>Tolak</button>
            </div>
          )}
        </fieldset>
      </form>
      {closed && <p className="small muted">Nota sudah {row.status === 'ditolak' ? 'ditolak' : 'dikonfirmasi'} dan tidak dapat diubah lagi.</p>}
    </Card>
  );
}
