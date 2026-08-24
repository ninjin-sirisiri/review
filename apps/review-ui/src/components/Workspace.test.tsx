import { describe, expect, it, vi, afterEach } from "vitest";
import { fireEvent, render, screen } from "@testing-library/react";
import { Workspace } from "./Workspace";
import type { FileTreeNode } from "../lib/file-tree";
import type { DecisionRecordDetail } from "../api";
import type { DiffLine, FileDiff } from "../../../../packages/contracts/src/index";

afterEach(() => {
  vi.restoreAllMocks();
});

function node(
  partial: Partial<FileTreeNode> & { name: string; path: string; isFile: boolean },
): FileTreeNode {
  return { decisionCount: 0, children: [], ...partial };
}

function treeFixture(): FileTreeNode {
  return node({
    name: "",
    path: "",
    isFile: false,
    children: [
      node({
        name: "src",
        path: "src",
        isFile: false,
        children: [
          node({ name: "api.ts", path: "src/api.ts", isFile: true, decisionCount: 1 }),
          node({ name: "util.ts", path: "src/util.ts", isFile: true }),
        ],
      }),
    ],
  });
}

function diffLine(partial: DiffLine): DiffLine {
  return partial;
}

function diffFixture(): FileDiff {
  return {
    path: "src/api.ts",
    base_sha: "abc123def4567890",
    old_missing: false,
    new_missing: false,
    binary: false,
    hunks: [
      {
        oldStart: 1,
        newStart: 1,
        lines: [
          diffLine({ type: "context", oldLine: 1, newLine: 1, content: "const before = 1;" }),
          diffLine({ type: "del", oldLine: 2, newLine: null, content: "const removed = 2;" }),
          diffLine({ type: "add", oldLine: null, newLine: 2, content: "const added = 3;" }),
        ],
      },
    ],
  };
}

export function detailFixture(recordId: string): DecisionRecordDetail {
  const target = {
    repository_id: "repo-1",
    path: "src/api.ts",
    line_start: 2,
    line_end: 3,
    revision: { kind: "commit" as const, sha: "abc123def4567890" },
    content_hash: "hash-a",
  };
  return {
    record: {
      record_id: recordId,
      session_id: `session-${recordId}`,
      repository_id: "repo-1",
      agent_type: "codex",
      revision: target.revision,
      targets: [target],
      judgment: `Guard ${recordId}`,
      rationale: "",
      checks: [],
      open_questions: [],
      created_at: "2026-08-20T10:00:00.000Z",
      user_disposition: "unreviewed",
    },
    sources: [
      {
        state: "resolved",
        repository_id: "repo-1",
        path: "src/api.ts",
        revision: target.revision,
        target,
        content: "const added = 3;",
        content_hash: "hash-a",
      },
    ],
  };
}

const baseProps = {
  tree: treeFixture(),
  selectedPath: "src/api.ts",
  explorerIsLoading: false,
  explorerError: null,
  onExplorerRetry: vi.fn(),
  onOpenFile: vi.fn(),
  fileIsLoading: false,
  fileError: null,
  diff: diffFixture(),
  fullText: null,
  onFileRetry: vi.fn(),
  judgments: [{ recordId: "rec-1", status: "ready" as const, detail: detailFixture("rec-1") }],
  anchors: [{ side: "new" as const, start: 2, end: 2 }],
  onDispositionChange: vi.fn(async () => detailFixture("rec-1")),
  onJudgmentRetry: vi.fn(),
};

describe("Workspace", () => {
  it("renders the three panes", () => {
    render(<Workspace {...baseProps} />);

    expect(screen.getByRole("navigation", { name: "Repository explorer" })).toBeTruthy();
    expect(screen.getByRole("region", { name: "Source diff" })).toBeTruthy();
    expect(screen.getByRole("region", { name: "Judgments" })).toBeTruthy();
  });

  it("forwards file clicks with their full path", () => {
    const onOpenFile = vi.fn();
    render(<Workspace {...baseProps} onOpenFile={onOpenFile} />);

    fireEvent.click(screen.getByText("util.ts"));
    expect(onOpenFile).toHaveBeenCalledWith("src/util.ts");
  });

  it("keeps block selection local and lets the panel clear it", () => {
    render(<Workspace {...baseProps} />);

    fireEvent.click(screen.getByText("const removed = 2;"));
    const delRow = document.querySelector<HTMLElement>('[data-old-line="2"]');
    expect(delRow?.className).toContain("diff-line--selected");
    expect(screen.getByRole("button", { name: "Clear block filter" })).toBeTruthy();

    fireEvent.click(screen.getByRole("button", { name: "Clear block filter" }));
    expect(delRow?.className).not.toContain("diff-line--selected");
  });

  it("scrolls to a judgment target line when its card link is clicked", () => {
    const scrollIntoView = vi.fn();
    Object.defineProperty(Element.prototype, "scrollIntoView", {
      value: scrollIntoView,
      configurable: true,
    });
    render(<Workspace {...baseProps} />);

    fireEvent.click(screen.getByRole("button", { name: "src/api.ts:2–3" }));
    expect(scrollIntoView).toHaveBeenCalledTimes(1);
    const row = document.querySelector<HTMLElement>('[data-new-line="2"]');
    expect(row?.className).toContain("diff-line--pulse");
  });

  it("routes explorer retry to onExplorerRetry", () => {
    const onExplorerRetry = vi.fn();
    render(
      <Workspace {...baseProps} explorerError={new Error("Recorder request failed")} onExplorerRetry={onExplorerRetry} />,
    );

    fireEvent.click(screen.getByRole("navigation", { name: "Repository explorer" }).querySelector<HTMLButtonElement>(".inline-error button")!);
    expect(onExplorerRetry).toHaveBeenCalled();
  });

  it("routes diff retry to onFileRetry", () => {
    const onFileRetry = vi.fn();
    render(
      <Workspace
        {...baseProps}
        diff={null}
        fileError={new Error("The recorded revision could not be found.")}
        onFileRetry={onFileRetry}
      />,
    );

    fireEvent.click(screen.getByRole("region", { name: "Source diff" }).querySelector<HTMLButtonElement>(".inline-error button")!);
    expect(onFileRetry).toHaveBeenCalled();
  });
});
