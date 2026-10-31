import { lineAmountCents, parseQty, qtyToString } from '../../../src/domain/quantity.js';
import { parseIdrCents } from './forms.js';
import type { Built } from './master.js';
import type { GrInput, PoInput, PoLineInput, PrInput, PrLineInput, PurchaseOrderDetail, PurchaseRequestDetail } from './types.js';

/**
 * Procurement forms → request bodies. Quantities and line amounts use the server's own code
 * (src/domain/quantity.ts: integers of 1/10 000 unit, qty × price rounded like the API), so the totals
 * a form shows are the ones the PO will store, and "more than ordered" is caught before sending.
 */
const fail = (error: string): { ok: false; error: string } => ({ ok: false, error });

export interface LineForm {
  /** '' = not tied to a BOQ item */
  boqItemId: string;
  /** set when the line comes from a PR item */
  prItemId?: number | undefined;
  description: string;
  qty: string;
  unit: string;
  /** PR: estimated unit price; PO: unit price (Rp) */
  price: string;
}

export const emptyLine = (): LineForm => ({ boqItemId: '', description: '', qty: '', unit: '', price: '' });

/** qty × unit price in cents, as the API computes it; null while either is unreadable */
export function lineTotalCents(l: Pick<LineForm, 'qty' | 'price'>): number | null {
  const q = parseQty(l.qty);
  const p = parseIdrCents(l.price);
  return q === null || p === null ? null : lineAmountCents(q, p);
}

type LineChecked = { boqItemId?: number; description: string; qty: string; unit?: string; priceCents: number | null };

function checkLines(lines: readonly LineForm[], priceRequired: boolean): Built<LineChecked[]> {
  if (lines.length === 0) return fail('Tambahkan minimal satu baris.');
  const out: LineChecked[] = [];
  for (const [i, l] of lines.entries()) {
    const n = i + 1;
    if (!l.description.trim()) return fail(`Baris ${n}: uraian wajib diisi.`);
    const q = parseQty(l.qty);
    if (q === null || q <= 0) return fail(`Baris ${n}: volume harus > 0, paling banyak 4 desimal (mis. 12,5).`);
    const priceCents = l.price.trim() ? parseIdrCents(l.price) : null;
    if (l.price.trim() && priceCents === null) return fail(`Baris ${n}: harga tidak terbaca (tulis mis. 1.250.000).`);
    if (priceRequired && priceCents === null) return fail(`Baris ${n}: harga satuan wajib diisi.`);
    out.push({
      ...(l.boqItemId ? { boqItemId: Number(l.boqItemId) } : {}),
      description: l.description.trim(), qty: qtyToString(q), ...(l.unit.trim() ? { unit: l.unit.trim() } : {}), priceCents,
    });
  }
  return { ok: true, body: out };
}

export interface PrForm { siteId: string; contractId: string; neededBy: string; note: string; lines: LineForm[] }

export function prBody(f: PrForm): Built<PrInput> {
  if (!f.siteId) return fail('Pilih lokasi.');
  const lines = checkLines(f.lines, false);
  if (!lines.ok) return lines;
  const items: PrLineInput[] = lines.body.map(({ priceCents, ...l }) => ({ ...l, ...(priceCents !== null ? { estPriceCents: priceCents } : {}) }));
  const body: PrInput = { siteId: Number(f.siteId), items };
  if (f.contractId) body.contractId = Number(f.contractId);
  if (f.neededBy) body.neededBy = f.neededBy;
  if (f.note.trim()) body.note = f.note.trim();
  return { ok: true, body };
}

export interface PoForm {
  siteId: string; vendorId: string; contractId: string; prId?: number | undefined; orderDate: string; expectedDate: string; note: string; lines: LineForm[];
}

