import { useState, type FormEvent } from 'react';
import { Card, ErrorNotice, Loading, Pill } from '../../components/ui';
import { api } from '../../lib/api';
import { CATEGORY_LABEL } from '../../lib/labels';
import { vendorBody, vendorFormOf, vendorPatchOf, type VendorForm } from '../../lib/master';
import { useAsync } from '../../lib/useAsync';
import type { Category, Vendor } from '../../lib/types';
import { errorNote, Notice, type Note } from './common';

/**
 * Vendor master. Bank account and NPWP (UU 27/2022) are shown and edited only by finance and
 * managers; the API hides them from everyone else and refuses a change from them.
 */
export function Vendors({ companyId, canEdit, seesPii }: { companyId: number; canEdit: boolean; seesPii: boolean }) {
  const list = useAsync(() => api.vendors(companyId), [companyId]);
  const [open, setOpen] = useState<number | 'new'>();
  /** "added": shown by the saved vendor's editor, which replaces the new-vendor form */
  const [added, setAdded] = useState<Note>();
  const show = (id: number | 'new') => { setAdded(undefined); setOpen(id); };
  const [onlyDraft, setOnlyDraft] = useState(false);
  const vendor = list.data?.find((v) => v.id === open);
  const rows = (list.data ?? []).filter((v) => !onlyDraft || v.status === 'draft');
  const drafts = (list.data ?? []).filter((v) => v.status === 'draft').length;

  return (
    <>
      <div className="page-head">
        <div className="eyebrow">Data master</div>
        <h1>Vendor</h1>
      </div>
      <div className="filters">
        <label className="chip"><span>Tampilkan</span>
          <select value={onlyDraft ? 'draft' : ''} onChange={(e) => setOnlyDraft(e.target.value === 'draft')}>
            <option value="">Semua ({list.data?.length ?? '…'})</option>
            <option value="draft">Draf dari bot ({drafts})</option>
          </select>
        </label>
        {!seesPii && <span className="pill blue plain">Rekening &amp; NPWP hanya untuk keuangan / manajer</span>}
      </div>
      <div className="review">
        <Card>
          {canEdit && <p><button type="button" className="btn" onClick={() => show('new')}>Tambah vendor</button></p>}
          {list.error && <ErrorNotice error={list.error} onRetry={list.reload} />}
          {list.loading && !list.data && <Loading what="vendor" />}
          {list.data && rows.length === 0 && <div className="empty">Tidak ada vendor pada daftar ini.</div>}
          {rows.length > 0 && (
            <div className="table-wrap">
              <table>
                <thead><tr><th>Nama</th><th>Kategori</th><th className="num">Tempo</th><th>Telepon</th>{seesPii && <th>Rekening</th>}<th>Status</th></tr></thead>
                <tbody>
                  {rows.map((v) => (
                    <tr key={v.id} className={`selectable ${v.id === open ? 'selected' : ''}`} tabIndex={0} onClick={() => show(v.id)}
                      onKeyDown={(e) => { if (e.key === 'Enter') show(v.id); }}>
                      <td>{v.name}</td>
                      <td>{v.defaultCategory ? CATEGORY_LABEL[v.defaultCategory] : '—'}</td>
                      <td className="num">{v.paymentTermsDays ?? 30} hr</td>
                      <td>{v.phone ?? '—'}</td>
                      {seesPii && <td>{v.bankName ? `${v.bankName} ${v.bankAccount ?? ''}` : '—'}</td>}
                      <td><Pill tone={v.status === 'active' ? 'green' : 'amber'}>{v.status === 'active' ? 'Aktif' : 'Draf'}</Pill></td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </Card>
        <div className="detail">
          {open === 'new' && <VendorEditor key="new" companyId={companyId} canEdit={canEdit} seesPii={seesPii} onSaved={(v) => { list.reload(); setOpen(v.id); setAdded({ tone: 'ok', text: 'Vendor ditambahkan.' }); }} />}
          {vendor && <VendorEditor key={vendor.id} companyId={companyId} vendor={vendor} initialNote={added} canEdit={canEdit} seesPii={seesPii} onSaved={() => list.reload()} />}
          {open === undefined && <Card><div className="empty">Pilih vendor untuk melihat atau mengubahnya.</div></Card>}
        </div>
      </div>
    </>
  );
}

function VendorEditor({ companyId, vendor, initialNote, canEdit, seesPii, onSaved }: {
  companyId: number; vendor?: Vendor; initialNote?: Note | undefined; canEdit: boolean; seesPii: boolean; onSaved: (v: Vendor) => void;
}) {
  const [form, setForm] = useState<VendorForm>(() => vendorFormOf(vendor));
  const set = <K extends keyof VendorForm>(k: K, v: VendorForm[K]) => setForm((f) => ({ ...f, [k]: v }));
  const [busy, setBusy] = useState(false);
  const [note, setNote] = useState<Note | undefined>(initialNote);

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    const patch = vendor ? vendorPatchOf(vendor, form, seesPii) : null;
    const create = vendor ? null : vendorBody(form, seesPii);
    const invalid = patch && !patch.ok ? patch.error : create && !create.ok ? create.error : null;
    if (invalid) { setNote({ tone: 'error', text: invalid }); return; }
    setBusy(true);
    setNote(undefined);
    try {
      const saved = vendor && patch?.ok ? await api.patchVendor(companyId, vendor.id, patch.body)
        : create?.ok ? await api.createVendor(companyId, create.body) : null;
      if (!saved) return;
      setForm(vendorFormOf(saved));
      setNote({ tone: 'ok', text: vendor ? 'Vendor diperbarui.' : 'Vendor ditambahkan.' });
      onSaved(saved);
    } catch (err) {
      setNote(errorNote(err));
    } finally {
      setBusy(false);
    }
  };

  return (
    <Card title={vendor ? vendor.name : 'Vendor baru'} eyebrow={vendor?.status === 'draft' ? 'Draf dari bot: periksa lalu aktifkan' : undefined}>
      <Notice note={note} />
      <form onSubmit={submit}>
        <fieldset disabled={!canEdit || busy} className="plain">
          <label className="field"><span>Nama (seperti di nota)</span>
            <input type="text" value={form.name} maxLength={200} required onChange={(e) => set('name', e.target.value)} />
          </label>
          <div className="row2">
            <label className="field"><span>Kategori biaya bawaan</span>
              <select value={form.defaultCategory} onChange={(e) => set('defaultCategory', e.target.value as Category | '')}>
                <option value="">— tidak ada —</option>
                {(Object.keys(CATEGORY_LABEL) as Category[]).map((c) => <option key={c} value={c}>{CATEGORY_LABEL[c]}</option>)}
              </select>
            </label>
            <label className="field"><span>Tempo bayar (hari; kosong = 30)</span>
              <input type="text" inputMode="numeric" className="mono" value={form.paymentTermsDays} onChange={(e) => set('paymentTermsDays', e.target.value)} />
            </label>
          </div>
          <label className="field"><span>Telepon</span>
            <input type="tel" value={form.phone} maxLength={30} onChange={(e) => set('phone', e.target.value)} />
          </label>
          {seesPii && (
            <>
              <label className="field"><span>NPWP (15/16 angka)</span>
                <input type="text" inputMode="numeric" className="mono" value={form.npwp} maxLength={16} onChange={(e) => set('npwp', e.target.value)} />
              </label>
              <div className="row2">
                <label className="field"><span>Bank</span>
                  <input type="text" value={form.bankName} maxLength={100} onChange={(e) => set('bankName', e.target.value)} />
                </label>
                <label className="field"><span>Nomor rekening</span>
                  <input type="text" inputMode="numeric" className="mono" value={form.bankAccount} maxLength={40} onChange={(e) => set('bankAccount', e.target.value)} />
                </label>
              </div>
            </>
          )}
          {vendor && (
            <label className="field"><span>Status</span>
              <select value={form.status} onChange={(e) => set('status', e.target.value as VendorForm['status'])}>
                <option value="active">Aktif</option>
                <option value="draft">Draf</option>
              </select>
            </label>
          )}
          {canEdit && <div className="actions"><button type="submit" className="btn primary">{vendor ? 'Simpan' : 'Tambah'}</button></div>}
        </fieldset>
      </form>
    </Card>
  );
}
