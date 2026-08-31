import type { BlockSelection, DecisionAnchor } from "../lib/decision-index";
import { decisionAnchors, overlapsBlock, transitionAnchors } from "../lib/decision-index";
import type { DecisionRecordDetail, UserDisposition } from "../api";
import { DecisionCard } from "./DecisionCard";

export type JudgmentEntry =
  | { recordId: string; status: "loading" }
  | { recordId: string; status: "ready"; detail: DecisionRecordDetail }
  | { recordId: string; status: "error"; message?: string };

interface JudgmentPanelProps {
  path: string | null;
  entries: JudgmentEntry[];
  transitionActive: boolean;
  selectedRecordId: string | null;
  onSelectJudgment: (recordId: string) => void;
  selectedBlock: BlockSelection | null;
  onSelectBlock: (block: BlockSelection | null) => void;
  onDispositionChange: (recordId: string, disposition: UserDisposition) => Promise<DecisionRecordDetail>;
  onRetry: (recordId: string) => void;
  onTargetClick: (path: string, line: number) => void;
}

function matchesSelectedBlock(
  detail: DecisionRecordDetail,
  path: string,
  transitionActive: boolean,
  selectedBlock: BlockSelection,
): boolean {
  const anchors: DecisionAnchor[] = transitionActive
    ? transitionAnchors(detail, path)
    : decisionAnchors({ ...detail, sources: detail.sources.filter((source) => source.path === path) });
  return anchors.some((anchor) => overlapsBlock(anchor, selectedBlock));
}

export function JudgmentPanel({
  path,
  entries,
  transitionActive,
  selectedRecordId,
  onSelectJudgment,
  selectedBlock,
  onSelectBlock,
  onDispositionChange,
  onRetry,
  onTargetClick,
}: JudgmentPanelProps) {
  const isLoading = entries.some((entry) => entry.status === "loading");

  if (path === null) {
    return (
      <section className="judgment-panel" aria-label="Judgments">
        <header className="pane-header">
          <div className="section-heading">
            <h2>Judgments</h2>
          </div>
        </header>
        <div className="pane-body">
          <p className="empty-state">Select a file in the explorer to review its judgments.</p>
        </div>
      </section>
    );
  }

  const visibleEntries = selectedBlock === null
    ? entries
    : entries.filter((entry) =>
        entry.status === "ready" && matchesSelectedBlock(entry.detail, path, transitionActive, selectedBlock),
      );

  return (
    <section className="judgment-panel" aria-label="Judgments" aria-busy={isLoading || undefined}>
      <header className="pane-header">
        <div className="section-heading">
          <h2>Judgments</h2>
          <span>
            {visibleEntries.length} of {entries.length}
          </span>
        </div>
        {selectedBlock !== null && (
          <div className="filter-banner">
            <p>Filtered to the selected lines</p>
            <button type="button" className="button-secondary" onClick={() => onSelectBlock(null)}>
              Clear block filter
            </button>
          </div>
        )}
      </header>

      <div className="pane-body">
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
                detail={entry.detail}
                selected={selectedRecordId === entry.recordId}
                onSelect={() => onSelectJudgment(entry.recordId)}
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
      </div>
    </section>
  );
}
