import { createHash } from "node:crypto";
import { mkdtemp, realpath, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeEach, expect, test } from "bun:test";
import { grantDecisionPermits, normalizeDecisionProposal, type AutomaticSnapshotBridge } from "../../common/src/decision-gate";
import type { AdapterBridge, SubmitResult } from "../../common/src/adapter-contract";
import type { RecorderSetupClient } from "../../common/src/recorder-setup";
import type { ReviewSession } from "../../../packages/contracts/src/index";
import {
  AGENT_TYPE,
  checkPostToolUse,
  checkPreToolUse,
  handleSessionStart,
  readBoundedStdin,
  recordDecision,
  sessionStartOutput,
} from "../src/gate";

function passingSetupClient(): Pick<RecorderSetupClient, "ensureSession"> {
  return {
    ensureSession: async (root: string, session: ReviewSession) => ({
      repository: { repository_id: "repository-setup", root, created_at: "2026-08-29T00:00:00.000Z" },
      session,
    }),
  } as unknown as Pick<RecorderSetupClient, "ensureSession">;
}

function repositoryIdFor(root: string): string {
  return createHash("sha256").update(root, "utf8").digest("hex");
}

const GATED_ENV_KEYS = [
  "AI_REVIEW_SESSION_ID",
  "AI_REVIEW_REPOSITORY_ROOT",
  "AI_REVIEW_AGENT_TYPE",
  "AI_REVIEW_GATE_ROOT",
  "AI_REVIEW_CURSOR_SESSION_ROOT",
  "CURSOR_PROJECT_DIR",
  "CURSOR_PLUGIN_ROOT",
];
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

test("bounds hook stdin by raw bytes and cancels an oversized stream", async () => {
  let pulls = 0;
  let cancelled = false;
  const stream = new ReadableStream<Uint8Array>({
    pull(controller) {
      pulls += 1;
      if (pulls === 1) controller.enqueue(Uint8Array.from([0x7b, 0x22]));
      else controller.enqueue(Uint8Array.from([0x78, 0x7d]));
    },
    cancel() {
      cancelled = true;
    },
  });

  await expect(readBoundedStdin(stream, 3)).rejects.toThrow("hook input exceeds the command limit");
  expect(cancelled).toBe(true);
  expect(pulls).toBe(2);
});

async function fixture(): Promise<{ root: string; file: string; gateRoot: string; sessionStoreRoot: string }> {
  const root = await realpath(await mkdtemp(join(tmpdir(), "ai-review-cursor-")));
  const file = join(root, "src", "change.ts");
  await Bun.write(file, "export const value = 1;\n");
  return { root, file, gateRoot: join(root, "gate-state"), sessionStoreRoot: join(root, "cursor-sessions") };
}

function successfulSnapshotBridge(captures: Array<Record<string, unknown>>): AutomaticSnapshotBridge {
  return {
    captureAutomaticSnapshot: async (input) => {
      captures.push(input);
      return { success: true, status: 201, duplicate: false, recordId: input.recordId };
    },
  };
}

test("preToolUse denies a Write without a matching recorded judgment", async () => {
  const current = await fixture();
  const decision = await checkPreToolUse({
    conversation_id: "session-denied",
    cwd: current.root,
    tool_name: "Write",
    tool_input: { path: current.file, contents: "export const value = 2;\n" },
  }, { gateRoot: current.gateRoot });

  expect(decision?.permission).toBe("deny");
  expect(decision?.agent_message).toContain("review_record_judgment");
  expect(decision?.agent_message).toContain("127.0.0.1:4318");
});

test("StrReplace, ApplyPatch, and Delete are gated through the same permit check", async () => {
  const current = await fixture();
  const options = { gateRoot: current.gateRoot };
  const session = { conversation_id: "session-tools", cwd: current.root };
  expect((await checkPreToolUse({ ...session, tool_name: "StrReplace", tool_input: { path: current.file, old_string: "1", new_string: "2" } }, options))?.permission).toBe("deny");
  expect((await checkPreToolUse({
    ...session,
    tool_name: "ApplyPatch",
    tool_input: { patch: `*** Begin Patch\n*** Update File: ${current.file}\n@@\n-export const value = 1;\n+export const value = 2;\n*** End Patch\n` },
  }, options))?.permission).toBe("deny");
  expect((await checkPreToolUse({ ...session, tool_name: "Delete", tool_input: { path: current.file } }, options))?.permission).toBe("deny");
});

