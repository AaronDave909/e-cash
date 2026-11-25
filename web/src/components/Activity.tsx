import { getActivity } from "../api";
import { formatPhp, shortId, timeOf } from "../format";
import { usePoll } from "../hooks";
import { StatusPill } from "./ui";

export function ActivityFeed() {
  const { data, error } = usePoll(getActivity, 1500);
  if (error && !data) return <p className="muted">Activity unavailable: {error}</p>;
  if (!data) return <p className="muted">Loading activity...</p>;
  if (data.length === 0) return <p className="muted">No transfers yet. Send something.</p>;
  return (
    <ul className="feed">
      {data.slice(0, 15).map((t) => (
        <li key={t.id} className="feed-item">
          <div className="feed-top">
            <span className="type">{t.type}</span>
            <strong>{formatPhp(t.amountCentavos)}</strong>
            <StatusPill status={t.status} />
          </div>
          <div className="muted small">
            <code>{shortId(t.id)}</code> {t.counterparty && <>to/from {t.counterparty} </>}
            {t.failureReason && <span className="err">({t.failureReason})</span>}
          </div>
          {t.history.length > 0 && (
            <ol className="timeline">
              {t.history.map((h, i) => (
                <li key={i} className={`step step-${h.to.toLowerCase()}`} title={h.reason}>
                  {h.to}
                  <span className="muted small"> {timeOf(h.at)}</span>
                </li>
              ))}
            </ol>
          )}
        </li>
      ))}
    </ul>
  );
}
