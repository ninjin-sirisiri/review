import { createHash } from "node:crypto";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { ERROR_CODES, type DecisionRecord, type DecisionRecordInput, type TargetReference } from "../../../packages/contracts/src/index";
import { createRecorderConfig } from "../src/config";
import { RepositoryRegistry } from "../src/repositories/registry";
import { GitReader } from "../src/source/git";
import { resolveSnapshotDiff, type SnapshotDiffDependencies } from "../src/source/snapshot-diff";
import { WorkingTreeReader } from "../src/source/worktree";
import { RecordStore } from "../src/store/records";
import { SnapshotStore, type AutomaticSnapshotInput } from "../src/store/snapshots";

const temporaryDirectories: string[] = [];
const openDatabases: Database[] = [];

type TransitionFixture = {
  root: string;
  dataDir: string;
  path: string;
  commitSha: string;
  committed: string;
  repositoryId: string;
  firstRecord: DecisionRecord;
  secondRecord: DecisionRecord;
  manualRecord: DecisionRecord;
  firstInput: Omit<AutomaticSnapshotInput, "captureId" | "content">;
  secondInput: Omit<AutomaticSnapshotInput, "captureId" | "content">;
  db: Database;
  store: RecordStore;
  snapshots: SnapshotStore;
  dependencies: SnapshotDiffDependencies;
};

function hash(content: string): string {
  return createHash("sha256").update(content, "utf8").digest("hex");
}

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

function target(repositoryId: string, path: string, content = "target\n"): TargetReference {
  return {
    repository_id: repositoryId,
    path,
    line_start: 1,
    line_end: 1,
    revision: { kind: "working-tree", contentHash: hash(content) },
    content_hash: hash(content),
  };
}

function inputRecord(
  recordId: string,
  sessionId: string,
  repositoryId: string,
  path: string,
  content = "target\n",
): DecisionRecordInput {
  return {
    record_id: recordId,
    session_id: sessionId,
    repository_id: repositoryId,
    agent_type: "codex",
    revision: { kind: "working-tree", contentHash: hash(content) },
    targets: [target(repositoryId, path, content)],
    judgment: "Safe",
    rationale: "Fixture",
    checks: [],
    open_questions: [],
    created_at: "2026-08-27T12:00:00Z",
  };
}

async function createTransitionFixture(): Promise<TransitionFixture> {
  const root = await mkdtemp(join(tmpdir(), "ai-review-transition-repository-"));
  temporaryDirectories.push(root);
  await runGit(root, ["init", "--quiet"]);
  await runGit(root, ["config", "user.email", "fixture@example.test"]);
  await runGit(root, ["config", "user.name", "Fixture"]);
  const path = "src/example.ts";
  const committed = "const value = 1;\n";
  await mkdir(join(root, "src"), { recursive: true });
  await writeFile(join(root, path), committed, "utf8");
  await runGit(root, ["add", "--", path]);
  await runGit(root, ["commit", "--quiet", "-m", "fixture"]);
  const commitSha = await runGit(root, ["rev-parse", "HEAD"]);

  const dataDir = await mkdtemp(join(tmpdir(), "ai-review-transition-data-"));
  temporaryDirectories.push(dataDir);
  const db = new Database(":memory:");
  openDatabases.push(db);
  const store = new RecordStore(db);
  const registry = new RepositoryRegistry(store);
  const repository = await registry.register(root);
  const firstSession = {
    session_id: "transition-first-session",
    repository_id: repository.repository_id,
    agent_type: "codex" as const,
    started_at: "2026-08-27T12:01:00Z",
    status: "active" as const,
  };
  const secondSession = {
    ...firstSession,
    session_id: "transition-second-session",
    started_at: "2026-08-27T12:02:00Z",
  };
  const manualSession = {
    ...firstSession,
    session_id: "transition-manual-session",
    started_at: "2026-08-27T12:03:00Z",
  };
  await store.createSession(firstSession);
  await store.createSession(secondSession);
  await store.createSession(manualSession);
  const firstRecord = await store.insertDecision(inputRecord("transition-first-record", firstSession.session_id, repository.repository_id, path));
  const secondRecord = await store.insertDecision(inputRecord("transition-second-record", secondSession.session_id, repository.repository_id, path));
  const manualRecord = await store.insertDecision(inputRecord("transition-manual-record", manualSession.session_id, repository.repository_id, path));
  const snapshots = new SnapshotStore(db, createRecorderConfig({ dataDir, maxSnapshotContentLength: 10_000, maxSourceContentLength: 10_000 }));
  const git = new GitReader(10_000);
  const worktree = new WorkingTreeReader(10_000);
  return {
    root,
    dataDir,
    path,
    commitSha,
    committed,
    repositoryId: repository.repository_id,
    firstRecord,
    secondRecord,
    manualRecord,
    firstInput: { recordId: firstRecord.record_id, sourcePath: path, beforeMissing: false },
    secondInput: { recordId: secondRecord.record_id, sourcePath: path, beforeMissing: false },
    db,
    store,
    snapshots,
    dependencies: { registry, snapshots, git, worktree },
  };
}

