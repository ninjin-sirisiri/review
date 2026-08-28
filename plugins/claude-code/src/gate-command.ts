import { appendFile, realpath } from "node:fs/promises";
import { createHash } from "node:crypto";
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
  type GateStorageOptions,
} from "../../common/src/decision-gate";
import { mapHostEvent, type AdapterBridge } from "../../common/src/adapter-contract";
import { RecorderBridge } from "../../common/src/bridge";
import { RecorderSetupClient, RecorderSetupError, type SessionRegistration } from "../../common/src/recorder-setup";
import type { AgentType, ReviewSession } from "../../../packages/contracts/src/index";

const MAX_STDIN_BYTES = 1_000_000;

type JsonObject = Record<string, unknown>;

export interface PreToolUseInput {
  session_id?: unknown;
  cwd?: unknown;
  tool_name?: unknown;
  tool_input?: unknown;
}

export interface PreToolUseDenyOutput {
  hookSpecificOutput: {
    hookEventName: "PreToolUse";
    permissionDecision: "deny";
    permissionDecisionReason: string;
  };
}

export type PreToolUseOutput = PreToolUseDenyOutput;

export interface PreToolUseOptions extends GateStorageOptions {
  bridge?: AutomaticSnapshotBridge;
}

export interface RecordDecisionOptions extends GateStorageOptions {
  bridge?: AdapterBridge;
  agentType?: AgentType;
  sessionId?: string;
  repositoryRoot?: string;
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

export interface SessionStartOptions {
  setupClient?: Pick<RecorderSetupClient, "ensureSession">;
  envFile?: string;
}

function jsonRecord(value: unknown, field: string): JsonObject {
  if (typeof value !== "object" || value === null || Array.isArray(value)) throw new Error(`${field} must be an object`);
  return value as JsonObject;
}

export async function readBoundedStdin(stream: ReadableStream<Uint8Array>, maxBytes = MAX_STDIN_BYTES): Promise<string> {
  if (!Number.isSafeInteger(maxBytes) || maxBytes <= 0) throw new RangeError("maxBytes must be a positive integer");
  const reader = stream.getReader();
  const chunks: Uint8Array[] = [];
  let totalBytes = 0;
  try {
    while (true) {
      const next = await reader.read();
      if (next.done) break;
      totalBytes += next.value.byteLength;
      if (totalBytes > maxBytes) {
        try {
          await reader.cancel();
        } catch {
          // The input is already rejected; cancellation failure is not actionable.
        }
        throw new Error("hook input exceeds the command limit");
      }
      chunks.push(next.value);
    }
  } finally {
    reader.releaseLock();
  }
  const bytes = new Uint8Array(totalBytes);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return new TextDecoder().decode(bytes);
}

async function stdinText(): Promise<string> {
  return readBoundedStdin(Bun.stdin.stream());
}

function sessionIdFromInput(input: PreToolUseInput): string {
  if (typeof input.session_id === "string" && input.session_id.trim().length > 0) return input.session_id;
  const value = process.env.AI_REVIEW_SESSION_ID;
  if (value === undefined || value.trim().length === 0) throw new Error("Claude session id is unavailable; restart the session so the plugin can initialize it");
  return value;
}

function cwdFromInput(input: PreToolUseInput): string {
  const value = process.env.AI_REVIEW_REPOSITORY_ROOT ?? (typeof input.cwd === "string" && input.cwd.trim().length > 0 ? input.cwd : process.cwd());
  return resolve(value);
}

function filePathFromTool(input: PreToolUseInput): string | null {
  if (typeof input.tool_input !== "object" || input.tool_input === null || Array.isArray(input.tool_input)) return null;
  const toolInput = input.tool_input as JsonObject;
  for (const key of ["file_path", "notebook_path", "path"]) {
    if (typeof toolInput[key] === "string" && toolInput[key].trim().length > 0) return resolve(toolInput[key]);
  }
  return null;
}

function shellCommandFromTool(input: PreToolUseInput): string | null {
  if (typeof input.tool_input !== "object" || input.tool_input === null || Array.isArray(input.tool_input)) return null;
  const command = (input.tool_input as JsonObject).command;
  return typeof command === "string" ? command : null;
}

function deny(reason: string): PreToolUseDenyOutput {
  return {
    hookSpecificOutput: {
      hookEventName: "PreToolUse",
      permissionDecision: "deny",
      permissionDecisionReason: reason,
    },
  };
}

function editReason(path: string): string {
  return [
    `Code edit blocked for ${path}: record a structured judgment first, then retry this exact edit.`,
    'Pipe this JSON to ai-review-record (inside Claude Code) or `bun <plugin>/bin/adapter.mjs record` from a plain shell:',
    '{"targets":[{"path":"<repo-relative-path>","lineStart":1}],"judgment":"<decision>","rationale":"<why>"}',
    "Required: targets[].path, targets[].lineStart, judgment, rationale; lineEnd is optional and contentHash is computed automatically.",
    "The Recorder must be running locally first (ai-review --data-dir ./.ai-review --port 4318, i.e. http://127.0.0.1:4318).",
    "See plugins/claude-code/skills/record-before-edit/SKILL.md.",
  ].join(" ");
}

export async function checkPreToolUse(input: PreToolUseInput, options: PreToolUseOptions = {}): Promise<PreToolUseOutput | null> {
  const toolName = typeof input.tool_name === "string" ? input.tool_name : "";
  if (toolName === "Bash" || toolName === "PowerShell") {
    const command = shellCommandFromTool(input);
    if (command === null || !likelyCodeMutation(command)) return null;
    return deny("Shell command blocked because it may edit code. Record a judgment first with ai-review-record, then use Edit or Write; arbitrary shell mutation is not accepted by the judgment gate.");
  }
  if (toolName !== "Edit" && toolName !== "Write" && toolName !== "NotebookEdit" && toolName !== "MultiEdit") return null;
  const filePath = filePathFromTool(input);
  if (filePath === null) return deny("Code edit blocked because the hook could not identify its target path; use Edit or Write with a file path after recording a judgment.");
  let sessionId: string;
  try {
    sessionId = sessionIdFromInput(input);
  } catch (error) {
    return deny(error instanceof Error ? error.message : String(error));
  }
  const repositoryRoot = cwdFromInput(input);
  // Peek only: consumption happens in checkPostToolUse once the edit has
  // actually run, so a denial by another PreToolUse hook does not waste it.
  const permit = await findDecisionPermit({
    sessionId,
    repositoryRoot,
    filePath,
    gateRoot: options.gateRoot ?? defaultGateRoot(),
  });
  if (permit === null) return deny(editReason(filePath));
  try {
    const state = await readCurrentFileState({ repositoryRoot: permit.repositoryRoot, filePath });
    if (state.contentHash !== permit.contentHash) return deny("Automatic snapshot failed before edit: target content changed since judgment");
    const bridge = options.bridge ?? new RecorderBridge();
    const captured = await bridge.captureAutomaticSnapshot({
      recordId: permit.recordId,
      captureId: permit.captureId,
      sourcePath: permit.path,
      content: state.content,
      beforeMissing: state.beforeMissing,
    });
    if (captured.success) return null;
    return deny(`Automatic snapshot failed before edit: ${captured.message}`);
  } catch (error) {
    return deny(`Automatic snapshot failed before edit: ${error instanceof Error ? error.message : String(error)}`);
  }
}

export interface PostToolUseInput {
  session_id?: unknown;
  cwd?: unknown;
  tool_name?: unknown;
  tool_input?: unknown;
}

export async function checkPostToolUse(input: PostToolUseInput, options: GateStorageOptions = {}): Promise<void> {
  const toolName = typeof input.tool_name === "string" ? input.tool_name : "";
  if (toolName !== "Edit" && toolName !== "Write" && toolName !== "NotebookEdit" && toolName !== "MultiEdit") return;
  const filePath = filePathFromTool(input);
  if (filePath === null) return;
  let sessionId: string;
  try {
    sessionId = sessionIdFromInput(input);
  } catch {
    return;
  }
  await consumeDecisionPermitAfterEdit({
    sessionId,
    repositoryRoot: cwdFromInput(input),
    filePath,
    gateRoot: options.gateRoot ?? defaultGateRoot(),
  });
}

function shellQuote(value: string): string {
  return "'" + value.replaceAll("'", "'\"'\"'") + "'";
}

function repositoryId(root: string): string {
  return createHash("sha256").update(root, "utf8").digest("hex");
}

function sessionRegistration(root: string, sessionId: string): ReviewSession {
  return {
    session_id: sessionId,
    repository_id: repositoryId(root),
    agent_type: "claude-code",
    started_at: new Date().toISOString(),
    status: "active",
  };
}

export async function handleSessionStart(input: unknown, options: SessionStartOptions = {}): Promise<SessionRegistration> {
  const root = jsonRecord(input, "SessionStart input");
  const sessionId = typeof root.session_id === "string" ? root.session_id : "";
  const cwd = typeof root.cwd === "string" ? resolve(root.cwd) : process.cwd();
  if (sessionId.trim().length === 0) throw new Error("SessionStart input did not include session_id");
  const canonicalRoot = await realpath(cwd).catch(() => cwd);
  const setupClient = options.setupClient ?? new RecorderSetupClient();
  let registration: SessionRegistration | undefined;
  let setupError: unknown;
  try {
    registration = (await setupClient.ensureSession(canonicalRoot, sessionRegistration(canonicalRoot, sessionId))).session;
  } catch (error) {
    setupError = error;
  }
  const envFile = options.envFile ?? process.env.CLAUDE_ENV_FILE;
  if (envFile !== undefined && envFile.trim().length > 0) {
    await appendFile(envFile, `export AI_REVIEW_SESSION_ID=${shellQuote(sessionId)}\nexport AI_REVIEW_REPOSITORY_ROOT=${shellQuote(canonicalRoot)}\nexport AI_REVIEW_AGENT_TYPE=claude-code\n`, "utf8");
  }
  if (setupError !== undefined) throw setupError;
  if (registration === undefined) throw new Error("SessionStart registration did not return a session");
  return registration;
}

export async function recordDecision(value: unknown, options: RecordDecisionOptions = {}): Promise<RecordDecisionResult> {
  const agentType = options.agentType ?? (process.env.AI_REVIEW_AGENT_TYPE === "codex" ? "codex" : "claude-code");
  const sessionId = options.sessionId ?? process.env.AI_REVIEW_SESSION_ID;
  const repositoryRoot = options.repositoryRoot ?? process.env.AI_REVIEW_REPOSITORY_ROOT;
  const event = await normalizeDecisionProposal(value, {
    ...(sessionId === undefined ? {} : { sessionId }),
    ...(repositoryRoot === undefined ? {} : { repositoryRoot }),
  });
  const record = mapHostEvent(agentType, event);
  const bridge = options.bridge ?? new RecorderBridge();
  const submitted = await bridge.submit(record);
  if (!submitted.success) {
    return {
      success: false,
      recordId: record.record_id,
      ...(submitted.status === undefined ? {} : { status: submitted.status }),
      code: submitted.code,
      message: submitted.message,
    };
  }
  const permits = await grantDecisionPermits(event, {
    recordId: record.record_id,
    ...(options.gateRoot === undefined ? {} : { gateRoot: options.gateRoot }),
  });
  return { success: true, recordId: record.record_id, status: submitted.status, duplicate: submitted.duplicate, permits: permits.permits };
}

export async function runPreEditHook(): Promise<void> {
  const result = await checkPreToolUse(JSON.parse(await stdinText()) as PreToolUseInput);
  if (result !== null) process.stdout.write(`${JSON.stringify(result)}\n`);
}

export async function runPostEditHook(): Promise<void> {
  await checkPostToolUse(JSON.parse(await stdinText()) as PostToolUseInput);
}

export async function runRecordCommand(): Promise<void> {
  try {
    const result = await recordDecision(JSON.parse(await stdinText()) as unknown);
    process.stdout.write(`${JSON.stringify(result)}\n`);
    if (!result.success) process.exitCode = 1;
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    process.stdout.write(`${JSON.stringify({ success: false, recordId: "", code: "INVALID_RECORD", message })}\n`);
    process.exitCode = 1;
  }
}

export async function runSessionStartHook(): Promise<void> {
  try {
    await handleSessionStart(JSON.parse(await stdinText()) as unknown);
  } catch (error) {
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
    if (!(error instanceof RecorderSetupError)) process.exitCode = 1;
  }
}
