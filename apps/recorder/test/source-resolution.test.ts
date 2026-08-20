import { createHash } from "node:crypto";
import { mkdir, mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import type { DecisionRecordInput, TargetReference } from "../../../packages/contracts/src/index";
import { createRecorderConfig } from "../src/config";
import { RepositoryRegistry } from "../src/repositories/registry";
import { GitReader } from "../src/source/git";
import { SourceResolver } from "../src/source/resolve";
import { WorkingTreeReader } from "../src/source/worktree";
import { RecordStore } from "../src/store/records";
import { SnapshotStore } from "../src/store/snapshots";

const temporaryDirectories: string[] = [];

type Fixture = { root: string; path: string; commitSha: string; committed: string; working: string };

async function runGit(root: string, args: string[]): Promise<string> {
  const process = Bun.spawn({ cmd: ["git", ...args], cwd: root, stdout: "pipe", stderr: "pipe" });
  const [stdout, stderr, exitCode] = await Promise.all([
    new Response(process.stdout).text(),
    new Response(process.stderr).text(),
    process.exited,
  ]);
  if (exitCode !== 0) throw new Error(`git ${args.join(" ")} failed: ${stderr}`);
  return stdout.trim();
}

function hash(content: string): string {
  return createHash("sha256").update(content, "utf8").digest("hex");
}

async function createFixture(): Promise<Fixture> {
  const root = await mkdtemp(join(tmpdir(), "ai-review-source-"));
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

function target(fixture: Fixture, revision: TargetReference["revision"], content: string): TargetReference {
  return {
    repository_id: "fixture-repository",
    path: fixture.path,
    line_start: 1,
    line_end: 1,
    revision,
    content_hash: hash(content),
  };
}

async function createResolverFixture(): Promise<{
  fixture: Fixture;
  store: RecordStore;
  registry: RepositoryRegistry;
  snapshots: SnapshotStore;
  resolver: SourceResolver;
  repositoryId: string;
}> {
  const fixture = await createFixture();
  const dataDir = await mkdtemp(join(tmpdir(), "ai-review-source-data-"));
  temporaryDirectories.push(dataDir);
  const store = new RecordStore(new Database(":memory:"));
  const registry = new RepositoryRegistry(store);
  const registered = await registry.register(fixture.root);
  const snapshots = new SnapshotStore(store.db, createRecorderConfig({ dataDir, maxSnapshotContentLength: 1_000 }));
  const fixtureTarget = target(fixture, { kind: "working-tree", contentHash: hash(fixture.working) }, fixture.working);
  fixtureTarget.repository_id = registered.repository_id;
  const decision: DecisionRecordInput = {
    record_id: "source-resolution-record",
    session_id: "source-resolution-session",
    repository_id: registered.repository_id,
    agent_type: "codex",
    revision: { kind: "working-tree", contentHash: hash(fixture.working) },
    targets: [fixtureTarget],
    judgment: "Safe",
    rationale: "Fixture",
    checks: [],
    open_questions: [],
    created_at: "2026-08-20T12:00:00Z",
  };
  await store.createSession({
    session_id: decision.session_id,
    repository_id: registered.repository_id,
    agent_type: decision.agent_type,
    started_at: "2026-08-20T12:00:00Z",
    status: "active",
  });
  await store.insertDecision(decision);
  const resolver = new SourceResolver(registry, snapshots);
  return { fixture, store, registry, snapshots, resolver, repositoryId: registered.repository_id };
}

afterEach(async () => {
  await Promise.all(temporaryDirectories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })));
});

