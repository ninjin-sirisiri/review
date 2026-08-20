import { describe, expect, test } from "bun:test";
import { Readable } from "node:stream";
import type { DecisionRecordInput } from "../../../packages/contracts/src/index";
import { mapHostEvent, runAdapter, type HostDecisionEvent, type SubmitResult } from "../../common/src/adapter-contract";

const event: HostDecisionEvent = {
  sessionId: "shared-session",
  repositoryRoot: "/tmp/shared-repository",
  revision: { kind: "working-tree", contentHash: "a".repeat(64) },
  targets: [{
    path: "src/change.ts",
    lineStart: 3,
    lineEnd: 7,
    revision: { kind: "working-tree", contentHash: "a".repeat(64) },
    contentHash: "b".repeat(64),
  }],
  judgment: "safe",
  rationale: "checked the changed branch",
  checks: [],
  openQuestions: [],
  recordId: "shared-record",
  createdAt: "2026-08-20T00:00:00.000Z",
};

test("Codex maps host events to the same canonical fields with its agent type", () => {
  const record = mapHostEvent("codex", event);
  expect(record.agent_type).toBe("codex");
  expect(record.session_id).toBe(event.sessionId);
  expect(record.targets[0]?.path).toBe("src/change.ts");
  expect(record.targets[0]).not.toHaveProperty("transcript");
});

test("Codex emits one result for one malformed event", async () => {
  const outputs: string[] = [];
  const bridge = {
    submit: async (record: DecisionRecordInput): Promise<SubmitResult> => ({
      success: true,
      status: 201,
      duplicate: false,
      recordId: record.record_id,
    }),
  };
  await runAdapter("codex", Readable.from('{"sessionId":\n'), { write: (value: string) => { outputs.push(value); return true; } }, bridge);
  expect(outputs).toHaveLength(1);
  expect(JSON.parse(outputs[0] ?? "").success).toBe(false);
});
