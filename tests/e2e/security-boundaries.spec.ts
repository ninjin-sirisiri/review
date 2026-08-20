import { createHash, randomUUID } from "node:crypto";
import { spawn, type ChildProcess } from "node:child_process";
import { mkdir, mkdtemp, readFile, realpath, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, test } from "@playwright/test";
import type { DecisionRecord, DecisionRecordInput, RevisionRef, SnapshotReference } from "../../packages/contracts/src/index";

const PROJECT_ROOT = process.cwd();
const UI_ROOT = join(PROJECT_ROOT, "apps/review-ui/dist");
const temporaryDirectories: string[] = [];
interface RecorderProcess {
  url: string;
  tokenPath: string;
  token: string;
  process: ChildProcess;
}
let app: RecorderProcess;
let token: string;
let securityRoot: string;
let securityRepositoryId: string;
let xssRoot: string;
let xssRepositoryId: string;
let largeRoot: string;
let largeRepositoryId: string;

async function runCommand(cwd: string, cmd: string[]): Promise<string> {
  const child = spawn(cmd[0]!, cmd.slice(1), { cwd, env: { ...process.env }, stdio: ["ignore", "pipe", "pipe"] });
  let stdout = "";
  let stderr = "";
  child.stdout.on("data", (chunk: Buffer) => { stdout += chunk.toString(); });
  child.stderr.on("data", (chunk: Buffer) => { stderr += chunk.toString(); });
  const exitCode = await new Promise<number>((resolve, reject) => {
    child.once("error", reject);
    child.once("exit", (code) => resolve(code ?? 1));
  });
  if (exitCode === 0) throw new Error(`expected ${cmd.join(" ")} to fail`);
  return `${stdout}${stderr}`;
}
async function startRecorder(dataDir: string): Promise<RecorderProcess> {
  const child = spawn("bun", ["apps/recorder/src/index.ts", "--data-dir", dataDir, "--port", "0", "--ui-root", UI_ROOT], {
    cwd: PROJECT_ROOT,
    env: { ...process.env },
    stdio: ["ignore", "pipe", "pipe"],
  });
  let output = "";
  child.stderr!.resume();
  const started = await new Promise<{ url: string; tokenPath: string }>((resolve, reject) => {
    const onOutput = (chunk: Buffer) => {
      output += chunk.toString();
      const url = output.match(/Recorder listening at (http:\/\/127\.0\.0\.1:\d+)/)?.[1];
      const tokenPath = output.match(/Recorder token: (.+)/)?.[1]?.trim();
      if (url !== undefined && tokenPath !== undefined) {
        child.stdout!.off("data", onOutput);
        resolve({ url, tokenPath });
      }
    };
    child.stdout!.on("data", onOutput);
    child.once("error", reject);
    child.once("exit", (code) => reject(new Error(`Recorder exited before startup (${code}): ${output}`)));
  });
  const recorderToken = (await readFile(started.tokenPath, "utf8")).trim();
  return { ...started, token: recorderToken, process: child };
}

async function stopRecorder(recorder: RecorderProcess): Promise<void> {
  recorder.process.kill("SIGTERM");
  await new Promise<void>((resolve) => recorder.process.once("exit", () => resolve()));
}

async function createGitRepository(name: string, path: string, content: string): Promise<{ root: string; repositoryId: string; path: string; content: string; contentHash: string; commitSha: string }> {
  const root = await mkdtemp(join(tmpdir(), `ai-review-security-${name}-`));
  temporaryDirectories.push(root);
  await mkdir(join(root, path, ".."), { recursive: true });
  await writeFile(join(root, path), content, "utf8");
  const runGit = async (args: string[]) => {
    const child = spawn("git", args, { cwd: root, stdio: ["ignore", "pipe", "pipe"] });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (chunk: Buffer) => { stdout += chunk.toString(); });
    child.stderr.on("data", (chunk: Buffer) => { stderr += chunk.toString(); });
    const exitCode = await new Promise<number>((resolve, reject) => {
      child.once("error", reject);
      child.once("exit", (code) => resolve(code ?? 1));
    });
    if (exitCode !== 0) throw new Error(`git ${args.join(" ")} failed: ${stderr}`);
    return stdout.trim();
  };
  await runGit(["init", "--quiet"]);
  await runGit(["config", "user.email", "fixture@example.test"]);
  await runGit(["config", "user.name", "Fixture"]);
  await runGit(["add", "--", path]);
  await runGit(["commit", "--quiet", "-m", "fixture"]);
  const canonicalRoot = await realpath(root);
  return {
    root: canonicalRoot,
    repositoryId: createHash("sha256").update(canonicalRoot, "utf8").digest("hex"),
    path,
    content,
    contentHash: createHash("sha256").update(content, "utf8").digest("hex"),
    commitSha: await runGit(["rev-parse", "HEAD"]),
  };
}

