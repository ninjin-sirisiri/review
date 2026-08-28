import { createHash } from "node:crypto";
import { realpath } from "node:fs/promises";
import { resolve } from "node:path";
import {
  consumeDecisionPermitAfterEdit,
  defaultGateRoot,
  findDecisionPermit,
  grantDecisionPermits,
  likelyCodeMutation,
  normalizeDecisionProposal,
  readCurrentFileState,
  type AutomaticSnapshotBridge,
  type DecisionProposalDefaults,
  type GateStorageOptions,
} from "../../common/src/decision-gate";
import { mapHostEvent, type AdapterBridge } from "../../common/src/adapter-contract";
import { RecorderBridge } from "../../common/src/bridge";
import { RecorderSetupClient, type SessionRegistration } from "../../common/src/recorder-setup";
import type { AgentType } from "../../../packages/contracts/src/index";

export const AGENT_TYPE: AgentType = "opencode";

const EDIT_TOOLS: ReadonlySet<string> = new Set(["edit", "write", "patch", "multiedit", "notebookedit"]);

export interface ToolCall {
  tool: string;
  args: unknown;
}

export interface GateContext extends GateStorageOptions {
  sessionId: string;
  repositoryRoot: string;
  snapshotBridge?: AutomaticSnapshotBridge;
}

export interface RegisterSessionOptions {
  setupClient?: Pick<RecorderSetupClient, "ensureSession">;
}

export interface RegisteredSession {
  sessionId: string;
  repositoryId: string;
  repositoryRoot: string;
  registration: SessionRegistration;
}

export interface RecordDecisionOptions extends GateStorageOptions, DecisionProposalDefaults {
  bridge?: AdapterBridge;
}

export interface RecordDecisionResult {
  success: boolean;
  recordId: string;
  duplicate?: boolean;
  status?: number;
  permits?: number;
  code?: string;
  message?: string;
}

function argString(args: unknown, keys: readonly string[]): string | null {
  if (typeof args !== "object" || args === null || Array.isArray(args)) return null;
  const record = args as Record<string, unknown>;
  for (const key of keys) {
    const value = record[key];
    if (typeof value === "string" && value.trim().length > 0) return value;
  }
  return null;
}

function repositoryId(root: string): string {
  return createHash("sha256").update(root, "utf8").digest("hex");
}

/**
 * Returns the denial reason when a tool call must be blocked, or null when the
 * call may proceed. Edit tools require a single-use permit bound to the target
 * path and its current content hash; the permit is only spent by
 * gateToolUseAfter after the edit actually completes.
 */
export async function gateToolUse(call: ToolCall, context: GateContext): Promise<string | null> {
  const toolName = typeof call.tool === "string" ? call.tool.toLowerCase() : "";
  if (toolName === "bash") {
    const command = argString(call.args, ["command"]);
    if (command === null || !likelyCodeMutation(command)) return null;
    return "Shell command blocked because it may edit code. Record a judgment first with review_record_judgment, then use edit or write; arbitrary shell mutation is not accepted by the judgment gate.";
  }
  if (!EDIT_TOOLS.has(toolName)) return null;
  const filePath = argString(call.args, ["filePath", "file_path", "path"]);
  if (filePath === null) {
    return "Code edit blocked because the plugin could not identify its target path; use edit or write with a file path after recording a judgment.";
  }
  // Peek only: consumption happens in gateToolUseAfter once the edit has run,
  // so an edit blocked elsewhere keeps its permit.
  const permit = await findDecisionPermit({
    sessionId: context.sessionId,
    repositoryRoot: resolve(context.repositoryRoot),
    filePath: resolve(filePath),
    gateRoot: context.gateRoot ?? defaultGateRoot(),
  });
  if (permit !== null) {
    try {
      const state = await readCurrentFileState({ repositoryRoot: permit.repositoryRoot, filePath: resolve(filePath) });
      if (state.contentHash !== permit.contentHash) return "Automatic snapshot failed before edit: target content changed since judgment";
      const bridge = context.snapshotBridge ?? new RecorderBridge();
      const captured = await bridge.captureAutomaticSnapshot({
        recordId: permit.recordId,
        captureId: permit.captureId,
        sourcePath: permit.path,
        content: state.content,
        beforeMissing: state.beforeMissing,
      });
      if (captured.success) return null;
      return `Automatic snapshot failed before edit: ${captured.message}`;
    } catch (error) {
      return `Automatic snapshot failed before edit: ${error instanceof Error ? error.message : String(error)}`;
    }
  }
  return `Code edit blocked for ${filePath}: record a structured judgment first, then retry this exact edit. Pass {"targets":[{"path":"<repo-relative-path>","lineStart":1}],"judgment":"<decision>","rationale":"<why>"} to review_record_judgment; required fields are targets[].path, targets[].lineStart, judgment, rationale; lineEnd is optional and contentHash is computed automatically. The Recorder must be running locally first (ai-review --data-dir ./.ai-review --port 4318).`;
}

