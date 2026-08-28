import { mkdtemp, realpath, writeFile } from "node:fs/promises";
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
import { grantDecisionPermits, normalizeDecisionProposal, type AutomaticSnapshotBridge } from "../../common/src/decision-gate";

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

function context(current: { root: string; gateRoot: string }, sessionId = "session-opencode", snapshotBridge?: AutomaticSnapshotBridge): GateContext {
  return {
    sessionId,
    repositoryRoot: current.root,
    gateRoot: current.gateRoot,
    ...(snapshotBridge === undefined ? {} : { snapshotBridge }),
  };
}

function successfulSnapshotBridge(captures: Array<Record<string, unknown>>): AutomaticSnapshotBridge {
  return {
    captureAutomaticSnapshot: async (input) => {
      captures.push(input);
      return { success: true, status: 201, duplicate: false, recordId: input.recordId };
    },
  };
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

  expect(await gateToolUse(call, context(current, "session-allowed", successfulSnapshotBridge([])))).toBeNull();
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
  expect(await gateToolUse({ tool: "edit", args: { filePath: current.file } }, context(current, "session-record", successfulSnapshotBridge([])))).toBeNull();
});

test("edit capture receives the matching permit state and reuses its capture ID", async () => {
  const current = await fixture();
  const event = await normalizeDecisionProposal({
    repositoryRoot: current.root,
    targets: [{ path: "src/change.ts", lineStart: 1 }],
    judgment: "safe",
    rationale: "checked",
  }, { sessionId: "session-capture" });
  await grantDecisionPermits(event, { recordId: "record-capture", gateRoot: current.gateRoot });
  const captures: Array<Record<string, unknown>> = [];
  const bridge = successfulSnapshotBridge(captures);
  const call = { tool: "edit", args: { filePath: current.file } };

  expect(await gateToolUse(call, context(current, "session-capture", bridge))).toBeNull();
  expect(await gateToolUse(call, context(current, "session-capture", bridge))).toBeNull();
  expect(captures).toHaveLength(2);
  expect(captures[0]).toMatchObject({
    recordId: "record-capture",
    sourcePath: "src/change.ts",
    content: "export const value = 1;\n",
    beforeMissing: false,
  });
  expect(captures[1]?.captureId).toBe(captures[0]?.captureId);
});

test("edit is denied when the target changed after the permit was issued", async () => {
  const current = await fixture();
  const event = await normalizeDecisionProposal({
    repositoryRoot: current.root,
    targets: [{ path: "src/change.ts", lineStart: 1 }],
    judgment: "safe",
    rationale: "checked",
  }, { sessionId: "session-hash-mismatch" });
  await grantDecisionPermits(event, { recordId: "record-hash-mismatch", gateRoot: current.gateRoot });
  await writeFile(current.file, "export const value = 2;\n", "utf8");
  const captures: Array<Record<string, unknown>> = [];

  const reason = await gateToolUse({ tool: "edit", args: { filePath: current.file } }, context(current, "session-hash-mismatch", successfulSnapshotBridge(captures)));

  expect(reason).not.toBeNull();
  expect(captures).toHaveLength(0);
});

test("a failed automatic capture denies the edit without consuming its permit", async () => {
  const current = await fixture();
  const event = await normalizeDecisionProposal({
    repositoryRoot: current.root,
    targets: [{ path: "src/change.ts", lineStart: 1 }],
    judgment: "safe",
    rationale: "checked",
  }, { sessionId: "session-capture-failure" });
  await grantDecisionPermits(event, { recordId: "record-capture-failure", gateRoot: current.gateRoot });
  const call = { tool: "edit", args: { filePath: current.file } };
  const failedBridge: AutomaticSnapshotBridge = {
    captureAutomaticSnapshot: async (input) => ({
      success: false,
      code: "HASH_MISMATCH",
      message: "content changed before capture",
      error: "content changed before capture",
      recordId: input.recordId,
      attempts: 1,
    }),
  };

  expect(await gateToolUse(call, context(current, "session-capture-failure", failedBridge))).toContain("Automatic snapshot failed before edit: content changed before capture");
  expect(await gateToolUse(call, context(current, "session-capture-failure", successfulSnapshotBridge([])))).toBeNull();
  await gateToolUseAfter(call, context(current, "session-capture-failure"));
  expect(await gateToolUse(call, context(current, "session-capture-failure", successfulSnapshotBridge([])))).not.toBeNull();
});

test("gateToolUseAfter consumes a permit even when the edited file no longer matches its pre-edit hash", async () => {
  const current = await fixture();
  const event = await normalizeDecisionProposal({
    repositoryRoot: current.root,
    targets: [{ path: "src/change.ts", lineStart: 1 }],
    judgment: "safe",
    rationale: "checked",
  }, { sessionId: "session-post-change" });
  await grantDecisionPermits(event, { recordId: "record-post-change", gateRoot: current.gateRoot });
  const call = { tool: "edit", args: { filePath: current.file } };

  expect(await gateToolUse(call, context(current, "session-post-change", successfulSnapshotBridge([])))).toBeNull();
  await writeFile(current.file, "export const value = 2;\n", "utf8");
  await gateToolUseAfter(call, context(current, "session-post-change"));
  await writeFile(current.file, "export const value = 1;\n", "utf8");

  expect(await gateToolUse(call, context(current, "session-post-change", successfulSnapshotBridge([])))).not.toBeNull();
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

test("recordDecision rejects a conflicting duplicate without granting a permit", async () => {
  const current = await fixture();
  const bridge: AdapterBridge = {
    submit: async (): Promise<SubmitResult> => ({
      success: false,
      code: "DUPLICATE_RECORD",
      message: "record_id already contains a different judgment",
      error: "record_id already contains a different judgment",
      recordId: "record-conflict",
      attempts: 1,
      status: 409,
    }),
  };
  const result = await recordDecision({
    repositoryRoot: current.root,
    targets: [{ path: "src/change.ts", lineStart: 1 }],
    judgment: "conflicting",
    rationale: "must not be accepted",
  }, { ...context(current, "session-conflict"), bridge });

  expect(result).toMatchObject({ success: false, code: "DUPLICATE_RECORD", status: 409 });
  expect(await gateToolUse({ tool: "edit", args: { filePath: current.file } }, context(current, "session-conflict"))).not.toBeNull();
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
