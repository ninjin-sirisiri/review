import { describe, expect, it, vi } from "vitest";
import { ReviewApi, ReviewApiError, type SnapshotDiffResponse } from "./api";

function response(payload: unknown, status = 200): Response {
  return new Response(JSON.stringify(payload), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

function snapshotTransition(): Extract<SnapshotDiffResponse, { state: "snapshot-resolved" }> {
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
    },
    to: { kind: "working-tree" },
    hunks: [{ oldStart: 1, newStart: 1, lines: [{ type: "context", oldLine: 1, newLine: 1, content: "const value = before;" }] }],
    old_missing: false,
    new_missing: false,
    binary: false,
  };
}

describe("ReviewApi", () => {
  it("sends the owner bearer token for list requests", async () => {
    const fetchImpl = vi.fn(async () => response({ success: true, data: [] }));
    const api = new ReviewApi(" owner-token ", { baseUrl: "http://recorder.test/", fetchImpl });

    await api.listDecisions("repo/one");

    expect(fetchImpl).toHaveBeenCalledWith(
      "http://recorder.test/v1/decision-records?repository_id=repo%2Fone",
      expect.objectContaining({
        headers: expect.objectContaining({ Authorization: "Bearer owner-token" }),
      }),
    );
  });

  it("lists registered repositories for the entered owner token", async () => {
    const fetchImpl = vi.fn(async () =>
      response({
        success: true,
        data: [{ repository_id: "repo-1", root: "/work/repo-one", created_at: "2026-08-22T00:00:00.000Z" }],
      }),
    );
    const api = new ReviewApi("owner-token", { baseUrl: "http://recorder.test/", fetchImpl });

    const repositories = await api.listRepositories();

    expect(fetchImpl).toHaveBeenCalledWith(
      "http://recorder.test/v1/repositories",
      expect.objectContaining({
        headers: expect.objectContaining({ Authorization: "Bearer owner-token" }),
      }),
    );
    expect(repositories).toEqual([
      { repository_id: "repo-1", root: "/work/repo-one", created_at: "2026-08-22T00:00:00.000Z" },
    ]);
  });

  it("propagates unauthorized API envelopes instead of falling back", async () => {
    const api = new ReviewApi("owner-token", {
      fetchImpl: async () => response({ success: false, error: { code: "UNAUTHORIZED", message: "owner bearer token is required" } }, 401),
    });

    await expect(api.listDecisions("repo-1")).rejects.toMatchObject({
      name: "ReviewApiError",
      code: "UNAUTHORIZED",
      status: 401,
      message: "owner bearer token is required",
    });
  });

  it("requires a token before making a request", () => {
    expect(() => new ReviewApi("   ")).toThrowError(ReviewApiError);
  });

  it("confirms a disposition mutation by loading the updated detail", async () => {
    const fetchImpl = vi
      .fn()
      .mockResolvedValueOnce(response({ success: true, data: { record_id: "record-1" } }))
      .mockResolvedValueOnce(response({ success: true, data: { record: { record_id: "record-1", user_disposition: "accepted" }, sources: [] } }));
    const api = new ReviewApi("owner-token", { fetchImpl });

    await api.setDisposition("record-1", "accepted");

    expect(fetchImpl).toHaveBeenNthCalledWith(
      1,
      "/v1/decision-records/record-1/disposition",
      expect.objectContaining({ method: "PATCH", body: JSON.stringify({ user_disposition: "accepted" }) }),
    );
    expect(fetchImpl).toHaveBeenNthCalledWith(2, "/v1/decision-records/record-1", expect.anything());
  });

  it("encodes and trims disposition record IDs before the PATCH request", async () => {
    const fetchImpl = vi
      .fn()
      .mockResolvedValueOnce(response({ success: true, data: { record_id: "record/1" } }))
      .mockResolvedValueOnce(response({ success: true, data: { record: { record_id: "record/1", user_disposition: "accepted" }, sources: [] } }));
    const api = new ReviewApi("owner-token", { fetchImpl });

    await api.setDisposition(" record/1 ", "accepted");

    expect(fetchImpl).toHaveBeenNthCalledWith(
      1,
      "/v1/decision-records/record%2F1/disposition",
      expect.objectContaining({ method: "PATCH", body: JSON.stringify({ user_disposition: "accepted" }) }),
    );
  });

  it("lists repository files under the owner bearer token", async () => {
    const fetchImpl = vi.fn(async () =>
      response({ success: true, data: { repository_id: "repo-1", view: { kind: "working-tree" }, paths: ["src/a.ts", "src/b.ts"] } }),
    );
    const api = new ReviewApi("owner-token", { fetchImpl });

    const files = await api.listRepositoryFiles("repo-1");

    expect(fetchImpl).toHaveBeenCalledWith(
      "/v1/repositories/repo-1/files",
      expect.objectContaining({ headers: expect.objectContaining({ Authorization: "Bearer owner-token" }) }),
    );
    expect(files).toEqual({
      repository_id: "repo-1",
      view: { kind: "working-tree" },
      paths: ["src/a.ts", "src/b.ts"],
    });
  });

  it("lists local branches and passes branch on files and diff", async () => {
    const fetchImpl = vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url.endsWith("/branches")) {
        return response({
          success: true,
          data: { repository_id: "repo-1", head_branch: "main", branches: [{ name: "feat/x", sha: "a".repeat(40) }, { name: "main", sha: "b".repeat(40) }] },
        });
      }
      if (url.includes("/files")) {
        return response({
          success: true,
          data: { repository_id: "repo-1", view: { kind: "local-branch", name: "feat/x", sha: "a".repeat(40) }, paths: ["src/a.ts"] },
        });
      }
      return response({
        success: true,
        data: { path: "src/a.ts", base_sha: "a".repeat(40), hunks: [], old_missing: false, new_missing: false, binary: false },
      });
    });
    const api = new ReviewApi("owner-token", { baseUrl: "http://recorder.test/", fetchImpl });
    await api.listBranches("repo-1");
    await api.listRepositoryFiles("repo-1", "feat/x");
    await api.getFileDiff("repo-1", "src/a.ts", "HEAD", "feat/x");
    expect(fetchImpl).toHaveBeenCalledWith("http://recorder.test/v1/repositories/repo-1/branches", expect.anything());
    expect(fetchImpl).toHaveBeenCalledWith("http://recorder.test/v1/repositories/repo-1/files?branch=feat%2Fx", expect.anything());
    expect(String(fetchImpl.mock.calls[2]![0])).toContain("branch=feat%2Fx");
  });

  it("fetches a structured path diff with an explicit base", async () => {
    const fileDiff = { path: "src/a.ts", base_sha: "abc", hunks: [], old_missing: false, new_missing: false, binary: false };
    const fetchImpl = vi.fn(async () => response({ success: true, data: fileDiff }));
    const api = new ReviewApi("owner-token", { fetchImpl });

    const diff = await api.getFileDiff("repo-1", "src/a.ts", "abc");
    expect(diff).toEqual(fileDiff);
    expect(fetchImpl).toHaveBeenNthCalledWith(
      1,
      "/v1/repositories/repo-1/diff?path=src%2Fa.ts&base=abc",
      expect.objectContaining({ headers: expect.objectContaining({ Authorization: "Bearer owner-token" }) }),
    );

    await api.getFileDiff("repo-1", "src/a.ts");
    expect(fetchImpl).toHaveBeenNthCalledWith(
      2,
      "/v1/repositories/repo-1/diff?path=src%2Fa.ts&base=HEAD",
      expect.anything(),
    );

    await expect(api.getFileDiff("  ", "src/a.ts")).rejects.toMatchObject({ name: "ReviewApiError", code: "INVALID_RECORD" });
  });

  it("propagates diff endpoint error envelopes", async () => {
    const api = new ReviewApi("owner-token", {
      fetchImpl: async () => response({ success: false, error: { code: "PAYLOAD_TOO_LARGE", message: "source exceeds the limit" } }, 413),
    });

    await expect(api.getFileDiff("repo-1", "src/a.ts")).rejects.toMatchObject({
      name: "ReviewApiError",
      code: "PAYLOAD_TOO_LARGE",
      status: 413,
    });
  });

  it("fetches a snapshot transition diff with encoded record and path", async () => {
    const fetchImpl = vi.fn(async () => response({
      success: true,
      data: { state: "legacy-fallback", reason: "automatic-snapshot-not-found", path: "src/a.ts" },
    }));
    const api = new ReviewApi("owner-token", { fetchImpl });

    await expect(api.getSnapshotDiff(" record/1 ", "src/a.ts")).resolves.toMatchObject({ state: "legacy-fallback" });
    expect(fetchImpl).toHaveBeenCalledWith(
      "/v1/decision-records/record%2F1/snapshot-diff?path=src%2Fa.ts",
      expect.objectContaining({ headers: expect.objectContaining({ Authorization: "Bearer owner-token" }) }),
    );
  });

  it("parses a valid structured snapshot transition response", async () => {
    const data = snapshotTransition();
    const api = new ReviewApi("owner-token", { fetchImpl: async () => response({ success: true, data }) });

    await expect(api.getSnapshotDiff("record-1", "src/a.ts")).resolves.toEqual(data);
  });

  it("accepts a long diff line within the Recorder response limit", async () => {
    const data = snapshotTransition();
    data.hunks[0]!.lines[0]!.content = "x".repeat(12_000);
    const api = new ReviewApi("owner-token", { fetchImpl: async () => response({ success: true, data }) });

    await expect(api.getSnapshotDiff("record-1", "src/a.ts")).resolves.toEqual(data);
  });

  it.each([
    ["a malformed hunk line", (value: ReturnType<typeof snapshotTransition>) => ({
      ...value,
      hunks: [{ ...value.hunks[0]!, lines: [{ type: "context", oldLine: 1, newLine: 1 }] }],
    })],
    ["a malformed snapshot endpoint", (value: ReturnType<typeof snapshotTransition>) => ({
      ...value,
      from: { ...value.from, source_path: "../outside.ts" },
    })],
    ["an extra working-tree endpoint field", (value: ReturnType<typeof snapshotTransition>) => ({
      ...value,
      to: { kind: "working-tree", source_path: value.path },
    })],
  ] as const)("converts %s into a retryable invalid-response error", async (_label, mutate) => {
    const data = mutate(snapshotTransition());
    const api = new ReviewApi("owner-token", { fetchImpl: async () => response({ success: true, data }) });

    await expect(api.getSnapshotDiff("record-1", "src/a.ts")).rejects.toMatchObject({
      name: "ReviewApiError",
      code: "INVALID_RESPONSE",
      status: 200,
    });
  });

  it("rejects a blank snapshot transition record ID before fetching", async () => {
    const fetchImpl = vi.fn(async () => response({ success: true, data: {} }));
    const api = new ReviewApi("owner-token", { fetchImpl });

    await expect(api.getSnapshotDiff("  ", "src/a.ts")).rejects.toMatchObject({
      name: "ReviewApiError",
      code: "INVALID_RECORD",
    });
    expect(fetchImpl).not.toHaveBeenCalled();
  });
});
