import { eq } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  auditLogs, documentSequences, goodsReceiptItems, goodsReceipts, purchaseOrderItems, purchaseOrders, purchaseRequestItems, purchaseRequests,
} from '../../src/db/schema.js';
import { withCompany } from '../../src/db/tenant.js';
import { asOwner } from '../helpers/db.js';
import { client, makePo, rows, seedWorld, seqOf, type Gr, type Po, type Pr, type World } from './fixture.js';

/**
 * PR → PO → GR over HTTP (HLD §2, §4): who may write and approve, the status machines, server-side
 * amounts, BOQ-leaf and vendor checks, over-receipt refusal, and that every refusal writes nothing
 * (no document, no line, no consumed document number). Tenancy: another company → 403 at the
 * membership gate or 404 by RLS; another site for a scoped member → 404.
 */
let w: World;
let api: ReturnType<typeof client>;

beforeAll(async () => {
  w = await seedWorld();
  api = client(w);
});
afterAll(async () => { await w.close(); });

/** counts of every procurement table + the doc sequences, to prove a refusal wrote nothing */
async function snapshot() {
  return {
    pr: await rows(w, purchaseRequests), pri: await rows(w, purchaseRequestItems),
    po: await rows(w, purchaseOrders), poi: await rows(w, purchaseOrderItems),
    gr: await rows(w, goodsReceipts), gri: await rows(w, goodsReceiptItems),
    seq: (await asOwner(w.db, () => w.db.select().from(documentSequences))).map((s) => `${s.companyId}/${s.docType}/${s.year}=${s.lastNumber}`).sort(),
  };
}

const prBody = (over: Record<string, unknown> = {}) => ({
  siteId: w.s1, contractId: w.K1, items: [{ boqItemId: w.leaf.I1, description: 'Semen 50 kg', qty: 100, unit: 'sak', estPriceCents: 75_000_00 }], ...over,
});

async function approvedPr(over: Record<string, unknown> = {}): Promise<Pr> {
  const pr = await api.ok<Pr>(api.call(w.u.adm, 'POST', '/purchase-requests', prBody(over)), 201);
  await api.ok(api.call(w.u.adm, 'POST', `/purchase-requests/${pr.id}/submit`));
  await api.ok(api.call(w.u.mgr, 'POST', `/purchase-requests/${pr.id}/approve`));
  return api.ok<Pr>(api.call(w.u.adm, 'GET', `/purchase-requests/${pr.id}`));
}

