import { Database } from "bun:sqlite";
import { existsSync } from "node:fs";
import { mkdir, mkdtemp, readFile, readdir, rename, rm, stat, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, relative } from "node:path";
import { afterEach, describe, expect, test } from "bun:test";
import { ERROR_CODES, type DecisionRecordInput, type ReviewSession } from "../../../packages/contracts/src/index";
import { createRecorderConfig } from "../src/config";
import { RecordStore } from "../src/store/records";
import { SnapshotStore } from "../src/store/snapshots";

const session: ReviewSession = {
  session_id: "snapshot-session",
  repository_id: "snapshot-repo",
  agent_type: "codex",
  started_at: "2026-08-20T12:00:00Z",
  status: "active",
};
const decision: DecisionRecordInput = {
  record_id: "snapshot-record",
  session_id: session.session_id,
  repository_id: session.repository_id,
  agent_type: session.agent_type,
  revision: { kind: "working-tree", contentHash: "tree-hash" },
  targets: [
    {
      repository_id: session.repository_id,
      path: "changed.ts",
      line_start: 1,
      line_end: 1,
      revision: { kind: "working-tree", contentHash: "tree-hash" },
      content_hash: "target-hash",
    },
  ],
  judgment: "The changed file is safe.",
  rationale: "The patch is bounded.",
  checks: [],
  open_questions: [],
  created_at: "2026-08-20T12:01:00Z",
};

const temporaryDirectories: string[] = [];
afterEach(async () => {
  await Promise.all(temporaryDirectories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })));
});

