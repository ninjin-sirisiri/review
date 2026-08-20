import type { DecisionRecordSummary } from "../api";

interface DecisionListProps {
  decisions: DecisionRecordSummary[];
  selectedRecordId?: string;
  onSelect: (recordId: string) => void;
  isLoading?: boolean;
}

function dispositionLabel(disposition: DecisionRecordSummary["user_disposition"]): string {
  if (disposition === "accepted") return "Accepted";
  if (disposition === "rejected") return "Rejected";
  return "Unreviewed";
}

export function DecisionList({ decisions, selectedRecordId, onSelect, isLoading = false }: DecisionListProps) {
  return (
    <section className="decision-list" aria-labelledby="timeline-heading">
      <div className="section-heading">
        <h2 id="timeline-heading">Review timeline</h2>
        <span>{decisions.length} {decisions.length === 1 ? "decision" : "decisions"}</span>
      </div>
      {isLoading && <p role="status">Loading decisions…</p>}
      {!isLoading && decisions.length === 0 && <p className="empty-state">No decisions have been recorded for this repository.</p>}
      <ol>
        {decisions.map((decision) => (
          <li key={decision.record_id}>
            <button
              type="button"
              className={`decision-list-item${selectedRecordId === decision.record_id ? " decision-list-item--selected" : ""}`}
              aria-current={selectedRecordId === decision.record_id ? "true" : undefined}
              onClick={() => onSelect(decision.record_id)}
            >
              <span className="decision-list-item__time">{new Date(decision.created_at).toLocaleString()}</span>
              <strong>{decision.judgment}</strong>
              <span className="decision-list-item__meta">
                {decision.agent_type} · {dispositionLabel(decision.user_disposition)}
              </span>
            </button>
          </li>
        ))}
      </ol>
    </section>
  );
}