// ------------------------------------------------------------------------------------------------
describe('purchase requests: create', () => {
  it('project_admin creates a draft PR with a numbered document, qty stored as qty4 text', async () => {
    const pr = await api.ok<Pr>(api.call(w.u.adm, 'POST', '/purchase-requests', prBody({ neededBy: '2026-11-15', note: 'urgent' })), 201);
    expect(pr).toMatchObject({ status: 'draft', siteId: w.s1, contractId: w.K1, requestedBy: w.u.adm, decidedBy: null });
    expect(pr.number).toMatch(/^PR\/KRM\/2026\/\d{3}$/);
    expect(pr.items).toHaveLength(1);
    expect(pr.items[0]).toMatchObject({ boqItemId: w.leaf.I1, qty: '100.0000', estPriceCents: 75_000_00, description: 'Semen 50 kg' });
    const again = await api.ok<Pr>(api.call(w.u.staff, 'GET', `/purchase-requests/${pr.id}`));
    expect(again.items.map((i) => i.id)).toEqual(pr.items.map((i) => i.id));
  });

  it('a PR without contract has free-text lines only', async () => {
    const pr = await api.ok<Pr>(api.call(w.u.adm, 'POST', '/purchase-requests', { siteId: w.s1, items: [{ description: 'ATK', qty: '1,5' }] }), 201);
    expect(pr.contractId).toBeNull();
    expect(pr.items[0]).toMatchObject({ boqItemId: null, qty: '1.5000', estPriceCents: null });
  });

  it('company_manager and system_admin may also create; site_staff and finance may not (403, nothing written)', async () => {
    await api.ok(api.call(w.u.mgr, 'POST', '/purchase-requests', prBody()), 201);
    await api.ok(api.call(w.u.sys, 'POST', '/purchase-requests', prBody()), 201);
    const before = await snapshot();
    await api.fails(api.call(w.u.staff, 'POST', '/purchase-requests', prBody()), 403);
    await api.fails(api.call(w.u.fin, 'POST', '/purchase-requests', prBody()), 403);
    await api.fails(api.call(w.u.boss, 'POST', '/purchase-requests', prBody()), 403);
    expect(await snapshot()).toEqual(before);
  });

  it('qty boundaries: 0.0001 is the smallest accepted, 0 / negative / 5 decimals / garbage are 400', async () => {
    const pr = await api.ok<Pr>(api.call(w.u.adm, 'POST', '/purchase-requests', prBody({ items: [{ description: 'baut', qty: '0.0001' }], contractId: undefined })), 201);
    expect(pr.items[0]!.qty).toBe('0.0001');
    const before = await snapshot();
    for (const qty of [0, '0', '0.0000', -1, '-1', '1.23456', 'satu', '', '1e3']) {
      await api.fails(api.call(w.u.adm, 'POST', '/purchase-requests', prBody({ items: [{ description: 'baut', qty }], contractId: undefined })), 400);
    }
    expect(await snapshot()).toEqual(before);
  });

  it('lines: at least 1, at most 200', async () => {
    const before = await snapshot();
    await api.fails(api.call(w.u.adm, 'POST', '/purchase-requests', prBody({ items: [] })), 400);
    const many = (n: number) => Array.from({ length: n }, (_, k) => ({ description: `item ${k}`, qty: 1 }));
    await api.fails(api.call(w.u.adm, 'POST', '/purchase-requests', { siteId: w.s1, items: many(201) }), 400);
    expect(await snapshot()).toEqual(before);
    const pr = await api.ok<Pr>(api.call(w.u.adm, 'POST', '/purchase-requests', { siteId: w.s1, items: many(200) }), 201);
    expect(pr.items).toHaveLength(200);
  });

  it('BOQ lines must be leaves of the current BOQ of the given contract (400), contract must be of the site', async () => {
    const before = await snapshot();
    // boqItemId without a contract
    await api.fails(api.call(w.u.adm, 'POST', '/purchase-requests', prBody({ contractId: undefined })), 400);
    // a section (not a leaf)
    await api.fails(api.call(w.u.adm, 'POST', '/purchase-requests', prBody({ items: [{ boqItemId: w.leaf.section, description: 'x', qty: 1 }] })), 400);
    // a leaf of another contract at the same site
    await api.fails(api.call(w.u.adm, 'POST', '/purchase-requests', prBody({ items: [{ boqItemId: w.leaf.K1b, description: 'x', qty: 1 }] })), 400);
    // a leaf of company B: invisible → same 400
    await api.fails(api.call(w.u.adm, 'POST', '/purchase-requests', prBody({ items: [{ boqItemId: w.leaf.KB, description: 'x', qty: 1 }] })), 400);
    // contract of another site
    await api.fails(api.call(w.u.adm, 'POST', '/purchase-requests', prBody({ contractId: w.K2 })), 400);
    // site / contract of company B
    await api.fails(api.call(w.u.adm, 'POST', '/purchase-requests', prBody({ siteId: w.sB, contractId: undefined, items: [{ description: 'x', qty: 1 }] })), 404);
    await api.fails(api.call(w.u.adm, 'POST', '/purchase-requests', prBody({ contractId: w.KB })), 404);
    // site that does not exist
    await api.fails(api.call(w.u.adm, 'POST', '/purchase-requests', prBody({ siteId: 999_999, contractId: undefined, items: [{ description: 'x', qty: 1 }] })), 404);
    expect(await snapshot()).toEqual(before);
  });

  it('a project_admin limited to s1 cannot create a PR at s2 (site invisible → 404)', async () => {
    const before = await snapshot();
    await api.fails(api.call(w.u.admS1, 'POST', '/purchase-requests', { siteId: w.s2, items: [{ description: 'x', qty: 1 }] }), 404);
    expect(await snapshot()).toEqual(before);
    await api.ok(api.call(w.u.admS1, 'POST', '/purchase-requests', { siteId: w.s1, items: [{ description: 'x', qty: 1 }] }), 201);
  });

  it('malformed JSON and unknown types are 400', async () => {
    const res = await w.app.request(`/companies/${w.A}/purchase-requests`, { method: 'POST', headers: { 'x-dev-user-id': String(w.u.adm), 'content-type': 'application/json' }, body: '{' });
    expect(res.status).toBe(400);
    await api.fails(api.call(w.u.adm, 'POST', '/purchase-requests', prBody({ neededBy: '2026-02-30' })), 400);
    await api.fails(api.call(w.u.adm, 'POST', '/purchase-requests', prBody({ items: [{ description: 'x', qty: 1, estPriceCents: -1 }] })), 400);
    await api.fails(api.call(w.u.adm, 'POST', '/purchase-requests', prBody({ items: [{ description: 'x', qty: 1, estPriceCents: 1.5 }] })), 400);
  });
});

