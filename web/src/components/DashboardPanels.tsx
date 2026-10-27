import { useState } from 'react';
import {
  groupThousands, minutesLabel, miliar, monthLabel, percentBp, percentMicro, points, rupiah, rupiahShort,
} from '../lib/format';
import { ALERT_TONE, contractStatus, daysTone, progressNote } from '../lib/status';
import type { Panels } from '../lib/types';
import { SCurve } from './SCurve';
import { Bar, Card, Kpi, Mini, Pill, type Tone } from './ui';

const CONTRACTS_SHOWN = 5;
const VENDORS_SHOWN = 5;
const ASK_RATE_TARGET_BP = 1_000;
const AGING = [
  { key: 'd0_30', label: '0–30', color: 'var(--navy)' },
  { key: 'd31_60', label: '31–60', color: 'var(--steel)' },
  { key: 'd61_90', label: '61–90', color: 'var(--amber)' },
  { key: 'd90p', label: '>90', color: 'var(--red-ink)' },
] as const;

export interface Names {
  company: (id: number) => string;
  /** short company label for narrow columns (code) */
  companyCode: (id: number) => string;
  site: (id: number) => string;
}

/**
 * The dashboard body of the holding mockup, from the panels the API returns (src/dashboard/panels.ts).
 * Used by the holding dashboard (all companies) and the company dashboard (one company, live).
 * `finance` is null when the caller may not see money owed or owing.
 */
