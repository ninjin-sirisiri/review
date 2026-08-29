import type {
  ApiFailure,
  ApiSuccess,
  DiffHunk,
  DiffLine,
  SnapshotDiff,
  SnapshotDiffResponse,
  SnapshotEndpoint,
  WorkingTreeEndpoint,
} from "./api";
import { ERROR_CODES } from "./api";
import { AGENT_TYPES, type AgentType } from "./records";
import type {
  CheckEvidence,
  DecisionRecord,
  DecisionRecordInput,
  RevisionRef,
  ReviewSession,
  SnapshotCaptureKind,
  SnapshotReference,
  TargetReference,
  UserDisposition,
} from "./records";

export const MAX_TEXT_FIELD_LENGTH = 10_000;
export const MAX_IDENTIFIER_LENGTH = 256;
export const MAX_PATH_LENGTH = 4_096;

const DISPOSITIONS: Record<UserDisposition, true> = {
  unreviewed: true,
  accepted: true,
  rejected: true,
};
const AGENTS: Record<AgentType, true> = Object.fromEntries(AGENT_TYPES.map((type) => [type, true])) as Record<AgentType, true>;
const CHECK_STATUSES: Record<CheckEvidence["status"], true> = {
  passed: true,
  failed: true,
  "not-run": true,
};
const DIFF_LINE_TYPES: Record<DiffLine["type"], true> = {
  context: true,
  add: true,
  del: true,
};
const SESSION_STATUSES: Record<ReviewSession["status"], true> = {
  active: true,
  completed: true,
  failed: true,
};
const SNAPSHOT_MODES: Record<SnapshotReference["mode"], true> = {
  "changed-files": true,
  patch: true,
  git: true,
};
const ISO_UTC_TIMESTAMP_PATTERN = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})(?:\.(\d+))?Z$/;

function hasOwnKey<T extends Record<string, true>>(table: T, value: unknown): value is keyof T {
  return typeof value === "string" && Object.prototype.hasOwnProperty.call(table, value);
}

export interface ValidationIssue {
  field: string;
  message: string;
}

export type ValidationResult<T> = ApiSuccess<T> | ApiFailure;

function success<T>(data: T): ApiSuccess<T> {
  return { success: true, data };
}

function failure(
  code: (typeof ERROR_CODES)[keyof typeof ERROR_CODES],
  message: string,
  field?: string,
  details?: ValidationIssue[],
): ApiFailure {
  return {
    success: false,
    error: {
      code,
      message,
      ...(field ? { field } : {}),
      ...(details?.length ? { details } : {}),
    },
  };
}

function invalid(message: string, field?: string, details?: ValidationIssue[]): ApiFailure {
  return failure(ERROR_CODES.INVALID_RECORD, message, field, details);
}

export function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function hasOnlyKeys(value: Record<string, unknown>, allowed: readonly string[]): boolean {
  const permitted = new Set(allowed);
  return Object.keys(value).every((key) => permitted.has(key));
}

function nonEmptyString(value: unknown, field: string, maxLength = MAX_IDENTIFIER_LENGTH): ApiFailure | null {
  if (typeof value !== "string" || value.trim().length === 0) {
    return invalid(`${field} must be a non-empty string`, field);
  }
  if (value.length > maxLength) {
    return failure(ERROR_CODES.PAYLOAD_TOO_LARGE, `${field} exceeds the maximum length`, field);
  }
  return null;
}

function textField(value: unknown, field: string): ApiFailure | null {
  return nonEmptyString(value, field, MAX_TEXT_FIELD_LENGTH);
}

function stringField(value: unknown, field: string): ApiFailure | null {
  if (typeof value !== "string") return invalid(`${field} must be a string`, field);
  // Diff content is bounded by Recorder's configured source and diff-output byte limits.
  return null;
}

function positiveInteger(value: unknown, field: string): ApiFailure | null {
  if (!Number.isInteger(value) || (value as number) < 1) return invalid(`${field} must be a positive integer`, field);
  return null;
}

