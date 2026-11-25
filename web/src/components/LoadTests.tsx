import { useState } from "react";
import { ApiError, getSimUsers, getTransfer, sendP2p, type Persona, type Transfer } from "../api";
import { formatPhp, newIdempotencyKey } from "../format";
import { useSession } from "../session";
import { errText } from "./useAction";
import { Notice } from "./ui";

const BURST_SIZE = 30;
const pick = <T,>(xs: T[]): T => xs[Math.floor(Math.random() * xs.length)]!;

interface Tally {
  success: number;
  failed: number;
  limited: number;
  ms: number;
}

export function BurstTest() {
  const { state, callAs } = useSession();
  const personas = Object.values(state.personas);
  const [busy, setBusy] = useState(false);
  const [tally, setTally] = useState<Tally | null>(null);

  async function fire() {
    setBusy(true);
    const t0 = performance.now();
    const jobs = Array.from({ length: BURST_SIZE }, () => {
      const from = pick(personas);
      const to = pick(personas.filter((p) => p.userId !== from.userId));
      const amount = 100 + Math.floor(Math.random() * 5) * 100;
      return callAs(from.userId, (tok) => sendP2p(tok, newIdempotencyKey(), to.mobile, amount, "burst"));
    });
    const results = await Promise.allSettled(jobs);
    const t: Tally = { success: 0, failed: 0, limited: 0, ms: Math.round(performance.now() - t0) };
    for (const r of results) {
      if (r.status === "fulfilled") r.value.status === "FAILED" ? t.failed++ : t.success++;
      else if (r.reason instanceof ApiError && r.reason.status === 429) t.limited++;
      else t.failed++;
    }
    setTally(t);
    setBusy(false);
  }

  return (
    <div className="stack">
      <p className="muted small">Fires {BURST_SIZE} concurrent Express Sends of 1 to 5 pesos across random pairs of your personas. Fund them first.</p>
      <button className="btn" disabled={busy || personas.length < 2} onClick={() => void fire()}>
        {busy ? "Firing..." : "Burst P2P traffic"}
      </button>
      {personas.length < 2 && <p className="muted small">Needs at least two personas.</p>}
      {tally && (
        <p className="tally">
          <span className="ok">{tally.success} ok</span> / <span className="err">{tally.failed} failed</span> /{" "}
          <span className="warn">{tally.limited} x 429</span> <span className="muted">in {tally.ms} ms</span>
        </p>
      )}
    </div>
  );
}

interface RaceResult {
  pass: boolean;
  lines: string[];
}

/** A send "wins" when the final transfer status is COMPLETED. PENDING results are polled for up to 6 s. */
async function settle(callAs: <T>(id: string, fn: (t: string) => Promise<T>) => Promise<T>, p: Persona, first: Transfer): Promise<Transfer> {
  let t = first;
  for (let i = 0; i < 12 && t.status === "PENDING"; i++) {
    await new Promise((r) => setTimeout(r, 500));
    t = await callAs(p.userId, (tok) => getTransfer(tok, first.id));
  }
  return t;
}

export function RaceTest() {
  const { active, state, callAs } = useSession();
  const [busy, setBusy] = useState(false);
  const [result, setResult] = useState<RaceResult | null>(null);
  const [err, setErr] = useState<string | null>(null);

  async function run() {
    if (!active) return;
    const other = Object.values(state.personas).find((p) => p.userId !== active.userId);
    if (!other) {
      setErr("Needs a second persona as recipient.");
      return;
    }
    setBusy(true);
    setErr(null);
    setResult(null);
    try {
      const me = (await getSimUsers()).find((u) => u.id === active.userId);
      if (!me) throw new Error("Active persona not found in /sim/users");
      const amount = Math.floor(me.balanceCentavos * 0.6);
      if (amount < 100) throw new Error(`Balance ${formatPhp(me.balanceCentavos)} is too low. Cash in first.`);
      const send = () =>
        callAs(active.userId, (tok) => sendP2p(tok, newIdempotencyKey(), other.mobile, amount, "race")).then((t) => settle(callAs, active, t));
      const [a, b] = await Promise.allSettled([send(), send()]);
      const wins = [a, b].filter((r) => r.status === "fulfilled" && r.value.status === "COMPLETED").length;
      const lines = [a, b].map((r, i) =>
        r.status === "fulfilled" ? `Send ${i + 1}: ${r.value.status}${r.value.failureReason ? ` (${r.value.failureReason})` : ""}` : `Send ${i + 1}: ${errText(r.reason)}`,
      );
      setResult({ pass: wins === 1, lines: [`Balance ${formatPhp(me.balanceCentavos)}, two sends of ${formatPhp(amount)} to ${other.displayName}.`, ...lines, `${wins} succeeded.`] });
    } catch (e) {
      setErr(errText(e));
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="stack">
      <p className="muted small">Two simultaneous sends of 60% of the active balance, different keys. Exactly one must succeed.</p>
      <button className="btn" disabled={busy || !active} onClick={() => void run()}>
        {busy ? "Racing..." : "Double-spend race test"}
      </button>
      {err && <Notice ok={false}>{err}</Notice>}
      {result && (
        <div>
          <span className={`verdict ${result.pass ? "verdict-pass" : "verdict-fail"}`}>{result.pass ? "PASS" : "FAIL"}</span>
          {result.lines.map((l, i) => (
            <p key={i} className="small">
              {l}
            </p>
          ))}
        </div>
      )}
    </div>
  );
}
