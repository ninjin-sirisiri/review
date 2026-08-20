import { describe, expect, test } from "bun:test";
import {
  ERROR_CODES,
  MAX_TEXT_FIELD_LENGTH,
  type DecisionRecordInput,
  type UserDisposition,
  validateDecisionRecordInput,
  validateRevisionRef,
  validateReviewSession,
  validateSnapshotReference,
} from "../src/index";

const claudeFixturePath = new URL("./fixtures/claude-code.json", import.meta.url);
const codexFixturePath = new URL("./fixtures/codex.json", import.meta.url);

test("Claude Code and Codex fixtures serialize to the same source-free input shape", async () => {
  const [claudeFixture, codexFixture] = await Promise.all([
    Bun.file(claudeFixturePath).json(),
    Bun.file(codexFixturePath).json(),
  ]);
  const claudeResult = validateDecisionRecordInput(claudeFixture);
  const codexResult = validateDecisionRecordInput(codexFixture);

  expect(claudeResult.success).toBe(true);
  expect(codexResult.success).toBe(true);
  if (!claudeResult.success || !codexResult.success) return;

  expect(Object.keys(claudeResult.data).sort()).toEqual(Object.keys(codexResult.data).sort());
  expect(Object.keys(claudeResult.data.targets[0] ?? {}).sort()).toEqual(
    Object.keys(codexResult.data.targets[0] ?? {}).sort(),
  );
  expect(JSON.stringify(claudeFixture)).not.toMatch(/source[_-]?code|transcript|conversation/i);
  expect(JSON.stringify(codexFixture)).not.toMatch(/source[_-]?code|transcript|conversation/i);
});

const baseInput = (): Record<string, unknown> => ({
  record_id: "record-001",
  session_id: "session-001",
  repository_id: "repo-001",
  agent_type: "claude-code",
  revision: { kind: "commit", sha: "a".repeat(40) },
  targets: [
    {
      repository_id: "repo-001",
      path: "src/review.ts",
      line_start: 2,
      line_end: 4,
      revision: { kind: "commit", sha: "a".repeat(40) },
      content_hash: "b".repeat(64),
    },
  ],
  judgment: "The change preserves the existing behavior.",
  rationale: "The guarded branch remains unchanged.",
  checks: [{ name: "focused tests", status: "passed", details: "All checks passed." }],
  open_questions: ["Should the integration test be expanded later?"],
  created_at: "2026-08-20T00:00:00.000Z",
});

function validInput(overrides: Record<string, unknown> = {}): DecisionRecordInput {
  return { ...baseInput(), ...overrides } as unknown as DecisionRecordInput;
}

describe("revision references", () => {
  test("accepts commit references", () => {
    const result = validateRevisionRef({ kind: "commit", sha: "a".repeat(40) });
    expect(result.success).toBe(true);
  });

  test("accepts working-tree references", () => {
    const result = validateRevisionRef({ kind: "working-tree", contentHash: "b".repeat(64) });
    expect(result.success).toBe(true);
  });

  test.each([
    { kind: "commit", sha: "a".repeat(40), contentHash: "b".repeat(64) },
    { kind: "working-tree", contentHash: "b".repeat(64), sha: "a".repeat(40) },
  ])("rejects extra fields on discriminated revisions", (revision) => {
    const result = validateRevisionRef(revision);
    expect(result.success).toBe(false);
  });
});

test("rejects inherited enum-like values across contract parsers", () => {
  const inputWithInheritedAgent = validInput({ agent_type: "toString" });
  const inputWithInheritedDisposition = validInput({ user_disposition: "constructor" });
  const inputWithInheritedCheckStatus = validInput({
    checks: [{ name: "tests", status: "toString" }],
  });
  const sessionWithInheritedStatus = {
    session_id: "session-001",
    repository_id: "repo-001",
    agent_type: "toString",
    started_at: "2026-08-20T00:00:00.000Z",
    status: "constructor",
  };
  const snapshotWithInheritedMode = {
    snapshot_id: "snapshot-001",
    record_id: "record-001",
    mode: "toString",
    path: "patch.diff",
    content_hash: "b".repeat(64),
    created_at: "2026-08-20T00:00:00.000Z",
  };

  expect(validateDecisionRecordInput(inputWithInheritedAgent).success).toBe(false);
  expect(validateDecisionRecordInput(inputWithInheritedDisposition).success).toBe(false);
  expect(validateDecisionRecordInput(inputWithInheritedCheckStatus).success).toBe(false);
  expect(validateReviewSession(sessionWithInheritedStatus).success).toBe(false);
  expect(validateSnapshotReference(snapshotWithInheritedMode).success).toBe(false);
});

