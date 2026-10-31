import { useState, type FormEvent } from 'react';
import { Card, ErrorNotice, Loading, Pill } from '../../components/ui';
import { api } from '../../lib/api';
import { dateLabel, rupiah } from '../../lib/format';
import { contractBody, contractFormOf, type ContractForm } from '../../lib/master';
import { navigate } from '../../lib/router';
import { CONTRACT_STATUS_LABEL, daysTone } from '../../lib/status';
import { useAsync } from '../../lib/useAsync';
import type { Site } from '../../lib/types';
import { errorNote, Notice, type Note } from './common';

/** Contracts of the company; the detail page holds termin, addenda and the BOQ. */
export function Contracts({ companyId, canEdit }: { companyId: number; canEdit: boolean }) {
  const list = useAsync(() => Promise.all([api.contracts(companyId), api.sites(companyId)]), [companyId]);
  const [contracts, sites] = list.data ?? [[], []];
  const [creating, setCreating] = useState(false);
  const siteName = new Map(sites.map((s) => [s.id, s.name]));
  const open = (id: number) => navigate(`/c/${companyId}/contracts/${id}`);

  return (
    <>
      <div className="page-head">
        <div className="eyebrow">Data master</div>
        <h1>Kontrak</h1>
      </div>
      <div className={creating ? 'review' : ''}>
        <Card>
          {canEdit && !creating && <p><button type="button" className="btn" onClick={() => setCreating(true)}>Tambah kontrak</button></p>}
          {list.error && <ErrorNotice error={list.error} onRetry={list.reload} />}
          {list.loading && !list.data && <Loading what="kontrak" />}
          {list.data && contracts.length === 0 && <div className="empty">Belum ada kontrak.</div>}
          {contracts.length > 0 && (
            <div className="table-wrap">
              <table>
                <thead>
                  <tr><th>No. kontrak</th><th>Lokasi</th><th>Pemberi kerja</th><th className="num">Nilai DPP</th><th>Selesai</th><th className="num">Sisa hari</th><th>Status</th></tr>
                </thead>
                <tbody>
                  {contracts.map((k) => (
                    <tr key={k.id} className="selectable" tabIndex={0} onClick={() => open(k.id)} onKeyDown={(e) => { if (e.key === 'Enter') open(k.id); }}>
                      <td className="code">{k.number}</td>
                      <td>{siteName.get(k.siteId) ?? `#${k.siteId}`}</td>
                      <td>{k.employerName}</td>
                      <td className="num">{rupiah(k.valueDppEffectiveCents)}{k.addendumDeltaCents !== 0 && <span className="small muted"> (addendum)</span>}</td>
                      <td>{dateLabel(k.endDateEffective)}</td>
                      <td className={`num ${daysTone(k.daysLeft) === 'red' ? 't-red' : ''}`}>{k.daysLeft ?? '—'}</td>
                      <td><Pill tone={k.status === 'active' ? 'green' : 'plain'}>{CONTRACT_STATUS_LABEL[k.status] ?? k.status}</Pill></td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </Card>
        {creating && (
          <div className="detail">
            <NewContract companyId={companyId} sites={sites} onCancel={() => setCreating(false)} onSaved={(id) => open(id)} />
          </div>
        )}
      </div>
    </>
  );
}

function NewContract({ companyId, sites, onCancel, onSaved }: { companyId: number; sites: Site[]; onCancel: () => void; onSaved: (id: number) => void }) {
  const [form, setForm] = useState<ContractForm>(() => ({ ...contractFormOf(), siteId: sites.length === 1 ? String(sites[0]!.id) : '' }));
  const set = (k: keyof ContractForm, v: string) => setForm((f) => ({ ...f, [k]: v }));
  const [busy, setBusy] = useState(false);
  const [note, setNote] = useState<Note>();

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    const built = contractBody(form);
    if (!built.ok) { setNote({ tone: 'error', text: built.error }); return; }
    setBusy(true);
    setNote(undefined);
    try {
      const k = await api.createContract(companyId, built.body);
      onSaved(k.id);
    } catch (err) {
      setNote(errorNote(err));
      setBusy(false);
    }
  };

  return (
    <Card title="Kontrak baru">
      <Notice note={note} />
      <form onSubmit={submit}>
        <fieldset disabled={busy} className="plain">
          <label className="field"><span>Lokasi</span>
            <select value={form.siteId} required onChange={(e) => set('siteId', e.target.value)}>
              <option value="">— pilih —</option>
              {sites.map((s) => <option key={s.id} value={s.id}>{s.name}</option>)}
            </select>
          </label>
          <label className="field"><span>Nomor kontrak</span>
            <input type="text" value={form.number} maxLength={100} required onChange={(e) => set('number', e.target.value)} />
          </label>
          <label className="field"><span>Pemberi kerja</span>
            <input type="text" value={form.employerName} maxLength={200} required onChange={(e) => set('employerName', e.target.value)} />
          </label>
          <ContractMoneyFields form={form} set={set} withDpp />
          <ContractDateFields form={form} set={set} />
          <div className="actions">
            <button type="submit" className="btn primary">Tambah</button>
            <button type="button" className="btn" onClick={onCancel}>Batal</button>
          </div>
        </fieldset>
      </form>
    </Card>
  );
}

/** Shared by the new-contract form and the contract's data tab. */
export function ContractMoneyFields({ form, set, withDpp }: { form: ContractForm; set: (k: keyof ContractForm, v: string) => void; withDpp: boolean }) {
  return (
    <>
      {withDpp && (
        <label className="field"><span>Nilai kontrak DPP (Rp, tanpa PPN)</span>
          <input type="text" inputMode="decimal" className="mono" value={form.valueDpp} required placeholder="8.150.000.000" onChange={(e) => set('valueDpp', e.target.value)} />
        </label>
      )}
      <div className="row2">
        <label className="field"><span>PPN (%)</span>
          <input type="text" inputMode="decimal" className="mono" value={form.ppn} onChange={(e) => set('ppn', e.target.value)} />
        </label>
        <label className="field"><span>Retensi per termin (%)</span>
          <input type="text" inputMode="decimal" className="mono" value={form.retention} onChange={(e) => set('retention', e.target.value)} />
        </label>
      </div>
      <label className="field"><span>Uang muka diterima (Rp DPP)</span>
        <input type="text" inputMode="decimal" className="mono" value={form.advance} onChange={(e) => set('advance', e.target.value)} />
      </label>
    </>
  );
}

export function ContractDateFields({ form, set }: { form: ContractForm; set: (k: keyof ContractForm, v: string) => void }) {
  return (
    <>
      <div className="row2">
        <label className="field"><span>Tanggal tanda tangan</span>
          <input type="date" value={form.signedAt} onChange={(e) => set('signedAt', e.target.value)} />
        </label>
        <label className="field"><span>Status</span>
          <select value={form.status} onChange={(e) => set('status', e.target.value)}>
            {Object.entries(CONTRACT_STATUS_LABEL).map(([v, l]) => <option key={v} value={v}>{l}</option>)}
          </select>
        </label>
      </div>
      <div className="row2">
        <label className="field"><span>Mulai</span>
          <input type="date" value={form.startDate} onChange={(e) => set('startDate', e.target.value)} />
        </label>
        <label className="field"><span>Selesai (sesuai kontrak)</span>
          <input type="date" value={form.endDate} min={form.startDate || undefined} onChange={(e) => set('endDate', e.target.value)} />
        </label>
      </div>
    </>
  );
}
