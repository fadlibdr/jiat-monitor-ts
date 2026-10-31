import { describe, expect, it } from 'vitest';
import { ALERT_RULES } from '../../src/dashboard/snapshot.js';
import { ALERT_KINDS, COMPANY_ROLES, VENDOR_INVOICE_STATUSES } from '../../src/db/schema.js';
import { CATEGORIES, CATEGORY_LABEL as SERVER_CATEGORY_LABEL } from '../../src/domain/categories.js';
import { flagText } from '../../src/intake/replies.js';
import { REVIEW_FLAGS } from '../../src/intake/review.js';
import { CATEGORY_LABEL, FLAG_TEXT, INTAKE_STATUS_LABEL } from '../../web/src/lib/labels.js';
import {
  ALERT_TONE, BEHIND_MICRO, contractStatus, DAYS_URGENT, daysTone, progressNote, ROLE_LABEL,
} from '../../web/src/lib/status.js';

const MINUS = '−';
const PCT = 1_000_000;
const point = (planned: number, actual: number | null) => ({
  period: '2026-10-01', plannedMicroPct: planned * PCT, actualMicroPct: actual === null ? null : actual * PCT,
  deviationMicroPct: actual === null ? null : (actual - planned) * PCT,
});

/** The SPA repeats a few server words and thresholds; these keep the two sides from drifting apart. */
describe('web labels match the server', () => {
  it('uses the alert thresholds of ALERT_RULES', () => {
    expect(BEHIND_MICRO).toBe(ALERT_RULES.deviationBelowMicroPct);
    expect(DAYS_URGENT).toBe(ALERT_RULES.contractDaysLeftAtMost);
  });

  it('has a tone for every alert kind, a label for every role and intake status', () => {
    expect(Object.keys(ALERT_TONE).sort()).toEqual([...ALERT_KINDS].sort());
    expect(Object.keys(ROLE_LABEL).sort()).toEqual([...COMPANY_ROLES].sort());
    expect(Object.keys(INTAKE_STATUS_LABEL).sort()).toEqual([...VENDOR_INVOICE_STATUSES].sort());
  });

  it('names categories as the server does', () => {
    expect(Object.keys(CATEGORY_LABEL).sort()).toEqual([...CATEGORIES].sort());
    for (const c of CATEGORIES) expect(CATEGORY_LABEL[c]).toBe(SERVER_CATEGORY_LABEL[c]);
  });

  it('explains every review flag with the chat reply wording', () => {
    for (const f of [...REVIEW_FLAGS, 'npwp_format', 'kategori_kosong']) expect(FLAG_TEXT[f]).toBe(flagText([f])[0]);
  });
});

describe('contract status pill', () => {
  it('is red "Tertinggal" only below the alert line, like the deviasi_progres alert', () => {
    expect(contractStatus({ progress: point(50, 39), termsIssued: 1, termsReady: 0 })).toEqual({ tone: 'red', text: 'Tertinggal' });
    // exactly −10 is not below the line
    expect(contractStatus({ progress: point(50, 40), termsIssued: 1, termsReady: 0 }).tone).toBe('amber');
  });

  it('shows the next termin as ready, since termin are billed in sequence', () => {
    expect(contractStatus({ progress: point(40, 41), termsIssued: 2, termsReady: 1 })).toEqual({ tone: 'amber', text: 'Termin 3 siap' });
  });

  it('marks a deviation between −5 and −10 points amber with its value', () => {
    expect(contractStatus({ progress: point(45, 35.8), termsIssued: 1, termsReady: 0 })).toEqual({ tone: 'amber', text: `Deviasi ${MINUS}9,2` });
  });

  it('is green when on plan, and plain before the first approved opname', () => {
    expect(contractStatus({ progress: point(40, 38), termsIssued: 1, termsReady: 0 })).toEqual({ tone: 'green', text: 'Sesuai rencana' });
    expect(contractStatus({ progress: point(40, null), termsIssued: 0, termsReady: 0 }).tone).toBe('plain');
    expect(contractStatus({ progress: null, termsIssued: 0, termsReady: 0 }).tone).toBe('plain');
  });
});

describe('progress note and days left', () => {
  it('words the company progress line', () => {
    expect(progressNote(point(48, 36.6))).toEqual({ tone: 'red', text: `tertinggal ${MINUS}11,4` });
    expect(progressNote(point(48, 41))).toEqual({ tone: 'amber', text: `deviasi ${MINUS}7,0` });
    expect(progressNote(point(48, 48.3)).text).toBe('sesuai rencana');
    expect(progressNote(null).tone).toBe('plain');
  });

  it('colours days left at the alert line (≤ 30) and a softer one (≤ 60)', () => {
    expect(daysTone(30)).toBe('red');
    expect(daysTone(-3)).toBe('red');
    expect(daysTone(31)).toBe('amber');
    expect(daysTone(60)).toBe('amber');
    expect(daysTone(61)).toBe('plain');
    expect(daysTone(null)).toBe('plain');
  });
});