function nullablePositiveInteger(value: unknown, field: string): ApiFailure | null {
  return value === null ? null : positiveInteger(value, field);
}

function booleanField(value: unknown, field: string): ApiFailure | null {
  return typeof value === "boolean" ? null : invalid(`${field} must be a boolean`, field);
}

function timestamp(value: unknown, field: string, optional = false): ApiFailure | null {
  if (value === undefined && optional) return null;
  const stringError = nonEmptyString(value, field, 128);
  if (stringError) return stringError;
  const match = ISO_UTC_TIMESTAMP_PATTERN.exec(value as string);
  const parsedTime = Date.parse(value as string);
  if (!match || !Number.isFinite(parsedTime)) {
    return invalid(`${field} must be an ISO-8601 UTC timestamp`, field);
  }
  const parsedDate = new Date(parsedTime);
  const milliseconds = Number((match[7] ?? "").slice(0, 3).padEnd(3, "0") || "0");
  if (
    parsedDate.getUTCFullYear() !== Number(match[1]) ||
    parsedDate.getUTCMonth() + 1 !== Number(match[2]) ||
    parsedDate.getUTCDate() !== Number(match[3]) ||
    parsedDate.getUTCHours() !== Number(match[4]) ||
    parsedDate.getUTCMinutes() !== Number(match[5]) ||
    parsedDate.getUTCSeconds() !== Number(match[6]) ||
    parsedDate.getUTCMilliseconds() !== milliseconds
  ) {
    return invalid(`${field} must be a valid ISO-8601 UTC timestamp`, field);
  }
  return null;
}
function firstError(...errors: Array<ApiFailure | null>): ApiFailure | null {
  return errors.find((error): error is ApiFailure => error !== null) ?? null;
}

function normalizeRelativePath(value: unknown, field: string): ValidationResult<string> {
  const stringError = nonEmptyString(value, field, MAX_PATH_LENGTH);
  if (stringError) return stringError;
  const original = value as string;
  const slashPath = original.replaceAll("\\", "/");
  if (slashPath.startsWith("/") || slashPath.startsWith("//")) {
    return failure(ERROR_CODES.PATH_OUTSIDE_ROOT, `${field} must be relative to the repository root`, field);
  }

  const segments: string[] = [];
  for (const segment of slashPath.split("/")) {
    if (segment === "" || segment === ".") continue;
    if (segment === "..") {
      return failure(ERROR_CODES.PATH_OUTSIDE_ROOT, `${field} cannot escape the repository root`, field);
    }
    segments.push(segment);
  }
  if (segments.length === 0) return failure(ERROR_CODES.PATH_OUTSIDE_ROOT, `${field} must name a file`, field);
  const normalizedPath = segments.join("/");
  if (/^[A-Za-z]:/.test(normalizedPath)) {
    return failure(ERROR_CODES.PATH_OUTSIDE_ROOT, `${field} must be relative to the repository root`, field);
  }
  return success(normalizedPath);
}

export function validateRevisionRef(value: unknown): ValidationResult<RevisionRef> {
  if (!isRecord(value) || typeof value.kind !== "string") {
    return invalid("revision must be a commit or working-tree reference", "revision");
  }
  if (value.kind === "commit") {
    if (!hasOnlyKeys(value, ["kind", "sha"])) {
      return invalid("commit revision must contain only kind and sha", "revision");
    }
    const error = nonEmptyString(value.sha, "revision.sha", 128);
    return error ? error : success({ kind: "commit", sha: value.sha as string });
  }
  if (value.kind === "working-tree") {
    if (!hasOnlyKeys(value, ["kind", "contentHash"])) {
      return invalid("working-tree revision must contain only kind and contentHash", "revision");
    }
    const error = nonEmptyString(value.contentHash, "revision.contentHash", 128);
    return error ? error : success({ kind: "working-tree", contentHash: value.contentHash as string });
  }
  return invalid("revision.kind must be commit or working-tree", "revision.kind");
}

