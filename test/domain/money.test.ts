import { describe, expect, it } from 'vitest';
import { centsToDecimalString, decimalStringToCents, formatRupiah, parseIdrCents } from '../../src/domain/money.js';

// Ported from tests/Unit/Intake/MoneyParserTest.php (PHP build 01) + regression cases B4 / L2.
const cases: Array<[string, string, number | null]> = [
  ['rupiah dengan titik ribuan dan koma desimal', 'Rp 2.450.000,00', 245_000_000],
  ['koma ribuan gaya inggris', '2,450,000', 245_000_000],
  ['titik ribuan tanpa desimal', '2.450.000', 245_000_000],
  ['angka polos', '2450000', 245_000_000],
  ['Rp. dengan spasi', 'Rp. 1.250.000', 125_000_000],
  ['desimal koma dua digit', '12,50', 1250],
  ['ribuan satu titik', '2.450', 245_000],
  ['nol di depan', '0007', 700],
  ['titik + 2 digit ambigu -> null', '245.50', null],
  ['titik + 1 digit ambigu -> null', '12.5', null],
  ['grup salah -> null', '1.234.56', null],
  ['huruf -> null', 'dua juta', null],
  ['kosong -> null', '', null],
  ['campur: titik ribuan, koma desimal', '1.234.567,89', 123_456_789],
  ['campur: koma ribuan, titik desimal', '1,234,567.89', 123_456_789],
  // B4: notasi nota paling umum
  ['B4: sufiks ,-', 'Rp 2.450.000,-', 245_000_000],
  ['B4: sufiks .-', '2.450.000.-', 245_000_000],
  ['B4: sufiks ,- tanpa ribuan', '12,-', 1200],
  // L2: desimal koma satu digit (volume RAB sebagai teks)
  ['L2: desimal koma 1 digit', '2,5', 250],
  ['IDR prefix', 'IDR 100', 10_000],
  ['tanda minus di tengah -> null', '2.450-000', null],
  ['NBSP di dalam', 'Rp 2.450.000', 245_000_000],
];

describe('parseIdrCents', () => {
  it.each(cases)('%s', (_name, input, expected) => {
    expect(parseIdrCents(input)).toBe(expected);
  });
  it('null/undefined -> null', () => {
    expect(parseIdrCents(null)).toBeNull();
    expect(parseIdrCents(undefined)).toBeNull();
  });
});

describe('cents <-> decimal string', () => {
  it('round-trips', () => {
    expect(centsToDecimalString(245_000_000)).toBe('2450000.00');
    expect(centsToDecimalString(-150)).toBe('-1.50');
    expect(centsToDecimalString(5)).toBe('0.05');
    expect(decimalStringToCents('2450000.00')).toBe(245_000_000);
    expect(decimalStringToCents('2450000')).toBe(245_000_000);
    expect(decimalStringToCents('0.5')).toBe(50);
    expect(decimalStringToCents('-1.50')).toBe(-150);
  });
  it('rejects non-decimal', () => {
    expect(() => decimalStringToCents('2.450.000')).toThrow(TypeError);
  });
  it('formats rupiah', () => {
    expect(formatRupiah(245_000_050)).toBe('Rp 2.450.000,50');
    expect(formatRupiah(0)).toBe('Rp 0,00');
  });
});