test("preToolUse peeks and postToolUse consumes so only a completed edit spends the permit", async () => {
  const current = await fixture();
  const event = await normalizeDecisionProposal({
    repositoryRoot: current.root,
    targets: [{ path: "src/change.ts", lineStart: 1, lineEnd: 1 }],
    judgment: "the change preserves the invariant",
    rationale: "the focused branch keeps the existing guard",
  }, { sessionId: "session-allowed" });
  await grantDecisionPermits(event, { recordId: "record-allowed", gateRoot: current.gateRoot });
  const editInput = {
    conversation_id: "session-allowed",
    cwd: current.root,
    tool_name: "StrReplace",
    tool_input: { path: current.file, old_string: "1", new_string: "2" },
  };

  expect(await checkPreToolUse(editInput, { gateRoot: current.gateRoot, bridge: successfulSnapshotBridge([]) })).toBeNull();
  await checkPostToolUse(editInput, { gateRoot: current.gateRoot });
  expect((await checkPreToolUse(editInput, { gateRoot: current.gateRoot }))?.permission).toBe("deny");
});

test("beforeShellExecution blocks mutation paths so agents cannot bypass the file gate", async () => {
  const current = await fixture();
  const decision = await checkPreToolUse({
    hook_event_name: "beforeShellExecution",
    conversation_id: "session-shell",
    cwd: current.root,
    command: "sed -i 's/value = 1/value = 2/' src/change.ts",
  }, { gateRoot: current.gateRoot });

  expect(decision?.permission).toBe("deny");
  expect(decision?.agent_message).toContain("Shell command blocked");
  expect(await checkPreToolUse({
    hook_event_name: "beforeShellExecution",
    conversation_id: "session-shell",
    cwd: current.root,
    command: "bun run test",
  }, { gateRoot: current.gateRoot })).toBeNull();
});

test("preToolUse Shell mutations are blocked while reads stay ungated", async () => {
  const current = await fixture();
  const denied = await checkPreToolUse({
    conversation_id: "session-shell-tool",
    cwd: current.root,
    tool_name: "Shell",
    tool_input: { command: "git checkout -- src/change.ts" },
  }, { gateRoot: current.gateRoot });
  expect(denied?.permission).toBe("deny");
  expect(await checkPreToolUse({
    conversation_id: "session-shell-tool",
    cwd: current.root,
    tool_name: "Read",
    tool_input: { path: current.file },
  }, { gateRoot: current.gateRoot })).toBeNull();
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
  expect(result.permits).toBe(1);
  expect(await checkPreToolUse({
    conversation_id: "session-record",
    cwd: current.root,
    tool_name: "Write",
    tool_input: { path: current.file },
  }, { gateRoot: current.gateRoot, bridge: successfulSnapshotBridge([]) })).toBeNull();
});

test("preToolUse captures the matching current permit state and reuses its capture ID", async () => {
  const current = await fixture();
  const event = await normalizeDecisionProposal({
    repositoryRoot: current.root,
    targets: [{ path: "src/change.ts", lineStart: 1, lineEnd: 1 }],
    judgment: "the change preserves the invariant",
    rationale: "the focused branch keeps the existing guard",
  }, { sessionId: "session-capture" });
  await grantDecisionPermits(event, { recordId: "record-capture", gateRoot: current.gateRoot });
  const editInput = {
    conversation_id: "session-capture",
    cwd: current.root,
    tool_name: "Write",
    tool_input: { path: current.file },
  };
  const captures: Array<Record<string, unknown>> = [];
  const bridge = successfulSnapshotBridge(captures);

  expect(await checkPreToolUse(editInput, { gateRoot: current.gateRoot, bridge })).toBeNull();
  expect(await checkPreToolUse(editInput, { gateRoot: current.gateRoot, bridge })).toBeNull();
  expect(captures).toHaveLength(2);
  expect(captures[0]).toMatchObject({
    recordId: "record-capture",
    sourcePath: "src/change.ts",
    content: "export const value = 1;\n",
    beforeMissing: false,
  });
  expect(captures[1]?.captureId).toBe(captures[0]?.captureId);
});

