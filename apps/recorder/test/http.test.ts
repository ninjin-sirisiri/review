import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createHash } from "node:crypto";
import type { DecisionRecordInput, ReviewSession } from "../../../packages/contracts/src/index";
import { createRecorderServer, type RecorderServer } from "../src/http/server";
import { readOwnerToken } from "../src/auth/token";

const temporaryDirectories: string[] = [];
let app: RecorderServer;
let dataDir: string;
let root: string;
let uiRoot: string;
let token: string;

async function request(path: string, init: RequestInit = {}): Promise<Response> {
  const headers = new Headers(init.headers);
  headers.set("Authorization", `Bearer ${token}`);
  return fetch(`${app.server.url}${path}`, { ...init, headers });
}

async function json<T>(response: Response): Promise<T> {
  return response.json() as Promise<T>;
}

function body(recordId = "record-1"): DecisionRecordInput {
  const content = "export const answer = 42;\n";
  const contentHash = createHash("sha256").update(content).digest("hex");
  return {
    record_id: recordId,
    session_id: "session-1",
    repository_id: "repo-1",
    agent_type: "codex",
    revision: { kind: "working-tree", contentHash },
    targets: [{
      repository_id: "repo-1",
      path: "src/example.ts",
      line_start: 1,
      line_end: 1,
      revision: { kind: "working-tree", contentHash },
      content_hash: contentHash,
    }],
    judgment: "The change is safe.",
    rationale: "The implementation is bounded.",
    checks: [{ name: "tests", status: "passed", details: "focused" }],
    open_questions: [],
    created_at: "2026-08-20T00:00:00Z",
  };
}

beforeEach(async () => {
  dataDir = await mkdtemp(join(tmpdir(), "ai-review-http-data-"));
  root = await mkdtemp(join(tmpdir(), "ai-review-http-root-"));
  uiRoot = await mkdtemp(join(tmpdir(), "ai-review-http-ui-"));
  temporaryDirectories.push(dataDir, root, uiRoot);
  await mkdir(join(root, "src"), { recursive: true });
  await writeFile(join(root, "src", "example.ts"), "changed source\n", "utf8");
  await writeFile(join(uiRoot, "index.html"), "<!doctype html><title>Review</title>", "utf8");
  app = await createRecorderServer({ dataDir, port: 0, uiRoot });
  token = await readOwnerToken(app.config);
});

afterEach(async () => {
  await app.stop();
  await Promise.all(temporaryDirectories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })));
});

