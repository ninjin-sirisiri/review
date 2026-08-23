import { describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen } from "@testing-library/react";
import { JudgmentPanel, type JudgmentEntry } from "./JudgmentPanel";
import type { DecisionRecordDetail } from "../api";

function entryWithTarget(recordId: string, path: string, lineStart: number, lineEnd: number, side: "commit" | "worktree"): JudgmentEntry {
  const target = {
    repository_id: "repo-1",
    path,
    line_start: lineStart,
    line_end: lineEnd,
    revision: (side === "commit" ? { kind: "commit", sha: "abc" } : { kind: "working-tree", contentHash: "h1" }) as const,
    content_hash: "expected",
  };
  const detail: DecisionRecordDetail = {
    record: {
      record_id: recordId,
      session_id: `session-${recordId}`,
      repository_id: "repo-1",
      agent_type: "codex",
      revision: side === "commit" ? { kind: "commit", sha: "abc" } : { kind: "working-tree", contentHash: "h1" },
      targets: [target],
      judgment: `Judgment ${recordId}`,
      rationale: "",
      checks: [],
      open_questions: [],
      created_at: "2026-08-20T10:00:00.000Z",
      user_disposition: "unreviewed",
    },
    sources: [
      side === "commit"
        ? { state: "resolved" as const, repository_id: "repo-1", path, revision: { kind: "commit", sha: "abc" }, target, content: "code", content_hash: "expected" }
        : { state: "resolved" as const, repository_id: "repo-1", path, revision: { kind: "working-tree", contentHash: "h1" }, target, content: "code", content_hash: "expected" },
    ],
  };
  return { recordId, status: "ready", detail };
}

const baseProps = {
  path: "src/a.ts",
  selectedBlock: null,
  onSelectBlock: vi.fn(),
  onDispositionChange: vi.fn(async () => {
    throw new Error("not used");
  }),
  onRetry: vi.fn(),
  onTargetClick: vi.fn(),
};

describe("JudgmentPanel", () => {
  it("shows all ready cards newest first and empty states without a file", () => {
    render(<JudgmentPanel {...baseProps} entries={[entryWithTarget("r1", "src/a.ts", 4, 6, "commit")]} />);
    expect(screen.getByRole("heading", { name: "Judgment r1" })).toBeTruthy();

    render(<JudgmentPanel {...baseProps} path={null} entries={[]} />);
    expect(screen.getByText("Select a file in the explorer to review its judgments.")).toBeTruthy();
  });

  it("filters to overlapping decisions when a block is selected and restores on clear", () => {
    const oldSide = entryWithTarget("old-side", "src/a.ts", 5, 7, "commit");
    const newSide = entryWithTarget("new-side", "src/a.ts", 2, 3, "worktree");
    const unrelated = entryWithTarget("unrelated", "src/b.ts", 1, 2, "commit");
    const onSelectBlock = vi.fn();
    render(
      <JudgmentPanel
        {...baseProps}
        entries={[oldSide, newSide, unrelated]}
        selectedBlock={{ oldStart: 5, oldEnd: 7, newStart: null, newEnd: null }}
        onSelectBlock={onSelectBlock}
      />,
    );
    expect(screen.getByRole("heading", { name: "Judgment old-side" })).toBeTruthy();
    expect(screen.queryByRole("heading", { name: "Judgment new-side" })).toBeNull();
    expect(screen.queryByRole("heading", { name: "Judgment unrelated" })).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "Clear block filter" }));
    expect(onSelectBlock).toHaveBeenCalledWith(null);
  });

  it("renders loading placeholders and per-card errors with retry", () => {
    const onRetry = vi.fn();
    render(
      <JudgmentPanel
        {...baseProps}
        onRetry={onRetry}
        entries={[
          { recordId: "loading-record", status: "loading" },
          { recordId: "broken-record", status: "error", message: "Recorder request failed" },
        ]}
      />,
    );

    expect(screen.getByText("Loading decision…")).toBeTruthy();
    expect(screen.getByRole("alert").textContent).toContain("Recorder request failed");
    fireEvent.click(screen.getByRole("button", { name: /Retry broken-record/ }));
    expect(onRetry).toHaveBeenCalledWith("broken-record");
  });
});
