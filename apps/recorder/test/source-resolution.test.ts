import { createHash } from "node:crypto";
import { chmod, mkdir, mkdtemp, readFile, rename, rm, symlink, writeFile } from "node:fs/promises";
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

  test("preserves literal backslashes in Git-enumerated paths", async () => {
    const context = await createResolverFixture();
    const literalPath = "literal\\name.ts";
    await writeFile(join(context.fixture.root, literalPath), "before\n", "utf8");
    await runGit(context.fixture.root, ["add", "--", literalPath]);
    await runGit(context.fixture.root, ["commit", "--quiet", "-m", "literal-path"]);
    const commitSha = await runGit(context.fixture.root, ["rev-parse", "HEAD"]);
    await writeFile(join(context.fixture.root, literalPath), "after\n", "utf8");

    const diff = await new GitReader().readDiff(context.fixture.root, commitSha);

    expect(diff).toContain(`a/${literalPath}`);
    expect(diff).toContain("-before");
    expect(diff).toContain("+after");
    context.store.close();
  });
  test("reads tracked symlinks as link text without following outside targets", async () => {
    const context = await createResolverFixture();
    await writeFile(join(context.fixture.root, context.fixture.path), context.fixture.committed, "utf8");
    const outside = await mkdtemp(join(tmpdir(), "ai-review-source-link-outside-"));
    temporaryDirectories.push(outside);
    const outsideTarget = join(outside, "secret.ts");
    await writeFile(outsideTarget, "secret\n", "utf8");
    const linkPath = "outside-link.ts";
    await symlink(outsideTarget, join(context.fixture.root, linkPath));
    await runGit(context.fixture.root, ["add", "--", linkPath]);
    await runGit(context.fixture.root, ["commit", "--quiet", "-m", "symlink"]);
    const commitSha = await runGit(context.fixture.root, ["rev-parse", "HEAD"]);

    const git = new GitReader();
    const worktree = new WorkingTreeReader();
    expect(await git.readCommitFile(context.fixture.root, commitSha, linkPath)).toBe(outsideTarget);
    expect(await worktree.readFile(context.fixture.root, linkPath)).toEqual({ content: outsideTarget, contentHash: hash(outsideTarget) });
    expect(await git.readDiff(context.fixture.root, commitSha)).toBe("");
    context.store.close();
  });
  test("rejects indexed files beneath an outside symlinked parent without reading external content", async () => {
    const context = await createResolverFixture();
    const outside = await mkdtemp(join(tmpdir(), "ai-review-source-parent-link-outside-"));
    temporaryDirectories.push(outside);
    await writeFile(join(outside, "example.ts"), "outside-secret\n", "utf8");
    await rm(join(context.fixture.root, "src"), { recursive: true, force: true });
    await symlink(outside, join(context.fixture.root, "src"));

    let opened = false;
    const worktree = new WorkingTreeReader(1024, () => {
      opened = true;
      return {
        stream: () => new Response("unexpected external read").body!,
      };
    });

    await expect(worktree.readEnumeratedFile(context.fixture.root, context.fixture.path)).rejects.toMatchObject({ code: "SOURCE_UNAVAILABLE" });
    expect(opened).toBe(false);
    await expect(new GitReader().readDiff(context.fixture.root, context.fixture.commitSha)).rejects.toMatchObject({ code: "SOURCE_UNAVAILABLE" });
    context.store.close();
  });


  test("classifies corrupt committed blobs as source-unavailable", async () => {
    const context = await createResolverFixture();
    const blobSha = await runGit(context.fixture.root, ["rev-parse", `${context.fixture.commitSha}:${context.fixture.path}`]);
    await rm(join(context.fixture.root, ".git", "objects", blobSha.slice(0, 2), blobSha.slice(2)), { force: true });

    await expect(new GitReader().readCommitFile(context.fixture.root, context.fixture.commitSha, context.fixture.path)).rejects.toMatchObject({ code: "SOURCE_UNAVAILABLE" });
    await expect(new GitReader().readDiff(context.fixture.root, context.fixture.commitSha)).rejects.toMatchObject({ code: "SOURCE_UNAVAILABLE" });
    context.store.close();
  });

  test("classifies unreadable working-tree files as source-unavailable", async () => {
    const context = await createResolverFixture();
    const reader = new WorkingTreeReader(1024, () => ({
      stream: () => {
        throw new Error("permission denied");
      },
    }));

    await expect(reader.readFile(context.fixture.root, context.fixture.path)).rejects.toMatchObject({ code: "SOURCE_UNAVAILABLE" });
    context.store.close();
  });

  test("emits separate accurate hunks for separated line edits", async () => {
    const context = await createResolverFixture();
    await writeFile(join(context.fixture.root, context.fixture.path), context.fixture.committed, "utf8");
    const separatedPath = "src/separated.ts";
    const original = Array.from({ length: 15 }, (_, index) => `line-${index + 1}`).join("\n") + "\n";
    await writeFile(join(context.fixture.root, separatedPath), original, "utf8");
    await runGit(context.fixture.root, ["add", "--", separatedPath]);
    await runGit(context.fixture.root, ["commit", "--quiet", "-m", "separated-lines"]);
    const commitSha = await runGit(context.fixture.root, ["rev-parse", "HEAD"]);
    const changed = original.replace("line-2", "changed-2").replace("line-12", "changed-12");
    await writeFile(join(context.fixture.root, separatedPath), changed, "utf8");

    const diff = await new GitReader().readDiff(context.fixture.root, commitSha);

    expect(diff.match(/@@ /g)?.length).toBe(2);
    expect(diff).toContain("-line-2");
    expect(diff).toContain("+changed-2");
    expect(diff).toContain("-line-12");
    expect(diff).toContain("+changed-12");
    expect(diff).not.toContain("-line-5");
    expect(diff).not.toContain("+line-5");
    context.store.close();
  });
  test("bounds dense line diff work before retaining an unbounded trace", async () => {
    const context = await createResolverFixture();
    await writeFile(join(context.fixture.root, context.fixture.path), context.fixture.committed, "utf8");
    const densePath = "src/dense.ts";
    const original = Array.from({ length: 2_200 }, (_, index) => `old-${index}`).join("\n") + "\n";
    const changed = Array.from({ length: 2_200 }, (_, index) => `new-${index}`).join("\n") + "\n";
    await writeFile(join(context.fixture.root, densePath), original, "utf8");
    await runGit(context.fixture.root, ["add", "--", densePath]);
    await runGit(context.fixture.root, ["commit", "--quiet", "-m", "dense-lines"]);
    const commitSha = await runGit(context.fixture.root, ["rev-parse", "HEAD"]);
    await writeFile(join(context.fixture.root, densePath), changed, "utf8");

    await expect(new GitReader().readDiff(context.fixture.root, commitSha)).rejects.toMatchObject({ code: "PAYLOAD_TOO_LARGE" });
    context.store.close();
  });


  test("treats an absent tracked worktree path as a deletion", async () => {
    const context = await createResolverFixture();
    await rm(join(context.fixture.root, context.fixture.path), { force: true });

    const diff = await new GitReader().readDiff(context.fixture.root, context.fixture.commitSha);

    expect(diff).toContain("-export const version = 1;");
    expect(diff).not.toContain("SOURCE_UNAVAILABLE");
    context.store.close();
  });

  test("preserves the pre-extraction unified diff output for a created file", async () => {
    const context = await createResolverFixture();
    const createdPath = "src/created.ts";
    await writeFile(join(context.fixture.root, context.fixture.path), context.fixture.committed, "utf8");
    await writeFile(join(context.fixture.root, createdPath), "brand new\n", "utf8");
    await runGit(context.fixture.root, ["add", "--", createdPath]);
    await runGit(context.fixture.root, ["commit", "--quiet", "-m", "created"]);

    const diff = await new GitReader().readDiff(context.fixture.root, context.fixture.commitSha);

    expect(diff).toBe(
      "diff --git a/src/created.ts b/src/created.ts\n"
      + "--- a/src/created.ts\n"
      + "+++ b/src/created.ts\n"
      + "@@ -1,1 +1,2 @@\n"
      + "+brand new\n"
      + " \n",
    );
    context.store.close();
  });

  test("preserves the pre-extraction unified diff output for a deleted file", async () => {
    const context = await createResolverFixture();
    await rm(join(context.fixture.root, context.fixture.path), { force: true });

    const diff = await new GitReader().readDiff(context.fixture.root, context.fixture.commitSha);

    expect(diff).toBe(
      "diff --git a/src/example.ts b/src/example.ts\n"
      + "--- a/src/example.ts\n"
      + "+++ b/src/example.ts\n"
      + "@@ -1,2 +1,1 @@\n"
      + "-export const version = 1;\n"
      + " \n",
    );
    context.store.close();
  });

  test("preserves a non-empty unified diff result for changed binary files", async () => {
    const context = await createResolverFixture();
    await writeFile(join(context.fixture.root, context.fixture.path), Uint8Array.from([0x00, 0x01, 0x02]));

    const diff = await new GitReader().readDiff(context.fixture.root, context.fixture.commitSha);

    expect(diff).not.toBe("");
    expect(diff).toContain("diff --git a/src/example.ts b/src/example.ts");
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

  test("resolves a git-backed snapshot through read-only history and reports dangling references", async () => {
    const context = await createResolverFixture();
    const headSha = context.resolver.git.resolveRevision
      ? await context.resolver.git.resolveRevision(context.fixture.root, "HEAD")
      : await (async () => {
          const process = Bun.spawn({ cmd: ["git", "rev-parse", "HEAD"], cwd: context.fixture.root, stdout: "pipe", stderr: "pipe" });
          return (await new Response(process.stdout).text()).trim();
        })();
    const reference = await context.snapshots.createGitBacked(
      "source-resolution-record",
      headSha,
      context.fixture.path,
      hash(context.fixture.committed),
    );
    const commitTarget = target(context.fixture, { kind: "working-tree", contentHash: hash(context.fixture.committed) }, context.fixture.committed);
    commitTarget.repository_id = context.repositoryId;

    const resolved = await context.resolver.resolve(commitTarget, { snapshotId: reference.snapshot_id });
    expect(resolved.state).toBe("snapshot-resolved");
    if (resolved.state === "snapshot-resolved") {
      expect(resolved.content).toBe(context.fixture.committed);
      expect(resolved.snapshot?.base_sha).toBe(headSha);
    }
    await rm(context.fixture.root, { recursive: true, force: true });
    const unavailable = await context.resolver.resolve(commitTarget, { snapshotId: reference.snapshot_id });
    expect(unavailable.state).toBe("source-unavailable");
    context.store.close();
  });

  test("reports revision-not-found when a git-backed snapshot commit is unavailable", async () => {
    const context = await createResolverFixture();
    const reference = await context.snapshots.createGitBacked(
      "source-resolution-record",
      "0".repeat(40),
      context.fixture.path,
      hash(context.fixture.committed),
    );
    const commitTarget = target(context.fixture, { kind: "working-tree", contentHash: hash(context.fixture.committed) }, context.fixture.committed);
    commitTarget.repository_id = context.repositoryId;

    const resolved = await context.resolver.resolve(commitTarget, { snapshotId: reference.snapshot_id });

    expect(resolved.state).toBe("revision-not-found");
    context.store.close();
  });

  test("reports source-unavailable when a git-backed snapshot hash does not match its commit", async () => {
    const context = await createResolverFixture();
    const reference = await context.snapshots.createGitBacked(
      "source-resolution-record",
      context.fixture.commitSha,
      context.fixture.path,
      hash("not the committed content"),
    );
    const commitTarget = target(context.fixture, { kind: "working-tree", contentHash: hash(context.fixture.committed) }, context.fixture.committed);
    commitTarget.repository_id = context.repositoryId;

    const resolved = await context.resolver.resolve(commitTarget, { snapshotId: reference.snapshot_id });

    expect(resolved.state).toBe("source-unavailable");
    context.store.close();
  });

  test("does not resolve a git-backed snapshot from a replaced registered root", async () => {
    const context = await createResolverFixture();
    const reference = await context.snapshots.createGitBacked(
      "source-resolution-record",
      context.fixture.commitSha,
      context.fixture.path,
      hash(context.fixture.committed),
    );
    const commitTarget = target(context.fixture, { kind: "working-tree", contentHash: hash(context.fixture.committed) }, context.fixture.committed);
    commitTarget.repository_id = context.repositoryId;
    const replacementParent = await mkdtemp(join(tmpdir(), "ai-review-source-replacement-"));
    temporaryDirectories.push(replacementParent);
    const replacementRoot = join(replacementParent, "repository");

    await rename(context.fixture.root, replacementRoot);
    await symlink(replacementRoot, context.fixture.root, "dir");

    const resolved = await context.resolver.resolve(commitTarget, { snapshotId: reference.snapshot_id });

    expect(resolved.state).toBe("source-unavailable");
    context.store.close();
  });

  test("does not resolve a git-backed snapshot from an invalid UTF-8 blob", async () => {
    const context = await createResolverFixture();
    const invalidBytes = Uint8Array.from([0xff, 0xfe, 0x69, 0x6e, 0x76, 0x61, 0x6c, 0x69, 0x64, 0x0a]);
    const replacementText = "\uFFFD\uFFFDinvalid\n";
    await writeFile(join(context.fixture.root, context.fixture.path), invalidBytes);
    await runGit(context.fixture.root, ["add", "--", context.fixture.path]);
    await runGit(context.fixture.root, ["commit", "--quiet", "--no-verify", "-m", "invalid-utf8"]);
    const invalidSha = await runGit(context.fixture.root, ["rev-parse", "HEAD"]);
    const reference = await context.snapshots.createGitBacked(
      "source-resolution-record",
      invalidSha,
      context.fixture.path,
      hash(replacementText),
    );
    const commitTarget = target(context.fixture, { kind: "working-tree", contentHash: hash(replacementText) }, replacementText);
    commitTarget.repository_id = context.repositoryId;

    const resolved = await context.resolver.resolve(commitTarget, { snapshotId: reference.snapshot_id });

    expect(resolved.state).toBe("source-unavailable");
    context.store.close();
  });

  test("contains an unexpected git-backed resolution rejection as source-unavailable", async () => {
    const context = await createResolverFixture();
    const reference = await context.snapshots.createGitBacked(
      "source-resolution-record",
      context.fixture.commitSha,
      context.fixture.path,
      hash(context.fixture.committed),
    );
    const commitTarget = target(context.fixture, { kind: "working-tree", contentHash: hash(context.fixture.committed) }, context.fixture.committed);
    commitTarget.repository_id = context.repositoryId;
    context.registry.assertTarget = async () => join(context.fixture.root, context.fixture.path);
    context.registry.get = async () => {
      throw new Error("unexpected registry failure");
    };

    const resolved = await context.resolver.resolve(commitTarget, { snapshotId: reference.snapshot_id });

    expect(resolved.state).toBe("source-unavailable");
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
  test("neutralizes filter drivers with non-alphanumeric Git names and values", async () => {
    const context = await createResolverFixture();
    const marker = join(tmpdir(), `ai-review-filter-name-${crypto.randomUUID()}`);
    const driver = "evil+driver";
    await writeFile(join(context.fixture.root, ".gitattributes"), `*.ts filter=${driver}\n`, "utf8");
    await runGit(context.fixture.root, ["add", "--", ".gitattributes"]);
    await runGit(context.fixture.root, ["commit", "--quiet", "-m", "filter-name"]);
    const attributesCommit = await runGit(context.fixture.root, ["rev-parse", "HEAD"]);
    await runGit(context.fixture.root, ["config", `filter.${driver}.clean`, `touch ${marker}; cat`]);
    await runGit(context.fixture.root, ["config", `filter.${driver}.smudge`, "cat"]);
    await writeFile(join(context.fixture.root, context.fixture.path), "export const version = 4;\n", "utf8");

    await new GitReader().readDiff(context.fixture.root, attributesCommit);

    expect(await readFile(marker, "utf8").catch(() => null)).toBeNull();
    context.store.close();
  });

  test("caps bytes emitted by a growing source stream", async () => {
    const root = await mkdtemp(join(tmpdir(), "ai-review-source-growth-"));
    temporaryDirectories.push(root);
    await writeFile(join(root, "growth.ts"), "small", "utf8");
    const reader = new WorkingTreeReader(8, () => ({
      stream: () =>
        new ReadableStream<Uint8Array>({
          start(controller) {
            controller.enqueue(new TextEncoder().encode("12345678"));
            controller.enqueue(new TextEncoder().encode("9"));
            controller.close();
          },
        }),
    }));

    await expect(reader.readFile(root, "growth.ts")).rejects.toMatchObject({ code: "PAYLOAD_TOO_LARGE" });
  });
  test("isolates worktree-local filters with equals in the driver name", async () => {
    const context = await createResolverFixture();
    const marker = join(tmpdir(), `ai-review-worktree-filter-${crypto.randomUUID()}`);
    await writeFile(join(context.fixture.root, ".gitattributes"), "*.ts filter=evil=driver\n", "utf8");
    await runGit(context.fixture.root, ["add", "--", ".gitattributes"]);
    await runGit(context.fixture.root, ["commit", "--quiet", "-m", "worktree-filter"]);
    const attributesCommit = await runGit(context.fixture.root, ["rev-parse", "HEAD"]);
    await runGit(context.fixture.root, ["config", "extensions.worktreeConfig", "true"]);
    await writeFile(
      join(context.fixture.root, ".git", "config.worktree"),
      `[filter "evil=driver"]\n\tclean = touch ${marker}; cat\n\tsmudge = cat\n`,
      "utf8",
    );
    await writeFile(join(context.fixture.root, context.fixture.path), "export const version = 5;\n", "utf8");

    await new GitReader().readDiff(context.fixture.root, attributesCommit);

    expect(await readFile(marker, "utf8").catch(() => null)).toBeNull();
    context.store.close();
  });
  test("does not execute repository hooks or fsmonitor while reading a diff", async () => {
    const context = await createResolverFixture();
    const marker = join(tmpdir(), `ai-review-git-hook-${crypto.randomUUID()}`);
    const hooks = join(context.fixture.root, ".malicious-hooks");
    const fsmonitor = join(hooks, "query-watchman");
    await mkdir(hooks, { recursive: true });
    await writeFile(fsmonitor, `#!/bin/sh\ntouch "${marker}"\n`, "utf8");
    await chmod(fsmonitor, 0o755);
    await runGit(context.fixture.root, ["config", "core.hooksPath", hooks]);
    await runGit(context.fixture.root, ["config", "core.fsmonitor", fsmonitor]);
    await writeFile(join(context.fixture.root, context.fixture.path), "export const version = 6;\n", "utf8");

    await new GitReader().readDiff(context.fixture.root, context.fixture.commitSha);

    expect(await readFile(marker, "utf8").catch(() => null)).toBeNull();
    context.store.close();
  });


  test("rejects oversized live source output before buffering", async () => {
    const context = await createResolverFixture();

    await expect(new WorkingTreeReader(8).readFile(context.fixture.root, context.fixture.path)).rejects.toMatchObject({ code: "PAYLOAD_TOO_LARGE" });
    await expect(new GitReader(8).readCommitFile(context.fixture.root, context.fixture.commitSha, context.fixture.path)).rejects.toMatchObject({ code: "PAYLOAD_TOO_LARGE" });
    context.store.close();
  });

  test("readPathDiff returns structured hunks with exact old and new line numbers", async () => {
    const context = await createResolverFixture();
    const diff = await new GitReader().readPathDiff(context.fixture.root, context.fixture.commitSha, context.fixture.path);

    expect(diff.path).toBe("src/example.ts");
    expect(diff.base_sha).toBe(context.fixture.commitSha);
    expect(diff.old_missing).toBe(false);
    expect(diff.new_missing).toBe(false);
    expect(diff.binary).toBe(false);
    expect(diff.hunks).toHaveLength(1);
    expect(diff.hunks[0]!.oldStart).toBe(1);
    expect(diff.hunks[0]!.newStart).toBe(1);
    const lines = diff.hunks[0]!.lines;
    expect(lines.find((line) => line.type === "del")).toEqual({ type: "del", oldLine: 1, newLine: null, content: "export const version = 1;" });
    expect(lines.find((line) => line.type === "add")).toEqual({ type: "add", oldLine: null, newLine: 1, content: "export const version = 2;" });
    expect(lines.filter((line) => line.type === "context")).toContainEqual({ type: "context", oldLine: 2, newLine: 2, content: "" });
    context.store.close();
  });

  test("readPathDiff marks created and deleted files with missing sides", async () => {
    const context = await createResolverFixture();
    await writeFile(join(context.fixture.root, "src/added.ts"), "brand new\n", "utf8");

    const created = await new GitReader().readPathDiff(context.fixture.root, context.fixture.commitSha, "src/added.ts");
    expect(created.old_missing).toBe(true);
    expect(created.new_missing).toBe(false);
    expect(created.hunks[0]!.lines.every((line) => line.type === "add")).toBe(true);

    await rm(join(context.fixture.root, context.fixture.path), { force: true });
    const deleted = await new GitReader().readPathDiff(context.fixture.root, context.fixture.commitSha, context.fixture.path);
    expect(deleted.new_missing).toBe(true);
    expect(deleted.old_missing).toBe(false);
    expect(deleted.hunks[0]!.lines.every((line) => line.type === "del")).toBe(true);
    context.store.close();
  });

  test("readPathDiff reports binary content without hunks", async () => {
    const context = await createResolverFixture();
    const binaryPath = "src/blob.bin";
    await writeFile(join(context.fixture.root, binaryPath), Buffer.from([0x00, 0x01, 0x02]), "utf8");

    const diff = await new GitReader().readPathDiff(context.fixture.root, context.fixture.commitSha, binaryPath);

    expect(diff.binary).toBe(true);
    expect(diff.hunks).toHaveLength(0);
    expect(diff.old_missing).toBe(true);
    expect(diff.new_missing).toBe(false);
    context.store.close();
  });

  test("readPathDiff enforces the configured structured diff output limit", async () => {
    const context = await createResolverFixture();
    const largeContent = `${Array.from({ length: 24 }, (_, index) => `changed-${index}`).join("\n")}\n`;
    await writeFile(join(context.fixture.root, context.fixture.path), largeContent, "utf8");

    await expect(new GitReader(256).readPathDiff(context.fixture.root, context.fixture.commitSha, context.fixture.path)).rejects.toMatchObject({
      code: "PAYLOAD_TOO_LARGE",
    });
    context.store.close();
  });

  test("resolveRevision normalizes HEAD and rejects unsafe or absent revisions", async () => {
    const context = await createResolverFixture();
    const git = new GitReader();

    expect(await git.resolveRevision(context.fixture.root, "HEAD")).toBe(context.fixture.commitSha);
    expect(await git.resolveRevision(context.fixture.root, context.fixture.commitSha)).toBe(context.fixture.commitSha);
    await expect(git.resolveRevision(context.fixture.root, "../escape")).rejects.toMatchObject({ code: "REVISION_NOT_FOUND" });
    await expect(git.resolveRevision(context.fixture.root, "deadbeefdeadbeefdeadbeefdeadbeefdeadbeef")).rejects.toMatchObject({ code: "REVISION_NOT_FOUND" });

    const emptyRoot = await mkdtemp(join(tmpdir(), "ai-review-source-empty-repo-"));
    temporaryDirectories.push(emptyRoot);
    await runGit(emptyRoot, ["init", "--quiet"]);
    await expect(git.resolveRevision(emptyRoot, "HEAD")).rejects.toMatchObject({ code: "REVISION_NOT_FOUND" });
    context.store.close();
  });

  test("lists tracked working-tree files as a public read-only operation", async () => {
    const context = await createResolverFixture();
    const paths = await new GitReader().listWorktreeFiles(context.fixture.root);
    expect(paths).toContain("src/example.ts");
    expect(paths.every((path) => !path.startsWith("/"))).toBe(true);
    context.store.close();
  });

  test("listLocalBranches returns only refs/heads, sorted, with head_branch", async () => {
    const root = await mkdtemp(join(tmpdir(), "ai-review-branches-"));
    temporaryDirectories.push(root);
    await runGit(root, ["init", "-b", "main", "--quiet"]);
    await runGit(root, ["config", "user.email", "fixture@example.test"]);
    await runGit(root, ["config", "user.name", "Fixture"]);
    await writeFile(join(root, "README.md"), "main\n", "utf8");
    await runGit(root, ["add", "--", "README.md"]);
    await runGit(root, ["commit", "--quiet", "-m", "main"]);
    const mainSha = await runGit(root, ["rev-parse", "HEAD"]);
    await runGit(root, ["branch", "feat/x"]);
    await runGit(root, ["tag", "v1"]);
    // A tag with the same short name makes `refname:short` emit `heads/main`.
    await runGit(root, ["tag", "main"]);
    await mkdir(join(root, ".git", "refs", "remotes", "origin"), { recursive: true });
    await writeFile(join(root, ".git", "refs", "remotes", "origin", "main"), `${mainSha}\n`, "utf8");
    await runGit(root, ["update-ref", "refs/heads/weird@name", mainSha]);

    const listed = await new GitReader().listLocalBranches(root);
    expect(listed.branches.map((branch) => branch.name)).toEqual(["feat/x", "main"]);
    expect(listed.head_branch).toBe("main");
    expect(listed.branches.find((branch) => branch.name === "main")?.sha).toBe(mainSha);
    await expect(new GitReader().resolveLocalBranch(root, "main")).resolves.toMatchObject({ name: "main", sha: mainSha });
    await expect(new GitReader().resolveLocalBranch(root, "feat/x")).resolves.toMatchObject({ name: "feat/x" });
    await expect(new GitReader().resolveLocalBranch(root, "origin/main")).rejects.toMatchObject({ code: "REVISION_NOT_FOUND" });
    await expect(new GitReader().resolveLocalBranch(root, "v1")).rejects.toMatchObject({ code: "REVISION_NOT_FOUND" });
    await expect(new GitReader().resolveLocalBranch(root, "weird@name")).rejects.toMatchObject({ code: "REVISION_NOT_FOUND" });
  });

  test("listLocalBranches is empty for an unborn repository and has null head_branch when detached", async () => {
    const unborn = await mkdtemp(join(tmpdir(), "ai-review-unborn-"));
    temporaryDirectories.push(unborn);
    await runGit(unborn, ["init", "-b", "main", "--quiet"]);
    expect(await new GitReader().listLocalBranches(unborn)).toEqual({ head_branch: null, branches: [] });

    const detached = await mkdtemp(join(tmpdir(), "ai-review-detached-"));
    temporaryDirectories.push(detached);
    await runGit(detached, ["init", "-b", "main", "--quiet"]);
    await runGit(detached, ["config", "user.email", "fixture@example.test"]);
    await runGit(detached, ["config", "user.name", "Fixture"]);
    await writeFile(join(detached, "README.md"), "x\n", "utf8");
    await runGit(detached, ["add", "--", "README.md"]);
    await runGit(detached, ["commit", "--quiet", "-m", "main"]);
    await runGit(detached, ["branch", "other"]);
    await runGit(detached, ["switch", "--detach", "--quiet", "HEAD"]);
    const listed = await new GitReader().listLocalBranches(detached);
    expect(listed.head_branch).toBe(null);
    expect(listed.branches.map((branch) => branch.name).sort()).toEqual(["main", "other"]);
  });

  test("listCommitFiles lists the tree at a commit, not the working tree", async () => {
    const context = await createResolverFixture();
    await writeFile(join(context.fixture.root, "src/only-worktree.ts"), "x\n", "utf8");
    await runGit(context.fixture.root, ["add", "--", "src/only-worktree.ts"]);
    const git = new GitReader();
    const commitPaths = await git.listCommitFiles(context.fixture.root, context.fixture.commitSha);
    const worktreePaths = await git.listWorktreeFiles(context.fixture.root);
    expect(commitPaths).toContain(context.fixture.path);
    expect(commitPaths).not.toContain("src/only-worktree.ts");
    expect(worktreePaths).toContain("src/only-worktree.ts");
    context.store.close();
  });

  test("readPathDiff can use a commit tree as the new side instead of the working tree", async () => {
    const root = await mkdtemp(join(tmpdir(), "ai-review-diff-current-"));
    temporaryDirectories.push(root);
    await runGit(root, ["init", "-b", "main", "--quiet"]);
    await runGit(root, ["config", "user.email", "fixture@example.test"]);
    await runGit(root, ["config", "user.name", "Fixture"]);
    await mkdir(join(root, "src"), { recursive: true });
    await writeFile(join(root, "src/file.ts"), "main-version\n", "utf8");
    await runGit(root, ["add", "--", "src/file.ts"]);
    await runGit(root, ["commit", "--quiet", "-m", "main"]);
    const mainSha = await runGit(root, ["rev-parse", "HEAD"]);
    await runGit(root, ["switch", "-c", "feat/x", "--quiet"]);
    await writeFile(join(root, "src/file.ts"), "feature-version\n", "utf8");
    await writeFile(join(root, "src/only-on-feature.ts"), "feature-only\n", "utf8");
    await runGit(root, ["add", "--", "src/file.ts", "src/only-on-feature.ts"]);
    await runGit(root, ["commit", "--quiet", "-m", "feature"]);
    const featureSha = await runGit(root, ["rev-parse", "HEAD"]);
    await runGit(root, ["switch", "--quiet", "main"]);
    await writeFile(join(root, "src/file.ts"), "dirty-worktree\n", "utf8");

    const git = new GitReader();
    const vsFeature = await git.readPathDiff(root, mainSha, "src/file.ts", { kind: "commit", sha: featureSha });
    expect(vsFeature.base_sha).toBe(mainSha);
    expect(vsFeature.old_missing).toBe(false);
    expect(vsFeature.new_missing).toBe(false);
    expect(vsFeature.hunks.some((hunk) => hunk.lines.some((line) => line.type === "add" && line.content === "feature-version"))).toBe(true);
    expect(vsFeature.hunks.some((hunk) => hunk.lines.some((line) => line.content === "dirty-worktree"))).toBe(false);

    const missingOnMain = await git.readPathDiff(root, mainSha, "src/only-on-feature.ts", { kind: "commit", sha: featureSha });
    expect(missingOnMain.old_missing).toBe(true);
    expect(missingOnMain.new_missing).toBe(false);

    const missingOnFeature = await git.readPathDiff(root, featureSha, "src/only-on-feature.ts", { kind: "commit", sha: mainSha });
    expect(missingOnFeature.old_missing).toBe(false);
    expect(missingOnFeature.new_missing).toBe(true);

    const worktree = await git.readPathDiff(root, mainSha, "src/file.ts");
    expect(worktree.hunks.some((hunk) => hunk.lines.some((line) => line.content === "dirty-worktree"))).toBe(true);
  });
});
