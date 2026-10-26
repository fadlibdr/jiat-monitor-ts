/** Thrown for any reason an import must refuse; `details` is safe to show the user. */
export class BoqImportError extends Error {
  override readonly name = 'BoqImportError';
  constructor(
    message: string,
    public readonly code:
      | 'file_unreadable'
      | 'sheet_missing'
      | 'header_missing'
      | 'column_missing'
      | 'row_invalid'
      | 'duplicate_code'
      | 'total_mismatch'
      | 'contract_invalid'
      | 'foreign_contract',
    public readonly details: Record<string, unknown> = {},
  ) {
    super(message);
  }
}
