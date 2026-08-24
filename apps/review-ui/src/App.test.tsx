import { describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { App } from "./App";
import { ReviewApi, type DecisionRecordDetail, type DecisionRecordSummary } from "./api";

const repository = { repository_id: "repo-1", root: "/work/repo-one", created_at: "2026-08-22T00:00:00.000Z" };

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });
}

function summaryFixture(): DecisionRecordSummary {
  return {
    record_id: "rec-1",
    session_id: "session-rec-1",
    repository_id: "repo-1",
    agent_type: "codex",
    revision: { kind: "commit", sha: "abc123" },
    targets: [
      {
        repository_id: "repo-1",
        path: "src/a.ts",
        line_start: 2,
        line_end: 2,
        revision: { kind: "commit", sha: "abc123" },
        content_hash: "hash-a",
      },
    ],
    judgment: "Guard the empty input",
    created_at: "2026-08-20T10:00:00.000Z",
    user_disposition: "unreviewed",
  };
}

function detailFixture(user_disposition: DecisionRecordDetail["record"]["user_disposition"] = "unreviewed"): DecisionRecordDetail {
  const target = summaryFixture().targets[0]!;
  return {
    record: {
      record_id: "rec-1",
      session_id: "session-rec-1",
      repository_id: "repo-1",
      agent_type: "codex",
      revision: { kind: "commit", sha: "abc123" },
      targets: [target],
      judgment: "Guard the empty input",
      rationale: "",
      checks: [],
      open_questions: [],
      created_at: "2026-08-20T10:00:00.000Z",
      user_disposition,
    },
    sources: [
      {
        state: "resolved",
        repository_id: "repo-1",
        path: "src/a.ts",
        // 検証済みworking-treeソースは新側にアンカーする(spec §5 / targetAnchor)。
        // commit-revisionソースだと旧側固定のため、このdiffには旧2行目が存在しない。
        revision: { kind: "working-tree", contentHash: "hash-a" },
        target,
        content: "const value = input ?? {};",
        content_hash: "hash-a",
      },
    ],
  };
}

const fileDiff = {
  path: "src/a.ts",
  base_sha: "abc123def4567890",
  old_missing: false,
  new_missing: false,
  binary: false,
  hunks: [
    {
      oldStart: 1,
      newStart: 1,
      lines: [
        { type: "context", oldLine: 1, newLine: 1, content: "const head = 0;" },
        { type: "add", oldLine: null, newLine: 2, content: "const value = input ?? {};" },
      ],
    },
  ],
};

function createFetch() {
  // Recorderと同じく、PATCHで保存されたuser_dispositionを以後のGETが返す。
  // DecisionCardは「サーバー応答を表示してから更新する」契約(Task 6)であり楽順更新を持たないため、
  // 常に古いunreviewedを返すモックではaria-pressedは決してtrueにならない。
  let userDisposition: DecisionRecordDetail["record"]["user_disposition"] = "unreviewed";
  return vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    if (url.endsWith("/v1/repositories")) return json({ success: true, data: [repository] });
    if (url.includes("/v1/decision-records?repository_id=")) return json({ success: true, data: [summaryFixture()] });
    if (url.endsWith("/v1/repositories/repo-1/files")) return json({ success: true, data: { repository_id: "repo-1", paths: ["src/a.ts", "src/b.ts"] } });
    if (url.startsWith("/v1/repositories/repo-1/diff?")) return json({ success: true, data: fileDiff });
    if (init?.method === "PATCH") {
      const body = JSON.parse(String(init.body)) as { user_disposition: typeof userDisposition };
      userDisposition = body.user_disposition;
      return json({ success: true, data: detailFixture(userDisposition).record });
    }
    if (url.endsWith("/v1/decision-records/rec-1")) return json({ success: true, data: detailFixture(userDisposition) });
    throw new Error(`unexpected request: ${url}`);
  });
}

async function openWorkspace(fetchImpl: ReturnType<typeof createFetch>) {
  render(<App apiFactory={(token) => new ReviewApi(token, { fetchImpl })} />);

  fireEvent.change(screen.getByLabelText("Owner bearer token"), { target: { value: "owner-token" } });
  fireEvent.submit(screen.getByRole("button", { name: "Load repositories" }).closest("form")!);

  const picker = await screen.findByLabelText("Repository");
  fireEvent.change(picker, { target: { value: "repo-1" } });
  fireEvent.submit(screen.getByRole("button", { name: "Open review timeline" }).closest("form")!);

  await screen.findByRole("navigation", { name: "Repository explorer" });
}

describe("App", () => {
  it("moves from bootstrap to the workspace with owner-token headers only in memory", async () => {
    const fetchImpl = createFetch();
    await openWorkspace(fetchImpl);

    expect(fetchImpl).toHaveBeenCalledWith("/v1/repositories", expect.objectContaining({
      headers: expect.objectContaining({ Authorization: "Bearer owner-token" }),
    }));
    expect(screen.getByText("/work/repo-one")).toBeTruthy();
  });

  it("fetches the diff and linked decisions together when a file is opened and anchors verified lines", async () => {
    const fetchImpl = createFetch();
    await openWorkspace(fetchImpl);

    fireEvent.click(screen.getByText("a.ts"));

    expect(await screen.findByRole("heading", { name: "Guard the empty input" })).toBeTruthy();
    expect(fetchImpl).toHaveBeenCalledWith(
      `/v1/repositories/repo-1/diff?${new URLSearchParams({ path: "src/a.ts", base: "abc123" })}`,
      expect.anything(),
    );
    expect(fetchImpl).toHaveBeenCalledWith("/v1/decision-records/rec-1", expect.objectContaining({
      headers: expect.objectContaining({ Authorization: "Bearer owner-token" }),
    }));
    await waitFor(() => {
      expect(document.querySelector<HTMLElement>('[data-new-line="2"]')?.className).toContain("diff-line--anchored");
    });
  });

  it("updates a disposition from the judgment card", async () => {
    const fetchImpl = createFetch();
    await openWorkspace(fetchImpl);

    fireEvent.click(screen.getByText("a.ts"));
    const accept = await screen.findByRole("button", { name: "Accept" });
    fireEvent.click(accept);
    await waitFor(() => expect(accept.getAttribute("aria-pressed")).toBe("true"));
    expect(fetchImpl).toHaveBeenCalledWith("/v1/decision-records/rec-1/disposition", expect.objectContaining({ method: "PATCH" }));
  });

  it("returns to bootstrap when clearing the session", async () => {
    const fetchImpl = createFetch();
    await openWorkspace(fetchImpl);

    fireEvent.click(screen.getByRole("button", { name: "Clear session" }));
    expect(screen.getByLabelText("Owner bearer token")).toBeTruthy();
  });
});
