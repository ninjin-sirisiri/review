import { useEffect, useRef, type ReactNode } from "react";
import type { DiffHunk, DiffLine, FileDiff, SnapshotDiff } from "../../../../packages/contracts/src/index";
import { ReviewApiError } from "../api";
import type { BlockSelection, DecisionAnchor } from "../lib/decision-index";

export interface DiffViewProps {
  path: string | null;
  isLoading: boolean;
  error: ReviewApiError | Error | null;
  /** spec §4.3-3: diff baseが解決不能(未誕生HEAD)。errorではなく空状態/全文表示へ分岐する。 */
  baseMissing: boolean;
  diff: FileDiff | null;
  anchors: DecisionAnchor[];
  transitionAnchors?: DecisionAnchor[];
  selectedBlock: BlockSelection | null;
  onSelectBlock: (block: BlockSelection | null) => void;
  fullText: { content: string; anchors: DecisionAnchor[] } | null;
  /** カードからの逆ナビゲーション(§6.2.4)。tokenが変わるたびに再スクロールする。 */
  navigateTo: { line: number; token: number } | null;
  onRetry: () => void;
  snapshotDiff?: SnapshotDiff | null;
  snapshotDiffLoading?: boolean;
  snapshotDiffError?: ReviewApiError | Error | null;
}

function lineAnchored(row: DiffLine, anchors: DecisionAnchor[]): boolean {
  return anchors.some((anchor) =>
    anchor.side === "old"
      ? row.oldLine !== null && anchor.start <= row.oldLine && row.oldLine <= anchor.end
      : row.newLine !== null && anchor.start <= row.newLine && row.newLine <= anchor.end,
  );
}

function transitionDestinationLabel(to: SnapshotDiff["to"]): string {
  if (to.kind === "working-tree") return "after: working tree";
  const sha = to.base_sha === undefined ? "" : ` @${to.base_sha.slice(0, 8)}`;
  return `next snapshot${sha} · ${new Date(to.created_at).toLocaleString()}`;
}

/** クリック行を含むmaximal run(§6.2.3)。context行ならnull。 */
function blockRun(rows: DiffLine[], index: number): BlockSelection | null {
  const kind = rows[index].type;
  if (kind === "context") return null;
  let start = index;
  while (start > 0 && rows[start - 1].type === kind) start -= 1;
  let end = index;
  while (end < rows.length - 1 && rows[end + 1].type === kind) end += 1;
  const run = rows.slice(start, end + 1);
  const dels = run.filter((row) => row.type === "del");
  const adds = run.filter((row) => row.type === "add");
  return {
    oldStart: dels.length > 0 ? dels[0].oldLine : null,
    oldEnd: dels.length > 0 ? dels[dels.length - 1].oldLine : null,
    newStart: adds.length > 0 ? adds[0].newLine : null,
    newEnd: adds.length > 0 ? adds[adds.length - 1].newLine : null,
  };
}

function sameBlock(a: BlockSelection | null, b: BlockSelection | null): boolean {
  if (a === null || b === null) return false;
  return (
    a.oldStart === b.oldStart &&
    a.oldEnd === b.oldEnd &&
    a.newStart === b.newStart &&
    a.newEnd === b.newEnd
  );
}

function errorCardMessage(error: ReviewApiError | Error): string {
  if (!(error instanceof ReviewApiError)) return error.message;
  if (error.code === "REVISION_NOT_FOUND") return "The recorded revision could not be found.";
  if (error.code === "PAYLOAD_TOO_LARGE") return "Source exceeds the size limit.";
  return error.message;
}

/** 新側行番号付きの全文表示。hunkが空のときと、diff baseが存在しないとき(spec §4.3-3)に使う。 */
function FullTextLines(props: { content: string; anchors: DecisionAnchor[] }) {
  const contents = props.content.split("\n");
  return (
    <ol className="diff-lines">
      {contents.map((content, index) => {
        const lineNumber = index + 1;
        const anchored = props.anchors.some(
          (anchor) => anchor.start <= lineNumber && lineNumber <= anchor.end,
        );
        return (
          <li
            key={lineNumber}
            className={`diff-line diff-line--context${anchored ? " diff-line--anchored" : ""}`}
            data-new-line={lineNumber}
          >
            <span className="diff-line__static" aria-hidden="true">
              <span className="line-number">{lineNumber}</span>
              <span className="line-sign">{" "}</span>
              <code>{content}</code>
            </span>
          </li>
        );
      })}
    </ol>
  );
}

