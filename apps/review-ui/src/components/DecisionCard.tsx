import { useEffect, useState } from "react";
import type { DecisionRecordDetail, SourceReferenceData, UserDisposition } from "../api";

interface DecisionCardProps {
  detail: DecisionRecordDetail;
  onDispositionChange?: (disposition: UserDisposition) => Promise<DecisionRecordDetail | void>;
  onTargetClick?: (path: string, line: number) => void;
}

const dispositionOptions: Array<{ value: UserDisposition; label: string }> = [
  { value: "accepted", label: "Accept" },
  { value: "rejected", label: "Reject" },
  { value: "unreviewed", label: "Mark unreviewed" },
];

const unresolvedStateCopy = {
  "hash-mismatch": {
    title: "Source changed since the decision",
    description: "The current source hash does not match the source that was reviewed.",
  },
  "revision-not-found": {
    title: "The recorded revision is no longer available",
    description: "The decision points to a revision that Recorder cannot find.",
  },
  "source-unavailable": {
    title: "Source is unavailable",
    description: "Recorder could not read the recorded source.",
  },
} as const;

function unresolvedSources(detail: DecisionRecordDetail): SourceReferenceData[] {
  return detail.sources.filter((source) => source.state !== "resolved" && source.state !== "snapshot-resolved");
}

function checkStatusLabel(status: "passed" | "failed" | "not-run"): string {
  if (status === "passed") return "Passed";
  if (status === "failed") return "Failed";
  return "Not run";
}

export function DecisionCard({ detail, onDispositionChange, onTargetClick }: DecisionCardProps) {
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

  const warnings = unresolvedSources(detail);

  return (
    <article className="decision-card" aria-labelledby={`decision-${displayedRecord.record_id}`}>
      <header className="decision-card__header">
        <div>
          <p className="eyebrow">Decision {displayedRecord.record_id}</p>
          <h3 id={`decision-${displayedRecord.record_id}`}>{displayedRecord.judgment}</h3>
          <p className="decision-card__meta">
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

      {warnings.length > 0 && (
        <div className="decision-card__warnings">
          {warnings.map((source) => {
            const copy = unresolvedStateCopy[source.state];
            return (
              <div key={`${source.path}-${source.target.line_start}`} className="source-warning" role="alert">
                <h4>{copy.title}</h4>
                <p>{copy.description}</p>
                {source.message !== undefined && <p>{source.message}</p>}
                <dl className="source-metadata">
                  <div>
                    <dt>Expected hash</dt>
                    <dd><code>{source.expected_hash}</code></dd>
                  </div>
                  {source.actual_hash !== undefined && (
                    <div>
                      <dt>Actual hash</dt>
                      <dd><code>{source.actual_hash}</code></dd>
                    </div>
                  )}
                </dl>
                <p className="source-safety-note">Current code is intentionally not shown until this reference is resolved.</p>
              </div>
            );
          })}
        </div>
      )}

      <p className="preserve-text">{displayedRecord.rationale}</p>

      <section aria-labelledby={`checks-${displayedRecord.record_id}`}>
        <h4 id={`checks-${displayedRecord.record_id}`}>Checks</h4>
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

      <section aria-labelledby={`questions-${displayedRecord.record_id}`}>
        <h4 id={`questions-${displayedRecord.record_id}`}>Open questions</h4>
        {displayedRecord.open_questions.length === 0 ? (
          <p className="muted">No open questions.</p>
        ) : (
          <ul>
            {displayedRecord.open_questions.map((question) => <li key={question}>{question}</li>)}
          </ul>
        )}
      </section>

      <footer className="decision-card__targets">
        <h4>Targets</h4>
        {displayedRecord.targets.map((target) => (
          <button
            key={`${target.path}-${target.line_start}`}
            type="button"
            className="target-link"
            onClick={() => onTargetClick?.(target.path, target.line_start)}
          >
            <code>{target.path}:{target.line_start}–{target.line_end}</code>
          </button>
        ))}
      </footer>
    </article>
  );
}

function revisionText(revision: DecisionRecordDetail["record"]["revision"]): string {
  return revision.kind === "commit" ? revision.sha : revision.contentHash;
}
