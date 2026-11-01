import type { ReactNode } from 'react';
import { createPortal } from 'react-dom';

/**
 * A document for the browser's own print (Ctrl+P / "Cetak" → window.print). Rendered outside #root, hidden
 * on screen; the print stylesheet hides the app and shows only this, so no PDF library is needed.
 */
export function PrintSheet({ children }: { children: ReactNode }) {
  return createPortal(<div className="print-sheet">{children}</div>, document.body);
}

/** The "Cetak" button next to a printable document. */
export function PrintButton({ label = 'Cetak' }: { label?: string }) {
  return <button type="button" className="btn" onClick={() => window.print()}>{label}</button>;
}
