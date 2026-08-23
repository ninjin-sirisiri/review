import { describe, expect, it, vi } from "vitest";
import { ReviewApi, ReviewApiError } from "./api";

function response(payload: unknown, status = 200): Response {
  return new Response(JSON.stringify(payload), {
    status,
    headers: { "Content-Type": "application/json" },
  });
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

  it("lists repository files under the owner bearer token", async () => {
    const fetchImpl = vi.fn(async () =>
      response({ success: true, data: { repository_id: "repo-1", paths: ["src/a.ts", "src/b.ts"] } }),
    );
    const api = new ReviewApi("owner-token", { fetchImpl });

    const files = await api.listRepositoryFiles("repo-1");

    expect(fetchImpl).toHaveBeenCalledWith(
      "/v1/repositories/repo-1/files",
      expect.objectContaining({ headers: expect.objectContaining({ Authorization: "Bearer owner-token" }) }),
    );
    expect(files).toEqual({ repository_id: "repo-1", paths: ["src/a.ts", "src/b.ts"] });
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
});
