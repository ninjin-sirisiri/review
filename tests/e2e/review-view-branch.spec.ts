import { createHash } from "node:crypto";
import { spawn, type ChildProcess } from "node:child_process";
import { mkdir, mkdtemp, readFile, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, test } from "@playwright/test";

const PROJECT_ROOT = process.cwd();
const UI_ROOT = join(PROJECT_ROOT, "apps/review-ui/dist");
const temporaryDirectories: string[] = [];

interface FixtureRepository {
  root: string;
  repositoryId: string;
}

interface RecorderProcess {
  url: string;
  tokenPath: string;
  token: string;
  process: ChildProcess;
}

let app: RecorderProcess;
let token: string;
let fixture: FixtureRepository;

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
  const recorderToken = (await readFile(started.tokenPath, "utf8")).trim();
  return { ...started, token: recorderToken, process: child };
}

async function stopRecorder(recorder: RecorderProcess): Promise<void> {
  recorder.process.kill("SIGTERM");
  await new Promise<void>((resolve) => recorder.process.once("exit", () => resolve()));
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

async function createTwoBranchRepository(): Promise<FixtureRepository> {
  const root = await mkdtemp(join(tmpdir(), "ai-review-e2e-review-view-"));
  temporaryDirectories.push(root);
  await mkdir(join(root, "src"), { recursive: true });
  await writeFile(join(root, "src/main-only.ts"), "export const mainOnly = true;\n", "utf8");
  await runCommand(root, ["git", "init", "-b", "main", "--quiet"]);
  await runCommand(root, ["git", "config", "user.email", "fixture@example.test"]);
  await runCommand(root, ["git", "config", "user.name", "Fixture"]);
  await runCommand(root, ["git", "add", "--", "src/main-only.ts"]);
  await runCommand(root, ["git", "commit", "--quiet", "-m", "main"]);
  await runCommand(root, ["git", "switch", "-c", "feat/x", "--quiet"]);
  await writeFile(join(root, "src/feature-only.ts"), "export const featureOnly = true;\n", "utf8");
  await runCommand(root, ["git", "add", "--", "src/feature-only.ts"]);
  await runCommand(root, ["git", "commit", "--quiet", "-m", "feature"]);
  await runCommand(root, ["git", "switch", "--quiet", "main"]);
  await writeFile(join(root, "src/worktree-only.ts"), "export const worktreeOnly = true;\n", "utf8");
  await runCommand(root, ["git", "add", "--", "src/worktree-only.ts"]);
  const canonicalRoot = await realpath(root);
  return {
    root: canonicalRoot,
    repositoryId: createHash("sha256").update(canonicalRoot, "utf8").digest("hex"),
  };
}

test.beforeAll(async () => {
  const dataDir = await mkdtemp(join(tmpdir(), "ai-review-e2e-review-view-data-"));
  temporaryDirectories.push(dataDir);
  fixture = await createTwoBranchRepository();
  app = await startRecorder(dataDir);
  token = app.token;
  const response = await postJson("/v1/repositories", { root: fixture.root, repository_id: fixture.repositoryId });
  expect(response.status).toBe(201);
});

test.afterAll(async () => {
  if (app !== undefined) await stopRecorder(app);
  await Promise.all(temporaryDirectories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })));
});

test("switches explorer from the working tree to a local branch tip", async ({ page }) => {
  await page.goto(app.url);
  await page.getByLabel("Owner bearer token").fill(token);
  await page.getByRole("button", { name: "Load repositories" }).click();
  await page.getByLabel("Repository").selectOption(fixture.repositoryId);
  await page.getByRole("button", { name: "Open review timeline" }).click();
  await expect(page.getByRole("heading", { name: "Decision review" })).toBeVisible();
  await expect(page.getByRole("button", { name: /worktree-only/ })).toBeVisible();
  await expect(page.getByRole("button", { name: /feature-only/ })).toHaveCount(0);
  await page.getByLabel("Review view").selectOption("feat/x");
  await expect(page.getByRole("button", { name: /feature-only/ })).toBeVisible();
  await expect(page.getByRole("button", { name: /worktree-only/ })).toHaveCount(0);
});
