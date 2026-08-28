import { mkdtemp, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Database } from "bun:sqlite";
import { describe, expect, test } from "bun:test";
import type { DecisionRecordInput, ReviewSession } from "../../../packages/contracts/src/index";
import { RecordStore } from "../src/store/records";

const session: ReviewSession = {
  session_id: "session-1",
  repository_id: "repo-1",
  agent_type: "codex",
  started_at: "2026-08-20T10:00:00Z",
  status: "active",
};

const decision: DecisionRecordInput = {
  record_id: "record-1",
  session_id: session.session_id,
  repository_id: session.repository_id,
  agent_type: session.agent_type,
  revision: { kind: "commit", sha: "abc123" },
  targets: [
    {
      repository_id: session.repository_id,
      path: "src/example.ts",
      line_start: 3,
      line_end: 6,
      revision: { kind: "commit", sha: "abc123" },
      content_hash: "target-hash",
    },
  ],
  judgment: "The change is safe.",
  rationale: "The boundary remains validated.",
  checks: [{ name: "focused tests", status: "passed", details: "green" }],
  open_questions: ["Does the caller need a migration note?"],
  created_at: "2026-08-20T10:01:00Z",
};

describe("RecordStore", () => {
  test("creates the schema with foreign keys and persists sessions, targets, and checks", async () => {
    const db = new Database(":memory:");
    const store = new RecordStore(db);

    const pragma = db.query("PRAGMA foreign_keys").get() as { foreign_keys: number };
    expect(pragma.foreign_keys).toBe(1);

    const createdSession = await store.createSession(session);
    expect(createdSession).toEqual(session);

    const created = await store.insertDecision(decision);
    expect(created).toEqual({ ...decision, user_disposition: "unreviewed" });
    expect(await store.getDecision(decision.record_id)).toEqual(created);
    expect(await store.listDecisions(decision.repository_id)).toEqual([created]);
    db.close();
  });

  test("is idempotent only for matching record payloads", async () => {
    const db = new Database(":memory:");
    const store = new RecordStore(db);
    await store.createSession(session);
    const first = await store.insertDecision(decision);
    await expect(store.insertDecision({
      ...decision,
      judgment: "A different judgment must not overwrite the first record.",
      rationale: "A different rationale must not overwrite the first record.",
      user_disposition: "accepted",
    })).rejects.toMatchObject({ code: "DUPLICATE_RECORD" });
    expect(db.query("SELECT COUNT(*) AS count FROM decision_records").get()).toEqual({ count: 1 });

    const updated = await store.setDisposition(decision.record_id, "rejected");
    expect(updated.judgment).toBe(first.judgment);
    expect(updated.rationale).toBe(first.rationale);
    expect(updated.targets).toEqual(first.targets);
    expect(updated.checks).toEqual(first.checks);
    expect(updated.user_disposition).toBe("rejected");
    expect(await store.getDecision(decision.record_id)).toEqual(updated);
    db.close();
  });
  test("creates a fresh data directory before opening the file-backed database", async () => {
    const parent = await mkdtemp(join(tmpdir(), "ai-review-store-"));
    const dataDir = join(parent, "new-owner");
    const store = new RecordStore({ dataDir });
    try {
      await store.createSession(session);
      expect((await stat(dataDir)).isDirectory()).toBe(true);
      expect((await stat(join(dataDir, "records.sqlite"))).isFile()).toBe(true);
    } finally {
      store.close();
      await rm(parent, { recursive: true, force: true });
    }
  });

  test("resolves relative database paths under the configured data directory", async () => {
    const parent = await mkdtemp(join(tmpdir(), "ai-review-relative-db-"));
    const dataDir = join(parent, "owner");
    const store = new RecordStore("nested/records.sqlite", { dataDir });
    try {
      await store.createSession(session);
      expect((await stat(join(dataDir, "nested", "records.sqlite"))).isFile()).toBe(true);
    } finally {
      store.close();
      await rm(parent, { recursive: true, force: true });
    }
  });
});
