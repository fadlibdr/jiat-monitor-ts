import ExcelJS from 'exceljs';
import { parseIdrCents, type Cents } from '../domain/money.js';
import { BoqImportError } from './errors.js';

/**
 * Reads the RAB sheet of an AHSP workbook (layout "RAPI") into a BOQ tree. Pure: no DB.
 *
 * Rule zero: printed numbers are never altered. A printed jumlah wins over qty × harga; any
 * disagreement is reported in `anomalies` with row and both values. Money is integer cents.
 *
 * Section codes: Roman (I, II…) > letter (A, B…) > number (1, 2, 1.1…). Single letters that are
 * also Roman digits (I, V, X, L, C, D, M) are decided by the document's own sequence
 * (fix B1 of the PHP build, where "C" became Roman and broke the tree).
 */
export interface ParsedItem {
  row: number; // Excel row (1-based)
  code: string; // full path, e.g. II.A.1
  codePrinted: string;
  description: string;
  unit: string | null;
  qty: number | null;
  unitPriceCents: Cents | null;
  amountCents: Cents; // leaf: printed (or qty×price); parent: Σ children
  printedAmountCents: Cents | null; // parent only: printed subtotal, if any
  parentIdx: number | null;
  level: number;
  isLeaf: boolean;
}
export interface Anomaly { row: number; type: string; detail: string }
export interface ParsedBoq {
  items: ParsedItem[];
  footers: Array<{ row: number; label: string; amountCents: Cents | null }>;
  anomalies: Anomaly[];
  totalCents: Cents; // Σ leaf amounts
}

type Kind = 'roman' | 'letter' | 'number';
interface Cols { code: number | null; desc: number; unit: number | null; qty: number; price: number; amount: number }
type Row = Array<string | number | null>;

const FOOTER = /^\s*(jumlah|total|sub\s*total|ppn|dibulatkan|terbilang|harga\s+total)\b/i;
const HEADER_SCAN_ROWS = 40;
const AMOUNT_TOLERANCE_CENTS = 100; // Rp 1

export async function parseBoqWorkbook(source: string | Buffer, sheetName = 'RAB'): Promise<ParsedBoq> {
  const wb = new ExcelJS.Workbook();
  try {
    if (typeof source === 'string') await wb.xlsx.readFile(source);
    else await wb.xlsx.load(source as unknown as ArrayBuffer);
  } catch (e) {
    throw new BoqImportError('Berkas tidak dapat dibaca sebagai .xlsx.', 'file_unreadable', { cause: String(e) });
  }
  const ws = wb.getWorksheet(sheetName);
  if (!ws) throw new BoqImportError(`Sheet "${sheetName}" tidak ditemukan.`, 'sheet_missing', { sheets: wb.worksheets.map((w) => w.name) });
  return parseRows(worksheetToRows(ws));
}

