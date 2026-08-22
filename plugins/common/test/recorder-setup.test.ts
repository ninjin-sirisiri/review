import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, test } from "bun:test";
import type { ReviewSession } from "../../../packages/contracts/src/index";
import { RecorderSetupClient, RecorderSetupError } from "../src/recorder-setup";

type RequestLog = { url: string; request: Request };

function response(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
}

async function tokenPath(): Promise<string> {
  const directory = await mkdtemp(join(tmpdir(), "ai-review-setup-"));
  const path = join(directory, "token");
  await writeFile(path, "owner-token\n", "utf8");
  return path;
}

const session: ReviewSession = {
  session_id: "session-setup",
  repository_id: "repository-setup",
  agent_type: "claude-code",
  started_at: "2026-08-21T00:00:00.000Z",
  status: "active",
};

describe("RecorderSetupClient", () => {
  test("registers repository and session with the token file and loopback endpoints", async () => {
    const requests: RequestLog[] = [];
    const client = new RecorderSetupClient({
      endpoint: "http://127.0.0.1:4318/v1/decision-records",
      tokenPath: await tokenPath(),
      fetchImpl: async (input, init) => {
        const request = new Request(input, init);
        requests.push({ url: String(input), request });
        return requests.length === 1
          ? response(201, { success: true, data: { repository_id: "repository-setup", root: "/tmp/repository", created_at: session.started_at } })
          : response(201, { success: true, data: session });
      },
    });

    const result = await client.ensureSession("/tmp/repository", session);

    expect(result.repository.repository_id).toBe("repository-setup");
    expect(result.session.session_id).toBe("session-setup");
    expect(requests.map((request) => request.url)).toEqual([
      "http://127.0.0.1:4318/v1/repositories",
      "http://127.0.0.1:4318/v1/sessions",
    ]);
    expect(requests[0]?.request.headers.get("authorization")).toBe("Bearer owner-token");
    expect(await requests[1]?.request.text()).toContain('"session_id":"session-setup"');
  });

  test("accepts idempotent repository and session responses", async () => {
    let calls = 0;
    const client = new RecorderSetupClient({
      endpoint: "http://localhost:4318/v1/decision-records",
      tokenPath: await tokenPath(),
      fetchImpl: async () => {
        calls += 1;
        return calls === 1
          ? response(200, { success: true, data: { repository_id: "repository-setup", root: "/tmp/repository", created_at: session.started_at } })
          : response(200, { success: true, data: session });
      },
    });

    const result = await client.ensureSession("/tmp/repository", session);

    expect(result.session.status).toBe("active");
    expect(calls).toBe(2);
  });

  test("rejects non-loopback endpoints before reading or sending a token", async () => {
    let called = false;
    expect(() => new RecorderSetupClient({
      endpoint: "https://example.com/v1/decision-records",
      fetchImpl: async () => {
        called = true;
        return response(200, { success: true, data: {} });
      },
    })).toThrow(RecorderSetupError);
    expect(called).toBe(false);
  });

  test("returns structured Recorder failures without exposing the token", async () => {
    const client = new RecorderSetupClient({
      endpoint: "http://127.0.0.1:4318/v1/decision-records",
      tokenPath: await tokenPath(),
      fetchImpl: async () => response(422, { success: false, error: { code: "INVALID_RECORD", message: "repository is invalid" } }),
    });

    let error: unknown;
    try {
      await client.registerRepository("/tmp/repository");
    } catch (candidate) {
      error = candidate;
    }
    expect(error).toBeInstanceOf(RecorderSetupError);
    expect((error as RecorderSetupError).code).toBe("INVALID_RECORD");
    expect((error as Error).message).toContain("repository is invalid");
    expect((error as Error).message).not.toContain("owner-token");
  });
});