/**
 * Spends one matching permit after a gated edit actually completed. OpenCode
 * fires tool.execute.after only for executed tools, so edits blocked before or
 * during execution never consume their permit.
 */
export async function gateToolUseAfter(call: ToolCall, context: GateContext): Promise<void> {
  const toolName = typeof call.tool === "string" ? call.tool.toLowerCase() : "";
  if (!EDIT_TOOLS.has(toolName)) return;
  const filePath = argString(call.args, ["filePath", "file_path", "path"]);
  if (filePath === null) return;
  await consumeDecisionPermitAfterEdit({
    sessionId: context.sessionId,
    repositoryRoot: resolve(context.repositoryRoot),
    filePath: resolve(filePath),
    gateRoot: context.gateRoot ?? defaultGateRoot(),
  });
}

export async function registerSession(sessionId: string, repositoryRoot: string, options: RegisterSessionOptions = {}): Promise<RegisteredSession> {
  if (typeof sessionId !== "string" || sessionId.trim().length === 0) {
    throw new Error("OpenCode session id is unavailable; restart the session so the plugin can initialize it");
  }
  const canonicalRoot = await realpath(repositoryRoot).catch(() => repositoryRoot);
  const setupClient = options.setupClient ?? new RecorderSetupClient();
  const registered = await setupClient.ensureSession(canonicalRoot, {
    session_id: sessionId,
    repository_id: repositoryId(canonicalRoot),
    agent_type: AGENT_TYPE,
    started_at: new Date().toISOString(),
    status: "active",
  });
  return {
    sessionId: registered.session.session_id,
    repositoryId: registered.repository.repository_id,
    repositoryRoot: canonicalRoot,
    registration: registered.session,
  };
}

export async function recordDecision(value: unknown, options: RecordDecisionOptions = {}): Promise<RecordDecisionResult> {
  const event = await normalizeDecisionProposal(value, {
    ...(options.sessionId === undefined ? {} : { sessionId: options.sessionId }),
    ...(options.repositoryRoot === undefined ? {} : { repositoryRoot: options.repositoryRoot }),
  });
  const record = mapHostEvent(AGENT_TYPE, event);
  const bridge = options.bridge ?? new RecorderBridge();
  const submitted = await bridge.submit(record);
  if (!submitted.success) {
    return {
      success: false,
      recordId: record.record_id,
      code: submitted.code,
      message: submitted.message,
      ...(submitted.status === undefined ? {} : { status: submitted.status }),
    };
  }
  const permits = await grantDecisionPermits(event, {
    recordId: record.record_id,
    ...(options.gateRoot === undefined ? {} : { gateRoot: options.gateRoot }),
  });
  return { success: true, recordId: record.record_id, status: submitted.status, duplicate: submitted.duplicate, permits: permits.permits };
}
