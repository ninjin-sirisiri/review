import { createHash, randomUUID } from "node:crypto";
import { spawn, type ChildProcess } from "node:child_process";
import { mkdir, mkdtemp, readFile, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, test } from "@playwright/test";
import type { DecisionRecord, DecisionRecordInput, ReviewSession } from "../../packages/contracts/src/index";

const PROJECT_ROOT = process.cwd();
const UI_ROOT = join(PROJECT_ROOT, "apps/review-ui/dist");
const temporaryDirectories: string[] = [];

interface FixtureRepository {
  root: string;
  repositoryId: string;
  path: string;
  content: string;
  contentHash: string;
  commitSha: string;
}

interface RecorderProcess {
  url: string;
  tokenPath: string;
  token: string;
  process: ChildProcess;
}

let app: RecorderProcess;
let token: string;
let journey: FixtureRepository;
let adapters: FixtureRepository;

async function runCommand(cwd: string, cmd: string[], env?: Record<string, string>): Promise<string> {
  const child = spawn(cmd[0]!, cmd.slice(1), {
    cwd,
    env: { ...process.env, ...env },
    stdio: ["ignore", "pipe", "pipe"],
  });
  let stdout = "";
  let stderr = "";
  child.stdout.on("data", (chunk: Buffer) => { stdout += chunk.toString(); });
  child.stderr.on("data", (chunk: Buffer) => { stderr += chunk.toString(); });
  const exitCode = await new Promise<number>((resolve, reject) => {
    child.once("error", reject);
    child.once("exit", (code) => resolve(code ?? 1));
  });
  if (exitCode !== 0) throw new Error(`${cmd.join(" ")} failed (${exitCode}): ${stderr}`);
  return stdout.trim();
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
  const token = (await readFile(started.tokenPath, "utf8")).trim();
  return { ...started, token, process: child };
}

async function stopRecorder(recorder: RecorderProcess): Promise<void> {
  recorder.process.kill("SIGTERM");
  await new Promise<void>((resolve) => recorder.process.once("exit", () => resolve()));
}

async function createGitRepository(name: string, path: string, content: string): Promise<FixtureRepository> {
  const root = await mkdtemp(join(tmpdir(), `ai-review-e2e-${name}-`));
  temporaryDirectories.push(root);
  await mkdir(join(root, path, ".."), { recursive: true });
  await writeFile(join(root, path), content, "utf8");
  await runCommand(root, ["git", "init", "--quiet"]);
  await runCommand(root, ["git", "config", "user.email", "fixture@example.test"]);
  await runCommand(root, ["git", "config", "user.name", "Fixture"]);
  await runCommand(root, ["git", "add", "--", path]);
  await runCommand(root, ["git", "commit", "--quiet", "-m", "fixture"]);
  const canonicalRoot = await realpath(root);
  return {
    root: canonicalRoot,
    repositoryId: createHash("sha256").update(canonicalRoot, "utf8").digest("hex"),
    path,
    content,
    contentHash: createHash("sha256").update(content, "utf8").digest("hex"),
    commitSha: await runCommand(root, ["git", "rev-parse", "HEAD"]),
  };
}

async function apiRequest(path: string, init: RequestInit = {}): Promise<Response> {
  const headers = new Headers(init.headers);
  headers.set("Authorization", `Bearer ${token}`);
  if (init.method !== undefined && init.method !== "GET" && init.method !== "HEAD") headers.set("Origin", "http://127.0.0.1");
  return fetch(`${app.url}${path}`, { ...init, headers });
}

async function postJson(path: string, value: unknown): Promise<Response> {
  return apiRequest(path, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(value),
  });
}

async function createSession(repository: FixtureRepository, agentType: "codex" | "claude-code"): Promise<ReviewSession> {
  const session = {
    session_id: `session-${randomUUID()}`,
    repository_id: repository.repositoryId,
    agent_type: agentType,
    started_at: new Date().toISOString(),
    status: "active",
  } satisfies ReviewSession;
  const response = await postJson("/v1/sessions", session);
  expect(response.status).toBe(201);
  return (await response.json() as { success: true; data: ReviewSession }).data;
}

function eventFor(repository: FixtureRepository, sessionId: string, agentType: "codex" | "claude-code", recordId = `record-${randomUUID()}`) {
  return {
    sessionId: sessionId,
    repositoryRoot: repository.root,
    revision: { kind: "working-tree", contentHash: repository.contentHash },
    targets: [{
      path: repository.path,
      lineStart: 1,
      lineEnd: 1,
      revision: { kind: "working-tree", contentHash: repository.contentHash },
      contentHash: repository.contentHash,
    }],
    judgment: `${agentType} fixture judgment ${recordId}`,
    rationale: "The bounded local source is linked to this decision.",
    checks: [{ name: "focused tests", status: "passed", details: "e2e" }],
    openQuestions: [],
    recordId,
    createdAt: new Date().toISOString(),
  };
}