function validateCheck(value: unknown, index: number): ValidationResult<CheckEvidence> {
  const field = `checks[${index}]`;
  if (!isRecord(value) || !hasOnlyKeys(value, ["name", "status", "details"])) {
    return invalid(`${field} has an unsupported field`, field);
  }
  const error = firstError(textField(value.name, `${field}.name`), value.details === undefined ? null : textField(value.details, `${field}.details`));
  if (error) return error;
  if (typeof value.status !== "string" || !hasOwnKey(CHECK_STATUSES, value.status)) {
    return invalid(`${field}.status must be passed, failed, or not-run`, `${field}.status`);
  }
  return success({
    name: value.name as string,
    status: value.status as CheckEvidence["status"],
    ...(value.details === undefined ? {} : { details: value.details as string }),
  });
}

export function validateTargetReference(value: unknown): ValidationResult<TargetReference> {
  if (!isRecord(value) || !hasOnlyKeys(value, ["repository_id", "path", "line_start", "line_end", "revision", "content_hash"])) {
    return invalid("target has an unsupported field", "targets");
  }
  const repositoryError = nonEmptyString(value.repository_id, "target.repository_id");
  if (repositoryError) return repositoryError;
  const pathResult = normalizeRelativePath(value.path, "target.path");
  if (!pathResult.success) return pathResult;
  if (!Number.isInteger(value.line_start) || (value.line_start as number) < 1) {
    return invalid("target.line_start must be a positive integer", "target.line_start");
  }
  if (!Number.isInteger(value.line_end) || (value.line_end as number) < (value.line_start as number)) {
    return invalid("target.line_end must be an integer at or after line_start", "target.line_end");
  }
  const revisionResult = validateRevisionRef(value.revision);
  if (!revisionResult.success) return revisionResult;
  const hashError = nonEmptyString(value.content_hash, "target.content_hash", 128);
  if (hashError) return hashError;
  return success({
    repository_id: value.repository_id as string,
    path: pathResult.data,
    line_start: value.line_start as number,
    line_end: value.line_end as number,
    revision: revisionResult.data,
    content_hash: value.content_hash as string,
  });
}

const DECISION_KEYS = [
  "record_id",
  "session_id",
  "repository_id",
  "agent_type",
  "revision",
  "targets",
  "judgment",
  "rationale",
  "checks",
  "open_questions",
  "created_at",
  "user_disposition",
] as const;

