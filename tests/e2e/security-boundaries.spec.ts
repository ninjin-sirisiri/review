import { createHash, randomUUID } from "node:crypto";
import { spawn, type ChildProcess } from "node:child_process";
import { mkdir, mkdtemp, readFile, realpath, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
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
async function startManagedRecorder(command: string[]): Promise<RecorderProcess> {
  const child = spawn("bun", command, {
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

async function startRecorder(dataDir: string): Promise<RecorderProcess> {
  return startManagedRecorder(["apps/recorder/src/index.ts", "--data-dir", dataDir, "--port", "0", "--ui-root", UI_ROOT]);
}

async function startSnapshotLimitedRecorder(dataDir: string, maxSnapshotBytes: number): Promise<RecorderProcess> {
  const configImport = JSON.stringify(join(PROJECT_ROOT, "apps/recorder/src/config.ts"));
  const serverImport = JSON.stringify(join(PROJECT_ROOT, "apps/recorder/src/http/server.ts"));
  const script = `import { createRecorderConfig } from ${configImport};
import { createRecorderServer } from ${serverImport};
const dataDir = process.argv[2];
const uiRoot = process.argv[3];
const config = createRecorderConfig({ dataDir, port: 0, maxSnapshotBytes: ${maxSnapshotBytes} });
const app = await createRecorderServer({ config, uiRoot });
console.log(\`Recorder listening at \${app.server.url}\`);
console.log(\`Recorder token: \${app.config.tokenPath}\`);
const stop = async () => { await app.stop(); process.exitCode = 0; };
process.once("SIGINT", stop);
process.once("SIGTERM", stop);`;
  const scriptPath = join(dataDir, "start-limited-recorder.ts");
  await writeFile(scriptPath, script, "utf8");
  return startManagedRecorder([scriptPath, dataDir, UI_ROOT]);
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

async function apiRequest(path: string, init: RequestInit = {}, options: { bearer?: string | null; origin?: string | null } = {}): Promise<Response> {
  const headers = new Headers(init.headers);
  if (options.bearer !== null) headers.set("Authorization", `Bearer ${options.bearer ?? token}`);
  if (options.origin !== null && init.method !== undefined && init.method !== "GET" && init.method !== "HEAD") {
    headers.set("Origin", options.origin ?? "http://127.0.0.1");
  }
  return fetch(`${app.url}${path}`, { ...init, headers });
}

async function postJson(path: string, value: unknown, options: { bearer?: string | null; origin?: string | null } = {}): Promise<Response> {
  return apiRequest(path, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(value),
  }, options);
}

function automaticSnapshotBody(sourcePath: string, content: string, beforeMissing = false, captureId = `security-capture-${randomUUID()}`) {
  return {
    capture_id: captureId,
    source_path: sourcePath,
    content,
    before_missing: beforeMissing,
  };
}

async function createCurrentRecord(path = "src/secure.ts", content = "export const secure = true;"): Promise<{ recordId: string; path: string; content: string }> {
  const sessionId = await createSession(securityRepositoryId);
  const fullContent = `${content}\n`;
  const contentHash = createHash("sha256").update(fullContent, "utf8").digest("hex");
  const result = await createRecord(recordInput(securityRepositoryId, sessionId, path, contentHash));
  const record = ((result.body.data as Record<string, unknown>).record as DecisionRecord);
  return { recordId: record.record_id, path, content: fullContent };
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

async function expectLegacyFallback(record: { recordId: string; path: string }): Promise<void> {
  const response = await apiRequest(
    `/v1/decision-records/${record.recordId}/snapshot-diff?path=${encodeURIComponent(record.path)}`,
  );
  expect(response.status).toBe(200);
  expect(await response.json()).toMatchObject({
    success: true,
    data: { state: "legacy-fallback", reason: "automatic-snapshot-not-found", path: record.path },
  });
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

test("requires an owner bearer token for automatic capture and snapshot diff routes", async () => {
  const record = await createCurrentRecord();
  const capturePath = `/v1/decision-records/${record.recordId}/automatic-snapshot`;
  const diffPath = `/v1/decision-records/${record.recordId}/snapshot-diff?path=${encodeURIComponent(record.path)}`;
  const captureId = `unauthorized-capture-${randomUUID()}`;

  for (const bearer of [null, "wrong-token"] as const) {
    const capture = await postJson(capturePath, automaticSnapshotBody(record.path, record.content, false, captureId), { bearer });
    expect(capture.status).toBe(401);
    expect(await capture.json()).toMatchObject({ success: false, error: { code: "UNAUTHORIZED" } });

    const diff = await apiRequest(diffPath, {}, { bearer });
    expect(diff.status).toBe(401);
    expect(await diff.json()).toMatchObject({ success: false, error: { code: "UNAUTHORIZED" } });
  }

  await expectLegacyFallback(record);
});

test("rejects disallowed origins before automatic capture", async () => {
  const record = await createCurrentRecord();
  const captureId = `origin-capture-${randomUUID()}`;
  const response = await postJson(
    `/v1/decision-records/${record.recordId}/automatic-snapshot`,
    automaticSnapshotBody(record.path, record.content, false, captureId),
    { origin: "https://evil.example" },
  );
  expect(response.status).toBe(403);
  const body = await response.json() as Record<string, unknown>;
  expect(body).toMatchObject({ success: false, error: { code: "UNAUTHORIZED" } });
  expect(JSON.stringify(body)).not.toContain(record.content);
  await expectLegacyFallback(record);
});

test("rejects unknown records and non-target or traversal paths on automatic routes", async () => {
  const record = await createCurrentRecord();
  const unknownCapture = await postJson(
    `/v1/decision-records/unknown-automatic-${randomUUID()}/automatic-snapshot`,
    automaticSnapshotBody(record.path, record.content),
  );
  expect(unknownCapture.status).toBe(404);
  expect(await unknownCapture.json()).toMatchObject({ success: false, error: { code: "INVALID_RECORD" } });

  const unknownDiff = await apiRequest(
    `/v1/decision-records/unknown-diff-${randomUUID()}/snapshot-diff?path=${encodeURIComponent(record.path)}`,
  );
  expect(unknownDiff.status).toBe(404);
  expect(await unknownDiff.json()).toMatchObject({ success: false, error: { code: "INVALID_RECORD" } });

  const nonTargetContent = "non-target source must not be captured\n";
  const nonTargetCaptureId = `non-target-capture-${randomUUID()}`;
  const nonTargetCapture = await postJson(
    `/v1/decision-records/${record.recordId}/automatic-snapshot`,
    automaticSnapshotBody("src/first.ts", nonTargetContent, false, nonTargetCaptureId),
  );
  expect(nonTargetCapture.status).toBe(422);
  const nonTargetCaptureBody = await nonTargetCapture.json() as Record<string, unknown>;
  expect(nonTargetCaptureBody).toMatchObject({ success: false, error: { code: "INVALID_RECORD", field: "source_path" } });
  expect(JSON.stringify(nonTargetCaptureBody)).not.toContain(nonTargetContent);
  await expectLegacyFallback(record);

  const nonTargetDiff = await apiRequest(
    `/v1/decision-records/${record.recordId}/snapshot-diff?path=${encodeURIComponent("src/first.ts")}`,
  );
  expect(nonTargetDiff.status).toBe(200);
  const nonTargetDiffBody = await nonTargetDiff.json() as Record<string, unknown>;
  expect(nonTargetDiffBody).toMatchObject({ success: true, data: { state: "source-unavailable", path: "src/first.ts" } });
  expect(JSON.stringify(nonTargetDiffBody)).not.toContain(nonTargetContent);

  const traversalContent = "traversal source must not be captured\n";
  const traversalCaptureId = `traversal-capture-${randomUUID()}`;
  const traversalCapture = await postJson(
    `/v1/decision-records/${record.recordId}/automatic-snapshot`,
    automaticSnapshotBody("../outside.ts", traversalContent, false, traversalCaptureId),
  );
  expect(traversalCapture.status).toBe(422);
  const traversalCaptureBody = await traversalCapture.json() as Record<string, unknown>;
  expect(traversalCaptureBody).toMatchObject({ success: false, error: { code: "PATH_OUTSIDE_ROOT" } });
  expect(JSON.stringify(traversalCaptureBody)).not.toContain(traversalContent);
  await expectLegacyFallback(record);

  const traversalDiff = await apiRequest(
    `/v1/decision-records/${record.recordId}/snapshot-diff?path=${encodeURIComponent("../outside.ts")}`,
  );
  expect(traversalDiff.status).toBe(422);
  const traversalDiffBody = await traversalDiff.json() as Record<string, unknown>;
  expect(traversalDiffBody).toMatchObject({ success: false, error: { code: "PATH_OUTSIDE_ROOT" } });
  expect(JSON.stringify(traversalDiffBody)).not.toContain(traversalContent);
});

test("rejects automatic capture content that conflicts with the current target hash", async () => {
  const record = await createCurrentRecord();
  const submittedContent = "forged current content\n";
  const captureId = `hash-conflict-capture-${randomUUID()}`;
  const response = await postJson(
    `/v1/decision-records/${record.recordId}/automatic-snapshot`,
    automaticSnapshotBody(record.path, submittedContent, false, captureId),
  );
  expect(response.status).toBe(422);
  const body = await response.json() as Record<string, unknown>;
  expect(body).toMatchObject({ success: false, error: { code: "HASH_MISMATCH" } });
  expect(JSON.stringify(body)).not.toContain(submittedContent);
  await expectLegacyFallback(record);
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
  const rootOutside = await createRecord(recordInput(securityRepositoryId, "unused", "../outside.ts", "hash"), 422);
  expect(rootOutside.response.status).toBe(422);
  expect(rootOutside.body).toMatchObject({ success: false, error: { code: "PATH_OUTSIDE_ROOT" } });
  expect(JSON.stringify(rootOutside.body)).not.toContain("outside secret");

  for (const path of ["src/direct-link.ts", "src/parent-link/secret.ts"]) {
    const sessionId = await createSession(securityRepositoryId);
    const result = await createRecord(recordInput(securityRepositoryId, sessionId, path, "hash"), 422);
    expect(result.response.status).toBe(422);
    expect(result.body).toMatchObject({ success: false, error: { code: "PATH_OUTSIDE_ROOT" } });
    expect(JSON.stringify(result.body)).not.toContain("outside secret");
  }

  const nestedSession = await createSession(securityRepositoryId);
  const nested = await createRecord(recordInput(securityRepositoryId, nestedSession, "src/nested/inside.ts", "hash"), 404);
  expect(nested.response.status).toBe(404);
  expect(nested.body).toMatchObject({ success: false, error: { code: "REPOSITORY_NOT_REGISTERED" } });
  expect(JSON.stringify(nested.body)).not.toContain("outside secret");
});

test("renders source text as text and never evaluates markup", async ({ page }) => {
  const sessionId = await createSession(xssRepositoryId);
  const payload = "<script>window.__reviewXss = true</script>\n";
  const contentHash = createHash("sha256").update(payload, "utf8").digest("hex");
  const input = recordInput(xssRepositoryId, sessionId, "src/unsafe.ts", contentHash);
  await createRecord(input);

  await page.goto(app.url);
  await page.getByLabel("Owner bearer token").fill(token);
  // BootstrapScreenは2段階送信:最初の送信でリポジトリ一覧をロードしてからRepositoryセレクトが現れる
  await page.getByRole("button", { name: "Load repositories" }).click();
  await page.getByLabel("Repository").selectOption(xssRepositoryId);
  await page.getByRole("button", { name: "Open review timeline" }).click();
  // ソース本文はdiffペインがファイルを開いてから表示する(§6.2.6)
  await page.getByRole("button", { name: /unsafe\.ts/ }).click();
  await expect(page.getByText(payload.trim(), { exact: true })).toBeVisible();
  expect(await page.evaluate(() => (window as Window & { __reviewXss?: boolean }).__reviewXss)).toBeUndefined();
  // ファーストパーティスクリプトのみ(Viteエントリ+テーマ初期化)。ルート相対パス以外の
  // 外部srcを持つスクリプトの注入は禁止で、ソース本文も実行されない(直前の__reviewXss検査と併用)
  expect(await page.locator("script").count()).toBe(2);
  const sources = await page.locator("script[src]").evaluateAll((nodes) =>
    nodes.map((node) => node.getAttribute("src") ?? ""),
  );
  for (const source of sources) {
    expect(/^\/[^/]/.test(source), `unexpected script src: ${source}`).toBe(true);
  }
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
  const limitedDataDir = await mkdtemp(join(tmpdir(), "ai-review-snapshot-cap-data-"));
  temporaryDirectories.push(limitedDataDir);
  const originalApp = app;
  const originalToken = token;
  const limitedApp = await startSnapshotLimitedRecorder(limitedDataDir, 64);
  app = limitedApp;
  token = limitedApp.token;
  try {
    const registration = await postJson("/v1/repositories", { root: securityRoot, repository_id: securityRepositoryId });
    expect(registration.status).toBe(201);
    const snapshotSession = await createSession(securityRepositoryId);
    const snapshotRecord = await createRecord(recordInput(
      securityRepositoryId,
      snapshotSession,
      "src/secure.ts",
      createHash("sha256").update("export const secure = true;\n", "utf8").digest("hex"),
    ));
    const snapshotRecordId = ((snapshotRecord.body.data as Record<string, unknown>).record as DecisionRecord).record_id;
    const patchContent = "d".repeat(65);
    expect(new TextEncoder().encode(JSON.stringify({ mode: "patch", content: patchContent })).byteLength).toBeLessThan(1_000_000);
    const oversizedPatch = await postJson(`/v1/decision-records/${snapshotRecordId}/snapshot`, { mode: "patch", content: patchContent });
    expect(oversizedPatch.status).toBe(413);
    expect(await oversizedPatch.json()).toMatchObject({ success: false, error: { code: "PAYLOAD_TOO_LARGE" } });

    const oversizedAutomaticContent = "a".repeat(65);
    const oversizedAutomaticCaptureId = `oversized-content-${randomUUID()}`;
    const oversizedAutomatic = await postJson(
      `/v1/decision-records/${snapshotRecordId}/automatic-snapshot`,
      automaticSnapshotBody("src/secure.ts", oversizedAutomaticContent, false, oversizedAutomaticCaptureId),
    );
    expect(oversizedAutomatic.status).toBe(413);
    const oversizedAutomaticResponse = await oversizedAutomatic.json() as Record<string, unknown>;
    expect(oversizedAutomaticResponse).toMatchObject({ success: false, error: { code: "PAYLOAD_TOO_LARGE" } });
    expect(JSON.stringify(oversizedAutomaticResponse)).not.toContain(oversizedAutomaticContent);
    await expectLegacyFallback({ recordId: snapshotRecordId, path: "src/secure.ts" });

    const encoder = new TextEncoder();
    const oversizedAutomaticBody = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(encoder.encode('{"capture_id":"oversized-body","source_path":"src/secure.ts","content":"'));
        controller.enqueue(encoder.encode("b".repeat(1_000_100)));
        controller.enqueue(encoder.encode('","before_missing":false}'));
        controller.close();
      },
    });
    const oversizedAutomaticRequest = await apiRequest(
      `/v1/decision-records/${snapshotRecordId}/automatic-snapshot`,
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: oversizedAutomaticBody,
        duplex: "half",
      } as RequestInit & { duplex: "half" },
    );
    expect(oversizedAutomaticRequest.status).toBe(413);
    const oversizedAutomaticRequestBody = await oversizedAutomaticRequest.json() as Record<string, unknown>;
    expect(oversizedAutomaticRequestBody).toMatchObject({ success: false, error: { code: "PAYLOAD_TOO_LARGE" } });
    expect(JSON.stringify(oversizedAutomaticRequestBody)).not.toContain("b".repeat(128));
    await expectLegacyFallback({ recordId: snapshotRecordId, path: "src/secure.ts" });
  } finally {
    app = originalApp;
    token = originalToken;
    await stopRecorder(limitedApp);
  }
});

test("does not fall back to the worktree when the next automatic snapshot is corrupted", async () => {
  const beforeContent = "export const corrupted = \"before\";\n";
  const nextContent = "export const corrupted = \"next\";\n";
  const fallbackContent = "export const corrupted = \"fallback\";\n";
  const fixture = await createGitRepository("automatic-corrupted-next", "src/corrupted.ts", beforeContent);
  const registration = await postJson("/v1/repositories", { root: fixture.root, repository_id: fixture.repositoryId });
  expect(registration.status).toBe(201);

  const firstSession = await createSession(fixture.repositoryId);
  const first = await createRecord(recordInput(
    fixture.repositoryId,
    firstSession,
    fixture.path,
    createHash("sha256").update(beforeContent, "utf8").digest("hex"),
  ));
  const firstRecordId = ((first.body.data as Record<string, unknown>).record as DecisionRecord).record_id;
  const beforeCapture = await postJson(
    `/v1/decision-records/${firstRecordId}/automatic-snapshot`,
    automaticSnapshotBody(fixture.path, beforeContent),
  );
  expect(beforeCapture.status).toBe(201);

  await writeFile(join(fixture.root, fixture.path), nextContent, "utf8");
  const secondSession = await createSession(fixture.repositoryId);
  const second = await createRecord(recordInput(
    fixture.repositoryId,
    secondSession,
    fixture.path,
    createHash("sha256").update(nextContent, "utf8").digest("hex"),
  ));
  const secondRecordId = ((second.body.data as Record<string, unknown>).record as DecisionRecord).record_id;
  const nextCapture = await postJson(
    `/v1/decision-records/${secondRecordId}/automatic-snapshot`,
    automaticSnapshotBody(fixture.path, nextContent),
  );
  expect(nextCapture.status).toBe(201);
  const nextReference = (await nextCapture.json() as { data: SnapshotReference }).data;
  expect(nextReference).toMatchObject({ mode: "changed-files", capture_kind: "automatic", source_path: fixture.path });

  await writeFile(join(dirname(app.tokenPath), nextReference.path), "corrupted snapshot content\n", "utf8");
  await writeFile(join(fixture.root, fixture.path), fallbackContent, "utf8");

  const response = await apiRequest(
    `/v1/decision-records/${firstRecordId}/snapshot-diff?path=${encodeURIComponent(fixture.path)}`,
  );
  expect(response.status).toBe(200);
  const body = await response.json() as Record<string, unknown>;
  expect(body).toMatchObject({ success: true, data: { path: fixture.path } });
  expect((body.data as Record<string, unknown>).state).toBe("source-unavailable");
  const serialized = JSON.stringify(body);
  expect(serialized).not.toContain(nextContent);
  expect(serialized).not.toContain(fallbackContent);
  expect(serialized).not.toContain("corrupted snapshot content");
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