// ------------------------------------------------------------------------------------------------
describe('purchase requests: submit / approve / reject', () => {
  it('draft → submitted → rejected → submitted → approved; the decision records who and when', async () => {
    const pr = await api.ok<Pr>(api.call(w.u.adm, 'POST', '/purchase-requests', prBody()), 201);
    // a draft cannot be decided
    await api.fails(api.call(w.u.mgr, 'POST', `/purchase-requests/${pr.id}/approve`), 409);
    await api.fails(api.call(w.u.mgr, 'POST', `/purchase-requests/${pr.id}/reject`), 409);

    const sub = await api.ok<Pr>(api.call(w.u.adm, 'POST', `/purchase-requests/${pr.id}/submit`));
    expect(sub.status).toBe('submitted');
    await api.fails(api.call(w.u.adm, 'POST', `/purchase-requests/${pr.id}/submit`), 409); // not twice

    const rej = await api.ok<Pr>(api.call(w.u.mgr, 'POST', `/purchase-requests/${pr.id}/reject`));
    expect(rej).toMatchObject({ status: 'rejected', decidedBy: w.u.mgr });
    expect(rej.decidedAt).not.toBeNull();
    await api.fails(api.call(w.u.mgr, 'POST', `/purchase-requests/${pr.id}/approve`), 409);
    await api.fails(api.call(w.u.mgr, 'POST', `/purchase-requests/${pr.id}/reject`), 409);

    await api.ok(api.call(w.u.adm, 'POST', `/purchase-requests/${pr.id}/submit`)); // resubmit after rejection
    const appr = await api.ok<Pr>(api.call(w.u.sys, 'POST', `/purchase-requests/${pr.id}/approve`));
    expect(appr).toMatchObject({ status: 'approved', decidedBy: w.u.sys });

    for (const action of ['submit', 'approve', 'reject']) {
      const body = await api.fails(api.call(w.u.mgr, 'POST', `/purchase-requests/${pr.id}/${action}`), 409);
      expect(body.message ?? JSON.stringify(body)).toBeTruthy();
    }
    expect((await api.ok<Pr>(api.call(w.u.adm, 'GET', `/purchase-requests/${pr.id}`))).status).toBe('approved');
  });

  it('approve/reject are for company_manager and system_admin only (HLD §2); the PR is unchanged on 403', async () => {
    const pr = await api.ok<Pr>(api.call(w.u.adm, 'POST', '/purchase-requests', prBody()), 201);
    await api.ok(api.call(w.u.adm, 'POST', `/purchase-requests/${pr.id}/submit`));
    for (const u of [w.u.adm, w.u.fin, w.u.staff, w.u.admS1]) {
      await api.fails(api.call(u, 'POST', `/purchase-requests/${pr.id}/approve`), 403);
      await api.fails(api.call(u, 'POST', `/purchase-requests/${pr.id}/reject`), 403);
    }
    await api.fails(api.call(w.u.staff, 'POST', `/purchase-requests/${pr.id}/submit`), 403);
    await api.fails(api.call(w.u.fin, 'POST', `/purchase-requests/${pr.id}/submit`), 403);
    expect((await api.ok<Pr>(api.call(w.u.mgr, 'GET', `/purchase-requests/${pr.id}`))).status).toBe('submitted');
  });

  it('unknown id → 404; malformed id → 400; another company\'s PR → 404 through A, 403 for the outsider', async () => {
    await api.fails(api.call(w.u.mgr, 'POST', '/purchase-requests/999999/approve'), 404);
    await api.fails(api.call(w.u.mgr, 'GET', '/purchase-requests/999999'), 404);
    await api.fails(api.call(w.u.mgr, 'GET', '/purchase-requests/abc'), 400);
    const prB = await api.ok<Pr>(api.call(w.u.bobB, 'POST', '/purchase-requests', { siteId: w.sB, items: [{ description: 'B', qty: 1 }] }, w.B), 201);
    await api.ok(api.call(w.u.bobB, 'POST', `/purchase-requests/${prB.id}/submit`, undefined, w.B));
    await api.fails(api.call(w.u.mgr, 'GET', `/purchase-requests/${prB.id}`), 404);
    await api.fails(api.call(w.u.mgr, 'POST', `/purchase-requests/${prB.id}/approve`), 404);
    await api.fails(api.call(w.u.mgr, 'POST', `/purchase-requests/${prB.id}/approve`, undefined, w.B), 403);
    expect((await api.ok<Pr>(api.call(w.u.bobB, 'GET', `/purchase-requests/${prB.id}`, undefined, w.B))).status).toBe('submitted');
    // B's own numbering starts at 001
    expect(prB.number).toBe('PR/BBB/2026/001');
  });

  it('site scope: site_staff sees PRs of their site only; staff without sites sees none', async () => {
    const atS2 = await api.ok<Pr>(api.call(w.u.adm, 'POST', '/purchase-requests', { siteId: w.s2, items: [{ description: 'pipa', qty: 2 }] }), 201);
    const list = await api.ok<Pr[]>(api.call(w.u.staff, 'GET', '/purchase-requests'));
    expect(list.length).toBeGreaterThan(0);
    expect(list.every((p) => p.siteId === w.s1)).toBe(true);
    await api.fails(api.call(w.u.staff, 'GET', `/purchase-requests/${atS2.id}`), 404);
    await api.fails(api.call(w.u.admS1, 'POST', `/purchase-requests/${atS2.id}/submit`), 404);
    expect(await api.ok<Pr[]>(api.call(w.u.staffNone, 'GET', '/purchase-requests'))).toEqual([]);
    const all = await api.ok<Pr[]>(api.call(w.u.fin, 'GET', '/purchase-requests'));
    expect(all.some((p) => p.id === atS2.id)).toBe(true);
    // filters
    const drafts = await api.ok<Pr[]>(api.call(w.u.mgr, 'GET', `/purchase-requests?status=draft&siteId=${w.s2}`));
    expect(drafts.map((p) => p.id)).toContain(atS2.id);
    expect(drafts.every((p) => p.status === 'draft' && p.siteId === w.s2)).toBe(true);
    await api.fails(api.call(w.u.mgr, 'GET', '/purchase-requests?status=bogus'), 400);
  });
});