describe("authenticated local Recorder HTTP API", () => {
  test("requires the owner bearer token and returns success/error envelopes", async () => {
    const unauthorized = await fetch(`${app.server.url}/v1/decision-records`);
    expect(unauthorized.status).toBe(401);
    expect(await json<{ success: false; error: { code: string } }>(unauthorized)).toMatchObject({ success: false, error: { code: "UNAUTHORIZED" } });

    const response = await request("/v1/decision-records?repository_id=repo-1");
    expect(response.status).toBe(200);
    expect(await json<{ success: true; data: unknown[] }>(response)).toEqual({ success: true, data: [] });
  });

  test("serves only static UI files and does not evaluate repository text", async () => {
    const page = await request("/");
    expect(page.status).toBe(200);
    expect(await page.text()).toContain("<title>Review</title>");

    const traversal = await request("/%2e%2e/%2e%2e/etc/passwd");
    expect(traversal.status).toBe(404);

    const mutation = await request("/", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ root }) });
    expect(mutation.status).toBe(404);
  });

  test("rejects disallowed browser origins for mutations", async () => {
    const response = await request("/v1/repositories", {
      method: "POST",
      headers: { "Content-Type": "application/json", Origin: "https://evil.example" },
      body: JSON.stringify({ root, repository_id: "repo-1" }),
    });
    expect(response.status).toBe(403);
    expect(await json<{ success: false; error: { code: string } }>(response)).toMatchObject({ success: false, error: { code: "UNAUTHORIZED" } });
  });

  test("enforces JSON content type and request size limits", async () => {
    const contentType = await request("/v1/repositories", {
      method: "POST",
      body: JSON.stringify({ root, repository_id: "repo-1" }),
    });
    expect(contentType.status).toBe(400);

    const oversized = await request("/v1/repositories", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ root: "x".repeat(1_000_001), repository_id: "repo-1" }),
    });
    expect(oversized.status).toBe(413);
    expect(await json<{ success: false; error: { code: string } }>(oversized)).toMatchObject({ success: false, error: { code: "PAYLOAD_TOO_LARGE" } });
  });

  test("registers a repository, creates a session and persists an idempotent decision", async () => {
    const repositoryResponse = await request("/v1/repositories", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ root, repository_id: "repo-1" }),
    });
    expect(repositoryResponse.status).toBe(201);
    expect(await json<{ success: true; data: { repository_id: string } }>(repositoryResponse)).toMatchObject({ success: true, data: { repository_id: "repo-1" } });

    const session: ReviewSession = {
      session_id: "session-1",
      repository_id: "repo-1",
      agent_type: "codex",
      started_at: "2026-08-20T00:00:00Z",
      status: "active",
    };
    const sessionResponse = await request("/v1/sessions", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(session),
    });
    expect(sessionResponse.status).toBe(201);

    const first = await request("/v1/decision-records", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body()),
    });
    expect(first.status).toBe(201);
    const duplicate = await request("/v1/decision-records", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body()),
    });
    expect(duplicate.status).toBe(200);
    expect(await json<{ success: true; data: { record: { record_id: string } } }>(duplicate)).toMatchObject({ success: true, data: { record: { record_id: "record-1" } } });
  });

  test("updates disposition and lists records by repository", async () => {
    await request("/v1/repositories", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ root, repository_id: "repo-1" }) });
    await request("/v1/sessions", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ session_id: "session-1", repository_id: "repo-1", agent_type: "codex", started_at: "2026-08-20T00:00:00Z", status: "active" }) });
    await request("/v1/decision-records", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body()) });

    const update = await request("/v1/decision-records/record-1/disposition", {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ user_disposition: "accepted" }),
    });
    expect(update.status).toBe(200);
    expect(await json<{ success: true; data: { user_disposition: string } }>(update)).toMatchObject({ success: true, data: { user_disposition: "accepted" } });

    const list = await request("/v1/decision-records?repository_id=repo-1");
    expect(await json<{ success: true; data: Array<{ record_id: string }> }>(list)).toMatchObject({ success: true, data: [{ record_id: "record-1" }] });
  });

  test("returns explicit hash mismatch source state and supports snapshot selection and deletion", async () => {
    await request("/v1/repositories", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ root, repository_id: "repo-1" }) });
    await request("/v1/sessions", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ session_id: "session-1", repository_id: "repo-1", agent_type: "codex", started_at: "2026-08-20T00:00:00Z", status: "active" }) });
    await request("/v1/decision-records", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body()) });

    const unresolved = await request("/v1/decision-records/record-1/source?source=repository");
    expect(unresolved.status).toBe(200);
    expect(await json<{ success: true; data: { state: string } }>(unresolved)).toMatchObject({ success: true, data: { state: "hash-mismatch" } });

    const snapshot = await request("/v1/decision-records/record-1/snapshot", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ mode: "patch", content: "snapshot text" }),
    });
    expect(snapshot.status).toBe(201);
    const snapshotPayload = await json<{ success: true; data: { snapshot_id: string } }>(snapshot);
    const source = await request(`/v1/decision-records/record-1/source?source=snapshot:${snapshotPayload.data.snapshot_id}`);
    expect(await json<{ success: true; data: { state: string; content: string } }>(source)).toMatchObject({ success: true, data: { state: "snapshot-resolved", content: "snapshot text" } });

    const deleted = await request(`/v1/snapshots/${snapshotPayload.data.snapshot_id}`, { method: "DELETE" });
    expect(deleted.status).toBe(200);
    const missing = await request(`/v1/decision-records/record-1/source?source=snapshot:${snapshotPayload.data.snapshot_id}`);
    expect(await json<{ success: true; data: { state: string } }>(missing)).toMatchObject({ success: true, data: { state: "source-unavailable" } });
  });

  test("stores the owner token with restrictive permissions and binds to loopback", async () => {
    expect(app.config.bindAddress).toBe("127.0.0.1");
    expect(app.server.hostname).toBe("127.0.0.1");
    expect((await stat(app.config.tokenPath)).mode & 0o777).toBe(0o600);
    expect((await readFile(app.config.tokenPath, "utf8")).trim()).toBe(token);
  });
});
