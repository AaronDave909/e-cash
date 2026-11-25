import { useCallback, useEffect, useRef, useState } from "react";

export interface Poll<T> {
  data: T | null;
  error: string | null;
  refresh: () => void;
}

/** Calls `fn` now and every `ms`, skipping a tick while the previous call is in flight. */
export function usePoll<T>(fn: () => Promise<T>, ms: number, enabled = true): Poll<T> {
  const [data, setData] = useState<T | null>(null);
  const [error, setError] = useState<string | null>(null);
  const fnRef = useRef(fn);
  fnRef.current = fn;
  const inflight = useRef(false);
  const alive = useRef(true);

  const tick = useCallback(async () => {
    if (inflight.current) return;
    inflight.current = true;
    try {
      const v = await fnRef.current();
      if (alive.current) {
        setData(v);
        setError(null);
      }
    } catch (e) {
      if (alive.current) setError(e instanceof Error ? e.message : String(e));
    } finally {
      inflight.current = false;
    }
  }, []);

  useEffect(() => {
    alive.current = true;
    if (!enabled) return () => void (alive.current = false);
    void tick();
    const id = setInterval(() => void tick(), ms);
    return () => {
      alive.current = false;
      clearInterval(id);
    };
  }, [ms, enabled, tick]);

  return { data, error, refresh: () => void tick() };
}
