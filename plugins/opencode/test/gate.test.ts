import { mkdtemp, realpath } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { beforeEach, expect, test } from "bun:test";
import {
  gateToolUse,
  gateToolUseAfter,
  recordDecision,
  registerSession,
  AGENT_TYPE,
  type GateContext,
} from "../src/gate";
import type { AdapterBridge, SubmitResult } from "../../common/src/adapter-contract";
import type { RecorderSetupClient } from "../../common/src/recorder-setup";
import { grantDecisionPermits, normalizeDecisionProposal } from "../../common/src/decision-gate";

const GATED_ENV_KEYS = ["AI_REVIEW_SESSION_ID", "AI_REVIEW_REPOSITORY_ROOT", "AI_REVIEW_AGENT_TYPE", "AI_REVIEW_GATE_ROOT"];
const preservedEnv: Record<string, string | undefined> = {};

beforeEach(() => {
  for (const key of GATED_ENV_KEYS) {
    preservedEnv[key] = process.env[key];
    delete process.env[key];
  }
});

async function fixture(): Promise<{ root: string; file: string; gateRoot: string }> {
  const root = await realpath(await mkdtemp(join(tmpdir(), "ai-review-opencode-")));
  const file = join(root, "src", "change.ts");
  await Bun.write(file, "export const value = 1;\n");
  return { root, file, gateRoot: join(root, "gate-state") };
}

function context(current: { root: string; gateRoot: string }, sessionId = "session-opencode"): GateContext {
  return { sessionId, repositoryRoot: current.root, gateRoot: current.gateRoot };
}

test("edit is denied while no matching judgment permit exists", async () => {
  const current = await fixture();
  const reason = await gateToolUse(
    { tool: "edit", args: { filePath: current.file, oldString: "1", newString: "2" } },
    context(current),
  );
  expect(reason).toContain("blocked");
  expect(reason).toContain("review_record_judgment");
});

test("write and patch tools are gated through the same permit check", async () => {
  const current = await fixture();
  expect(await gateToolUse({ tool: "write", args: { filePath: current.file, content: "x" } }, context(current))).not.toBeNull();
  expect(await gateToolUse({ tool: "patch", args: { path: current.file } }, context(current))).not.toBeNull();
});

test("one recorded judgment allows exactly one completed edit", async () => {
  const current = await fixture();
  const event = await normalizeDecisionProposal({
    repositoryRoot: current.root,
    targets: [{ path: "src/change.ts", lineStart: 1, lineEnd: 1 }],
    judgment: "the change preserves the invariant",
    rationale: "the focused branch keeps the existing guard",
  }, { sessionId: "session-allowed" });
  await grantDecisionPermits(event, { recordId: "record-allowed", gateRoot: current.gateRoot });
  const call = { tool: "edit", args: { filePath: current.file } };

  expect(await gateToolUse(call, context(current, "session-allowed"))).toBeNull();
  await gateToolUseAfter(call, context(current, "session-allowed"));
  expect(await gateToolUse(call, context(current, "session-allowed"))).not.toBeNull();
});

test("permits do not cross sessions", async () => {
  const current = await fixture();
  const event = await normalizeDecisionProposal({
    repositoryRoot: current.root,
    targets: [{ path: "src/change.ts", lineStart: 1 }],
    judgment: "safe",
    rationale: "checked",
  }, { sessionId: "session-owner" });
  await grantDecisionPermits(event, { recordId: "record-owner", gateRoot: current.gateRoot });
  expect(await gateToolUse({ tool: "edit", args: { filePath: current.file } }, context(current, "session-other"))).not.toBeNull();
});

test("shell mutations are blocked without consuming any permit path", async () => {
  const current = await fixture();
  const reason = await gateToolUse({ tool: "bash", args: { command: "sed -i 's/value = 1/value = 2/' src/change.ts" } }, context(current));
  expect(reason).toContain("Shell command blocked");
  expect(await gateToolUse({ tool: "bash", args: { command: "bun run test" } }, context(current))).toBeNull();
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
  }, { ...context(current, "session-record"), bridge });

  expect(submitted).toBe(true);
  expect(result.success).toBe(true);
  expect(result.permits).toBe(1);
  expect(await gateToolUse({ tool: "edit", args: { filePath: current.file } }, context(current, "session-record"))).toBeNull();
});

test("recordDecision reports Recorder failures without granting permits", async () => {
  const current = await fixture();
  const bridge: AdapterBridge = {
    submit: async (): Promise<SubmitResult> => ({ success: false, code: "RECORDER_UNAVAILABLE", message: "down", error: "down", recordId: "", attempts: 3 }),
  };
  const result = await recordDecision({
    repositoryRoot: current.root,
    targets: [{ path: "src/change.ts", lineStart: 1 }],
    judgment: "safe",
    rationale: "checked",
  }, { ...context(current, "session-failed"), bridge });

  expect(result.success).toBe(false);
  expect(result.code).toBe("RECORDER_UNAVAILABLE");
  expect(await gateToolUse({ tool: "edit", args: { filePath: current.file } }, context(current, "session-failed"))).not.toBeNull();
});

test("registerSession registers an opencode session against the canonical repository root", async () => {
  const current = await fixture();
  const calls: Array<{ root: string; session: Record<string, unknown> }> = [];
  const setupClient = {
    ensureSession: async (root: string, session: Record<string, unknown>) => {
      calls.push({ root, session });
      return { repository: { repository_id: "repository-opencode", root, created_at: "2026-08-24T00:00:00.000Z" }, session };
    },
  } as unknown as Pick<RecorderSetupClient, "ensureSession">;

  const registered = await registerSession("ses_opencode-001", current.root, { setupClient });

  expect(calls).toHaveLength(1);
  expect(calls[0]?.session).toMatchObject({ session_id: "ses_opencode-001", agent_type: AGENT_TYPE, status: "active" });
  expect(registered.registration.agent_type).toBe("opencode");
  expect(registered.repositoryRoot).toBe(current.root);
});
