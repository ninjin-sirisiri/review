import { createHash } from "node:crypto";
import { isAbsolute } from "node:path";
import {
  ContractValidationError,
  isRecord,
  parseDecisionRecordInput,
  validateRevisionRef,
  type AgentType,
  type CheckEvidence,
  type DecisionRecordInput,
  type RevisionRef,
} from "../../../packages/contracts/src/index";
import { RecorderBridge } from "./bridge";

export interface HostTargetReference {
  path: string;
  lineStart: number;
  lineEnd: number;
  revision: RevisionRef;
  contentHash: string;
}

export interface HostDecisionEvent {
  sessionId: string;
  repositoryRoot: string;
  revision: RevisionRef;
  targets: HostTargetReference[];
  judgment: string;
  rationale: string;
  checks: CheckEvidence[];
  openQuestions: string[];
  /** Optional host-provided stable id; otherwise one is derived from the event. */
  recordId?: string;
  /** Optional host timestamp; otherwise the adapter records receipt time. */
  createdAt?: string;
}

export interface SubmitSuccess {
  success: true;
  status: number;
  duplicate: boolean;
  recordId: string;
}

export interface SubmitFailure {
  success: false;
  code: string;
  message: string;
  /** Alias retained for JSONL consumers that use an error field. */
  error: string;
  recordId: string;
  attempts: number;
  status?: number;
}

export type SubmitResult = SubmitSuccess | SubmitFailure;

export interface AdapterBridge {
  submit(record: DecisionRecordInput): Promise<SubmitResult>;
}

export interface JsonLineInput extends AsyncIterable<string | Uint8Array> {}

export interface JsonLineOutput {
  write(chunk: string): unknown;
}

const EVENT_KEYS = [
  "sessionId",
  "repositoryRoot",
  "revision",
  "targets",
  "judgment",
  "rationale",
  "checks",
  "openQuestions",
  "recordId",
  "createdAt",
] as const;
const TARGET_KEYS = ["path", "lineStart", "lineEnd", "revision", "contentHash"] as const;
const MAX_EVENT_LINE_BYTES = 1_000_000;

function fail(message: string, field?: string): never {
  const suffix = field === undefined ? "" : ` (${field})`;
  throw new HostEventValidationError(`${message}${suffix}`);
}

function onlyKeys(value: Record<string, unknown>, allowed: readonly string[], label: string): void {
  const unexpected = Object.keys(value).find((key) => !allowed.includes(key));
  if (unexpected !== undefined) fail("host event contains an unsupported field", `${label}.${unexpected}`);
}

function requiredString(value: unknown, field: string): string {
  if (typeof value !== "string" || value.trim().length === 0) fail("host event requires a non-empty string", field);
  return value;
}

function revision(value: unknown, field: string): RevisionRef {
  const result = validateRevisionRef(value);
  if (!result.success) fail(result.error.message, field);
  return result.data;
}

function normalizedEvent(value: unknown): HostDecisionEvent {
  if (!isRecord(value)) fail("host event must be an object");
  onlyKeys(value, EVENT_KEYS, "event");
  const sessionId = requiredString(value.sessionId, "sessionId");
  const repositoryRoot = requiredString(value.repositoryRoot, "repositoryRoot");
  if (!isAbsolute(repositoryRoot)) fail("repositoryRoot must be an absolute path", "repositoryRoot");
  const eventRevision = revision(value.revision, "revision");
  if (!Array.isArray(value.targets) || value.targets.length === 0) fail("targets must contain at least one target", "targets");
  const targets: HostTargetReference[] = value.targets.map((candidate, index) => {
    if (!isRecord(candidate)) fail("target must be an object", `targets[${index}]`);
    onlyKeys(candidate, TARGET_KEYS, `targets[${index}]`);
    const path = requiredString(candidate.path, `targets[${index}].path`);
    if (!Number.isSafeInteger(candidate.lineStart) || (candidate.lineStart as number) < 1) fail("lineStart must be a positive integer", `targets[${index}].lineStart`);
    if (!Number.isSafeInteger(candidate.lineEnd) || (candidate.lineEnd as number) < (candidate.lineStart as number)) fail("lineEnd must be at or after lineStart", `targets[${index}].lineEnd`);
    const contentHash = requiredString(candidate.contentHash, `targets[${index}].contentHash`);
    return {
      path,
      lineStart: candidate.lineStart as number,
      lineEnd: candidate.lineEnd as number,
      revision: revision(candidate.revision, `targets[${index}].revision`),
      contentHash,
    };
  });
  if (!Array.isArray(value.checks)) fail("checks must be an array", "checks");
  if (!Array.isArray(value.openQuestions)) fail("openQuestions must be an array", "openQuestions");
  const openQuestions = value.openQuestions.map((question, index) => requiredString(question, `openQuestions[${index}]`));
  const checks = value.checks.map((candidate, index): CheckEvidence => {
    if (!isRecord(candidate)) fail("check must be an object", `checks[${index}]`);
    onlyKeys(candidate, ["name", "status", "details"], `checks[${index}]`);
    const name = requiredString(candidate.name, `checks[${index}].name`);
    const status = candidate.status;
    if (status !== "passed" && status !== "failed" && status !== "not-run") fail("check status is invalid", `checks[${index}].status`);
    if (candidate.details !== undefined && typeof candidate.details !== "string") fail("check details must be a string", `checks[${index}].details`);
    return candidate.details === undefined
      ? { name, status }
      : { name, status, details: candidate.details };
  });
  const recordId = value.recordId === undefined ? undefined : requiredString(value.recordId, "recordId");
  const createdAt = value.createdAt === undefined ? undefined : requiredString(value.createdAt, "createdAt");
  return {
    sessionId,
    repositoryRoot,
    revision: eventRevision,
    targets,
    judgment: requiredString(value.judgment, "judgment"),
    rationale: requiredString(value.rationale, "rationale"),
    checks,
    openQuestions,
    ...(recordId === undefined ? {} : { recordId }),
    ...(createdAt === undefined ? {} : { createdAt }),
  };
}