// ------------------------------------------------------------------------------------------------
describe('purchase orders: create', () => {
  it('from an approved PR: amounts are computed by the server (qty × price, half away from zero), PPN 11 % default, PR closed', async () => {
    const pr = await approvedPr();
    const po = await api.ok<Po>(api.call(w.u.adm, 'POST', '/purchase-orders', {
      siteId: w.s1, vendorId: w.v1, prId: pr.id, orderDate: '2026-10-01',
      // client-sent money/status fields are ignored
      dppCents: 1, ppnCents: 1, totalCents: 1, status: 'issued',
      items: [
        { prItemId: pr.items[0]!.id, boqItemId: w.leaf.I1, description: 'Semen', qty: '2.5', unitPriceCents: 333, amountCents: 1 }, // 832.5 → 833
        { boqItemId: w.leaf.I2, description: 'Kawat', qty: '0.0001', unitPriceCents: 5_000 }, // 0.5 → 1
        { description: 'Ongkos', qty: 3, unitPriceCents: 0 }, // free line → 0
        { description: 'Paku', qty: '0.0001', unitPriceCents: 4_999 }, // 0.4999 → 0
      ],
    }), 201);
    expect(po.items.map((i) => i.amountCents)).toEqual([833, 1, 0, 0]);
    expect(po).toMatchObject({ status: 'draft', prId: pr.id, contractId: w.K1, ppnRateBp: 1100, dppCents: 834, ppnCents: 92, totalCents: 926, approvedBy: null });
    expect(po.number).toMatch(/^PO\/KRM\/2026\/\d{3}$/);
    expect((await api.ok<Pr>(api.call(w.u.adm, 'GET', `/purchase-requests/${pr.id}`))).status).toBe('closed');
    // a closed PR accepts no other transition and no second PO
    await api.fails(api.call(w.u.adm, 'POST', `/purchase-requests/${pr.id}/submit`), 409);
    await api.fails(api.call(w.u.mgr, 'POST', `/purchase-requests/${pr.id}/approve`), 409);
    const before = await snapshot();
    await api.fails(api.call(w.u.adm, 'POST', '/purchase-orders', { siteId: w.s1, vendorId: w.v1, prId: pr.id, orderDate: '2026-10-02', items: [{ description: 'x', qty: 1, unitPriceCents: 1 }] }), 409);
    expect(await snapshot()).toEqual(before);
  });

  it('PPN boundaries: 0 bp → no PPN, 10 000 bp → PPN = DPP, rounding half up (5.5 → 6); > 10 000 or negative → 400', async () => {
    const base = { siteId: w.s1, vendorId: w.v1 };
    const zero = await makePo(w, { ...base, ppnRateBp: 0, items: [{ description: 'x', qty: 1, unitPriceCents: 1_000 }] });
    expect([zero.dppCents, zero.ppnCents, zero.totalCents]).toEqual([1_000, 0, 1_000]);
    const full = await makePo(w, { ...base, ppnRateBp: 10_000, items: [{ description: 'x', qty: 1, unitPriceCents: 1_000 }] });
    expect([full.dppCents, full.ppnCents, full.totalCents]).toEqual([1_000, 1_000, 2_000]);
    const half = await makePo(w, { ...base, items: [{ description: 'x', qty: 1, unitPriceCents: 50 }] }); // 50 × 11 % = 5.5
    expect([half.dppCents, half.ppnCents, half.totalCents]).toEqual([50, 6, 56]);
    const down = await makePo(w, { ...base, items: [{ description: 'x', qty: 1, unitPriceCents: 45 }] }); // 4.95 → 5
    expect(down.ppnCents).toBe(5);
    const before = await snapshot();
    await api.fails(api.call(w.u.adm, 'POST', '/purchase-orders', { ...base, orderDate: '2026-10-01', ppnRateBp: 10_001, items: [{ description: 'x', qty: 1, unitPriceCents: 1 }] }), 400);
    await api.fails(api.call(w.u.adm, 'POST', '/purchase-orders', { ...base, orderDate: '2026-10-01', ppnRateBp: -1, items: [{ description: 'x', qty: 1, unitPriceCents: 1 }] }), 400);
    await api.fails(api.call(w.u.adm, 'POST', '/purchase-orders', { ...base, orderDate: '2026-10-01', items: [{ description: 'x', qty: 1, unitPriceCents: -1 }] }), 400);
    await api.fails(api.call(w.u.adm, 'POST', '/purchase-orders', { ...base, orderDate: '2026-10-01', items: [{ description: 'x', qty: 1, unitPriceCents: 1.5 }] }), 400);
    await api.fails(api.call(w.u.adm, 'POST', '/purchase-orders', { ...base, orderDate: '2026-13-01', items: [{ description: 'x', qty: 1, unitPriceCents: 1 }] }), 400);
    await api.fails(api.call(w.u.adm, 'POST', '/purchase-orders', { ...base, items: [{ description: 'x', qty: 1, unitPriceCents: 1 }] }), 400); // no orderDate
    expect(await snapshot()).toEqual(before);
  });

  it('large but realistic money stays exact (BigInt product): 12 345.6789 m³ × Rp 98 765 432,10', async () => {
    const po = await makePo(w, { siteId: w.s1, vendorId: w.v1, items: [{ description: 'Beton', qty: '12345.6789', unitPriceCents: 9_876_543_210 }] });
    // 12345.6789 × 9 876 543 210 = 121 932 631 112 635.269 → 121 932 631 112 635 cents
    expect(po.items[0]!.amountCents).toBe(121_932_631_112_635);
    expect(po.dppCents).toBe(121_932_631_112_635);
    expect(po.ppnCents).toBe(13_412_589_422_390); // × 0.11 = 13 412 589 422 389.85 → …390
    expect(po.totalCents).toBe(121_932_631_112_635 + 13_412_589_422_390);
  });

  // Regression (was a defect): parseQty() accepts up to 14 integer digits (the numeric(18,4) column), but qty4 = qty × 10 000 is a
  // JS number and is no longer a safe integer from ~900 719 925 475 units up; lineAmountCents → mulDiv then
  // throws a RangeError and the API answers 500 instead of a 400 validation error.
  it('an absurd qty at the column maximum is refused with 400, not a 500', async () => {
    const before = await snapshot();
    await api.fails(api.call(w.u.adm, 'POST', '/purchase-orders', {
      siteId: w.s1, vendorId: w.v1, orderDate: '2026-10-01', items: [{ description: 'x', qty: '99999999999999', unitPriceCents: 1 }],
    }), 400);
    expect(await snapshot()).toEqual(before);
  });

  it('vendor must be of the company (B\'s vendor or unknown → 404, nothing written)', async () => {
    const before = await snapshot();
    const body = (vendorId: number) => ({ siteId: w.s1, vendorId, orderDate: '2026-10-01', items: [{ description: 'x', qty: 1, unitPriceCents: 100 }] });
    await api.fails(api.call(w.u.adm, 'POST', '/purchase-orders', body(w.vB)), 404);
    await api.fails(api.call(w.u.adm, 'POST', '/purchase-orders', body(999_999)), 404);
    await api.fails(api.call(w.u.adm, 'POST', '/purchase-orders', { ...body(w.v1), siteId: w.sB }), 404);
    expect(await snapshot()).toEqual(before);
  });

  it('PO lines must be current BOQ leaves of the (given or inherited) contract', async () => {
    const before = await snapshot();
    const body = (over: Record<string, unknown>) => ({ siteId: w.s1, vendorId: w.v1, orderDate: '2026-10-01', ...over });
    await api.fails(api.call(w.u.adm, 'POST', '/purchase-orders', body({ items: [{ boqItemId: w.leaf.I1, description: 'x', qty: 1, unitPriceCents: 1 }] })), 400); // no contract
    await api.fails(api.call(w.u.adm, 'POST', '/purchase-orders', body({ contractId: w.K1, items: [{ boqItemId: w.leaf.section, description: 'x', qty: 1, unitPriceCents: 1 }] })), 400);
    await api.fails(api.call(w.u.adm, 'POST', '/purchase-orders', body({ contractId: w.K1, items: [{ boqItemId: w.leaf.K1b, description: 'x', qty: 1, unitPriceCents: 1 }] })), 400);
    await api.fails(api.call(w.u.adm, 'POST', '/purchase-orders', body({ contractId: w.K1, items: [{ boqItemId: w.leaf.KB, description: 'x', qty: 1, unitPriceCents: 1 }] })), 400);
    await api.fails(api.call(w.u.adm, 'POST', '/purchase-orders', body({ contractId: w.K2, items: [{ description: 'x', qty: 1, unitPriceCents: 1 }] })), 400); // contract of s2
    await api.fails(api.call(w.u.adm, 'POST', '/purchase-orders', body({ contractId: w.KB, items: [{ description: 'x', qty: 1, unitPriceCents: 1 }] })), 404);
    expect(await snapshot()).toEqual(before);
    const ok = await makePo(w, body({ contractId: w.K1, items: [{ boqItemId: w.leaf.III1, description: 'x', qty: 1, unitPriceCents: 1 }] }));
    expect(ok.items[0]!.boqItemId).toBe(w.leaf.III1);
  });

  it('PR rules: only approved, same site, prItemId of that PR; a refused PO leaves the PR approved (rolled back)', async () => {
    const draft = await api.ok<Pr>(api.call(w.u.adm, 'POST', '/purchase-requests', prBody()), 201);
    const submitted = await api.ok<Pr>(api.call(w.u.adm, 'POST', '/purchase-requests', prBody()), 201);
    await api.ok(api.call(w.u.adm, 'POST', `/purchase-requests/${submitted.id}/submit`));
    const rejected = await api.ok<Pr>(api.call(w.u.adm, 'POST', '/purchase-requests', prBody()), 201);
    await api.ok(api.call(w.u.adm, 'POST', `/purchase-requests/${rejected.id}/submit`));
    await api.ok(api.call(w.u.mgr, 'POST', `/purchase-requests/${rejected.id}/reject`));
    const approved = await approvedPr();
    const other = await approvedPr();
    const atS2 = await approvedPr({ siteId: w.s2, contractId: undefined, items: [{ description: 'pipa', qty: 1 }] });

    const before = await snapshot();
    const po = (over: Record<string, unknown>) => api.call(w.u.adm, 'POST', '/purchase-orders', {
      siteId: w.s1, vendorId: w.v1, orderDate: '2026-10-01', items: [{ description: 'x', qty: 1, unitPriceCents: 1 }], ...over,
    });
    for (const p of [draft, submitted, rejected]) await api.fails(po({ prId: p.id }), 409);
    await api.fails(po({ prId: atS2.id }), 400);
    await api.fails(po({ prId: 999_999 }), 404);
    await api.fails(po({ prId: approved.id, items: [{ prItemId: other.items[0]!.id, description: 'x', qty: 1, unitPriceCents: 1 }] }), 400);
    await api.fails(po({ items: [{ prItemId: approved.items[0]!.id, description: 'x', qty: 1, unitPriceCents: 1 }] }), 400); // prItemId without prId
    // fails after the PR was closed inside the transaction: a stale BOQ leaf on the line
    await api.fails(po({ prId: approved.id, items: [{ boqItemId: w.leaf.section, description: 'x', qty: 1, unitPriceCents: 1 }] }), 400);
    await api.fails(po({ prId: approved.id, items: [{ description: 'x', qty: 0, unitPriceCents: 1 }] }), 400);
    expect(await snapshot()).toEqual(before);
    expect((await api.ok<Pr>(api.call(w.u.adm, 'GET', `/purchase-requests/${approved.id}`))).status).toBe('approved');
    // the same prItemId twice is fine (Set size)
    const okPo = await api.ok<Po>(po({ prId: approved.id, items: [
      { prItemId: approved.items[0]!.id, boqItemId: w.leaf.I1, description: 'a', qty: 1, unitPriceCents: 1 },
      { prItemId: approved.items[0]!.id, boqItemId: w.leaf.I1, description: 'b', qty: 1, unitPriceCents: 1 },
    ] }), 201);
    expect(okPo.contractId).toBe(w.K1); // inherited from the PR
  });

  it('roles: site_staff and finance cannot create POs (403)', async () => {
    const before = await snapshot();
    const body = { siteId: w.s1, vendorId: w.v1, orderDate: '2026-10-01', items: [{ description: 'x', qty: 1, unitPriceCents: 1 }] };
    await api.fails(api.call(w.u.staff, 'POST', '/purchase-orders', body), 403);
    await api.fails(api.call(w.u.fin, 'POST', '/purchase-orders', body), 403);
    await api.fails(api.call(w.u.bobB, 'POST', '/purchase-orders', body), 403); // not a member of A
    await api.fails(api.call(w.u.admS1, 'POST', '/purchase-orders', { ...body, siteId: w.s2 }), 404); // site outside scope
    expect(await snapshot()).toEqual(before);
  });
});

