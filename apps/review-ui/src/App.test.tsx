import { describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { App } from "./App";
import { ReviewApi, ReviewApiError, type DecisionRecordDetail, type DecisionRecordSummary } from "./api";

function summary(recordId: string, judgment: string): DecisionRecordSummary {
  return {
    record_id: recordId,
    session_id: `session-${recordId}`,
    repository_id: "repo-1",
    agent_type: "codex",
    revision: { kind: "commit", sha: "abc123" },
    targets: [],
    judgment,
    created_at: "2026-08-20T10:00:00.000Z",
    user_disposition: "unreviewed",
  };
}

function detail(record: DecisionRecordSummary): DecisionRecordDetail {
  return {
    record: {
      ...record,
      targets: [],
      rationale: "Recorded rationale",
      checks: [],
      open_questions: [],
    },
    sources: [],
  };
}

describe("App", () => {
  it("loads repositories after token entry and opens the timeline for the selected repository", async () => {
    const records = [summary("record-1", "First judgment"), summary("record-2", "Second judgment")];
    const fakeApi = {
      listRepositories: vi.fn(async () => [
        { repository_id: "repo-1", root: "/work/repo-one", created_at: "2026-08-22T00:00:00.000Z" },
        { repository_id: "repo-2", root: "/work/repo-two", created_at: "2026-08-22T01:00:00.000Z" },
      ]),
      listDecisions: vi.fn(async () => records),
      getDecision: vi.fn(async (recordId: string) => detail(records.find((record) => record.record_id === recordId)!)),
    } as unknown as ReviewApi;
    const apiFactory = vi.fn(() => fakeApi);
    render(<App apiFactory={apiFactory} />);

    fireEvent.change(screen.getByLabelText("Owner bearer token"), { target: { value: "owner-token" } });
    fireEvent.click(screen.getByRole("button", { name: "Load repositories" }));

    await waitFor(() => expect(screen.getByLabelText("Repository")).toBeTruthy());
    fireEvent.change(screen.getByLabelText("Repository"), { target: { value: "repo-1" } });
    fireEvent.submit(screen.getByRole("button", { name: "Open review timeline" }).closest("form")!);

    await waitFor(() => expect(screen.getByRole("heading", { name: "First judgment" })).toBeTruthy());
    expect(fakeApi.listDecisions).toHaveBeenCalledWith("repo-1");
    fireEvent.click(screen.getByRole("button", { name: /Second judgment/ }));
    await waitFor(() => expect(screen.getByRole("heading", { name: "Second judgment" })).toBeTruthy());
    expect(fakeApi.getDecision).toHaveBeenCalledWith("record-2");
  });

  it("shows an explicit token or recorder error before any repository is selectable", async () => {
    const apiFactory = vi.fn(() => ({
      listRepositories: vi.fn(async () => {
        throw new ReviewApiError("owner bearer token is required", { code: "UNAUTHORIZED", status: 401 });
      }),
    }) as unknown as ReviewApi);
    render(<App apiFactory={apiFactory} />);

    fireEvent.change(screen.getByLabelText("Owner bearer token"), { target: { value: "wrong-token" } });
    fireEvent.click(screen.getByRole("button", { name: "Load repositories" }));

    await waitFor(() => expect(screen.getByRole("alert").textContent).toContain("Owner token required"));
    expect(screen.queryByRole("heading", { name: "Review timeline" })).toBeNull();
  });
});
