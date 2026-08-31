import { describe, expect, test } from "bun:test";
import {
  ERROR_CODES,
  MAX_TEXT_FIELD_LENGTH,
  type DecisionRecordInput,
  type SnapshotDiffResponse,
  type UserDisposition,
  validateBranchList,
  validateDecisionRecordInput,
  validateRepositoryFiles,
  validateRevisionRef,
  validateReviewSession,
  validateSnapshotDiffResponse,
  validateSnapshotReference,
  parseSnapshotDiffResponse,
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

  test("accepts the cursor agent type", () => {
    const result = validateDecisionRecordInput(validInput({ agent_type: "cursor" }));
    expect(result.success).toBe(true);
    if (result.success) expect(result.data.agent_type).toBe("cursor");
    expect(validateReviewSession({
      session_id: "session-001",
      repository_id: "repo-001",
      agent_type: "cursor",
      started_at: "2026-08-20T00:00:00.000Z",
      status: "active",
    }).success).toBe(true);
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
  test.each(["C:..\\outside.ts", "C:../outside.ts", "./C:..\\outside.ts", "./C:../outside.ts"])("rejects drive-relative Windows path %s", (path) => {
    const result = validateDecisionRecordInput(
      validInput({
        targets: [
          {
            ...(baseInput().targets as Array<Record<string, unknown>>)[0],
            path,
          },
        ],
      }),
    );
    expect(result.success).toBe(false);
    if (!result.success) expect(result.error.code).toBe(ERROR_CODES.PATH_OUTSIDE_ROOT);
  });

  test("accepts valid ISO-8601 UTC timestamps with arbitrary fractional precision", () => {
    for (const createdAt of [
      "2026-08-20T00:00:00.1Z",
      "2026-08-20T00:00:00.12Z",
      "2026-08-20T00:00:00.1234Z",
      "2026-08-20T00:00:00.123456789Z",
    ]) {
      const result = validateDecisionRecordInput(validInput({ created_at: createdAt }));
      expect(result.success).toBe(true);
      if (result.success) expect(result.data.created_at).toBe(createdAt);
    }
  });

  test("rejects non-UTC, non-ISO, and invalid-calendar timestamps", () => {
    for (const createdAt of ["2026-08-20", "2026-08-20T00:00:00+09:00", "2026-02-31T00:00:00Z"]) {
      expect(validateDecisionRecordInput(validInput({ created_at: createdAt })).success).toBe(false);
    }
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

const gitSnapshotBase = {
  snapshot_id: "snapshot-git",
  record_id: "record-001",
  mode: "git" as const,
  path: "",
  content_hash: "b".repeat(64),
  created_at: "2026-08-20T00:00:00.000Z",
  base_sha: "a".repeat(40),
  source_path: "src/example.ts",
};

const automaticFileSnapshot = {
  snapshot_id: "snapshot-auto",
  record_id: "record-001",
  mode: "changed-files" as const,
  path: "snapshots/record-001/snapshot-auto.snapshot",
  content_hash: "b".repeat(64),
  created_at: "2026-08-27T00:00:00.000Z",
  source_path: "src/example.ts",
  capture_kind: "automatic" as const,
  before_missing: false,
};

test("accepts a git-backed snapshot reference", () => {
  const result = validateSnapshotReference(gitSnapshotBase);
  expect(result.success).toBe(true);
  if (result.success) {
    expect(result.data.mode).toBe("git");
    expect(result.data.path).toBe("");
    expect(result.data.base_sha).toBe("a".repeat(40));
    expect(result.data.source_path).toBe("src/example.ts");
  }
});

test("accepts an automatic file-backed snapshot reference", () => {
  const result = validateSnapshotReference(automaticFileSnapshot);
  expect(result.success).toBe(true);
  if (result.success) {
    expect(result.data.capture_kind).toBe("automatic");
    expect(result.data.source_path).toBe("src/example.ts");
    expect(result.data.before_missing).toBe(false);
  }
});

test("accepts an automatic missing-file snapshot reference", () => {
  const result = validateSnapshotReference({
    ...automaticFileSnapshot,
    before_missing: true,
  });
  expect(result.success).toBe(true);
});

test("requires before_missing for automatic git snapshots", () => {
  expect(validateSnapshotReference({ ...gitSnapshotBase, capture_kind: "automatic" }).success).toBe(false);
});

test.each([
  ["missing capture kind", { ...automaticFileSnapshot, capture_kind: undefined }],
  ["missing source path", { ...automaticFileSnapshot, source_path: undefined }],
  ["missing missing flag", { ...automaticFileSnapshot, before_missing: undefined }],
  ["non-boolean missing flag", { ...automaticFileSnapshot, before_missing: "false" }],
  ["escaping source path", { ...automaticFileSnapshot, source_path: "../outside.ts" }],
  ["manual file with source path", { ...automaticFileSnapshot, capture_kind: "manual", source_path: "src/example.ts" }],
])("rejects an invalid automatic snapshot: %s", (_label, value) => {
  expect(validateSnapshotReference(value).success).toBe(false);
});

test.each([
  ["missing base_sha", { ...gitSnapshotBase, base_sha: undefined }],
  ["uppercase sha", { ...gitSnapshotBase, base_sha: "A".repeat(40) }],
  ["short sha", { ...gitSnapshotBase, base_sha: "a".repeat(39) }],
  ["non-hex sha", { ...gitSnapshotBase, base_sha: `${"g".repeat(39)}a` }],
  ["missing source_path", { ...gitSnapshotBase, source_path: undefined }],
  ["escaping source_path", { ...gitSnapshotBase, source_path: "../outside.ts" }],
  ["non-empty storage path", { ...gitSnapshotBase, path: "snapshots/x.snapshot" }],
])("rejects an invalid git snapshot: %s", (_label, value) => {
  expect(validateSnapshotReference(value).success).toBe(false);
});

test("rejects base_sha on non-git snapshots and accepts automatic source_path", () => {
  expect(validateSnapshotReference({ ...automaticFileSnapshot, base_sha: "a".repeat(40) }).success).toBe(false);
  expect(validateSnapshotReference(automaticFileSnapshot).success).toBe(true);
});

test("keeps legacy manual file and git references valid", () => {
  expect(validateSnapshotReference({
    snapshot_id: "legacy-file",
    record_id: "record-001",
    mode: "patch",
    path: "snapshots/legacy.snapshot",
    content_hash: "b".repeat(64),
    created_at: "2026-08-27T00:00:00.000Z",
  }).success).toBe(true);
  expect(validateSnapshotReference(gitSnapshotBase).success).toBe(true);
});

test("accepts and discriminates transition responses", () => {
  const resolved: Extract<SnapshotDiffResponse, { state: "snapshot-resolved" }> = {
    state: "snapshot-resolved",
    path: "src/example.ts",
    from: {
      kind: "snapshot",
      snapshot_id: "before",
      record_id: "record-001",
      created_at: "2026-08-27T00:00:00.000Z",
      content_hash: "a".repeat(64),
      source_path: "src/example.ts",
    },
    to: { kind: "working-tree" },
    hunks: [],
    old_missing: false,
    new_missing: false,
    binary: false,
  };
  const result = validateSnapshotDiffResponse(resolved);
  expect(result.success).toBe(true);
  expect(parseSnapshotDiffResponse(resolved)).toEqual(resolved);
});

test("accepts diff lines longer than record text fields", () => {
  const resolved: Extract<SnapshotDiffResponse, { state: "snapshot-resolved" }> = {
    state: "snapshot-resolved",
    path: "src/example.ts",
    from: {
      kind: "snapshot",
      snapshot_id: "before",
      record_id: "record-001",
      created_at: "2026-08-27T00:00:00.000Z",
      content_hash: "a".repeat(64),
      source_path: "src/example.ts",
    },
    to: { kind: "working-tree" },
    hunks: [{ oldStart: 1, newStart: 1, lines: [{ type: "add", oldLine: null, newLine: 1, content: "x".repeat(12_000) }] }],
    old_missing: false,
    new_missing: false,
    binary: false,
  };

  expect(validateSnapshotDiffResponse(resolved).success).toBe(true);
  expect(parseSnapshotDiffResponse(resolved)).toEqual(resolved);
});

test("rejects empty hunks and binary responses with non-empty hunks", () => {
  const resolved: Extract<SnapshotDiffResponse, { state: "snapshot-resolved" }> = {
    state: "snapshot-resolved",
    path: "src/example.ts",
    from: {
      kind: "snapshot",
      snapshot_id: "before",
      record_id: "record-001",
      created_at: "2026-08-27T00:00:00.000Z",
      content_hash: "a".repeat(64),
      source_path: "src/example.ts",
    },
    to: { kind: "working-tree" },
    hunks: [{ oldStart: 1, newStart: 1, lines: [{ type: "context", oldLine: 1, newLine: 1, content: "one" }] }],
    old_missing: false,
    new_missing: false,
    binary: false,
  };

  expect(validateSnapshotDiffResponse({
    ...resolved,
    hunks: [{ ...resolved.hunks[0]!, lines: [] }],
  }).success).toBe(false);
  expect(validateSnapshotDiffResponse({ ...resolved, binary: true }).success).toBe(false);
  expect(validateSnapshotDiffResponse({ ...resolved, hunks: [], binary: true }).success).toBe(true);
  expect(validateSnapshotDiffResponse({ ...resolved, hunks: [], binary: false }).success).toBe(true);
});

test.each([
  ["an extra top-level field", (value: Extract<SnapshotDiffResponse, { state: "snapshot-resolved" }>) => ({ ...value, unexpected: true })],
  ["a malformed hunk line", (value: Extract<SnapshotDiffResponse, { state: "snapshot-resolved" }>) => ({
    ...value,
    hunks: [{ ...value.hunks[0]!, lines: [{ type: "add", oldLine: null, newLine: 1 }] }],
  })],
  ["a malformed snapshot endpoint", (value: Extract<SnapshotDiffResponse, { state: "snapshot-resolved" }>) => ({
    ...value,
    from: { ...value.from, source_path: "../outside.ts" },
  })],
  ["an extra working-tree endpoint field", (value: Extract<SnapshotDiffResponse, { state: "snapshot-resolved" }>) => ({
    ...value,
    to: { kind: "working-tree", source_path: value.path },
  })],
] as const)("rejects %s in a snapshot transition response", (_label, mutate) => {
  const value: Extract<SnapshotDiffResponse, { state: "snapshot-resolved" }> = {
    state: "snapshot-resolved",
    path: "src/example.ts",
    from: {
      kind: "snapshot",
      snapshot_id: "before",
      record_id: "record-001",
      created_at: "2026-08-27T00:00:00.000Z",
      content_hash: "a".repeat(64),
      source_path: "src/example.ts",
    },
    to: { kind: "working-tree" },
    hunks: [{ oldStart: 1, newStart: 1, lines: [{ type: "context", oldLine: 1, newLine: 1, content: "one" }] }],
    old_missing: false,
    new_missing: false,
    binary: false,
  };
  const result = validateSnapshotDiffResponse(mutate(value));
  expect(result.success).toBe(false);
  expect(() => parseSnapshotDiffResponse(mutate(value))).toThrow();
});

const shaA = "0123456789abcdef0123456789abcdef01234567";
const shaB = "89abcdef0123456789abcdef0123456789abcdef";

describe("branch list and repository files", () => {
  test("accepts a sorted local-branch list with a matching head_branch", () => {
    const result = validateBranchList({
      repository_id: "repo-1",
      head_branch: "main",
      branches: [
        { name: "feat/x", sha: shaA },
        { name: "main", sha: shaB },
      ],
    });
    expect(result.success).toBe(true);
  });

  test("accepts an unborn repository list", () => {
    const result = validateBranchList({
      repository_id: "repo-1",
      head_branch: null,
      branches: [],
    });
    expect(result.success).toBe(true);
  });

  test("rejects head_branch that is not in branches", () => {
    const result = validateBranchList({
      repository_id: "repo-1",
      head_branch: "missing",
      branches: [{ name: "main", sha: shaA }],
    });
    expect(result.success).toBe(false);
    if (!result.success) expect(result.error.code).toBe(ERROR_CODES.INVALID_RECORD);
  });

  test("rejects a remote-style extra field and a short sha", () => {
    expect(validateBranchList({
      repository_id: "repo-1",
      head_branch: null,
      branches: [{ name: "main", sha: shaA }],
      remotes: [],
    }).success).toBe(false);
    expect(validateBranchList({
      repository_id: "repo-1",
      head_branch: null,
      branches: [{ name: "main", sha: "abc" }],
    }).success).toBe(false);
  });

  test("accepts working-tree and local-branch files payloads", () => {
    expect(validateRepositoryFiles({
      repository_id: "repo-1",
      view: { kind: "working-tree" },
      paths: ["src/a.ts"],
    }).success).toBe(true);
    expect(validateRepositoryFiles({
      repository_id: "repo-1",
      view: { kind: "local-branch", name: "feat/x", sha: shaA },
      paths: ["src/a.ts"],
    }).success).toBe(true);
  });

  test("rejects a files payload without view", () => {
    const result = validateRepositoryFiles({
      repository_id: "repo-1",
      paths: ["src/a.ts"],
    });
    expect(result.success).toBe(false);
  });
});
