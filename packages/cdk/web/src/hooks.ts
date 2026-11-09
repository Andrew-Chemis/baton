import { useCallback, useEffect, useRef, useState } from 'preact/hooks';

export interface Loaded<T> {
  data: T | undefined;
  error: string | undefined;
  loading: boolean;
  reload: () => Promise<void>;
  /** Replaces the data now, for an optimistic change; the next load overwrites it. */
  set: (next: T) => void;
}

/** Loads on mount and whenever `key` changes, then every `ms` while the page is visible. */
export function usePoll<T>(load: () => Promise<T>, key: string, ms = 15_000): Loaded<T> {
  const [data, setData] = useState<T | undefined>();
  const [error, setError] = useState<string | undefined>();
  const [loading, setLoading] = useState(true);
  const latest = useRef(0);
  const loader = useRef(load);
  loader.current = load;

  const reload = useCallback(async () => {
    const ticket = ++latest.current;
    try {
      const next = await loader.current();
      if (ticket !== latest.current) return;
      setData(next);
      setError(undefined);
    } catch (caught) {
      if (ticket === latest.current) setError(caught instanceof Error ? caught.message : String(caught));
    } finally {
      if (ticket === latest.current) setLoading(false);
    }
  }, []);

  useEffect(() => {
    setLoading(true);
    void reload();
    const timer = setInterval(() => {
      if (!document.hidden) void reload();
    }, ms);
    const visible = () => {
      if (!document.hidden) void reload();
    };
    document.addEventListener('visibilitychange', visible);
    return () => {
      clearInterval(timer);
      document.removeEventListener('visibilitychange', visible);
      latest.current += 1;
    };
  }, [key, ms, reload]);

  const set = useCallback((next: T) => {
    latest.current += 1;
    setData(next);
  }, []);
  return { data, error, loading, reload, set };
}