test("preToolUse denies when the target changed after the permit was issued", async () => {
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

  const denial = await checkPreToolUse({
    conversation_id: "session-hash-mismatch",
    cwd: current.root,
    tool_name: "Write",
    tool_input: { path: current.file },
  }, { gateRoot: current.gateRoot, bridge: successfulSnapshotBridge(captures) });

  expect(denial?.permission).toBe("deny");
  expect(captures).toHaveLength(0);
});

test("preToolUse denies a failed automatic capture and leaves the permit for retry", async () => {
  const current = await fixture();
  const event = await normalizeDecisionProposal({
    repositoryRoot: current.root,
    targets: [{ path: "src/change.ts", lineStart: 1 }],
    judgment: "safe",
    rationale: "checked",
  }, { sessionId: "session-capture-failure" });
  await grantDecisionPermits(event, { recordId: "record-capture-failure", gateRoot: current.gateRoot });
  const editInput = {
    conversation_id: "session-capture-failure",
    cwd: current.root,
    tool_name: "Write",
    tool_input: { path: current.file },
  };
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

  const denial = await checkPreToolUse(editInput, { gateRoot: current.gateRoot, bridge: failedBridge });
  expect(denial?.agent_message).toContain("Automatic snapshot failed before edit: content changed before capture");
  expect(await checkPreToolUse(editInput, { gateRoot: current.gateRoot, bridge: successfulSnapshotBridge([]) })).toBeNull();
  await checkPostToolUse(editInput, { gateRoot: current.gateRoot });
  expect(await checkPreToolUse(editInput, { gateRoot: current.gateRoot, bridge: successfulSnapshotBridge([]) })).not.toBeNull();
});

test("postToolUse consumes a permit even when the edited file no longer matches its pre-edit hash", async () => {
  const current = await fixture();
  const event = await normalizeDecisionProposal({
    repositoryRoot: current.root,
    targets: [{ path: "src/change.ts", lineStart: 1 }],
    judgment: "safe",
    rationale: "checked",
  }, { sessionId: "session-post-change" });
  await grantDecisionPermits(event, { recordId: "record-post-change", gateRoot: current.gateRoot });
  const editInput = {
    conversation_id: "session-post-change",
    cwd: current.root,
    tool_name: "Write",
    tool_input: { path: current.file },
  };

  expect(await checkPreToolUse(editInput, { gateRoot: current.gateRoot, bridge: successfulSnapshotBridge([]) })).toBeNull();
  await writeFile(current.file, "export const value = 2;\n", "utf8");
  await checkPostToolUse(editInput, { gateRoot: current.gateRoot });
  await writeFile(current.file, "export const value = 1;\n", "utf8");

  expect(await checkPreToolUse(editInput, { gateRoot: current.gateRoot, bridge: successfulSnapshotBridge([]) })).not.toBeNull();
});

test("sessionStart registers a cursor session and returns env for later hooks", async () => {
  const current = await fixture();
  const calls: Array<{ root: string; session: Record<string, unknown> }> = [];
  const setupClient = {
    ensureSession: async (root: string, session: Record<string, unknown>) => {
      calls.push({ root, session });
      return { repository: { repository_id: "repository-setup", root, created_at: "2026-08-29T00:00:00.000Z" }, session };
    },
  } as unknown as Pick<RecorderSetupClient, "ensureSession">;

  const result = await handleSessionStart({
    session_id: "session-start",
    cwd: current.root,
    workspace_roots: [current.root],
  }, { setupClient, sessionStoreRoot: current.sessionStoreRoot });

  expect(calls).toHaveLength(1);
  expect(calls[0]?.session).toMatchObject({ session_id: "session-start", agent_type: AGENT_TYPE, status: "active" });
  expect(result.env.AI_REVIEW_SESSION_ID).toBe("session-start");
  expect(result.env.AI_REVIEW_REPOSITORY_ROOT).toBe(current.root);
  expect(result.env.AI_REVIEW_AGENT_TYPE).toBe("cursor");
  expect(result.additional_context).toContain("review_record_judgment");
});

