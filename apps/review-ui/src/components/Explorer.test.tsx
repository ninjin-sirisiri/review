import { describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen } from "@testing-library/react";
import { Explorer } from "./Explorer";
import type { FileTreeNode } from "../lib/file-tree";

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
          node({ name: "api.ts", path: "src/api.ts", isFile: true, decisionCount: 2 }),
          node({ name: "util.ts", path: "src/util.ts", isFile: true }),
        ],
      }),
      node({ name: "README.md", path: "README.md", isFile: true, decisionCount: 1 }),
    ],
  });
}

const baseProps = {
  tree: treeFixture(),
  selectedPath: null,
  isLoading: false,
  error: null,
  onRetry: vi.fn(),
  onOpenFile: vi.fn(),
};

describe("Explorer", () => {
  it("renders nested directories and files from the tree root", () => {
    render(<Explorer {...baseProps} />);

    expect(screen.getByRole("button", { name: /src/ })).toBeTruthy();
    expect(screen.getByRole("button", { name: /api\.ts/ })).toBeTruthy();
    expect(screen.getByRole("button", { name: /util\.ts/ })).toBeTruthy();
    expect(screen.getByRole("button", { name: /README\.md/ })).toBeTruthy();
  });

  it("opens a file and reports its full path on click", () => {
    const onOpenFile = vi.fn();
    render(<Explorer {...baseProps} onOpenFile={onOpenFile} />);

    fireEvent.click(screen.getByText("api.ts"));
    expect(onOpenFile).toHaveBeenCalledWith("src/api.ts");
  });

  it("marks the selected file with aria-current", () => {
    render(<Explorer {...baseProps} selectedPath="src/api.ts" />);

    const selected = screen.getByText("api.ts").closest("button");
    expect(selected?.getAttribute("aria-current")).toBe("true");
    const other = screen.getByText("README.md").closest("button");
    expect(other?.getAttribute("aria-current")).toBeNull();
  });

  it("collapses and re-expands a directory on click", () => {
    render(<Explorer {...baseProps} />);

    fireEvent.click(screen.getByRole("button", { name: /src/ }));
    expect(screen.queryByText("api.ts")).toBeNull();
    expect(screen.queryByText("util.ts")).toBeNull();

    fireEvent.click(screen.getByRole("button", { name: /src/ }));
    expect(screen.getByText("api.ts")).toBeTruthy();
  });

  it("shows decision count badges only for files with decisions", () => {
    render(<Explorer {...baseProps} />);

    const apiButton = screen.getByText("api.ts").closest("button");
    expect(apiButton?.querySelector(".explorer__badge")?.textContent).toBe("2");
    const readmeButton = screen.getByText("README.md").closest("button");
    expect(readmeButton?.querySelector(".explorer__badge")?.textContent).toBe("1");
    const utilButton = screen.getByText("util.ts").closest("button");
    expect(utilButton?.querySelector(".explorer__badge")).toBeNull();
  });

  it("names files with their decision counts for assistive tech", () => {
    render(<Explorer {...baseProps} />);

    expect(screen.getByRole("button", { name: "api.ts, 2 decisions" })).toBeTruthy();
    expect(screen.getByRole("button", { name: "README.md, 1 decision" })).toBeTruthy();
    expect(screen.getByRole("button", { name: "util.ts" })).toBeTruthy();
  });

  it("filters the tree to files that have judgments", () => {
    render(<Explorer {...baseProps} />);

    fireEvent.click(screen.getByRole("button", { name: "With judgments" }));
    expect(screen.getByRole("button", { name: "With judgments" }).getAttribute("aria-pressed")).toBe("true");
    expect(screen.getByText("api.ts")).toBeTruthy();
    expect(screen.getByText("README.md")).toBeTruthy();
    expect(screen.queryByText("util.ts")).toBeNull();
  });

  it("shows the loading state", () => {
    render(<Explorer {...baseProps} isLoading tree={node({ name: "", path: "", isFile: false })} />);
    expect(screen.getByRole("status").textContent).toContain("Loading repository tree");
  });

  it("shows a pane-level error with retry when listing files fails", () => {
    const onRetry = vi.fn();
    render(<Explorer {...baseProps} error={new Error("Recorder request failed")} onRetry={onRetry} />);

    expect(screen.getByRole("alert").textContent).toContain("Recorder request failed");
    fireEvent.click(screen.getByRole("button", { name: "Retry" }));
    expect(onRetry).toHaveBeenCalled();
  });

  it("shows an empty state for a repository without tracked files", () => {
    render(<Explorer {...baseProps} tree={node({ name: "", path: "", isFile: false })} />);
    expect(screen.getByText("No tracked files found.")).toBeTruthy();
  });
});
