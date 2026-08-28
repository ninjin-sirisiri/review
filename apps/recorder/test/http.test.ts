import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { lstat, mkdir, mkdtemp, readFile, realpath, rm, stat, symlink, writeFile } from "node:fs/promises";
import { spawn } from "node:child_process";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createHash } from "node:crypto";
import type { DecisionRecordInput, ReviewSession } from "../../../packages/contracts/src/index";
import { createRecorderConfig } from "../src/config";
import { createRecorderServer, type RecorderServer } from "../src/http/server";
import { ensureOwnerToken, readOwnerToken } from "../src/auth/token";
import { RecordStore } from "../src/store/records";

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

async function requestTo(server: RecorderServer, serverToken: string, path: string, init: RequestInit = {}): Promise<Response> {
  const headers = new Headers(init.headers);
  headers.set("Authorization", `Bearer ${serverToken}`);
  return fetch(`${server.server.url}${path}`, { ...init, headers });
}

async function json<T>(response: Response): Promise<T> {
  return response.json() as Promise<T>;
}

async function runGit(args: string[]): Promise<void> {
  const child = spawn("git", args, { cwd: root, stdio: ["ignore", "pipe", "pipe"] });
  const exitCode = await new Promise<number>((resolve) => child.once("exit", (code) => resolve(code ?? 1)));
  if (exitCode !== 0) throw new Error(`git ${args.join(" ")} failed`);
}

async function setupAutomaticFixture(): Promise<void> {
  await runGit(["init", "--quiet"]);
  await runGit(["config", "user.email", "fixture@example.test"]);
  await runGit(["config", "user.name", "Fixture"]);
  await writeFile(join(root, "src", "example.ts"), "export const answer = 42;\n", "utf8");
  await runGit(["add", "--", "src/example.ts"]);
  await runGit(["commit", "--quiet", "-m", "fixture"]);

  const repository = await request("/v1/repositories", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ root, repository_id: "repo-1" }),
  });
  expect(repository.status).toBe(201);

  for (const [sessionId, recordId] of [["session-1", "record-1"], ["session-2", "record-2"], ["session-manual", "manual-record"]]) {
    const session = await request("/v1/sessions", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ session_id: sessionId, repository_id: "repo-1", agent_type: "codex", started_at: "2026-08-20T00:00:00Z", status: "active" }),
    });
    expect(session.status).toBe(201);
    const record = await request("/v1/decision-records", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body(recordId, sessionId)),
    });
    expect(record.status).toBe(201);
  }
}