test("sessionStart prefers workspace_roots over a plugin-directory cwd", async () => {
  const current = await fixture();
  const pluginCwd = await realpath(await mkdtemp(join(tmpdir(), "ai-review-plugin-cwd-")));
  process.env.CURSOR_PLUGIN_ROOT = pluginCwd;

  const result = await handleSessionStart({
    session_id: "session-workspace-roots",
    cwd: pluginCwd,
    workspace_roots: [current.root],
  }, { setupClient: passingSetupClient(), sessionStoreRoot: current.sessionStoreRoot });

  expect(result.env.AI_REVIEW_REPOSITORY_ROOT).toBe(current.root);
});

test("sessionStart prefers CURSOR_PROJECT_DIR over a plugin-directory cwd", async () => {
  const current = await fixture();
  const pluginCwd = await realpath(await mkdtemp(join(tmpdir(), "ai-review-plugin-cwd-")));
  process.env.CURSOR_PLUGIN_ROOT = pluginCwd;
  process.env.CURSOR_PROJECT_DIR = current.root;

  const result = await handleSessionStart({
    conversation_id: "session-project-dir-root",
    cwd: pluginCwd,
  }, { setupClient: passingSetupClient(), sessionStoreRoot: current.sessionStoreRoot });

  expect(result.env.AI_REVIEW_REPOSITORY_ROOT).toBe(current.root);
});

test("beforeSubmitPrompt session output continues the prompt after persisting", async () => {
  const current = await fixture();
  const result = await handleSessionStart({
    hook_event_name: "beforeSubmitPrompt",
    conversation_id: "session-submit",
    workspace_roots: [current.root],
  }, { setupClient: passingSetupClient(), sessionStoreRoot: current.sessionStoreRoot });

  expect(sessionStartOutput({ hook_event_name: "beforeSubmitPrompt" }, result)).toEqual({ continue: true });
  expect(sessionStartOutput({ hook_event_name: "sessionStart" }, result)).toEqual(result);
});

test("sessionStart still returns env when Recorder auto-registration fails", async () => {
  const current = await fixture();
  const setupClient = {
    ensureSession: async () => { throw new Error("Recorder unavailable"); },
  } as unknown as Pick<RecorderSetupClient, "ensureSession">;
  const warnings: unknown[] = [];

  const result = await handleSessionStart({
    conversation_id: "session-warning",
    workspace_roots: [current.root],
  }, {
    setupClient,
    sessionStoreRoot: current.sessionStoreRoot,
    onRegistrationError: (error) => { warnings.push(error); },
  });

  expect(result.env.AI_REVIEW_SESSION_ID).toBe("session-warning");
  expect(warnings).toHaveLength(1);
});

test("recordDecision can recover the persisted Cursor session when env is empty", async () => {
  const current = await fixture();
  await handleSessionStart({
    session_id: "session-persisted",
    cwd: current.root,
  }, {
    setupClient: passingSetupClient(),
    sessionStoreRoot: current.sessionStoreRoot,
  });
  const bridge: AdapterBridge = {
    submit: async (record): Promise<SubmitResult> => ({ success: true, status: 201, duplicate: false, recordId: record.record_id }),
  };

  const result = await recordDecision({
    repositoryRoot: current.root,
    targets: [{ path: "src/change.ts", lineStart: 1 }],
    judgment: "safe",
    rationale: "checked",
  }, { bridge, gateRoot: current.gateRoot, sessionStoreRoot: current.sessionStoreRoot });

  expect(result.success).toBe(true);
  expect(await checkPreToolUse({
    conversation_id: "session-persisted",
    cwd: current.root,
    tool_name: "Write",
    tool_input: { path: current.file },
  }, { gateRoot: current.gateRoot, bridge: successfulSnapshotBridge([]) })).toBeNull();
});

