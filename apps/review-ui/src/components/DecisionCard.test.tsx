import { describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { DecisionCard } from "./DecisionCard";
import type { DecisionRecordDetail } from "../api";

const target = {
  repository_id: "repo-1",
  path: "src/feature.ts",
  line_start: 12,
  line_end: 16,
  revision: { kind: "commit" as const, sha: "abc123" },
  content_hash: "expected",
};

const detail: DecisionRecordDetail = {
  record: {
    record_id: "record-1",
    session_id: "session-1",
    repository_id: "repo-1",
    agent_type: "codex",
    revision: { kind: "commit", sha: "abc123" },
    targets: [target],
    judgment: "Needs a guard before accessing the value.",
    rationale: "The caller can pass an empty collection.",
    checks: [
      { name: "Type check", status: "passed", details: "No errors" },
      { name: "Regression test", status: "failed", details: "Missing coverage" },
    ],
    open_questions: ["Should the caller own this validation?"],
    created_at: "2026-08-20T10:00:00.000Z",
    user_disposition: "unreviewed",
  },
  sources: [
    {
      state: "resolved",
      repository_id: "repo-1",
      path: "src/feature.ts",
      revision: { kind: "commit", sha: "abc123" },
      target,
      content: "const value = items[0];",
      content_hash: "expected",
    },
  ],
};

describe("DecisionCard", () => {
  it("renders judgment, target link, rationale, checks, and open questions", () => {
    const onTargetClick = vi.fn();
    render(<DecisionCard detail={detail} onTargetClick={onTargetClick} />);

    expect(screen.getByRole("heading", { name: /needs a guard/i })).toBeTruthy();
    const targetLink = screen.getByRole("button", { name: "src/feature.ts:12–16" });
    expect(targetLink).toBeTruthy();
    fireEvent.click(targetLink);
    expect(onTargetClick).toHaveBeenCalledWith("src/feature.ts", 12);
    expect(screen.getByText("The caller can pass an empty collection.")).toBeTruthy();
    expect(screen.getByText("Type check")).toBeTruthy();
    expect(screen.getByText("Regression test")).toBeTruthy();
    expect(screen.getByText("Should the caller own this validation?")).toBeTruthy();
    expect(screen.queryByRole("alert")).toBeNull();
  });

  it("confirms a disposition before updating the displayed state", async () => {
    const onDispositionChange = vi.fn(async () => ({ ...detail, record: { ...detail.record, user_disposition: "accepted" as const } }));
    render(<DecisionCard detail={detail} onDispositionChange={onDispositionChange} />);

    const accepted = screen.getByRole("button", { name: "Accept" });
    fireEvent.click(accepted);
    expect(accepted.getAttribute("aria-pressed")).toBe("false");
    await waitFor(() => expect(accepted.getAttribute("aria-pressed")).toBe("true"));
    expect(onDispositionChange).toHaveBeenCalledWith("accepted");
  });

  it("keeps the current disposition and shows an alert when the mutation fails", async () => {
    const onDispositionChange = vi.fn(async () => {
      throw new Error("Recorder unavailable");
    });
    render(<DecisionCard detail={detail} onDispositionChange={onDispositionChange} />);

    const rejected = screen.getByRole("button", { name: "Reject" });
    fireEvent.click(rejected);
    await waitFor(() => expect(screen.getByRole("alert").textContent).toContain("Recorder unavailable"));
    expect(rejected.getAttribute("aria-pressed")).toBe("false");
    expect(screen.getByRole("button", { name: "Mark unreviewed" }).getAttribute("aria-pressed")).toBe("true");
  });

  it.each([
    ["hash-mismatch", "Source changed since the decision"],
    ["revision-not-found", "The recorded revision is no longer available"],
    ["source-unavailable", "Source is unavailable"],
  ] as const)("warns on an unresolved %s source without showing code", (state, message) => {
    const warned: DecisionRecordDetail = {
      ...detail,
      sources: [{
        state,
        repository_id: "repo-1",
        path: "src/feature.ts",
        revision: { kind: "working-tree", contentHash: "h1" },
        target: { ...target, revision: { kind: "working-tree", contentHash: "h1" } },
        expected_hash: "expected",
        actual_hash: state === "hash-mismatch" ? "actual" : undefined,
      }],
    };
    render(<DecisionCard detail={warned} />);

    const alert = screen.getAllByRole("alert").at(-1)!;
    expect(alert.textContent).toContain(message);
    expect(alert.textContent).toContain("expected");
    expect(screen.queryByText(/const value/)).toBeNull();
  });
});