export function validateDecisionRecordInput(value: unknown): ValidationResult<DecisionRecordInput> {
  if (!isRecord(value)) return invalid("decision record must be an object");
  if (!hasOnlyKeys(value, DECISION_KEYS)) {
    const unexpected = Object.keys(value).find((key) => !DECISION_KEYS.includes(key as (typeof DECISION_KEYS)[number]));
    return invalid("decision record contains an unsupported field", unexpected);
  }

  const requiredError = firstError(
    nonEmptyString(value.record_id, "record_id"),
    nonEmptyString(value.session_id, "session_id"),
    nonEmptyString(value.repository_id, "repository_id"),
    textField(value.judgment, "judgment"),
    textField(value.rationale, "rationale"),
    timestamp(value.created_at, "created_at"),
  );
  if (requiredError) return requiredError;

  if (typeof value.agent_type !== "string" || !hasOwnKey(AGENTS, value.agent_type)) {
    return invalid("agent_type must be claude-code, codex, opencode, or cursor", "agent_type");
  }
  const revisionResult = validateRevisionRef(value.revision);
  if (!revisionResult.success) return revisionResult;
  if (!Array.isArray(value.targets) || value.targets.length === 0) {
    return invalid("targets must contain at least one target", "targets");
  }
  const targets: TargetReference[] = [];
  for (let index = 0; index < value.targets.length; index += 1) {
    const result = validateTargetReference(value.targets[index]);
    if (!result.success) return result;
    targets.push(result.data);
  }
  if (!Array.isArray(value.checks)) return invalid("checks must be an array", "checks");
  const checks: CheckEvidence[] = [];
  for (let index = 0; index < value.checks.length; index += 1) {
    const result = validateCheck(value.checks[index], index);
    if (!result.success) return result;
    checks.push(result.data);
  }
  if (!Array.isArray(value.open_questions)) return invalid("open_questions must be an array", "open_questions");
  const openQuestions: string[] = [];
  for (let index = 0; index < value.open_questions.length; index += 1) {
    const error = textField(value.open_questions[index], `open_questions[${index}]`);
    if (error) return error;
    openQuestions.push(value.open_questions[index] as string);
  }
  if (value.user_disposition !== undefined && (typeof value.user_disposition !== "string" || !hasOwnKey(DISPOSITIONS, value.user_disposition))) {
    return invalid("user_disposition must be unreviewed, accepted, or rejected", "user_disposition");
  }

  return success({
    record_id: value.record_id as string,
    session_id: value.session_id as string,
    repository_id: value.repository_id as string,
    agent_type: value.agent_type as AgentType,
    revision: revisionResult.data,
    targets,
    judgment: value.judgment as string,
    rationale: value.rationale as string,
    checks,
    open_questions: openQuestions,
    created_at: value.created_at as string,
    ...(value.user_disposition === undefined ? {} : { user_disposition: value.user_disposition as UserDisposition }),
  });
}

export function validateDecisionRecord(value: unknown): ValidationResult<DecisionRecord> {
  const result = validateDecisionRecordInput(value);
  if (!result.success) return result;
  if (result.data.user_disposition === undefined) {
    return success({ ...result.data, user_disposition: "unreviewed" });
  }
  return success(result.data as DecisionRecord);
}

export function validateReviewSession(value: unknown): ValidationResult<ReviewSession> {
  if (!isRecord(value) || !hasOnlyKeys(value, ["session_id", "repository_id", "agent_type", "started_at", "ended_at", "status"])) {
    return invalid("review session has an unsupported field");
  }
  const requiredError = firstError(
    nonEmptyString(value.session_id, "session_id"),
    nonEmptyString(value.repository_id, "repository_id"),
    timestamp(value.started_at, "started_at"),
    timestamp(value.ended_at, "ended_at", true),
  );
  if (requiredError) return requiredError;
  if (typeof value.agent_type !== "string" || !hasOwnKey(AGENTS, value.agent_type)) return invalid("agent_type is invalid", "agent_type");
  if (typeof value.status !== "string" || !hasOwnKey(SESSION_STATUSES, value.status)) return invalid("status is invalid", "status");
  return success({
    session_id: value.session_id as string,
    repository_id: value.repository_id as string,
    agent_type: value.agent_type as AgentType,
    started_at: value.started_at as string,
    ...(value.ended_at === undefined ? {} : { ended_at: value.ended_at as string }),
    status: value.status as ReviewSession["status"],
  });
}

