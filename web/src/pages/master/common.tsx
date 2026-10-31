import { ApiError } from '../../lib/api';

export type Note = { tone: 'ok' | 'error'; text: string; detail?: string[] };

/** The outcome of the last save in a panel. */
export function Notice({ note }: { note: Note | undefined }) {
  if (!note) return null;
  return (
    <div className={`notice ${note.tone}`} role={note.tone === 'error' ? 'alert' : 'status'}>
      {note.text}
      {note.detail && note.detail.length > 0 && <ul>{note.detail.map((d) => <li key={d}>{d}</li>)}</ul>}
    </div>
  );
}

/** A failed request as a panel note: the server's own message, or "no connection". */
export const errorNote = (e: unknown): Note => ({ tone: 'error', text: e instanceof ApiError ? e.message : 'Tidak dapat menghubungi server.' });
