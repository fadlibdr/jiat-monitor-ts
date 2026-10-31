// explicit .js: these files are also compiled by the root typecheck (NodeNext) for test/web/*
import { points } from './format.js';
import type { AlertKind, CurvePoint, PanelContract } from './types.js';

/** Same line as the server's "deviasi_progres" alert (src/dashboard/snapshot.ts ALERT_RULES): behind by more than 10 points. */
export const BEHIND_MICRO = -10_000_000;
/** A watch zone before the alert line, shown amber on the dashboard only (UI choice, no alert). */
export const WATCH_MICRO = -5_000_000;
/** Same line as the "kontrak_mendekati_batas" alert: 30 days or fewer left. */
export const DAYS_URGENT = 30;
export const DAYS_SOON = 60;

export type StatusTone = 'red' | 'amber' | 'green' | 'blue' | 'plain';

/** The status pill of a contract row (holding mockup: "Tertinggal", "Termin 3 siap", "Deviasi −9,2", "Sesuai rencana"). */
export function contractStatus(k: Pick<PanelContract, 'progress' | 'termsIssued' | 'termsReady'>): { tone: StatusTone; text: string } {
  const dev = k.progress?.deviationMicroPct ?? null;
  if (k.progress?.actualMicroPct === null || k.progress?.actualMicroPct === undefined) return { tone: 'plain', text: 'Belum ada opname' };
  if (dev !== null && dev < BEHIND_MICRO) return { tone: 'red', text: 'Tertinggal' };
  // terms are billed in sequence, so the ready one is the next after those issued
  if (k.termsReady > 0) return { tone: 'amber', text: `Termin ${k.termsIssued + 1} siap` };
  if (dev !== null && dev < WATCH_MICRO) return { tone: 'amber', text: `Deviasi ${points(dev)}` };
  return { tone: 'green', text: 'Sesuai rencana' };
}

/** "sesuai rencana" / "tertinggal −11,4" under a company's progress bar. */
export function progressNote(p: CurvePoint | null): { tone: StatusTone; text: string } {
  if (!p || p.actualMicroPct === null) return { tone: 'plain', text: 'belum ada opname' };
  const dev = p.deviationMicroPct ?? 0;
  if (dev < BEHIND_MICRO) return { tone: 'red', text: `tertinggal ${points(dev)}` };
  if (dev < WATCH_MICRO) return { tone: 'amber', text: `deviasi ${points(dev)}` };
  return { tone: 'green', text: 'sesuai rencana' };
}

export function daysTone(daysLeft: number | null): StatusTone {
  if (daysLeft === null) return 'plain';
  if (daysLeft <= DAYS_URGENT) return 'red';
  return daysLeft <= DAYS_SOON ? 'amber' : 'plain';
}

/** Money owed or owing is red; slipping schedule amber; a termin ready to bill is good news (blue). */
export const ALERT_TONE: Record<AlertKind, StatusTone> = {
  termin_jatuh_tempo: 'red',
  vendor_overdue: 'red',
  deviasi_progres: 'amber',
  po_lewat_30_hari: 'amber',
  kontrak_mendekati_batas: 'amber',
  termin_siap: 'blue',
};

export const ROLE_LABEL: Record<string, string> = {
  site_staff: 'Staf site',
  project_admin: 'Admin proyek',
  finance: 'Keuangan',
  company_manager: 'Manajer perusahaan',
  system_admin: 'Admin sistem',
};

export const CONTRACT_STATUS_LABEL: Record<string, string> = {
  draft: 'Draf',
  active: 'Aktif',
  completed: 'Selesai',
  terminated: 'Dihentikan',
};
