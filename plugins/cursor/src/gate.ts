import { createHash } from "node:crypto";
import { mkdir, readFile, realpath, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
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
import type { AgentType, ReviewSession } from "../../../packages/contracts/src/index";

export const AGENT_TYPE: AgentType = "cursor";

const MAX_STDIN_BYTES = 1_000_000;
const EDIT_TOOLS: ReadonlySet<string> = new Set([
  "write",
  "strreplace",
  "applypatch",
  "delete",
  "editnotebook",
  "multiedit",
  "edit",
  "searchreplace",
  "search_replace",
  "apply_patch",
  "notebookedit",
]);
const PATH_KEYS = ["file_path", "filePath", "path", "notebook_path", "target_notebook", "target_file"] as const;

type JsonObject = Record<string, unknown>;

export interface CursorHookInput {
  hook_event_name?: unknown;
  conversation_id?: unknown;
  session_id?: unknown;
  cwd?: unknown;
  workspace_roots?: unknown;
  tool_name?: unknown;
  tool_input?: unknown;
  command?: unknown;
  file_path?: unknown;
}

export interface CursorDenyOutput {
  permission: "deny";
  agent_message: string;
  user_message: string;
}

export interface PreToolUseOptions extends GateStorageOptions {
  bridge?: AutomaticSnapshotBridge;
}

export interface RecordDecisionOptions extends GateStorageOptions, DecisionProposalDefaults {
  bridge?: AdapterBridge;
  sessionStoreRoot?: string;
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
  sessionStoreRoot?: string;
  onRegistrationError?: (error: unknown) => void;
}

export interface SessionStartResult {
  env: {
    AI_REVIEW_SESSION_ID: string;
    AI_REVIEW_REPOSITORY_ROOT: string;
    AI_REVIEW_AGENT_TYPE: "cursor";
  };
  additional_context: string;
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

function jsonRecord(value: unknown): JsonObject | null {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return null;
  return value as JsonObject;
}

function stringField(record: JsonObject, keys: readonly string[]): string | null {
  for (const key of keys) {
    const value = record[key];
    if (typeof value === "string" && value.trim().length > 0) return value;
  }
  return null;
}

function sha256(value: string): string {
  return createHash("sha256").update(value, "utf8").digest("hex");
}

function repositoryId(root: string): string {
  return sha256(root);
}

function sessionStoreBase(options: { sessionStoreRoot?: string }): string {
  return options.sessionStoreRoot ?? process.env.AI_REVIEW_CURSOR_SESSION_ROOT ?? joinSessionHome();
}

function joinSessionHome(): string {
  return join(homedir(), ".ai-code-review-evidence", "cursor-sessions");
}

function sessionStorePath(root: string, options: { sessionStoreRoot?: string }): string {
  return join(sessionStoreBase(options), `${sha256(root)}.json`);
}

export async function persistCursorSession(root: string, sessionId: string, options: { sessionStoreRoot?: string } = {}): Promise<void> {
  const path = sessionStorePath(root, options);
  await mkdir(dirname(path), { recursive: true, mode: 0o700 });
  await writeFile(path, `${JSON.stringify({ sessionId, repositoryRoot: root })}\n`, { encoding: "utf8", mode: 0o600 });
}

export async function loadCursorSession(root: string, options: { sessionStoreRoot?: string } = {}): Promise<string | undefined> {
  try {
    const raw = JSON.parse(await readFile(sessionStorePath(root, options), "utf8")) as { sessionId?: unknown };
    if (typeof raw.sessionId === "string" && raw.sessionId.trim().length > 0) return raw.sessionId;
  } catch {
    return undefined;
  }
  return undefined;
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

function sessionIdFromInput(input: CursorHookInput): string {
  if (typeof input.conversation_id === "string" && input.conversation_id.trim().length > 0) return input.conversation_id;
  if (typeof input.session_id === "string" && input.session_id.trim().length > 0) return input.session_id;
  const value = process.env.AI_REVIEW_SESSION_ID;
  if (value === undefined || value.trim().length === 0) throw new Error("Cursor session id is unavailable; restart the session so the plugin can initialize it");
  return value;
}

function workspaceRootFromInput(input: CursorHookInput): string {
  if (typeof process.env.AI_REVIEW_REPOSITORY_ROOT === "string" && process.env.AI_REVIEW_REPOSITORY_ROOT.trim().length > 0) {
    return resolve(process.env.AI_REVIEW_REPOSITORY_ROOT);
  }
  if (typeof input.cwd === "string" && input.cwd.trim().length > 0) return resolve(input.cwd);
  if (Array.isArray(input.workspace_roots)) {
    const first = input.workspace_roots.find((root) => typeof root === "string" && root.trim().length > 0);
    if (typeof first === "string") return resolve(first);
  }
  return resolve(process.cwd());
}

function toolName(input: CursorHookInput): string {
  if (typeof input.tool_name === "string") return input.tool_name;
  if (input.hook_event_name === "beforeShellExecution" || (typeof input.command === "string" && input.tool_name === undefined)) return "Shell";
  return "";
}

function shellCommandFromInput(input: CursorHookInput): string | null {
  if (typeof input.command === "string") return input.command;
  const toolInput = jsonRecord(input.tool_input);
  if (toolInput === null) return null;
  return typeof toolInput.command === "string" ? toolInput.command : null;
}

function pathsFromPatch(patch: string): string[] {
  const paths: string[] = [];
  for (const pattern of [/^\*\*\* (?:Add|Update|Delete) File:\s+(.+)$/gm, /^\+\+\+ (?:b\/)?(.+)$/gm]) {
    for (const match of patch.matchAll(pattern)) {
      const path = match[1]?.trim();
      if (path !== undefined && path.length > 0 && path !== "/dev/null") paths.push(path);
    }
  }
  return paths;
}

function filePathsFromInput(input: CursorHookInput): string[] {
  const paths: string[] = [];
  if (typeof input.file_path === "string" && input.file_path.trim().length > 0) paths.push(input.file_path);
  const toolInput = jsonRecord(input.tool_input);
  if (toolInput !== null) {
    const direct = stringField(toolInput, PATH_KEYS);
    if (direct !== null) paths.push(direct);
    const patch = stringField(toolInput, ["patch", "apply_patch"]);
    if (patch !== null) paths.push(...pathsFromPatch(patch));
  }
  return [...new Set(paths.map((path) => resolve(path)))];
}

function deny(reason: string): CursorDenyOutput {
  return { permission: "deny", agent_message: reason, user_message: reason };
}

function editReason(path: string): string {
  return [
    `Code edit blocked for ${path}: record a structured judgment first, then retry this exact edit.`,
    "Call the review_record_judgment MCP tool (or pipe JSON to ai-review-record) with",
    '{"targets":[{"path":"<repo-relative-path>","lineStart":1}],"judgment":"<decision>","rationale":"<why>"}.',
    "Required: targets[].path, targets[].lineStart, judgment, rationale; lineEnd is optional and contentHash is computed automatically.",
    "The Recorder must be running locally first (ai-review --data-dir ./.ai-review --port 4318, i.e. http://127.0.0.1:4318).",
    "See plugins/cursor/skills/record-before-edit/SKILL.md.",
  ].join(" ");
}

async function capturePermit(filePath: string, sessionId: string, repositoryRoot: string, options: PreToolUseOptions): Promise<CursorDenyOutput | null> {
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

export async function checkPreToolUse(input: CursorHookInput, options: PreToolUseOptions = {}): Promise<CursorDenyOutput | null> {
  const name = toolName(input);
  const normalized = name.toLowerCase();
  if (name === "Shell" || input.hook_event_name === "beforeShellExecution") {
    const command = shellCommandFromInput(input);
    if (command === null || !likelyCodeMutation(command)) return null;
    return deny("Shell command blocked because it may edit code. Record a judgment first with review_record_judgment, then use Write or StrReplace; arbitrary shell mutation is not accepted by the judgment gate.");
  }
  if (!EDIT_TOOLS.has(normalized)) return null;
  const filePaths = filePathsFromInput(input);
  if (filePaths.length === 0) return deny("Code edit blocked because the hook could not identify its target path; use Write or StrReplace with a file path after recording a judgment.");
  let sessionId: string;
  try {
    sessionId = sessionIdFromInput(input);
  } catch (error) {
    return deny(error instanceof Error ? error.message : String(error));
  }
  const repositoryRoot = workspaceRootFromInput(input);
  for (const filePath of filePaths) {
    const denied = await capturePermit(filePath, sessionId, repositoryRoot, options);
    if (denied !== null) return denied;
  }
  return null;
}

export async function checkPostToolUse(input: CursorHookInput, options: GateStorageOptions = {}): Promise<void> {
  const name = toolName(input);
  if (!EDIT_TOOLS.has(name.toLowerCase())) return;
  const filePaths = filePathsFromInput(input);
  if (filePaths.length === 0) return;
  let sessionId: string;
  try {
    sessionId = sessionIdFromInput(input);
  } catch {
    return;
  }
  const repositoryRoot = workspaceRootFromInput(input);
  for (const filePath of filePaths) {
    await consumeDecisionPermitAfterEdit({
      sessionId,
      repositoryRoot,
      filePath,
      gateRoot: options.gateRoot ?? defaultGateRoot(),
    });
  }
}

function sessionRegistration(root: string, sessionId: string): ReviewSession {
  return {
    session_id: sessionId,
    repository_id: repositoryId(root),
    agent_type: AGENT_TYPE,
    started_at: new Date().toISOString(),
    status: "active",
  };
}

const ADDITIONAL_CONTEXT = [
  "AI Code Review Evidence is active for this Cursor session.",
  "Before Write, StrReplace, ApplyPatch, Delete, or notebook edits, call the review_record_judgment MCP tool with targets, judgment, and rationale.",
  "The gate is fail-closed: an edit is allowed only after a matching one-use permit exists for the current file hash.",
  "Do not bypass the gate with Shell redirections, sed -i, git checkout, or a temporary allow-list.",
].join(" ");

export async function registerSession(sessionId: string, repositoryRoot: string, options: RegisterSessionOptions = {}): Promise<RegisteredSession> {
  if (typeof sessionId !== "string" || sessionId.trim().length === 0) {
    throw new Error("Cursor session id is unavailable; restart the session so the plugin can initialize it");
  }
  const canonicalRoot = await realpath(repositoryRoot).catch(() => repositoryRoot);
  const setupClient = options.setupClient ?? new RecorderSetupClient();
  const registered = await setupClient.ensureSession(canonicalRoot, sessionRegistration(canonicalRoot, sessionId));
  return {
    sessionId: registered.session.session_id,
    repositoryId: registered.repository.repository_id,
    repositoryRoot: canonicalRoot,
    registration: registered.session,
  };
}

export async function handleSessionStart(input: unknown, options: SessionStartOptions = {}): Promise<SessionStartResult> {
  const payload = (jsonRecord(input) ?? {}) as CursorHookInput;
  const sessionId = sessionIdFromInput(payload);
  const cwd = workspaceRootFromInput(payload);
  const canonicalRoot = await realpath(cwd).catch(() => cwd);
  await persistCursorSession(canonicalRoot, sessionId, options);
  try {
    await registerSession(sessionId, canonicalRoot, options);
  } catch (error) {
    options.onRegistrationError?.(error);
  }
  return {
    env: {
      AI_REVIEW_SESSION_ID: sessionId,
      AI_REVIEW_REPOSITORY_ROOT: canonicalRoot,
      AI_REVIEW_AGENT_TYPE: AGENT_TYPE,
    },
    additional_context: ADDITIONAL_CONTEXT,
  };
}

export async function recordDecision(value: unknown, options: RecordDecisionOptions = {}): Promise<RecordDecisionResult> {
  const proposal = jsonRecord(value);
  const proposalRoot = proposal !== null && typeof proposal.repositoryRoot === "string" ? proposal.repositoryRoot : undefined;
  const repositoryRoot = options.repositoryRoot ?? process.env.AI_REVIEW_REPOSITORY_ROOT ?? proposalRoot;
  const persisted = repositoryRoot === undefined ? undefined : await loadCursorSession(resolve(repositoryRoot), options);
  const sessionId = options.sessionId ?? process.env.AI_REVIEW_SESSION_ID ?? persisted;
  const event = await normalizeDecisionProposal(value, {
    ...(sessionId === undefined ? {} : { sessionId }),
    ...(repositoryRoot === undefined ? {} : { repositoryRoot }),
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

async function stdinText(): Promise<string> {
  return readBoundedStdin(Bun.stdin.stream());
}

export async function runPreEditHook(): Promise<void> {
  let input: CursorHookInput;
  try {
    input = JSON.parse(await stdinText()) as CursorHookInput;
  } catch {
    process.stdout.write(`${JSON.stringify(deny("hook input is not valid JSON"))}\n`);
    return;
  }
  try {
    await registerSession(sessionIdFromInput(input), workspaceRootFromInput(input));
  } catch {
    // Cloud agents skip sessionStart; a registration failure keeps the gate closed.
  }
  const result = await checkPreToolUse(input);
  if (result !== null) process.stdout.write(`${JSON.stringify(result)}\n`);
}

export async function runPostEditHook(): Promise<void> {
  try {
    await checkPostToolUse(JSON.parse(await stdinText()) as CursorHookInput);
  } catch {
    // Permit consumption must not fail the completed edit.
  }
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
  const warnings: string[] = [];
  try {
    const result = await handleSessionStart(JSON.parse(await stdinText()) as unknown, {
      onRegistrationError: (error) => {
        warnings.push(error instanceof Error ? error.message : String(error));
      },
    });
    process.stdout.write(`${JSON.stringify(result)}\n`);
    if (warnings.length > 0) process.stderr.write(`${warnings.join("\n")}\n`);
  } catch (error) {
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
    process.exitCode = 1;
  }
}