describe("source resolution", () => {
  test("reads the selected commit and never executes revision text as a command", async () => {
    const context = await createResolverFixture();
    const commitTarget = target(context.fixture, { kind: "commit", sha: context.fixture.commitSha }, context.fixture.committed);
    commitTarget.repository_id = context.repositoryId;

    const resolved = await context.resolver.resolve(commitTarget, "repository");

    expect(resolved.state).toBe("resolved");
    expect(resolved.content).toBe(context.fixture.committed);
    expect(resolved.contentHash).toBe(hash(context.fixture.committed));

    const marker = join(tmpdir(), `ai-review-source-command-${crypto.randomUUID()}`);
    const malicious = { ...commitTarget, revision: { kind: "commit", sha: `$(touch ${marker})` } as const };
    const unavailable = await context.resolver.resolve(malicious, "repository");
    expect(unavailable.state).toBe("revision-not-found");
    expect(await readFile(marker, "utf8").catch(() => null)).toBeNull();
    context.store.close();
  });

  test("resolves the current working tree only when its content hash matches", async () => {
    const context = await createResolverFixture();
    const workingTarget = target(context.fixture, { kind: "working-tree", contentHash: hash(context.fixture.working) }, context.fixture.working);
    workingTarget.repository_id = context.repositoryId;

    const resolved = await context.resolver.resolve(workingTarget, "repository");
    expect(resolved.state).toBe("resolved");
    expect(resolved.content).toBe(context.fixture.working);

    const stale = await context.resolver.resolve(
      { ...workingTarget, content_hash: hash(context.fixture.committed) },
      "repository",
    );
    expect(stale.state).toBe("hash-mismatch");
    expect(stale.content).toBeUndefined();
    context.store.close();
  });

  test("returns distinct unavailable states for a missing revision and missing source", async () => {
    const context = await createResolverFixture();
    const missingRevision = target(context.fixture, { kind: "commit", sha: "deadbeefdeadbeefdeadbeefdeadbeefdeadbeef" }, context.fixture.committed);
    missingRevision.repository_id = context.repositoryId;
    expect((await context.resolver.resolve(missingRevision, "repository")).state).toBe("revision-not-found");

    const missingFile = { ...missingRevision, path: "src/missing.ts", revision: { kind: "commit", sha: context.fixture.commitSha } as const };
    expect((await context.resolver.resolve(missingFile, "repository")).state).toBe("source-unavailable");
    context.store.close();
  });

  test("resolves an explicitly selected untampered snapshot and rejects tampering", async () => {
    const context = await createResolverFixture();
    const workingTarget = target(context.fixture, { kind: "working-tree", contentHash: hash(context.fixture.working) }, context.fixture.working);
    workingTarget.repository_id = context.repositoryId;
    const snapshot = await context.snapshots.create("source-resolution-record", "changed-files", context.fixture.working);

    const resolved = await context.resolver.resolve(workingTarget, { snapshotId: snapshot.snapshot_id });
    expect(resolved.state).toBe("snapshot-resolved");
    expect(resolved.content).toBe(context.fixture.working);
    const staleTarget = { ...workingTarget, content_hash: hash(context.fixture.committed) };
    expect((await context.resolver.resolve(staleTarget, "repository")).state).toBe("hash-mismatch");

    await writeFile(join(context.snapshots.config.dataDir, snapshot.path), "x".repeat(1_001), "utf8");
    expect((await context.resolver.resolve(workingTarget, { snapshotId: snapshot.snapshot_id })).state).toBe("source-unavailable");

    await writeFile(join(context.snapshots.config.dataDir, snapshot.path), "tampered snapshot", "utf8");
    expect((await context.resolver.resolve(workingTarget, { snapshotId: snapshot.snapshot_id })).state).toBe("source-unavailable");
    context.store.close();
  });

  test("rejects traversal, absolute, drive-relative, and root-outside symlink targets", async () => {
    const context = await createResolverFixture();
    const outside = await mkdtemp(join(tmpdir(), "ai-review-source-outside-"));
    temporaryDirectories.push(outside);
    await writeFile(join(outside, "secret.ts"), "secret\n", "utf8");
    await symlink(join(outside, "secret.ts"), join(context.fixture.root, "escape.ts"));
    for (const path of ["../outside.ts", "/etc/passwd", "C:..\\outside.ts", "C:/outside.ts", "escape.ts"]) {
      const unsafe = { ...target(context.fixture, { kind: "working-tree", contentHash: hash(context.fixture.working) }, context.fixture.working), path };
      unsafe.repository_id = context.repositoryId;
      await expect(context.resolver.resolve(unsafe, "repository")).rejects.toMatchObject({ code: "PATH_OUTSIDE_ROOT" });
    }
    context.store.close();
  });

  test("GitReader and WorkingTreeReader expose fixed read-only operations", async () => {
    const context = await createResolverFixture();
    const git = new GitReader();
    const worktree = new WorkingTreeReader();
    expect(await git.readCommitFile(context.fixture.root, context.fixture.commitSha, context.fixture.path)).toBe(context.fixture.committed);
    expect(await worktree.readFile(context.fixture.root, context.fixture.path)).toEqual({ content: context.fixture.working, contentHash: hash(context.fixture.working) });
    expect(await git.readDiff(context.fixture.root, context.fixture.commitSha)).toContain("version = 2");
    context.store.close();
  });
  test("returns snapshot content even after the live repository root disappears", async () => {
    const context = await createResolverFixture();
    const workingTarget = target(context.fixture, { kind: "working-tree", contentHash: hash(context.fixture.working) }, context.fixture.working);
    workingTarget.repository_id = context.repositoryId;
    const snapshot = await context.snapshots.create("source-resolution-record", "changed-files", context.fixture.working);
    await rm(context.fixture.root, { recursive: true, force: true });

    const resolved = await context.resolver.resolve(workingTarget, { snapshotId: snapshot.snapshot_id });

    expect(resolved.state).toBe("snapshot-resolved");
    expect(resolved.content).toBe(context.fixture.working);
    context.store.close();
  });

  test("returns source-unavailable when a registered live root disappears", async () => {
    const context = await createResolverFixture();
    const workingTarget = target(context.fixture, { kind: "working-tree", contentHash: hash(context.fixture.working) }, context.fixture.working);
    workingTarget.repository_id = context.repositoryId;
    await rm(context.fixture.root, { recursive: true, force: true });

    const resolved = await context.resolver.resolve(workingTarget, "repository");

    expect(resolved.state).toBe("source-unavailable");
    context.store.close();
  });

  test("classifies a valid non-Git root as source-unavailable for commit reads", async () => {
    const root = await mkdtemp(join(tmpdir(), "ai-review-source-non-git-"));
    temporaryDirectories.push(root);
    const store = new RecordStore(new Database(":memory:"));
    const registry = new RepositoryRegistry(store);
    const registered = await registry.register(root);
    const resolver = new SourceResolver(registry);
    const nonGitTarget: TargetReference = {
      repository_id: registered.repository_id,
      path: "missing.ts",
      line_start: 1,
      line_end: 1,
      revision: { kind: "commit", sha: "deadbeefdeadbeefdeadbeefdeadbeefdeadbeef" },
      content_hash: hash("missing"),
    };

    const resolved = await resolver.resolve(nonGitTarget, "repository");

    expect(resolved.state).toBe("source-unavailable");
    store.close();
  });

  test("does not execute repository-configured filters while reading a diff", async () => {
    const context = await createResolverFixture();
    const marker = join(tmpdir(), `ai-review-filter-command-${crypto.randomUUID()}`);
    await writeFile(join(context.fixture.root, ".gitattributes"), "*.ts filter=evil\n", "utf8");
    await runGit(context.fixture.root, ["add", "--", ".gitattributes"]);
    await runGit(context.fixture.root, ["commit", "--quiet", "-m", "attributes"]);
    const attributesCommit = await runGit(context.fixture.root, ["rev-parse", "HEAD"]);
    await runGit(context.fixture.root, ["config", "filter.evil.clean", `touch ${marker}; cat`]);
    await runGit(context.fixture.root, ["config", "filter.evil.smudge", "cat"]);
    await writeFile(join(context.fixture.root, context.fixture.path), "export const version = 3;\n", "utf8");

    await new GitReader().readDiff(context.fixture.root, attributesCommit);

    expect(await readFile(marker, "utf8").catch(() => null)).toBeNull();
    context.store.close();
  });

  test("rejects oversized live source output before buffering", async () => {
    const context = await createResolverFixture();

    await expect(new WorkingTreeReader(8).readFile(context.fixture.root, context.fixture.path)).rejects.toMatchObject({ code: "PAYLOAD_TOO_LARGE" });
    await expect(new GitReader(8).readCommitFile(context.fixture.root, context.fixture.commitSha, context.fixture.path)).rejects.toMatchObject({ code: "PAYLOAD_TOO_LARGE" });
    context.store.close();
  });
});
