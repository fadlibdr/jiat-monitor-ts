import { useState, type FormEvent } from 'react';
import { Shell, type NavItem } from '../components/Shell';
import { Card, ErrorNotice, Loading, Pill } from '../components/ui';
import { api } from '../lib/api';
import {
  chatBody, companyBody, companyFormOf, companyPatchOf, emptyChat, userFormOf, userPatchOf, type ChatForm, type CompanyForm, type UserForm,
} from '../lib/admin';
import { instantLabel } from '../lib/format';
import { navigate } from '../lib/router';
import { useAsync } from '../lib/useAsync';
import type { AdminCompany, AdminUser, ManagementRole, Me, TelegramChat } from '../lib/types';
import { errorNote, Notice, type Note } from './master/common';
import { Members, type MemberOps } from './master/Members';

export const ADMIN_VIEWS = ['companies', 'users', 'telegram', 'holding'] as const;
export type AdminView = (typeof ADMIN_VIEWS)[number];
const LABEL: Record<AdminView, string> = { companies: 'Perusahaan', users: 'Pengguna', telegram: 'Grup Telegram', holding: 'Akses holding' };
const VIEWER_LABEL: Record<ManagementRole, string> = { holding_viewer: 'Holding viewer', direksi: 'Direksi' };

/**
 * HLD §2 "Admin sistem" under /admin: companies (with the letterhead printed on invoices and POs) and
 * their members, user accounts, Telegram groups → company + site, holding access. Configuration only:
 * a system admin who is not a member still cannot open a company's project data.
 */
export function AdminArea({ me, view, itemId, onSignOut }: { me: Me; view: AdminView; itemId?: number | undefined; onSignOut: () => Promise<void> }) {
  const nav: Array<NavItem | { head: string }> = [
    { head: 'Admin sistem' },
    ...ADMIN_VIEWS.map((v) => ({ to: `/admin/${v}`, label: LABEL[v] })),
    { to: '/', label: 'Ganti ruang kerja' },
  ];
  return (
    <Shell me={me} context="Admin sistem" nav={nav} current={`/admin/${view}`} onSignOut={onSignOut} roleNote="peran: admin sistem"
      crumbs={<>Admin sistem › <b>{LABEL[view]}</b></>}>
      {view === 'companies' && (itemId ? <CompanyDetail key={itemId} companyId={itemId} /> : <Companies />)}
      {view === 'users' && <Users me={me} />}
      {view === 'telegram' && <TelegramGroups />}
      {view === 'holding' && <HoldingAccess />}
    </Shell>
  );
}

function Head({ title }: { title: string }) {
  return <div className="page-head"><div className="eyebrow">Admin sistem</div><h1>{title}</h1></div>;
}

// --- companies ---

