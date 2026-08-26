import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeEach, expect, test } from "bun:test";
import { grantDecisionPermits, normalizeDecisionProposal } from "../../common/src/decision-gate";
import type { AdapterBridge, SubmitResult } from "../../common/src/adapter-contract";
import type { RecorderSetupClient } from "../../common/src/recorder-setup";
import { checkPostToolUse, checkPreToolUse, handleSessionStart, recordDecision } from "../src/gate-command";

const GATED_ENV_KEYS = ["AI_REVIEW_SESSION_ID", "AI_REVIEW_REPOSITORY_ROOT", "AI_REVIEW_AGENT_TYPE", "AI_REVIEW_GATE_ROOT"];
const preservedEnv: Record<string, string | undefined> = {};

beforeEach(() => {
  for (const key of GATED_ENV_KEYS) {
    preservedEnv[key] = process.env[key];
    delete process.env[key];
  }
});

afterAll(() => {
  for (const [key, value] of Object.entries(preservedEnv)) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
});

async function fixture(): Promise<{ root: string; file: string; gateRoot: string }> {
  const root = await mkdtemp(join(tmpdir(), "ai-review-hook-"));
  const file = join(root, "src", "change.ts");
  await Bun.write(file, "export const value = 1;\n");
  return { root, file, gateRoot: join(root, "gate-state") };
}

test("PreToolUse denies an Edit without a matching recorded judgment", async () => {
  const current = await fixture();
  const decision = await checkPreToolUse({
    session_id: "session-denied",
    cwd: current.root,
    tool_name: "Edit",
    tool_input: { file_path: current.file, old_string: "1", new_string: "2" },
  }, { gateRoot: current.gateRoot });

  expect(decision?.hookSpecificOutput.permissionDecision).toBe("deny");
  expect(decision?.hookSpecificOutput.permissionDecisionReason).toContain('"targets":[{"path":');
  expect(decision?.hookSpecificOutput.permissionDecisionReason).toContain("127.0.0.1:4318");
});

test("PreToolUse peeks and PostToolUse consumes so only a completed edit spends the permit", async () => {
  const current = await fixture();
  const event = await normalizeDecisionProposal({
    repositoryRoot: current.root,
    targets: [{ path: "src/change.ts", lineStart: 1, lineEnd: 1 }],
    judgment: "the change preserves the invariant",
    rationale: "the focused branch keeps the existing guard",
  }, { sessionId: "session-allowed" });
  await grantDecisionPermits(event, { recordId: "record-allowed", gateRoot: current.gateRoot });
  const editInput = {
    session_id: "session-allowed",
    cwd: current.root,
    tool_name: "Edit",
    tool_input: { file_path: current.file, old_string: "1", new_string: "2" },
  };

  expect(await checkPreToolUse(editInput, { gateRoot: current.gateRoot })).toBeNull();

  await checkPostToolUse(editInput, { gateRoot: current.gateRoot });
  expect((await checkPreToolUse(editInput, { gateRoot: current.gateRoot }))?.hookSpecificOutput.permissionDecision).toBe("deny");
});

test("a denial by another hook leaves the permit intact until an edit actually succeeds", async () => {
  const current = await fixture();
  const event = await normalizeDecisionProposal({
    repositoryRoot: current.root,
    targets: [{ path: "src/change.ts", lineStart: 1, lineEnd: 1 }],
    judgment: "the change preserves the invariant",
    rationale: "the focused branch keeps the existing guard",
  }, { sessionId: "session-external-deny" });
  await grantDecisionPermits(event, { recordId: "record-external-deny", gateRoot: current.gateRoot });
  const editInput = {
    session_id: "session-external-deny",
    cwd: current.root,
    tool_name: "Edit",
    tool_input: { file_path: current.file, old_string: "1", new_string: "2" },
  };

  expect(await checkPreToolUse(editInput, { gateRoot: current.gateRoot })).toBeNull();
  expect(await checkPreToolUse(editInput, { gateRoot: current.gateRoot })).toBeNull();

  await checkPostToolUse(editInput, { gateRoot: current.gateRoot });
  expect((await checkPreToolUse(editInput, { gateRoot: current.gateRoot }))?.hookSpecificOutput.permissionDecision).toBe("deny");
});

test("PreToolUse blocks shell mutation paths so agents cannot bypass the file gate", async () => {
  const current = await fixture();
  const decision = await checkPreToolUse({
    session_id: "session-shell",
    cwd: current.root,
    tool_name: "Bash",
    tool_input: { command: "sed -i 's/value = 1/value = 2/' src/change.ts" },
  }, { gateRoot: current.gateRoot });

  expect(decision?.hookSpecificOutput.permissionDecision).toBe("deny");
});

test("recordDecision grants the edit permit only after Recorder submission succeeds", async () => {
  const current = await fixture();
  let submitted = false;
  const bridge: AdapterBridge = {
    submit: async (record): Promise<SubmitResult> => {
      submitted = true;
      return { success: true, status: 201, duplicate: false, recordId: record.record_id };
    },
  };
  const result = await recordDecision({
    repositoryRoot: current.root,
    targets: [{ path: "src/change.ts", lineStart: 1, lineEnd: 1 }],
    judgment: "the change preserves the invariant",
    rationale: "the focused branch keeps the existing guard",
  }, { sessionId: "session-record", bridge, gateRoot: current.gateRoot });

  expect(submitted).toBe(true);
  expect(result.success).toBe(true);
  expect(await checkPreToolUse({
    session_id: "session-record",
    cwd: current.root,
    tool_name: "Edit",
    tool_input: { file_path: current.file, old_string: "1", new_string: "2" },
  }, { gateRoot: current.gateRoot })).toBeNull();
});

test("SessionStart registers the canonical repository and session before persisting environment", async () => {
  const current = await fixture();
  const envFile = join(current.root, "session.env");
  const calls: Array<{ root: string; session: Record<string, unknown> }> = [];
  const setupClient = {
    ensureSession: async (root: string, session: Record<string, unknown>) => {
      calls.push({ root, session });
      return { repository: { repository_id: "repository-setup", root, created_at: "2026-08-21T00:00:00.000Z" }, session };
    },
  } as unknown as Pick<RecorderSetupClient, "ensureSession">;

  await handleSessionStart({ session_id: "session-start", cwd: current.root }, { setupClient, envFile });

  expect(calls).toHaveLength(1);
  expect(calls[0]?.session).toMatchObject({ session_id: "session-start", repository_id: expect.any(String), agent_type: "claude-code", status: "active" });
  expect(await readFile(envFile, "utf8")).toContain("AI_REVIEW_SESSION_ID='session-start'");
});

test("SessionStart persists environment even when Recorder auto-registration fails", async () => {
  const current = await fixture();
  const envFile = join(current.root, "session.env");
  const setupClient = {
    ensureSession: async () => { throw new Error("Recorder unavailable"); },
  } as unknown as Pick<RecorderSetupClient, "ensureSession">;

  let failed = false;
  try {
    await handleSessionStart({ session_id: "session-warning", cwd: current.root }, { setupClient, envFile });
  } catch {
    failed = true;
  }

  expect(failed).toBe(true);
  expect(await readFile(envFile, "utf8")).toContain("AI_REVIEW_SESSION_ID='session-warning'");
});