export function poBody(f: PoForm): Built<PoInput> {
  if (!f.siteId) return fail('Pilih lokasi.');
  if (!f.vendorId) return fail('Pilih vendor.');
  if (!f.orderDate) return fail('Tanggal PO wajib diisi.');
  if (f.expectedDate && f.expectedDate < f.orderDate) return fail('Tanggal kirim sebelum tanggal PO.');
  const lines = checkLines(f.lines, true);
  if (!lines.ok) return lines;
  const items: PoLineInput[] = lines.body.map(({ priceCents, ...l }, i) => ({
    ...l, unitPriceCents: priceCents!, ...(f.lines[i]!.prItemId ? { prItemId: f.lines[i]!.prItemId } : {}),
  }));
  const body: PoInput = { siteId: Number(f.siteId), vendorId: Number(f.vendorId), orderDate: f.orderDate, items };
  if (f.contractId) body.contractId = Number(f.contractId);
  if (f.prId) body.prId = f.prId;
  if (f.expectedDate) body.expectedDate = f.expectedDate;
  if (f.note.trim()) body.note = f.note.trim();
  return { ok: true, body };
}

/** "12.5000" → "12,5" for an input the user may edit (parseQty reads both marks). */
const qtyText = (stored: string) => (stored.includes('.') ? stored.replace(/0+$/, '').replace(/\.$/, '') : stored).replace('.', ',');
const rupiahText = (cents: number | null) => (cents === null ? '' : String(Math.round(cents / 100)).replace(/\B(?=(\d{3})+(?!\d))/g, '.'));

/** A PO started from an approved PR: same site and contract, its lines with the estimated prices to confirm. */
export function poFormFromPr(pr: PurchaseRequestDetail, today: string): PoForm {
  return {
    siteId: String(pr.siteId), vendorId: '', contractId: pr.contractId ? String(pr.contractId) : '', prId: pr.id,
    orderDate: today, expectedDate: pr.neededBy ?? '', note: '',
    lines: pr.items.map((i) => ({
      boqItemId: i.boqItemId ? String(i.boqItemId) : '', prItemId: i.id, description: i.description,
      qty: qtyText(i.qty), unit: i.unit ?? '', price: rupiahText(i.estPriceCents),
    })),
  };
}

/** What is still to come per PO line, as a receipt form starts: the remaining quantity. */
export function receiptRows(po: PurchaseOrderDetail): Array<{ poItemId: number; description: string; unit: string | null; ordered: string; received: string; remaining: string }> {
  return po.items.map((i) => {
    const left = Math.max(0, (parseQty(i.qty) ?? 0) - (parseQty(i.qtyReceived) ?? 0));
    return { poItemId: i.id, description: i.description, unit: i.unit, ordered: i.qty, received: i.qtyReceived, remaining: left ? qtyText(qtyToString(left)) : '0' };
  });
}

/** Lines with a quantity typed (0 / empty = nothing arrived); refused above what is still to come. */
export function grBody(po: PurchaseOrderDetail, typed: Record<number, string>, receivedAt: string, note: string): Built<GrInput> {
  if (!receivedAt) return fail('Tanggal terima wajib diisi.');
  const items: GrInput['items'] = [];
  for (const i of po.items) {
    const raw = (typed[i.id] ?? '').trim();
    if (!raw || raw === '0') continue;
    const q = parseQty(raw);
    if (q === null || q <= 0) return fail(`"${i.description}": volume tidak terbaca (paling banyak 4 desimal).`);
    const left = (parseQty(i.qty) ?? 0) - (parseQty(i.qtyReceived) ?? 0);
    if (q > left) return fail(`"${i.description}": melebihi sisa pesanan (${qtyText(qtyToString(Math.max(0, left)))}).`);
    items.push({ poItemId: i.id, qtyReceived: qtyToString(q) });
  }
  if (items.length === 0) return fail('Isi volume yang diterima pada minimal satu baris.');
  const body: GrInput = { receivedAt, items };
  if (note.trim()) body.note = note.trim();
  return { ok: true, body };
}
