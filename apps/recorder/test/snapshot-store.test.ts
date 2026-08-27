import { Database } from "bun:sqlite";
import { readdirSync } from "node:fs";
import { mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, relative } from "node:path";
import { afterEach, describe, expect, test } from "bun:test";
import type { DecisionRecordInput, ReviewSession } from "../../../packages/contracts/src/index";
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
    const reference = await snapshots.createGitBacked(decision.record_id, sha40, "changed.ts", "hash-1");
    expect(reference.mode).toBe("git");
    expect(reference.path).toBe("");
    expect(reference.base_sha).toBe(sha40);
    expect(reference.source_path).toBe("changed.ts");
    expect(readdirSync(join(dataDir, "snapshots")).length).toBe(0);

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
});