function Companies() {
  const list = useAsync(() => api.admin.companies(), []);
  const [adding, setAdding] = useState(false);
  return (
    <>
      <Head title="Perusahaan" />
      <div className="review">
        <Card>
          <p><button type="button" className="btn" onClick={() => setAdding(true)}>Tambah perusahaan</button></p>
          {list.error && <ErrorNotice error={list.error} onRetry={list.reload} />}
          {list.loading && !list.data && <Loading what="perusahaan" />}
          {list.data && (
            <div className="table-wrap">
              <table>
                <thead><tr><th>Kode</th><th>Nama</th><th>NPWP</th><th>Rekening</th></tr></thead>
                <tbody>
                  {list.data.map((c) => (
                    <tr key={c.id} className="selectable" tabIndex={0} onClick={() => navigate(`/admin/companies/${c.id}`)}
                      onKeyDown={(e) => { if (e.key === 'Enter') navigate(`/admin/companies/${c.id}`); }}>
                      <td className="code">{c.code}</td><td>{c.name}</td><td className="mono small">{c.npwp ?? '—'}</td>
                      <td className="small">{c.bankName ? `${c.bankName} ${c.bankAccount ?? ''}` : '—'}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </Card>
        <div className="detail">
          {adding
            ? <CompanyEditor onSaved={(c) => navigate(`/admin/companies/${c.id}`)} />
            : <Card><div className="empty">Pilih perusahaan untuk mengubah data dan anggotanya.</div></Card>}
        </div>
      </div>
    </>
  );
}

function CompanyDetail({ companyId }: { companyId: number }) {
  const list = useAsync(() => api.admin.companies(), []);
  const company = list.data?.find((c) => c.id === companyId);
  const ops: MemberOps = {
    members: () => api.admin.members(companyId),
    sites: () => api.admin.sites(companyId),
    put: (body) => api.admin.putMember(companyId, body),
    remove: (userId) => api.admin.removeMember(companyId, userId),
  };
  return (
    <>
      <p className="small"><button type="button" className="linkish" onClick={() => navigate('/admin/companies')}>← Semua perusahaan</button></p>
      {list.error && <ErrorNotice error={list.error} onRetry={list.reload} />}
      {list.loading && !list.data && <Loading what="perusahaan" />}
      {list.data && !company && <div className="empty">Perusahaan tidak ditemukan.</div>}
      {company && (
        <>
          <Head title={company.name} />
          <CompanyEditor key={JSON.stringify(company)} company={company} onSaved={() => list.reload()} />
          <Members companyId={companyId} canManage ops={ops} heading={`Anggota ${company.code}`} />
        </>
      )}
    </>
  );
}

/** New company (with its first manager) or the profile of one; the letterhead fields print on invoices and POs. */
function CompanyEditor({ company, onSaved }: { company?: AdminCompany; onSaved: (c: AdminCompany) => void }) {
  const [form, setForm] = useState<CompanyForm>(companyFormOf(company));
  const [busy, setBusy] = useState(false);
  const [note, setNote] = useState<Note>();
  const setField = (k: keyof CompanyForm, v: string) => setForm((f) => ({ ...f, [k]: v }));

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    let request: () => Promise<AdminCompany>;
    if (company) {
      const built = companyPatchOf(company, form);
      if (!built.ok) { setNote({ tone: 'error', text: built.error }); return; }
      request = () => api.admin.patchCompany(company.id, built.body);
    } else {
      const built = companyBody(form);
      if (!built.ok) { setNote({ tone: 'error', text: built.error }); return; }
      request = () => api.admin.createCompany(built.body);
    }
    setBusy(true);
    setNote(undefined);
    try {
      const saved = await request();
      setNote({ tone: 'ok', text: company ? 'Data perusahaan disimpan.' : `${saved.code} dibuat.` });
      onSaved(saved);
    } catch (err) {
      setNote(errorNote(err));
    } finally {
      setBusy(false);
    }
  };

  const text = (k: keyof CompanyForm, label: string, extra: { placeholder?: string; maxLength?: number } = {}) => (
    <label className="field"><span>{label}</span><input type="text" value={form[k]} onChange={(e) => setField(k, e.target.value)} {...extra} /></label>
  );
  return (
    <Card title={company ? 'Data perusahaan' : 'Perusahaan baru'} eyebrow={company?.code}>
      <Notice note={note} />
      <form onSubmit={(e) => void submit(e)}>
        <fieldset disabled={busy} className="plain">
          {!company && text('code', 'Kode (2–8 huruf/angka, dipakai di nomor dokumen)', { maxLength: 8, placeholder: 'KRM' })}
          {text('name', 'Nama', { maxLength: 200 })}
          {text('npwp', 'NPWP', { placeholder: '01.234.567.8-901.000' })}
          {text('address', 'Alamat (kop surat)', { maxLength: 1000 })}
          <div className="row2">
            {text('bankName', 'Bank', { maxLength: 100 })}
            {text('bankAccount', 'Nomor rekening', { maxLength: 40 })}
          </div>
          {text('docPrefix', 'Prefiks nomor dokumen (opsional)', { maxLength: 12, placeholder: 'PII' })}
          {!company && (
            <label className="field"><span>Email manajer pertama (akun sudah ada; opsional)</span>
              <input type="email" value={form.managerEmail} onChange={(e) => setField('managerEmail', e.target.value)} />
            </label>
          )}
          <div className="actions"><button type="submit" className="btn primary">{company ? 'Simpan' : 'Buat perusahaan'}</button></div>
        </fieldset>
      </form>
    </Card>
  );
}

// --- users ---

function Users({ me }: { me: Me }) {
  const list = useAsync(() => api.admin.users(), []);
  const [open, setOpen] = useState<number>();
  const user = list.data?.find((u) => u.id === open);
  return (
    <>
      <Head title="Pengguna" />
      <div className="review">
        <Card>
          <p className="small muted">Akun baru dibuat operator server dengan <span className="mono">src/cli/create-user.ts</span>; di sini profil, tautan Telegram, status dan hak admin.</p>
          {list.error && <ErrorNotice error={list.error} onRetry={list.reload} />}
          {list.loading && !list.data && <Loading what="pengguna" />}
          {list.data && (
            <div className="table-wrap">
              <table>
                <thead><tr><th>Email</th><th>Nama</th><th>Telegram</th><th>Status</th></tr></thead>
                <tbody>
                  {list.data.map((u) => (
                    <tr key={u.id} className={`selectable ${u.id === open ? 'selected' : ''}`} tabIndex={0} onClick={() => setOpen(u.id)}
                      onKeyDown={(e) => { if (e.key === 'Enter') setOpen(u.id); }}>
                      <td>{u.email}</td><td>{u.name}</td><td className="mono small">{u.telegramUserId ?? '—'}</td>
                      <td>
                        {u.isActive ? <Pill tone="green">Aktif</Pill> : <Pill tone="red">Nonaktif</Pill>}
                        {u.isSystemAdmin && <> <Pill tone="amber">Admin</Pill></>}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </Card>
        <div className="detail">
          {user
            ? <UserEditor key={JSON.stringify(user)} user={user} self={user.id === me.id} onSaved={() => list.reload()} />
            : <Card><div className="empty">Pilih pengguna.</div></Card>}
        </div>
      </div>
    </>
  );
}

function UserEditor({ user, self, onSaved }: { user: AdminUser; self: boolean; onSaved: () => void }) {
  const [form, setForm] = useState<UserForm>(userFormOf(user));
  const [busy, setBusy] = useState(false);
  const [note, setNote] = useState<Note>();
  const send = async (body: Parameters<typeof api.admin.patchUser>[1], done: string) => {
    setBusy(true);
    setNote(undefined);
    try {
      await api.admin.patchUser(user.id, body);
      setNote({ tone: 'ok', text: done });
      onSaved();
    } catch (err) {
      setNote(errorNote(err));
    } finally {
      setBusy(false);
    }
  };
  const submit = (e: FormEvent) => {
    e.preventDefault();
    const built = userPatchOf(user, form);
    if (!built.ok) { setNote({ tone: 'error', text: built.error }); return; }
    void send(built.body, 'Profil disimpan.');
  };
  const toggleActive = () => {
    if (user.isActive && !window.confirm(`Nonaktifkan ${user.email}? Semua sesinya langsung berakhir.`)) return;
    void send({ isActive: !user.isActive }, user.isActive ? 'Akun dinonaktifkan; sesinya diakhiri.' : 'Akun diaktifkan kembali.');
  };
  const toggleAdmin = () => {
    if (!user.isSystemAdmin && !window.confirm(`Jadikan ${user.email} admin sistem?`)) return;
    void send({ isSystemAdmin: !user.isSystemAdmin }, user.isSystemAdmin ? 'Hak admin sistem dicabut.' : 'Hak admin sistem diberikan.');
  };

  return (
    <Card title={user.name} eyebrow={user.email}>
      <Notice note={note} />
      <form onSubmit={submit}>
        <fieldset disabled={busy} className="plain">
          <label className="field"><span>Nama</span><input type="text" value={form.name} maxLength={200} onChange={(e) => setForm((f) => ({ ...f, name: e.target.value }))} /></label>
          <label className="field"><span>Nomor HP</span><input type="tel" value={form.phone} maxLength={30} onChange={(e) => setForm((f) => ({ ...f, phone: e.target.value }))} /></label>
          <label className="field"><span>ID Telegram (kosongkan untuk memutus)</span>
            <input type="text" inputMode="numeric" value={form.telegramUserId} onChange={(e) => setForm((f) => ({ ...f, telegramUserId: e.target.value }))} />
          </label>
          <div className="actions">
            <button type="submit" className="btn primary">Simpan profil</button>
            {!self && <button type="button" className={`btn ${user.isActive ? 'danger' : ''}`} onClick={toggleActive}>{user.isActive ? 'Nonaktifkan' : 'Aktifkan'}</button>}
            {!self && <button type="button" className="btn" onClick={toggleAdmin}>{user.isSystemAdmin ? 'Cabut admin sistem' : 'Jadikan admin sistem'}</button>}
          </div>
          {self && <p className="small muted">Akun sendiri tidak bisa dinonaktifkan atau dicabut hak adminnya.</p>}
        </fieldset>
      </form>
    </Card>
  );
}

// --- Telegram groups ---

function TelegramGroups() {
  const chats = useAsync(() => api.admin.chats(), []);
  const companies = useAsync(() => api.admin.companies(), []);
  const [open, setOpen] = useState<number | 'new'>();
  const [flash, setFlash] = useState<Note>();
  const companyCode = (id: number) => companies.data?.find((c) => c.id === id)?.code ?? `#${id}`;
  const chat = chats.data?.find((c) => c.id === open);
  return (
    <>
      <Head title="Grup Telegram" />
      <div className="review">
        <Card>
          <p className="small muted">Nota yang dikirim ke grup masuk ke review nota lokasi yang dipetakan di sini.</p>
          <p><button type="button" className="btn" onClick={() => { setFlash(undefined); setOpen('new'); }}>Petakan grup</button></p>
          <Notice note={flash} />
          {chats.error && <ErrorNotice error={chats.error} onRetry={chats.reload} />}
          {chats.loading && !chats.data && <Loading what="grup" />}
          {chats.data && chats.data.length === 0 && <div className="empty">Belum ada grup yang dipetakan.</div>}
          {chats.data && chats.data.length > 0 && (
            <div className="table-wrap">
              <table>
                <thead><tr><th>Grup</th><th>Chat ID</th><th>Perusahaan</th><th>Status</th></tr></thead>
                <tbody>
                  {chats.data.map((c) => (
                    <tr key={c.id} className={`selectable ${c.id === open ? 'selected' : ''}`} tabIndex={0} onClick={() => { setFlash(undefined); setOpen(c.id); }}
                      onKeyDown={(e) => { if (e.key === 'Enter') setOpen(c.id); }}>
                      <td>{c.title ?? '—'}</td><td className="mono small">{c.chatId}</td><td>{companyCode(c.companyId)}</td>
                      <td>{c.isActive ? <Pill tone="green">Aktif</Pill> : <Pill>Nonaktif</Pill>}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </Card>
        <div className="detail">
          {open === 'new' && (
            <NewChat companies={companies.data ?? []} onSaved={(c) => { chats.reload(); setOpen(c.id); setFlash({ tone: 'ok', text: `Grup ${c.title ?? c.chatId} dipetakan.` }); }} />
          )}
          {chat && <ChatEditor key={JSON.stringify(chat)} chat={chat} companyCode={companyCode(chat.companyId)} onSaved={() => chats.reload()} />}
          {open === undefined && <Card><div className="empty">Pilih grup, atau petakan grup baru.</div></Card>}
        </div>
      </div>
    </>
  );
}

function NewChat({ companies, onSaved }: { companies: AdminCompany[]; onSaved: (c: TelegramChat) => void }) {
  const [form, setForm] = useState<ChatForm>(emptyChat());
  const sites = useAsync(() => (form.companyId ? api.admin.sites(Number(form.companyId)) : Promise.resolve([])), [form.companyId]);
  const [busy, setBusy] = useState(false);
  const [note, setNote] = useState<Note>();
  const submit = async (e: FormEvent) => {
    e.preventDefault();
    const built = chatBody(form);
    if (!built.ok) { setNote({ tone: 'error', text: built.error }); return; }
    setBusy(true);
    setNote(undefined);
    try {
      onSaved(await api.admin.createChat(built.body));
    } catch (err) {
      setNote(errorNote(err));
    } finally {
      setBusy(false);
    }
  };
  return (
    <Card title="Petakan grup Telegram">
      <Notice note={note} />
      <form onSubmit={(e) => void submit(e)}>
        <fieldset disabled={busy} className="plain">
          <label className="field"><span>Chat ID grup</span>
            <input type="text" inputMode="numeric" value={form.chatId} placeholder="-1001234567890" onChange={(e) => setForm((f) => ({ ...f, chatId: e.target.value }))} />
          </label>
          <label className="field"><span>Perusahaan</span>
            <select value={form.companyId} onChange={(e) => setForm((f) => ({ ...f, companyId: e.target.value, siteId: '' }))}>
              <option value="">— pilih —</option>
              {companies.map((c) => <option key={c.id} value={c.id}>{c.code} — {c.name}</option>)}
            </select>
          </label>
          <label className="field"><span>Lokasi</span>
            <select value={form.siteId} onChange={(e) => setForm((f) => ({ ...f, siteId: e.target.value }))} disabled={!form.companyId}>
              <option value="">— pilih —</option>
              {(sites.data ?? []).map((s) => <option key={s.id} value={s.id}>{s.code} — {s.name}</option>)}
            </select>
          </label>
          {sites.error && <ErrorNotice error={sites.error} onRetry={sites.reload} />}
          <label className="field"><span>Nama grup (opsional)</span>
            <input type="text" value={form.title} maxLength={200} onChange={(e) => setForm((f) => ({ ...f, title: e.target.value }))} />
          </label>
          <div className="actions"><button type="submit" className="btn primary">Petakan</button></div>
        </fieldset>
      </form>
    </Card>
  );
}

/** Move a group to another site of the same company, rename it, or switch it off (its notas are then ignored). */
function ChatEditor({ chat, companyCode, onSaved }: { chat: TelegramChat; companyCode: string; onSaved: () => void }) {
  const sites = useAsync(() => api.admin.sites(chat.companyId), [chat.companyId]);
  const [siteId, setSiteId] = useState(String(chat.siteId));
  const [title, setTitle] = useState(chat.title ?? '');
  const [busy, setBusy] = useState(false);
  const [note, setNote] = useState<Note>();
  const send = async (body: Parameters<typeof api.admin.patchChat>[1], done: string) => {
    setBusy(true);
    setNote(undefined);
    try {
      await api.admin.patchChat(chat.id, body);
      setNote({ tone: 'ok', text: done });
      onSaved();
    } catch (err) {
      setNote(errorNote(err));
    } finally {
      setBusy(false);
    }
  };
  const save = (e: FormEvent) => {
    e.preventDefault();
    const body: Parameters<typeof api.admin.patchChat>[1] = {};
    if (siteId !== String(chat.siteId)) body.siteId = Number(siteId);
    if (title.trim() !== (chat.title ?? '')) body.title = title.trim() || null;
    if (Object.keys(body).length === 0) { setNote({ tone: 'error', text: 'Tidak ada perubahan.' }); return; }
    void send(body, 'Grup disimpan.');
  };
  return (
    <Card title={chat.title ?? 'Grup Telegram'} eyebrow={`${companyCode} · ${chat.chatId}`}>
      <Notice note={note} />
      <form onSubmit={save}>
        <fieldset disabled={busy} className="plain">
          <label className="field"><span>Lokasi</span>
            <select value={siteId} onChange={(e) => setSiteId(e.target.value)}>
              {(sites.data ?? []).map((s) => <option key={s.id} value={s.id}>{s.code} — {s.name}</option>)}
            </select>
          </label>
          {sites.error && <ErrorNotice error={sites.error} onRetry={sites.reload} />}
          <label className="field"><span>Nama grup</span><input type="text" value={title} maxLength={200} onChange={(e) => setTitle(e.target.value)} /></label>
          <div className="actions">
            <button type="submit" className="btn primary">Simpan</button>
            <button type="button" className={`btn ${chat.isActive ? 'danger' : ''}`}
              onClick={() => void send({ isActive: !chat.isActive }, chat.isActive ? 'Grup dinonaktifkan; notanya tidak diproses.' : 'Grup diaktifkan.')}>
              {chat.isActive ? 'Nonaktifkan' : 'Aktifkan'}
            </button>
          </div>
        </fieldset>
      </form>
    </Card>
  );
}

// --- holding access ---

function HoldingAccess() {
  const list = useAsync(() => api.admin.viewers(), []);
  const [email, setEmail] = useState('');
  const [role, setRole] = useState<ManagementRole>('holding_viewer');
  const [busy, setBusy] = useState(false);
  const [note, setNote] = useState<Note>();
  /** true when it went through (the form is cleared only then) */
  const run = async (fn: () => Promise<unknown>, done: string): Promise<boolean> => {
    setBusy(true);
    setNote(undefined);
    try {
      await fn();
      setNote({ tone: 'ok', text: done });
      list.reload();
      return true;
    } catch (err) {
      setNote(errorNote(err));
      return false;
    } finally {
      setBusy(false);
    }
  };
  const grant = (e: FormEvent) => {
    e.preventDefault();
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email.trim())) { setNote({ tone: 'error', text: 'Email tidak valid.' }); return; }
    void run(() => api.admin.putViewer(email.trim(), role), `${email.trim()} mendapat akses ${VIEWER_LABEL[role]}.`).then((ok) => { if (ok) setEmail(''); });
  };
  return (
    <>
      <Head title="Akses holding" />
      <div className="review">
        <Card>
          <p className="small muted">Dashboard holding (konsolidasi seluruh perusahaan, baca saja) untuk direksi dan holding viewer.</p>
          <Notice note={note} />
          {list.error && <ErrorNotice error={list.error} onRetry={list.reload} />}
          {list.loading && !list.data && <Loading what="akses" />}
          {list.data && list.data.length === 0 && <div className="empty">Belum ada yang diberi akses holding.</div>}
          {list.data && list.data.length > 0 && (
            <div className="table-wrap">
              <table>
                <thead><tr><th>Pengguna</th><th>Akses</th><th>Diberikan</th><th /></tr></thead>
                <tbody>
                  {list.data.map((v) => (
                    <tr key={v.userId}>
                      <td>{v.name}<div className="small muted">{v.email}</div></td>
                      <td>{VIEWER_LABEL[v.role]}</td>
                      <td className="small">{instantLabel(v.grantedAt)}</td>
                      <td><button type="button" className="btn danger" disabled={busy}
                        onClick={() => { if (window.confirm(`Cabut akses holding ${v.email}?`)) void run(() => api.admin.removeViewer(v.userId), `Akses holding ${v.email} dicabut.`); }}>Cabut</button></td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </Card>
        <div className="detail">
          <Card title="Beri akses">
            <form onSubmit={grant}>
              <fieldset disabled={busy} className="plain">
                <label className="field"><span>Email (akun sudah ada)</span><input type="email" value={email} onChange={(e) => setEmail(e.target.value)} /></label>
                <label className="field"><span>Akses</span>
                  <select value={role} onChange={(e) => setRole(e.target.value as ManagementRole)}>
                    {(Object.keys(VIEWER_LABEL) as ManagementRole[]).map((r) => <option key={r} value={r}>{VIEWER_LABEL[r]}</option>)}
                  </select>
                </label>
                <div className="actions"><button type="submit" className="btn primary">Beri akses</button></div>
              </fieldset>
            </form>
          </Card>
        </div>
      </div>
    </>
  );
}
