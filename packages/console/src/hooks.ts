import { useCallback, useEffect, useRef, useState } from "react";
import { callTool } from "./api.js";

export interface ToolState<T> {
  data?: T;
  error?: string;
  loading: boolean;
  refresh: () => void;
}

/**
 * Fetch-on-navigation with optional gentle polling, paused while the
 * tab is hidden (an idle console must not hammer the gateway).
 */
export function useTool<T = unknown>(
  name: string,
  input: unknown,
  options: { pollMs?: number; enabled?: boolean } = {}
): ToolState<T> {
  const { pollMs, enabled = true } = options;
  const [data, setData] = useState<T | undefined>(undefined);
  const [error, setError] = useState<string | undefined>(undefined);
  const [loading, setLoading] = useState(enabled);
  const [tick, setTick] = useState(0);
  const inputKey = JSON.stringify(input ?? {});
  const alive = useRef(true);

  useEffect(() => {
    alive.current = true;
    return () => {
      alive.current = false;
    };
  }, []);

  useEffect(() => {
    if (!enabled) return;
    let cancelled = false;
    setLoading(true);
    callTool<T>(name, JSON.parse(inputKey))
      .then(result => {
        if (cancelled || !alive.current) return;
        setData(result);
        setError(undefined);
      })
      .catch((failure: unknown) => {
        if (cancelled || !alive.current) return;
        setError(failure instanceof Error ? failure.message : String(failure));
      })
      .finally(() => {
        if (!cancelled && alive.current) setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [name, inputKey, tick, enabled]);

  useEffect(() => {
    if (!pollMs || !enabled) return;
    const interval = setInterval(() => {
      if (!document.hidden) setTick(current => current + 1);
    }, pollMs);
    return () => clearInterval(interval);
  }, [pollMs, enabled]);

  const refresh = useCallback(() => setTick(current => current + 1), []);
  return { data, error, loading, refresh };
}
