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
  codex: true
};
var CHECK_STATUSES = {
  passed: true,
  failed: true,
  "not-run": true
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
    return invalid("agent_type must be claude-code or codex", "agent_type");
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
    const existing = this.pending.get(record.record_id);
    if (existing !== undefined)
      return existing;
    if (this.pending.size >= this.queueCapacity) {
      return Promise.resolve(responseFailure(record.record_id, "QUEUE_EXHAUSTED", "Recorder queue capacity is exhausted", 0));
    }
    const operation = this.postWithRetry(record).finally(() => {
      if (this.pending.get(record.record_id) === operation)
        this.pending.delete(record.record_id);
    });
    this.pending.set(record.record_id, operation);
    return operation;
  }
  async postWithRetry(record) {
    const startedAt = Date.now();
    let attempts = 0;
    let lastFailure;
    while (attempts < this.maxAttempts && Date.now() - startedAt <= this.maxRetryDurationMs) {
      attempts += 1;
      try {
        const token = (await readFile(this.tokenPath, "utf8")).trim();
        if (token.length === 0)
          throw new Error("Recorder token file is empty");
        const remaining = this.maxRetryDurationMs - (Date.now() - startedAt);
        if (remaining <= 0)
          break;
        const { response, body } = await requestWithTimeout(this.fetchImpl, this.endpoint, {
          method: "POST",
          headers: {
            authorization: `Bearer ${token}`,
            "content-type": "application/json"
          },
          body: JSON.stringify(record)
        }, remaining);
        if (response.ok) {
          if (typeof body !== "object" || body === null || Array.isArray(body) || body.success !== true) {
            return responseFailure(record.record_id, "RECORDER_PROTOCOL_ERROR", "Recorder returned an invalid success envelope", attempts, response.status);
          }
          return {
            success: true,
            status: response.status,
            duplicate: response.status === 200,
            recordId: record.record_id
          };
        }
        const detail = responseErrorBody(body);
        const failure2 = responseFailure(record.record_id, detail.code ?? (retryableStatus(response.status) ? "RECORDER_UNAVAILABLE" : "RECORDER_ERROR"), detail.message ?? `Recorder returned HTTP ${response.status}`, attempts, response.status);
        lastFailure = failure2;
        if (!retryableStatus(response.status))
          return failure2;
      } catch (error) {
        lastFailure = responseFailure(record.record_id, "RECORDER_UNAVAILABLE", error instanceof Error ? error.message : String(error), attempts);
      }
      const elapsed = Date.now() - startedAt;
      if (attempts >= this.maxAttempts || elapsed >= this.maxRetryDurationMs)
        break;
      const delay = Math.min(this.maxRetryDelayMs, this.retryBaseDelayMs * 2 ** (attempts - 1), this.maxRetryDurationMs - elapsed);
      await sleep(delay);
    }
    return responseFailure(record.record_id, lastFailure?.code === "RECORDER_ERROR" ? "RECORDER_ERROR" : "RECORDER_UNAVAILABLE", "Recorder unavailable after bounded retries", attempts, lastFailure?.status);
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

// plugins/claude-code/src/index.ts
if (import.meta.main) {
  await runAdapter("claude-code", process.stdin, process.stdout);
}
export {
  runAdapter,
  mapHostEvent,
  RecorderBridge
};
