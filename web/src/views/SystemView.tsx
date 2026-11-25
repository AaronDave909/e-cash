import { getHealth, getReconcile } from "../api";
import { JournalList } from "../components/Journals";
import { Panel } from "../components/ui";
import { formatPhp } from "../format";
import { usePoll } from "../hooks";

function Health() {
  const { data, error } = usePoll(getHealth, 2000);
  if (!data) return <p className="muted">{error ? `Health unavailable: ${error}` : "Checking..."}</p>;
  return (
    <div className="services">
      {data.map((s) => (
        <div key={s.name} className={`service ${s.up ? "up" : "down"}`}>
          <span className="dot" aria-hidden />
          <strong>{s.name}</strong>
          <span className="small">{s.up ? "up" : "down"}</span>
          <span className="muted small">{s.latencyMs === null ? "-" : `${Math.round(s.latencyMs)} ms`}</span>
        </div>
      ))}
    </div>
  );
}

function ReconcileBadge() {
  const { data, error } = usePoll(getReconcile, 2000);
  if (!data) return <p className="muted">{error ? `Reconcile unavailable: ${error}` : "Reconciling..."}</p>;
  return (
    <div className="stack">
      <span className={`recon ${data.balanced ? "recon-ok" : "recon-bad"}`}>{data.balanced ? "BALANCED" : "IMBALANCE_DETECTED"}</span>
      <dl className="kv">
        <dt>Total debits</dt>
        <dd>{formatPhp(data.totalDebits)}</dd>
        <dt>Total credits</dt>
        <dd>{formatPhp(data.totalCredits)}</dd>
        <dt>Unbalanced journals</dt>
        <dd>{data.unbalancedJournals}</dd>
        <dt>Negative wallets</dt>
        <dd>{data.negativeWallets}</dd>
      </dl>
    </div>
  );
}

export function SystemView() {
  return (
    <div className="grid">
      <Panel title="Services">
        <Health />
      </Panel>
      <Panel title="Ledger reconciliation">
        <ReconcileBadge />
      </Panel>
      <Panel title="Recent journals">
        <JournalList ms={2000} limit={15} />
      </Panel>
    </div>
  );
}