describe("SnapshotStore", () => {
  test("creates an explicit owner-local snapshot and deletes it", async () => {
    const dataDir = await mkdtemp(join(tmpdir(), "ai-review-snapshot-"));
    temporaryDirectories.push(dataDir);
    const db = new Database(":memory:");
    const store = new RecordStore(db);
    await store.createSession(session);
    await store.insertDecision(decision);
    const snapshots = new SnapshotStore(db, createRecorderConfig({ dataDir, maxSnapshotContentLength: 100 }));

    const reference = await snapshots.create(decision.record_id, "patch", "diff --git a/changed.ts b/changed.ts\n");
    expect(reference.record_id).toBe(decision.record_id);
    expect(reference.mode).toBe("patch");
    expect(reference.path.startsWith("snapshots/")).toBe(true);
    expect(relative(dataDir, join(dataDir, reference.path))).toBe(reference.path);
    expect(await readFile(join(dataDir, reference.path), "utf8")).toContain("diff --git");
    expect(await snapshots.get(reference.snapshot_id)).toEqual({ reference, content: "diff --git a/changed.ts b/changed.ts\n" });

    await snapshots.delete(reference.snapshot_id);
    expect(await snapshots.get(reference.snapshot_id)).toBeNull();
    db.close();
  });

  test("requires an explicit mode and enforces configured content bounds", async () => {
    const dataDir = await mkdtemp(join(tmpdir(), "ai-review-snapshot-limit-"));
    temporaryDirectories.push(dataDir);
    const db = new Database(":memory:");
    const store = new RecordStore(db);
    await store.createSession(session);
    await store.insertDecision(decision);
    const snapshots = new SnapshotStore(db, createRecorderConfig({ dataDir, maxSnapshotContentLength: 4 }));

    await expect(snapshots.create(decision.record_id, undefined as never, "text")).rejects.toThrow();
    const exactByteLimit = await snapshots.create(decision.record_id, "patch", "éé");
    expect((await snapshots.get(exactByteLimit.snapshot_id))?.content).toBe("éé");
    await expect(snapshots.create(decision.record_id, "patch", "ééé")).rejects.toThrow();
    await expect(snapshots.create(decision.record_id, "patch", "too long")).rejects.toThrow();
    db.close();
  });
  test("rejects a snapshot directory symlink that escapes the owner data directory", async () => {
    const dataDir = await mkdtemp(join(tmpdir(), "ai-review-snapshot-owner-"));
    const outsideDir = await mkdtemp(join(tmpdir(), "ai-review-snapshot-outside-"));
    temporaryDirectories.push(dataDir, outsideDir);
    await symlink(outsideDir, join(dataDir, "snapshots"), "dir");
    const db = new Database(":memory:");
    try {
      expect(() => new SnapshotStore(db, createRecorderConfig({ dataDir }))).toThrow(/outside dataDir/);
    } finally {
      db.close();
    }
  });

  test("does not load a snapshot file whose byte size exceeds the configured limit", async () => {
    const dataDir = await mkdtemp(join(tmpdir(), "ai-review-snapshot-size-"));
    temporaryDirectories.push(dataDir);
    const db = new Database(":memory:");
    const store = new RecordStore(db);
    await store.createSession(session);
    await store.insertDecision(decision);
    const snapshots = new SnapshotStore(db, createRecorderConfig({ dataDir, maxSnapshotContentLength: 8 }));
    const reference = await snapshots.create(decision.record_id, "patch", "small");
    await writeFile(join(dataDir, reference.path), "0123456789", "utf8");
    expect(await snapshots.get(reference.snapshot_id)).toBeNull();
    db.close();
  });

  const sha40 = "a".repeat(40);

  async function gitFixture() {
    const dataDir = await mkdtemp(join(tmpdir(), "ai-review-snapshot-git-"));
    temporaryDirectories.push(dataDir);
    const db = new Database(":memory:");
    const store = new RecordStore(db);
    await store.createSession(session);
    await store.insertDecision(decision);
    return { dataDir, db, snapshots: new SnapshotStore(db, createRecorderConfig({ dataDir })) };
  }

  test("creates git-backed references without writing files", async () => {
    const { dataDir, db, snapshots } = await gitFixture();
    expect(existsSync(join(dataDir, "snapshots"))).toBe(false);
    const reference = await snapshots.createGitBacked(decision.record_id, sha40, "changed.ts", "hash-1");
    expect(reference.mode).toBe("git");
    expect(reference.path).toBe("");
    expect(reference.base_sha).toBe(sha40);
    expect(reference.source_path).toBe("changed.ts");
    expect(existsSync(join(dataDir, "snapshots"))).toBe(false);

    expect(await snapshots.get(reference.snapshot_id)).toBeNull();
    expect(await snapshots.getReference(reference.snapshot_id)).toEqual(reference);

    const second = await snapshots.createGitBacked(decision.record_id, sha40, "other.ts", "hash-2");
    expect(second.snapshot_id).not.toBe(reference.snapshot_id);
    db.close();
  });

  test("rejects git-backed creation with an unknown record or malformed fields", async () => {
    const { db, snapshots } = await gitFixture();
    await expect(snapshots.createGitBacked("missing-record", sha40, "a.ts", "h")).rejects.toThrow(/does not exist/);
    await expect(snapshots.createGitBacked(decision.record_id, "ZZ", "a.ts", "h")).rejects.toThrow();
    await expect(snapshots.createGitBacked(decision.record_id, sha40, "../escape.ts", "h")).rejects.toThrow();
    db.close();
  });

  test("deletes git-backed rows without touching disk", async () => {
    const { db, snapshots } = await gitFixture();
    const reference = await snapshots.createGitBacked(decision.record_id, sha40, "changed.ts", "hash-1");
    await snapshots.delete(reference.snapshot_id);
    expect(await snapshots.getReference(reference.snapshot_id)).toBeNull();
    db.close();
  });

  async function automaticFixture() {
    const dataDir = await mkdtemp(join(tmpdir(), "ai-review-snapshot-automatic-"));
    temporaryDirectories.push(dataDir);
    const db = new Database(":memory:");
    const store = new RecordStore(db);
    await store.createSession(session);
    await store.insertDecision(decision);
    const snapshots = new SnapshotStore(db, createRecorderConfig({ dataDir, maxSnapshotContentLength: 100 }));
    return { dataDir, db, store, snapshots, repositoryId: session.repository_id };
  }

  function automaticSession(sessionId: string, repositoryId: string): ReviewSession {
    return { ...session, session_id: sessionId, repository_id: repositoryId };
  }

  function automaticDecision(recordId: string, sessionId: string, repositoryId: string, sourcePath: string): DecisionRecordInput {
    return {
      ...decision,
      record_id: recordId,
      session_id: sessionId,
      repository_id: repositoryId,
      targets: [{ ...decision.targets[0]!, repository_id: repositoryId, path: sourcePath }],
    };
  }

  async function automaticSequenceFixture() {
    const context = await automaticFixture();
    const nextSession = automaticSession("snapshot-next-session", context.repositoryId);
    const nextDecision = automaticDecision("snapshot-next-record", nextSession.session_id, context.repositoryId, "changed.ts");
    const otherPathSession = automaticSession("snapshot-other-path-session", context.repositoryId);
    const otherPathDecision = automaticDecision("snapshot-other-path-record", otherPathSession.session_id, context.repositoryId, "other.ts");
    const otherRepositoryId = "other-snapshot-repo";
    const otherRepositorySession = automaticSession("snapshot-other-repository-session", otherRepositoryId);
    const otherRepositoryDecision = automaticDecision(
      "snapshot-other-repository-record",
      otherRepositorySession.session_id,
      otherRepositoryId,
      "changed.ts",
    );

    await context.store.createSession(nextSession);
    await context.store.insertDecision(nextDecision);
    await context.store.createSession(otherPathSession);
    await context.store.insertDecision(otherPathDecision);
    await context.store.createSession(otherRepositorySession);
    await context.store.insertDecision(otherRepositoryDecision);

    return {
      ...context,
      input: { recordId: decision.record_id, sourcePath: "changed.ts", beforeMissing: false },
      nextInput: { recordId: nextDecision.record_id, sourcePath: "changed.ts", beforeMissing: false },
      otherPathInput: { recordId: otherPathDecision.record_id, sourcePath: "other.ts", beforeMissing: false },
      otherRepositoryInput: { recordId: otherRepositoryDecision.record_id, sourcePath: "changed.ts", beforeMissing: false },
      otherRepositoryId,
    };
  }

  test("stores an automatic file snapshot with source metadata and sequence", async () => {
    const context = await automaticFixture();
    const reference = await context.snapshots.createAutomatic({
      recordId: decision.record_id,
      captureId: "capture-1",
      sourcePath: "./changed.ts",
      content: "before\n",
      beforeMissing: false,
    });

    expect(reference).toMatchObject({
      mode: "changed-files",
      source_path: "changed.ts",
      capture_kind: "automatic",
      before_missing: false,
    });
    expect(await context.snapshots.get(reference.snapshot_id)).toMatchObject({ content: "before\n" });
    expect((await stat(join(context.dataDir, reference.path))).mode & 0o777).toBe(0o600);
    expect((await context.snapshots.getAutomaticForRecord(decision.record_id, "changed.ts"))?.captureSequence).toBe(1);
    context.db.close();
  });

  test("rejects an automatic file write through an escaping record-directory symlink", async () => {
    const context = await automaticFixture();
    const outsideDir = await mkdtemp(join(tmpdir(), "ai-review-snapshot-automatic-outside-"));
    temporaryDirectories.push(outsideDir);
    const ownerDirectory = join(context.dataDir, "snapshots", encodeURIComponent(decision.record_id));
    await mkdir(join(context.dataDir, "snapshots"), { recursive: true });
    await symlink(outsideDir, ownerDirectory, "dir");

    await expect(context.snapshots.createAutomatic({
      recordId: decision.record_id,
      captureId: "capture-escaping",
      sourcePath: "changed.ts",
      content: "before",
      beforeMissing: false,
    })).rejects.toMatchObject({ code: ERROR_CODES.PATH_OUTSIDE_ROOT });
    expect(await readdir(outsideDir)).toEqual([]);
    expect((context.db.query("SELECT COUNT(*) AS count FROM snapshots WHERE capture_id = 'capture-escaping'").get() as { count: number }).count).toBe(0);
    context.db.close();
  });

  test("keeps automatic files in the pinned snapshot root after its path is replaced", async () => {
    const context = await automaticFixture();
    await context.snapshots.createAutomatic({
      recordId: decision.record_id,
      captureId: "capture-pinned-before",
      sourcePath: "changed.ts",
      content: "before",
      beforeMissing: false,
    });
    const outsideDir = await mkdtemp(join(tmpdir(), "ai-review-snapshot-pinned-outside-"));
    temporaryDirectories.push(outsideDir);
    const snapshotRoot = join(context.dataDir, "snapshots");
    const movedRoot = join(context.dataDir, "snapshots-moved");
    await rename(snapshotRoot, movedRoot);
    await symlink(outsideDir, snapshotRoot, "dir");

    const second = await context.snapshots.createAutomatic({
      recordId: decision.record_id,
      captureId: "capture-pinned-after",
      sourcePath: "changed.ts",
      content: "after",
      beforeMissing: false,
    });

    expect(await readdir(outsideDir)).toEqual([]);
    expect(await readdir(join(movedRoot, encodeURIComponent(decision.record_id)))).toHaveLength(2);
    expect(second.path.startsWith("snapshots/")).toBe(true);
    context.db.close();
  });

  test("stores an automatic missing-file snapshot without treating it as an empty file", async () => {
    const context = await automaticFixture();
    const reference = await context.snapshots.createAutomatic({
      recordId: decision.record_id,
      captureId: "capture-missing",
      sourcePath: "changed.ts",
      content: "",
      beforeMissing: true,
    });

    expect(reference.before_missing).toBe(true);
    expect((await context.snapshots.get(reference.snapshot_id))?.content).toBe("");
    expect((await context.snapshots.getAutomaticForRecord(decision.record_id, "changed.ts"))?.beforeMissing).toBe(true);
    context.db.close();
  });

  test("stores automatic Git-backed metadata without writing a file", async () => {
    const context = await automaticFixture();
    const reference = await context.snapshots.createAutomaticGitBacked({
      recordId: decision.record_id,
      captureId: "capture-git",
      sourcePath: "changed.ts",
      baseSha: sha40,
      contentHash: "a".repeat(64),
    });

    expect(reference).toMatchObject({
      mode: "git",
      path: "",
      base_sha: sha40,
      source_path: "changed.ts",
      capture_kind: "automatic",
      before_missing: false,
    });
    expect(await context.snapshots.get(reference.snapshot_id)).toBeNull();
    expect(await context.snapshots.getReference(reference.snapshot_id)).toEqual(reference);
    expect((await context.snapshots.getAutomaticForRecord(decision.record_id, "changed.ts"))?.reference).toEqual(reference);
    expect(await readdir(join(context.dataDir, "snapshots")).catch(() => [])).toEqual([]);
    context.db.close();
  });

  test("reuses an identical capture and rejects a conflicting capture", async () => {
    const context = await automaticFixture();
    const input = {
      recordId: decision.record_id,
      captureId: "capture-repeat",
      sourcePath: "changed.ts",
      content: "before",
      beforeMissing: false,
    };
    const first = await context.snapshots.createAutomatic(input);
    const second = await context.snapshots.createAutomatic(input);

    expect(second).toEqual(first);
    await expect(context.snapshots.createAutomatic({ ...input, content: "different" })).rejects.toMatchObject({
      code: ERROR_CODES.INVALID_RECORD,
    });
    expect((context.db.query("SELECT COUNT(*) AS count FROM snapshots WHERE capture_id = 'capture-repeat'").get() as { count: number }).count).toBe(1);
    expect((await readdir(join(context.dataDir, "snapshots", encodeURIComponent(decision.record_id)))).length).toBe(1);
    context.db.close();
  });

  test("finds the next automatic snapshot across sessions but not across paths or repositories", async () => {
    const context = await automaticSequenceFixture();
    const before = await context.snapshots.createAutomatic({ ...context.input, captureId: "capture-1", content: "one" });
    await context.snapshots.createAutomatic({ ...context.otherPathInput, captureId: "capture-other-path", content: "ignored" });
    await context.snapshots.createAutomaticGitBacked({
      ...context.otherRepositoryInput,
      captureId: "capture-other-repository",
      baseSha: sha40,
      contentHash: "b".repeat(64),
    });
    const next = await context.snapshots.createAutomatic({ ...context.nextInput, captureId: "capture-2", content: "two" });
    const beforeMetadata = await context.snapshots.getAutomaticForRecord(context.input.recordId, context.input.sourcePath);
    const nextMetadata = await context.snapshots.getNextAutomatic(
      context.repositoryId,
      context.input.sourcePath,
      beforeMetadata?.captureSequence ?? 0,
    );

    expect(beforeMetadata?.reference.snapshot_id).toBe(before.snapshot_id);
    expect(nextMetadata?.reference.snapshot_id).toBe(next.snapshot_id);
    expect(nextMetadata?.captureSequence).toBe(4);
    expect((await context.snapshots.getNextAutomatic(context.repositoryId, "other.ts", 0))?.reference.record_id).toBe(context.otherPathInput.recordId);
    expect((await context.snapshots.getNextAutomatic(context.otherRepositoryId, "changed.ts", 0))?.reference.record_id).toBe(context.otherRepositoryInput.recordId);
    context.db.close();
  });

  test("throws when the selected automatic row has an invalid reference instead of skipping it", async () => {
    const context = await automaticFixture();
    context.db.query(
      `INSERT INTO snapshots (
         snapshot_id, record_id, mode, path, content_hash, created_at,
         base_sha, source_path, capture_kind, before_missing, capture_sequence, capture_id
       ) VALUES ($snapshot_id, $record_id, 'changed-files', '../escape.snapshot', $content_hash,
         '2026-08-27T00:00:00Z', NULL, 'changed.ts', 'automatic', 0, 1, 'capture-invalid')`,
    ).run({
      $snapshot_id: "invalid-automatic",
      $record_id: decision.record_id,
      $content_hash: "c".repeat(64),
    });

    expect(await context.snapshots.getReference("invalid-automatic")).toBeNull();
    await expect(context.snapshots.getAutomaticForRecord(decision.record_id, "changed.ts")).rejects.toMatchObject({
      code: ERROR_CODES.SOURCE_UNAVAILABLE,
    });
    await expect(context.snapshots.getNextAutomatic(context.repositoryId, "changed.ts", 0)).rejects.toMatchObject({
      code: ERROR_CODES.SOURCE_UNAVAILABLE,
    });
    context.db.close();
  });
});
