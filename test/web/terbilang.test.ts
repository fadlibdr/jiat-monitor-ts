import { describe, expect, it } from 'vitest';
import { numberWords, terbilangRupiah } from '../../web/src/lib/terbilang.js';

describe('terbilang', () => {
  it('reads the irregular Indonesian forms', () => {
    const cases: Array<[number, string]> = [
      [0, 'nol'], [1, 'satu'], [10, 'sepuluh'], [11, 'sebelas'], [12, 'dua belas'], [19, 'sembilan belas'], [20, 'dua puluh'],
      [21, 'dua puluh satu'], [100, 'seratus'], [101, 'seratus satu'], [111, 'seratus sebelas'], [250, 'dua ratus lima puluh'],
      [1_000, 'seribu'], [1_001, 'seribu satu'], [1_100, 'seribu seratus'], [2_000, 'dua ribu'], [11_000, 'sebelas ribu'],
      [100_000, 'seratus ribu'], [1_000_000, 'satu juta'], [1_001_000, 'satu juta seribu'], [1_000_000_000, 'satu miliar'],
      [2_591_700_000, 'dua miliar lima ratus sembilan puluh satu juta tujuh ratus ribu'],
      [1_000_000_000_000, 'satu triliun'],
    ];
    for (const [n, words] of cases) expect(numberWords(n), String(n)).toBe(words);
  });

  it('refuses what is not a whole non-negative safe number', () => {
    expect(() => numberWords(-1)).toThrow(RangeError);
    expect(() => numberWords(1.5)).toThrow(RangeError);
    expect(() => numberWords(Number.MAX_SAFE_INTEGER + 1)).toThrow(RangeError);
  });

  it('rupiah from cents, sen only when there are any, capitalised', () => {
    expect(terbilangRupiah(259_170_000_000)).toBe('Dua miliar lima ratus sembilan puluh satu juta tujuh ratus ribu rupiah');
    expect(terbilangRupiah(10_050)).toBe('Seratus rupiah lima puluh sen');
    expect(terbilangRupiah(0)).toBe('Nol rupiah');
    expect(terbilangRupiah(-100_000)).toBe('Minus seribu rupiah');
    expect(terbilangRupiah(Number.MAX_SAFE_INTEGER)).toMatch(/^Sembilan puluh triliun .* rupiah sembilan puluh satu sen$/);
  });
});