describe("decision input validation", () => {
  test.each(["unreviewed", "accepted", "rejected"])("accepts %s disposition", (disposition: UserDisposition) => {
    const result = validateDecisionRecordInput(validInput({ user_disposition: disposition }));
    expect(result.success).toBe(true);
    if (result.success) expect(result.data.user_disposition).toBe(disposition);
  });

  test("rejects a missing required field with INVALID_RECORD", () => {
    const input = validInput();
    delete (input as unknown as Record<string, unknown>).record_id;
    const result = validateDecisionRecordInput(input);
    expect(result.success).toBe(false);
    if (!result.success) expect(result.error.code).toBe(ERROR_CODES.INVALID_RECORD);
  });

  test("requires a client-generated record_id", () => {
    const result = validateDecisionRecordInput(validInput({ record_id: "" }));
    expect(result.success).toBe(false);
    if (!result.success) expect(result.error.code).toBe(ERROR_CODES.INVALID_RECORD);
  });

  test("normalizes separators and rejects absolute target paths", () => {
    const normalized = validateDecisionRecordInput(
      validInput({
        targets: [
          {
            ...(baseInput().targets as Array<Record<string, unknown>>)[0],
            path: "src\\review.ts",
          },
        ],
      }),
    );
    expect(normalized.success).toBe(true);
    if (normalized.success) expect(normalized.data.targets[0]?.path).toBe("src/review.ts");

    const absolute = validateDecisionRecordInput(
      validInput({
        targets: [
          {
            ...(baseInput().targets as Array<Record<string, unknown>>)[0],
            path: "/etc/passwd",
          },
        ],
      }),
    );
    expect(absolute.success).toBe(false);
    if (!absolute.success) expect(absolute.error.code).toBe(ERROR_CODES.PATH_OUTSIDE_ROOT);
  });
  test("rejects drive-relative Windows paths", () => {
    const result = validateDecisionRecordInput(
      validInput({
        targets: [
          {
            ...(baseInput().targets as Array<Record<string, unknown>>)[0],
            path: "C:..\\outside.ts",
          },
        ],
      }),
    );
    expect(result.success).toBe(false);
    if (!result.success) expect(result.error.code).toBe(ERROR_CODES.PATH_OUTSIDE_ROOT);
  });

  test("rejects non-UTC and non-ISO timestamps", () => {
    const dateOnly = validateDecisionRecordInput(validInput({ created_at: "2026-08-20" }));
    const localTime = validateDecisionRecordInput(validInput({ created_at: "2026-08-20T00:00:00+09:00" }));
    expect(dateOnly.success).toBe(false);
    expect(localTime.success).toBe(false);
  });

  test("rejects invalid line ranges", () => {
    const result = validateDecisionRecordInput(
      validInput({
        targets: [
          {
            ...(baseInput().targets as Array<Record<string, unknown>>)[0],
            line_start: 0,
            line_end: 2,
          },
        ],
      }),
    );
    expect(result.success).toBe(false);
    if (!result.success) expect(result.error.code).toBe(ERROR_CODES.INVALID_RECORD);
  });

  test("rejects oversized text fields with PAYLOAD_TOO_LARGE", () => {
    const result = validateDecisionRecordInput(
      validInput({ judgment: "x".repeat(MAX_TEXT_FIELD_LENGTH + 1) }),
    );
    expect(result.success).toBe(false);
    if (!result.success) expect(result.error.code).toBe(ERROR_CODES.PAYLOAD_TOO_LARGE);
  });

  test("rejects source bodies and transcript fields", () => {
    const result = validateDecisionRecordInput(
      validInput({ source_code: "const secret = true;", transcript: "full conversation" }),
    );
    expect(result.success).toBe(false);
    if (!result.success) expect(result.error.code).toBe(ERROR_CODES.INVALID_RECORD);
  });
});