/** Exposed for tests and for callers that already hold a 2-D array. */
export function parseRows(rows: Row[]): ParsedBoq {
  const [hdr, cols] = findHeader(rows);
  const items: ParsedItem[] = [];
  const footers: ParsedBoq['footers'] = [];
  const anomalies: Anomaly[] = [];
  const stack: Array<{ idx: number; kind: Kind; code: string; full: string }> = [];
  let lastRoman: string | null = null;
  let lastLetter: { code: string; parentIdx: number | null } | null = null;

  for (let i = hdr + 1; i < rows.length; i++) {
    const r = rows[i] ?? [];
    const excelRow = i + 1;
    const desc = str(r[cols.desc]) ?? '';
    let code = cols.code === null ? '' : (str(r[cols.code]) ?? '');
    const qty = num(r[cols.qty]);
    const price = cents(r[cols.price]);
    const amount = cents(r[cols.amount]);

    if (desc === '' && code === '' && qty === null && price === null && amount === null) continue;
    if (code === '' && FOOTER.test(desc)) {
      footers.push({ row: excelRow, label: desc, amountCents: amount });
      continue;
    }

    const isLeaf =
      (qty !== null && price !== null) ||
      (code !== '' && amount !== null && qty === null && price === null && looksLeaf(code, rows, i, cols));
    if (code === '') {
      code = `R${excelRow}`;
      anomalies.push({ row: excelRow, type: 'row_without_code', detail: `kode dibuat otomatis ${code}` });
    }

    // classify, then pop the stack to the nearest legal parent
    const kind = classify(code, lastRoman, lastLetter, stack);
    while (stack.length && !canParent(stack[stack.length - 1]!, kind, code)) stack.pop();
    const top = stack[stack.length - 1];
    const parentIdx = top ? top.idx : null;
    const level = stack.length;

    const printedCode = code;
    let full = code;
    if (top) {
      const childOfPrefix = kind === 'number' && rtrimDot(code).startsWith(`${rtrimDot(top.code)}.`);
      if (!childOfPrefix) full = `${top.full}.${rtrimDot(code)}`;
    }
    if (kind === 'roman') lastRoman = rtrimDot(code);
    if (kind === 'letter') lastLetter = { code: rtrimDot(code), parentIdx };

    let amountCents: Cents | null = isLeaf ? amount : null;
    if (isLeaf) {
      if (amount === null && qty !== null && price !== null) {
        amountCents = Math.round(qty * price);
        anomalies.push({ row: excelRow, type: 'amount_computed', detail: `jumlah kosong; qty × harga = ${amountCents} sen` });
      } else if (amount !== null && qty !== null && price !== null && Math.abs(amount - Math.round(qty * price)) > AMOUNT_TOLERANCE_CENTS) {
        anomalies.push({
          row: excelRow,
          type: 'amount_mismatch',
          detail: `jumlah tercetak ${amount} sen ≠ qty × harga ${Math.round(qty * price)} sen; jumlah tercetak dipakai`,
        });
      }
      if (amountCents === null) {
        throw new BoqImportError(`Baris ${excelRow} (${full}): item tanpa jumlah dan tanpa qty/harga.`, 'row_invalid', { row: excelRow, code: full });
      }
    }

    items.push({
      row: excelRow, code: full, codePrinted: printedCode, description: desc,
      unit: str(r[cols.unit ?? -1]), qty, unitPriceCents: price,
      amountCents: amountCents ?? 0, printedAmountCents: isLeaf ? null : amount,
      parentIdx, level, isLeaf,
    });
    if (!isLeaf) stack.push({ idx: items.length - 1, kind, code: printedCode, full });
  }

  // duplicate full codes would break unique(version_id, code)
  const seen = new Map<string, number>();
  for (const it of items) {
    const prev = seen.get(it.code);
    if (prev !== undefined) throw new BoqImportError(`Kode ganda "${it.code}" pada baris ${prev} dan ${it.row}.`, 'duplicate_code', { code: it.code, rows: [prev, it.row] });
    seen.set(it.code, it.row);
  }

  // roll leaf amounts up into parents (computed, never printed)
  for (const it of items) {
    if (!it.isLeaf) continue;
    for (let p = it.parentIdx; p !== null; p = items[p]!.parentIdx) items[p]!.amountCents += it.amountCents;
  }
  const childCount = new Map<number, number>();
  for (const it of items) if (it.parentIdx !== null) childCount.set(it.parentIdx, (childCount.get(it.parentIdx) ?? 0) + 1);
  items.forEach((it, idx) => {
    if (it.isLeaf) return;
    if (!childCount.has(idx)) {
      // a coded row with no qty/price/jumlah and no children: a section that lost its rows, or a half-filled item
      anomalies.push({ row: it.row, type: 'empty_section', detail: `"${it.code}" tidak punya item di bawahnya dan tidak punya jumlah; diabaikan dari total` });
      return;
    }
    if (it.printedAmountCents !== null && it.printedAmountCents !== it.amountCents) {
      anomalies.push({ row: it.row, type: 'subtotal_mismatch', detail: `subtotal tercetak ${it.printedAmountCents} sen ≠ jumlah anak ${it.amountCents} sen; jumlah anak dipakai` });
    }
  });

  const totalCents = items.reduce((s, it) => (it.isLeaf ? s + it.amountCents : s), 0);
  return { items, footers, anomalies, totalCents };
}