async function apiRequest(path: string, init: RequestInit = {}, options: { bearer?: string; origin?: string | null } = {}): Promise<Response> {
  const headers = new Headers(init.headers);
  const bearer = options.bearer ?? token;
  headers.set("Authorization", `Bearer ${bearer}`);
  if (options.origin !== null && init.method !== undefined && init.method !== "GET" && init.method !== "HEAD") {
    headers.set("Origin", options.origin ?? "http://127.0.0.1");
  }
  return fetch(`${app.url}${path}`, { ...init, headers });
}

async function postJson(path: string, value: unknown, options: { bearer?: string; origin?: string | null } = {}): Promise<Response> {
  return apiRequest(path, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(value),
  }, options);
}
async function createSession(repositoryId: string, agentType: "codex" | "claude-code" = "codex"): Promise<string> {
  const sessionId = `security-session-${randomUUID()}`;
  const response = await postJson("/v1/sessions", {
    session_id: sessionId,
    repository_id: repositoryId,
    agent_type: agentType,
    started_at: new Date().toISOString(),
    status: "active",
  });
  expect(response.status).toBe(201);
  return sessionId;
}

function recordInput(repositoryId: string, sessionId: string, path: string, contentHash: string, revision: RevisionRef = { kind: "working-tree", contentHash }, recordId = `security-record-${randomUUID()}`): DecisionRecordInput {
  return {
    record_id: recordId,
    session_id: sessionId,
    repository_id: repositoryId,
    agent_type: "codex",
    revision,
    targets: [{ repository_id: repositoryId, path, line_start: 1, line_end: 1, revision, content_hash: contentHash }],
    judgment: `Security fixture ${recordId}`,
    rationale: "Boundary behavior is recorded without exposing unbounded source data.",
    checks: [],
    open_questions: [],
    created_at: new Date().toISOString(),
  };
}

async function createRecord(input: DecisionRecordInput, expectedStatus = 201): Promise<{ response: Response; body: Record<string, unknown> }> {
  const response = await postJson("/v1/decision-records", input);
  expect(response.status).toBe(expectedStatus);
  return { response, body: await response.json() as Record<string, unknown> };
}

test.beforeAll(async () => {
  const dataDir = await mkdtemp(join(tmpdir(), "ai-review-security-data-"));
  temporaryDirectories.push(dataDir);
  const security = await createGitRepository("root", "src/secure.ts", "export const secure = true;\n");
  const xss = await createGitRepository("xss", "src/unsafe.ts", "<script>window.__reviewXss = true</script>\n");
  const large = await createGitRepository("large", "src/large.ts", "x".repeat(512));
  securityRoot = security.root;
  securityRepositoryId = security.repositoryId;
  xssRoot = xss.root;
  xssRepositoryId = xss.repositoryId;
  largeRoot = large.root;
  largeRepositoryId = large.repositoryId;
  await mkdir(join(securityRoot, "src", "nested", ".git"), { recursive: true });
  await writeFile(join(securityRoot, "src", "nested", "inside.ts"), "nested\n", "utf8");
  const outside = await mkdtemp(join(tmpdir(), "ai-review-security-outside-"));
  temporaryDirectories.push(outside);
  await writeFile(join(outside, "secret.ts"), "outside secret\n", "utf8");
  await symlink(join(outside, "secret.ts"), join(securityRoot, "src", "direct-link.ts"));
  await symlink(outside, join(securityRoot, "src", "parent-link"));
  await writeFile(join(securityRoot, "src", "first.ts"), "first source\n", "utf8");
  await writeFile(join(securityRoot, "src", "second.ts"), "second source\n", "utf8");

  app = await startRecorder(dataDir);
  token = app.token;
  for (const repository of [security, xss, large]) {
    const response = await postJson("/v1/repositories", { root: repository.root, repository_id: repository.repositoryId });
    expect(response.status).toBe(201);
  }
});

