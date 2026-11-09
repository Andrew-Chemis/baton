import { useCallback, useEffect, useRef, useState } from 'preact/hooks';
import { messageOf } from './api.ts';
import { notify } from './toast.tsx';

export interface Loaded<T> {
  data: T | undefined;
  error: string | undefined;
  reload: () => Promise<void>;
}

/**
 * Loads on mount and whenever `key` changes, then every `ms` while the page is visible. A tick is skipped while the last
 * request is still out. An answer identical to the one on screen leaves `data` as it is, so what is derived from it is not
 * worked out again; the page still renders, so the relative times on it keep moving.
 */
export function usePoll<T>(load: () => Promise<T>, key: string, ms = 15_000): Loaded<T> {
  const [data, setData] = useState<T | undefined>();
  const [error, setError] = useState<string | undefined>();
  const [, setUnchanged] = useState(0);
  const latest = useRef(0);
  const shown = useRef<string | undefined>(undefined);
  const inFlight = useRef(false);
  const loader = useRef(load);
  loader.current = load;

  const reload = useCallback(async () => {
    const ticket = ++latest.current;
    inFlight.current = true;
    try {
      const next = await loader.current();
      if (ticket !== latest.current) return;
      const json = JSON.stringify(next);
      if (json === shown.current) {
        setUnchanged((n) => n + 1);
      } else {
        shown.current = json;
        setData(next);
      }
      setError(undefined);
    } catch (caught) {
      if (ticket === latest.current) setError(caught instanceof Error ? caught.message : String(caught));
    } finally {
      if (ticket === latest.current) inFlight.current = false;
    }
  }, []);

  useEffect(() => {
    void reload();
    const timer = setInterval(() => {
      if (!document.hidden && !inFlight.current) void reload();
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

  return { data, error, reload };
}

/** For a click or a submit: busy while `run` works, and a toast in the board's own words when it fails. */
export function useAction(): { busy: boolean; run: (fn: () => Promise<unknown>) => Promise<void> } {
  const [busy, setBusy] = useState(false);
  const run = useCallback(async (fn: () => Promise<unknown>) => {
    setBusy(true);
    try {
      await fn();
    } catch (error) {
      notify(messageOf(error));
    } finally {
      setBusy(false);
    }
  }, []);
  return { busy, run };
}
