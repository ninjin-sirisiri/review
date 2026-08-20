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
});
