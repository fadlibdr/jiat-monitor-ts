import { describe, expect, it } from 'vitest';
import { parseIdrCents } from '../../src/domain/money.js';
import {
  amountPlain, currentMonthWib, dateLabel, groupThousands, instantLabel, miliar, minutesLabel, monthIndex, monthLabel, monthLong, monthShort,
  percentBp, percentMicro, periodOfIndex, points, rupiah, rupiahShort, shortRef,
} from '../../web/src/lib/format.js';

const MINUS = '−';
/** Rp 1 = 100 cents */
const RP = 100;
const JUTA = 1_000_000 * RP;
const MILIAR = 1_000_000_000 * RP;

describe('web format: money', () => {
  it('groups thousands with dots', () => {
    expect(groupThousands(0)).toBe('0');
    expect(groupThousands(999)).toBe('999');
    expect(groupThousands(1_234_567)).toBe('1.234.567');
    expect(groupThousands(-1_234)).toBe(`${MINUS}1.234`);
  });

  it('prints a full amount, cents only when there are any', () => {
    expect(rupiah(6_420_000_000 * RP)).toBe('Rp 6.420.000.000');
    expect(rupiah(12_345)).toBe('Rp 123,45');
    expect(rupiah(5)).toBe('Rp 0,05');
    expect(rupiah(-5 * RP)).toBe(`${MINUS}Rp 5`);
  });

  it('shortens to miliar (M) and juta (jt) like the mockup cards', () => {
    expect(rupiahShort(48_600_000_000 * RP)).toBe('Rp 48,6 M');
    expect(rupiahShort(410 * JUTA)).toBe('Rp 410 jt');
    expect(rupiahShort(1 * MILIAR)).toBe('Rp 1,0 M');
    expect(rupiahShort(1_600_000_000 * RP, { signed: true })).toBe('+Rp 1,6 M');
    expect(rupiahShort(-2_500_000_000 * RP, { signed: true })).toBe(`${MINUS}Rp 2,5 M`);
    expect(rupiahShort(0, { signed: true })).toBe('Rp 0');
    expect(rupiahShort(12_345 * RP)).toBe('Rp 12.345');
  });

  it('rounds juta to whole numbers and miliar to one decimal', () => {
    expect(rupiahShort(999_499_999 * RP)).toBe('Rp 999 jt');
    expect(rupiahShort(999_500_000 * RP)).toBe('Rp 1,0 M');
    expect(rupiahShort(1_049_999_999 * RP)).toBe('Rp 1,0 M');
    expect(rupiahShort(1_050_000_000 * RP)).toBe('Rp 1,1 M');
  });

  it('prints miliar without currency for "masuk 4,1 · keluar 2,5"', () => {
    expect(miliar(4_100_000_000 * RP)).toBe('4,1');
    expect(miliar(0)).toBe('0,0');
  });

  it('amountPlain is what the server parses back to the same cents (review form round trip)', () => {
    for (const cents of [100, 245_000_000, 12_345, 6_420_000_000 * RP, 99]) {
      expect(parseIdrCents(amountPlain(cents))).toBe(cents);
    }
    expect(amountPlain(245_000_000)).toBe('2.450.000');
  });
});

describe('web format: percentages and points', () => {
  it('prints micro-percent and basis points with a decimal comma', () => {
    expect(percentMicro(41_200_000)).toBe('41,2%');
    expect(percentMicro(100_000_000)).toBe('100,0%');
    expect(percentMicro(0)).toBe('0,0%');
    expect(percentMicro(null)).toBe('—');
    expect(percentMicro(undefined)).toBe('—');
    expect(percentBp(3_990)).toBe('39,9%');
    expect(percentBp(null)).toBe('—');
  });

  it('signs deviation points, but never "+0,0" or "−0,0"', () => {
    expect(points(-4_800_000)).toBe(`${MINUS}4,8`);
    expect(points(1_000_000)).toBe('+1,0');
    expect(points(40_000)).toBe('0,0');
    expect(points(-40_000)).toBe('0,0');
    expect(points(null)).toBe('—');
  });
});

describe('web format: dates', () => {
  it('places months on a calendar axis (S-curve x), across a year boundary', () => {
    expect(monthIndex('2026-12-01')! + 1).toBe(monthIndex('2027-01')!);
    expect(monthIndex('2026-08-01')! - monthIndex('2026-07-01')!).toBe(1);
    expect(monthIndex('2026-09-01')! - monthIndex('2026-07-01')!).toBe(2);
    expect(periodOfIndex(monthIndex('2027-01-01')!)).toBe('2027-01-01');
    expect(periodOfIndex(monthIndex('2026-12')!)).toBe('2026-12-01');
    expect(monthIndex('2026-13-01')).toBeNull();
    expect(monthIndex('2026-00-01')).toBeNull();
    expect(monthIndex('garbage')).toBeNull();
  });

  it('names months in Indonesian', () => {
    expect(monthLabel('2026-10-01')).toBe('Okt 2026');
    expect(monthLong('2026-08-01')).toBe('Agustus 2026');
    expect(monthShort('2026-02-01')).toBe('Feb');
    expect(monthLabel('garbage')).toBe('garbage');
  });

  it('prints calendar dates without a time zone shift', () => {
    expect(dateLabel('2026-10-07')).toBe('7 Okt 2026');
    expect(dateLabel(null)).toBe('—');
  });

  it('prints instants in WIB (UTC+7), across midnight too', () => {
    expect(instantLabel('2026-10-26T10:15:00Z')).toBe('26 Okt 2026 · 17:15');
    expect(instantLabel('2026-10-26T18:30:00Z')).toBe('27 Okt 2026 · 01:30');
    expect(instantLabel(new Date('2026-12-31T17:00:00Z'))).toBe('1 Jan 2027 · 00:00');
    expect(instantLabel('not a date')).toBe('—');
    expect(instantLabel(null)).toBe('—');
  });

  it('takes the current month in WIB, not UTC', () => {
    expect(currentMonthWib(new Date('2026-10-31T18:00:00Z'))).toBe('2026-11');
    expect(currentMonthWib(new Date('2026-10-31T16:59:00Z'))).toBe('2026-10');
  });

  it('prints durations as hours and minutes', () => {
    expect(minutesLabel(220)).toBe('3 j 40 m');
    expect(minutesLabel(45)).toBe('45 m');
    expect(minutesLabel(120)).toBe('2 j');
    expect(minutesLabel(59.6)).toBe('1 j');
    expect(minutesLabel(null)).toBe('—');
  });
});

describe('web format: references', () => {
  it('uses the chat reference: last 4 hex of the row uuid', () => {
    expect(shortRef('0f3c1d2e-aaaa-4bbb-8ccc-0123456A3F2A')).toBe('#3f2a');
  });
});
