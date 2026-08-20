import { describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { DecisionDetail } from "./DecisionDetail";
import type { DecisionRecordDetail } from "../api";

const detail: DecisionRecordDetail = {
  record: {
    record_id: "record-1",
    session_id: "session-1",
    repository_id: "repo-1",
    agent_type: "codex",
    revision: { kind: "commit", sha: "abc123" },
    targets: [
      {
        repository_id: "repo-1",
        path: "src/feature.ts",
        line_start: 12,
        line_end: 16,
        revision: { kind: "commit", sha: "abc123" },
        content_hash: "expected",
      },
    ],
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
      target: detailTarget(),
      content: "const value = items[0];\nreturn value;",
      content_hash: "expected",
    },
  ],
};

function detailTarget() {
  return {
    repository_id: "repo-1",
    path: "src/feature.ts",
    line_start: 12,
    line_end: 16,
    revision: { kind: "commit" as const, sha: "abc123" },
    content_hash: "expected",
  };
}

describe("DecisionDetail", () => {
  it("renders the judgment, target, rationale, checks, and open questions together", () => {
    render(<DecisionDetail detail={detail} />);

    expect(screen.getByRole("heading", { name: /needs a guard/i })).toBeTruthy();
    expect(screen.getByText("src/feature.ts:12–16")).toBeTruthy();
    expect(screen.getByText("The caller can pass an empty collection.")).toBeTruthy();
    expect(screen.getByText("Type check")).toBeTruthy();
    expect(screen.getByText("Regression test")).toBeTruthy();
    expect(screen.getByText("Should the caller own this validation?")).toBeTruthy();
  });

  it("confirms a disposition before updating the displayed selection", async () => {
    const onDispositionChange = vi.fn(async () => ({ ...detail, record: { ...detail.record, user_disposition: "accepted" as const } }));
    render(<DecisionDetail detail={detail} onDispositionChange={onDispositionChange} />);

    const accepted = screen.getByRole("button", { name: "Accept" });
    fireEvent.click(accepted);
    expect(accepted.getAttribute("aria-pressed")).toBe("false");
    await waitFor(() => expect(accepted.getAttribute("aria-pressed")).toBe("true"));
    expect(onDispositionChange).toHaveBeenCalledWith("accepted");
  });
  it("does not change the displayed disposition when the mutation has no confirmed detail", async () => {
    const onDispositionChange = vi.fn(async () => undefined);
    render(<DecisionDetail detail={detail} onDispositionChange={onDispositionChange} />);

    const accepted = screen.getByRole("button", { name: "Accept" });
    const controls = accepted.closest("fieldset");
    fireEvent.click(accepted);
    await waitFor(() => expect(onDispositionChange).toHaveBeenCalledWith("accepted"));
    await waitFor(() => expect(controls?.hasAttribute("disabled")).toBe(false));
    expect(accepted.getAttribute("aria-pressed")).toBe("false");
    expect(screen.getByRole("button", { name: "Mark unreviewed" }).getAttribute("aria-pressed")).toBe("true");
  });

  it("keeps the current disposition and shows an error when mutation fails", async () => {
    const onDispositionChange = vi.fn(async () => {
      throw new Error("Recorder unavailable");
    });
    render(<DecisionDetail detail={detail} onDispositionChange={onDispositionChange} />);

    const rejected = screen.getByRole("button", { name: "Reject" });
    fireEvent.click(rejected);
    await waitFor(() => expect(screen.getByRole("alert").textContent).toContain("Recorder unavailable"));
    expect(rejected.getAttribute("aria-pressed")).toBe("false");
    expect(screen.getByRole("button", { name: "Mark unreviewed" }).getAttribute("aria-pressed")).toBe("true");
  });
});