async function postAutomatic(
  recordId: string,
  captureId: string,
  sourcePath: string,
  content: string,
  beforeMissing = false,
  extraHeaders: HeadersInit = {},
): Promise<Response> {
  const fixturePath = join(root, sourcePath);
  if (beforeMissing) {
    await rm(fixturePath, { force: true });
  } else {
    await writeFile(fixturePath, content, "utf8");
  }
  return request(`/v1/decision-records/${recordId}/automatic-snapshot`, {
    method: "POST",
    headers: { "Content-Type": "application/json", ...extraHeaders },
    body: JSON.stringify({ capture_id: captureId, source_path: sourcePath, content, before_missing: beforeMissing }),
  });
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

    const conflict = await request("/v1/decision-records", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ ...body(), judgment: "A different judgment must not reuse this record_id." }),
    });
    expect(conflict.status).toBe(409);
    expect(await json<{ success: false; error: { code: string } }>(conflict)).toMatchObject({ success: false, error: { code: "DUPLICATE_RECORD" } });
  });

  test("lists registered repositories with their canonical roots", async () => {
    const empty = await request("/v1/repositories");
    expect(empty.status).toBe(200);
    expect(await json<{ success: true; data: unknown[] }>(empty)).toEqual({ success: true, data: [] });

    const secondRoot = await mkdtemp(join(tmpdir(), "ai-review-http-root2-"));
    temporaryDirectories.push(secondRoot);
    await request("/v1/repositories", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ root, repository_id: "repo-1" }) });
    await request("/v1/repositories", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ root: secondRoot, repository_id: "repo-2" }) });

    const response = await request("/v1/repositories");
    expect(response.status).toBe(200);
    const payload = await json<{ success: true; data: Array<{ repository_id: string; root: string; created_at: string }> }>(response);
    expect(payload.success).toBe(true);
    expect(payload.data.map((repository) => repository.repository_id).sort()).toEqual(["repo-1", "repo-2"]);
    const [canonicalRoot, canonicalSecondRoot] = await Promise.all([realpath(root), realpath(secondRoot)]);
    expect(payload.data.find((repository) => repository.repository_id === "repo-1")?.root).toBe(canonicalRoot);
    expect(payload.data.find((repository) => repository.repository_id === "repo-2")?.root).toBe(canonicalSecondRoot);
    for (const repository of payload.data) {
      expect(repository.created_at.length).toBeGreaterThan(0);
    }
  });

  test("serializes concurrent same-record submissions and returns sources for the stored record", async () => {
    await request("/v1/repositories", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ root, repository_id: "repo-1" }) });
    await request("/v1/sessions", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ session_id: "session-1", repository_id: "repo-1", agent_type: "codex", started_at: "2026-08-20T00:00:00Z", status: "active" }) });
    const [first, second] = await Promise.all([
      request("/v1/decision-records", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body("same-record", "session-1", "src/example.ts")) }),
      request("/v1/decision-records", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body("same-record", "session-1", "src/other.ts")) }),
    ]);
    expect([first.status, second.status].sort()).toEqual([201, 409]);
    const conflict = first.status === 409 ? first : second;
    expect(await json<{ success: false; error: { code: string } }>(conflict)).toMatchObject({ success: false, error: { code: "DUPLICATE_RECORD" } });
    const created = first.status === 201 ? first : second;
    const payload = await json<{ success: true; data: { record: { targets: Array<{ path: string }> }; sources: Array<{ path: string }> } }>(created);
    expect(payload.data.sources[0]?.path).toBe(payload.data.record.targets[0]?.path);
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
  test("rejects a dangling database symlink whose target enters the public UI root", async () => {
    const externalDataDir = await mkdtemp(join(tmpdir(), "ai-review-http-dangling-data-"));
    temporaryDirectories.push(externalDataDir);
    const databaseLink = join(externalDataDir, "dangling.sqlite");
    await symlink(join(uiRoot, "missing.sqlite"), databaseLink, "file");
    expect((await lstat(databaseLink)).isSymbolicLink()).toBe(true);
    const config = createRecorderConfig({ dataDir: externalDataDir, databasePath: databaseLink });
    await expect(createRecorderServer({ config, uiRoot, port: 0 })).rejects.toThrow();
  });

  test("stores the owner token with restrictive permissions and binds to loopback", async () => {
    expect(app.config.bindAddress).toBe("127.0.0.1");
    expect(app.server.hostname).toBe("127.0.0.1");
    expect((await stat(app.config.tokenPath)).mode & 0o777).toBe(0o600);
    expect((await readFile(app.config.tokenPath, "utf8")).trim()).toBe(token);
  });

  test("lists tracked repository files for the explorer", async () => {
    await runGit(["init", "--quiet"]);
    await runGit(["config", "user.email", "fixture@example.test"]);
    await runGit(["config", "user.name", "Fixture"]);
    await runGit(["add", "--", "src/example.ts", "src/other.ts"]);
    await runGit(["commit", "--quiet", "-m", "tracked"]);
    await request("/v1/repositories", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ root, repository_id: "repo-1" }) });

    const unauthorized = await fetch(`${app.server.url}/v1/repositories/repo-1/files`);
    expect(unauthorized.status).toBe(401);

    const response = await request("/v1/repositories/repo-1/files");
    expect(response.status).toBe(200);
    expect(await json<{ success: true; data: { repository_id: string; paths: string[] } }>(response)).toEqual({
      success: true,
      data: { repository_id: "repo-1", paths: ["src/example.ts", "src/other.ts"] },
    });

    const unregistered = await request("/v1/repositories/repo-missing/files");
    expect(unregistered.status).toBe(404);
    expect(await json<{ success: false; error: { code: string } }>(unregistered)).toMatchObject({ success: false, error: { code: "REPOSITORY_NOT_REGISTERED" } });
  });

  test("creates an automatic snapshot only for the current target state", async () => {
    await setupAutomaticFixture();
    const response = await postAutomatic("record-1", "capture-http-1", "src/example.ts", "export const answer = 42;\n");
    expect(response.status).toBe(201);
    const payload = await json<{ success: true; data: { capture_kind: string; mode: string; path: string; source_path: string; base_sha?: string } }>(response);
    expect(payload.data).toMatchObject({ capture_kind: "automatic", mode: "git", path: "", source_path: "src/example.ts" });
    expect(payload.data.base_sha).toMatch(/^[0-9a-f]{40}$/);
  });

  test("automatic capture is idempotent and rejects a changed retry", async () => {
    await setupAutomaticFixture();
    const input = { captureId: "capture-http-repeat", sourcePath: "src/example.ts", content: "before\n" };
    const first = await postAutomatic("record-1", input.captureId, input.sourcePath, input.content);
    const second = await postAutomatic("record-1", input.captureId, input.sourcePath, input.content);
    expect(first.status).toBe(201);
    expect(second.status).toBe(200);
    expect((await json<{ success: true; data: { snapshot_id: string } }>(first)).data.snapshot_id)
      .toBe((await json<{ success: true; data: { snapshot_id: string } }>(second)).data.snapshot_id);

    const conflict = await postAutomatic("record-1", input.captureId, input.sourcePath, "different\n");
    expect(conflict.status).toBe(422);
    expect(await json<{ success: false; error: { code: string } }>(conflict)).toMatchObject({ success: false, error: { code: "INVALID_RECORD" } });
  });

  test("returns the original reference when HEAD eligibility changes on retry", async () => {
    await setupAutomaticFixture();
    const content = "before\n";
    const first = await postAutomatic("record-1", "capture-http-head-change", "src/example.ts", content);
    expect(first.status).toBe(201);
    const firstPayload = await json<{ success: true; data: { snapshot_id: string; mode: string; path: string; source_path: string; content_hash: string; before_missing: boolean } }>(first);
    expect(firstPayload.data.mode).toBe("changed-files");

    await runGit(["add", "--", "src/example.ts"]);
    await runGit(["commit", "--quiet", "-m", "capture-content"]);

    const retry = await postAutomatic("record-1", "capture-http-head-change", "src/example.ts", content);
    expect(retry.status).toBe(200);
    const retryPayload = await json<{ success: true; data: { snapshot_id: string; mode: string; path: string; source_path: string; content_hash: string; before_missing: boolean } }>(retry);
    expect(retryPayload.data).toEqual(firstPayload.data);
  });

  test("does not report a file-backed capture as successful when its evidence is missing or corrupted", async () => {
    await setupAutomaticFixture();
    const content = "before-file-backed\n";
    const first = await postAutomatic("record-1", "capture-http-file-integrity", "src/example.ts", content);
    expect(first.status).toBe(201);
    const firstPayload = await json<{ success: true; data: { mode: string; path: string } }>(first);
    expect(firstPayload.data.mode).toBe("changed-files");

    await rm(join(dataDir, firstPayload.data.path), { force: true });
    const missing = await postAutomatic("record-1", "capture-http-file-integrity", "src/example.ts", content);
    expect(missing.status).toBe(422);
    expect(await json<{ success: false; error: { code: string } }>(missing)).toMatchObject({ success: false, error: { code: "SOURCE_UNAVAILABLE" } });

    await writeFile(join(dataDir, firstPayload.data.path), "tampered\n", "utf8");
    const corrupted = await postAutomatic("record-1", "capture-http-file-integrity", "src/example.ts", content);
    expect(corrupted.status).toBe(422);
    expect(await json<{ success: false; error: { code: string } }>(corrupted)).toMatchObject({ success: false, error: { code: "SOURCE_UNAVAILABLE" } });
  });

  test("serves snapshot-to-snapshot and snapshot-to-worktree transition diffs", async () => {
    await setupAutomaticFixture();
    const before = await postAutomatic("record-1", "capture-http-before", "src/example.ts", "one\n");
    const next = await postAutomatic("record-2", "capture-http-next", "src/example.ts", "two\n");
    expect(before.status).toBe(201);
    expect(next.status).toBe(201);
    const beforePayload = await json<{ success: true; data: { snapshot_id: string } }>(before);
    const transition = await request("/v1/decision-records/record-1/snapshot-diff?path=src%2Fexample.ts");
    expect(transition.status).toBe(200);
    expect(await json<{ success: true; data: { state: string; from: { snapshot_id: string }; to: { kind: string } } }>(transition)).toMatchObject({
      success: true,
      data: { state: "snapshot-resolved", from: { snapshot_id: beforePayload.data.snapshot_id }, to: { kind: "snapshot" } },
    });

    await writeFile(join(root, "src", "example.ts"), "three\n", "utf8");
    const worktreeTransition = await request("/v1/decision-records/record-2/snapshot-diff?path=src%2Fexample.ts");
    expect(worktreeTransition.status).toBe(200);
    expect(await json<{ success: true; data: { state: string; to: { kind: string } } }>(worktreeTransition)).toMatchObject({
      success: true,
      data: { state: "snapshot-resolved", to: { kind: "working-tree" } },
    });
  });

  test("returns legacy fallback for records without automatic snapshots", async () => {
    await setupAutomaticFixture();
    const response = await request("/v1/decision-records/manual-record/snapshot-diff?path=src%2Fexample.ts");
    expect(response.status).toBe(200);
    expect(await json<{ success: true; data: { state: string; reason: string } }>(response)).toMatchObject({
      success: true,
      data: { state: "legacy-fallback", reason: "automatic-snapshot-not-found" },
    });
  });

  test("requires authentication for automatic capture and transition reads", async () => {
    await setupAutomaticFixture();
    const automaticPath = `${app.server.url}/v1/decision-records/record-1/automatic-snapshot`;
    const transitionPath = `${app.server.url}/v1/decision-records/record-1/snapshot-diff?path=src%2Fexample.ts`;
    const missing = await fetch(automaticPath, { method: "POST", headers: { "Content-Type": "application/json" }, body: "{}" });
    expect(missing.status).toBe(401);
    const incorrect = await fetch(transitionPath, { headers: { Authorization: "Bearer incorrect-token" } });
    expect(incorrect.status).toBe(401);
    const authenticated = await request("/v1/decision-records/record-1/snapshot-diff?path=src%2Fexample.ts");
    expect(authenticated.status).toBe(200);
  });

  test("rejects disallowed origins and unknown records for automatic capture", async () => {
    await setupAutomaticFixture();
    const disallowed = await postAutomatic("record-1", "capture-http-origin", "src/example.ts", "origin\n", false, { Origin: "https://evil.example" });
    expect(disallowed.status).toBe(403);
    expect(await json<{ success: false; error: { code: string } }>(disallowed)).toMatchObject({ success: false, error: { code: "UNAUTHORIZED" } });

    const unknown = await postAutomatic("missing-record", "capture-http-unknown", "src/example.ts", "unknown\n");
    expect(unknown.status).toBe(404);
    expect(await json<{ success: false; error: { code: string } }>(unknown)).toMatchObject({ success: false, error: { code: "INVALID_RECORD" } });
  });

  test("enforces exact target ownership and path normalization for automatic capture and diffs", async () => {
    await setupAutomaticFixture();
    const nonTarget = await postAutomatic("record-1", "capture-http-non-target", "src/other.ts", "other\n");
    expect(nonTarget.status).toBe(422);
    expect(await json<{ success: false; error: { code: string } }>(nonTarget)).toMatchObject({ success: false, error: { code: "INVALID_RECORD" } });

    const traversal = await request("/v1/decision-records/record-1/automatic-snapshot", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ capture_id: "capture-http-traversal", source_path: "../src/example.ts", content: "unsafe\n", before_missing: false }),
    });
    expect(traversal.status).toBe(422);
    expect(await json<{ success: false; error: { code: string } }>(traversal)).toMatchObject({ success: false, error: { code: "PATH_OUTSIDE_ROOT" } });

    const traversalDiff = await request("/v1/decision-records/record-1/snapshot-diff?path=..%2Fsrc%2Fexample.ts");
    expect(traversalDiff.status).toBe(422);
    expect(await json<{ success: false; error: { code: string } }>(traversalDiff)).toMatchObject({ success: false, error: { code: "PATH_OUTSIDE_ROOT" } });

    const missingPath = await request("/v1/decision-records/record-1/snapshot-diff");
    expect(missingPath.status).toBe(422);
    expect(await json<{ success: false; error: { code: string; field?: string } }>(missingPath)).toMatchObject({ success: false, error: { code: "INVALID_RECORD", field: "path" } });
    const nonTargetDiff = await request("/v1/decision-records/record-1/snapshot-diff?path=src%2Fother.ts");
    expect(nonTargetDiff.status).toBe(200);
    expect(await json<{ success: true; data: { state: string; path: string } }>(nonTargetDiff)).toMatchObject({ success: true, data: { state: "source-unavailable", path: "src/other.ts" } });
  });

  test("rejects automatic capture when current content or missing state differs", async () => {
    await setupAutomaticFixture();
    await writeFile(join(root, "src", "example.ts"), "observed\n", "utf8");
    const hashConflict = await request("/v1/decision-records/record-1/automatic-snapshot", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ capture_id: "capture-http-hash-conflict", source_path: "src/example.ts", content: "submitted\n", before_missing: false }),
    });
    expect(hashConflict.status).toBe(422);
    expect(await json<{ success: false; error: { code: string } }>(hashConflict)).toMatchObject({ success: false, error: { code: "HASH_MISMATCH" } });

    await rm(join(root, "src", "example.ts"), { force: true });
    const missingConflict = await request("/v1/decision-records/record-1/automatic-snapshot", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ capture_id: "capture-http-missing-conflict", source_path: "src/example.ts", content: "", before_missing: false }),
    });
    expect(missingConflict.status).toBe(422);
    expect(await json<{ success: false; error: { code: string } }>(missingConflict)).toMatchObject({ success: false, error: { code: "HASH_MISMATCH" } });

    const missing = await postAutomatic("record-1", "capture-http-missing", "src/example.ts", "", true);
    expect(missing.status).toBe(201);
  });

  test("rejects malformed and oversized automatic snapshot requests", async () => {
    await setupAutomaticFixture();
    const missingField = await request("/v1/decision-records/record-1/automatic-snapshot", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ capture_id: "capture-http-missing-field", source_path: "src/example.ts", content: "missing\n" }),
    });
    expect(missingField.status).toBe(422);

    const extraField = await request("/v1/decision-records/record-1/automatic-snapshot", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ capture_id: "capture-http-extra", source_path: "src/example.ts", content: "extra\n", before_missing: false, mode: "patch" }),
    });
    expect(extraField.status).toBe(422);

    const wrongType = await request("/v1/decision-records/record-1/automatic-snapshot", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ capture_id: "capture-http-type", source_path: "src/example.ts", content: "type\n", before_missing: "false" }),
    });
    expect(wrongType.status).toBe(422);

    const limitedDataDir = await mkdtemp(join(tmpdir(), "ai-review-http-automatic-limit-data-"));
    const limitedUiRoot = await mkdtemp(join(tmpdir(), "ai-review-http-automatic-limit-ui-"));
    temporaryDirectories.push(limitedDataDir, limitedUiRoot);
    const limitedApp = await createRecorderServer({
      config: createRecorderConfig({ dataDir: limitedDataDir, maxSnapshotContentLength: 64 }),
      maxJsonBytes: 2_000_000,
      port: 0,
      uiRoot: limitedUiRoot,
    });
    try {
      const limitedToken = await readOwnerToken(limitedApp.config);
      const limitedRepository = await requestTo(limitedApp, limitedToken, "/v1/repositories", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ root, repository_id: "repo-1" }),
      });
      expect(limitedRepository.status).toBe(201);
      const limitedSession = await requestTo(limitedApp, limitedToken, "/v1/sessions", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ session_id: "limited-session", repository_id: "repo-1", agent_type: "codex", started_at: "2026-08-20T00:00:00Z", status: "active" }),
      });
      expect(limitedSession.status).toBe(201);
      const limitedRecord = await requestTo(limitedApp, limitedToken, "/v1/decision-records", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body("limited-record", "limited-session")),
      });
      expect(limitedRecord.status).toBe(201);

      const oversizedContent = "x".repeat(100);
      await writeFile(join(root, "src", "example.ts"), oversizedContent, "utf8");
      const oversized = await requestTo(limitedApp, limitedToken, "/v1/decision-records/limited-record/automatic-snapshot", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ capture_id: "capture-http-large", source_path: "src/example.ts", content: oversizedContent, before_missing: false }),
      });
      expect(oversized.status).toBe(413);
      expect(await json<{ success: false; error: { code: string } }>(oversized)).toMatchObject({ success: false, error: { code: "PAYLOAD_TOO_LARGE" } });
    } finally {
      await limitedApp.stop();
    }

    const wrongAutomaticRoute = await request("/v1/decision-records/record-1/automatic-snapshot/extra", { method: "POST", headers: { "Content-Type": "application/json" }, body: "{}" });
    expect(wrongAutomaticRoute.status).toBe(404);
    const wrongDiffRoute = await request("/v1/decision-records/record-1/snapshot-diff/extra?path=src%2Fexample.ts");
    expect(wrongDiffRoute.status).toBe(404);
  });

  test("uses the requested path when two targets have the same HEAD content", async () => {
    await setupAutomaticFixture();
    const record = await app.service.getDecision("record-1");
    expect(record).not.toBeNull();
    if (record === null) return;
    const target = record.targets[0]!;
    app.store.db.query(
      `INSERT INTO targets (
         record_id, target_index, repository_id, path, line_start, line_end,
         revision_kind, revision_value, content_hash
       ) VALUES ($record_id, $target_index, $repository_id, $path, $line_start, $line_end,
         $revision_kind, $revision_value, $content_hash)`,
    ).run({
      $record_id: "record-1",
      $target_index: 1,
      $repository_id: target.repository_id,
      $path: "src/other.ts",
      $line_start: target.line_start,
      $line_end: target.line_end,
      $revision_kind: target.revision.kind,
      $revision_value: target.revision.kind === "commit" ? target.revision.sha : target.revision.contentHash,
      $content_hash: target.content_hash,
    });
    await writeFile(join(root, "src", "other.ts"), "export const answer = 42;\n", "utf8");
    await runGit(["add", "--", "src/other.ts"]);
    await runGit(["commit", "--quiet", "-m", "same-content"]);
    const response = await postAutomatic("record-1", "capture-http-exact-head-path", "src/other.ts", "export const answer = 42;\n");
    expect(response.status).toBe(201);
    const payload = await json<{ success: true; data: { mode: string; path: string; source_path: string; base_sha?: string } }>(response);
    expect(payload.data).toMatchObject({ mode: "git", path: "", source_path: "src/other.ts" });
    expect(payload.data.base_sha).toMatch(/^[0-9a-f]{40}$/);
  });

  test("returns source-unavailable for a corrupted next automatic snapshot", async () => {
    await setupAutomaticFixture();
    const before = await postAutomatic("record-1", "capture-http-corrupt-before", "src/example.ts", "one\n");
    const next = await postAutomatic("record-2", "capture-http-corrupt-next", "src/example.ts", "two\n");
    const nextPayload = await json<{ success: true; data: { path: string } }>(next);
    expect(before.status).toBe(201);
    expect(next.status).toBe(201);
    await writeFile(join(dataDir, nextPayload.data.path), "tampered\n", "utf8");

    const response = await request("/v1/decision-records/record-1/snapshot-diff?path=src%2Fexample.ts");
    expect(response.status).toBe(200);
    expect(await json<{ success: true; data: { state: string; path: string } }>(response)).toMatchObject({ success: true, data: { state: "source-unavailable", path: "src/example.ts" } });
  });

  test("stores a git-backed reference when snapshot content matches HEAD and serves it back", async () => {
    await runGit(["init"]);
    await runGit(["config", "user.email", "fixture@example.test"]);
    await runGit(["config", "user.name", "Fixture"]);
    await writeFile(join(root, "src", "example.ts"), "export const answer = 42;\n", "utf8");
    await runGit(["add", "--", "src/example.ts"]);
    await runGit(["commit", "-m", "fixture"]);
    await request("/v1/repositories", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ root, repository_id: "repo-1" }),
    });
    await request("/v1/sessions", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ repository_id: "repo-1", agent_type: "codex", session_id: "session-1", started_at: "2026-08-20T00:00:00Z", status: "active" }),
    });
    await request("/v1/decision-records", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body()),
    });

    const stored = await request("/v1/decision-records/record-1/snapshot", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ mode: "patch", content: "export const answer = 42;\n" }),
    });
    expect(stored.status).toBe(201);
    const payload = await json<{ success: true; data: { mode: string; path: string; base_sha?: string; snapshot_id: string } }>(stored);
    expect(payload.data.mode).toBe("git");
    expect(payload.data.path).toBe("");
    expect(payload.data.base_sha).toMatch(/^[0-9a-f]{40}$/);

    const source = await request("/v1/decision-records/record-1/source?source=snapshot:" + payload.data.snapshot_id);
    expect(await json<{ success: true; data: { state: string; content: string } }>(source)).toMatchObject({
      success: true,
      data: { state: "snapshot-resolved", content: "export const answer = 42;\n" },
    });
  });

  test("falls back to a file-backed snapshot for a SHA-256 repository", async () => {
    await runGit(["init", "--quiet", "--object-format=sha256"]);
    await runGit(["config", "user.email", "fixture@example.test"]);
    await runGit(["config", "user.name", "Fixture"]);
    await writeFile(join(root, "src", "example.ts"), "export const answer = 42;\n", "utf8");
    await runGit(["add", "--", "src/example.ts"]);
    await runGit(["commit", "--quiet", "-m", "fixture"]);

    const repository = await request("/v1/repositories", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ root, repository_id: "repo-1" }),
    });
    expect(repository.status).toBe(201);
    const session = await request("/v1/sessions", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ repository_id: "repo-1", agent_type: "codex", session_id: "session-1", started_at: "2026-08-20T00:00:00Z", status: "active" }),
    });
    expect(session.status).toBe(201);
    const record = await request("/v1/decision-records", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body()),
    });
    expect(record.status).toBe(201);

    const stored = await request("/v1/decision-records/record-1/snapshot", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ mode: "patch", content: "export const answer = 42;\n" }),
    });
    expect(stored.status).toBe(201);
    const payload = await json<{ success: true; data: { mode: string; base_sha?: string; snapshot_id: string } }>(stored);
    expect(payload.data.mode).toBe("patch");
    expect(payload.data.base_sha).toBeUndefined();

    const source = await request(`/v1/decision-records/record-1/source?source=snapshot:${payload.data.snapshot_id}`);
    expect(await json<{ success: true; data: { state: string; content: string } }>(source)).toMatchObject({
      success: true,
      data: { state: "snapshot-resolved", content: "export const answer = 42;\n" },
    });
  });

  test("stores a regular snapshot when content does not match any HEAD blob", async () => {
    await request("/v1/repositories", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ root, repository_id: "repo-1" }),
    });
    await request("/v1/sessions", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ repository_id: "repo-1", agent_type: "codex", session_id: "session-1", started_at: "2026-08-20T00:00:00Z", status: "active" }),
    });
    await request("/v1/decision-records", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body()),
    });
    const stored = await request("/v1/decision-records/record-1/snapshot", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ mode: "patch", content: "unmatchable text\n" }),
    });
    expect(stored.status).toBe(201);
    const payload = await json<{ success: true; data: { mode: string } }>(stored);
    expect(payload.data.mode).toBe("patch");
  });

  test("returns a structured path diff against the recorded revision or HEAD", async () => {
    await request("/v1/repositories", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ root, repository_id: "repo-1" }) });
    await writeFile(join(root, "src", "example.ts"), "first source\nsecond line\n", "utf8");
    await runGit(["init", "--quiet"]);
    await runGit(["config", "user.email", "fixture@example.test"]);
    await runGit(["config", "user.name", "Fixture"]);
    await runGit(["add", "--", "src/example.ts"]);
    await runGit(["commit", "--quiet", "-m", "base"]);
    const baseSha = await new Promise<string>((resolve, reject) => {
      const child = spawn("git", ["rev-parse", "HEAD"], { cwd: root, stdio: ["ignore", "pipe", "pipe"] });
      let stdout = "";
      child.stdout.on("data", (chunk: Buffer) => { stdout += chunk.toString(); });
      child.once("exit", (code) => (code === 0 ? resolve(stdout.trim()) : reject(new Error("rev-parse failed"))));
    });
    // Restore the pre-commit working-tree content so both diff sides exist.
    await writeFile(join(root, "src", "example.ts"), "changed source\n", "utf8");
    const response = await request(`/v1/repositories/repo-1/diff?path=${encodeURIComponent("src/example.ts")}&base=${baseSha}`);
    expect(response.status).toBe(200);
    const payload = await json<{ success: true; data: { path: string; base_sha: string; binary: boolean; hunks: Array<{ lines: Array<{ type: string; oldLine: number | null; newLine: number | null; content: string }> }> } }>(response);
    expect(payload.success).toBe(true);
    expect(payload.data.path).toBe("src/example.ts");
    expect(payload.data.base_sha).toBe(baseSha);
    expect(payload.data.binary).toBe(false);
    const lines = payload.data.hunks[0]!.lines;
    expect(lines.find((line) => line.type === "del")?.content).toBe("first source");
    expect(lines.find((line) => line.type === "add")?.content).toBe("changed source");

    const headResponse = await request(`/v1/repositories/repo-1/diff?path=${encodeURIComponent("src/example.ts")}`);
    expect(headResponse.status).toBe(200);

    const missingPath = await request(`/v1/repositories/repo-1/diff`);
    expect(missingPath.status).toBe(422);

    const outside = await request(`/v1/repositories/repo-1/diff?path=${encodeURIComponent("../outside.ts")}`);
    expect(outside.status).toBe(422);
    expect(await json<{ success: false; error: { code: string } }>(outside)).toMatchObject({ success: false, error: { code: "PATH_OUTSIDE_ROOT" } });

    const badRevision = await request(`/v1/repositories/repo-1/diff?path=${encodeURIComponent("src/example.ts")}&base=$(touch /tmp/pwned)`);
    expect(badRevision.status).toBe(404);
    expect(await json<{ success: false; error: { code: string } }>(badRevision)).toMatchObject({ success: false, error: { code: "REVISION_NOT_FOUND" } });

    const unregistered = await request(`/v1/repositories/repo-missing/diff?path=src/example.ts`);
    expect(unregistered.status).toBe(404);
  });

  test("rejects oversized working-tree sources on the diff endpoint with 413", async () => {
    const limitedDataDir = await mkdtemp(join(tmpdir(), "ai-review-http-diff-limit-"));
    temporaryDirectories.push(limitedDataDir);
    const limitedRoot = await mkdtemp(join(tmpdir(), "ai-review-http-diff-root-"));
    temporaryDirectories.push(limitedRoot);
    const limitedUi = await mkdtemp(join(tmpdir(), "ai-review-http-diff-ui-"));
    temporaryDirectories.push(limitedUi);
    await mkdir(join(limitedRoot, "src"), { recursive: true });
    await writeFile(join(limitedRoot, "src", "example.ts"), "x".repeat(64), "utf8");
    // A maxSourceBytes-limited server cannot register repositories via POST /v1/repositories:
    // discoverGitTopLevel bounds `git rev-parse --show-toplevel` output at the source limit and any
    // canonical root path exceeds it, so registration itself fails with PAYLOAD_TOO_LARGE before the
    // diff route runs. Seed the row through RecordStore so the request exercises the diff route's
    // own PAYLOAD_TOO_LARGE mapping.
    const seedStore = new RecordStore(createRecorderConfig({ dataDir: limitedDataDir }));
    await seedStore.createRepository({ repository_id: "limited-repo", root: await realpath(limitedRoot) });
    seedStore.close();
    const limitedApp = await createRecorderServer({
      config: createRecorderConfig({ dataDir: limitedDataDir, port: 0, maxSourceBytes: 16 }),
      uiRoot: limitedUi,
      port: 0,
    });
    try {
      const limitedToken = await readOwnerToken(limitedApp.config);
      const limitedHeaders = new Headers({ Authorization: `Bearer ${limitedToken}` });
      const response = await fetch(`${limitedApp.server.url}/v1/repositories/limited-repo/diff?path=src/example.ts`, { headers: limitedHeaders });
      expect(response.status).toBe(413);
      expect(await response.json()).toMatchObject({ success: false, error: { code: "PAYLOAD_TOO_LARGE" } });
    } finally {
      await limitedApp.stop();
    }
  });
});