export function validateSnapshotReference(value: unknown): ValidationResult<SnapshotReference> {
  if (!isRecord(value) || !hasOnlyKeys(value, ["snapshot_id", "record_id", "mode", "path", "content_hash", "created_at", "base_sha", "source_path", "capture_kind", "before_missing"])) {
    return invalid("snapshot reference has an unsupported field");
  }
  const requiredError = firstError(
    nonEmptyString(value.snapshot_id, "snapshot_id"),
    nonEmptyString(value.record_id, "record_id"),
    nonEmptyString(value.content_hash, "content_hash", 128),
    timestamp(value.created_at, "created_at"),
  );
  if (requiredError) return requiredError;
  if (typeof value.mode !== "string" || !hasOwnKey(SNAPSHOT_MODES, value.mode)) return invalid("mode is invalid", "mode");
  const mode = value.mode as SnapshotReference["mode"];
  const captureKind = value.capture_kind;
  if (captureKind !== undefined && captureKind !== "manual" && captureKind !== "automatic") {
    return invalid("capture_kind is invalid", "capture_kind");
  }
  if (value.before_missing !== undefined && typeof value.before_missing !== "boolean") {
    return invalid("before_missing must be a boolean", "before_missing");
  }
  if (captureKind !== "automatic" && value.before_missing !== undefined) {
    return invalid("before_missing is only allowed on automatic snapshots", "before_missing");
  }
  if (mode === "git") {
    if (typeof value.base_sha !== "string" || !/^[0-9a-f]{40}$/.test(value.base_sha)) {
      return invalid("base_sha must be a lowercase 40-character commit SHA for git snapshots", "base_sha");
    }
    const sourcePathResult = normalizeRelativePath(value.source_path, "source_path");
    if (!sourcePathResult.success) return sourcePathResult;
    if (value.path !== "") return invalid("path must be empty for git-backed snapshots", "path");
    if (captureKind === "automatic" && typeof value.before_missing !== "boolean") {
      return invalid("before_missing is required for automatic snapshots", "before_missing");
    }
    return success({
      snapshot_id: value.snapshot_id as string,
      record_id: value.record_id as string,
      mode,
      path: "",
      content_hash: value.content_hash as string,
      created_at: value.created_at as string,
      base_sha: value.base_sha,
      source_path: sourcePathResult.data,
      ...(captureKind === undefined ? {} : { capture_kind: captureKind as SnapshotCaptureKind }),
      ...(captureKind === "automatic" ? { before_missing: value.before_missing as boolean } : {}),
    });
  }
  if (value.base_sha !== undefined) {
    return invalid("base_sha is only allowed on git-backed snapshots", "base_sha");
  }
  const pathResult = normalizeRelativePath(value.path, "path");
  if (!pathResult.success) return pathResult;
  if (captureKind === "automatic") {
    const sourcePathResult = normalizeRelativePath(value.source_path, "source_path");
    if (!sourcePathResult.success) return sourcePathResult;
    if (typeof value.before_missing !== "boolean") return invalid("before_missing is required for automatic snapshots", "before_missing");
    return success({
      snapshot_id: value.snapshot_id as string,
      record_id: value.record_id as string,
      mode,
      path: pathResult.data,
      content_hash: value.content_hash as string,
      created_at: value.created_at as string,
      source_path: sourcePathResult.data,
      capture_kind: "automatic",
      before_missing: value.before_missing,
    });
  }
  if (value.source_path !== undefined) {
    return invalid("source_path is only allowed on automatic snapshots", "source_path");
  }
  return success({
    snapshot_id: value.snapshot_id as string,
    record_id: value.record_id as string,
    mode,
    path: pathResult.data,
    content_hash: value.content_hash as string,
    created_at: value.created_at as string,
    ...(captureKind === undefined ? {} : { capture_kind: captureKind as SnapshotCaptureKind }),
  });
}

function validateDiffLine(value: unknown, hunkIndex: number, lineIndex: number): ValidationResult<DiffLine> {
  const field = `hunks[${hunkIndex}].lines[${lineIndex}]`;
  if (!isRecord(value) || !hasOnlyKeys(value, ["type", "oldLine", "newLine", "content"])) {
    return invalid(`${field} has an unsupported field`, field);
  }
  const requiredError = firstError(
    nullablePositiveInteger(value.oldLine, `${field}.oldLine`),
    nullablePositiveInteger(value.newLine, `${field}.newLine`),
    stringField(value.content, `${field}.content`),
  );
  if (requiredError) return requiredError;
  if (typeof value.type !== "string" || !hasOwnKey(DIFF_LINE_TYPES, value.type)) {
    return invalid(`${field}.type must be context, add, or del`, `${field}.type`);
  }

  const type = value.type as DiffLine["type"];
  const oldLine = value.oldLine as number | null;
  const newLine = value.newLine as number | null;
  const lineShapeIsValid = type === "context"
    ? oldLine !== null && newLine !== null
    : type === "add"
      ? oldLine === null && newLine !== null
      : oldLine !== null && newLine === null;
  if (!lineShapeIsValid) return invalid(`${field} line numbers do not match its type`, field);

  return success({ type, oldLine, newLine, content: value.content as string });
}

