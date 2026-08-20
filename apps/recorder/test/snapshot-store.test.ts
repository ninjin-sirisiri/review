import { Database } from "bun:sqlite";
import { mkdtemp, readFile, rm } from "node:fs/promises";
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
    await expect(snapshots.create(decision.record_id, "patch", "too long")).rejects.toThrow();
    db.close();
  });
});