// ------------------------------------------------------------------------------------------------
describe('purchase orders: approve / cancel', () => {
  const body = () => ({ siteId: w.s1, vendorId: w.v1, items: [{ description: 'x', qty: 10, unitPriceCents: 1_000 }] });

  it('draft → issued by a manager; approving twice is 409; amounts do not change on approval', async () => {
    const po = await makePo(w, body());
    await api.fails(api.call(w.u.adm, 'POST', `/purchase-orders/${po.id}/approve`), 403);
    await api.fails(api.call(w.u.fin, 'POST', `/purchase-orders/${po.id}/approve`), 403);
    await api.fails(api.call(w.u.staff, 'POST', `/purchase-orders/${po.id}/approve`), 403);
    const issued = await api.ok<Po>(api.call(w.u.mgr, 'POST', `/purchase-orders/${po.id}/approve`));
    expect(issued).toMatchObject({ status: 'issued', approvedBy: w.u.mgr, dppCents: po.dppCents, ppnCents: po.ppnCents, totalCents: po.totalCents, number: po.number });
    expect(issued.approvedAt).not.toBeNull();
    await api.fails(api.call(w.u.mgr, 'POST', `/purchase-orders/${po.id}/approve`), 409);
    await api.fails(api.call(w.u.mgr, 'POST', '/purchase-orders/999999/approve'), 404);
  });

  it('cancel: draft and issued (no receipts) → cancelled; partial/received/cancelled → 409; only managers', async () => {
    const d = await makePo(w, body());
    await api.fails(api.call(w.u.adm, 'POST', `/purchase-orders/${d.id}/cancel`), 403);
    expect((await api.ok<Po>(api.call(w.u.mgr, 'POST', `/purchase-orders/${d.id}/cancel`))).status).toBe('cancelled');
    await api.fails(api.call(w.u.mgr, 'POST', `/purchase-orders/${d.id}/cancel`), 409);
    await api.fails(api.call(w.u.mgr, 'POST', `/purchase-orders/${d.id}/approve`), 409);

    const i = await makePo(w, body(), { approve: true });
    expect((await api.ok<Po>(api.call(w.u.sys, 'POST', `/purchase-orders/${i.id}/cancel`))).status).toBe('cancelled');

    const p = await makePo(w, body(), { approve: true });
    await api.ok(api.call(w.u.adm, 'POST', `/purchase-orders/${p.id}/receipts`, { receivedAt: '2026-10-05', items: [{ poItemId: p.items[0]!.id, qtyReceived: 1 }] }), 201);
    await api.fails(api.call(w.u.mgr, 'POST', `/purchase-orders/${p.id}/cancel`), 409);
    const r = await makePo(w, body(), { approve: true });
    await api.ok(api.call(w.u.adm, 'POST', `/purchase-orders/${r.id}/receipts`, { receivedAt: '2026-10-05', items: [{ poItemId: r.items[0]!.id, qtyReceived: 10 }] }), 201);
    await api.fails(api.call(w.u.mgr, 'POST', `/purchase-orders/${r.id}/cancel`), 409);
    expect((await api.ok<Po>(api.call(w.u.mgr, 'GET', `/purchase-orders/${p.id}`))).status).toBe('partial');
    expect((await api.ok<Po>(api.call(w.u.mgr, 'GET', `/purchase-orders/${r.id}`))).status).toBe('received');
    await api.fails(api.call(w.u.mgr, 'POST', '/purchase-orders/999999/cancel'), 404);
  });

  it('a cancelled PO cannot be received or approved', async () => {
    const po = await makePo(w, body(), { approve: true });
    await api.ok(api.call(w.u.mgr, 'POST', `/purchase-orders/${po.id}/cancel`));
    const before = await snapshot();
    await api.fails(api.call(w.u.adm, 'POST', `/purchase-orders/${po.id}/receipts`, { receivedAt: '2026-10-05', items: [{ poItemId: po.items[0]!.id, qtyReceived: 1 }] }), 409);
    await api.fails(api.call(w.u.mgr, 'POST', `/purchase-orders/${po.id}/approve`), 409);
    expect(await snapshot()).toEqual(before);
  });

  it('PO approval and cancellation are audited', async () => {
    const po = await makePo(w, body(), { approve: true });
    const logs = await asOwner(w.db, () => w.db.select().from(auditLogs).where(eq(auditLogs.auditableId, po.id)));
    const ofPo = logs.filter((l) => l.auditableType === 'purchase_orders');
    expect(ofPo.length).toBeGreaterThanOrEqual(2); // insert + update to issued
    expect(ofPo.some((l) => l.userId === w.u.mgr)).toBe(true);
  });
});