function validateDiffHunk(value: unknown, hunkIndex: number): ValidationResult<DiffHunk> {
  const field = `hunks[${hunkIndex}]`;
  if (!isRecord(value) || !hasOnlyKeys(value, ["oldStart", "newStart", "lines"])) {
    return invalid(`${field} has an unsupported field`, field);
  }
  const requiredError = firstError(
    positiveInteger(value.oldStart, `${field}.oldStart`),
    positiveInteger(value.newStart, `${field}.newStart`),
  );
  if (requiredError) return requiredError;
  if (!Array.isArray(value.lines)) return invalid(`${field}.lines must be an array`, `${field}.lines`);
  if (value.lines.length === 0) return invalid(`${field}.lines must contain at least one line`, `${field}.lines`);

  const lines: DiffLine[] = [];
  for (let lineIndex = 0; lineIndex < value.lines.length; lineIndex += 1) {
    const result = validateDiffLine(value.lines[lineIndex], hunkIndex, lineIndex);
    if (!result.success) return result;
    lines.push(result.data);
  }
  return success({ oldStart: value.oldStart as number, newStart: value.newStart as number, lines });
}

function validateSnapshotEndpoint(value: unknown): ValidationResult<SnapshotEndpoint> {
  if (!isRecord(value) || !hasOnlyKeys(value, ["kind", "snapshot_id", "record_id", "created_at", "content_hash", "source_path", "base_sha"])) {
    return invalid("snapshot endpoint has an unsupported field", "from");
  }
  const requiredError = firstError(
    nonEmptyString(value.snapshot_id, "from.snapshot_id"),
    nonEmptyString(value.record_id, "from.record_id"),
    timestamp(value.created_at, "from.created_at"),
    nonEmptyString(value.content_hash, "from.content_hash", 128),
    value.base_sha === undefined ? null : nonEmptyString(value.base_sha, "from.base_sha", 128),
  );
  if (requiredError) return requiredError;
  if (value.kind !== "snapshot") return invalid("snapshot endpoint kind must be snapshot", "from.kind");
  const sourcePathResult = normalizeRelativePath(value.source_path, "from.source_path");
  if (!sourcePathResult.success) return sourcePathResult;
  return success({
    kind: "snapshot",
    snapshot_id: value.snapshot_id as string,
    record_id: value.record_id as string,
    created_at: value.created_at as string,
    content_hash: value.content_hash as string,
    source_path: sourcePathResult.data,
    ...(value.base_sha === undefined ? {} : { base_sha: value.base_sha as string }),
  });
}

function validateWorkingTreeEndpoint(value: unknown): ValidationResult<WorkingTreeEndpoint> {
  if (!isRecord(value) || !hasOnlyKeys(value, ["kind"]) || value.kind !== "working-tree") {
    return invalid("working-tree endpoint must contain only kind", "to");
  }
  return success({ kind: "working-tree" });
}

