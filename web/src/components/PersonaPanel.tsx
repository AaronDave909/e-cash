import { useState, type FormEvent } from "react";
import type { Tier } from "../api";
import { formatPhp, isMobile, normalizeMobile, parsePesos } from "../format";
import { createPersona, PRESETS, type PersonaSpec } from "../personas";
import { useSession } from "../session";
import { errText } from "./useAction";
import { Notice, TierBadge } from "./ui";

export function PersonaPanel() {
  const { state, dispatch } = useSession();
  const [busy, setBusy] = useState<string | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [balance, setBalance] = useState("");
  const [name, setName] = useState("");
  const [mobile, setMobile] = useState("+639");
  const [mpin, setMpin] = useState("1234");
  const [tier, setTier] = useState<Tier>("BASIC");

  const start = balance.trim() === "" ? undefined : parsePesos(balance);

  async function create(label: string, spec: PersonaSpec) {
    setBusy(label);
    setErr(null);
    try {
      const persona = await createPersona({ ...spec, startingBalanceCentavos: start ?? undefined });
      dispatch({ type: "upsert", persona, activate: true });
    } catch (e) {
      setErr(errText(e));
    } finally {
      setBusy(null);
    }
  }

  function submit(e: FormEvent) {
    e.preventDefault();
    const m = normalizeMobile(mobile);
    if (!name.trim() || !isMobile(m) || !/^\d{4,6}$/.test(mpin)) {
      setErr("Enter a name, a +639XXXXXXXXX mobile and a 4 to 6 digit MPIN.");
      return;
    }
    void create("custom", { displayName: name.trim(), mobile: m, mpin, tier });
  }

  const personas = Object.values(state.personas);
  return (
    <div className="stack">
      <div className="chips" role="list">
        {personas.length === 0 && <p className="muted small">No personas yet. Create one below.</p>}
        {personas.map((p) => (
          <div key={p.userId} role="listitem" className={`chip ${p.userId === state.activeId ? "chip-active" : ""}`}>
            <button className="chip-main" onClick={() => dispatch({ type: "activate", userId: p.userId })} aria-pressed={p.userId === state.activeId}>
              {p.displayName}
              <span className="muted small"> {p.mobile}</span>
            </button>
            <TierBadge tier={p.tier} />
            <button className="chip-x" aria-label={`Forget ${p.displayName}`} onClick={() => dispatch({ type: "remove", userId: p.userId })}>
              x
            </button>
          </div>
        ))}
      </div>

      <label className="field">
        <span>Starting balance (₱, optional cash-in)</span>
        <input inputMode="decimal" placeholder="e.g. 5000" value={balance} onChange={(e) => setBalance(e.target.value)} />
        {start && <span className="muted small">{formatPhp(start)} via INSTAPAY</span>}
      </label>

      <div className="presets">
        {PRESETS.map((p) => (
          <button key={p.mobile} className="btn btn-ghost" disabled={busy !== null} onClick={() => void create(p.mobile, p)}>
            {busy === p.mobile ? "Creating..." : `+ ${p.label}`}
            <span className="muted small"> {p.mobile} · {p.tier === "FULLY_VERIFIED" ? "Fully Verified" : "Basic"}</span>
          </button>
        ))}
      </div>

      <details className="custom">
        <summary>Custom persona</summary>
        <form className="stack" onSubmit={submit}>
          <label className="field">
            <span>Name</span>
            <input value={name} onChange={(e) => setName(e.target.value)} autoComplete="off" />
          </label>
          <label className="field">
            <span>Mobile</span>
            <input value={mobile} onChange={(e) => setMobile(e.target.value)} inputMode="tel" autoComplete="off" />
          </label>
          <div className="row">
            <label className="field">
              <span>MPIN</span>
              <input value={mpin} onChange={(e) => setMpin(e.target.value)} inputMode="numeric" maxLength={6} autoComplete="off" />
            </label>
            <label className="field">
              <span>Tier</span>
              <select value={tier} onChange={(e) => setTier(e.target.value as Tier)}>
                <option value="BASIC">Basic</option>
                <option value="FULLY_VERIFIED">Fully Verified</option>
              </select>
            </label>
          </div>
          <button className="btn" disabled={busy !== null}>
            {busy === "custom" ? "Creating..." : "Create persona"}
          </button>
        </form>
      </details>
      {balance.trim() !== "" && start === null && <p className="err small">Starting balance is not a valid amount.</p>}
      {err && <Notice ok={false}>{err}</Notice>}
    </div>
  );
}