test.afterAll(async () => {
  if (app !== undefined) await stopRecorder(app);
  await Promise.all(temporaryDirectories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })));
});

test("rejects invalid bearer tokens while keeping the public UI shell available", async ({ page }) => {
  const unauthorized = await apiRequest("/v1/decision-records?repository_id=missing", {}, { bearer: "wrong-token" });
  expect(unauthorized.status).toBe(401);
  expect(await unauthorized.json()).toMatchObject({ success: false, error: { code: "UNAUTHORIZED" } });

  await page.goto(app.url);
  await expect(page.getByRole("heading", { name: "Review decisions with their source" })).toBeVisible();
});

test("rejects oversized chunked JSON and malformed UTF-8 before persistence", async () => {
  const encoder = new TextEncoder();
  const oversized = new ReadableStream<Uint8Array>({
    start(controller) {
      controller.enqueue(encoder.encode('{"root":"'));
      controller.enqueue(encoder.encode("x".repeat(1_000_100)));
      controller.enqueue(encoder.encode('"}'));
      controller.close();
    },
  });
  const tooLarge = await apiRequest("/v1/repositories", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: oversized,
    duplex: "half",
  } as RequestInit & { duplex: "half" });
  expect(tooLarge.status).toBe(413);
  expect(await tooLarge.json()).toMatchObject({ success: false, error: { code: "PAYLOAD_TOO_LARGE" } });

  const malformed = await apiRequest("/v1/repositories", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: new Uint8Array([0xff, 0xfe, 0xfd]),
  });
  expect(malformed.status).toBe(400);
  expect(await malformed.json()).toMatchObject({ success: false, error: { code: "INVALID_RECORD" } });
});

test("rejects root-outside, direct symlink, parent-symlink, and unregistered nested Git targets", async () => {
  const outside = join(securityRoot, "src", "outside.ts");
  const rootOutside = await createRecord(recordInput(securityRepositoryId, "unused", "../outside.ts", "hash"), 422);
  expect(rootOutside.body).toMatchObject({ success: false, error: { code: "PATH_OUTSIDE_ROOT" } });

  for (const path of ["src/direct-link.ts", "src/parent-link/secret.ts"]) {
    const sessionId = await createSession(securityRepositoryId);
    const result = await createRecord(recordInput(securityRepositoryId, sessionId, path, "hash"), 422);
    expect(result.body).toMatchObject({ success: false, error: { code: "PATH_OUTSIDE_ROOT" } });
  }

  const nestedSession = await createSession(securityRepositoryId);
  const nested = await createRecord(recordInput(securityRepositoryId, nestedSession, "src/nested/inside.ts", "hash"), 404);
  expect(nested.body).toMatchObject({ success: false, error: { code: "REPOSITORY_NOT_REGISTERED" } });
  expect(outside).not.toContain("secret");
});

test("renders source text as text and never evaluates markup", async ({ page }) => {
  const sessionId = await createSession(xssRepositoryId);
  const payload = "<script>window.__reviewXss = true</script>\n";
  const contentHash = createHash("sha256").update(payload, "utf8").digest("hex");
  const input = recordInput(xssRepositoryId, sessionId, "src/unsafe.ts", contentHash);
  await createRecord(input);

  await page.goto(app.url);
  await page.getByLabel("Owner bearer token").fill(token);
  await page.getByLabel("Repository ID").fill(xssRepositoryId);
  await page.getByRole("button", { name: "Open review timeline" }).click();
  await expect(page.getByText(payload.trim(), { exact: true })).toBeVisible();
  expect(await page.evaluate(() => (window as Window & { __reviewXss?: boolean }).__reviewXss)).toBeUndefined();
  expect(await page.locator("script").count()).toBe(1);
});

