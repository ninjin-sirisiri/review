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
  createdAt: "2026-08-29T00:00:00.000Z",
};

test("Cursor maps host events to the same canonical fields with its agent type", () => {
  const record = mapHostEvent("cursor", event);
  expect(record.agent_type).toBe("cursor");
  expect(record.session_id).toBe(event.sessionId);
  expect(record.targets[0]?.path).toBe("src/change.ts");
  expect(record.targets[0]).not.toHaveProperty("transcript");
});

describe("stdin adapter", () => {
  test("emits one success result per submitted event", async () => {
    const outputs: string[] = [];
    const bridge = {
      submit: async (record: DecisionRecordInput): Promise<SubmitResult> => ({
        success: true,
        status: 201,
        duplicate: false,
        recordId: record.record_id,
      }),
    };
    await runAdapter("cursor", Readable.from(`${JSON.stringify(event)}\n`), { write: (value: string) => { outputs.push(value); return true; } }, bridge);
    expect(outputs).toHaveLength(1);
    const parsed = JSON.parse(outputs[0] ?? "") as SubmitResult;
    expect(parsed.success).toBe(true);
  });

  test("emits one failure for one malformed event", async () => {
    const outputs: string[] = [];
    await runAdapter("cursor", Readable.from('{"sessionId":\n'), { write: (value: string) => { outputs.push(value); return true; } });
    expect(outputs).toHaveLength(1);
    expect(JSON.parse(outputs[0] ?? "").success).toBe(false);
  });
});
