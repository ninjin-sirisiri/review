import { Database } from "bun:sqlite";
import { describe, expect, test } from "bun:test";
import { MAX_TEXT_FIELD_LENGTH, type DecisionRecordInput, type ReviewSession } from "../../../packages/contracts/src/index";
import { RecordService } from "../src/records/service";
import { RecordStore } from "../src/store/records";

const session: ReviewSession = {
  session_id: "service-session",
  repository_id: "service-repo",
  agent_type: "claude-code",
  started_at: "2026-08-20T11:00:00Z",
  status: "active",
};

const decision: DecisionRecordInput = {
  record_id: "service-record",
  session_id: session.session_id,
  repository_id: session.repository_id,
  agent_type: session.agent_type,
  revision: { kind: "working-tree", contentHash: "tree-hash" },
  targets: [
    {
      repository_id: session.repository_id,
      path: "src/service.ts",
      line_start: 1,
      line_end: 2,
      revision: { kind: "working-tree", contentHash: "tree-hash" },
      content_hash: "content-hash",
    },
  ],
  judgment: "The service is safe.",
  rationale: "The input is validated before persistence.",
  checks: [],
  open_questions: [],
  created_at: "2026-08-20T11:01:00Z",
};

describe("RecordService", () => {
  test("validates before persistence and rejects conflicting duplicate submissions", async () => {
    const db = new Database(":memory:");
    const store = new RecordStore(db);
    await store.createSession(session);
    const service = new RecordService(store);

    const first = await service.record(decision);
    await expect(service.record({ ...decision, judgment: "ignored" })).rejects.toMatchObject({ code: "DUPLICATE_RECORD" });

    await expect(service.record({ ...decision, judgment: "x".repeat(MAX_TEXT_FIELD_LENGTH + 1) })).rejects.toThrow();
    expect(await store.getDecision(decision.record_id)).toEqual(first);
    db.close();
  });

  test("keeps rejected records available for later review", async () => {
    const db = new Database(":memory:");
    const store = new RecordStore(db);
    await store.createSession(session);
    const service = new RecordService(store);

    await service.record(decision);
    const rejected = await service.setDisposition(decision.record_id, "rejected");
    expect(rejected.user_disposition).toBe("rejected");
    expect(await service.getDecision(decision.record_id)).toEqual(rejected);
    db.close();
  });
});
