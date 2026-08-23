import { useEffect, useRef, type ReactNode } from "react";
import type { DiffLine, FileDiff } from "../../../../packages/contracts/src/index";
import { ReviewApiError } from "../api";
import type { BlockSelection, DecisionAnchor } from "../lib/decision-index";

export interface DiffViewProps {
  path: string | null;
  isLoading: boolean;
  error: ReviewApiError | Error | null;
  diff: FileDiff | null;
  anchors: DecisionAnchor[];
  selectedBlock: BlockSelection | null;
  onSelectBlock: (block: BlockSelection | null) => void;
  fullText: { content: string; anchors: DecisionAnchor[] } | null;
  /** カードからの逆ナビゲーション(§6.2.4)。tokenが変わるたびに再スクロールする。 */
  navigateTo: { line: number; token: number } | null;
  onRetry: () => void;
}

function lineAnchored(row: DiffLine, anchors: DecisionAnchor[]): boolean {
  return anchors.some((anchor) =>
    anchor.side === "old"
      ? row.oldLine !== null && anchor.start <= row.oldLine && row.oldLine <= anchor.end
      : row.newLine !== null && anchor.start <= row.newLine && row.newLine <= anchor.end,
  );
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

function LineRow(props: {
  row: DiffLine;
  anchored: boolean;
  selected: boolean;
  onSelect: () => void;
}) {
  const { row, anchored, selected, onSelect } = props;
  const tone =
    row.type === "add" ? "diff-line--add" : row.type === "del" ? "diff-line--del" : "diff-line--context";
  const gutter = row.type === "del" ? row.oldLine : row.newLine;
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
      <button type="button" className="diff-line__body" onClick={onSelect}>
        <span className="line-number" aria-hidden="true">
          {gutter ?? ""}
        </span>
        <span className="line-sign" aria-hidden="true">
          {row.type === "add" ? "+" : row.type === "del" ? "-" : " "}
        </span>
        <code>{row.content}</code>
      </button>
    </li>
  );
}

export function DiffView({
  path,
  isLoading,
  error,
  diff,
  anchors,
  selectedBlock,
  onSelectBlock,
  fullText,
  navigateTo,
  onRetry,
}: DiffViewProps) {
  const rootRef = useRef<HTMLElement | null>(null);

  useEffect(() => {
    if (navigateTo === null || rootRef.current === null) return;
    // 新側の行番号を優先して解決する(旧新で同じ番号が衝突するときは作業木側の行へ飛ぶ)。
    const target =
      rootRef.current.querySelector(`[data-new-line="${navigateTo.line}"]`) ??
      rootRef.current.querySelector(`[data-old-line="${navigateTo.line}"]`);
    if (!(target instanceof HTMLElement)) return;
    target.scrollIntoView({ block: "center" });
    target.classList.add("diff-line--pulse");
    window.setTimeout(() => target.classList.remove("diff-line--pulse"), 1200);
  }, [navigateTo]);

  const shell = (children: ReactNode, heading = true) => (
    <section ref={rootRef} className="diff-view" aria-label="Source diff">
      {heading && (
        <header className="diff-view__header">
          <h2>{path}</h2>
          {diff !== null && !diff.binary && diff.base_sha.length > 0 && (
            <code className="diff-view__base">vs {diff.base_sha.slice(0, 12)}</code>
          )}
        </header>
      )}
      {children}
    </section>
  );

  if (path === null) {
    return shell(<p className="empty-state">Select a file in the explorer to see its diff.</p>, false);
  }
  if (isLoading) {
    return shell(
      <p role="status" className="empty-state">
        Loading diff…
      </p>,
      false,
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
    return shell(<p className="empty-state">Select a file in the explorer to see its diff.</p>, false);
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
    const contents = fullText.content.split("\n");
    return shell(
      <ol className="diff-lines">
        {contents.map((content, index) => {
          const lineNumber = index + 1;
          const anchored = fullText.anchors.some(
            (anchor) => anchor.side === "new" && anchor.start <= lineNumber && lineNumber <= anchor.end,
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
              </span>
              <code>{content}</code>
            </li>
          );
        })}
      </ol>,
    );
  }

  return shell(
    <>
      {diff.hunks.map((hunk, hunkIndex) => (
        <ol className="diff-lines" key={`${hunk.oldStart}:${hunk.newStart}:${hunkIndex}`}>
          {hunk.lines.map((row, index) => {
            const run = blockRun(hunk.lines, index);
            const selected = sameBlock(run, selectedBlock);
            return (
              <LineRow
                key={`${index}-${row.content}`}
                row={row}
                anchored={lineAnchored(row, anchors)}
                selected={selected}
                onSelect={() => onSelectBlock(run === null || selected ? null : run)}
              />
            );
          })}
        </ol>
      ))}
    </>,
  );
}
