import { describe, expect, it, vi } from "vitest";
import { act, fireEvent, render, screen, waitFor } from "@testing-library/react";
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

const fileBDiff = {
  path: "src/b.ts",
  base_sha: "abc123def4567890",
  old_missing: false,
  new_missing: false,
  binary: false,
  hunks: [
    {
      oldStart: 1,
      newStart: 3,
      lines: [{ type: "add", oldLine: null, newLine: 3, content: "const beta = parse(x);" }],
    },
  ],
};

function summaryFixtureB(): DecisionRecordSummary {
  const base = summaryFixture();
  const target = { ...base.targets[0]!, path: "src/b.ts", content_hash: "hash-b" };
  return { ...base, record_id: "rec-2", session_id: "session-rec-2", targets: [target], judgment: "Cover the parse failure" };
}

function detailFixtureB(): DecisionRecordDetail {
  const summary = summaryFixtureB();
  const target = summary.targets[0]!;
  return {
    record: {
      ...detailFixture().record,
      record_id: "rec-2",
      session_id: "session-rec-2",
      targets: [target],
      judgment: "Cover the parse failure",
    },
    sources: [
      {
        state: "resolved",
        repository_id: "repo-1",
        path: "src/b.ts",
        revision: { kind: "working-tree", contentHash: "hash-b" },
        target,
        content: "const beta = parse(x);",
        content_hash: "hash-b",
      },
    ],
  };
}

