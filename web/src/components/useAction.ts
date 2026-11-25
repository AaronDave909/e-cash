import { useRef, useState } from "react";
import { ApiError } from "../api";
import { keepsIdempotencyKey, newIdempotencyKey } from "../format";
import { useSession } from "../session";

export interface Outcome {
  ok: boolean;
  text: string;
}

export const errText = (e: unknown): string =>
  e instanceof ApiError ? `${e.code} (${e.status || "network"}): ${e.message}` : e instanceof Error ? e.message : String(e);

/**
 * Runs one user action as the active persona. The Idempotency-Key is minted once per
 * distinct action (`fingerprint`), kept after a failure the server may not have decided
 * (network error, 429, 5xx) so a manual retry reuses it, and dropped after a success or
 * any other 4xx.
 */
export function useAction() {
  const { active, callAs } = useSession();
  const keyRef = useRef<{ fp: string; key: string } | null>(null);
  const [busy, setBusy] = useState(false);
  const [outcome, setOutcome] = useState<Outcome | null>(null);

  async function run<T>(fingerprint: string, fn: (token: string, key: string) => Promise<T>, describe: (r: T) => string): Promise<T | undefined> {
    if (!active) return undefined;
    const fp = `${active.userId}|${fingerprint}`;
    if (keyRef.current?.fp !== fp) keyRef.current = { fp, key: newIdempotencyKey() };
    const key = keyRef.current.key;
    setBusy(true);
    try {
      const r = await callAs(active.userId, (t) => fn(t, key));
      keyRef.current = null;
      setOutcome({ ok: true, text: describe(r) });
      return r;
    } catch (e) {
      // A non-ApiError never got an HTTP answer, so treat it like a network error.
      const keep = keepsIdempotencyKey(e instanceof ApiError ? e.status : 0);
      if (!keep) keyRef.current = null;
      setOutcome({
        ok: false,
        text: `${errText(e)}. ${keep ? "Retrying the same action reuses its Idempotency-Key." : "A retry sends a new Idempotency-Key."}`,
      });
      return undefined;
    } finally {
      setBusy(false);
    }
  }
  return { run, busy, outcome, active };
}
