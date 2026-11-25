import { getJournals } from "../api";
import { formatPhp, shortId, timeOf } from "../format";
import { usePoll } from "../hooks";

export function JournalList({ ms, limit = 8 }: { ms: number; limit?: number }) {
  const { data, error } = usePoll(getJournals, ms);
  if (error && !data) return <p className="muted">Journals unavailable: {error}</p>;
  if (!data) return <p className="muted">Loading journals...</p>;
  if (data.length === 0) return <p className="muted">No journals posted yet.</p>;
  return (
    <ul className="journals">
      {data.slice(0, limit).map((j) => (
        <li key={j.id} className="journal">
          <div className="journal-head">
            <code>{shortId(j.id)}</code>
            <span className="muted">{j.kind}</span>
            <span className="muted">{timeOf(j.createdAt)}</span>
          </div>
          {j.postings.map((p, i) => (
            <div key={i} className="posting">
              <span className={`dir dir-${p.direction.toLowerCase()}`}>{p.direction}</span>
              <code className="acct">{p.account}</code>
              <span className="amt">{formatPhp(p.amountCentavos)}</span>
            </div>
          ))}
        </li>
      ))}
    </ul>
  );
}