function createFetch(hold?: (url: string) => boolean, fail?: (url: string) => boolean) {
  // Recorderと同じく、PATCHで保存されたuser_dispositionを以後のGETが返す。
  // DecisionCardは「サーバー応答を表示してから更新する」契約(Task 6)であり楽順更新を持たないため、
  // 常に古いunreviewedを返すモックではaria-pressedは決してtrueにならない。
  let userDisposition: DecisionRecordDetail["record"]["user_disposition"] = "unreviewed";
  const route = async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
    const url = String(input);
    if (fail?.(url)) return json({ success: false, error: { code: "UNKNOWN", message: "mock failure" } }, 500);
    if (url.endsWith("/v1/repositories")) return json({ success: true, data: [repository] });
    if (url.includes("/v1/decision-records?repository_id=")) return json({ success: true, data: [summaryFixture(), summaryFixtureB()] });
    if (url.endsWith("/v1/repositories/repo-1/files")) return json({ success: true, data: { repository_id: "repo-1", paths: ["src/a.ts", "src/b.ts"] } });
    if (url.startsWith("/v1/repositories/repo-1/diff?")) {
      return url.includes("path=src%2Fb.ts") ? json({ success: true, data: fileBDiff }) : json({ success: true, data: fileDiff });
    }
    if (init?.method === "PATCH") {
      const body = JSON.parse(String(init.body)) as { user_disposition: typeof userDisposition };
      userDisposition = body.user_disposition;
      return json({ success: true, data: detailFixture(userDisposition).record });
    }
    if (url.endsWith("/v1/decision-records/rec-2")) return json({ success: true, data: detailFixtureB() });
    if (url.endsWith("/v1/decision-records/rec-1")) return json({ success: true, data: detailFixture(userDisposition) });
    throw new Error(`unexpected request: ${url}`);
  };
  if (hold === undefined) return vi.fn(route);
  // M31レースのピン留め用:hold(url)が真の間リクエストを保留し、テストが任意のタイミングで解放する。
  const held: Array<{ url: string; response: Response; resolve: (response: Response) => void }> = [];
  const fetchImpl = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    if (!hold(url)) return route(input, init);
    const response = await route(input, init);
    return new Promise<Response>((resolve) => held.push({ url, response, resolve }));
  });
  return Object.assign(fetchImpl, {
    releaseAll(respond?: (url: string) => Response | undefined) {
      for (const request of held.splice(0)) request.resolve(respond?.(request.url) ?? request.response);
    },
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

  it("renders the color-scheme toggle in the connected workspace header", async () => {
    const fetchImpl = createFetch();
    await openWorkspace(fetchImpl);

    expect(screen.getByRole("heading", { name: "Decision review" })).toBeTruthy();
    expect(screen.getByRole("button", { name: "Color scheme" })).toBeTruthy();
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

  it("treats an unresolvable HEAD as a no-base state instead of a recorded-revision error", async () => {
    // コミットが一つもないリポジトリ(spec §4.3-3)。判断はすべてworking-treeなのでbase=HEADになり、
    // Recorderは未誕生HEADに対して404 REVISION_NOT_FOUNDを返す。
    const workingTreeSummary: DecisionRecordSummary = {
      ...summaryFixture(),
      revision: { kind: "working-tree", contentHash: "hash-a" },
      targets: [
        { ...summaryFixture().targets[0]!, revision: { kind: "working-tree", contentHash: "hash-a" } },
      ],
    };
    const route = async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
      const url = String(input);
      if (url.endsWith("/v1/repositories")) return json({ success: true, data: [repository] });
      if (url.includes("/v1/decision-records?repository_id=")) return json({ success: true, data: [workingTreeSummary] });
      if (url.endsWith("/v1/repositories/repo-1/files")) return json({ success: true, data: { repository_id: "repo-1", paths: ["src/a.ts"] } });
      if (url.startsWith("/v1/repositories/repo-1/diff?")) {
        return json({ success: false, error: { code: "REVISION_NOT_FOUND", message: "revision was not found" } }, 404);
      }
      if (url.endsWith("/v1/decision-records/rec-1")) return json({ success: true, data: detailFixture() });
      throw new Error(`unexpected request: ${url}`);
    };
    const fetchImpl = vi.fn(route);
    await openWorkspace(fetchImpl);

    fireEvent.click(screen.getByText("a.ts"));

    expect(fetchImpl).toHaveBeenCalledWith(
      `/v1/repositories/repo-1/diff?${new URLSearchParams({ path: "src/a.ts", base: "HEAD" })}`,
      expect.anything(),
    );
    // エラーカードではなく、解決済みworking-treeソースの全文が見えていること。
    expect(await screen.findByText("const value = input ?? {};")).toBeTruthy();
    expect(screen.queryByText("The recorded revision could not be found.")).toBeNull();
    expect(screen.queryByRole("button", { name: "Retry" })).toBeNull();
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

  it("discards a slow previous file load whose responses land after another file was opened", async () => {
    let holdFileALoad = false;
    const fetchImpl = createFetch((url) => holdFileALoad && (url.includes("/diff?") || url.includes("/decision-records/")));
    await openWorkspace(fetchImpl);

    holdFileALoad = true;
    fireEvent.click(screen.getByText("a.ts"));
    holdFileALoad = false;

    fireEvent.click(screen.getByText("b.ts"));
    expect(await screen.findByRole("heading", { name: "Cover the parse failure" })).toBeTruthy();

    // Aの応答をBの描画完了後に解放する。先行ロードの完了がBの状態を上書きしてはならない。
    fetchImpl.releaseAll();
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 20));
    });

    expect(screen.getByRole("heading", { name: "src/b.ts" })).toBeTruthy();
    expect(screen.getByText("const beta = parse(x);")).toBeTruthy();
    expect(screen.getByRole("heading", { name: "Cover the parse failure" })).toBeTruthy();
    expect(screen.queryByText("const value = input ?? {};")).toBeNull();
    expect(screen.queryByRole("heading", { name: "Guard the empty input" })).toBeNull();
    expect(screen.queryByText("No decisions have been recorded for this file.")).toBeNull();
  });

  it("discards a stale judgment retry that fails after the file was reopened and reloaded", async () => {
    let failRec1Detail = false;
    let holdRec1Detail = false;
    const fetchImpl = createFetch(
      (url) => holdRec1Detail && url.endsWith("/v1/decision-records/rec-1"),
      (url) => failRec1Detail && url.endsWith("/v1/decision-records/rec-1"),
    );
    await openWorkspace(fetchImpl);

    fireEvent.click(screen.getByText("a.ts"));
    await screen.findByRole("heading", { name: "Guard the empty input" });

    failRec1Detail = true;
    fireEvent.click(screen.getByText("a.ts"));
    const retry = await screen.findByRole("button", { name: "Retry rec-1" });

    failRec1Detail = false;
    holdRec1Detail = true;
    fireEvent.click(retry);
    holdRec1Detail = false;

    fireEvent.click(screen.getByText("b.ts"));
    await screen.findByRole("heading", { name: "Cover the parse failure" });
    fireEvent.click(screen.getByText("a.ts"));
    await screen.findByRole("heading", { name: "Guard the empty input" });

    // 再試行の失敗を、再オープン後の正常ロード完了より遅れて届かせる。
    fetchImpl.releaseAll((url) =>
      url.endsWith("/v1/decision-records/rec-1")
        ? json({ success: false, error: { code: "UNKNOWN", message: "late boom" } }, 503)
        : undefined,
    );
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 20));
    });

    expect(screen.getByRole("heading", { name: "Guard the empty input" })).toBeTruthy();
    expect(screen.queryByRole("button", { name: "Retry rec-1" })).toBeNull();
    expect(screen.queryByRole("alert")).toBeNull();
  });
});
