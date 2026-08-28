// @bun
// plugins/common/src/adapter-contract.ts
import { createHash } from "crypto";
import { isAbsolute } from "path";

// packages/contracts/src/api.ts
var ERROR_CODES = {
  UNAUTHORIZED: "UNAUTHORIZED",
  INVALID_RECORD: "INVALID_RECORD",
  REPOSITORY_NOT_REGISTERED: "REPOSITORY_NOT_REGISTERED",
  PATH_OUTSIDE_ROOT: "PATH_OUTSIDE_ROOT",
  REVISION_NOT_FOUND: "REVISION_NOT_FOUND",
  HASH_MISMATCH: "HASH_MISMATCH",
  SOURCE_UNAVAILABLE: "SOURCE_UNAVAILABLE",
  DUPLICATE_RECORD: "DUPLICATE_RECORD",
  PAYLOAD_TOO_LARGE: "PAYLOAD_TOO_LARGE"
};
// packages/contracts/src/validation.ts
var MAX_TEXT_FIELD_LENGTH = 1e4;
var MAX_IDENTIFIER_LENGTH = 256;
var MAX_PATH_LENGTH = 4096;
var DISPOSITIONS = {
  unreviewed: true,
  accepted: true,
  rejected: true
};
var AGENTS = {
  "claude-code": true,
  codex: true,
  opencode: true
};
var CHECK_STATUSES = {
  passed: true,
  failed: true,
  "not-run": true
};
var SESSION_STATUSES = {
  active: true,
  completed: true,
  failed: true
};
var ISO_UTC_TIMESTAMP_PATTERN = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})(?:\.(\d+))?Z$/;
function hasOwnKey(table, value) {
  return typeof value === "string" && Object.prototype.hasOwnProperty.call(table, value);
}
function success(data) {
  return { success: true, data };
}
function failure(code, message, field, details) {
  return {
    success: false,
    error: {
      code,
      message,
      ...field ? { field } : {},
      ...details?.length ? { details } : {}
    }
  };
}
function invalid(message, field, details) {
  return failure(ERROR_CODES.INVALID_RECORD, message, field, details);
}
function isRecord(value) {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
function hasOnlyKeys(value, allowed) {
  const permitted = new Set(allowed);
  return Object.keys(value).every((key) => permitted.has(key));
}
function nonEmptyString(value, field, maxLength = MAX_IDENTIFIER_LENGTH) {
  if (typeof value !== "string" || value.trim().length === 0) {
    return invalid(`${field} must be a non-empty string`, field);
  }
  if (value.length > maxLength) {
    return failure(ERROR_CODES.PAYLOAD_TOO_LARGE, `${field} exceeds the maximum length`, field);
  }
  return null;
}
function textField(value, field) {
  return nonEmptyString(value, field, MAX_TEXT_FIELD_LENGTH);
}
function timestamp(value, field, optional = false) {
  if (value === undefined && optional)
    return null;
  const stringError = nonEmptyString(value, field, 128);
  if (stringError)
    return stringError;
  const match = ISO_UTC_TIMESTAMP_PATTERN.exec(value);
  const parsedTime = Date.parse(value);
  if (!match || !Number.isFinite(parsedTime)) {
    return invalid(`${field} must be an ISO-8601 UTC timestamp`, field);
  }
  const parsedDate = new Date(parsedTime);
  const milliseconds = Number((match[7] ?? "").slice(0, 3).padEnd(3, "0") || "0");
  if (parsedDate.getUTCFullYear() !== Number(match[1]) || parsedDate.getUTCMonth() + 1 !== Number(match[2]) || parsedDate.getUTCDate() !== Number(match[3]) || parsedDate.getUTCHours() !== Number(match[4]) || parsedDate.getUTCMinutes() !== Number(match[5]) || parsedDate.getUTCSeconds() !== Number(match[6]) || parsedDate.getUTCMilliseconds() !== milliseconds) {
    return invalid(`${field} must be a valid ISO-8601 UTC timestamp`, field);
  }
  return null;
}
function firstError(...errors) {
  return errors.find((error) => error !== null) ?? null;
}
function normalizeRelativePath(value, field) {
  const stringError = nonEmptyString(value, field, MAX_PATH_LENGTH);
  if (stringError)
    return stringError;
  const original = value;
  const slashPath = original.replaceAll("\\", "/");
  if (slashPath.startsWith("/") || slashPath.startsWith("//")) {
    return failure(ERROR_CODES.PATH_OUTSIDE_ROOT, `${field} must be relative to the repository root`, field);
  }
  const segments = [];
  for (const segment of slashPath.split("/")) {
    if (segment === "" || segment === ".")
      continue;
    if (segment === "..") {
      return failure(ERROR_CODES.PATH_OUTSIDE_ROOT, `${field} cannot escape the repository root`, field);
    }
    segments.push(segment);
  }
  if (segments.length === 0)
    return failure(ERROR_CODES.PATH_OUTSIDE_ROOT, `${field} must name a file`, field);
  const normalizedPath = segments.join("/");
  if (/^[A-Za-z]:/.test(normalizedPath)) {
    return failure(ERROR_CODES.PATH_OUTSIDE_ROOT, `${field} must be relative to the repository root`, field);
  }
  return success(normalizedPath);
}
function validateRevisionRef(value) {
  if (!isRecord(value) || typeof value.kind !== "string") {
    return invalid("revision must be a commit or working-tree reference", "revision");
  }
  if (value.kind === "commit") {
    if (!hasOnlyKeys(value, ["kind", "sha"])) {
      return invalid("commit revision must contain only kind and sha", "revision");
    }
    const error = nonEmptyString(value.sha, "revision.sha", 128);
    return error ? error : success({ kind: "commit", sha: value.sha });
  }
  if (value.kind === "working-tree") {
    if (!hasOnlyKeys(value, ["kind", "contentHash"])) {
      return invalid("working-tree revision must contain only kind and contentHash", "revision");
    }
    const error = nonEmptyString(value.contentHash, "revision.contentHash", 128);
    return error ? error : success({ kind: "working-tree", contentHash: value.contentHash });
  }
  return invalid("revision.kind must be commit or working-tree", "revision.kind");
}
function validateCheck(value, index) {
  const field = `checks[${index}]`;
  if (!isRecord(value) || !hasOnlyKeys(value, ["name", "status", "details"])) {
    return invalid(`${field} has an unsupported field`, field);
  }
  const error = firstError(textField(value.name, `${field}.name`), value.details === undefined ? null : textField(value.details, `${field}.details`));
  if (error)
    return error;
  if (typeof value.status !== "string" || !hasOwnKey(CHECK_STATUSES, value.status)) {
    return invalid(`${field}.status must be passed, failed, or not-run`, `${field}.status`);
  }
  return success({
    name: value.name,
    status: value.status,
    ...value.details === undefined ? {} : { details: value.details }
  });
}
function validateTargetReference(value) {
  if (!isRecord(value) || !hasOnlyKeys(value, ["repository_id", "path", "line_start", "line_end", "revision", "content_hash"])) {
    return invalid("target has an unsupported field", "targets");
  }
  const repositoryError = nonEmptyString(value.repository_id, "target.repository_id");
  if (repositoryError)
    return repositoryError;
  const pathResult = normalizeRelativePath(value.path, "target.path");
  if (!pathResult.success)
    return pathResult;
  if (!Number.isInteger(value.line_start) || value.line_start < 1) {
    return invalid("target.line_start must be a positive integer", "target.line_start");
  }
  if (!Number.isInteger(value.line_end) || value.line_end < value.line_start) {
    return invalid("target.line_end must be an integer at or after line_start", "target.line_end");
  }
  const revisionResult = validateRevisionRef(value.revision);
  if (!revisionResult.success)
    return revisionResult;
  const hashError = nonEmptyString(value.content_hash, "target.content_hash", 128);
  if (hashError)
    return hashError;
  return success({
    repository_id: value.repository_id,
    path: pathResult.data,
    line_start: value.line_start,
    line_end: value.line_end,
    revision: revisionResult.data,
    content_hash: value.content_hash
  });
}
var DECISION_KEYS = [
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
  "user_disposition"
];
function validateDecisionRecordInput(value) {
  if (!isRecord(value))
    return invalid("decision record must be an object");
  if (!hasOnlyKeys(value, DECISION_KEYS)) {
    const unexpected = Object.keys(value).find((key) => !DECISION_KEYS.includes(key));
    return invalid("decision record contains an unsupported field", unexpected);
  }
  const requiredError = firstError(nonEmptyString(value.record_id, "record_id"), nonEmptyString(value.session_id, "session_id"), nonEmptyString(value.repository_id, "repository_id"), textField(value.judgment, "judgment"), textField(value.rationale, "rationale"), timestamp(value.created_at, "created_at"));
  if (requiredError)
    return requiredError;
  if (typeof value.agent_type !== "string" || !hasOwnKey(AGENTS, value.agent_type)) {
    return invalid("agent_type must be claude-code, codex, or opencode", "agent_type");
  }
  const revisionResult = validateRevisionRef(value.revision);
  if (!revisionResult.success)
    return revisionResult;
  if (!Array.isArray(value.targets) || value.targets.length === 0) {
    return invalid("targets must contain at least one target", "targets");
  }
  const targets = [];
  for (let index = 0;index < value.targets.length; index += 1) {
    const result = validateTargetReference(value.targets[index]);
    if (!result.success)
      return result;
    targets.push(result.data);
  }
  if (!Array.isArray(value.checks))
    return invalid("checks must be an array", "checks");
  const checks = [];
  for (let index = 0;index < value.checks.length; index += 1) {
    const result = validateCheck(value.checks[index], index);
    if (!result.success)
      return result;
    checks.push(result.data);
  }
  if (!Array.isArray(value.open_questions))
    return invalid("open_questions must be an array", "open_questions");
  const openQuestions = [];
  for (let index = 0;index < value.open_questions.length; index += 1) {
    const error = textField(value.open_questions[index], `open_questions[${index}]`);
    if (error)
      return error;
    openQuestions.push(value.open_questions[index]);
  }
  if (value.user_disposition !== undefined && (typeof value.user_disposition !== "string" || !hasOwnKey(DISPOSITIONS, value.user_disposition))) {
    return invalid("user_disposition must be unreviewed, accepted, or rejected", "user_disposition");
  }
  return success({
    record_id: value.record_id,
    session_id: value.session_id,
    repository_id: value.repository_id,
    agent_type: value.agent_type,
    revision: revisionResult.data,
    targets,
    judgment: value.judgment,
    rationale: value.rationale,
    checks,
    open_questions: openQuestions,
    created_at: value.created_at,
    ...value.user_disposition === undefined ? {} : { user_disposition: value.user_disposition }
  });
}
function validateReviewSession(value) {
  if (!isRecord(value) || !hasOnlyKeys(value, ["session_id", "repository_id", "agent_type", "started_at", "ended_at", "status"])) {
    return invalid("review session has an unsupported field");
  }
  const requiredError = firstError(nonEmptyString(value.session_id, "session_id"), nonEmptyString(value.repository_id, "repository_id"), timestamp(value.started_at, "started_at"), timestamp(value.ended_at, "ended_at", true));
  if (requiredError)
    return requiredError;
  if (typeof value.agent_type !== "string" || !hasOwnKey(AGENTS, value.agent_type))
    return invalid("agent_type is invalid", "agent_type");
  if (typeof value.status !== "string" || !hasOwnKey(SESSION_STATUSES, value.status))
    return invalid("status is invalid", "status");
  return success({
    session_id: value.session_id,
    repository_id: value.repository_id,
    agent_type: value.agent_type,
    started_at: value.started_at,
    ...value.ended_at === undefined ? {} : { ended_at: value.ended_at },
    status: value.status
  });
}
class ContractValidationError extends Error {
  code;
  field;
  constructor(result) {
    super(result.error.message);
    this.name = "ContractValidationError";
    this.code = result.error.code;
    this.field = result.error.field;
  }
}
function parseDecisionRecordInput(value) {
  const result = validateDecisionRecordInput(value);
  if (!result.success)
    throw new ContractValidationError(result);
  return result.data;
}
// plugins/common/src/bridge.ts
import { readFile } from "fs/promises";
import { homedir } from "os";
import { join } from "path";
var DEFAULT_RECORDER_ENDPOINT = "http://127.0.0.1:4318/v1/decision-records";
var DEFAULT_RECORDER_TOKEN_PATH = join(homedir(), ".ai-code-review-evidence", "token");
var MAX_RESPONSE_BYTES = 1e6;
function positiveInteger(value, field) {
  if (!Number.isSafeInteger(value) || value <= 0)
    throw new RangeError(`${field} must be a positive integer`);
  return value;
}
function nonNegativeInteger(value, field) {
  if (!Number.isSafeInteger(value) || value < 0)
    throw new RangeError(`${field} must be a non-negative integer`);
  return value;
}
function localEndpoint(value) {
  let url;
  try {
    url = new URL(value);
  } catch {
    throw new RangeError("Recorder endpoint must be a valid URL");
  }
  if (url.protocol !== "http:" && url.protocol !== "https:")
    throw new RangeError("Recorder endpoint must use HTTP or HTTPS");
  if (url.hostname !== "127.0.0.1" && url.hostname !== "localhost" && url.hostname !== "[::1]") {
    throw new RangeError("Recorder endpoint must use a loopback host");
  }
  return url.toString();
}
function responseFailure(recordId, code, message, attempts, status) {
  return {
    success: false,
    code,
    message,
    error: message,
    recordId,
    attempts,
    ...status === undefined ? {} : { status }
  };
}
function retryableStatus(status) {
  return status === 408 || status === 425 || status === 429 || status >= 500;
}
async function boundedResponseJson(response) {
  const body = await response.text();
  if (new TextEncoder().encode(body).byteLength > MAX_RESPONSE_BYTES)
    throw new Error("Recorder response exceeds the adapter limit");
  if (body.length === 0)
    return null;
  try {
    return JSON.parse(body);
  } catch {
    throw new Error("Recorder returned malformed JSON");
  }
}
function responseErrorBody(body) {
  if (typeof body !== "object" || body === null || Array.isArray(body))
    return {};
  const root = body;
  if (typeof root.error !== "object" || root.error === null || Array.isArray(root.error))
    return {};
  const error = root.error;
  return {
    ...typeof error.code === "string" ? { code: error.code } : {},
    ...typeof error.message === "string" ? { message: error.message } : {}
  };
}
function sleep(milliseconds) {
  if (milliseconds <= 0)
    return Promise.resolve();
  const { promise, resolve } = Promise.withResolvers();
  setTimeout(resolve, milliseconds);
  return promise;
}
async function requestWithTimeout(fetchImpl, endpoint, init, timeoutMs) {
  const controller = new AbortController;
  const request = fetchImpl(endpoint, { ...init, signal: controller.signal }).then(async (response) => ({ response, body: await boundedResponseJson(response) }));
  const timeout = Promise.withResolvers();
  const timer = setTimeout(() => {
    controller.abort();
    timeout.reject(new Error("Recorder request timed out"));
  }, timeoutMs);
  try {
    return await Promise.race([request, timeout.promise]);
  } finally {
    clearTimeout(timer);
  }
}

class RecorderBridge {
  endpoint;
  tokenPath;
  queueCapacity;
  maxAttempts;
  retryBaseDelayMs;
  maxRetryDelayMs;
  maxRetryDurationMs;
  fetchImpl;
  pending = new Map;
  constructor(options = {}) {
    const endpointValue = options.endpoint ?? process.env.RECORDER_URL ?? DEFAULT_RECORDER_ENDPOINT;
    this.endpoint = localEndpoint(endpointValue);
    this.tokenPath = options.tokenPath ?? process.env.RECORDER_TOKEN_PATH ?? DEFAULT_RECORDER_TOKEN_PATH;
    this.queueCapacity = positiveInteger(options.queueCapacity ?? 32, "queueCapacity");
    this.maxAttempts = positiveInteger(options.maxAttempts ?? 3, "maxAttempts");
    this.retryBaseDelayMs = nonNegativeInteger(options.retryBaseDelayMs ?? 50, "retryBaseDelayMs");
    this.maxRetryDelayMs = nonNegativeInteger(options.maxRetryDelayMs ?? 500, "maxRetryDelayMs");
    this.maxRetryDurationMs = positiveInteger(options.maxRetryDurationMs ?? 2000, "maxRetryDurationMs");
    this.fetchImpl = options.fetchImpl ?? fetch;
  }
  submit(record) {
    const pendingKey = `record:${record.record_id}`;
    const existing = this.pending.get(pendingKey);
    if (existing !== undefined)
      return existing;
    if (this.pending.size >= this.queueCapacity) {
      return Promise.resolve(responseFailure(record.record_id, "QUEUE_EXHAUSTED", "Recorder queue capacity is exhausted", 0));
    }
    const operation = this.postWithRetry(record.record_id, this.endpoint, record).finally(() => {
      if (this.pending.get(pendingKey) === operation)
        this.pending.delete(pendingKey);
    });
    this.pending.set(pendingKey, operation);
    return operation;
  }
  captureAutomaticSnapshot(input) {
    const pendingKey = `capture:${input.captureId}`;
    const existing = this.pending.get(pendingKey);
    if (existing !== undefined)
      return existing;
    if (this.pending.size >= this.queueCapacity) {
      return Promise.resolve(responseFailure(input.recordId, "QUEUE_EXHAUSTED", "Recorder queue capacity is exhausted", 0));
    }
    const endpoint = new URL(this.endpoint);
    endpoint.pathname = `${endpoint.pathname.replace(/\/$/, "")}/${encodeURIComponent(input.recordId)}/automatic-snapshot`;
    endpoint.search = "";
    endpoint.hash = "";
    const operation = this.postWithRetry(input.recordId, endpoint.toString(), {
      capture_id: input.captureId,
      source_path: input.sourcePath,
      content: input.content,
      before_missing: input.beforeMissing
    }, true).finally(() => {
      if (this.pending.get(pendingKey) === operation)
        this.pending.delete(pendingKey);
    });
    this.pending.set(pendingKey, operation);
    return operation;
  }
  async postWithRetry(recordId, endpoint, body, preserveServerFailure = false) {
    const startedAt = Date.now();
    let attempts = 0;
    let lastFailure;
    let lastServerFailure;
    while (attempts < this.maxAttempts && Date.now() - startedAt <= this.maxRetryDurationMs) {
      attempts += 1;
      try {
        const token = (await readFile(this.tokenPath, "utf8")).trim();
        if (token.length === 0)
          throw new Error("Recorder token file is empty");
        const remaining = this.maxRetryDurationMs - (Date.now() - startedAt);
        if (remaining <= 0)
          break;
        const { response, body: responseBody } = await requestWithTimeout(this.fetchImpl, endpoint, {
          method: "POST",
          headers: {
            authorization: `Bearer ${token}`,
            "content-type": "application/json"
          },
          body: JSON.stringify(body)
        }, remaining);
        if (response.ok) {
          if (typeof responseBody !== "object" || responseBody === null || Array.isArray(responseBody) || responseBody.success !== true) {
            const detail2 = responseErrorBody(responseBody);
            if (preserveServerFailure && (detail2.code !== undefined || detail2.message !== undefined)) {
              return responseFailure(recordId, detail2.code ?? "RECORDER_PROTOCOL_ERROR", detail2.message ?? "Recorder returned an invalid success envelope", attempts, response.status);
            }
            return responseFailure(recordId, "RECORDER_PROTOCOL_ERROR", "Recorder returned an invalid success envelope", attempts, response.status);
          }
          return {
            success: true,
            status: response.status,
            duplicate: response.status === 200,
            recordId
          };
        }
        const detail = responseErrorBody(responseBody);
        const failure2 = responseFailure(recordId, detail.code ?? (retryableStatus(response.status) ? "RECORDER_UNAVAILABLE" : "RECORDER_ERROR"), detail.message ?? `Recorder returned HTTP ${response.status}`, attempts, response.status);
        lastFailure = failure2;
        lastServerFailure = failure2;
        if (!retryableStatus(response.status))
          return failure2;
      } catch (error) {
        lastFailure = responseFailure(recordId, "RECORDER_UNAVAILABLE", error instanceof Error ? error.message : String(error), attempts);
      }
      const elapsed = Date.now() - startedAt;
      if (attempts >= this.maxAttempts || elapsed >= this.maxRetryDurationMs)
        break;
      const delay = Math.min(this.maxRetryDelayMs, this.retryBaseDelayMs * 2 ** (attempts - 1), this.maxRetryDurationMs - elapsed);
      await sleep(delay);
    }
    if (preserveServerFailure && lastServerFailure !== undefined) {
      return { ...lastServerFailure, attempts };
    }
    return responseFailure(recordId, lastFailure?.code === "RECORDER_ERROR" ? "RECORDER_ERROR" : "RECORDER_UNAVAILABLE", "Recorder unavailable after bounded retries", attempts, lastFailure?.status);
  }
}

// plugins/common/src/adapter-contract.ts
var EVENT_KEYS = [
  "sessionId",
  "repositoryRoot",
  "revision",
  "targets",
  "judgment",
  "rationale",
  "checks",
  "openQuestions",
  "recordId",
  "createdAt"
];
var TARGET_KEYS = ["path", "lineStart", "lineEnd", "revision", "contentHash"];
var MAX_EVENT_LINE_BYTES = 1e6;
function fail(message, field) {
  const suffix = field === undefined ? "" : ` (${field})`;
  throw new HostEventValidationError(`${message}${suffix}`);
}
function onlyKeys(value, allowed, label) {
  const unexpected = Object.keys(value).find((key) => !allowed.includes(key));
  if (unexpected !== undefined)
    fail("host event contains an unsupported field", `${label}.${unexpected}`);
}
function requiredString(value, field) {
  if (typeof value !== "string" || value.trim().length === 0)
    fail("host event requires a non-empty string", field);
  return value;
}
function revision(value, field) {
  const result = validateRevisionRef(value);
  if (!result.success)
    fail(result.error.message, field);
  return result.data;
}
function normalizedEvent(value) {
  if (!isRecord(value))
    fail("host event must be an object");
  onlyKeys(value, EVENT_KEYS, "event");
  const sessionId = requiredString(value.sessionId, "sessionId");
  const repositoryRoot = requiredString(value.repositoryRoot, "repositoryRoot");
  if (!isAbsolute(repositoryRoot))
    fail("repositoryRoot must be an absolute path", "repositoryRoot");
  const eventRevision = revision(value.revision, "revision");
  if (!Array.isArray(value.targets) || value.targets.length === 0)
    fail("targets must contain at least one target", "targets");
  const targets = value.targets.map((candidate, index) => {
    if (!isRecord(candidate))
      fail("target must be an object", `targets[${index}]`);
    onlyKeys(candidate, TARGET_KEYS, `targets[${index}]`);
    const path = requiredString(candidate.path, `targets[${index}].path`);
    if (!Number.isSafeInteger(candidate.lineStart) || candidate.lineStart < 1)
      fail("lineStart must be a positive integer", `targets[${index}].lineStart`);
    if (!Number.isSafeInteger(candidate.lineEnd) || candidate.lineEnd < candidate.lineStart)
      fail("lineEnd must be at or after lineStart", `targets[${index}].lineEnd`);
    const contentHash = requiredString(candidate.contentHash, `targets[${index}].contentHash`);
    return {
      path,
      lineStart: candidate.lineStart,
      lineEnd: candidate.lineEnd,
      revision: revision(candidate.revision, `targets[${index}].revision`),
      contentHash
    };
  });
  if (!Array.isArray(value.checks))
    fail("checks must be an array", "checks");
  if (!Array.isArray(value.openQuestions))
    fail("openQuestions must be an array", "openQuestions");
  const openQuestions = value.openQuestions.map((question, index) => requiredString(question, `openQuestions[${index}]`));
  const checks = value.checks.map((candidate, index) => {
    if (!isRecord(candidate))
      fail("check must be an object", `checks[${index}]`);
    onlyKeys(candidate, ["name", "status", "details"], `checks[${index}]`);
    const name = requiredString(candidate.name, `checks[${index}].name`);
    const status = candidate.status;
    if (status !== "passed" && status !== "failed" && status !== "not-run")
      fail("check status is invalid", `checks[${index}].status`);
    if (candidate.details !== undefined && typeof candidate.details !== "string")
      fail("check details must be a string", `checks[${index}].details`);
    return candidate.details === undefined ? { name, status } : { name, status, details: candidate.details };
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
    ...recordId === undefined ? {} : { recordId },
    ...createdAt === undefined ? {} : { createdAt }
  };
}

class HostEventValidationError extends Error {
  code = "INVALID_RECORD";
  constructor(message) {
    super(message);
    this.name = "HostEventValidationError";
  }
}
function repositoryId(repositoryRoot) {
  return createHash("sha256").update(repositoryRoot, "utf8").digest("hex");
}
function derivedRecordId(input) {
  const { agent_type: _agentType, ...identity } = input;
  return createHash("sha256").update(JSON.stringify(identity), "utf8").digest("hex");
}
function mapHostEvent(agentType, value) {
  let event;
  try {
    event = normalizedEvent(value);
  } catch (error) {
    if (error instanceof HostEventValidationError)
      throw error;
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
      content_hash: target.contentHash
    })),
    judgment: event.judgment,
    rationale: event.rationale,
    checks: event.checks,
    open_questions: event.openQuestions
  };
  const record = {
    ...canonicalWithoutIdentity,
    record_id: event.recordId ?? derivedRecordId(canonicalWithoutIdentity),
    created_at: event.createdAt ?? new Date().toISOString()
  };
  try {
    return parseDecisionRecordInput(record);
  } catch (error) {
    if (error instanceof ContractValidationError)
      throw new HostEventValidationError(error.message);
    throw error;
  }
}
function adapterError(error) {
  const message = error instanceof Error ? error.message : String(error);
  const code = error instanceof HostEventValidationError || error instanceof SyntaxError ? "INVALID_RECORD" : "ADAPTER_ERROR";
  return { success: false, code, message, error: message, recordId: "", attempts: 0 };
}
async function writeResult(output, result) {
  const writeResult2 = output.write(`${JSON.stringify(result)}
`);
  if (writeResult2 instanceof Promise)
    await writeResult2;
}
async function runAdapter(agentType, stdin, stdout, bridge) {
  const recorder = bridge ?? new RecorderBridge;
  const decoder = new TextDecoder;
  const encoder = new TextEncoder;
  let buffer = "";
  let oversized = false;
  const processLine = async (line) => {
    if (line.length === 0) {
      await writeResult(stdout, { success: false, code: "INVALID_RECORD", message: "input line is empty", error: "input line is empty", recordId: "", attempts: 0 });
      return;
    }
    if (encoder.encode(line).byteLength > MAX_EVENT_LINE_BYTES) {
      await writeResult(stdout, { success: false, code: "PAYLOAD_TOO_LARGE", message: "input line exceeds the adapter limit", error: "input line exceeds the adapter limit", recordId: "", attempts: 0 });
      return;
    }
    try {
      const record = mapHostEvent(agentType, JSON.parse(line));
      await writeResult(stdout, await recorder.submit(record));
    } catch (error) {
      await writeResult(stdout, adapterError(error));
    }
  };
  for await (const chunk of stdin) {
    buffer += typeof chunk === "string" ? chunk : decoder.decode(chunk, { stream: true });
    let newline = buffer.indexOf(`
`);
    while (newline >= 0) {
      const line = buffer.slice(0, newline).replace(/\r$/, "");
      buffer = buffer.slice(newline + 1);
      if (oversized) {
        oversized = false;
        await processLine(`${"x".repeat(MAX_EVENT_LINE_BYTES + 1)}`);
      } else {
        await processLine(line);
      }
      newline = buffer.indexOf(`
`);
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

// plugins/claude-code/src/gate-command.ts
import { appendFile, realpath as realpath2 } from "fs/promises";
import { createHash as createHash3 } from "crypto";
import { resolve as resolve2 } from "path";

// plugins/common/src/decision-gate.ts
import { createHash as createHash2, randomUUID } from "crypto";
import { lstat, mkdir, readFile as readFile2, readdir, realpath, rename, rm, writeFile } from "fs/promises";
import { homedir as homedir2 } from "os";
import { basename, dirname, isAbsolute as isAbsolute2, join as join2, relative, resolve, sep } from "path";
var DEFAULT_PERMIT_TTL_MS = 10 * 60 * 1000;
var MAX_HASH_BYTES = 10 * 1024 * 1024;
var PROPOSAL_KEYS = [
  "sessionId",
  "repositoryRoot",
  "revision",
  "targets",
  "judgment",
  "rationale",
  "checks",
  "openQuestions",
  "recordId",
  "createdAt"
];
var TARGET_KEYS2 = ["path", "lineStart", "lineEnd", "revision", "contentHash"];
function fail2(message) {
  throw new Error(message);
}
function nonEmptyString2(value, field) {
  if (typeof value !== "string" || value.trim().length === 0)
    fail2(`${field} must be a non-empty string`);
  return value;
}
function onlyKeys2(value, allowed, label) {
  const unexpected = Object.keys(value).find((key) => !allowed.includes(key));
  if (unexpected !== undefined)
    fail2(`${label}.${unexpected} is not supported`);
}
function sha256(value) {
  return createHash2("sha256").update(value, "utf8").digest("hex");
}
function hashText(value) {
  return sha256(value);
}
function normalizedRelativePath(root, candidate) {
  const absoluteCandidate = resolve(root, candidate);
  const relativeCandidate = relative(root, absoluteCandidate);
  if (relativeCandidate === "" || relativeCandidate === ".." || relativeCandidate.startsWith(`..${sep}`) || isAbsolute2(relativeCandidate)) {
    fail2("target path must stay inside repositoryRoot");
  }
  return relativeCandidate.split(sep).join("/");
}
async function readRegularFile(path) {
  const details = await lstat(path);
  if (details.isSymbolicLink() || !details.isFile())
    fail2(`target is not a regular file: ${path}`);
  if (details.size > MAX_HASH_BYTES)
    fail2(`target exceeds the hash size limit: ${path}`);
  let bytes;
  try {
    bytes = await readFile2(path);
  } catch {
    throw new Error(`target could not be read: ${path}`);
  }
  try {
    return new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  } catch {
    throw new Error(`target could not be read: ${path}`);
  }
}
async function currentFileText(path) {
  try {
    return await readRegularFile(path);
  } catch (error) {
    const code = error.code;
    if (code === "ENOENT")
      return "";
    if (error instanceof Error && error.message.startsWith("target "))
      throw error;
    throw new Error(`target could not be read: ${path}`);
  }
}
async function canonicalPath(root, filePath) {
  let canonicalRoot;
  try {
    canonicalRoot = await realpath(root);
  } catch {
    return null;
  }
  try {
    if ((await lstat(filePath)).isSymbolicLink())
      return null;
  } catch (error) {
    if (error.code !== "ENOENT")
      return null;
  }
  let canonicalFile;
  try {
    canonicalFile = await realpath(filePath);
  } catch (error) {
    if (error.code !== "ENOENT")
      return null;
    const ancestor = await nearestExistingCanonicalPath(canonicalRoot, resolve(filePath));
    if (ancestor === null)
      return null;
    canonicalFile = ancestor;
  }
  const relativeFile = relative(canonicalRoot, canonicalFile);
  if (relativeFile === "" || relativeFile === ".." || relativeFile.startsWith(`..${sep}`) || isAbsolute2(relativeFile))
    return null;
  return { root: canonicalRoot, path: canonicalFile };
}
async function nearestExistingCanonicalPath(canonicalRoot, missingPath) {
  const tail = [];
  let candidate = missingPath;
  for (;; ) {
    const parent = dirname(candidate);
    if (parent === candidate)
      return null;
    tail.push(basename(candidate));
    candidate = parent;
    try {
      if ((await lstat(candidate)).isSymbolicLink())
        return null;
    } catch (error) {
      if (error.code !== "ENOENT")
        return null;
      continue;
    }
    try {
      const resolved = await realpath(candidate);
      const relativeAncestor = relative(canonicalRoot, resolved);
      if (relativeAncestor === ".." || relativeAncestor.startsWith(`..${sep}`) || isAbsolute2(relativeAncestor))
        return null;
      return join2(resolved, ...tail.reverse());
    } catch (error) {
      if (error.code !== "ENOENT")
        return null;
    }
  }
}
async function hashExistingFile(path) {
  return hashText(await currentFileText(path));
}
async function readCurrentFileState(options) {
  const canonical = await canonicalPath(options.repositoryRoot, options.filePath);
  if (canonical === null)
    throw new Error(`target could not be resolved: ${options.filePath}`);
  try {
    const content = await readRegularFile(canonical.path);
    return { content, beforeMissing: false, contentHash: hashText(content) };
  } catch (error) {
    if (error.code === "ENOENT")
      return { content: "", beforeMissing: true, contentHash: hashText("") };
    if (error instanceof Error)
      throw error;
    throw new Error(`target could not be read: ${options.filePath}`);
  }
}
function gateBase(options) {
  return options.gateRoot ?? process.env.AI_REVIEW_GATE_ROOT ?? join2(homedir2(), ".ai-code-review-evidence", "gates");
}
function gateDirectory(root, sessionId, options = {}) {
  return join2(gateBase(options), sha256(root), sha256(sessionId));
}
function permitPath(directory) {
  return join2(directory, `permit-${randomUUID()}.json`);
}
function parseProposal(value) {
  if (!isRecord(value))
    fail2("decision proposal must be an object");
  onlyKeys2(value, PROPOSAL_KEYS, "proposal");
  if (!Array.isArray(value.targets) || value.targets.length === 0)
    fail2("proposal.targets must contain at least one target");
  if (typeof value.judgment !== "string" || value.judgment.trim().length === 0)
    fail2("proposal.judgment must be a non-empty string");
  if (typeof value.rationale !== "string" || value.rationale.trim().length === 0)
    fail2("proposal.rationale must be a non-empty string");
  const targets = value.targets.map((candidate, index) => {
    if (!isRecord(candidate))
      fail2(`proposal.targets[${index}] must be an object`);
    onlyKeys2(candidate, TARGET_KEYS2, `proposal.targets[${index}]`);
    const path = nonEmptyString2(candidate.path, `proposal.targets[${index}].path`);
    if (!Number.isSafeInteger(candidate.lineStart) || candidate.lineStart < 1)
      fail2(`proposal.targets[${index}].lineStart must be a positive integer`);
    if (candidate.lineEnd !== undefined && (!Number.isSafeInteger(candidate.lineEnd) || candidate.lineEnd < candidate.lineStart)) {
      fail2(`proposal.targets[${index}].lineEnd must be at or after lineStart`);
    }
    return {
      path,
      lineStart: candidate.lineStart,
      ...candidate.lineEnd === undefined ? {} : { lineEnd: candidate.lineEnd },
      ...candidate.revision === undefined ? {} : { revision: candidate.revision },
      ...candidate.contentHash === undefined ? {} : { contentHash: nonEmptyString2(candidate.contentHash, `proposal.targets[${index}].contentHash`) }
    };
  });
  return {
    ...value.sessionId === undefined ? {} : { sessionId: nonEmptyString2(value.sessionId, "proposal.sessionId") },
    ...value.repositoryRoot === undefined ? {} : { repositoryRoot: nonEmptyString2(value.repositoryRoot, "proposal.repositoryRoot") },
    ...value.revision === undefined ? {} : { revision: value.revision },
    targets,
    judgment: value.judgment,
    rationale: value.rationale,
    ...value.checks === undefined ? {} : { checks: value.checks },
    ...value.openQuestions === undefined ? {} : { openQuestions: value.openQuestions },
    ...value.recordId === undefined ? {} : { recordId: nonEmptyString2(value.recordId, "proposal.recordId") },
    ...value.createdAt === undefined ? {} : { createdAt: nonEmptyString2(value.createdAt, "proposal.createdAt") }
  };
}
async function normalizeDecisionProposal(value, defaults) {
  const proposal = parseProposal(value);
  const sessionId = proposal.sessionId ?? defaults.sessionId;
  if (sessionId === undefined)
    fail2("sessionId is required; start the plugin session first");
  const repositoryRoot = resolve(proposal.repositoryRoot ?? defaults.repositoryRoot ?? process.cwd());
  if (!isAbsolute2(repositoryRoot))
    fail2("repositoryRoot must be an absolute path");
  const canonicalRoot = await realpath(repositoryRoot).catch(() => fail2("repositoryRoot does not exist"));
  const targetData = [];
  for (const target of proposal.targets) {
    const path = normalizedRelativePath(canonicalRoot, target.path);
    if (await canonicalPath(canonicalRoot, resolve(canonicalRoot, path)) === null) {
      fail2(`target path must resolve inside repositoryRoot: ${path}`);
    }
    const text = await currentFileText(resolve(canonicalRoot, path));
    const contentHash = hashText(text);
    if (target.contentHash !== undefined && target.contentHash !== contentHash) {
      fail2(`target contentHash does not match the current file: ${path}`);
    }
    const lineCount = Math.max(1, text.split(/\r?\n/).length - (text.endsWith(`
`) ? 1 : 0));
    targetData.push({
      path,
      lineStart: target.lineStart,
      lineEnd: target.lineEnd ?? Math.max(target.lineStart, lineCount),
      contentHash,
      ...target.revision === undefined ? {} : { revision: target.revision }
    });
  }
  const revision2 = proposal.revision ?? {
    kind: "working-tree",
    contentHash: sha256(targetData.map((target) => `${target.path}\x00${target.contentHash}`).sort().join(`
`))
  };
  return {
    sessionId,
    repositoryRoot: canonicalRoot,
    revision: revision2,
    targets: targetData.map((target) => ({
      path: target.path,
      lineStart: target.lineStart,
      lineEnd: target.lineEnd,
      revision: target.revision ?? revision2,
      contentHash: target.contentHash
    })),
    judgment: proposal.judgment,
    rationale: proposal.rationale,
    checks: proposal.checks ?? [],
    openQuestions: proposal.openQuestions ?? [],
    ...proposal.recordId === undefined ? {} : { recordId: proposal.recordId },
    ...proposal.createdAt === undefined ? {} : { createdAt: proposal.createdAt }
  };
}
async function grantDecisionPermits(event, options) {
  const recordId = nonEmptyString2(options.recordId, "recordId");
  const sessionId = nonEmptyString2(event.sessionId, "sessionId");
  const root = await realpath(event.repositoryRoot).catch(() => fail2("repositoryRoot does not exist"));
  const ttlMs = options.ttlMs ?? DEFAULT_PERMIT_TTL_MS;
  if (!Number.isSafeInteger(ttlMs) || ttlMs <= 0)
    fail2("permit ttl must be a positive integer");
  const expiresAt = new Date(Date.now() + ttlMs).toISOString();
  const directory = gateDirectory(root, sessionId, options);
  await mkdir(directory, { recursive: true, mode: 448 });
  for (const target of event.targets) {
    const path = normalizedRelativePath(root, target.path);
    const permit = { sessionId, repositoryRoot: root, recordId, captureId: randomUUID(), path, contentHash: target.contentHash, expiresAt };
    await writeFile(permitPath(directory), `${JSON.stringify(permit)}
`, { encoding: "utf8", mode: 384 });
  }
  return { permits: event.targets.length, gateDirectory: directory, expiresAt };
}
async function claimPermit(path) {
  const claimed = `${path}.claim-${process.pid}-${randomUUID()}`;
  try {
    await rename(path, claimed);
    return claimed;
  } catch {
    return null;
  }
}
async function findMatchingPermit(options, checkContentHash = true) {
  const canonical = await canonicalPath(options.repositoryRoot, options.filePath);
  if (canonical === null)
    return null;
  const directory = gateDirectory(canonical.root, options.sessionId, options.gateRoot === undefined ? {} : { gateRoot: options.gateRoot });
  let entries;
  try {
    entries = await readdir(directory, { withFileTypes: true });
  } catch {
    return null;
  }
  const relativeFile = relative(canonical.root, canonical.path).split(sep).join("/");
  for (const entry of entries) {
    if (!entry.isFile() || !entry.name.endsWith(".json"))
      continue;
    const original = join2(directory, entry.name);
    let raw;
    try {
      raw = await readFile2(original, "utf8");
    } catch {
      continue;
    }
    let permit;
    try {
      const value = JSON.parse(raw);
      if (typeof value.sessionId !== "string" || typeof value.repositoryRoot !== "string" || typeof value.recordId !== "string" || typeof value.path !== "string" || typeof value.contentHash !== "string" || typeof value.expiresAt !== "string")
        continue;
      if (Date.parse(value.expiresAt) <= Date.now()) {
        await rm(original, { force: true }).catch(() => {
          return;
        });
        continue;
      }
      if (typeof value.captureId !== "string" || value.captureId.trim().length === 0)
        continue;
      permit = value;
    } catch {
      continue;
    }
    if (permit.sessionId !== options.sessionId || permit.repositoryRoot !== canonical.root || permit.path !== relativeFile)
      continue;
    if (checkContentHash) {
      const actualHash = await hashExistingFile(canonical.path).catch(() => null);
      if (actualHash !== permit.contentHash)
        continue;
    }
    return {
      path: original,
      permit: {
        recordId: permit.recordId,
        captureId: permit.captureId,
        sessionId: permit.sessionId,
        repositoryRoot: permit.repositoryRoot,
        path: permit.path,
        contentHash: permit.contentHash
      }
    };
  }
  return null;
}
async function findDecisionPermit(options) {
  return (await findMatchingPermit(options))?.permit ?? null;
}
async function consumeDecisionPermitAfterEdit(options) {
  return consumeMatchingPermit(options, false);
}
async function consumeMatchingPermit(options, checkContentHash) {
  const found = await findMatchingPermit(options, checkContentHash);
  if (found === null)
    return false;
  const claimed = await claimPermit(found.path);
  if (claimed === null)
    return false;
  await rm(claimed, { force: true }).catch(() => {
    return;
  });
  return true;
}
var GIT_MUTATING_VERBS = new Set(["apply", "am", "restore", "reset", "rebase", "merge-file", "merge-index", "merge-one-file", "mergetool"]);
var GIT_WORKTREE_METADATA_SUBCOMMANDS = new Set(["list", "prune", "lock", "unlock"]);
function gitCheckoutMutates(tokens, from) {
  let sawBranchCreation = false;
  for (let index = from;index < tokens.length; index += 1) {
    const token = tokens[index];
    if (token === undefined)
      break;
    if (token === "--")
      return true;
    if (token === "-b" || token === "-B" || token === "-q" || token === "--quiet" || token === "--no-guess" || token.startsWith("--branch")) {
      if (token !== "-q" && token !== "--quiet" && token !== "--no-guess")
        sawBranchCreation = true;
      continue;
    }
    if (token.startsWith("-"))
      return true;
    if (!sawBranchCreation)
      return true;
  }
  return !sawBranchCreation && tokens.length > from;
}
function gitSwitchMutates(tokens, from) {
  for (let index = from;index < tokens.length; index += 1) {
    const token = tokens[index];
    if (token === undefined)
      break;
    if (token === "--")
      return true;
    if (token === "-c" || token === "-C" || token === "--create" || token === "-q" || token === "--quiet" || token === "--guess" || token === "--no-guess" || token === "-t" || token === "--track" || token === "--no-track" || token.startsWith("--create="))
      continue;
    if (token.startsWith("-"))
      return true;
  }
  return false;
}
function gitWorktreeMutates(tokens, from) {
  const subcommand = tokens[from];
  if (subcommand === undefined || subcommand.startsWith("-"))
    return true;
  if (GIT_WORKTREE_METADATA_SUBCOMMANDS.has(subcommand))
    return false;
  if (subcommand !== "add")
    return true;
  for (let index = from + 1;index < tokens.length; index += 1) {
    const token = tokens[index];
    if (token === undefined)
      break;
    if (token === "-b" || token === "-B" || token === "--detach" || token === "-q" || token === "--quiet" || token === "--lock" || token === "--no-checkout" || token === "--checkout")
      continue;
    if (token.startsWith("-"))
      return true;
  }
  return false;
}
function gitInvocationMutates(segment) {
  const tokens = segment.trim().split(/\s+/).filter((token) => token.length > 0);
  for (let index = 0;index < tokens.length; index += 1) {
    if (tokens[index] !== "git")
      continue;
    const verb = tokens[index + 1];
    if (verb === undefined)
      continue;
    if (GIT_MUTATING_VERBS.has(verb))
      return true;
    if (verb === "checkout" && gitCheckoutMutates(tokens, index + 2))
      return true;
    if (verb === "switch" && gitSwitchMutates(tokens, index + 2))
      return true;
    if (verb === "worktree" && gitWorktreeMutates(tokens, index + 2))
      return true;
  }
  return false;
}
function likelyCodeMutation(command) {
  const normalized = command.replaceAll("\\", "/");
  return /(?:^|[;&|]\s*)(?:apply_patch|patch)\b/i.test(normalized) || normalized.split(/[;&|\n]+/).some(gitInvocationMutates) || /\b(?:sed|perl)\s+[^\n]*-i(?:\s|$)/i.test(normalized) || /\b(?:tee|install|cp|mv)\s+[^\n]*(?:>|$)/i.test(normalized) || /(?:^|\s)(?:>>|1>|2>|>)\s*(?!\/dev\/null(?:\s|$))(?![nN][uU][lL](?:\s|$))(?!(?:\/private)?\/tmp\/)(?!\$\{?TMPDIR\}?\/)[^\s|;&<>]+/.test(normalized) || /\b(?:python|python3|node|nodejs|bun)\s+[^\n]*(?:writeFile|appendFile|write_text|open\s*\([^)]*['"][wax+])/i.test(normalized);
}
function defaultGateRoot() {
  return process.env.AI_REVIEW_GATE_ROOT ?? join2(homedir2(), ".ai-code-review-evidence", "gates");
}

// plugins/common/src/recorder-setup.ts
import { readFile as readFile3 } from "fs/promises";
import { isAbsolute as isAbsolute3 } from "path";
var MAX_RESPONSE_BYTES2 = 1e6;
var DEFAULT_TIMEOUT_MS = 2000;

class RecorderSetupError extends Error {
  code;
  status;
  constructor(code, message, status) {
    super(message);
    this.name = "RecorderSetupError";
    this.code = code;
    if (status !== undefined)
      this.status = status;
  }
}
function loopbackEndpoint(value) {
  let url;
  try {
    url = new URL(value);
  } catch {
    throw new RecorderSetupError("INVALID_ENDPOINT", "Recorder endpoint must be a valid URL");
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") {
    throw new RecorderSetupError("INVALID_ENDPOINT", "Recorder endpoint must use HTTP or HTTPS");
  }
  if (url.hostname !== "127.0.0.1" && url.hostname !== "localhost" && url.hostname !== "[::1]") {
    throw new RecorderSetupError("INVALID_ENDPOINT", "Recorder endpoint must use a loopback host");
  }
  return url.toString();
}
function positiveTimeout(value) {
  if (!Number.isSafeInteger(value) || value <= 0)
    throw new RecorderSetupError("INVALID_TIMEOUT", "Recorder setup timeout must be a positive integer");
  return value;
}
function resourceEndpoint(endpoint, resource) {
  const url = new URL(endpoint);
  const decisionRecords = "/decision-records";
  if (url.pathname.endsWith(decisionRecords)) {
    url.pathname = `${url.pathname.slice(0, -decisionRecords.length)}/${resource}`;
  } else {
    url.pathname = `/v1/${resource}`;
  }
  url.search = "";
  url.hash = "";
  return url.toString();
}
function objectValue(value, field) {
  if (!isRecord(value))
    throw new RecorderSetupError("RECORDER_PROTOCOL_ERROR", `Recorder response data.${field} must be an object`);
  return value;
}
function requiredString2(value, field) {
  if (typeof value !== "string" || value.trim().length === 0)
    throw new RecorderSetupError("RECORDER_PROTOCOL_ERROR", `Recorder response ${field} must be a non-empty string`);
  return value;
}
function errorDetail(value) {
  if (!isRecord(value) || !isRecord(value.error))
    return {};
  return {
    ...typeof value.error.code === "string" ? { code: value.error.code } : {},
    ...typeof value.error.message === "string" ? { message: value.error.message } : {}
  };
}
async function responseJson(response) {
  const text = await response.text();
  if (new TextEncoder().encode(text).byteLength > MAX_RESPONSE_BYTES2)
    throw new RecorderSetupError("PAYLOAD_TOO_LARGE", "Recorder response exceeds the setup limit");
  if (text.length === 0)
    return null;
  try {
    return JSON.parse(text);
  } catch {
    throw new RecorderSetupError("RECORDER_PROTOCOL_ERROR", "Recorder returned malformed JSON");
  }
}
async function withTimeout(operation, timeoutMs) {
  const controller = new AbortController;
  const timeout = setTimeout(() => controller.abort(), timeoutMs);
  try {
    return await operation(controller.signal);
  } catch (error) {
    if (error instanceof RecorderSetupError)
      throw error;
    if (controller.signal.aborted)
      throw new RecorderSetupError("RECORDER_UNAVAILABLE", "Recorder setup request timed out");
    throw new RecorderSetupError("RECORDER_UNAVAILABLE", error instanceof Error ? error.message : String(error));
  } finally {
    clearTimeout(timeout);
  }
}

class RecorderSetupClient {
  endpoint;
  tokenPath;
  timeoutMs;
  fetchImpl;
  constructor(options = {}) {
    this.endpoint = loopbackEndpoint(options.endpoint ?? process.env.RECORDER_URL ?? DEFAULT_RECORDER_ENDPOINT);
    this.tokenPath = options.tokenPath ?? process.env.RECORDER_TOKEN_PATH ?? DEFAULT_RECORDER_TOKEN_PATH;
    this.timeoutMs = positiveTimeout(options.timeoutMs ?? DEFAULT_TIMEOUT_MS);
    this.fetchImpl = options.fetchImpl ?? fetch;
  }
  async registerRepository(root) {
    if (typeof root !== "string" || root.trim().length === 0 || !isAbsolute3(root)) {
      throw new RecorderSetupError("INVALID_RECORD", "repository root must be an absolute path");
    }
    const data = await this.post("repositories", { root });
    const object = objectValue(data, "repository");
    return {
      repository_id: requiredString2(object.repository_id, "repository_id"),
      root: requiredString2(object.root, "root"),
      created_at: requiredString2(object.created_at, "created_at")
    };
  }
  async registerSession(input) {
    const validation2 = validateReviewSession(input);
    if (!validation2.success)
      throw new RecorderSetupError(validation2.error.code, validation2.error.message);
    const data = await this.post("sessions", validation2.data);
    const object = objectValue(data, "session");
    const agentType = requiredString2(object.agent_type, "agent_type");
    if (agentType !== "claude-code" && agentType !== "codex" && agentType !== "opencode")
      throw new RecorderSetupError("RECORDER_PROTOCOL_ERROR", "Recorder response agent_type is invalid");
    const status = requiredString2(object.status, "status");
    if (status !== "active" && status !== "completed" && status !== "failed")
      throw new RecorderSetupError("RECORDER_PROTOCOL_ERROR", "Recorder response status is invalid");
    return {
      session_id: requiredString2(object.session_id, "session_id"),
      repository_id: requiredString2(object.repository_id, "repository_id"),
      agent_type: agentType,
      started_at: requiredString2(object.started_at, "started_at"),
      status
    };
  }
  async ensureSession(root, input) {
    const repository = await this.registerRepository(root);
    if (repository.root !== root)
      throw new RecorderSetupError("INVALID_RECORD", "Recorder returned a repository root different from the requested root");
    if (repository.repository_id !== input.repository_id)
      throw new RecorderSetupError("INVALID_RECORD", "Recorder returned a repository ID different from the session input");
    const session = await this.registerSession(input);
    return { repository, session };
  }
  async post(resource, body) {
    const endpoint = resourceEndpoint(this.endpoint, resource);
    return withTimeout(async (signal) => {
      let token;
      try {
        token = (await readFile3(this.tokenPath, "utf8")).trim();
      } catch {
        throw new RecorderSetupError("UNAUTHORIZED", "Recorder token file could not be read");
      }
      if (token.length === 0)
        throw new RecorderSetupError("UNAUTHORIZED", "Recorder token file is empty");
      const response = await this.fetchImpl(endpoint, {
        method: "POST",
        headers: {
          authorization: `Bearer ${token}`,
          "content-type": "application/json"
        },
        body: JSON.stringify(body),
        signal
      });
      const parsed = await responseJson(response);
      if (!response.ok) {
        const detail = errorDetail(parsed);
        throw new RecorderSetupError(detail.code ?? "RECORDER_ERROR", detail.message ?? `Recorder returned HTTP ${response.status}`, response.status);
      }
      if (!isRecord(parsed) || parsed.success !== true || !("data" in parsed))
        throw new RecorderSetupError("RECORDER_PROTOCOL_ERROR", "Recorder returned an invalid setup success envelope", response.status);
      return parsed.data;
    }, this.timeoutMs);
  }
}

// plugins/claude-code/src/gate-command.ts
var MAX_STDIN_BYTES = 1e6;
function jsonRecord(value, field) {
  if (typeof value !== "object" || value === null || Array.isArray(value))
    throw new Error(`${field} must be an object`);
  return value;
}
async function readBoundedStdin(stream, maxBytes = MAX_STDIN_BYTES) {
  if (!Number.isSafeInteger(maxBytes) || maxBytes <= 0)
    throw new RangeError("maxBytes must be a positive integer");
  const reader = stream.getReader();
  const chunks = [];
  let totalBytes = 0;
  try {
    while (true) {
      const next = await reader.read();
      if (next.done)
        break;
      totalBytes += next.value.byteLength;
      if (totalBytes > maxBytes) {
        try {
          await reader.cancel();
        } catch {}
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
async function stdinText() {
  return readBoundedStdin(Bun.stdin.stream());
}
function sessionIdFromInput(input) {
  if (typeof input.session_id === "string" && input.session_id.trim().length > 0)
    return input.session_id;
  const value = process.env.AI_REVIEW_SESSION_ID;
  if (value === undefined || value.trim().length === 0)
    throw new Error("Claude session id is unavailable; restart the session so the plugin can initialize it");
  return value;
}
function cwdFromInput(input) {
  const value = process.env.AI_REVIEW_REPOSITORY_ROOT ?? (typeof input.cwd === "string" && input.cwd.trim().length > 0 ? input.cwd : process.cwd());
  return resolve2(value);
}
function filePathFromTool(input) {
  if (typeof input.tool_input !== "object" || input.tool_input === null || Array.isArray(input.tool_input))
    return null;
  const toolInput = input.tool_input;
  for (const key of ["file_path", "notebook_path", "path"]) {
    if (typeof toolInput[key] === "string" && toolInput[key].trim().length > 0)
      return resolve2(toolInput[key]);
  }
  return null;
}
function shellCommandFromTool(input) {
  if (typeof input.tool_input !== "object" || input.tool_input === null || Array.isArray(input.tool_input))
    return null;
  const command = input.tool_input.command;
  return typeof command === "string" ? command : null;
}
function deny(reason) {
  return {
    hookSpecificOutput: {
      hookEventName: "PreToolUse",
      permissionDecision: "deny",
      permissionDecisionReason: reason
    }
  };
}
function editReason(path) {
  return [
    `Code edit blocked for ${path}: record a structured judgment first, then retry this exact edit.`,
    "Pipe this JSON to ai-review-record (inside Claude Code) or `bun <plugin>/bin/adapter.mjs record` from a plain shell:",
    '{"targets":[{"path":"<repo-relative-path>","lineStart":1}],"judgment":"<decision>","rationale":"<why>"}',
    "Required: targets[].path, targets[].lineStart, judgment, rationale; lineEnd is optional and contentHash is computed automatically.",
    "The Recorder must be running locally first (ai-review --data-dir ./.ai-review --port 4318, i.e. http://127.0.0.1:4318).",
    "See plugins/claude-code/skills/record-before-edit/SKILL.md."
  ].join(" ");
}
async function checkPreToolUse(input, options = {}) {
  const toolName = typeof input.tool_name === "string" ? input.tool_name : "";
  if (toolName === "Bash" || toolName === "PowerShell") {
    const command = shellCommandFromTool(input);
    if (command === null || !likelyCodeMutation(command))
      return null;
    return deny("Shell command blocked because it may edit code. Record a judgment first with ai-review-record, then use Edit or Write; arbitrary shell mutation is not accepted by the judgment gate.");
  }
  if (toolName !== "Edit" && toolName !== "Write" && toolName !== "NotebookEdit" && toolName !== "MultiEdit")
    return null;
  const filePath = filePathFromTool(input);
  if (filePath === null)
    return deny("Code edit blocked because the hook could not identify its target path; use Edit or Write with a file path after recording a judgment.");
  let sessionId;
  try {
    sessionId = sessionIdFromInput(input);
  } catch (error) {
    return deny(error instanceof Error ? error.message : String(error));
  }
  const repositoryRoot = cwdFromInput(input);
  const permit = await findDecisionPermit({
    sessionId,
    repositoryRoot,
    filePath,
    gateRoot: options.gateRoot ?? defaultGateRoot()
  });
  if (permit === null)
    return deny(editReason(filePath));
  try {
    const state = await readCurrentFileState({ repositoryRoot: permit.repositoryRoot, filePath });
    if (state.contentHash !== permit.contentHash)
      return deny("Automatic snapshot failed before edit: target content changed since judgment");
    const bridge = options.bridge ?? new RecorderBridge;
    const captured = await bridge.captureAutomaticSnapshot({
      recordId: permit.recordId,
      captureId: permit.captureId,
      sourcePath: permit.path,
      content: state.content,
      beforeMissing: state.beforeMissing
    });
    if (captured.success)
      return null;
    return deny(`Automatic snapshot failed before edit: ${captured.message}`);
  } catch (error) {
    return deny(`Automatic snapshot failed before edit: ${error instanceof Error ? error.message : String(error)}`);
  }
}
async function checkPostToolUse(input, options = {}) {
  const toolName = typeof input.tool_name === "string" ? input.tool_name : "";
  if (toolName !== "Edit" && toolName !== "Write" && toolName !== "NotebookEdit" && toolName !== "MultiEdit")
    return;
  const filePath = filePathFromTool(input);
  if (filePath === null)
    return;
  let sessionId;
  try {
    sessionId = sessionIdFromInput(input);
  } catch {
    return;
  }
  await consumeDecisionPermitAfterEdit({
    sessionId,
    repositoryRoot: cwdFromInput(input),
    filePath,
    gateRoot: options.gateRoot ?? defaultGateRoot()
  });
}
function shellQuote(value) {
  return "'" + value.replaceAll("'", `'"'"'`) + "'";
}
function repositoryId2(root) {
  return createHash3("sha256").update(root, "utf8").digest("hex");
}
function sessionRegistration(root, sessionId) {
  return {
    session_id: sessionId,
    repository_id: repositoryId2(root),
    agent_type: "claude-code",
    started_at: new Date().toISOString(),
    status: "active"
  };
}
async function handleSessionStart(input, options = {}) {
  const root = jsonRecord(input, "SessionStart input");
  const sessionId = typeof root.session_id === "string" ? root.session_id : "";
  const cwd = typeof root.cwd === "string" ? resolve2(root.cwd) : process.cwd();
  if (sessionId.trim().length === 0)
    throw new Error("SessionStart input did not include session_id");
  const canonicalRoot = await realpath2(cwd).catch(() => cwd);
  const setupClient = options.setupClient ?? new RecorderSetupClient;
  let registration;
  let setupError;
  try {
    registration = (await setupClient.ensureSession(canonicalRoot, sessionRegistration(canonicalRoot, sessionId))).session;
  } catch (error) {
    setupError = error;
  }
  const envFile = options.envFile ?? process.env.CLAUDE_ENV_FILE;
  if (envFile !== undefined && envFile.trim().length > 0) {
    await appendFile(envFile, `export AI_REVIEW_SESSION_ID=${shellQuote(sessionId)}
export AI_REVIEW_REPOSITORY_ROOT=${shellQuote(canonicalRoot)}
export AI_REVIEW_AGENT_TYPE=claude-code
`, "utf8");
  }
  if (setupError !== undefined)
    throw setupError;
  if (registration === undefined)
    throw new Error("SessionStart registration did not return a session");
  return registration;
}
async function recordDecision(value, options = {}) {
  const agentType = options.agentType ?? (process.env.AI_REVIEW_AGENT_TYPE === "codex" ? "codex" : "claude-code");
  const sessionId = options.sessionId ?? process.env.AI_REVIEW_SESSION_ID;
  const repositoryRoot = options.repositoryRoot ?? process.env.AI_REVIEW_REPOSITORY_ROOT;
  const event = await normalizeDecisionProposal(value, {
    ...sessionId === undefined ? {} : { sessionId },
    ...repositoryRoot === undefined ? {} : { repositoryRoot }
  });
  const record = mapHostEvent(agentType, event);
  const bridge = options.bridge ?? new RecorderBridge;
  const submitted = await bridge.submit(record);
  if (!submitted.success) {
    return {
      success: false,
      recordId: record.record_id,
      ...submitted.status === undefined ? {} : { status: submitted.status },
      code: submitted.code,
      message: submitted.message
    };
  }
  const permits = await grantDecisionPermits(event, {
    recordId: record.record_id,
    ...options.gateRoot === undefined ? {} : { gateRoot: options.gateRoot }
  });
  return { success: true, recordId: record.record_id, status: submitted.status, duplicate: submitted.duplicate, permits: permits.permits };
}
async function runPreEditHook() {
  const result = await checkPreToolUse(JSON.parse(await stdinText()));
  if (result !== null)
    process.stdout.write(`${JSON.stringify(result)}
`);
}
async function runPostEditHook() {
  await checkPostToolUse(JSON.parse(await stdinText()));
}
async function runRecordCommand() {
  try {
    const result = await recordDecision(JSON.parse(await stdinText()));
    process.stdout.write(`${JSON.stringify(result)}
`);
    if (!result.success)
      process.exitCode = 1;
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    process.stdout.write(`${JSON.stringify({ success: false, recordId: "", code: "INVALID_RECORD", message })}
`);
    process.exitCode = 1;
  }
}
async function runSessionStartHook() {
  try {
    await handleSessionStart(JSON.parse(await stdinText()));
  } catch (error) {
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}
`);
    if (!(error instanceof RecorderSetupError))
      process.exitCode = 1;
  }
}

// plugins/claude-code/src/index.ts
if (import.meta.main) {
  const command = process.argv[2];
  if (command === "pre-edit") {
    await runPreEditHook();
  } else if (command === "post-edit") {
    await runPostEditHook();
  } else if (command === "record") {
    await runRecordCommand();
  } else if (command === "session-start") {
    await runSessionStartHook();
  } else {
    await runAdapter("claude-code", process.stdin, process.stdout);
  }
}
export {
  RecorderBridge,
  checkPostToolUse,
  checkPreToolUse,
  handleSessionStart,
  mapHostEvent,
  recordDecision,
  runAdapter
};
