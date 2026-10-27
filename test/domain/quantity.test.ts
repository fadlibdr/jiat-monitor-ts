import { describe, expect, it } from 'vitest';
import { lineAmountCents, parseQty, qtyToString, receiptStatus } from '../../src/domain/quantity.js';

describe('parseQty / qtyToString', () => {
  it('reads dot or comma decimals up to 4 places, and integers', () => {
    expect([parseQty('12.5'), parseQty('12,5'), parseQty(40), parseQty('0.0001'), parseQty('0')]).toEqual([125_000, 125_000, 400_000, 1, 0]);
  });
  it('refuses negatives, more than 4 decimals, empty and garbage', () => {
    expect([parseQty('-1'), parseQty('1.23456'), parseQty(''), parseQty('abc'), parseQty('1.2.3'), parseQty(Number.NaN)]).toEqual([null, null, null, null, null, null]);
  });
  it('round-trips to the numeric(18,4) text form', () => {
    expect([qtyToString(125_000), qtyToString(1), qtyToString(0)]).toEqual(['12.5000', '0.0001', '0.0000']);
    expect(parseQty(qtyToString(987_654_321))).toBe(987_654_321);
  });
});

describe('lineAmountCents', () => {
  it('is qty × unit price, exact and rounded to the cent', () => {
    expect(lineAmountCents(parseQty('40')!, 42_000_00)).toBe(1_680_000_00); // Semen 40 sak × Rp 42.000
    expect(lineAmountCents(parseQty('2.5')!, 3)).toBe(8); // 7.5 cents → 8
    // 1 000 000 units × Rp 10.000: qty4 × price = 1e10 × 1e6 = 1e16 > 2^53 in the product; result Rp 10 M-billion
    expect(lineAmountCents(parseQty('1000000')!, 10_000_00)).toBe(10_000_000_000_00);
  });
});

describe('receiptStatus', () => {
  it('issued when nothing arrived, partial when some, received when every line is complete', () => {
    expect(receiptStatus([{ ordered4: 10, received4: 0 }, { ordered4: 5, received4: 0 }])).toBe('issued');
    expect(receiptStatus([{ ordered4: 10, received4: 10 }, { ordered4: 5, received4: 1 }])).toBe('partial');
    expect(receiptStatus([{ ordered4: 10, received4: 10 }, { ordered4: 5, received4: 5 }])).toBe('received');
    expect(receiptStatus([])).toBe('issued');
  });
});