function LineRow(props: {
  row: DiffLine;
  anchored: boolean;
  selected: boolean;
  onSelect: () => void;
}) {
  const { row, anchored, selected, onSelect } = props;
  const tone =
    row.type === "add" ? "diff-line--add" : row.type === "del" ? "diff-line--del" : "diff-line--context";
  const operation = row.type === "add" ? "Added" : row.type === "del" ? "Deleted" : "Context";
  const lineNumbers = [
    row.oldLine === null ? null : `old line ${row.oldLine}`,
    row.newLine === null ? null : `new line ${row.newLine}`,
  ]
    .filter((lineNumber): lineNumber is string => lineNumber !== null)
    .join(", ");
  const content = row.content.length > 0 ? row.content : "blank line";
  const label = row.type === "context"
    ? `Clear selected block from context line${lineNumbers.length > 0 ? `, ${lineNumbers}` : ""}: ${content}`
    : `${operation} line${lineNumbers.length > 0 ? `, ${lineNumbers}` : ""}: ${content}`;
  return (
    <li
      className={[
        "diff-line",
        tone,
        anchored ? "diff-line--anchored" : "",
        selected ? "diff-line--selected" : "",
      ]
        .filter(Boolean)
        .join(" ")}
      data-old-line={row.oldLine ?? undefined}
      data-new-line={row.newLine ?? undefined}
    >
      <button
        type="button"
        className="diff-line__body"
        aria-label={label}
        aria-pressed={row.type === "context" ? undefined : selected}
        onClick={onSelect}
      >
        <span className="line-number line-number--old" aria-hidden="true">
          {row.oldLine ?? ""}
        </span>
        <span className="line-number line-number--new" aria-hidden="true">
          {row.newLine ?? ""}
        </span>
        <span className="line-sign" aria-hidden="true">
          {row.type === "add" ? "+" : row.type === "del" ? "-" : " "}
        </span>
        <code>{row.content}</code>
      </button>
    </li>
  );
}

function HunkLines(props: {
  hunks: DiffHunk[];
  anchors: DecisionAnchor[];
  selectedBlock: BlockSelection | null;
  onSelectBlock: (block: BlockSelection | null) => void;
}) {
  return (
    <>
      {props.hunks.map((hunk, hunkIndex) => (
        <div className="diff-hunk" key={`${hunk.oldStart}:${hunk.newStart}:${hunkIndex}`}>
          <p className="diff-hunk__header">{`@@ -${hunk.oldStart} +${hunk.newStart} @@`}</p>
          <ol className="diff-lines">
            {hunk.lines.map((row, index) => {
              const run = blockRun(hunk.lines, index);
              const selected = sameBlock(run, props.selectedBlock);
              return (
                <LineRow
                  key={`${index}-${row.content}`}
                  row={row}
                  anchored={lineAnchored(row, props.anchors)}
                  selected={selected}
                  onSelect={() => props.onSelectBlock(run === null || selected ? null : run)}
                />
              );
            })}
          </ol>
        </div>
      ))}
    </>
  );
}

