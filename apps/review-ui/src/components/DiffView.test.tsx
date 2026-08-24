import { afterEach, describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen } from "@testing-library/react";
import { DiffView } from "./DiffView";
import { ReviewApiError } from "../api";
import type { DecisionAnchor } from "../lib/decision-index";
import type { DiffLine, FileDiff } from "../../../../packages/contracts/src/index";

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

    fireEvent.click(screen.getByText("const added = 3;"));
    expect(onSelectBlock).toHaveBeenCalledWith(null);
  });

  it("shows a dedicated message for binary files", () => {
    render(<DiffView {...baseProps} diff={fileDiff({ binary: true, hunks: [] })} />);
    expect(screen.getByText("Binary files cannot be shown in the diff view.")).toBeTruthy();
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

  it("prompts for file selection when no path is chosen", () => {
    render(<DiffView {...baseProps} path={null} diff={null} />);
    expect(screen.getByText("Select a file in the explorer to see its diff.")).toBeTruthy();
  });
});