// ---------- classification (B1) ----------

const ROMAN = /^[IVXLCDM]+$/;

function classify(code: string, lastRoman: string | null, lastLetter: { code: string; parentIdx: number | null } | null, stack: Array<{ idx: number; kind: Kind }>): Kind {
  const c = rtrimDot(code);
  if (/^[A-Z]$/.test(c)) {
    const romanDigit = ROMAN.test(c);
    if (!romanDigit) return 'letter';
    // Ambiguous single char: decide by the document's own sequence.
    const romanTop = [...stack].reverse().find((s) => s.kind === 'roman');
    if (lastLetter && (romanTop ? lastLetter.parentIdx === romanTop.idx : true) && nextLetter(lastLetter.code) === c) return 'letter';
    if (c === nextRoman(lastRoman)) return 'roman';
    return 'letter';
  }
  if (ROMAN.test(c) && romanToInt(c) !== null) return 'roman';
  return 'number';
}

function canParent(top: { kind: Kind; code: string }, kind: Kind, code: string): boolean {
  switch (kind) {
    case 'roman': return false;
    case 'letter': return top.kind === 'roman';
    default:
      return top.kind !== 'number' || rtrimDot(code).startsWith(`${rtrimDot(top.code)}.`);
  }
}

function nextLetter(c: string): string {
  return String.fromCharCode(c.charCodeAt(0) + 1);
}
function nextRoman(last: string | null): string {
  const n = last ? (romanToInt(last) ?? 0) : 0;
  return intToRoman(n + 1);
}
const ROMAN_VALUES: Record<string, number> = { I: 1, V: 5, X: 10, L: 50, C: 100, D: 500, M: 1000 };
export function romanToInt(s: string): number | null {
  let total = 0;
  for (let i = 0; i < s.length; i++) {
    const v = ROMAN_VALUES[s[i]!];
    const next = ROMAN_VALUES[s[i + 1] ?? ''] ?? 0;
    if (v === undefined) return null;
    total += v < next ? -v : v;
  }
  return intToRoman(total) === s ? total : null; // canonical form only
}
export function intToRoman(n: number): string {
  const map: Array<[number, string]> = [[1000, 'M'], [900, 'CM'], [500, 'D'], [400, 'CD'], [100, 'C'], [90, 'XC'], [50, 'L'], [40, 'XL'], [10, 'X'], [9, 'IX'], [5, 'V'], [4, 'IV'], [1, 'I']];
  let out = '';
  for (const [v, s] of map) while (n >= v) { out += s; n -= v; }
  return out;
}

// ---------- sheet access ----------

function worksheetToRows(ws: ExcelJS.Worksheet): Row[] {
  const rows: Row[] = [];
  ws.eachRow({ includeEmpty: true }, (row, rowNumber) => {
    const arr: Row = [];
    row.eachCell({ includeEmpty: true }, (cell, col) => { arr[col - 1] = cellValue(cell); });
    rows[rowNumber - 1] = arr;
  });
  for (let i = 0; i < rows.length; i++) rows[i] ??= [];
  return rows;
}

