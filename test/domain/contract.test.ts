import { describe, expect, it } from 'vitest';
import { daysLeft, effectiveContract, formatBp, ppnOf, roundDiv, validateTerms } from '../../src/domain/contract.js';

describe('effectiveContract', () => {
  const base = { valueDppCents: 1_000_000_00, ppnRateBp: 1100, endDate: '2026-12-31' };

  it('without addenda equals the original, PPN derived', () => {
    expect(effectiveContract(base, [])).toEqual({
      valueDppEffectiveCents: 1_000_000_00, addendumDeltaCents: 0, valueTotalCents: 1_110_000_00, endDateEffective: '2026-12-31',
    });
  });

  it('sums signed deltas and takes the end date of the latest addendum that sets one (by signing date)', () => {
    const e = effectiveContract(base, [
      { signedAt: '2026-09-01', valueDeltaCents: -50_000_00, endDateNew: null },
      { signedAt: '2026-08-01', valueDeltaCents: 200_000_00, endDateNew: '2027-01-31' },
    ]);
    expect(e.addendumDeltaCents).toBe(150_000_00);
    expect(e.valueDppEffectiveCents).toBe(1_150_000_00);
    expect(e.valueTotalCents).toBe(1_276_500_00);
    expect(e.endDateEffective).toBe('2027-01-31'); // the later (Sept) addendum did not move it
  });

  it('a contract without an end date stays without one unless an addendum sets it', () => {
    const open = { ...base, endDate: null };
    expect(effectiveContract(open, []).endDateEffective).toBeNull();
    expect(effectiveContract(open, [{ signedAt: '2026-08-01', valueDeltaCents: 0, endDateNew: null }]).endDateEffective).toBeNull();
    expect(effectiveContract(open, [{ signedAt: '2026-08-01', valueDeltaCents: 0, endDateNew: '2027-03-31' }]).endDateEffective).toBe('2027-03-31');
  });
});

describe('ppnOf / roundDiv', () => {
  it('rounds half away from zero to the cent', () => {
    expect(ppnOf(5, 1100)).toBe(1); // 0.55 -> 1
    expect(ppnOf(4, 1100)).toBe(0); // 0.44 -> 0
    expect(roundDiv(-15, 10)).toBe(-2);
    expect(roundDiv(14, 10)).toBe(1);
  });
});

describe('daysLeft', () => {
  it('counts calendar days from today\'s WIB date; negative when past; null without an end date', () => {
    const today = new Date('2026-10-27T16:59:00Z'); // 23:59 WIB on the 27th
    expect(daysLeft('2026-10-27', today)).toBe(0);
    expect(daysLeft('2026-11-30', today)).toBe(34);
    expect(daysLeft('2026-10-20', today)).toBe(-7);
    expect(daysLeft(null, today)).toBeNull();
  });

  it('after midnight WIB it is already the next day on site, though not yet in UTC', () => {
    const justAfter = new Date('2026-10-27T17:00:00Z'); // 00:00 WIB on the 28th
    expect(daysLeft('2026-10-27', justAfter)).toBe(-1);
    expect(daysLeft('2026-10-28', justAfter)).toBe(0);
  });
});

describe('validateTerms', () => {
  const t = (seq: number, percentBp: number, triggerProgressBp: number) => ({ seq, name: `Termin ${seq}`, percentBp, triggerProgressBp, dueDays: 30 });

  it('accepts a complete schedule and reports it complete', () => {
    expect(validateTerms([t(1, 3000, 2500), t(2, 3000, 5000), t(3, 4000, 10000)])).toEqual({ errors: [], complete: true, totalBp: 10000 });
  });
  it('an empty schedule is valid, total 0, not complete', () => {
    expect(validateTerms([])).toEqual({ errors: [], complete: false, totalBp: 0 });
  });
  it('a draft below 100 % is valid but not complete', () => {
    expect(validateTerms([t(1, 3000, 2500)])).toMatchObject({ errors: [], complete: false });
  });
  it('refuses Σ > 100 %, duplicate seq and a decreasing trigger', () => {
    const r = validateTerms([t(1, 6000, 5000), t(2, 5000, 4000), t(2, 1, 9000)]);
    expect(r.errors).toEqual(expect.arrayContaining([
      'seq 2 ganda', expect.stringMatching(/ambang progres termin 2/), 'jumlah persen termin 110.01% melebihi 100%',
    ]));
  });
  it('formatBp trims trailing zeros', () => {
    expect([formatBp(10000), formatBp(2050), formatBp(0)]).toEqual(['100%', '20.5%', '0%']);
  });
});