function validateSnapshotResolved(value: Record<string, unknown>): ValidationResult<SnapshotDiff> {
  if (!hasOnlyKeys(value, ["state", "path", "from", "to", "hunks", "old_missing", "new_missing", "binary"])) {
    return invalid("snapshot-resolved response has an unsupported field");
  }
  const pathResult = normalizeRelativePath(value.path, "path");
  if (!pathResult.success) return pathResult;
  const fromResult = validateSnapshotEndpoint(value.from);
  if (!fromResult.success) return fromResult;

  let toResult: ValidationResult<SnapshotEndpoint | WorkingTreeEndpoint>;
  if (isRecord(value.to) && value.to.kind === "snapshot") {
    toResult = validateSnapshotEndpoint(value.to);
  } else {
    toResult = validateWorkingTreeEndpoint(value.to);
  }
  if (!toResult.success) return toResult;

  const requiredError = firstError(
    booleanField(value.old_missing, "old_missing"),
    booleanField(value.new_missing, "new_missing"),
    booleanField(value.binary, "binary"),
  );
  if (requiredError) return requiredError;
  if (!Array.isArray(value.hunks)) return invalid("hunks must be an array", "hunks");
  if (value.binary === true && value.hunks.length > 0) return invalid("binary snapshot diffs must not contain hunks", "hunks");

  const hunks: DiffHunk[] = [];
  for (let hunkIndex = 0; hunkIndex < value.hunks.length; hunkIndex += 1) {
    const result = validateDiffHunk(value.hunks[hunkIndex], hunkIndex);
    if (!result.success) return result;
    hunks.push(result.data);
  }
  return success({
    state: "snapshot-resolved",
    path: pathResult.data,
    from: fromResult.data,
    to: toResult.data,
    hunks,
    old_missing: value.old_missing as boolean,
    new_missing: value.new_missing as boolean,
    binary: value.binary as boolean,
  });
}

function validateLegacyFallback(value: Record<string, unknown>): ValidationResult<Extract<SnapshotDiffResponse, { state: "legacy-fallback" }>> {
  if (!hasOnlyKeys(value, ["state", "reason", "path"])) return invalid("legacy-fallback response has an unsupported field");
  if (value.reason !== "automatic-snapshot-not-found") return invalid("legacy-fallback reason is invalid", "reason");
  const pathResult = normalizeRelativePath(value.path, "path");
  if (!pathResult.success) return pathResult;
  return success({ state: "legacy-fallback", reason: "automatic-snapshot-not-found", path: pathResult.data });
}

function validateSnapshotFailure(value: Record<string, unknown>): ValidationResult<Extract<SnapshotDiffResponse, { state: "source-unavailable" | "revision-not-found" }>> {
  if (!hasOnlyKeys(value, ["state", "path", "message"])) return invalid("snapshot failure response has an unsupported field");
  if (value.state !== "source-unavailable" && value.state !== "revision-not-found") {
    return invalid("snapshot failure state is invalid", "state");
  }
  const pathResult = normalizeRelativePath(value.path, "path");
  if (!pathResult.success) return pathResult;
  const messageError = textField(value.message, "message");
  if (messageError) return messageError;
  return success({ state: value.state, path: pathResult.data, message: value.message as string });
}

export function validateSnapshotDiffResponse(value: unknown): ValidationResult<SnapshotDiffResponse> {
  if (!isRecord(value)) return invalid("snapshot diff response must be an object");
  if (value.state === "snapshot-resolved") return validateSnapshotResolved(value);
  if (value.state === "legacy-fallback") return validateLegacyFallback(value);
  if (value.state === "source-unavailable" || value.state === "revision-not-found") return validateSnapshotFailure(value);
  return invalid("snapshot diff response state is invalid", "state");
}

export class ContractValidationError extends Error {
  readonly code: ApiFailure["error"]["code"];
  readonly field: string | undefined;

  constructor(result: ApiFailure) {
    super(result.error.message);
    this.name = "ContractValidationError";
    this.code = result.error.code;
    this.field = result.error.field;
  }
}

export function parseDecisionRecordInput(value: unknown): DecisionRecordInput {
  const result = validateDecisionRecordInput(value);
  if (!result.success) throw new ContractValidationError(result);
  return result.data;
}

export function parseSnapshotDiffResponse(value: unknown): SnapshotDiffResponse {
  const result = validateSnapshotDiffResponse(value);
  if (!result.success) throw new ContractValidationError(result);
  return result.data;
}