async function runAdapter(agentType: "codex" | "claude-code", event: unknown, endpoint = app.url): Promise<{ result: Record<string, unknown>; exitCode: number; stderr: string }> {
  const child = spawn("bun", [`plugins/${agentType}/src/index.ts`], {
    cwd: PROJECT_ROOT,
    env: {
      ...process.env,
      RECORDER_URL: `${endpoint}/v1/decision-records`,
      RECORDER_TOKEN_PATH: app.tokenPath,
      RECORDER_RETRY_BASE_DELAY_MS: "1",
    },
    stdio: ["pipe", "pipe", "pipe"],
  });
  let stdout = "";
  let stderr = "";
  child.stdout.on("data", (chunk: Buffer) => { stdout += chunk.toString(); });
  child.stderr.on("data", (chunk: Buffer) => { stderr += chunk.toString(); });
  child.stdin.write(`${JSON.stringify(event)}\n`);
  child.stdin.end();
  const exitCode = await new Promise<number>((resolve, reject) => {
    child.once("error", reject);
    child.once("exit", (code) => resolve(code ?? 1));
  });
  const line = stdout.trim().split("\n").at(-1) ?? "";
  return { result: JSON.parse(line) as Record<string, unknown>, exitCode, stderr };
}

test.beforeAll(async () => {
  const dataDir = await mkdtemp(join(tmpdir(), "ai-review-e2e-data-"));
  temporaryDirectories.push(dataDir);
  journey = await createGitRepository("journey", "src/review.ts", "export const reviewed = true;\n");
  adapters = await createGitRepository("adapters", "src/adapter.ts", "export const adapter = true;\n");
  app = await startRecorder(dataDir);
  token = app.token;
  for (const repository of [journey, adapters]) {
    const response = await postJson("/v1/repositories", { root: repository.root, repository_id: repository.repositoryId });
    expect(response.status).toBe(201);
  }
});

test.afterAll(async () => {
  if (app !== undefined) await stopRecorder(app);
  await Promise.all(temporaryDirectories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })));
});


test("reviews a decision through the explorer, accepts it, and flags a tampered source", async ({ page }) => {
  const session = await createSession(journey, "codex");
  const event = eventFor(journey, session.session_id, "codex", `journey-${randomUUID()}`);
  const submission = await runAdapter("codex", event);
  expect(submission.exitCode).toBe(0);
  expect(submission.result).toMatchObject({ success: true, recordId: event.recordId });

  await page.goto(app.url);
  await expect(page).toHaveTitle("Review decisions");
  await page.getByLabel("Owner bearer token").fill(token);
  // BootstrapScreenは2段階送信:最初の送信でリポジトリ一覧をロードしてからRepositoryセレクトが現れる
  await page.getByRole("button", { name: "Load repositories" }).click();
  await page.getByLabel("Repository").selectOption(journey.repositoryId);
  await page.getByRole("button", { name: "Open review timeline" }).click();
  await expect(page.getByRole("heading", { name: "Decision review" })).toBeVisible();

  await page.getByRole("button", { name: /review\.ts/ }).click();
  await expect(page.getByRole("heading", { name: event.judgment })).toBeVisible();
  // 作業ツリー未変更 → hunks空 + 検証済みsource → 全文モード(§6.2.6)で記録済みソースを表示
  await expect(page.getByText("export const reviewed = true;", { exact: true })).toBeVisible();

  const accept = page.getByRole("button", { name: "Accept", exact: true });
  await accept.click();
  await expect(accept).toHaveAttribute("aria-pressed", "true");
  const acceptedResponse = await apiRequest(`/v1/decision-records/${event.recordId}`);
  expect(acceptedResponse.status).toBe(200);
  const acceptedBody = await acceptedResponse.json() as { data: { record: DecisionRecord } };
  expect(acceptedBody.data.record.user_disposition).toBe("accepted");

  // 改ざん: 作業ツリーだけ書き換える
  const currentSource = "export const reviewed = false;";
  await writeFile(join(journey.root, journey.path), `${currentSource}\n`, "utf8");
  await page.reload();
  const staleResponse = await apiRequest(`/v1/decision-records/${event.recordId}`);
  expect(staleResponse.status).toBe(200);
  const staleBody = await staleResponse.json() as { data: { sources: Array<Record<string, unknown>> } };
  expect(staleBody.data.sources[0]).toMatchObject({ state: "hash-mismatch" });

  // トークンはメモリ保持なので再認証になる。不変条件は「トークン非出力」:ストレージ/URLに現れないこと
  await expect(page.getByLabel("Owner bearer token")).toBeVisible();
  await expect(page).not.toHaveURL(new RegExp(token));
  // トークンは一切ストレージに現れないこと(キーと値の両方を検査。UI設定などの無害なキーは許容)
  await expect(page.evaluate(() =>
    [...Object.keys(localStorage), ...Object.values(localStorage)].some((value) => String(value).includes(token)),
  )).resolves.toBe(false);

  await page.getByLabel("Owner bearer token").fill(token);
  await page.getByRole("button", { name: "Load repositories" }).click();
  await page.getByLabel("Repository").selectOption(journey.repositoryId);
  await page.getByRole("button", { name: "Open review timeline" }).click();
  await page.getByRole("button", { name: /review\.ts/ }).click();

  await expect(page.getByRole("heading", { name: event.judgment })).toBeVisible();
  await expect(page.getByText("Source changed since the decision")).toBeVisible();
  await expect(page.getByText("Current code is intentionally not shown until this reference is resolved.")).toBeVisible();
  // カード上に改ざん後コードは出ない(§7)。diffペインはHEADとの差分として現状を表示するが、
  // hash不一致のアンカーは検証済み扱いしないためティントは付かない(§5/§8)
  await expect(page.locator(".judgment-panel").getByText(currentSource)).toHaveCount(0);
  await expect(page.locator(".diff-line--anchored")).toHaveCount(0);
});