test("does not disclose snapshots across decision records", async () => {
  const firstSession = await createSession(securityRepositoryId);
  const secondSession = await createSession(securityRepositoryId);
  const firstContent = "first source\n";
  const secondContent = "second source\n";
  const first = await createRecord(recordInput(securityRepositoryId, firstSession, "src/first.ts", createHash("sha256").update(firstContent).digest("hex")));
  const second = await createRecord(recordInput(securityRepositoryId, secondSession, "src/second.ts", createHash("sha256").update(secondContent).digest("hex")));
  const firstRecordId = ((first.body.data as Record<string, unknown>).record as DecisionRecord).record_id;
  const secondRecordId = ((second.body.data as Record<string, unknown>).record as DecisionRecord).record_id;
  const snapshotResponse = await postJson(`/v1/decision-records/${firstRecordId}/snapshot`, { mode: "changed-files", content: "private first snapshot" });
  expect(snapshotResponse.status).toBe(201);
  const snapshot = (await snapshotResponse.json() as { data: SnapshotReference }).data;

  const crossRecord = await apiRequest(`/v1/decision-records/${secondRecordId}/source?source=snapshot:${snapshot.snapshot_id}`);
  expect(crossRecord.status).toBe(200);
  const body = await crossRecord.json() as { data: Record<string, unknown> };
  expect(body.data).toMatchObject({ state: "source-unavailable" });
  expect(JSON.stringify(body)).not.toContain("private first snapshot");
});

test("rejects UI roots that overlap Recorder owner storage", async () => {
  const overlap = await mkdtemp(join(tmpdir(), "ai-review-overlap-"));
  temporaryDirectories.push(overlap);
  const failure = await runCommand(PROJECT_ROOT, ["bun", "apps/recorder/src/index.ts", "--data-dir", overlap, "--port", "0", "--ui-root", overlap]);
  expect(failure).toContain("uiRoot must not overlap owner storage");
});

test("caps source and patch reads without returning oversized content", async () => {
  const oversizedContent = "y".repeat(4 * 1024 * 1024 + 1);
  await writeFile(join(largeRoot, "src/large.ts"), oversizedContent, "utf8");
  const sessionId = await createSession(largeRepositoryId);
  const result = await createRecord(recordInput(
    largeRepositoryId,
    sessionId,
    "src/large.ts",
    createHash("sha256").update(oversizedContent, "utf8").digest("hex"),
  ));
  const source = ((result.body.data as Record<string, unknown>).sources as Array<Record<string, unknown>>)[0]!;
  expect(source).toMatchObject({ state: "source-unavailable" });
  expect(source.content).toBeUndefined();
  const recordId = ((result.body.data as Record<string, unknown>).record as DecisionRecord).record_id;
  const oversizedPatch = await postJson(`/v1/decision-records/${recordId}/snapshot`, { mode: "patch", content: "d".repeat(1_000_001) });
  expect(oversizedPatch.status).toBe(413);
  expect(await oversizedPatch.json()).toMatchObject({ success: false, error: { code: "PAYLOAD_TOO_LARGE" } });
});

test("never executes revision or path filter text as a command", async () => {
  const marker = join(tmpdir(), `ai-review-command-marker-${randomUUID()}`);
  const sessionId = await createSession(securityRepositoryId);
  const maliciousRevision = { kind: "commit", sha: `$(touch ${marker})` } as const;
  const revisionResult = await createRecord(recordInput(securityRepositoryId, sessionId, "src/secure.ts", "hash", maliciousRevision));
  expect(revisionResult.body).toMatchObject({ success: true });
  expect(((revisionResult.body.data as Record<string, unknown>).sources as Array<Record<string, unknown>>)[0]).toMatchObject({ state: "revision-not-found" });

  const pathSession = await createSession(securityRepositoryId);
  const pathResult = await createRecord(recordInput(securityRepositoryId, pathSession, `$(touch ${marker}).ts`, "hash"));
  expect(pathResult.body).toMatchObject({ success: true });
  expect(((pathResult.body.data as Record<string, unknown>).sources as Array<Record<string, unknown>>)[0]).toMatchObject({ state: "source-unavailable" });
  await expect(readFile(marker, "utf8")).rejects.toMatchObject({ code: "ENOENT" });
});