export class HostEventValidationError extends Error {
  readonly code = "INVALID_RECORD" as const;

  constructor(message: string) {
    super(message);
    this.name = "HostEventValidationError";
  }
}

function repositoryId(repositoryRoot: string): string {
  return createHash("sha256").update(repositoryRoot, "utf8").digest("hex");
}

function derivedRecordId(input: Omit<DecisionRecordInput, "record_id" | "created_at">): string {
  const { agent_type: _agentType, ...identity } = input;
  return createHash("sha256").update(JSON.stringify(identity), "utf8").digest("hex");
}

export function mapHostEvent(agentType: AgentType, value: unknown): DecisionRecordInput {
  let event: HostDecisionEvent;
  try {
    event = normalizedEvent(value);
  } catch (error) {
    if (error instanceof HostEventValidationError) throw error;
    throw new HostEventValidationError(error instanceof Error ? error.message : String(error));
  }
  const canonicalWithoutIdentity = {
    session_id: event.sessionId,
    repository_id: repositoryId(event.repositoryRoot),
    agent_type: agentType,
    revision: event.revision,
    targets: event.targets.map((target) => ({
      repository_id: repositoryId(event.repositoryRoot),
      path: target.path,
      line_start: target.lineStart,
      line_end: target.lineEnd,
      revision: target.revision,
      content_hash: target.contentHash,
    })),
    judgment: event.judgment,
    rationale: event.rationale,
    checks: event.checks,
    open_questions: event.openQuestions,
  } satisfies Omit<DecisionRecordInput, "record_id" | "created_at">;
  const record = {
    ...canonicalWithoutIdentity,
    record_id: event.recordId ?? derivedRecordId(canonicalWithoutIdentity),
    created_at: event.createdAt ?? new Date().toISOString(),
  };
  try {
    return parseDecisionRecordInput(record);
  } catch (error) {
    if (error instanceof ContractValidationError) throw new HostEventValidationError(error.message);
    throw error;
  }
}

function adapterError(error: unknown): SubmitFailure {
  const message = error instanceof Error ? error.message : String(error);
  const code = error instanceof HostEventValidationError || error instanceof SyntaxError ? "INVALID_RECORD" : "ADAPTER_ERROR";
  return { success: false, code, message, error: message, recordId: "", attempts: 0 };
}

async function writeResult(output: JsonLineOutput, result: SubmitResult): Promise<void> {
  const writeResult = output.write(`${JSON.stringify(result)}\n`);
  if (writeResult instanceof Promise) await writeResult;
}

export async function runAdapter(
  agentType: AgentType,
  stdin: JsonLineInput,
  stdout: JsonLineOutput,
  bridge?: AdapterBridge,
): Promise<void> {
  const recorder = bridge ?? new RecorderBridge();
  const decoder = new TextDecoder();
  const encoder = new TextEncoder();
  let buffer = "";
  let oversized = false;
  const processLine = async (line: string): Promise<void> => {
    if (line.length === 0) {
      await writeResult(stdout, { success: false, code: "INVALID_RECORD", message: "input line is empty", error: "input line is empty", recordId: "", attempts: 0 });
      return;
    }
    if (encoder.encode(line).byteLength > MAX_EVENT_LINE_BYTES) {
      await writeResult(stdout, { success: false, code: "PAYLOAD_TOO_LARGE", message: "input line exceeds the adapter limit", error: "input line exceeds the adapter limit", recordId: "", attempts: 0 });
      return;
    }
    try {
      const record = mapHostEvent(agentType, JSON.parse(line) as unknown);
      await writeResult(stdout, await recorder.submit(record));
    } catch (error) {
      await writeResult(stdout, adapterError(error));
    }
  };
  for await (const chunk of stdin) {
    buffer += typeof chunk === "string" ? chunk : decoder.decode(chunk, { stream: true });
    let newline = buffer.indexOf("\n");
    while (newline >= 0) {
      const line = buffer.slice(0, newline).replace(/\r$/, "");
      buffer = buffer.slice(newline + 1);
      if (oversized) {
        oversized = false;
        await processLine(`${"x".repeat(MAX_EVENT_LINE_BYTES + 1)}`);
      } else {
        await processLine(line);
      }
      newline = buffer.indexOf("\n");
    }
    if (encoder.encode(buffer).byteLength > MAX_EVENT_LINE_BYTES) {
      oversized = true;
      buffer = "";
    }
  }
  buffer += decoder.decode();
  if (buffer.length > 0 || oversized) {
    await processLine(oversized ? `${"x".repeat(MAX_EVENT_LINE_BYTES + 1)}` : buffer.replace(/\r$/, ""));
  }
}
