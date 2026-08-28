import { afterEach, describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen } from "@testing-library/react";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { DiffView } from "./DiffView";
import { ReviewApiError } from "../api";
import type { DecisionAnchor } from "../lib/decision-index";
import type { DiffLine, FileDiff, SnapshotDiff } from "../../../../packages/contracts/src/index";

const componentsCss = readFileSync(resolve(process.cwd(), "src/styles/components.css"), "utf8");

function line(partial: DiffLine): DiffLine {
  return partial;
}

function fileDiff(overrides: Partial<FileDiff> = {}): FileDiff {
  return {
    path: "src/a.ts",
    base_sha: "abc123def456",
    old_missing: false,
    new_missing: false,
    binary: false,
    hunks: [
      {
        oldStart: 1,
        newStart: 1,
        lines: [
          line({ type: "context", oldLine: 1, newLine: 1, content: "const before = 1;" }),
          line({ type: "del", oldLine: 2, newLine: null, content: "const removed = 2;" }),
          line({ type: "add", oldLine: null, newLine: 2, content: "const added = 3;" }),
          line({ type: "context", oldLine: 3, newLine: 3, content: "const tail = 4;" }),
        ],
      },
    ],
    ...overrides,
  };
}

function snapshotDiff(overrides: Partial<SnapshotDiff> = {}): SnapshotDiff {
  return {
    state: "snapshot-resolved",
    path: "src/a.ts",
    from: {
      kind: "snapshot",
      snapshot_id: "snapshot-before",
      record_id: "record-1",
      created_at: "2026-08-20T10:00:00.000Z",
      content_hash: "before-hash",
      source_path: "src/a.ts",
      base_sha: "before1234567890",
    },
    to: {
      kind: "snapshot",
      snapshot_id: "snapshot-next",
      record_id: "record-2",
      created_at: "2026-08-20T11:00:00.000Z",
      content_hash: "next-hash",
      source_path: "src/a.ts",
      base_sha: "next1234567890",
    },
    hunks: [
      {
        oldStart: 1,
        newStart: 1,
        lines: [
          line({ type: "context", oldLine: 1, newLine: 1, content: "const before = 1;" }),
          line({ type: "del", oldLine: 2, newLine: null, content: "const transition = \"before\";" }),
          line({ type: "add", oldLine: null, newLine: 2, content: "const transition = \"after\";" }),
        ],
      },
    ],
    old_missing: false,
    new_missing: false,
    binary: false,
    ...overrides,
  };
}

const baseProps = {
  path: "src/a.ts",
  isLoading: false,
  error: null,
  baseMissing: false,
  diff: fileDiff(),
  anchors: [
    { side: "old", start: 1, end: 1 },
    { side: "new", start: 2, end: 2 },
  ] satisfies DecisionAnchor[],
  selectedBlock: null,
  onSelectBlock: vi.fn(),
  fullText: null,
  navigateTo: null,
  onRetry: vi.fn(),
};

afterEach(() => {
  vi.restoreAllMocks();
});