// 注意: ブロック絞り込みテストは末尾の2つのadapterテストより後に実行する。
// 共有adaptersリポジトリに判断を1件追加するため、record数を数えるテストより前に置けない。

test("submits both adapter fixtures through the common JSONL bridge", async () => {
  for (const agentType of ["codex", "claude-code"] as const) {
    const session = await createSession(adapters, agentType);
    const submission = await runAdapter(agentType, eventFor(adapters, session.session_id, agentType));
    expect(submission.exitCode, submission.stderr).toBe(0);
    expect(submission.result).toMatchObject({ success: true });
  }
  const records = await apiRequest(`/v1/decision-records?repository_id=${adapters.repositoryId}`);
  expect(records.status).toBe(200);
  expect((await records.json() as { data: DecisionRecordInput[] }).data).toHaveLength(2);
});

test("keeps a failed Recorder submission non-blocking for the host adapter", async () => {
  const session = await createSession(adapters, "codex");
  const submission = await runAdapter("codex", eventFor(adapters, session.session_id, "codex"), "http://127.0.0.1:9");
  expect(submission.exitCode).toBe(0);
  expect(submission.result).toMatchObject({ success: false, code: "RECORDER_UNAVAILABLE" });
});

test("narrows judgments to the selected diff block and restores them on clear", async ({ page }) => {
  const session = await createSession(adapters, "claude-code");
  const recordId = `block-${randomUUID()}`;
  const event = eventFor(adapters, session.session_id, "claude-code", recordId);
  event.revision = { kind: "commit", sha: adapters.commitSha };
  event.targets[0]!.revision = { kind: "commit", sha: adapters.commitSha };
  event.targets[0]!.contentHash = adapters.contentHash;
  const submission = await runAdapter("claude-code", event);
  expect(submission.exitCode).toBe(0);

  // 1行目を書き換えて1行追加し、実diffを作る
  await writeFile(join(adapters.root, adapters.path), "export const adapter = false;\nexport const extra = 1;\n", "utf8");

  await page.goto(app.url);
  await page.getByLabel("Owner bearer token").fill(token);
  await page.getByRole("button", { name: "Load repositories" }).click();
  await page.getByLabel("Repository").selectOption(adapters.repositoryId);
  await page.getByRole("button", { name: "Open review timeline" }).click();
  await page.getByRole("button", { name: /adapter\.ts/ }).click();

  // commit revision の判断は旧側1..1に常時アンカー(§5)
  await expect(page.getByRole("heading", { name: event.judgment })).toBeVisible();
  await expect(page.locator('[data-old-line="1"]')).toHaveClass(/diff-line--anchored/);

  // 純addブロック(new側のみ)をクリック → 旧側アンカーは辺ごと厳密判定で合致しない(§6.2.3)
  await page.locator(".diff-line--add").last().click();
  await expect(page.getByText("No judgments overlap the selected lines.")).toBeVisible();

  await page.getByRole("button", { name: "Clear block filter" }).click();
  await expect(page.getByRole("heading", { name: event.judgment })).toBeVisible();
});

test("switches the color scheme, persists it, and boots without flashing", async ({ page }) => {
  await page.goto(app.url);
  await expect(page.locator("html")).toHaveAttribute("data-theme", /light|dark/);

  await page.emulateMedia({ colorScheme: "light" });
  await page.reload();
  await expect(page.locator("html")).toHaveAttribute("data-theme", "light");
  await expect(page.evaluate(() => localStorage.getItem("review-ui-theme"))).resolves.toBeNull();

  const toggle = page.getByRole("button", { name: /Color scheme/ });
  await toggle.click();
  await expect(page.locator("html")).toHaveAttribute("data-theme", "light");
  await expect(page.evaluate(() => localStorage.getItem("review-ui-theme"))).resolves.toBe("light");

  await toggle.click();
  await expect(page.locator("html")).toHaveAttribute("data-theme", "dark");
  await page.reload();
  await expect(page.locator("html")).toHaveAttribute("data-theme", "dark");
});