// ------------------------------------------------------------------------------------------------
describe('goods receipts', () => {
  let po: Po; let l1 = 0; let l2 = 0;
  beforeAll(async () => {
    po = await makePo(w, {
      siteId: w.s1, vendorId: w.v1, contractId: w.K1, items: [
        { boqItemId: w.leaf.I1, description: 'Semen', qty: 100, unitPriceCents: 75_000_00 },
        { boqItemId: w.leaf.I2, description: 'Besi', qty: '10.5', unitPriceCents: 10_000_00 },
      ],
    }, { approve: true });
    [l1, l2] = po.items.map((i) => i.id) as [number, number];
  });
  const gr = (items: Array<{ poItemId: number; qtyReceived: number | string }>, receivedAt = '2026-10-10', who = w.u.adm, poId = po.id) =>
    api.call(who, 'POST', `/purchase-orders/${poId}/receipts`, { receivedAt, items });

  it('a draft PO cannot be received (409)', async () => {
    const d = await makePo(w, { siteId: w.s1, vendorId: w.v1, items: [{ description: 'x', qty: 1, unitPriceCents: 1 }] });
    await api.fails(gr([{ poItemId: d.items[0]!.id, qtyReceived: 1 }], '2026-10-10', w.u.adm, d.id), 409);
  });

  it('roles: site_staff and finance cannot record receipts; another site is invisible to a scoped admin', async () => {
    const before = await snapshot();
    await api.fails(gr([{ poItemId: l1, qtyReceived: 1 }], '2026-10-10', w.u.staff), 403);
    await api.fails(gr([{ poItemId: l1, qtyReceived: 1 }], '2026-10-10', w.u.fin), 403);
    const atS2 = await makePo(w, { siteId: w.s2, vendorId: w.v1, items: [{ description: 'pipa', qty: 5, unitPriceCents: 100 }] }, { approve: true });
    const mid = await snapshot();
    await api.fails(gr([{ poItemId: atS2.items[0]!.id, qtyReceived: 1 }], '2026-10-10', w.u.admS1, atS2.id), 404);
    expect(await snapshot()).toEqual(mid);
    expect(mid.gr).toBe(before.gr);
  });

  it('partial receipt: issued → partial, numbered GR, received qty per line', async () => {
    const r = await api.ok<Gr>(gr([{ poItemId: l1, qtyReceived: 40 }]), 201);
    expect(r).toMatchObject({ poId: po.id, siteId: w.s1, poStatus: 'partial' });
    expect(r.number).toMatch(/^GR\/KRM\/2026\/\d{3}$/);
    expect(r.items).toMatchObject([{ poItemId: l1, qtyReceived: '40.0000' }]);
    const full = await api.ok<Po>(api.call(w.u.staff, 'GET', `/purchase-orders/${po.id}`));
    expect(full.status).toBe('partial');
    expect(full.items.map((i) => i.qtyReceived)).toEqual(['40.0000', '0.0000']);
  });

  it('over-receipt is refused (409) and writes nothing; duplicate lines in one receipt are summed', async () => {
    const before = await snapshot();
    await api.fails(gr([{ poItemId: l1, qtyReceived: '60.0001' }]), 409);
    await api.fails(gr([{ poItemId: l2, qtyReceived: 6 }, { poItemId: l2, qtyReceived: '4.5001' }]), 409);
    await api.fails(gr([{ poItemId: l1, qtyReceived: 1 }, { poItemId: l2, qtyReceived: 11 }]), 409); // one bad line refuses the whole receipt
    expect(await snapshot()).toEqual(before);
  });

  it('bad lines: line of another PO → 400, qty 0 / 5 decimals → 400, empty → 400', async () => {
    const other = await makePo(w, { siteId: w.s1, vendorId: w.v1, items: [{ description: 'x', qty: 1, unitPriceCents: 1 }] }, { approve: true });
    const before = await snapshot();
    await api.fails(gr([{ poItemId: other.items[0]!.id, qtyReceived: 1 }]), 400);
    await api.fails(gr([{ poItemId: 999_999, qtyReceived: 1 }]), 400);
    await api.fails(gr([{ poItemId: l1, qtyReceived: 0 }]), 400);
    await api.fails(gr([{ poItemId: l1, qtyReceived: '0' }]), 400);
    await api.fails(gr([{ poItemId: l1, qtyReceived: '0.00001' }]), 400);
    await api.fails(gr([]), 400);
    await api.fails(api.call(w.u.adm, 'POST', `/purchase-orders/${po.id}/receipts`, { items: [{ poItemId: l1, qtyReceived: 1 }] }), 400); // no date
    await api.fails(gr([{ poItemId: l1, qtyReceived: 1 }], '2026-10-10', w.u.adm, 999_999), 404);
    expect(await snapshot()).toEqual(before);
  });

  it('exactly the ordered quantity completes the PO: partial → received; then no more receipts', async () => {
    // the rest of line 1 exactly, line 2 as two halves in one receipt (stored as one summed line)
    const r = await api.ok<Gr>(gr([{ poItemId: l1, qtyReceived: '60' }, { poItemId: l2, qtyReceived: '5.25' }, { poItemId: l2, qtyReceived: '5,25' }]), 201);
    expect(r.poStatus).toBe('received');
    expect(r.items.map((i) => [i.poItemId, i.qtyReceived])).toEqual([[l1, '60.0000'], [l2, '10.5000']]);
    const full = await api.ok<Po>(api.call(w.u.mgr, 'GET', `/purchase-orders/${po.id}`));
    expect(full.status).toBe('received');
    expect(full.items.map((i) => i.qtyReceived)).toEqual(['100.0000', '10.5000']);
    const before = await snapshot();
    await api.fails(gr([{ poItemId: l1, qtyReceived: '0.0001' }]), 409);
    expect(await snapshot()).toEqual(before);
    const list = await api.ok<Array<{ id: number; poId: number }>>(api.call(w.u.mgr, 'GET', `/goods-receipts?poId=${po.id}`));
    expect(list).toHaveLength(2);
    expect(list.every((g) => g.poId === po.id)).toBe(true);
  });

  it('single-line PO: one exact receipt goes issued → received directly', async () => {
    const p = await makePo(w, { siteId: w.s1, vendorId: w.v2, items: [{ description: 'Sewa excavator', qty: '0.5', unitPriceCents: 1_000_000 }] }, { approve: true });
    const r = await api.ok<Gr>(gr([{ poItemId: p.items[0]!.id, qtyReceived: '0.5' }], '2026-10-11', w.u.mgr, p.id), 201);
    expect(r.poStatus).toBe('received');
  });

  it('site scope on receipts: site_staff lists only receipts of their site', async () => {
    const atS2 = await makePo(w, { siteId: w.s2, vendorId: w.v1, items: [{ description: 'pipa', qty: 5, unitPriceCents: 100 }] }, { approve: true });
    const g2 = await api.ok<Gr>(gr([{ poItemId: atS2.items[0]!.id, qtyReceived: 1 }], '2026-10-12', w.u.adm, atS2.id), 201);
    expect(g2.number).toMatch(/^GR\/JYP\/2026\/\d{3}$/);
    const staffList = await api.ok<Array<{ id: number; siteId: number }>>(api.call(w.u.staff, 'GET', '/goods-receipts'));
    expect(staffList.length).toBeGreaterThan(0);
    expect(staffList.every((g) => g.siteId === w.s1)).toBe(true);
    expect(await api.ok(api.call(w.u.staffNone, 'GET', '/goods-receipts'))).toEqual([]);
    // the PO at s2 and its lines are invisible to the staff of s1
    await api.fails(api.call(w.u.staff, 'GET', `/purchase-orders/${atS2.id}`), 404);
    const pos = await api.ok<Po[]>(api.call(w.u.staff, 'GET', '/purchase-orders'));
    expect(pos.every((p) => p.siteId === w.s1)).toBe(true);
    // RLS on the line tables follows the parent
    const lines = await withCompany(w.db, { companyId: w.A, siteIds: [w.s1] }, (tx) => tx.select().from(purchaseOrderItems).where(eq(purchaseOrderItems.poId, atS2.id)));
    expect(lines).toEqual([]);
    const grLines = await withCompany(w.db, { companyId: w.A, siteIds: [w.s1] }, (tx) => tx.select().from(goodsReceiptItems).where(eq(goodsReceiptItems.grId, g2.id)));
    expect(grLines).toEqual([]);
  });
});