export function DashboardPanels({ p, names, multiCompany }: { p: Omit<Panels, 'finance'> & { finance: Panels['finance'] | null }; names: Names; multiCompany: boolean }) {
  const [allContracts, setAllContracts] = useState(false);
  const s = p.summary;
  const prog = s.progress;
  const contracts = allContracts ? p.contracts : p.contracts.slice(0, CONTRACTS_SHOWN);
  const maxPhotos = Math.max(1, ...p.intake.perSite.map((x) => x.photos7d));
  const topCats = p.procurement.commitment.byCategory.slice(0, 2)
    .map((c) => `${c.category} ${percentBp(c.shareOfCommittedBp).replace(',0%', '%')}`).join(' · ');

  return (
    <>
      <div className="grid g4" id="ringkasan">
        <Kpi label="Kontrak" value={groupThousands(s.contracts)} sub={multiCompany ? `di ${s.sites} lokasi · ${s.companies} perusahaan` : `di ${s.sites} lokasi`} />
        <Kpi
          label="Nilai kontrak (DPP)"
          value={rupiahShort(s.valueDppEffectiveCents)}
          sub={s.addendumDeltaCents ? `termasuk adendum ${rupiahShort(s.addendumDeltaCents, { signed: true })}` : `${rupiahShort(s.valueTotalCents)} dengan PPN`}
        />
        <Kpi label="Realisasi biaya" value={rupiahShort(s.costRealisedCents)} sub={s.budgetCents ? `${percentBp(s.costOfBudgetBp)} dari anggaran BOQ` : 'anggaran BOQ belum ada'} />
        <Kpi
          label="Progres tertimbang"
          value={percentMicro(prog?.actualMicroPct)}
          sub={prog ? `rencana ${percentMicro(prog.plannedMicroPct)} · deviasi ${points(prog.deviationMicroPct)}` : 'belum ada rencana'}
          subTone={progressNote(prog).tone === 'green' ? 'plain' : (progressNote(prog).tone as Tone)}
        />
      </div>

      <div className="grid g-wide" id="progres">
        <Card title="Kurva S gabungan" eyebrow={p.curve.length ? `${monthLabel(p.curve[0]!.period)} – ${monthLabel(p.curve.at(-1)!.period)}` : undefined}>
          <SCurve points={p.curve} period={p.period} />
        </Card>
        <Card title={multiCompany ? 'Per perusahaan' : 'Per lokasi'}>
          {multiCompany ? p.byCompany.map((c) => {
            const note = progressNote(c.progress);
            return (
              <div className="company-row" key={c.companyId}>
                <div className="top"><b>{names.company(c.companyId)}</b><span className="mono small">{c.contracts} kontrak · {rupiahShort(c.valueDppEffectiveCents)}</span></div>
                <Bar fraction={(c.progress?.actualMicroPct ?? 0) / 100_000_000} label={`Progres ${names.company(c.companyId)}`} />
                <div className="bottom"><span>progres {percentMicro(c.progress?.actualMicroPct)}</span><span className={`t-${note.tone}`}>{note.text}</span></div>
              </div>
            );
          }) : p.contracts.map((k) => {
            const note = progressNote(k.progress);
            return (
              <div className="company-row" key={k.contractId}>
                <div className="top"><b>{names.site(k.siteId)}</b><span className="mono small">{rupiahShort(k.valueDppEffectiveCents)}</span></div>
                <Bar fraction={(k.progress?.actualMicroPct ?? 0) / 100_000_000} label={`Progres ${k.number}`} />
                <div className="bottom"><span>progres {percentMicro(k.progress?.actualMicroPct)}</span><span className={`t-${note.tone}`}>{note.text}</span></div>
              </div>
            );
          })}
          {(multiCompany ? p.byCompany : p.contracts).length === 0 && <div className="empty">Tidak ada kontrak pada filter ini.</div>}
        </Card>
      </div>

      <Card title="Kontrak" eyebrow={`${p.contracts.length} kontrak · diurutkan sisa hari`} id="kontrak" className="grid">
        <div className="table-wrap">
          <table>
            <thead>
              <tr>
                {multiCompany && <th>Perusahaan</th>}
                <th>Lokasi</th><th>No. kontrak</th><th>Pemberi kerja</th>
                <th className="num">Nilai DPP</th><th className="num">Progres</th><th className="num">Termin</th><th className="num">Sisa hari</th><th>Status</th>
              </tr>
            </thead>
            <tbody>
              {contracts.map((k) => {
                const st = contractStatus(k);
                return (
                  <tr key={k.contractId}>
                    {multiCompany && <td>{names.company(k.companyId)}</td>}
                    <td>{names.site(k.siteId)}</td>
                    <td className="code">{k.number}</td>
                    <td>{k.employerName}</td>
                    <td className="num" title={`${rupiah(k.valueTotalCents)} dengan PPN`}>{rupiah(k.valueDppEffectiveCents)}</td>
                    <td className="num">{percentMicro(k.progress?.actualMicroPct)}</td>
                    <td className="num">{k.termsIssued} / {k.termsTotal}</td>
                    <td className={`num t-${daysTone(k.daysLeft)}`}>{k.daysLeft ?? '—'}</td>
                    <td><Pill tone={st.tone}>{st.text}</Pill></td>
                  </tr>
                );
              })}
            </tbody>
          </table>
          {p.contracts.length === 0 && <div className="empty">Tidak ada kontrak pada filter ini.</div>}
        </div>
        {p.contracts.length > CONTRACTS_SHOWN && (
          <p><button type="button" className="linkish" onClick={() => setAllContracts((v) => !v)}>
            {allContracts ? 'Tampilkan lebih sedikit' : `Tampilkan ${p.contracts.length - CONTRACTS_SHOWN} kontrak lainnya →`}
          </button></p>
        )}
      </Card>

      <div className="grid g2">
        <Card title="Invoicing & kas" id="keuangan">
          {p.finance ? (
            <>
              <div className="minis">
                <Mini label="Piutang termin" value={rupiahShort(p.finance.receivableCents)} sub={`${p.finance.receivableCount} tagihan terbit`} />
                <Mini
                  label="Hutang vendor"
                  value={rupiahShort(p.finance.payableCents)}
                  sub={p.finance.payableOverdueCents ? `${rupiahShort(p.finance.payableOverdueCents)} lewat jatuh tempo` : 'tidak ada yang lewat jatuh tempo'}
                  subTone={p.finance.payableOverdueCents ? 'red' : 'plain'}
                />
                <Mini
                  label={`Kas ${monthLabel(p.finance.cash.period)}`}
                  value={rupiahShort(p.finance.cash.netCents, { signed: true })}
                  sub={`masuk ${miliar(p.finance.cash.inCents)} · keluar ${miliar(p.finance.cash.outCents)} (M)`}
                />
              </div>
              <div className="eyebrow" style={{ marginTop: 18 }}>Umur piutang</div>
              <div className="stack" role="img" aria-label="Umur piutang">
                {AGING.map((a) => (
                  <i key={a.key} style={{ width: `${p.finance!.receivableCents ? (p.finance!.aging[a.key] / p.finance!.receivableCents) * 100 : 0}%`, background: a.color }} />
                ))}
              </div>
              <div className="legend">
                {AGING.map((a) => <span key={a.key}>{a.label} · {rupiahShort(p.finance!.aging[a.key])}</span>)}
              </div>
            </>
          ) : <div className="empty">Ringkasan keuangan hanya untuk peran keuangan dan manajer.</div>}
        </Card>

        <Card title="Pembelian" id="pembelian">
          <div className="minis">
            <Mini label="PR terbuka" value={groupThousands(p.procurement.prOpen)} sub={`${p.procurement.prWaiting} menunggu persetujuan`} />
            <Mini
              label="PO outstanding"
              value={rupiahShort(p.procurement.poOutstandingCents)}
              sub={`${p.procurement.poOverdueCount} PO > 30 hari`}
              subTone={p.procurement.poOverdueCount ? 'amber' : 'plain'}
            />
            <Mini label="Komitmen vs BOQ" value={percentBp(p.procurement.commitment.committedOfBudgetBp)} sub={topCats || '—'} />
          </div>
          {p.procurement.topVendors.length > 0 && (
            <div className="table-wrap" style={{ marginTop: 16 }}>
              <table>
                <thead><tr><th>Vendor terbesar</th>{multiCompany && <th>Perusahaan</th>}<th className="num">Nilai PO</th><th className="num">Belum diterima</th></tr></thead>
                <tbody>
                  {p.procurement.topVendors.slice(0, VENDORS_SHOWN).map((v) => (
                    <tr key={`${v.companyId}:${v.vendorId}`}>
                      <td>{v.vendorName}</td>
                      {multiCompany && <td>{names.companyCode(v.companyId)}</td>}
                      <td className="num">{rupiah(v.poValueCents)}</td>
                      <td className={`num ${v.undeliveredCents ? 't-red' : ''}`}>{rupiah(v.undeliveredCents)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </Card>
      </div>

      <div className="grid g-wide">
        <Card title="Peringatan" eyebrow={`${p.alerts.length} aktif`} id="peringatan">
          {p.alerts.length === 0 ? <div className="empty">Tidak ada peringatan.</div> : (
            <table className="alerts">
              <tbody>
                {p.alerts.map((a) => (
                  <tr key={`${a.companyId}:${a.kind}:${a.ref}`}>
                    <td><Pill tone={ALERT_TONE[a.kind]}>{a.label}</Pill></td>
                    <td>{multiCompany ? `${names.company(a.companyId)} · ` : ''}{names.site(a.siteId)} · {a.text}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </Card>

        <Card title="Intake lapangan" id="intake">
          <div className="minis" style={{ gridTemplateColumns: 'repeat(2, minmax(0, 1fr))' }}>
            <Mini label="Foto masuk, 7 hari" value={groupThousands(p.intake.photos7d)} sub={`${p.intake.sitesWithPhotos} lokasi`} />
            <Mini
              label="Perlu konfirmasi"
              value={groupThousands(p.intake.openKonfirmasi + p.intake.openCek)}
              sub={`${p.intake.openCek} perlu cek`}
              subTone={p.intake.openCek ? 'amber' : 'plain'}
            />
            <Mini
              label="Ask rate"
              value={percentBp(p.intake.askRateBp)}
              sub="target < 10%"
              subTone={p.intake.askRateBp !== null && p.intake.askRateBp >= ASK_RATE_TARGET_BP ? 'amber' : 'green'}
            />
            <Mini label="Waktu sampai terkonfirmasi" value={minutesLabel(p.intake.medianConfirmMinutes7d)} sub="median, 7 hari" />
          </div>
          {p.intake.perSite.length > 0 && (
            <>
              <div className="eyebrow" style={{ margin: '16px 0 8px' }}>Per lokasi</div>
              <div className="persite">
                {p.intake.perSite.map((x) => (
                  <PerSite key={`${x.companyId}:${x.siteId}`} name={names.site(x.siteId)} count={x.photos7d} max={maxPhotos} />
                ))}
              </div>
            </>
          )}
        </Card>
      </div>
    </>
  );
}

function PerSite({ name, count, max }: { name: string; count: number; max: number }) {
  return (
    <>
      <span>{name}</span>
      <Bar fraction={count / max} label={`Foto ${name}`} />
      <span className="num">{count}</span>
    </>
  );
}
