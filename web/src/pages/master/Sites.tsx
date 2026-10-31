import { useState, type FormEvent } from 'react';
import { Card, ErrorNotice, Loading, Pill } from '../../components/ui';
import { api } from '../../lib/api';
import { dateLabel } from '../../lib/format';
import { siteBody, siteFormOf, sitePatchOf, type SiteForm } from '../../lib/master';
import { useAsync } from '../../lib/useAsync';
import type { Site } from '../../lib/types';
import { errorNote, Notice, type Note } from './common';

/** Sites (lokasi proyek): every member reads; project admins and managers add and edit. */
export function Sites({ companyId, canEdit }: { companyId: number; canEdit: boolean }) {
  const list = useAsync(() => api.sites(companyId), [companyId]);
  const [open, setOpen] = useState<number | 'new'>();
  /** "added": shown by the saved site's editor, which replaces the new-site form */
  const [added, setAdded] = useState<Note>();
  const site = list.data?.find((s) => s.id === open);
  const show = (id: number | 'new' | undefined) => { setAdded(undefined); setOpen(id); };

  return (
    <>
      <div className="page-head">
        <div className="eyebrow">Data master</div>
        <h1>Lokasi</h1>
      </div>
      <div className="review">
        <Card>
          {canEdit && <p><button type="button" className="btn" onClick={() => show('new')}>Tambah lokasi</button></p>}
          {list.error && <ErrorNotice error={list.error} onRetry={list.reload} />}
          {list.loading && !list.data && <Loading what="lokasi" />}
          {list.data && list.data.length === 0 && <div className="empty">Belum ada lokasi.</div>}
          {list.data && list.data.length > 0 && (
            <div className="table-wrap">
              <table>
                <thead><tr><th>Kode</th><th>Nama</th><th>Provinsi</th><th>Mulai</th><th>Selesai</th><th>Status</th></tr></thead>
                <tbody>
                  {list.data.map((s) => (
                    <tr key={s.id} className={`selectable ${s.id === open ? 'selected' : ''}`} tabIndex={0} onClick={() => show(s.id)}
                      onKeyDown={(e) => { if (e.key === 'Enter') show(s.id); }}>
                      <td className="code">{s.code}</td>
                      <td>{s.name}</td>
                      <td>{s.province ?? '—'}</td>
                      <td>{dateLabel(s.startDate)}</td>
                      <td>{dateLabel(s.endDate)}</td>
                      <td><Pill tone={s.status === 'active' ? 'green' : 'plain'}>{s.status === 'active' ? 'Aktif' : 'Ditutup'}</Pill></td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </Card>
        <div className="detail">
          {open === 'new' && <SiteEditor key="new" companyId={companyId} canEdit={canEdit} onSaved={(s) => { list.reload(); setOpen(s.id); setAdded({ tone: 'ok', text: 'Lokasi ditambahkan.' }); }} />}
          {site && <SiteEditor key={site.id} companyId={companyId} site={site} initialNote={added} canEdit={canEdit} onSaved={() => list.reload()} />}
          {open === undefined && <Card><div className="empty">Pilih lokasi untuk melihat atau mengubahnya.</div></Card>}
        </div>
      </div>
    </>
  );
}

function SiteEditor({ companyId, site, initialNote, canEdit, onSaved }: {
  companyId: number; site?: Site; initialNote?: Note | undefined; canEdit: boolean; onSaved: (s: Site) => void;
}) {
  const [form, setForm] = useState<SiteForm>(() => siteFormOf(site));
  const set = (k: keyof SiteForm, v: string) => setForm((f) => ({ ...f, [k]: v }));
  const [busy, setBusy] = useState(false);
  const [note, setNote] = useState<Note | undefined>(initialNote);

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    const patch = site ? sitePatchOf(site, form) : null;
    const create = site ? null : siteBody(form);
    const invalid = patch && !patch.ok ? patch.error : create && !create.ok ? create.error : null;
    if (invalid) { setNote({ tone: 'error', text: invalid }); return; }
    setBusy(true);
    setNote(undefined);
    try {
      const saved = site && patch?.ok ? await api.patchSite(companyId, site.id, patch.body)
        : create?.ok ? await api.createSite(companyId, create.body) : null;
      if (!saved) return;
      setForm(siteFormOf(saved));
      setNote({ tone: 'ok', text: site ? 'Lokasi diperbarui.' : 'Lokasi ditambahkan.' });
      onSaved(saved);
    } catch (err) {
      setNote(errorNote(err));
    } finally {
      setBusy(false);
    }
  };

  return (
    <Card title={site ? site.name : 'Lokasi baru'} eyebrow={site?.code}>
      <Notice note={note} />
      <form onSubmit={submit}>
        <fieldset disabled={!canEdit || busy} className="plain">
          {!site && (
            <label className="field"><span>Kode (dipakai di nomor dokumen, tidak bisa diubah)</span>
              <input type="text" value={form.code} maxLength={20} required onChange={(e) => set('code', e.target.value.toUpperCase())} />
            </label>
          )}
          <label className="field"><span>Nama</span>
            <input type="text" value={form.name} maxLength={200} required onChange={(e) => set('name', e.target.value)} />
          </label>
          <div className="row2">
            <label className="field"><span>Lokasi</span>
              <input type="text" value={form.location} maxLength={500} onChange={(e) => set('location', e.target.value)} />
            </label>
            <label className="field"><span>Provinsi</span>
              <input type="text" value={form.province} maxLength={100} onChange={(e) => set('province', e.target.value)} />
            </label>
          </div>
          <div className="row2">
            <label className="field"><span>Mulai</span>
              <input type="date" value={form.startDate} onChange={(e) => set('startDate', e.target.value)} />
            </label>
            <label className="field"><span>Selesai</span>
              <input type="date" value={form.endDate} min={form.startDate || undefined} onChange={(e) => set('endDate', e.target.value)} />
            </label>
          </div>
          {site && (
            <label className="field"><span>Status</span>
              <select value={form.status} onChange={(e) => set('status', e.target.value)}>
                <option value="active">Aktif</option>
                <option value="closed">Ditutup</option>
              </select>
            </label>
          )}
          {canEdit && <div className="actions"><button type="submit" className="btn primary">{site ? 'Simpan' : 'Tambah'}</button></div>}
        </fieldset>
      </form>
    </Card>
  );
}
