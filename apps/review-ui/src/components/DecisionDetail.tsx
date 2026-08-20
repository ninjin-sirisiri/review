import { useEffect, useState } from "react";
import type { DecisionRecordDetail, UserDisposition } from "../api";
import { SourceReference } from "./SourceReference";

interface DecisionDetailProps {
  detail: DecisionRecordDetail;
  onDispositionChange?: (disposition: UserDisposition) => Promise<DecisionRecordDetail | void>;
}

const dispositionOptions: Array<{ value: UserDisposition; label: string }> = [
  { value: "accepted", label: "Accept" },
  { value: "rejected", label: "Reject" },
  { value: "unreviewed", label: "Mark unreviewed" },
];

function checkStatusLabel(status: "passed" | "failed" | "not-run"): string {
  if (status === "passed") return "Passed";
  if (status === "failed") return "Failed";
  return "Not run";
}

export function DecisionDetail({ detail, onDispositionChange }: DecisionDetailProps) {
  const [displayedRecord, setDisplayedRecord] = useState(detail.record);
  const [isUpdating, setIsUpdating] = useState(false);
  const [mutationError, setMutationError] = useState<string | null>(null);

  useEffect(() => {
    setDisplayedRecord(detail.record);
    setMutationError(null);
  }, [detail.record]);

  async function changeDisposition(disposition: UserDisposition) {
    if (onDispositionChange === undefined || isUpdating) return;
    setIsUpdating(true);
    setMutationError(null);
    try {
      const updatedDetail = await onDispositionChange(disposition);
      if (updatedDetail !== undefined) setDisplayedRecord(updatedDetail.record);
    } catch (error) {
      setMutationError(error instanceof Error ? error.message : "Unable to update the disposition");
    } finally {
      setIsUpdating(false);
    }
  }

  return (
    <article className="decision-detail" aria-labelledby={`decision-${displayedRecord.record_id}`}>
      <header className="decision-detail__header">
        <div>
          <p className="eyebrow">Decision {displayedRecord.record_id}</p>
          <h2 id={`decision-${displayedRecord.record_id}`}>{displayedRecord.judgment}</h2>
          <p className="decision-detail__meta">
            {displayedRecord.agent_type} · {new Date(displayedRecord.created_at).toLocaleString()} · revision {revisionText(displayedRecord.revision)}
          </p>
        </div>
        <fieldset className="disposition-controls" disabled={isUpdating || onDispositionChange === undefined}>
          <legend>Disposition</legend>
          {dispositionOptions.map((option) => (
            <button
              key={option.value}
              type="button"
              aria-pressed={displayedRecord.user_disposition === option.value}
              onClick={() => void changeDisposition(option.value)}
            >
              {option.label}
            </button>
          ))}
        </fieldset>
      </header>
      {isUpdating && <p role="status">Saving disposition…</p>}
      {mutationError !== null && <p className="inline-error" role="alert">{mutationError}</p>}

      <div className="decision-detail__grid">
        <section aria-labelledby="target-heading">
          <h3 id="target-heading">Target</h3>
          <ul className="target-list">
            {displayedRecord.targets.map((target) => (
              <li key={`${target.path}-${target.line_start}-${target.line_end}`}>
                <code>{target.path}:{target.line_start}–{target.line_end}</code>
                <span>expected hash <code>{target.content_hash}</code></span>
              </li>
            ))}
          </ul>
        </section>
        <section aria-labelledby="rationale-heading">
          <h3 id="rationale-heading">Rationale</h3>
          <p className="preserve-text">{displayedRecord.rationale}</p>
        </section>
      </div>

      <section aria-labelledby="checks-heading">
        <h3 id="checks-heading">Checks</h3>
        {displayedRecord.checks.length === 0 ? (
          <p className="muted">No checks were recorded.</p>
        ) : (
          <ul className="check-list">
            {displayedRecord.checks.map((check) => (
              <li key={check.name}>
                <span className={`check-status check-status--${check.status}`}>{checkStatusLabel(check.status)}</span>
                <strong>{check.name}</strong>
                {check.details !== undefined && <span>{check.details}</span>}
              </li>
            ))}
          </ul>
        )}
      </section>

      <section aria-labelledby="questions-heading">
        <h3 id="questions-heading">Open questions</h3>
        {displayedRecord.open_questions.length === 0 ? (
          <p className="muted">No open questions.</p>
        ) : (
          <ul>
            {displayedRecord.open_questions.map((question) => <li key={question}>{question}</li>)}
          </ul>
        )}
      </section>

      <section aria-labelledby="sources-heading">
        <h3 id="sources-heading">Linked source</h3>
        <div className="source-stack">
          {detail.sources.length === 0 ? (
            <p className="muted">No source references were returned for this decision.</p>
          ) : detail.sources.map((source) => <SourceReference key={`${source.path}-${source.target.line_start}`} source={source} />)}
        </div>
      </section>
    </article>
  );
}

function revisionText(revision: DecisionRecordDetail["record"]["revision"]): string {
  return revision.kind === "commit" ? revision.sha : revision.contentHash;
}
