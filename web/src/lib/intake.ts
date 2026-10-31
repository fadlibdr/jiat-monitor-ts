import { amountPlain } from './format.js';
import type { Category, IntakePatch, IntakeRow, IntakeStatus } from './types.js';

/** The review form's fields, as the inputs hold them (strings; '' = empty). */
export interface IntakeForm {
  vendorId: string;
  vendorName: string;
  invoiceDate: string;
  dueDate: string;
  total: string;
  docNumber: string;
  category: Category | '';
}

export function formOf(row: IntakeRow): IntakeForm {
  return {
    vendorId: row.vendorId ? String(row.vendorId) : '',
    vendorName: row.vendorName ?? '',
    invoiceDate: row.invoiceDate ?? '',
    dueDate: row.dueDate ?? '',
    total: amountPlain(row.totalCents),
    docNumber: row.docNumber ?? '',
    category: row.category ?? '',
  };
}

/**
 * Only what the reviewer changed, as PATCH /intake/:rowId expects. A due date that was set and is
 * now empty is sent as null: the server then uses the nota date + the vendor's payment term, as the
 * field's label says. Other emptied fields are not sent (the API cannot blank them).
 */
export function patchOf(row: IntakeRow, f: IntakeForm): IntakePatch {
  const p: IntakePatch = {};
  const name = f.vendorName.trim();
  if (f.vendorId && Number(f.vendorId) !== row.vendorId) p.vendorId = Number(f.vendorId);
  else if (!f.vendorId && name && name !== (row.vendorName ?? '')) p.vendorName = name;
  if (f.invoiceDate && f.invoiceDate !== row.invoiceDate) p.invoiceDate = f.invoiceDate;
  if (f.dueDate !== (row.dueDate ?? '')) p.dueDate = f.dueDate || null;
  const typed = f.total.trim();
  if (typed && typed !== amountPlain(row.totalCents)) p.totalCents = typed; // the server parses "2.450.000" / "Rp 2.450.000,-"
  const doc = f.docNumber.trim();
  if (doc && doc !== (row.docNumber ?? '')) p.docNumber = doc;
  if (f.category && f.category !== row.category) p.category = f.category;
  return p;
}

/** Whether a row with this status belongs in the list of a tab (undefined = "Terbuka": both open statuses). */
export function listedIn(tab: IntakeStatus | undefined, status: IntakeStatus): boolean {
  return tab === undefined ? status === 'perlu_konfirmasi' || status === 'perlu_cek' : status === tab;
}

/**
 * What the reviewer may do with a row, mirroring the server: an open row can be corrected, confirmed
 * or rejected; a confirmed one can still have its data corrected (wrong number, due date, total) but
 * not change status; a rejected one is left as it is. Finance only reads.
 */
export function editMode(status: IntakeStatus, canEdit: boolean): 'full' | 'fix' | 'none' {
  if (!canEdit || status === 'ditolak') return 'none';
  return status === 'terkonfirmasi' ? 'fix' : 'full';
}
