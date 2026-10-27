/**
 * Structured logging (LLD §9): one JSON object per line on stdout, for the process manager to
 * collect. Fields carry ids (company, user, chat, message, job), never photo bytes, bank accounts,
 * NPWP, tokens or passwords: values under those keys are replaced before anything is written, at
 * any depth, so a careless `log('x', { vendor })` cannot leak them.
 */
export type LogLevel = 'info' | 'warn' | 'error';
export type Log = (msg: string, meta?: object) => void;

const SECRET_KEY = /(bank_?account|rekening|npwp|password|passwd|secret|token|authorization|cookie|api_?key)/i;
const MAX_DEPTH = 6;

export function redact(value: unknown, depth = 0): unknown {
  if (value === null || typeof value !== 'object') return value;
  if (depth >= MAX_DEPTH) return '[depth]';
  if (Buffer.isBuffer(value) || value instanceof Uint8Array) return `[${value.length} bytes]`;
  if (value instanceof Date) return value.toISOString();
  if (value instanceof Error) return `${value.name}: ${value.message}`;
  if (Array.isArray(value)) return value.map((v) => redact(v, depth + 1));
  return Object.fromEntries(Object.entries(value).map(([k, v]) => [k, SECRET_KEY.test(k) ? '[redacted]' : redact(v, depth + 1)]));
}

/** Level from the message name: "*_failed" / "*_error" → error, "*_warn*" → warn, else info. */
function levelOf(msg: string): LogLevel {
  if (/(_failed|_error)$/.test(msg) || msg === 'unhandled') return 'error';
  if (/warn|skipped|no_recipients/.test(msg)) return 'warn';
  return 'info';
}

export function createLogger(base: Record<string, unknown> = {}, write: (line: string) => void = (l) => process.stdout.write(`${l}\n`)): Log {
  return (msg, meta = {}) => {
    write(JSON.stringify({ time: new Date().toISOString(), level: levelOf(msg), msg, ...(redact(base) as object), ...(redact(meta) as object) }));
  };
}
