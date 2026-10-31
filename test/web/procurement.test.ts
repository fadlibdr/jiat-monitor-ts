import { describe, expect, it } from 'vitest';
import { APPROVE_ROLES as S_APPROVE } from '../../src/http/context.js';
import { emptyLine, grBody, lineTotalCents, poBody, poFormFromPr, prBody, receiptRows } from '../../web/src/lib/procurement.js';
import { APPROVE_ROLES } from '../../web/src/lib/roles.js';
import type { PurchaseOrderDetail, PurchaseRequestDetail } from '../../web/src/lib/types.js';

const RP = 100;
const line = (over: Partial<ReturnType<typeof emptyLine>>) => ({ ...emptyLine(), ...over });

describe('procurement forms', () => {
  it('approvers mirror the server', () => {
    expect([...APPROVE_ROLES].sort()).toEqual([...S_APPROVE].sort());
  });

  it('a line total is qty × price the way the API rounds it', () => {
    expect(lineTotalCents({ qty: '12,5', price: '1.250.000' })).toBe(15_625_000 * RP);
    expect(lineTotalCents({ qty: '0,3333', price: '10' })).toBe(333); // Rp 3,333 → 333 cents
    expect(lineTotalCents({ qty: 'abc', price: '10' })).toBeNull();
  });

  it('PR: lines checked, quantities in the stored form, estimated price optional', () => {
    const f = { siteId: '1', contractId: '', neededBy: '2026-11-10', note: '', lines: [line({ description: 'Semen', qty: '50', unit: 'zak', price: '65.000' }), line({ description: 'Pasir', qty: '2,5' })] };
    expect(prBody(f)).toEqual({ ok: true, body: {
      siteId: 1, neededBy: '2026-11-10',
      items: [{ description: 'Semen', qty: '50.0000', unit: 'zak', estPriceCents: 65_000 * RP }, { description: 'Pasir', qty: '2.5000' }],
    } });
    expect(prBody({ ...f, lines: [line({ description: 'X', qty: '1,23456' })] }).ok).toBe(false);
    expect(prBody({ ...f, lines: [] }).ok).toBe(false);
    expect(prBody({ ...f, siteId: '' }).ok).toBe(false);
  });

  it('PO: price required per line; the PR link and its item ids are kept', () => {
    const pr: PurchaseRequestDetail = {
      id: 4, siteId: 1, contractId: 3, number: 'PR/KRM/2026/004', neededBy: '2026-11-10', status: 'approved', note: null,
      items: [{ id: 41, boqItemId: 77, description: 'Semen', qty: '50.0000', unit: 'zak', estPriceCents: 65_000 * RP }, { id: 42, boqItemId: null, description: 'Pasir', qty: '2.5000', unit: 'm3', estPriceCents: null }],
    };
    const f = poFormFromPr(pr, '2026-10-31');
    expect(f.lines.map((l) => [l.qty, l.price, l.prItemId, l.boqItemId])).toEqual([['50', '65.000', 41, '77'], ['2,5', '', 42, '']]);
    expect(poBody({ ...f, vendorId: '9' })).toEqual({ ok: false, error: 'Baris 2: harga satuan wajib diisi.' });
    f.lines[1]!.price = '300.000';
    expect(poBody({ ...f, vendorId: '9' })).toEqual({ ok: true, body: {
      siteId: 1, vendorId: 9, orderDate: '2026-10-31', contractId: 3, prId: 4, expectedDate: '2026-11-10',
      items: [
        { boqItemId: 77, description: 'Semen', qty: '50.0000', unit: 'zak', unitPriceCents: 65_000 * RP, prItemId: 41 },
        { description: 'Pasir', qty: '2.5000', unit: 'm3', unitPriceCents: 300_000 * RP, prItemId: 42 },
      ],
    } });
    expect(poBody({ ...f, vendorId: '' }).ok).toBe(false);
    expect(poBody({ ...f, vendorId: '9', expectedDate: '2026-10-01' }).ok).toBe(false);
  });
});

describe('goods receipts', () => {
  const po: PurchaseOrderDetail = {
    id: 8, siteId: 1, vendorId: 9, prId: null, contractId: null, number: 'PO/KRM/2026/008', orderDate: '2026-10-20', expectedDate: null,
    ppnRateBp: 1100, dppCents: 0, ppnCents: 0, totalCents: 0, status: 'partial', note: null,
    items: [
      { id: 81, prItemId: null, boqItemId: null, description: 'Semen', qty: '50.0000', unit: 'zak', unitPriceCents: 6_500_000, amountCents: 0, qtyReceived: '20.0000' },
      { id: 82, prItemId: null, boqItemId: null, description: 'Pasir', qty: '2.5000', unit: 'm3', unitPriceCents: 30_000_000, amountCents: 0, qtyReceived: '2.5000' },
      { id: 83, prItemId: null, boqItemId: null, description: 'Besi', qty: '100.0000', unit: 'btg', unitPriceCents: 1, amountCents: 0, qtyReceived: '0.0000' },
    ],
  };

  it('the form starts from what is still to come', () => {
    expect(receiptRows(po).map((r) => r.remaining)).toEqual(['30', '0', '100']);
  });

  it('only lines with a quantity are sent; more than the remainder is refused (exactly the remainder is fine)', () => {
    expect(grBody(po, { 81: '30', 82: '', 83: '0' }, '2026-10-31', '')).toEqual({ ok: true, body: { receivedAt: '2026-10-31', items: [{ poItemId: 81, qtyReceived: '30.0000' }] } });
    expect(grBody(po, { 81: '30,0001' }, '2026-10-31', '').ok).toBe(false);
    expect(grBody(po, { 82: '0,5' }, '2026-10-31', '')).toEqual({ ok: false, error: '"Pasir": melebihi sisa pesanan (0).' });
    expect(grBody(po, {}, '2026-10-31', '').ok).toBe(false);
    expect(grBody(po, { 83: '10' }, '', '').ok).toBe(false);
  });
});