test("recordDecision recovers the persisted session from CURSOR_PROJECT_DIR when MCP env is empty", async () => {
  const current = await fixture();
  await handleSessionStart({
    session_id: "session-project-dir",
    cwd: current.root,
  }, {
    setupClient: passingSetupClient(),
    sessionStoreRoot: current.sessionStoreRoot,
  });
  process.env.CURSOR_PROJECT_DIR = current.root;
  const bridge: AdapterBridge = {
    submit: async (record): Promise<SubmitResult> => {
      expect(record.session_id).toBe("session-project-dir");
      expect(record.repository_id).toBe(repositoryIdFor(current.root));
      return { success: true, status: 201, duplicate: false, recordId: record.record_id };
    },
  };

  const result = await recordDecision({
    targets: [{ path: "src/change.ts", lineStart: 1 }],
    judgment: "safe",
    rationale: "checked",
  }, { bridge, gateRoot: current.gateRoot, sessionStoreRoot: current.sessionStoreRoot });

  expect(result.success).toBe(true);
});

test("recordDecision falls back to the latest persisted session when cwd is the plugin root", async () => {
  const current = await fixture();
  await handleSessionStart({
    session_id: "session-latest",
    cwd: current.root,
  }, {
    setupClient: passingSetupClient(),
    sessionStoreRoot: current.sessionStoreRoot,
  });
  process.env.CURSOR_PLUGIN_ROOT = process.cwd();
  const bridge: AdapterBridge = {
    submit: async (record): Promise<SubmitResult> => {
      expect(record.session_id).toBe("session-latest");
      expect(record.repository_id).toBe(repositoryIdFor(current.root));
      return { success: true, status: 201, duplicate: false, recordId: record.record_id };
    },
  };

  const result = await recordDecision({
    targets: [{ path: "src/change.ts", lineStart: 1 }],
    judgment: "safe",
    rationale: "checked",
  }, { bridge, gateRoot: current.gateRoot, sessionStoreRoot: current.sessionStoreRoot });

  expect(result.success).toBe(true);
});

test("recordDecision does not adopt a latest session from a different repository", async () => {
  const current = await fixture();
  const other = await fixture();
  await handleSessionStart({
    session_id: "session-foreign",
    cwd: other.root,
  }, {
    setupClient: passingSetupClient(),
    sessionStoreRoot: current.sessionStoreRoot,
  });
  process.env.CURSOR_PROJECT_DIR = current.root;

  await expect(recordDecision({
    targets: [{ path: "src/change.ts", lineStart: 1 }],
    judgment: "safe",
    rationale: "checked",
  }, {
    bridge: {
      submit: async (): Promise<SubmitResult> => {
        throw new Error("must not submit a mismatched session");
      },
    },
    gateRoot: current.gateRoot,
    sessionStoreRoot: current.sessionStoreRoot,
  })).rejects.toThrow("sessionId is required; start the plugin session first");
});

test("recordDecision explains a Recorder that still rejects agent_type cursor", async () => {
  const current = await fixture();
  const bridge: AdapterBridge = {
    submit: async (record): Promise<SubmitResult> => ({
      success: false,
      status: 422,
      code: "INVALID_RECORD",
      message: "agent_type must be claude-code, codex, or opencode",
      error: "agent_type must be claude-code, codex, or opencode",
      recordId: record.record_id,
      attempts: 1,
    }),
  };

  const result = await recordDecision({
    repositoryRoot: current.root,
    targets: [{ path: "src/change.ts", lineStart: 1 }],
    judgment: "safe",
    rationale: "checked",
  }, { sessionId: "session-old-recorder", bridge, gateRoot: current.gateRoot });

  expect(result.success).toBe(false);
  expect(result.message).toContain("agent_type must be claude-code, codex, or opencode");
  expect(result.message).toContain("restart Recorder");
  expect(result.message).toContain("cursor");
});
