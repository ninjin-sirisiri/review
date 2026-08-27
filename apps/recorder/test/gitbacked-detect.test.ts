import { createHash } from "node:crypto";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import type { DecisionRecordInput, TargetReference } from "../../../packages/contracts/src/index";
import { RepositoryRegistry } from "../src/repositories/registry";
import { GitReader } from "../src/source/git";
import { detectGitBackable } from "../src/source/gitbacked";
import { RecordStore } from "../src/store/records";

const temporaryDirectories: string[] = [];

async function runGit(root: string, args: string[]): Promise<string> {
  const process = Bun.spawn({ cmd: ["git", ...args], cwd: root, stdout: "pipe", stderr: "pipe" });
  const [stdout, stderr] = await Promise.all([new Response(process.stdout).text(), new Response(process.stderr).text()]);
  if ((await process.exited) !== 0) throw new Error(`git ${args.join(" ")} failed: ${stderr}`);
  return stdout.trim();
}

function hash(content: string): string {
  return createHash("sha256").update(content, "utf8").digest("hex");
}

interface Fixture { root: string; path: string; commitSha: string; committed: string; working: string }

async function createFixture(): Promise<Fixture> {
  const root = await mkdtemp(join(tmpdir(), "ai-review-gitbacked-"));
  temporaryDirectories.push(root);
  await runGit(root, ["init", "--quiet"]);
  await runGit(root, ["config", "user.email", "fixture@example.test"]);
  await runGit(root, ["config", "user.name", "Fixture"]);
  const path = "src/example.ts";
  const committed = "export const version = 1;\n";
  const working = "export const version = 2;\n";
  await mkdir(join(root, "src"), { recursive: true });
  await writeFile(join(root, path), committed, "utf8");
  await runGit(root, ["add", "--", path]);
  await runGit(root, ["commit", "--quiet", "-m", "fixture"]);
  const commitSha = await runGit(root, ["rev-parse", "HEAD"]);
  await writeFile(join(root, path), working, "utf8");
  return { root, path, commitSha, committed, working };
}

async function registeredRecord(fixture: Fixture, repositoryId: string, registry: RepositoryRegistry): Promise<DecisionRecordInput> {
  const target: TargetReference = {
    repository_id: repositoryId,
    path: fixture.path,
    line_start: 1,
    line_end: 1,
    revision: { kind: "working-tree", contentHash: hash(fixture.working) },
    content_hash: hash(fixture.working),
  };
  void registry;
  return {
    record_id: "detect-record",
    session_id: "detect-session",
    repository_id: repositoryId,
    agent_type: "codex",
    revision: target.revision,
    targets: [target],
    judgment: "Safe",
    rationale: "Fixture",
    checks: [],
    open_questions: [],
    created_at: "2026-08-26T00:00:00Z",
  };
}

afterEach(async () => {
  await Promise.all(temporaryDirectories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })));
});

describe("detectGitBackable", () => {
  test("matches submitted content against the HEAD blob of a target path", async () => {
    const fixture = await createFixture();
    const store = new RecordStore(new Database(":memory:"));
    const registry = new RepositoryRegistry(store);
    const registered = await registry.register(fixture.root);
    const record = await registeredRecord(fixture, registered.repository_id, registry);
    record.targets = [{ ...record.targets[0]!, path: "src/missing.ts" }, record.targets[0]!];
    // Roll the worktree forward: detection must compare against HEAD, not the worktree.
    await writeFile(join(fixture.root, fixture.path), fixture.working, "utf8");

    const hit = await detectGitBackable(registry, new GitReader(10_000), record as never, hash(fixture.committed));
    expect(hit).toEqual({ baseSha: fixture.commitSha, sourcePath: fixture.path });

    const miss = await detectGitBackable(registry, new GitReader(10_000), record as never, hash("never committed\n"));
    expect(miss).toBeNull();
  });

  test("returns null for unregistered repositories and unborn HEADs", async () => {
    const fixture = await createFixture();
    const store = new RecordStore(new Database(":memory:"));
    const registry = new RepositoryRegistry(store);
    const record = await registeredRecord(fixture, "unknown-repository", registry);
    expect(await detectGitBackable(registry, new GitReader(10_000), record as never, hash(fixture.committed))).toBeNull();

    const emptyRoot = await mkdtemp(join(tmpdir(), "ai-review-gitbacked-empty-"));
    temporaryDirectories.push(emptyRoot);
    await runGit(emptyRoot, ["init", "--quiet"]);
    await runGit(emptyRoot, ["config", "user.email", "fixture@example.test"]);
    await runGit(emptyRoot, ["config", "user.name", "Fixture"]);
    const unbornRegistered = await registry.register(emptyRoot);
    const unbornRecord = await registeredRecord({ ...fixture, path: "src/example.ts" }, unbornRegistered.repository_id, registry);
    expect(await detectGitBackable(registry, new GitReader(10_000), unbornRecord as never, hash(fixture.committed))).toBeNull();
  });
});