describe("DiffView", () => {
  it("renders a resolved snapshot transition with endpoint labels and old-side anchors", () => {
    render(
      <DiffView
        {...baseProps}
        snapshotDiff={snapshotDiff()}
        transitionAnchors={[{ side: "old", start: 2, end: 2 }]}
      />,
    );

    expect(screen.getByRole("heading", { name: "src/a.ts" })).toBeTruthy();
    expect(screen.getByText("before snapshot")).toBeTruthy();
    expect(screen.getByText(/next snapshot @next1234/)).toBeTruthy();
    expect(screen.getByText('const transition = "before";')).toBeTruthy();
    expect(screen.getByText('const transition = "after";')).toBeTruthy();
    expect(document.querySelector('[data-old-line="2"]')?.className).toContain("diff-line--anchored");
  });

  it("labels a transition with no next snapshot as the working tree", () => {
    render(<DiffView {...baseProps} snapshotDiff={snapshotDiff({ to: { kind: "working-tree" } })} />);

    expect(screen.getByText("after: working tree")).toBeTruthy();
  });

  it("shows a transition-specific no-changes state for a resolved empty diff", () => {
    render(<DiffView {...baseProps} snapshotDiff={snapshotDiff({ hunks: [] })} fullText={{ content: "current repository source", anchors: [] }} />);

    expect(screen.getByText("No changes between the selected judgment and the next state.")).toBeTruthy();
    expect(screen.queryByText("current repository source")).toBeNull();
  });

  it.each([
    ["created", { old_missing: true, new_missing: false }, "File was created after the selected judgment."],
    ["deleted", { old_missing: false, new_missing: true }, "File was deleted after the selected judgment."],
    ["both sides missing", { old_missing: true, new_missing: true }, "No changes between the selected judgment and the next state."],
  ] as const)("announces a %s empty-file transition without losing metadata", (_label, missing, expected) => {
    render(<DiffView {...baseProps} snapshotDiff={snapshotDiff({ ...missing, hunks: [] })} />);

    expect(screen.getByText("before snapshot")).toBeTruthy();
    expect(screen.getByText(/next snapshot @next1234/)).toBeTruthy();
    expect(screen.getByText(expected)).toBeTruthy();
    if (expected.startsWith("File was")) {
      expect(screen.getByRole("status").textContent).toBe(expected);
      expect(screen.queryByText("No changes between the selected judgment and the next state.")).toBeNull();
    } else {
      expect(screen.queryByRole("status")).toBeNull();
    }
  });

  it("preserves transition hunk rows when missing-side flags accompany textual changes", () => {
    render(<DiffView {...baseProps} snapshotDiff={snapshotDiff({ old_missing: true, new_missing: false })} />);

    expect(screen.getByText('const transition = "before";')).toBeTruthy();
    expect(screen.getByText('const transition = "after";')).toBeTruthy();
    expect(screen.queryByRole("status")).toBeNull();
  });

  it("uses the binary message for a binary snapshot transition", () => {
    render(<DiffView {...baseProps} snapshotDiff={snapshotDiff({ binary: true, hunks: [] })} />);

    expect(screen.getByText("Binary files cannot be shown in the diff view.")).toBeTruthy();
  });

  it("shows transition loading and errors without falling back to repository full text", () => {
    const { rerender } = render(
      <DiffView
        {...baseProps}
        snapshotDiffLoading
        fullText={{ content: "current repository source", anchors: [] }}
      />,
    );
    expect(screen.getByRole("status").textContent).toContain("Loading snapshot transition");
    expect(screen.queryByText("current repository source")).toBeNull();

    rerender(
      <DiffView
        {...baseProps}
        snapshotDiffError={new Error("snapshot source unavailable")}
        fullText={{ content: "current repository source", anchors: [] }}
      />,
    );
    expect(screen.getByRole("alert").textContent).toContain("snapshot source unavailable");
    expect(screen.queryByText("current repository source")).toBeNull();
  });

  it("keeps Retry focused and blocks duplicate clicks while a transition retry loads", () => {
    const onRetry = vi.fn();
    const { rerender } = render(
      <DiffView {...baseProps} snapshotDiffError={new Error("snapshot source unavailable")} onRetry={onRetry} />,
    );
    const retry = screen.getByRole("button", { name: "Retry" });
    retry.focus();
    fireEvent.click(retry);
    expect(onRetry).toHaveBeenCalledTimes(1);

    rerender(<DiffView {...baseProps} snapshotDiffLoading onRetry={onRetry} />);

    const loadingRetry = screen.getByRole("button", { name: "Retry" });
    expect(screen.getByRole("status").textContent).toContain("Loading snapshot transition");
    expect(loadingRetry.getAttribute("aria-disabled")).toBe("true");
    expect(document.activeElement).toBe(loadingRetry);

    fireEvent.click(loadingRetry);
    expect(onRetry).toHaveBeenCalledTimes(1);
  });

  it("renders hunk lines with gutters and tints only verified anchored lines", () => {
    render(<DiffView {...baseProps} />);

    const rows = screen.getAllByRole("listitem");
    expect(rows).toHaveLength(4);
    // 旧側アンカー(old 1..1)はcontext行の旧行番号1に一致、新側アンカー(new 2..2)はadd行に一致
    expect(rows[0].className).toContain("diff-line--anchored"); // context old=1
    expect(rows[1].className).not.toContain("diff-line--anchored"); // del: 新側アンカーは新行番号がnullなので不適合
    expect(rows[2].className).toContain("diff-line--anchored"); // add new=2
    expect(rows[3].className).not.toContain("diff-line--anchored");
    expect(screen.getByText("const removed = 2;")).toBeTruthy();
    expect(screen.getByText("-")).toBeTruthy();
    expect(document.querySelector('[data-old-line="2"]')).not.toBeNull();
    expect(document.querySelector('[data-new-line="2"]')).not.toBeNull();
    expect(document.querySelector('[data-new-line="2"]')?.hasAttribute("data-old-line")).toBe(false); // add行には新行番号のみ
  });

  it("names each diff row by operation, available line numbers, and content", () => {
    render(<DiffView {...baseProps} />);

    expect(screen.getByRole("button", { name: /context.*old line 1.*new line 1.*const before = 1;/i })).toBeTruthy();
    expect(screen.getByRole("button", { name: /deleted.*old line 2.*const removed = 2;/i })).toBeTruthy();
    expect(screen.getByRole("button", { name: /added.*new line 2.*const added = 3;/i })).toBeTruthy();
  });

  it("gives clickable diff rows a 44px coarse-pointer hit target", () => {
    expect(componentsCss).toMatch(
      /@media\s*\(pointer:\s*coarse\)\s*,\s*\(any-pointer:\s*coarse\)[\s\S]*\.diff-line__body\s*\{[\s\S]*min-height:\s*44px;/,
    );
  });

  it("selects a maximal add run on click and clears on context click", () => {
    const onSelectBlock = vi.fn();
    render(<DiffView {...baseProps} onSelectBlock={onSelectBlock} />);

    fireEvent.click(screen.getByText("const added = 3;"));
    expect(onSelectBlock).toHaveBeenLastCalledWith({
      oldStart: null,
      oldEnd: null,
      newStart: 2,
      newEnd: 2,
    });

    fireEvent.click(screen.getByText("const tail = 4;"));
    expect(onSelectBlock).toHaveBeenLastCalledWith(null);
  });

  it("selects the whole del run and reports an old-side-only range", () => {
    const onSelectBlock = vi.fn();
    const diff = fileDiff({
      hunks: [
        {
          oldStart: 1,
          newStart: 1,
          lines: [
            line({ type: "del", oldLine: 1, newLine: null, content: "alpha();" }),
            line({ type: "del", oldLine: 2, newLine: null, content: "beta();" }),
            line({ type: "add", oldLine: null, newLine: 1, content: "gamma();" }),
          ],
        },
      ],
    });
    render(<DiffView {...baseProps} diff={diff} anchors={[]} onSelectBlock={onSelectBlock} />);

    fireEvent.click(screen.getByText("alpha();"));
    expect(onSelectBlock).toHaveBeenLastCalledWith({
      oldStart: 1,
      oldEnd: 2,
      newStart: null,
      newEnd: null,
    });
  });

  it("highlights the selected block and toggles it off when clicked again", () => {
    const onSelectBlock = vi.fn();
    const selectedBlock = { oldStart: null, oldEnd: null, newStart: 2, newEnd: 2 };
    render(<DiffView {...baseProps} selectedBlock={selectedBlock} onSelectBlock={onSelectBlock} />);

    const addRow = screen.getAllByRole("listitem")[2];
    expect(addRow.className).toContain("diff-line--selected");
    expect(screen.getByRole("button", { name: /added.*new line 2.*const added = 3;/i }).getAttribute("aria-pressed")).toBe("true");
    expect(screen.getByRole("button", { name: /deleted.*old line 2.*const removed = 2;/i }).getAttribute("aria-pressed")).toBe("false");
    expect(screen.getByRole("button", { name: /clear selected block.*context.*old line 1.*new line 1.*const before = 1;/i }).getAttribute("aria-pressed")).toBeNull();

    fireEvent.click(screen.getByText("const added = 3;"));
    expect(onSelectBlock).toHaveBeenCalledWith(null);
  });

  it("names context rows as clear actions without toggle semantics", () => {
    const onSelectBlock = vi.fn();
    render(
      <DiffView
        {...baseProps}
        selectedBlock={{ oldStart: null, oldEnd: null, newStart: 2, newEnd: 2 }}
        onSelectBlock={onSelectBlock}
      />,
    );

    const context = screen.getByRole("button", { name: /clear selected block.*context.*old line 1.*new line 1.*const before = 1;/i });
    expect(context.getAttribute("aria-pressed")).toBeNull();

    fireEvent.click(context);

    expect(onSelectBlock).toHaveBeenCalledWith(null);
  });

  it("shows a dedicated message for binary files", () => {
    render(<DiffView {...baseProps} diff={fileDiff({ binary: true, hunks: [] })} />);
    expect(screen.getByText("Binary files cannot be shown in the diff view.")).toBeTruthy();
  });

  it("keeps binary transition messaging ahead of missing-file messaging", () => {
    render(
      <DiffView
        {...baseProps}
        snapshotDiff={snapshotDiff({ binary: true, hunks: [], old_missing: true, new_missing: false })}
      />,
    );

    expect(screen.getByText("Binary files cannot be shown in the diff view.")).toBeTruthy();
    expect(screen.queryByText("File was created after the selected judgment.")).toBeNull();
    expect(screen.queryByText("File was deleted after the selected judgment.")).toBeNull();
  });

  it("shows full-text mode with anchored highlights when there is no textual diff", () => {
    render(
      <DiffView
        {...baseProps}
        diff={fileDiff({ hunks: [] })}
        fullText={{
          content: "alpha\nbeta\ngamma",
          anchors: [{ side: "new", start: 2, end: 2 }],
        }}
      />,
    );

    const rows = screen.getAllByRole("listitem");
    expect(rows).toHaveLength(3);
    expect(rows[1].className).toContain("diff-line--anchored");
    expect(screen.getByText("beta")).toBeTruthy();
    expect(document.querySelector('[data-new-line="2"]')).not.toBeNull();
  });

  it("highlights full-text lines for old-side anchors", () => {
    render(
      <DiffView
        {...baseProps}
        diff={fileDiff({ hunks: [] })}
        fullText={{
          content: "alpha\nbeta\ngamma",
          anchors: [{ side: "old", start: 2, end: 2 }],
        }}
      />,
    );

    expect(screen.getAllByRole("listitem")[1]?.className).toContain("diff-line--anchored");
  });

  it("shows the no-changes empty state when there is no diff and no resolved source", () => {
    render(<DiffView {...baseProps} diff={fileDiff({ hunks: [] })} />);
    expect(
      screen.getByText("No changes between the recorded revision and the working tree."),
    ).toBeTruthy();
  });

  // spec §4.3-3: コミットが一つもないリポジトリではdiff baseが存在しない。エラーカードではなく
  // 解決済みソースの全文(または専用の空状態)を表示する。
  it("shows full text when the diff base is missing but a verified source exists", () => {
    render(
      <DiffView
        {...baseProps}
        diff={null}
        baseMissing
        fullText={{
          content: "alpha\nbeta\ngamma",
          anchors: [{ side: "new", start: 2, end: 2 }],
        }}
      />,
    );

    expect(screen.queryByRole("alert")).toBeNull();
    expect(screen.getByText("beta")).toBeTruthy();
    expect(document.querySelector('[data-new-line="2"]')?.className).toContain("diff-line--anchored");
  });

  it("explains the absent commits when the diff base is missing and no source resolved", () => {
    render(<DiffView {...baseProps} diff={null} baseMissing />);
    expect(
      screen.getByText("This repository has no commits yet, so there is nothing to compare against."),
    ).toBeTruthy();
    expect(screen.queryByRole("button", { name: "Retry" })).toBeNull();
  });

  it.each([
    ["REVISION_NOT_FOUND", 404, "The recorded revision could not be found."],
    ["PAYLOAD_TOO_LARGE", 413, "Source exceeds the size limit."],
  ] as const)("maps %s to its card copy with retry", (code, status, expected) => {
    render(<DiffView {...baseProps} diff={null} error={new ReviewApiError(expected, { code, status })} />);
    expect(screen.getByText(expected)).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Retry" }));
    expect(baseProps.onRetry).toHaveBeenCalled();
  });

  it("shows other errors with their own message and retry", () => {
    render(<DiffView {...baseProps} diff={null} error={new Error("Recorder request failed")} />);
    expect(screen.getByText("Recorder request failed")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Retry" }));
    expect(baseProps.onRetry).toHaveBeenCalled();
  });

  it("shows the loading state", () => {
    render(<DiffView {...baseProps} diff={null} isLoading />);
    expect(screen.getByRole("status").textContent).toContain("Loading diff");
  });

  it("scrolls to and pulses the navigateTo line", () => {
    const scrollIntoView = vi.fn();
    Object.defineProperty(Element.prototype, "scrollIntoView", {
      value: scrollIntoView,
      configurable: true,
    });
    vi.useFakeTimers();
    try {
      render(<DiffView {...baseProps} navigateTo={{ line: 2, token: 1 }} />);
      expect(scrollIntoView).toHaveBeenCalledTimes(1);
      const row = document.querySelector<HTMLElement>('[data-new-line="2"]');
      expect(row?.className).toContain("diff-line--pulse");
      vi.runAllTimers();
      expect(row?.className).not.toContain("diff-line--pulse");
    } finally {
      vi.useRealTimers();
    }
  });

  it("cleans up the previous pulse timer when navigation reruns", () => {
    vi.useFakeTimers();
    try {
      const { rerender } = render(<DiffView {...baseProps} navigateTo={{ line: 2, token: 1 }} />);
      const row = document.querySelector<HTMLElement>('[data-new-line="2"]');
      expect(row?.className).toContain("diff-line--pulse");

      vi.advanceTimersByTime(600);
      rerender(<DiffView {...baseProps} navigateTo={{ line: 2, token: 2 }} />);
      expect(row?.className).toContain("diff-line--pulse");

      vi.advanceTimersByTime(600);
      expect(row?.className).toContain("diff-line--pulse");
      vi.advanceTimersByTime(600);
      expect(row?.className).not.toContain("diff-line--pulse");
    } finally {
      vi.useRealTimers();
    }
  });

  it("prefers the old-side line when navigating a snapshot transition", () => {
    let scrolled: Element | null = null;
    Object.defineProperty(Element.prototype, "scrollIntoView", {
      value: function (this: Element) {
        scrolled = this;
      },
      configurable: true,
    });

    render(
      <DiffView
        {...baseProps}
        snapshotDiff={snapshotDiff()}
        transitionAnchors={[{ side: "old", start: 2, end: 2 }]}
        navigateTo={{ line: 2, token: 1 }}
      />,
    );

    expect(scrolled).toBe(document.querySelector('[data-old-line="2"]'));
  });

  it("retries transition navigation when rows mount after the navigation request", () => {
    let scrolled: Element | null = null;
    Object.defineProperty(Element.prototype, "scrollIntoView", {
      value: function (this: Element) {
        scrolled = this;
      },
      configurable: true,
    });
    const navigateTo = { line: 2, token: 1 };
    const { rerender } = render(
      <DiffView {...baseProps} snapshotDiffLoading navigateTo={navigateTo} />,
    );

    expect(scrolled).toBeNull();

    rerender(
      <DiffView
        {...baseProps}
        snapshotDiff={snapshotDiff()}
        transitionAnchors={[{ side: "old", start: 2, end: 2 }]}
        navigateTo={navigateTo}
      />,
    );

    expect(scrolled).toBe(document.querySelector('[data-old-line="2"]'));
  });

  it("retries repository navigation when diff rows mount after the navigation request", () => {
    let scrolled: Element | null = null;
    Object.defineProperty(Element.prototype, "scrollIntoView", {
      value: function (this: Element) {
        scrolled = this;
      },
      configurable: true,
    });
    const navigateTo = { line: 2, token: 1 };
    const { rerender } = render(
      <DiffView {...baseProps} diff={null} isLoading navigateTo={navigateTo} />,
    );

    expect(scrolled).toBeNull();

    rerender(<DiffView {...baseProps} navigateTo={navigateTo} />);

    expect(scrolled).toBe(document.querySelector('[data-new-line="2"]'));
  });

  it("prompts for file selection when no path is chosen", () => {
    render(<DiffView {...baseProps} path={null} diff={null} />);
    expect(screen.getByText("Select a file in the explorer to see its diff.")).toBeTruthy();
  });
});
