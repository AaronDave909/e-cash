import { useState } from "react";
import { getReceipts, getSimUsers, login, unlockUser, type SimUser } from "../api";
import { formatPhp, timeOf } from "../format";
import { usePoll } from "../hooks";
import { useSession } from "../session";
import { errText } from "./useAction";
import { TierBadge } from "./ui";

function Receipts({ userId }: { userId: string }) {
  const [open, setOpen] = useState(false);
  const { data, error } = usePoll(() => getReceipts(userId), 3000, open);
  return (
    <details onToggle={(e) => setOpen(e.currentTarget.open)}>
      <summary>Receipts</summary>
      {error && !data && <p className="muted small">Unavailable: {error}</p>}
      {data && data.length === 0 && <p className="muted small">None yet.</p>}
      <ul className="receipts">
        {data?.slice(0, 6).map((r) => (
          <li key={r.id} className="small">
            <span className="badge badge-basic">{r.channel}</span> {r.body} <span className="muted">{timeOf(r.createdAt)}</span>
          </li>
        ))}
      </ul>
    </details>
  );
}

function UserCard({ u, onChange }: { u: SimUser; onChange: () => void }) {
  const { state, dispatch } = useSession();
  const local = state.personas[u.id];
  const [msg, setMsg] = useState<string | null>(null);
  const pct = u.monthLimitCentavos > 0 ? Math.min(100, (u.monthOutCentavos / u.monthLimitCentavos) * 100) : 0;

  async function wrongMpin() {
    const wrong = local?.mpin === "0000" ? "9999" : "0000";
    try {
      await login(u.mobile, wrong);
      setMsg("Login unexpectedly succeeded.");
    } catch (e) {
      setMsg(errText(e));
    }
    onChange();
  }
  async function unlock() {
    try {
      await unlockUser(u.id);
      setMsg("Unlocked.");
    } catch (e) {
      setMsg(errText(e));
    }
    onChange();
  }

  return (
    <article className={`card ${local && state.activeId === u.id ? "card-active" : ""}`}>
      <div className="card-top">
        <div>
          <strong>{u.displayName || u.mobile}</strong>
          <div className="muted small">{u.mobile}</div>
        </div>
        <TierBadge tier={u.tier} />
      </div>
      <div className="balance">{formatPhp(u.balanceCentavos)}</div>
      <div className="meter" role="img" aria-label={`Monthly usage ${Math.round(pct)}%`}>
        <div className="meter-fill" style={{ width: `${pct}%` }} />
      </div>
      <div className="muted small">
        {formatPhp(u.monthOutCentavos)} of {formatPhp(u.monthLimitCentavos)} this month
      </div>
      <div className="row wrap">
        {u.locked ? <span className="pill pill-failed">MPIN LOCKED</span> : <span className="pill pill-completed">MPIN OK{u.failedAttempts > 0 ? ` (${u.failedAttempts}/3 wrong)` : ""}</span>}
        {u.locked && (
          <button className="btn btn-sm" onClick={() => void unlock()}>
            Unlock
          </button>
        )}
        <button className="btn btn-sm btn-ghost" onClick={() => void wrongMpin()}>
          Try wrong MPIN
        </button>
        {local && state.activeId !== u.id && (
          <button className="btn btn-sm btn-ghost" onClick={() => dispatch({ type: "activate", userId: u.id })}>
            Use
          </button>
        )}
      </div>
      {msg && <p className="small muted">{msg}</p>}
      <Receipts userId={u.id} />
    </article>
  );
}

export function UserCards() {
  const { data, error, refresh } = usePoll(getSimUsers, 1500);
  if (!data) return <p className="muted">{error ? `Users unavailable: ${error}` : "Loading users..."}</p>;
  if (data.length === 0) return <p className="muted">No users yet.</p>;
  return (
    <div className="cards">
      {data.map((u) => (
        <UserCard key={u.id} u={u} onChange={refresh} />
      ))}
    </div>
  );
}
