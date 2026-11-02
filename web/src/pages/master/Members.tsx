import { useState, type FormEvent } from 'react';
import { Card, ErrorNotice, Loading } from '../../components/ui';
import { api } from '../../lib/api';
import { ROLE_LABEL } from '../../lib/status';
import { useAsync } from '../../lib/useAsync';
import type { CompanyRole, Member, Site } from '../../lib/types';
import { errorNote, Notice, type Note } from './common';

const ROLES: CompanyRole[] = ['site_staff', 'project_admin', 'finance', 'company_manager', 'system_admin'];

/**
 * Members and their sites. Only managers change them; the account itself is created by the system
 * admin first (the API answers 404 for an unknown email). The last company_manager cannot be removed
 * or demoted (409), so the company can always be managed.
 */
/** Where the members come from: the company's own endpoints, or the system admin's (/admin/companies/:id/…). */
export interface MemberOps {
  members: () => Promise<Member[]>;
  sites: () => Promise<Array<Pick<Site, 'id' | 'name'>>>;
  put: (body: { email: string; role: CompanyRole; siteIds?: number[] }) => Promise<unknown>;
  remove: (userId: number) => Promise<unknown>;
}

export const companyMemberOps = (companyId: number): MemberOps => ({
  members: () => api.members(companyId),
  sites: () => api.sites(companyId),
  put: (body) => api.putMember(companyId, body),
  remove: (userId) => api.removeMember(companyId, userId),
});

export function Members({ companyId, canManage, ops = companyMemberOps(companyId), heading = 'Data master' }: {
  companyId: number; canManage: boolean; ops?: MemberOps; heading?: string;
}) {
  const list = useAsync(() => Promise.all([ops.members(), ops.sites()]), [companyId]);
  const [members, sites] = list.data ?? [[], []];
  const [open, setOpen] = useState<number | 'new'>();
  const [note, setNote] = useState<Note>();
  const member = members.find((m) => m.userId === open);
  const siteName = new Map(sites.map((s) => [s.id, s.name]));

  const remove = async (m: Member) => {
    if (!window.confirm(`Keluarkan ${m.name || m.email} dari perusahaan ini?`)) return;
    try {
      await ops.remove(m.userId);
      setNote({ tone: 'ok', text: `${m.name || m.email} dikeluarkan.` });
      setOpen(undefined);
      list.reload();
    } catch (e) {
      setNote(errorNote(e));
    }
  };

  return (
    <>
      <div className="page-head">
        <div className="eyebrow">{heading}</div>
        <h1>Anggota</h1>
      </div>
      <div className="review">
        <Card>
          {canManage && <p><button type="button" className="btn" onClick={() => setOpen('new')}>Tambah anggota</button></p>}
          <Notice note={note} />
          {list.error && <ErrorNotice error={list.error} onRetry={list.reload} />}
          {list.loading && !list.data && <Loading what="anggota" />}
          {members.length > 0 && (
            <div className="table-wrap">
              <table>
                <thead><tr><th>Nama</th><th>Email</th><th>Peran</th><th>Lokasi</th></tr></thead>
                <tbody>
                  {members.map((m) => (
                    <tr key={m.userId} className={`selectable ${m.userId === open ? 'selected' : ''}`} tabIndex={0} onClick={() => setOpen(m.userId)}
                      onKeyDown={(e) => { if (e.key === 'Enter') setOpen(m.userId); }}>
                      <td>{m.name || '—'}</td>
                      <td>{m.email}</td>
                      <td>{ROLE_LABEL[m.role] ?? m.role}</td>
                      <td>{siteScope(m, siteName)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </Card>
        <div className="detail">
          {open === 'new' && <MemberEditor key="new" ops={ops} sites={sites} canManage={canManage} onSaved={(email) => { setNote({ tone: 'ok', text: `${email} disimpan.` }); list.reload(); }} />}
          {member && (
            <MemberEditor key={member.userId} ops={ops} member={member} sites={sites} canManage={canManage}
              onSaved={() => list.reload()} onRemove={() => void remove(member)} />
          )}
          {open === undefined && <Card><div className="empty">Pilih anggota untuk melihat atau mengubah peran dan lokasinya.</div></Card>}
        </div>
      </div>
    </>
  );
}

/** "Semua lokasi", "JIAT Keerom, JIAT Arso", or for site staff without sites: none yet. */
function siteScope(m: Member, siteName: Map<number, string>): string {
  if (m.siteIds === null || m.siteIds.length === 0) return m.role === 'site_staff' ? 'belum ditugaskan' : 'semua lokasi';
  return m.siteIds.map((id) => siteName.get(id) ?? `#${id}`).join(', ');
}

function MemberEditor({ ops, member, sites, canManage, onSaved, onRemove }: {
  ops: MemberOps; member?: Member; sites: Array<Pick<Site, 'id' | 'name'>>; canManage: boolean; onSaved: (email: string) => void; onRemove?: () => void;
}) {
  const [email, setEmail] = useState(member?.email ?? '');
  const [role, setRole] = useState<CompanyRole>(member?.role ?? 'site_staff');
  const [siteIds, setSiteIds] = useState<number[]>(member?.siteIds ?? []);
  const [busy, setBusy] = useState(false);
  const [note, setNote] = useState<Note>();
  const toggle = (id: number) => setSiteIds((xs) => (xs.includes(id) ? xs.filter((x) => x !== id) : [...xs, id]));

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    if (role === 'site_staff' && siteIds.length === 0) {
      setNote({ tone: 'error', text: 'Staf site harus ditugaskan ke minimal satu lokasi.' });
      return;
    }
    setBusy(true);
    setNote(undefined);
    try {
      // no site ticked = every site (for roles other than site staff)
      await ops.put({ email: email.trim(), role, ...(siteIds.length ? { siteIds } : {}) });
      setNote({ tone: 'ok', text: 'Tersimpan.' });
      onSaved(email.trim());
    } catch (err) {
      setNote(errorNote(err));
    } finally {
      setBusy(false);
    }
  };

  return (
    <Card title={member ? member.name || member.email : 'Anggota baru'} eyebrow={member?.email}>
      <Notice note={note} />
      <form onSubmit={submit}>
        <fieldset disabled={!canManage || busy} className="plain">
          {!member && (
            <label className="field"><span>Email (akun harus sudah dibuat admin sistem)</span>
              <input type="email" value={email} required onChange={(e) => setEmail(e.target.value)} />
            </label>
          )}
          <label className="field"><span>Peran</span>
            <select value={role} onChange={(e) => setRole(e.target.value as CompanyRole)}>
              {ROLES.map((r) => <option key={r} value={r}>{ROLE_LABEL[r] ?? r}</option>)}
            </select>
          </label>
          <div className="field"><span>Lokasi {role === 'site_staff' ? '(wajib)' : '(kosong = semua lokasi)'}</span>
            <div className="checks">
              {sites.map((s) => (
                <label key={s.id}><input type="checkbox" checked={siteIds.includes(s.id)} onChange={() => toggle(s.id)} /> {s.name}</label>
              ))}
            </div>
          </div>
          {canManage && (
            <div className="actions">
              <button type="submit" className="btn primary">Simpan</button>
              {onRemove && <button type="button" className="btn danger" onClick={onRemove}>Keluarkan</button>}
            </div>
          )}
        </fieldset>
      </form>
    </Card>
  );
}