export function DiffView({
  path,
  isLoading,
  error,
  baseMissing,
  diff,
  anchors,
  transitionAnchors = [],
  selectedBlock,
  onSelectBlock,
  fullText,
  navigateTo,
  onRetry,
  snapshotDiff = null,
  snapshotDiffLoading = false,
  snapshotDiffError = null,
}: DiffViewProps) {
  const rootRef = useRef<HTMLElement | null>(null);
  const transitionActive = snapshotDiff !== null || snapshotDiffLoading || snapshotDiffError !== null;

  useEffect(() => {
    if (navigateTo === null || rootRef.current === null) return;
    // Snapshot transitions anchor judgments to the recorded old side; ordinary diffs keep the new-side preference.
    const target =
      transitionActive
        ? rootRef.current.querySelector(`[data-old-line="${navigateTo.line}"]`) ??
          rootRef.current.querySelector(`[data-new-line="${navigateTo.line}"]`)
        : rootRef.current.querySelector(`[data-new-line="${navigateTo.line}"]`) ??
          rootRef.current.querySelector(`[data-old-line="${navigateTo.line}"]`);
    if (!(target instanceof HTMLElement)) return;
    target.scrollIntoView({ block: "center" });
    target.classList.add("diff-line--pulse");
    const pulseTimer = window.setTimeout(() => target.classList.remove("diff-line--pulse"), 1200);
    return () => {
      window.clearTimeout(pulseTimer);
      target.classList.remove("diff-line--pulse");
    };
  }, [
    navigateTo,
    path,
    isLoading,
    error,
    baseMissing,
    diff,
    fullText,
    snapshotDiff,
    snapshotDiffError,
    snapshotDiffLoading,
    transitionActive,
  ]);

  const shell = (children: ReactNode, metadata?: ReactNode) => (
    <section
      ref={rootRef}
      className="diff-view"
      aria-label="Source diff"
      aria-busy={isLoading || snapshotDiffLoading || undefined}
    >
      <header className="pane-header diff-view__header">
        <h2>{path ?? "Diff"}</h2>
        {metadata ?? (diff !== null && !diff.binary && !transitionActive && diff.base_sha.length > 0 && (
          <code className="diff-view__base">vs {diff.base_sha.slice(0, 12)}</code>
        ))}
      </header>
      <div className="pane-body">{children}</div>
    </section>
  );

  if (path === null) {
    return shell(<p className="empty-state">Select a file in the explorer to see its diff.</p>);
  }
  if (transitionActive) {
    const retryTransition = () => {
      if (!snapshotDiffLoading) onRetry();
    };
    if (snapshotDiffLoading) {
      return shell(
        <div className="empty-state">
          <p role="status">Loading snapshot transition…</p>
          <button type="button" aria-disabled="true" onClick={retryTransition}>Retry</button>
        </div>,
      );
    }
    if (snapshotDiffError !== null) {
      return shell(
        <div className="inline-error" role="alert">
          <p>{errorCardMessage(snapshotDiffError)}</p>
          <button type="button" aria-disabled="false" onClick={retryTransition}>Retry</button>
        </div>,
      );
    }
    if (snapshotDiff === null) {
      return shell(<p className="empty-state">Snapshot transition is unavailable.</p>);
    }
    const metadata = (
      <div className="diff-view__transition" aria-label="Snapshot transition">
        <code>before snapshot</code>
        <span aria-hidden="true">→</span>
        <code>{transitionDestinationLabel(snapshotDiff.to)}</code>
      </div>
    );
    if (snapshotDiff.binary) {
      return shell(<p className="empty-state">Binary files cannot be shown in the diff view.</p>, metadata);
    }
    if (snapshotDiff.hunks.length === 0) {
      if (snapshotDiff.old_missing !== snapshotDiff.new_missing) {
        return shell(
          <p role="status" className="empty-state">
            {snapshotDiff.old_missing
              ? "File was created after the selected judgment."
              : "File was deleted after the selected judgment."}
          </p>,
          metadata,
        );
      }
      return shell(
        <p className="empty-state">No changes between the selected judgment and the next state.</p>,
        metadata,
      );
    }
    return shell(
      <HunkLines
        hunks={snapshotDiff.hunks}
        anchors={transitionAnchors}
        selectedBlock={selectedBlock}
        onSelectBlock={onSelectBlock}
      />,
      metadata,
    );
  }
  if (isLoading) {
    return shell(
      <p role="status" className="empty-state">
        Loading diff…
      </p>,
    );
  }
  // spec §4.3-3: コミットが一つもないリポジトリではdiff baseが存在しない。これはエラーではなく、
  // 解決済みソースの全文(なければ専用の空状態)を示す。Retryは状況が変わらないため出さない。
  if (baseMissing && fullText !== null) {
    return shell(<FullTextLines content={fullText.content} anchors={fullText.anchors} />);
  }
  if (baseMissing) {
    return shell(
      <p className="empty-state">This repository has no commits yet, so there is nothing to compare against.</p>,
    );
  }
  if (error !== null) {
    return shell(
      <div className="inline-error" role="alert">
        <p>{errorCardMessage(error)}</p>
        <button type="button" onClick={onRetry}>
          Retry
        </button>
      </div>,
    );
  }
  if (diff === null) {
    return shell(<p className="empty-state">Select a file in the explorer to see its diff.</p>);
  }
  if (diff.binary) {
    return shell(<p className="empty-state">Binary files cannot be shown in the diff view.</p>);
  }
  if (diff.hunks.length === 0 && fullText === null) {
    return shell(
      <p className="empty-state">No changes between the recorded revision and the working tree.</p>,
    );
  }

  if (diff.hunks.length === 0 && fullText !== null) {
    return shell(<FullTextLines content={fullText.content} anchors={fullText.anchors} />);
  }

  return shell(
    <HunkLines hunks={diff.hunks} anchors={anchors} selectedBlock={selectedBlock} onSelectBlock={onSelectBlock} />,
  );
}
