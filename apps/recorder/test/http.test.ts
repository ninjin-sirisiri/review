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

async function json<T>(response: Response): Promise<T> {
  return response.json() as Promise<T>;
}

async function runGit(args: string[]): Promise<void> {
  const child = spawn("git", args, { cwd: root, stdio: ["ignore", "pipe", "pipe"] });
  const exitCode = await new Promise<number>((resolve) => child.once("exit", (code) => resolve(code ?? 1)));
  if (exitCode !== 0) throw new Error(`git ${args.join(" ")} failed`);
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
