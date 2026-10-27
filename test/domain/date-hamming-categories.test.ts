import { describe, expect, it } from 'vitest';
import { parseIndonesianDate } from '../../src/domain/date.js';
import { hammingDistance, isNearDuplicate } from '../../src/domain/hamming.js';
import { CATEGORIES, categoryFromDescription, isCategory, normalizeCategory } from '../../src/domain/categories.js';

describe('parseIndonesianDate', () => {
  it.each([
    ['21/06/2026', '2026-06-21'],
    ['21-06-2026', '2026-06-21'],
    ['21.06.2026', '2026-06-21'],
    ['2026-06-21', '2026-06-21'],
    ['1/6/2026', '2026-06-01'],
    ['21 Juni 2026', '2026-06-21'],
    ['21 jun 2026', '2026-06-21'],
    ['5 Agt. 2026', '2026-08-05'],
    ['21/06/26', null], // dua digit tahun tidak ditebak
    ['31/02/2026', null],
    ['21/13/2026', null],
    ['21 Jumat 2026', null],
    ['', null],
    ['21/06/1999', null],
  ])('%s -> %s', (input, expected) => {
    expect(parseIndonesianDate(input)).toBe(expected);
  });
});

describe('hammingDistance (pHash 64-bit as 16 hex chars)', () => {
  it('counts differing bits per hex nibble', () => {
    expect(hammingDistance('0', '0')).toBe(0);
    expect(hammingDistance('f', '0')).toBe(4);
    expect(hammingDistance('ffffffffffffffff', '0000000000000000')).toBe(64);
    expect(hammingDistance('8f3a', '8f3b')).toBe(1);
  });
  it('rejects empty strings (a pHash is never empty)', () => {
    expect(() => hammingDistance('', '')).toThrow(RangeError);
  });
  it('isNearDuplicate accepts ≤ 6 differing bits and rejects 7', () => {
    expect(isNearDuplicate('0000000000000000', '000000000000003f')).toBe(true); // 6 bit
    expect(isNearDuplicate('0000000000000000', '000000000000007f')).toBe(false); // 7 bit
  });
  it('throws RangeError on unequal length or non-hex input', () => {
    expect(() => hammingDistance('abc', 'ab')).toThrow(RangeError);
    expect(() => hammingDistance('xyz', 'abc')).toThrow(RangeError);
    expect(() => hammingDistance('', 'a')).toThrow(RangeError);
  });
});

describe('categoryFromDescription (intake fallback after vendor.default_category)', () => {
  it('matches whole words only, case-insensitive', () => {
    expect(categoryFromDescription('Semen 40 sak')).toBe('material');
    expect(categoryFromDescription('SOLAR 200 liter')).toBe('operasional');
    expect(categoryFromDescription('Sewa  alat molen 3 hari')).toBe('alat');
    expect(categoryFromDescription('semennya kurang')).toBeNull(); // substring is not a word
  });
  it('null when nothing matches, when two categories match (ambiguous), or for empty input', () => {
    expect(categoryFromDescription('Pembelian umum')).toBeNull();
    expect(categoryFromDescription('Semen 40 sak + upah tukang')).toBeNull();
    expect(categoryFromDescription('')).toBeNull();
    expect(categoryFromDescription(null)).toBeNull();
  });
});

describe('categories (single source of truth)', () => {
  it('canonical slugs', () => {
    for (const c of CATEGORIES) expect(isCategory(c)).toBe(true);
    expect(isCategory('Material')).toBe(false);
  });
  it('maps P2X spec labels and typos of case/space', () => {
    expect(normalizeCategory('Material')).toBe('material');
    expect(normalizeCategory('Peralatan')).toBe('alat');
    expect(normalizeCategory('Transportasi')).toBe('operasional');
    expect(normalizeCategory('Konsumsi')).toBe('operasional');
    expect(normalizeCategory('Jasa')).toBe('upah');
    expect(normalizeCategory('Lain-lain')).toBe('lain');
    expect(normalizeCategory('  SEWA   ALAT ')).toBe('alat');
    expect(normalizeCategory('pemeliharaan')).toBeNull();
  });
});