afterEach(async () => {
  for (const db of openDatabases.splice(0)) {
    db.close();
  }
  await Promise.all(temporaryDirectories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })));
});

describe("snapshot transition resolution", () => {
  test("compares an automatic before snapshot with the first later snapshot across sessions", async () => {
    const context = await createTransitionFixture();
    const before = await context.snapshots.createAutomatic({
      recordId: context.firstRecord.record_id,
      captureId: "capture-before",
      sourcePath: context.path,
      content: "const value = 1;\n",
      beforeMissing: false,
    });
    await context.snapshots.createAutomatic({
      recordId: context.secondRecord.record_id,
      captureId: "capture-next",
      sourcePath: context.path,
      content: "const value = 2;\n",
      beforeMissing: false,
    });

    const result = await resolveSnapshotDiff(context.firstRecord, context.path, context.dependencies);

    expect(result.state).toBe("snapshot-resolved");
    if (result.state === "snapshot-resolved") {
      expect(result.from.snapshot_id).toBe(before.snapshot_id);
      expect(result.to.kind).toBe("snapshot");
      expect(result.hunks.flatMap((hunk) => hunk.lines)).toContainEqual(
        expect.objectContaining({ type: "add", content: "const value = 2;" }),
      );
    }
  });

  test("uses the current worktree when there is no later automatic snapshot", async () => {
    const context = await createTransitionFixture();
    await context.snapshots.createAutomatic({
      recordId: context.firstRecord.record_id,
      captureId: "capture-before",
      sourcePath: context.path,
      content: "before\n",
      beforeMissing: false,
    });
    await writeFile(join(context.root, context.path), "after\n", "utf8");

    const result = await resolveSnapshotDiff(context.firstRecord, context.path, context.dependencies);

    expect(result).toMatchObject({ state: "snapshot-resolved", to: { kind: "working-tree" } });
    if (result.state === "snapshot-resolved") {
      expect(result.hunks.flatMap((hunk) => hunk.lines)).toContainEqual(expect.objectContaining({ type: "add", content: "after" }));
    }
  });

  test("returns legacy-fallback when the selected record has no automatic snapshot", async () => {
    const context = await createTransitionFixture();

    await expect(resolveSnapshotDiff(context.manualRecord, context.path, context.dependencies)).resolves.toEqual({
      state: "legacy-fallback",
      reason: "automatic-snapshot-not-found",
      path: context.path,
    });
  });

  test("does not skip a broken next snapshot", async () => {
    const context = await createTransitionFixture();
    const before = await context.snapshots.createAutomatic({ ...context.firstInput, captureId: "capture-before", content: "one" });
    const next = await context.snapshots.createAutomatic({ ...context.secondInput, captureId: "capture-next", content: "two" });
    await writeFile(join(context.dataDir, next.path), "tampered", "utf8");

    const result = await resolveSnapshotDiff(context.firstRecord, context.path, context.dependencies);

    expect(result.state).toBe("source-unavailable");
    expect(before.snapshot_id).not.toBe(next.snapshot_id);
  });

  test("rejects a transition whose structured diff exceeds the configured output-byte limit", async () => {
    const context = await createTransitionFixture();
    await context.snapshots.createAutomatic({ ...context.firstInput, captureId: "capture-before-large", content: "a".repeat(100) });
    await context.snapshots.createAutomatic({ ...context.secondInput, captureId: "capture-next-large", content: "b".repeat(100) });
    context.dependencies.git = new GitReader(64);

    await expect(resolveSnapshotDiff(context.firstRecord, context.path, context.dependencies)).rejects.toMatchObject({
      code: ERROR_CODES.PAYLOAD_TOO_LARGE,
    });
  });

  test("reports a missing before file as old_missing without confusing it with an empty file", async () => {
    const context = await createTransitionFixture();
    await context.snapshots.createAutomatic({
      recordId: context.firstRecord.record_id,
      captureId: "capture-missing-before",
      sourcePath: context.path,
      content: "",
      beforeMissing: true,
    });
    await writeFile(join(context.root, context.path), "created\n", "utf8");

    const result = await resolveSnapshotDiff(context.firstRecord, context.path, context.dependencies);

    expect(result).toMatchObject({ state: "snapshot-resolved", old_missing: true, new_missing: false });
    if (result.state === "snapshot-resolved") {
      expect(result.hunks[0]?.lines.every((line) => line.type === "add")).toBe(true);
    }
  });

  test("reports a missing next file as new_missing instead of using the worktree", async () => {
    const context = await createTransitionFixture();
    await context.snapshots.createAutomatic({ ...context.firstInput, captureId: "capture-before", content: "before\n" });
    const next = await context.snapshots.createAutomatic({
      ...context.secondInput,
      captureId: "capture-next-missing",
      content: "",
      beforeMissing: true,
    });
    await writeFile(join(context.root, context.path), "worktree content\n", "utf8");

    const result = await resolveSnapshotDiff(context.firstRecord, context.path, context.dependencies);

    expect(result).toMatchObject({ state: "snapshot-resolved", new_missing: true, to: { kind: "snapshot", snapshot_id: next.snapshot_id } });
  });

  test("reports a deleted current worktree file when there is no next snapshot", async () => {
    const context = await createTransitionFixture();
    await context.snapshots.createAutomatic({ ...context.firstInput, captureId: "capture-before", content: "before\n" });
    await rm(join(context.root, context.path), { force: true });

    const result = await resolveSnapshotDiff(context.firstRecord, context.path, context.dependencies);

    expect(result).toMatchObject({ state: "snapshot-resolved", new_missing: true, to: { kind: "working-tree" } });
  });

  test("returns an empty diff for identical automatic snapshots", async () => {
    const context = await createTransitionFixture();
    await context.snapshots.createAutomatic({ ...context.firstInput, captureId: "capture-before", content: "same\n" });
    await context.snapshots.createAutomatic({ ...context.secondInput, captureId: "capture-next", content: "same\n" });

    const result = await resolveSnapshotDiff(context.firstRecord, context.path, context.dependencies);

    expect(result).toMatchObject({ state: "snapshot-resolved", binary: false, hunks: [] });
  });

  test("returns binary without hunks when either automatic snapshot contains a NUL byte", async () => {
    const context = await createTransitionFixture();
    await context.snapshots.createAutomatic({ ...context.firstInput, captureId: "capture-before", content: "before\0" });
    await context.snapshots.createAutomatic({ ...context.secondInput, captureId: "capture-next", content: "after\0" });

    const result = await resolveSnapshotDiff(context.firstRecord, context.path, context.dependencies);

    expect(result).toMatchObject({ state: "snapshot-resolved", binary: true, hunks: [] });
  });

  test("reads Git-backed automatic snapshots through the registered repository", async () => {
    const context = await createTransitionFixture();
    const before = await context.snapshots.createAutomaticGitBacked({
      recordId: context.firstRecord.record_id,
      captureId: "capture-git-before",
      sourcePath: context.path,
      baseSha: context.commitSha,
      contentHash: hash(context.committed),
    });
    await writeFile(join(context.root, context.path), "const value = 2;\n", "utf8");
    await runGit(context.root, ["add", "--", context.path]);
    await runGit(context.root, ["commit", "--quiet", "-m", "second"]);
    const nextSha = await runGit(context.root, ["rev-parse", "HEAD"]);
    const nextContent = "const value = 2;\n";
    const next = await context.snapshots.createAutomaticGitBacked({
      recordId: context.secondRecord.record_id,
      captureId: "capture-git-next",
      sourcePath: context.path,
      baseSha: nextSha,
      contentHash: hash(nextContent),
    });

    const result = await resolveSnapshotDiff(context.firstRecord, context.path, context.dependencies);

    expect(result).toMatchObject({ state: "snapshot-resolved", from: { snapshot_id: before.snapshot_id }, to: { snapshot_id: next.snapshot_id } });
  });

  test("maps a missing Git revision to revision-not-found", async () => {
    const context = await createTransitionFixture();
    await context.snapshots.createAutomaticGitBacked({
      recordId: context.firstRecord.record_id,
      captureId: "capture-missing-revision",
      sourcePath: context.path,
      baseSha: "0".repeat(40),
      contentHash: hash("missing\n"),
    });

    await expect(resolveSnapshotDiff(context.firstRecord, context.path, context.dependencies)).resolves.toMatchObject({
      state: "revision-not-found",
      path: context.path,
    });
  });

  test("maps invalid UTF-8 Git content to source-unavailable", async () => {
    const context = await createTransitionFixture();
    const invalidBytes = Uint8Array.from([0xff, 0xfe, 0x69, 0x6e, 0x76, 0x61, 0x6c, 0x69, 0x64, 0x0a]);
    await writeFile(join(context.root, context.path), invalidBytes);
    await runGit(context.root, ["add", "--", context.path]);
    await runGit(context.root, ["commit", "--quiet", "--no-verify", "-m", "invalid-utf8"]);
    const invalidSha = await runGit(context.root, ["rev-parse", "HEAD"]);
    await context.snapshots.createAutomaticGitBacked({
      recordId: context.firstRecord.record_id,
      captureId: "capture-invalid-utf8",
      sourcePath: context.path,
      baseSha: invalidSha,
      contentHash: hash("replacement\n"),
    });

    await expect(resolveSnapshotDiff(context.firstRecord, context.path, context.dependencies)).resolves.toMatchObject({
      state: "source-unavailable",
      path: context.path,
    });
  });

  test("returns source-unavailable for a path that is not an exact target", async () => {
    const context = await createTransitionFixture();
    await context.snapshots.createAutomatic({ ...context.firstInput, captureId: "capture-before", content: "before\n" });

    await expect(resolveSnapshotDiff(context.firstRecord, "src/other.ts", context.dependencies)).resolves.toMatchObject({
      state: "source-unavailable",
      path: "src/other.ts",
    });
  });

  test("rejects a file-backed snapshot when its stored path differs from the selected reference", async () => {
    const context = await createTransitionFixture();
    await context.snapshots.createAutomatic({ ...context.firstInput, captureId: "capture-swapped-path", content: "before\n" });
    const originalGet = context.snapshots.get.bind(context.snapshots);
    context.snapshots.get = async (snapshotId) => {
      const stored = await originalGet(snapshotId);
      if (stored === null) return null;
      return { ...stored, reference: { ...stored.reference, path: `${stored.reference.path}.swapped` } };
    };

    await expect(resolveSnapshotDiff(context.firstRecord, context.path, context.dependencies)).resolves.toMatchObject({
      state: "source-unavailable",
      path: context.path,
    });
  });

  test("does not use automatic snapshots from a different repository", async () => {
    const context = await createTransitionFixture();
    await context.snapshots.createAutomatic({ ...context.firstInput, captureId: "capture-before", content: "before\n" });

    const otherRoot = await mkdtemp(join(tmpdir(), "ai-review-transition-other-repository-"));
    temporaryDirectories.push(otherRoot);
    await runGit(otherRoot, ["init", "--quiet"]);
    await runGit(otherRoot, ["config", "user.email", "fixture@example.test"]);
    await runGit(otherRoot, ["config", "user.name", "Fixture"]);
    await writeFile(join(otherRoot, "example.ts"), "other\n", "utf8");
    await runGit(otherRoot, ["add", "--", "example.ts"]);
    await runGit(otherRoot, ["commit", "--quiet", "-m", "other"]);
    const otherRepository = await context.dependencies.registry.register(otherRoot);
    const otherSession = {
      session_id: "transition-other-session",
      repository_id: otherRepository.repository_id,
      agent_type: "codex" as const,
      started_at: "2026-08-27T12:04:00Z",
      status: "active" as const,
    };
    await context.store.createSession(otherSession);
    const otherRecord = await context.store.insertDecision(inputRecord("transition-other-record", otherSession.session_id, otherRepository.repository_id, context.path));
    await context.snapshots.createAutomatic({
      recordId: otherRecord.record_id,
      captureId: "capture-other-repository",
      sourcePath: context.path,
      content: "other\n",
      beforeMissing: false,
    });
    await writeFile(join(context.root, context.path), "after\n", "utf8");

    const result = await resolveSnapshotDiff(context.firstRecord, context.path, context.dependencies);

    expect(result).toMatchObject({ state: "snapshot-resolved", to: { kind: "working-tree" } });
  });

  test("returns source-unavailable when the selected record target repository does not match the record", async () => {
    const context = await createTransitionFixture();
    const mismatchedRecord = {
      ...context.firstRecord,
      repository_id: "different-repository",
    };

    await expect(resolveSnapshotDiff(mismatchedRecord, context.path, context.dependencies)).resolves.toMatchObject({
      state: "source-unavailable",
      path: context.path,
    });
  });
});