function cellValue(cell: ExcelJS.Cell): string | number | null {
  const v: unknown = cell.value;
  if (v === null || v === undefined) return null;
  if (typeof v === 'number' || typeof v === 'string') return v;
  if (typeof v === 'boolean') return v ? '1' : '0';
  if (v instanceof Date) return v.toISOString().slice(0, 10);
  if (typeof v === 'object') {
    const o = v as { result?: unknown; richText?: Array<{ text: string }>; text?: unknown; error?: unknown };
    if ('error' in o) return null;
    if (Array.isArray(o.richText)) return o.richText.map((t) => t.text).join('');
    if ('result' in o) return typeof o.result === 'number' || typeof o.result === 'string' ? o.result : null;
    if (typeof o.text === 'string') return o.text;
  }
  return null;
}

function findHeader(rows: Row[]): [number, Cols] {
  for (let i = 0; i < Math.min(rows.length, HEADER_SCAN_ROWS); i++) {
    const cells = (rows[i] ?? []).map((c) => (str(c) ?? '').toLowerCase());
    const find = (re: RegExp, from = 0) => { const k = cells.findIndex((v, idx) => idx >= from && v !== '' && re.test(v)); return k === -1 ? null : k; };
    const desc = find(/^uraian/);
    // Some RABs label the quantity column "Jumlah" and the amount "Jumlah Harga"/"Total":
    // with no explicit volume header and ≥ 2 jumlah/total headers, the first is qty, the last is amount.
    let qty = find(/^(volume|vol\b|kuantitas|qty)/);
    const amountCandidates = cells.flatMap((v, idx) => (v !== '' && /^(jumlah|total)/.test(v) ? [idx] : []));
    if (qty === null && amountCandidates.length >= 2) qty = amountCandidates[0]!;
    const amount = amountCandidates.filter((idx) => idx !== qty).at(-1) ?? null;
    if (desc === null || amount === null) continue;
    const cols: Cols = {
      code: find(/^(no\b|no\.|kode)/),
      desc,
      unit: find(/^(satuan|sat\b)/),
      qty: qty ?? -1,
      price: find(/^harga\s*(satuan|sat\b)/) ?? find(/^harga/) ?? -1,
      amount,
    };
    for (const must of ['qty', 'price'] as const) {
      if (cols[must] === -1) throw new BoqImportError(`Kolom "${must}" tidak ditemukan pada baris header ${i + 1}.`, 'column_missing', { header: i + 1, column: must });
    }
    if (cols.price === cols.amount) throw new BoqImportError(`Kolom harga satuan dan jumlah menunjuk kolom yang sama pada baris ${i + 1}.`, 'column_missing', { header: i + 1 });
    return [i, cols];
  }
  throw new BoqImportError(`Baris header (Uraian … Jumlah) tidak ditemukan pada ${HEADER_SCAN_ROWS} baris pertama.`, 'header_missing');
}

/** A row with an amount but no qty/price is a leaf only if the next coded row is not its child. */
function looksLeaf(code: string, rows: Row[], i: number, cols: Cols): boolean {
  if (cols.code === null) return true;
  for (let j = i + 1; j < rows.length; j++) {
    const next = str(rows[j]?.[cols.code]) ?? '';
    if (next === '') continue;
    const nextIsNumber = !/^[A-Z]+$/.test(rtrimDot(next));
    const thisIsNumber = !/^[A-Z]+$/.test(rtrimDot(code));
    return !rtrimDot(next).startsWith(`${rtrimDot(code)}.`) && !(!thisIsNumber && nextIsNumber);
  }
  return true;
}

function rtrimDot(s: string): string { return s.replace(/\.+$/, ''); }
function str(v: string | number | null | undefined): string | null {
  if (v === null || v === undefined) return null;
  const s = String(v).trim();
  return s === '' ? null : s;
}
function num(v: string | number | null | undefined): number | null {
  if (v === null || v === undefined || v === '') return null;
  if (typeof v === 'number') return Number.isFinite(v) ? v : null;
  const c = parseIdrCents(v);
  return c === null ? null : c / 100;
}
function cents(v: string | number | null | undefined): Cents | null {
  const n = num(v);
  return n === null ? null : Math.round(n * 100);
}
