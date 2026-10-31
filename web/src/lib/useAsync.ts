import { useCallback, useEffect, useRef, useState } from 'react';

export interface AsyncState<T> {
  data: T | undefined;
  error: Error | undefined;
  loading: boolean;
  reload: () => void;
}

/**
 * Runs `load` when `deps` change and keeps the last result. An answer that arrives after a newer
 * request started is dropped, so a slow response never overwrites a newer filter's data. When `deps`
 * change, or a request fails, the old data is cleared: figures of the previous month or company must
 * never sit under the new selection. A plain reload() keeps them on screen until the new answer.
 */
export function useAsync<T>(load: () => Promise<T>, deps: readonly unknown[]): AsyncState<T> {
  const [data, setData] = useState<T>();
  const [error, setError] = useState<Error>();
  const [loading, setLoading] = useState(true);
  const [tick, setTick] = useState(0);
  const seq = useRef(0);

  // `load` is a fresh closure on every render; the caller lists what it depends on in `deps`
  useEffect(() => {
    setData(undefined);
  }, deps);

  useEffect(() => {
    const mine = ++seq.current;
    setLoading(true);
    setError(undefined);
    load().then(
      (v) => { if (mine === seq.current) { setData(v); setLoading(false); } },
      (e: unknown) => {
        if (mine !== seq.current) return;
        setData(undefined);
        setError(e instanceof Error ? e : new Error(String(e)));
        setLoading(false);
      },
    );
  }, [...deps, tick]);

  const reload = useCallback(() => setTick((t) => t + 1), []);
  return { data, error, loading, reload };
}
