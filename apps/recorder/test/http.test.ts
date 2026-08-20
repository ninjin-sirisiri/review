import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, readFile, rm, stat, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createHash } from "node:crypto";
import type { DecisionRecordInput, ReviewSession } from "../../../packages/contracts/src/index";
import { createRecorderConfig } from "../src/config";
import { createRecorderServer, type RecorderServer } from "../src/http/server";
import { ensureOwnerToken, readOwnerToken } from "../src/auth/token";

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

function body(recordId = "record-1", sessionId = "session-1", targetPath = "src/example.ts"): DecisionRecordInput {
  const content = "export const answer = 42;\n";
  const contentHash = createHash("sha256").update(content).digest("hex");
  return {
    record_id: recordId,
    session_id: sessionId,
    repository_id: "repo-1",
    agent_type: "codex",
    revision: { kind: "working-tree", contentHash },
    targets: [{
      repository_id: "repo-1",
      path: targetPath,
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
  await writeFile(join(root, "src", "other.ts"), "changed source\n", "utf8");
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
  test("serves static UI navigation publicly while keeping APIs authenticated", async () => {
    const page = await fetch(`${app.server.url}/`);
    expect(page.status).toBe(200);
    expect(await page.text()).toContain("<title>Review</title>");

    const api = await fetch(`${app.server.url}/v1/decision-records?repository_id=repo-1`);
    expect(api.status).toBe(401);
    expect(await json<{ success: false; error: { code: string } }>(api)).toMatchObject({ success: false, error: { code: "UNAUTHORIZED" } });
  });

  test("serves only static UI files without evaluating repository text", async () => {
    const page = await fetch(`${app.server.url}/`);
    expect(page.status).toBe(200);
    expect(await page.text()).not.toContain(root);

    const head = await fetch(`${app.server.url}/`, { method: "HEAD" });
    expect(head.status).toBe(200);
    expect(await head.text()).toBe("");

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
  test("rejects chunked request bodies as soon as they exceed the JSON limit", async () => {
    const encoder = new TextEncoder();
    const stream = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(encoder.encode("{\"root\":\""));
        controller.enqueue(encoder.encode("x".repeat(1_000_100)));
        controller.enqueue(encoder.encode("\"}"));
        controller.close();
      },
    });
    const response = await fetch(`${app.server.url}/v1/repositories`, {
      method: "POST",
      headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
      body: stream,
      duplex: "half",
    } as RequestInit & { duplex: "half" });
    expect(response.status).toBe(413);
    expect(await json<{ success: false; error: { code: string } }>(response)).toMatchObject({ success: false, error: { code: "PAYLOAD_TOO_LARGE" } });
  });

  test("returns an INVALID_RECORD envelope for malformed UTF-8 JSON", async () => {
    const response = await fetch(`${app.server.url}/v1/repositories`, {
      method: "POST",
      headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
      body: new Uint8Array([0x7b, 0x22, 0x72, 0x6f, 0x6f, 0x74, 0x22, 0x3a, 0xc3, 0x28, 0x7d]),
    });
    expect(response.status).toBe(400);
    expect(await json<{ success: false; error: { code: string } }>(response)).toMatchObject({ success: false, error: { code: "INVALID_RECORD" } });
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

  test("serializes concurrent same-record submissions and returns sources for the stored record", async () => {
    await request("/v1/repositories", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ root, repository_id: "repo-1" }) });
    await request("/v1/sessions", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ session_id: "session-1", repository_id: "repo-1", agent_type: "codex", started_at: "2026-08-20T00:00:00Z", status: "active" }) });
    const [first, second] = await Promise.all([
      request("/v1/decision-records", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body("same-record", "session-1", "src/example.ts")) }),
      request("/v1/decision-records", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body("same-record", "session-1", "src/other.ts")) }),
    ]);
    for (const response of [first, second]) {
      expect([201, 200]).toContain(response.status);
      const payload = await json<{ success: true; data: { record: { targets: Array<{ path: string }> }; sources: Array<{ path: string }> } }>(response);
      expect(payload.data.sources[0]?.path).toBe(payload.data.record.targets[0]?.path);
    }
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
  test("does not resolve a snapshot belonging to another record", async () => {
    await request("/v1/repositories", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ root, repository_id: "repo-1" }) });
    await request("/v1/sessions", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ session_id: "session-1", repository_id: "repo-1", agent_type: "codex", started_at: "2026-08-20T00:00:00Z", status: "active" }) });
    await request("/v1/decision-records", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body()) });
    await request("/v1/sessions", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ session_id: "session-2", repository_id: "repo-1", agent_type: "codex", started_at: "2026-08-20T00:00:00Z", status: "active" }) });
    await request("/v1/decision-records", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body("record-2", "session-2")) });

    const snapshot = await request("/v1/decision-records/record-1/snapshot", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ mode: "patch", content: "record one snapshot" }),
    });
    const snapshotPayload = await json<{ success: true; data: { snapshot_id: string } }>(snapshot);
    const crossRecord = await request(`/v1/decision-records/record-2/source?source=snapshot:${snapshotPayload.data.snapshot_id}`);
    expect(crossRecord.status).toBe(200);
    expect(await json<{ success: true; data: { state: string; content?: string } }>(crossRecord)).toMatchObject({ success: true, data: { state: "source-unavailable" } });
  });

  test("does not persist decisions that fail on an unregistered repository source", async () => {
    await request("/v1/sessions", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ session_id: "missing-session", repository_id: "missing-repo", agent_type: "codex", started_at: "2026-08-20T00:00:00Z", status: "active" }) });
    const missing = body("missing-record", "missing-session");
    missing.repository_id = "missing-repo";
    missing.targets[0]!.repository_id = "missing-repo";
    const response = await request("/v1/decision-records", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(missing) });
    expect(response.status).toBe(404);
    expect(await json<{ success: false; error: { code: string } }>(response)).toMatchObject({ success: false, error: { code: "REPOSITORY_NOT_REGISTERED" } });
    const records = await request("/v1/decision-records?repository_id=missing-repo");
    expect(await json<{ success: true; data: unknown[] }>(records)).toEqual({ success: true, data: [] });
  });
  test("preflights missing sessions before source resolution", async () => {
    await request("/v1/repositories", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ root, repository_id: "repo-1" }) });
    const missing = body("missing-session-record", "missing-session");
    missing.targets[0]!.repository_id = "unregistered-target";
    const response = await request("/v1/decision-records", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(missing) });
    expect(response.status).toBe(422);
    expect(await json<{ success: false; error: { code: string } }>(response)).toMatchObject({ success: false, error: { code: "INVALID_RECORD" } });
    const records = await request("/v1/decision-records?repository_id=repo-1");
    expect(await json<{ success: true; data: unknown[] }>(records)).toEqual({ success: true, data: [] });
  });

  test("preflights target repository invariants before source resolution", async () => {
    await request("/v1/repositories", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ root, repository_id: "repo-1" }) });
    await request("/v1/sessions", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ session_id: "session-1", repository_id: "repo-1", agent_type: "codex", started_at: "2026-08-20T00:00:00Z", status: "active" }) });
    const mismatched = body("mismatched-target");
    mismatched.targets[0]!.repository_id = "unregistered-target";
    const response = await request("/v1/decision-records", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(mismatched) });
    expect(response.status).toBe(422);
    expect(await json<{ success: false; error: { code: string } }>(response)).toMatchObject({ success: false, error: { code: "INVALID_RECORD" } });
    const records = await request("/v1/decision-records?repository_id=repo-1");
    expect(await json<{ success: true; data: unknown[] }>(records)).toEqual({ success: true, data: [] });
  });

  test("rejects token paths whose parent symlink escapes the data directory", async () => {
    const outside = await mkdtemp(join(tmpdir(), "ai-review-http-token-outside-"));
    temporaryDirectories.push(outside);
    const escapedParent = join(dataDir, "token-parent");
    await symlink(outside, escapedParent, "dir");
    const config = createRecorderConfig({ dataDir, tokenPath: join("token-parent", "token") });
    await expect(ensureOwnerToken(config)).rejects.toThrow();
  });
  test("rejects static UI roots that overlap owner data, including symlinks", async () => {
    await expect(createRecorderServer({ dataDir, uiRoot: dataDir, port: 0 })).rejects.toThrow();
    const nestedUi = join(dataDir, "ui-inside");
    await mkdir(nestedUi, { recursive: true });
    await expect(createRecorderServer({ dataDir, uiRoot: nestedUi, port: 0 })).rejects.toThrow();
    const ancestor = await mkdtemp(join(tmpdir(), "ai-review-http-ui-ancestor-"));
    temporaryDirectories.push(ancestor);
    const ownerInsideAncestor = join(ancestor, "owner-data");
    await mkdir(ownerInsideAncestor, { recursive: true });
    await expect(createRecorderServer({ dataDir: ownerInsideAncestor, uiRoot: ancestor, port: 0 })).rejects.toThrow();
    const linkParent = await mkdtemp(join(tmpdir(), "ai-review-http-ui-link-"));
    temporaryDirectories.push(linkParent);
    const linkedUi = join(linkParent, "ui-link");
    await symlink(dataDir, linkedUi, "dir");
    await expect(createRecorderServer({ dataDir, uiRoot: linkedUi, port: 0 })).rejects.toThrow();
  });

  test("rejects a public UI root containing an external database path", async () => {
    const externalDataDir = await mkdtemp(join(tmpdir(), "ai-review-http-external-data-"));
    temporaryDirectories.push(externalDataDir);
    const externalDatabaseDir = join(uiRoot, "database");
    await mkdir(externalDatabaseDir, { recursive: true });
    const config = createRecorderConfig({
      dataDir: externalDataDir,
      databasePath: join(externalDatabaseDir, "records.sqlite"),
    });
    await expect(createRecorderServer({ config, uiRoot, port: 0 })).rejects.toThrow();
  });

  test("stores the owner token with restrictive permissions and binds to loopback", async () => {
    expect(app.config.bindAddress).toBe("127.0.0.1");
    expect(app.server.hostname).toBe("127.0.0.1");
    expect((await stat(app.config.tokenPath)).mode & 0o777).toBe(0o600);
    expect((await readFile(app.config.tokenPath, "utf8")).trim()).toBe(token);
  });
});
