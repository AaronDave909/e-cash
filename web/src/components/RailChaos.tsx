import { useState } from "react";
import { getChaos, putChaos, type Chaos } from "../api";
import { usePoll } from "../hooks";
import { errText } from "./useAction";
import { Notice } from "./ui";

const DEGRADED_LATENCY = 3000;
const DEGRADED_FAILURE = 0.5;

export function RailChaos() {
  const { data, error, refresh } = usePoll(getChaos, 3000);
  const [err, setErr] = useState<string | null>(null);

  async function apply(next: Chaos) {
    try {
      await putChaos(next);
      setErr(null);
      refresh();
    } catch (e) {
      setErr(errText(e));
    }
  }

  if (!data) return <p className="muted">{error ? `Chaos unavailable: ${error}` : "Loading..."}</p>;
  return (
    <div className="stack">
      <label className="check">
        <input
          type="checkbox"
          checked={data.latencyMs >= DEGRADED_LATENCY}
          onChange={(e) => void apply({ ...data, latencyMs: e.target.checked ? DEGRADED_LATENCY : 0 })}
        />
        3000 ms latency
      </label>
      <label className="check">
        <input
          type="checkbox"
          checked={data.failureRate >= DEGRADED_FAILURE}
          onChange={(e) => void apply({ ...data, failureRate: e.target.checked ? DEGRADED_FAILURE : 0 })}
        />
        50% failure rate
      </label>
      <p className="muted small">
        Now: {data.latencyMs} ms latency, {Math.round(data.failureRate * 100)}% failures.
      </p>
      <button className="btn btn-ghost" onClick={() => void apply({ latencyMs: 0, failureRate: 0 })}>
        Reset
      </button>
      {err && <Notice ok={false}>{err}</Notice>}
    </div>
  );
}
