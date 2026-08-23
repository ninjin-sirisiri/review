import type { BlockSelection, DecisionAnchor } from "../lib/decision-index";
import { decisionAnchors, overlapsBlock } from "../lib/decision-index";
import type { DecisionRecordDetail, UserDisposition } from "../api";
import { DecisionCard } from "./DecisionCard";

export interface JudgmentEntry {
  recordId: string;
  status: "loading" | "ready" | "error";
  detail?: DecisionRecordDetail;
  message?: string;
}

interface JudgmentPanelProps {
  path: string | null;
  entries: JudgmentEntry[];
  selectedBlock: BlockSelection | null;
  onSelectBlock: (block: BlockSelection | null) => void;
  onDispositionChange: (recordId: string, disposition: UserDisposition) => Promise<DecisionRecordDetail>;
  onRetry: (recordId: string) => void;
  onTargetClick: (path: string, line: number) => void;
}

function matchesSelectedBlock(detail: DecisionRecordDetail, selectedBlock: BlockSelection): boolean {
  return decisionAnchors(detail).some((anchor: DecisionAnchor) => overlapsBlock(anchor, selectedBlock));
}

export function JudgmentPanel({
  path,
  entries,
  selectedBlock,
  onSelectBlock,
  onDispositionChange,
  onRetry,
  onTargetClick,
}: JudgmentPanelProps) {
  if (path === null) {
    return (
      <section className="judgment-panel" aria-label="Judgments">
        <p className="empty-state">Select a file in the explorer to review its judgments.</p>
      </section>
    );
  }

  const visibleEntries = selectedBlock === null
    ? entries
    : entries.filter((entry) =>
        entry.status === "ready" && entry.detail !== undefined && matchesSelectedBlock(entry.detail, selectedBlock),
      );

  return (
    <section className="judgment-panel" aria-label="Judgments">
      <div className="section-heading">
        <h2>Judgments</h2>
        <span>
          {visibleEntries.length} of {entries.length}
          {selectedBlock !== null && (
            <button type="button" className="button-secondary" onClick={() => onSelectBlock(null)}>
              Clear block filter
            </button>
          )}
        </span>
      </div>

      <div className="judgment-stack">
        {visibleEntries.map((entry) => {
          if (entry.status === "loading") {
            return <p key={entry.recordId} role="status">Loading decision…</p>;
          }
          if (entry.status === "error") {
            return (
              <div key={entry.recordId} className="inline-error" role="alert">
                <p>{entry.message ?? "Unable to load this decision."}</p>
                <button type="button" onClick={() => onRetry(entry.recordId)}>Retry {entry.recordId}</button>
              </div>
            );
          }
          return (
            <DecisionCard
              key={entry.recordId}
              detail={entry.detail!}
              onDispositionChange={(disposition) => onDispositionChange(entry.recordId, disposition)}
              onTargetClick={onTargetClick}
            />
          );
        })}
        {entries.length > 0 && visibleEntries.length === 0 && (
          <p className="empty-state">No judgments overlap the selected lines.</p>
        )}
        {entries.length === 0 && (
          <p className="empty-state">No decisions have been recorded for this file.</p>
        )}
      </div>
    </section>
  );
}
