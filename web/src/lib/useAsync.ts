import { useCallback, useEffect, useRef, useState } from 'react';

export interface AsyncState<T> {
  data: T | undefined;
  error: Error | undefined;
  loading: boolean;
  reload: () => void;
}

/**
 * Runs `load` when `deps` change and keeps the last result. An answer that arrives after a newer
 * request started is dropped, so a slow response never overwrites a newer filter's data.
 */
export function useAsync<T>(load: () => Promise<T>, deps: readonly unknown[]): AsyncState<T> {
  const [data, setData] = useState<T>();
  const [error, setError] = useState<Error>();
  const [loading, setLoading] = useState(true);
  const [tick, setTick] = useState(0);
  const seq = useRef(0);

  useEffect(() => {
    const mine = ++seq.current;
    setLoading(true);
    setError(undefined);
    load().then(
      (v) => { if (mine === seq.current) { setData(v); setLoading(false); } },
      (e: unknown) => { if (mine === seq.current) { setError(e instanceof Error ? e : new Error(String(e))); setLoading(false); } },
    );
    // `load` is a fresh closure on every render; the caller lists what it depends on in `deps`
  }, [...deps, tick]);

  const reload = useCallback(() => setTick((t) => t + 1), []);
  return { data, error, loading, reload };
}