// ------------------------------------------------------------------------------------------------
describe('cross-company isolation', () => {
  it('B\'s PO is invisible through A (404) and A\'s members get 403 on B\'s routes', async () => {
    const poB = await api.ok<Po>(api.call(w.u.bobB, 'POST', '/purchase-orders', {
      siteId: w.sB, vendorId: w.vB, contractId: w.KB, orderDate: '2026-10-01', items: [{ boqItemId: w.leaf.KB, description: 'B', qty: 2, unitPriceCents: 100 }],
    }, w.B), 201);
    expect(poB.number).toBe('PO/BBB/2026/001');
    for (const u of [w.u.mgr, w.u.sys]) {
      await api.fails(api.call(u, 'GET', `/purchase-orders/${poB.id}`), 404);
      await api.fails(api.call(u, 'POST', `/purchase-orders/${poB.id}/approve`), 404);
      await api.fails(api.call(u, 'POST', `/purchase-orders/${poB.id}/cancel`), 404);
      await api.fails(api.call(u, 'POST', `/purchase-orders/${poB.id}/receipts`, { receivedAt: '2026-10-02', items: [{ poItemId: poB.items[0]!.id, qtyReceived: 1 }] }), 404);
      await api.fails(api.call(u, 'GET', `/purchase-orders/${poB.id}`, undefined, w.B), 403);
    }
    const listA = await api.ok<Po[]>(api.call(w.u.mgr, 'GET', '/purchase-orders'));
    expect(listA.some((p) => p.id === poB.id)).toBe(false);
    expect((await api.ok<Po>(api.call(w.u.bobB, 'GET', `/purchase-orders/${poB.id}`, undefined, w.B))).status).toBe('draft');
    // a holding viewer is not a company member
    await api.fails(api.call(w.u.boss, 'GET', '/purchase-orders'), 403);
    // no auth
    expect((await w.app.request(`/companies/${w.A}/purchase-orders`)).status).toBe(401);
  });

  it('a PO line cannot point at a line of another company\'s PR', async () => {
    const prB = await api.ok<Pr>(api.call(w.u.bobB, 'POST', '/purchase-requests', { siteId: w.sB, items: [{ description: 'B', qty: 1 }] }, w.B), 201);
    await api.fails(api.call(w.u.adm, 'POST', '/purchase-orders', {
      siteId: w.s1, vendorId: w.v1, prId: prB.id, orderDate: '2026-10-01', items: [{ prItemId: prB.items[0]!.id, description: 'x', qty: 1, unitPriceCents: 1 }],
    }), 404);
  });
});

// ------------------------------------------------------------------------------------------------
describe('filters on the PO list', () => {
  it('status, site and vendor filters', async () => {
    const p = await makePo(w, { siteId: w.s2, vendorId: w.v2, items: [{ description: 'x', qty: 1, unitPriceCents: 1 }] });
    const list = await api.ok<Po[]>(api.call(w.u.mgr, 'GET', `/purchase-orders?status=draft&siteId=${w.s2}&vendorId=${w.v2}`));
    expect(list.map((x) => x.id)).toEqual([p.id]);
    await api.fails(api.call(w.u.mgr, 'GET', '/purchase-orders?status=nope'), 400);
  });
});
