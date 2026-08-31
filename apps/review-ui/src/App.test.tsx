import { describe, expect, it, vi } from "vitest";
import { act, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { App, currentPathEvidence } from "./App";
import type { JudgmentEntry } from "./components/JudgmentPanel";
import { ReviewApi, type DecisionRecordDetail, type DecisionRecordSummary } from "./api";
import type { SnapshotDiffResponse } from "../../../packages/contracts/src/index";

const repository = { repository_id: "repo-1", root: "/work/repo-one", created_at: "2026-08-22T00:00:00.000Z" };

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });
}

function deferred<T>() {
  let resolve!: (value: T | PromiseLike<T>) => void;
  const promise = new Promise<T>((resolvePromise) => {
    resolve = resolvePromise;
  });
  return { promise, resolve };
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

function retryDetailFixture(): DecisionRecordDetail {
  const base = detailFixture();
  return {
    ...base,
    sources: base.sources.map((source) => source.state === "resolved"
      ? { ...source, content: "const head = 0;\nconst value = input ?? {};" }
      : source),
  };
}

function multiTargetDetailFixture(): DecisionRecordDetail {
  const base = detailFixture();
  const selectedTarget = { ...base.record.targets[0]!, revision: { kind: "commit" as const, sha: "abc123" } };
  const otherTarget = {
    ...selectedTarget,
    path: "src/b.ts",
    line_start: 7,
    line_end: 7,
    revision: { kind: "working-tree" as const, contentHash: "hash-b" },
    content_hash: "hash-b",
  };
  return {
    ...base,
    record: { ...base.record, targets: [selectedTarget, otherTarget] },
    sources: [
      {
        state: "resolved",
        repository_id: "repo-1",
        path: "src/b.ts",
        revision: otherTarget.revision,
        target: otherTarget,
        content: "const wrong = true;",
        content_hash: "hash-b",
      },
      {
        state: "hash-mismatch",
        repository_id: "repo-1",
        path: "src/a.ts",
        revision: selectedTarget.revision,
        target: selectedTarget,
        expected_hash: "hash-a",
        actual_hash: "changed-a",
        message: "source changed",
      },
    ],
  };
}

function multiPathSummaryFixture(): DecisionRecordSummary {
  const base = summaryFixture();
  const target = base.targets[0]!;
  const otherTarget = {
    ...target,
    path: "src/b.ts",
    line_start: 7,
    line_end: 7,
    revision: { kind: "working-tree" as const, contentHash: "hash-b" },
    content_hash: "hash-b",
  };
  return { ...base, targets: [target, otherTarget] };
}

function multiPathDetailFixture(content: string): DecisionRecordDetail {
  const base = detailFixture();
  const source = base.sources[0];
  if (source === undefined || source.state !== "resolved") throw new Error("The fixture must contain a resolved source");
  const target = base.record.targets[0]!;
  const otherTarget = {
    ...target,
    path: "src/b.ts",
    line_start: 7,
    line_end: 7,
    revision: { kind: "working-tree" as const, contentHash: "hash-b" },
    content_hash: "hash-b",
  };
  return {
    ...base,
    record: { ...base.record, targets: [target, otherTarget] },
    sources: [
      { ...source, target },
      { ...source, path: "src/b.ts", revision: otherTarget.revision, target: otherTarget, content, content_hash: "hash-b" },
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

const snapshotTransition: Extract<SnapshotDiffResponse, { state: "snapshot-resolved" }> = {
  state: "snapshot-resolved",
  path: "src/a.ts",
  from: {
    kind: "snapshot",
    snapshot_id: "snapshot-before",
    record_id: "rec-1",
    created_at: "2026-08-20T10:00:00.000Z",
    content_hash: "hash-a",
    source_path: "src/a.ts",
    base_sha: "before1234567890",
  },
  to: {
    kind: "snapshot",
    snapshot_id: "snapshot-next",
    record_id: "rec-2",
    created_at: "2026-08-20T11:00:00.000Z",
    content_hash: "hash-next",
    source_path: "src/a.ts",
    base_sha: "next1234567890",
  },
  hunks: [
    {
      oldStart: 1,
      newStart: 1,
      lines: [
        { type: "context", oldLine: 1, newLine: 1, content: "const head = 0;" },
        { type: "del", oldLine: 2, newLine: null, content: "const value = before;" },
        { type: "add", oldLine: null, newLine: 2, content: "const value = after;" },
      ],
    },
  ],
  old_missing: false,
  new_missing: false,
  binary: false,
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

const defaultBranchList = {
  repository_id: "repo-1",
  head_branch: "main",
  branches: [{ name: "main", sha: "a".repeat(40) }],
};

const twoBranchList = {
  repository_id: "repo-1",
  head_branch: "main",
  branches: [
    { name: "feat/x", sha: "1".repeat(40) },
    { name: "main", sha: "2".repeat(40) },
  ],
};

function requestPath(url: string): string {
  return url.split("?")[0] ?? url;
}

function createFetch(
  hold?: (url: string) => boolean,
  fail?: (url: string) => boolean,
  snapshotResponse?: (url: string) => Response | undefined,
  overrideResponse?: (url: string, init?: RequestInit) => Response | undefined,
  branchList = defaultBranchList,
) {
  // Recorderと同じく、PATCHで保存されたuser_dispositionを以後のGETが返す。
  // DecisionCardは「サーバー応答を表示してから更新する」契約(Task 6)であり楽順更新を持たないため、
  // 常に古いunreviewedを返すモックではaria-pressedは決してtrueにならない。
  let userDisposition: DecisionRecordDetail["record"]["user_disposition"] = "unreviewed";
  const route = async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
    const url = String(input);
    if (fail?.(url)) return json({ success: false, error: { code: "UNKNOWN", message: "mock failure" } }, 500);
    const override = overrideResponse?.(url, init);
    if (override !== undefined) return override;
    if (url.endsWith("/v1/repositories")) return json({ success: true, data: [repository] });
    if (url.includes("/v1/decision-records?repository_id=")) return json({ success: true, data: [summaryFixture(), summaryFixtureB()] });
    if (url.endsWith("/v1/repositories/repo-1/branches")) {
      return json({ success: true, data: branchList });
    }
    if (requestPath(url).endsWith("/v1/repositories/repo-1/files")) {
      return json({ success: true, data: { repository_id: "repo-1", view: { kind: "working-tree" }, paths: ["src/a.ts", "src/b.ts"] } });
    }
    if (url.startsWith("/v1/repositories/repo-1/diff?")) {
      return url.includes("path=src%2Fb.ts") ? json({ success: true, data: fileBDiff }) : json({ success: true, data: fileDiff });
    }
    if (url.includes("/v1/decision-records/") && url.includes("/snapshot-diff?")) {
      return snapshotResponse?.(url) ?? json({
        success: true,
        data: {
          state: "legacy-fallback",
          reason: "automatic-snapshot-not-found",
          path: url.includes("path=src%2Fb.ts") ? "src/b.ts" : "src/a.ts",
        },
      });
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
    releaseOne(respond?: (url: string) => Response | undefined) {
      const request = held.shift();
      if (request !== undefined) request.resolve(respond?.(request.url) ?? request.response);
    },
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
    expect(screen.queryByLabelText("Review view")).toBeNull();
  });

  it("recovers from an empty repository response without reloading", async () => {
    let repositoryCalls = 0;
    const fetchImpl = createFetch(undefined, undefined, undefined, (url) => {
      if (!url.endsWith("/v1/repositories")) return undefined;
      repositoryCalls += 1;
      return json({ success: true, data: repositoryCalls === 1 ? [] : [repository] });
    });
    render(<App apiFactory={(token) => new ReviewApi(token, { fetchImpl })} />);

    const token = screen.getByLabelText("Owner bearer token");
    fireEvent.change(token, { target: { value: "empty-token" } });
    fireEvent.submit(token.closest("form")!);

    expect((await screen.findByRole("status")).textContent).toContain("No registered repositories");
    fireEvent.click(screen.getByRole("button", { name: "Use another token" }));

    const replacementToken = screen.getByLabelText("Owner bearer token");
    expect(replacementToken).toHaveProperty("value", "");
    fireEvent.change(replacementToken, { target: { value: "replacement-token" } });
    fireEvent.submit(replacementToken.closest("form")!);

    expect(await screen.findByLabelText("Repository")).toBeTruthy();
    expect(screen.getByText("/work/repo-one")).toBeTruthy();
    expect(repositoryCalls).toBe(2);
  });

  it("renders the color-scheme toggle in the connected workspace header", async () => {
    const fetchImpl = createFetch();
    await openWorkspace(fetchImpl);

    expect(screen.getByRole("heading", { name: "Decision review" })).toBeTruthy();
    expect(screen.getByRole("link", { name: "Skip to workspace" })).toBeTruthy();
    expect(document.querySelector(".app-header__progress")?.textContent).toMatch(/\d+ unreviewed of \d+/);
    expect(screen.getByRole("button", { name: /Color scheme/ })).toBeTruthy();
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

  it("fetches and renders a selected judgment snapshot transition for the current path", async () => {
    const fetchImpl = createFetch(undefined, undefined, (url) =>
      url.includes("/v1/decision-records/rec-1/snapshot-diff?")
        ? json({ success: true, data: snapshotTransition })
        : undefined,
    );
    await openWorkspace(fetchImpl);

    fireEvent.click(screen.getByText("a.ts"));
    await screen.findByRole("heading", { name: "Guard the empty input" });
    expect(screen.queryByText("before snapshot")).toBeNull();

    fireEvent.click(screen.getByRole("button", { name: "View subsequent changes" }));

    expect(await screen.findByText("before snapshot")).toBeTruthy();
    expect(screen.getByText("const value = after;")).toBeTruthy();
    expect(fetchImpl).toHaveBeenCalledWith(
      "/v1/decision-records/rec-1/snapshot-diff?path=src%2Fa.ts",
      expect.anything(),
    );
  });

  it("retries a failed selected judgment transition without toggling it off", async () => {
    let snapshotCalls = 0;
    const fetchImpl = createFetch(undefined, undefined, () => {
      snapshotCalls += 1;
      return snapshotCalls === 1
        ? json({ success: false, error: { code: "SOURCE_UNAVAILABLE", message: "snapshot unavailable" } }, 503)
        : json({ success: true, data: snapshotTransition });
    });
    await openWorkspace(fetchImpl);

    fireEvent.click(screen.getByText("a.ts"));
    await screen.findByRole("heading", { name: "Guard the empty input" });
    fireEvent.click(screen.getByRole("button", { name: "View subsequent changes" }));
    expect(await screen.findByText("snapshot unavailable")).toBeTruthy();
    expect(snapshotCalls).toBe(1);

    fireEvent.click(screen.getByRole("button", { name: "Retry" }));

    expect(await screen.findByText("before snapshot")).toBeTruthy();
    expect(snapshotCalls).toBe(2);
    expect(screen.getByRole("button", { name: "Viewing subsequent changes" }).getAttribute("aria-pressed")).toBe("true");
  });

  it.each([
    ["the response path", (value: typeof snapshotTransition) => ({ ...value, path: "src/b.ts" })],
    ["the source record identity", (value: typeof snapshotTransition) => ({ ...value, from: { ...value.from, record_id: "rec-2" } })],
    ["the source path identity", (value: typeof snapshotTransition) => ({ ...value, from: { ...value.from, source_path: "src/b.ts" } })],
    ["the destination path identity", (value: typeof snapshotTransition) => ({
      ...value,
      to: {
        kind: "snapshot" as const,
        snapshot_id: "snapshot-next",
        record_id: "rec-2",
        created_at: "2026-08-20T11:00:00.000Z",
        content_hash: "next-hash",
        source_path: "src/b.ts",
      },
    })],
  ] as const)("rejects a transition with mismatched %s without showing repository full text", async (_label, mutate) => {
    const repositorySource = "repository-only correlation source";
    const fetchImpl = createFetch(
      undefined,
      undefined,
      (url) => url.includes("/v1/decision-records/rec-1/snapshot-diff?")
        ? json({ success: true, data: mutate(snapshotTransition) })
        : undefined,
      (url) => {
        if (url.startsWith("/v1/repositories/repo-1/diff?")) {
          return json({ success: true, data: { ...fileDiff, hunks: [] } });
        }
        if (url.endsWith("/v1/decision-records/rec-1")) {
          const detail = detailFixture();
          return json({
            success: true,
            data: {
              ...detail,
              sources: detail.sources.map((source) => source.state === "resolved"
                ? { ...source, content: repositorySource }
                : source),
            },
          });
        }
        return undefined;
      },
    );
    await openWorkspace(fetchImpl);

    fireEvent.click(screen.getByText("a.ts"));
    await screen.findByRole("heading", { name: "Guard the empty input" });
    expect(await screen.findByText(repositorySource)).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "View subsequent changes" }));

    expect((await screen.findByRole("alert")).textContent).toContain("does not match the requested snapshot transition");
    expect(screen.getByRole("button", { name: "Retry" })).toBeTruthy();
     expect(screen.queryByText(repositorySource)).toBeNull();
  });

  it.each([
    ["legacy fallback", { state: "legacy-fallback" as const, reason: "automatic-snapshot-not-found" as const, path: "src/b.ts" }],
    ["source-unavailable", { state: "source-unavailable" as const, path: "src/b.ts", message: "snapshot source unavailable" }],
    ["revision-not-found", { state: "revision-not-found" as const, path: "src/b.ts", message: "snapshot revision unavailable" }],
  ] as const)("rejects a wrong-path %s response without showing repository full text", async (_label, data) => {
    const repositorySource = "repository-only wrong-path response source";
    const fetchImpl = createFetch(
      undefined,
      undefined,
      () => json({ success: true, data }),
      (url) => {
        if (url.startsWith("/v1/repositories/repo-1/diff?")) {
          return json({ success: true, data: { ...fileDiff, hunks: [] } });
        }
        if (url.endsWith("/v1/decision-records/rec-1")) {
          const detail = detailFixture();
          return json({
            success: true,
            data: {
              ...detail,
              sources: detail.sources.map((source) => source.state === "resolved"
                ? { ...source, content: repositorySource }
                : source),
            },
          });
        }
        return undefined;
      },
    );
    await openWorkspace(fetchImpl);

    fireEvent.click(screen.getByText("a.ts"));
    await screen.findByRole("heading", { name: "Guard the empty input" });
    expect(await screen.findByText(repositorySource)).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "View subsequent changes" }));

    expect((await screen.findByRole("alert")).textContent).toContain("does not match the requested snapshot transition");
    expect(screen.getByRole("button", { name: "Retry" })).toBeTruthy();
    expect(screen.queryByText(repositorySource)).toBeNull();
  });

  it.each([
    ["source-unavailable", "snapshot source unavailable"],
    ["revision-not-found", "snapshot revision unavailable"],
  ] as const)("shows a successful %s transition response as a retryable central error", async (state, message) => {
    let snapshotCalls = 0;
    const repositorySource = "repository-only transition source";
    const fetchImpl = createFetch(undefined, undefined, () => {
      snapshotCalls += 1;
      return snapshotCalls === 1
        ? json({ success: true, data: { state, path: "src/a.ts", message } })
        : json({ success: true, data: snapshotTransition });
    }, (url) => {
      if (url.startsWith("/v1/repositories/repo-1/diff?")) {
        return json({ success: true, data: { ...fileDiff, hunks: [] } });
      }
      if (url.endsWith("/v1/decision-records/rec-1")) {
        const detail = detailFixture();
        return json({
          success: true,
          data: {
            ...detail,
            sources: detail.sources.map((source) => source.state === "resolved"
              ? { ...source, content: repositorySource }
              : source),
          },
        });
      }
      return undefined;
    });
    await openWorkspace(fetchImpl);

    fireEvent.click(screen.getByText("a.ts"));
    await screen.findByRole("heading", { name: "Guard the empty input" });
    expect(await screen.findByText(repositorySource)).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "View subsequent changes" }));

    expect((await screen.findByRole("alert")).textContent).toContain(message);
    expect(screen.getByRole("button", { name: "Retry" })).toBeTruthy();
    expect(screen.queryByText(repositorySource)).toBeNull();
    expect(snapshotCalls).toBe(1);

    fireEvent.click(screen.getByRole("button", { name: "Retry" }));

    expect(await screen.findByText("before snapshot")).toBeTruthy();
    expect(snapshotCalls).toBe(2);
    expect(screen.queryByText(repositorySource)).toBeNull();
  });

  it("scopes derived source content to the selected path for a multi-target record", async () => {
    const fetchImpl = createFetch(undefined, undefined, undefined, (url) => {
      if (url.startsWith("/v1/repositories/repo-1/diff?") && url.includes("path=src%2Fa.ts")) {
        return json({ success: true, data: { ...fileDiff, hunks: [] } });
      }
      if (url.endsWith("/v1/decision-records/rec-1")) {
        return json({ success: true, data: multiTargetDetailFixture() });
      }
      return undefined;
    });
    await openWorkspace(fetchImpl);

    fireEvent.click(screen.getByText("a.ts"));

    expect(await screen.findByText("Source changed since the decision")).toBeTruthy();
    expect(screen.queryByText("const wrong = true;")).toBeNull();
    expect(screen.getByText("No changes between the recorded revision and the working tree.")).toBeTruthy();
  });

  it("scopes block filtering anchors to the selected path", async () => {
    const pathScopedDiff = {
      ...fileDiff,
      hunks: [{
        oldStart: 7,
        newStart: 7,
        lines: [{ type: "add" as const, oldLine: null, newLine: 7, content: "const selected = true;" }],
      }],
    };
    const fetchImpl = createFetch(undefined, undefined, undefined, (url) => {
      if (url.startsWith("/v1/repositories/repo-1/diff?") && url.includes("path=src%2Fa.ts")) {
        return json({ success: true, data: pathScopedDiff });
      }
      if (url.endsWith("/v1/decision-records/rec-1")) {
        return json({ success: true, data: multiTargetDetailFixture() });
      }
      return undefined;
    });
    await openWorkspace(fetchImpl);

    fireEvent.click(screen.getByText("a.ts"));
    await screen.findByText("Source changed since the decision");
    fireEvent.click(screen.getByText("const selected = true;"));

    expect(screen.getByText("No judgments overlap the selected lines.")).toBeTruthy();
  });

  it("uses old-side anchors when filtering judgments in a snapshot transition", async () => {
    const fetchImpl = createFetch(undefined, undefined, (url) =>
      url.includes("/v1/decision-records/rec-1/snapshot-diff?")
        ? json({ success: true, data: snapshotTransition })
        : undefined,
    );
    await openWorkspace(fetchImpl);

    fireEvent.click(screen.getByText("a.ts"));
    await screen.findByRole("heading", { name: "Guard the empty input" });
    fireEvent.click(screen.getByRole("button", { name: "View subsequent changes" }));
    await screen.findByText("const value = before;");
    fireEvent.click(screen.getByText("const value = before;"));

    expect(screen.getByRole("heading", { name: "Guard the empty input" })).toBeTruthy();
    expect(screen.queryByText("No judgments overlap the selected lines.")).toBeNull();
  });

  it("toggles an already-selected judgment transition off without refetching", async () => {
    const fetchImpl = createFetch(undefined, undefined, (url) =>
      url.includes("/v1/decision-records/rec-1/snapshot-diff?")
        ? json({ success: true, data: snapshotTransition })
        : undefined,
    );
    await openWorkspace(fetchImpl);

    fireEvent.click(screen.getByText("a.ts"));
    await screen.findByRole("heading", { name: "Guard the empty input" });
    fireEvent.click(screen.getByRole("button", { name: "View subsequent changes" }));
    await screen.findByText("before snapshot");
    const snapshotCalls = fetchImpl.mock.calls.filter(([url]) => String(url).includes("/snapshot-diff?")).length;

    fireEvent.click(screen.getByRole("button", { name: "Viewing subsequent changes" }));

    expect(await screen.findByText("const head = 0;")).toBeTruthy();
    expect(screen.queryByText("before snapshot")).toBeNull();
    expect(screen.getByRole("button", { name: "View subsequent changes" }).getAttribute("aria-pressed")).toBe("false");
    expect(fetchImpl.mock.calls.filter(([url]) => String(url).includes("/snapshot-diff?")).length).toBe(snapshotCalls);
  });

  it("keeps the repository diff visible when a selected judgment uses the legacy fallback", async () => {
    const fetchImpl = createFetch();
    await openWorkspace(fetchImpl);

    fireEvent.click(screen.getByText("a.ts"));
    await screen.findByRole("heading", { name: "Guard the empty input" });
    fireEvent.click(screen.getByRole("button", { name: "View subsequent changes" }));

    expect(await screen.findByText("const value = input ?? {};")).toBeTruthy();
    expect(screen.queryByText("before snapshot")).toBeNull();
    expect(screen.getByRole("heading", { name: "src/a.ts" })).toBeTruthy();
    expect(screen.getByRole("button", { name: "View subsequent changes" }).getAttribute("aria-pressed")).toBe("false");
  });

  it("discards a stale snapshot transition after another file is opened", async () => {
    let holdSnapshot = false;
    const fetchImpl = createFetch(
      (url) => holdSnapshot && url.includes("/snapshot-diff?"),
      undefined,
      (url) => url.includes("/v1/decision-records/rec-1/snapshot-diff?")
        ? json({ success: true, data: snapshotTransition })
        : undefined,
    );
    await openWorkspace(fetchImpl);

    fireEvent.click(screen.getByText("a.ts"));
    await screen.findByRole("heading", { name: "Guard the empty input" });
    holdSnapshot = true;
    fireEvent.click(screen.getByRole("button", { name: "View subsequent changes" }));
    expect(screen.getByRole("status").textContent).toContain("Loading snapshot transition");

    holdSnapshot = false;
    fireEvent.click(screen.getByText("b.ts"));
    await screen.findByRole("heading", { name: "Cover the parse failure" });
    fetchImpl.releaseAll();
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 20));
    });

    expect(screen.getByRole("heading", { name: "src/b.ts" })).toBeTruthy();
    expect(screen.getByText("const beta = parse(x);")).toBeTruthy();
    expect(screen.queryByText("before snapshot")).toBeNull();
    expect(screen.getByRole("button", { name: "View subsequent changes" }).getAttribute("aria-pressed")).toBe("false");
  });

  it("recomputes current-file anchors and full text after a judgment retry", async () => {
    let failRec1Detail = true;
    const fetchImpl = createFetch(
      undefined,
      (url) => failRec1Detail && url.endsWith("/v1/decision-records/rec-1"),
      undefined,
      (url) => url.startsWith("/v1/repositories/repo-1/diff?")
        ? json({ success: true, data: { ...fileDiff, hunks: [] } })
        : url.endsWith("/v1/decision-records/rec-1")
          ? json({ success: true, data: retryDetailFixture() })
        : undefined,
    );
    await openWorkspace(fetchImpl);

    fireEvent.click(screen.getByText("a.ts"));
    const retry = await screen.findByRole("button", { name: "Retry rec-1" });
    failRec1Detail = false;
    fireEvent.click(retry);

    expect(await screen.findByText("const value = input ?? {};")).toBeTruthy();
    expect(document.querySelector('[data-new-line="2"]')?.className).toContain("diff-line--anchored");
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
      if (url.endsWith("/v1/repositories/repo-1/branches")) {
        return json({ success: true, data: { repository_id: "repo-1", head_branch: null, branches: [] } });
      }
      if (url.endsWith("/v1/repositories/repo-1/files")) {
        return json({ success: true, data: { repository_id: "repo-1", view: { kind: "working-tree" }, paths: ["src/a.ts"] } });
      }
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
    expect(screen.getByLabelText("Owner bearer token")).toHaveProperty("disabled", false);
  });

  it("ignores a late repository file-list response after session reset", async () => {
    const fetchImpl = createFetch((url) => url.endsWith("/v1/repositories/repo-1/files"));
    render(<App apiFactory={(token) => new ReviewApi(token, { fetchImpl })} />);

    fireEvent.change(screen.getByLabelText("Owner bearer token"), { target: { value: "owner-token" } });
    fireEvent.submit(screen.getByRole("button", { name: "Load repositories" }).closest("form")!);
    const picker = await screen.findByLabelText("Repository");
    fireEvent.change(picker, { target: { value: "repo-1" } });
    fireEvent.submit(screen.getByRole("button", { name: "Open review timeline" }).closest("form")!);
    await screen.findByRole("button", { name: "Clear session" });
    fireEvent.click(screen.getByRole("button", { name: "Clear session" }));

    fireEvent.change(screen.getByLabelText("Owner bearer token"), { target: { value: "owner-token" } });
    fireEvent.submit(screen.getByLabelText("Owner bearer token").closest("form")!);
    const secondPicker = await screen.findByLabelText("Repository");
    fireEvent.change(secondPicker, { target: { value: "repo-1" } });
    fireEvent.submit(screen.getByRole("button", { name: "Open review timeline" }).closest("form")!);
    await screen.findByRole("button", { name: "Clear session" });

    fetchImpl.releaseOne((url) => url.endsWith("/v1/repositories/repo-1/files")
      ? json({ success: true, data: { repository_id: "repo-1", paths: ["late-after-reset.ts"] } })
      : undefined);
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 20));
    });

    expect(screen.queryByText("late-after-reset.ts")).toBeNull();
    expect(screen.getByRole("status").textContent).toContain("Loading repository tree");
  });

  it("ignores deferred session responses after reset while accepting the current request", async () => {
    const initialFiles = deferred<Response>();
    const staleRepositories = deferred<Response>();
    const currentRepositories = deferred<Response>();
    let repositoryCalls = 0;
    let fileCalls = 0;
    const fetchImpl = vi.fn(async (input: RequestInfo | URL): Promise<Response> => {
      const url = String(input);
      if (url.endsWith("/v1/repositories")) {
        repositoryCalls += 1;
        if (repositoryCalls === 1) return json({ success: true, data: [repository] });
        if (repositoryCalls === 2) return staleRepositories.promise;
        return currentRepositories.promise;
      }
      if (url.includes("/v1/decision-records?repository_id=")) return json({ success: true, data: [] });
      if (url.endsWith("/v1/repositories/repo-1/branches")) {
        return json({ success: true, data: { repository_id: "repo-1", head_branch: "main", branches: [] } });
      }
      if (url.endsWith("/v1/repositories/repo-1/files")) {
        fileCalls += 1;
        if (fileCalls === 1) return initialFiles.promise;
        return json({ success: true, data: { repository_id: "repo-1", view: { kind: "working-tree" }, paths: ["current.ts"] } });
      }
      throw new Error(`unexpected request: ${url}`);
    });
    await openWorkspace(fetchImpl);

    fireEvent.click(screen.getByRole("button", { name: "Clear session" }));
    initialFiles.resolve(json({ success: true, data: { repository_id: "repo-1", paths: ["late-after-reset.ts"] } }));

    fireEvent.change(screen.getByLabelText("Owner bearer token"), { target: { value: "owner-token" } });
    const form = screen.getByLabelText("Owner bearer token").closest("form")!;
    fireEvent.submit(form);
    fireEvent.submit(form);

    staleRepositories.resolve(json({
      success: true,
      data: [{ ...repository, root: "/work/stale-repository" }],
    }));
    await act(async () => {
      await Promise.resolve();
    });
    expect(screen.queryByText("/work/stale-repository")).toBeNull();
    expect(screen.getByRole("button", { name: "Connecting…" })).toBeTruthy();

    currentRepositories.resolve(json({
      success: true,
      data: [{ ...repository, root: "/work/current-repository" }],
    }));
    expect(await screen.findByText("/work/current-repository")).toBeTruthy();
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

  it("ignores a late disposition response after another file is opened", async () => {
    let holdDisposition = false;
    let returnLateDetail = false;
    const fetchImpl = createFetch(
      (url) => holdDisposition && url.includes("/disposition"),
      undefined,
      undefined,
      (url, init) => {
        if (url.includes("/v1/decision-records?repository_id=")) {
          return json({ success: true, data: [multiPathSummaryFixture(), summaryFixtureB()] });
        }
        if (url.startsWith("/v1/repositories/repo-1/diff?") && url.includes("path=src%2Fb.ts")) {
          return json({ success: true, data: { ...fileBDiff, hunks: [] } });
        }
        if (url.includes("/v1/decision-records/rec-1/disposition") && init?.method === "PATCH") {
          return json({ success: true, data: { record_id: "rec-1" } });
        }
        if (returnLateDetail && url.endsWith("/v1/decision-records/rec-1")) {
          return json({ success: true, data: multiPathDetailFixture("late disposition source") });
        }
        return undefined;
      },
    );
    await openWorkspace(fetchImpl);

    fireEvent.click(screen.getByText("a.ts"));
    const accept = await screen.findByRole("button", { name: "Accept" });
    holdDisposition = true;
    fireEvent.click(accept);
    await screen.findByText("Saving disposition…");

    fireEvent.click(screen.getByText("b.ts"));
    await screen.findByRole("heading", { name: "Cover the parse failure" });
    returnLateDetail = true;
    holdDisposition = false;
    fetchImpl.releaseAll();
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 20));
    });

    expect(screen.queryByText("late disposition source")).toBeNull();
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

  it("renders Review view with working tree default and checked-out suffix when two local branches exist", async () => {
    const fetchImpl = createFetch(undefined, undefined, undefined, undefined, twoBranchList);
    await openWorkspace(fetchImpl);

    const select = await screen.findByLabelText("Review view");
    expect(select).toHaveProperty("value", "");
    expect([...select.querySelectorAll("option")].map((option) => option.textContent)).toEqual([
      "Working tree",
      "feat/x",
      "main (checked out)",
    ]);
  });

  it("reloads files and the open diff with the selected branch query", async () => {
    const fetchImpl = createFetch(undefined, undefined, undefined, undefined, twoBranchList);
    await openWorkspace(fetchImpl);

    fireEvent.click(screen.getByText("a.ts"));
    await screen.findByRole("heading", { name: "Guard the empty input" });
    fireEvent.change(await screen.findByLabelText("Review view"), { target: { value: "feat/x" } });

    await waitFor(() => {
      expect(fetchImpl).toHaveBeenCalledWith("/v1/repositories/repo-1/files?branch=feat%2Fx", expect.anything());
    });
    await waitFor(() => {
      expect(fetchImpl.mock.calls.some(([url]) => {
        const href = String(url);
        return href.includes("/diff?") && href.includes("branch=feat%2Fx");
      })).toBe(true);
    });
  });

  it.each([
    { label: "zero local branches", branches: [] as typeof twoBranchList.branches },
    { label: "one local branch", branches: defaultBranchList.branches },
  ])("does not render Review view for $label", async ({ branches }) => {
    const fetchImpl = createFetch(undefined, undefined, undefined, undefined, {
      repository_id: "repo-1",
      head_branch: "main",
      branches,
    });
    await openWorkspace(fetchImpl);

    expect(screen.queryByLabelText("Review view")).toBeNull();
  });

  it("returns to the working tree when a selected branch files request is not found", async () => {
    const fetchImpl = createFetch(undefined, undefined, undefined, (url) => {
      if (url.includes("/v1/repositories/repo-1/files?") && url.includes("branch=")) {
        return json({ success: false, error: { code: "REVISION_NOT_FOUND", message: "revision was not found" } }, 404);
      }
      return undefined;
    }, twoBranchList);
    await openWorkspace(fetchImpl);

    fireEvent.change(await screen.findByLabelText("Review view"), { target: { value: "feat/x" } });

    expect((await screen.findByRole("alert")).textContent).toContain("revision was not found");
    expect(screen.getByLabelText("Review view")).toHaveProperty("value", "");
    await waitFor(() => {
      const fileUrls = fetchImpl.mock.calls
        .map(([url]) => String(url))
        .filter((url) => url.includes("/v1/repositories/repo-1/files"));
      expect(fileUrls.at(-1)).toBe("/v1/repositories/repo-1/files");
    });
  });

  it("shows the workspace heading even if the branches request is held", async () => {
    const fetchImpl = createFetch((url) => url.endsWith("/v1/repositories/repo-1/branches"), undefined, undefined, undefined, twoBranchList);
    await openWorkspace(fetchImpl);

    expect(screen.getByRole("heading", { name: "Decision review" })).toBeTruthy();
    expect(screen.queryByLabelText("Review view")).toBeNull();
    expect(fetchImpl).toHaveBeenCalledWith("/v1/repositories/repo-1/branches", expect.anything());
  });

  it("does not attach working-tree source content as fullText when the review view is a local branch", () => {
    const entries: JudgmentEntry[] = [{ recordId: "rec-1", status: "ready", detail: detailFixture() }];

    expect(currentPathEvidence(entries, "src/a.ts", "local-branch").fullText).toBeNull();
    expect(currentPathEvidence(entries, "src/a.ts", "working-tree").fullText?.content).toBe("const value = input ?? {};");
  });

  it("discards a stale branch files response after the review view changes again", async () => {
    let holdBranchFiles = false;
    const fetchImpl = createFetch(
      (url) => holdBranchFiles && url.includes("/v1/repositories/repo-1/files?") && url.includes("branch="),
      undefined,
      undefined,
      (url) => {
        if (!requestPath(url).endsWith("/v1/repositories/repo-1/files") || !url.includes("branch=")) return undefined;
        if (url.includes("branch=feat%2Fx")) {
          return json({
            success: true,
            data: {
              repository_id: "repo-1",
              view: { kind: "local-branch", name: "feat/x", sha: "1".repeat(40) },
              paths: ["src/a.ts", "feat-only.ts"],
            },
          });
        }
        if (url.includes("branch=main")) {
          return json({
            success: true,
            data: {
              repository_id: "repo-1",
              view: { kind: "local-branch", name: "main", sha: "2".repeat(40) },
              paths: ["src/a.ts", "main-only.ts"],
            },
          });
        }
        return undefined;
      },
      twoBranchList,
    );
    await openWorkspace(fetchImpl);

    fireEvent.click(screen.getByText("a.ts"));
    await screen.findByRole("heading", { name: "Guard the empty input" });

    holdBranchFiles = true;
    fireEvent.change(await screen.findByLabelText("Review view"), { target: { value: "feat/x" } });
    await waitFor(() => {
      expect(fetchImpl).toHaveBeenCalledWith("/v1/repositories/repo-1/files?branch=feat%2Fx", expect.anything());
    });

    fireEvent.change(screen.getByLabelText("Review view"), { target: { value: "main" } });
    await waitFor(() => {
      expect(fetchImpl).toHaveBeenCalledWith("/v1/repositories/repo-1/files?branch=main", expect.anything());
    });
    expect(screen.getByLabelText("Review view")).toHaveProperty("value", "main");

    // feat/x is still in flight when main starts. Releasing it first is the window where
    // loadFiles can apply feat/x and openFile("feat/x") while the select already shows main.
    fetchImpl.releaseOne();
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 20));
    });
    holdBranchFiles = false;
    fetchImpl.releaseAll();
    await waitFor(() => {
      expect(screen.getByText("main-only.ts")).toBeTruthy();
    });

    expect(screen.getByLabelText("Review view")).toHaveProperty("value", "main");
    expect(screen.queryByText("feat-only.ts")).toBeNull();
    const lastDiff = fetchImpl.mock.calls
      .map(([url]) => String(url))
      .filter((url) => url.includes("/diff?"))
      .at(-1);
    expect(lastDiff).toContain("branch=main");
    expect(lastDiff).not.toContain("feat");
  });
});
