import { readFile } from "node:fs/promises";
import { homedir } from "node:os";
import { isAbsolute } from "node:path";
import {
  isAgentType,
  isRecord,
  validateReviewSession,
  type AgentType,
  type ReviewSession,
  type ReviewSessionStatus,
} from "../../../packages/contracts/src/index";
import {
  DEFAULT_RECORDER_ENDPOINT,
  DEFAULT_RECORDER_TOKEN_PATH,
  type FetchLike,
} from "./bridge";

const MAX_RESPONSE_BYTES = 1_000_000;
const DEFAULT_TIMEOUT_MS = 2_000;

type JsonObject = Record<string, unknown>;

export interface RecorderSetupOptions {
  endpoint?: string;
  tokenPath?: string;
  fetchImpl?: FetchLike;
  timeoutMs?: number;
}

export interface RepositoryRegistration {
  repository_id: string;
  root: string;
  created_at: string;
}

export interface SessionRegistration {
  session_id: string;
  repository_id: string;
  agent_type: AgentType;
  started_at: string;
  status: ReviewSessionStatus;
}

export class RecorderSetupError extends Error {
  readonly code: string;
  readonly status?: number;

  constructor(code: string, message: string, status?: number) {
    super(message);
    this.name = "RecorderSetupError";
    this.code = code;
    if (status !== undefined) this.status = status;
  }
}

function loopbackEndpoint(value: string): string {
  let url: URL;
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

function positiveTimeout(value: number): number {
  if (!Number.isSafeInteger(value) || value <= 0) throw new RecorderSetupError("INVALID_TIMEOUT", "Recorder setup timeout must be a positive integer");
  return value;
}

function resourceEndpoint(endpoint: string, resource: "repositories" | "sessions"): string {
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

function objectValue(value: unknown, field: string): JsonObject {
  if (!isRecord(value)) throw new RecorderSetupError("RECORDER_PROTOCOL_ERROR", `Recorder response data.${field} must be an object`);
  return value;
}

function requiredString(value: unknown, field: string): string {
  if (typeof value !== "string" || value.trim().length === 0) throw new RecorderSetupError("RECORDER_PROTOCOL_ERROR", `Recorder response ${field} must be a non-empty string`);
  return value;
}

function errorDetail(value: unknown): { code?: string; message?: string } {
  if (!isRecord(value) || !isRecord(value.error)) return {};
  return {
    ...(typeof value.error.code === "string" ? { code: value.error.code } : {}),
    ...(typeof value.error.message === "string" ? { message: value.error.message } : {}),
  };
}

async function responseJson(response: Response): Promise<unknown> {
  const text = await response.text();
  if (new TextEncoder().encode(text).byteLength > MAX_RESPONSE_BYTES) throw new RecorderSetupError("PAYLOAD_TOO_LARGE", "Recorder response exceeds the setup limit");
  if (text.length === 0) return null;
  try {
    return JSON.parse(text) as unknown;
  } catch {
    throw new RecorderSetupError("RECORDER_PROTOCOL_ERROR", "Recorder returned malformed JSON");
  }
}

async function withTimeout<T>(operation: (signal: AbortSignal) => Promise<T>, timeoutMs: number): Promise<T> {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), timeoutMs);
  try {
    return await operation(controller.signal);
  } catch (error) {
    if (error instanceof RecorderSetupError) throw error;
    if (controller.signal.aborted) throw new RecorderSetupError("RECORDER_UNAVAILABLE", "Recorder setup request timed out");
    throw new RecorderSetupError("RECORDER_UNAVAILABLE", error instanceof Error ? error.message : String(error));
  } finally {
    clearTimeout(timeout);
  }
}

export class RecorderSetupClient {
  readonly endpoint: string;
  readonly tokenPath: string;
  readonly timeoutMs: number;
  readonly fetchImpl: FetchLike;

  constructor(options: RecorderSetupOptions = {}) {
    this.endpoint = loopbackEndpoint(options.endpoint ?? process.env.RECORDER_URL ?? DEFAULT_RECORDER_ENDPOINT);
    this.tokenPath = options.tokenPath ?? process.env.RECORDER_TOKEN_PATH ?? DEFAULT_RECORDER_TOKEN_PATH;
    this.timeoutMs = positiveTimeout(options.timeoutMs ?? DEFAULT_TIMEOUT_MS);
    this.fetchImpl = options.fetchImpl ?? fetch;
  }

  async registerRepository(root: string): Promise<RepositoryRegistration> {
    if (typeof root !== "string" || root.trim().length === 0 || !isAbsolute(root)) {
      throw new RecorderSetupError("INVALID_RECORD", "repository root must be an absolute path");
    }
    const data = await this.post("repositories", { root });
    const object = objectValue(data, "repository");
    return {
      repository_id: requiredString(object.repository_id, "repository_id"),
      root: requiredString(object.root, "root"),
      created_at: requiredString(object.created_at, "created_at"),
    };
  }

  async registerSession(input: ReviewSession): Promise<SessionRegistration> {
    const validation = validateReviewSession(input);
    if (!validation.success) throw new RecorderSetupError(validation.error.code, validation.error.message);
    const data = await this.post("sessions", validation.data);
    const object = objectValue(data, "session");
    const agentType = requiredString(object.agent_type, "agent_type");
    if (!isAgentType(agentType)) throw new RecorderSetupError("RECORDER_PROTOCOL_ERROR", "Recorder response agent_type is invalid");
    const status = requiredString(object.status, "status");
    if (status !== "active" && status !== "completed" && status !== "failed") throw new RecorderSetupError("RECORDER_PROTOCOL_ERROR", "Recorder response status is invalid");
    return {
      session_id: requiredString(object.session_id, "session_id"),
      repository_id: requiredString(object.repository_id, "repository_id"),
      agent_type: agentType,
      started_at: requiredString(object.started_at, "started_at"),
      status,
    };
  }

  async ensureSession(root: string, input: ReviewSession): Promise<{ repository: RepositoryRegistration; session: SessionRegistration }> {
    const repository = await this.registerRepository(root);
    if (repository.root !== root) throw new RecorderSetupError("INVALID_RECORD", "Recorder returned a repository root different from the requested root");
    if (repository.repository_id !== input.repository_id) throw new RecorderSetupError("INVALID_RECORD", "Recorder returned a repository ID different from the session input");
    const session = await this.registerSession(input);
    return { repository, session };
  }

  private async post(resource: "repositories" | "sessions", body: unknown): Promise<unknown> {
    const endpoint = resourceEndpoint(this.endpoint, resource);
    return withTimeout(async (signal) => {
      let token: string;
      try {
        token = (await readFile(this.tokenPath, "utf8")).trim();
      } catch {
        throw new RecorderSetupError("UNAUTHORIZED", "Recorder token file could not be read");
      }
      if (token.length === 0) throw new RecorderSetupError("UNAUTHORIZED", "Recorder token file is empty");
      const response = await this.fetchImpl(endpoint, {
        method: "POST",
        headers: {
          authorization: `Bearer ${token}`,
          "content-type": "application/json",
        },
        body: JSON.stringify(body),
        signal,
      });
      const parsed = await responseJson(response);
      if (!response.ok) {
        const detail = errorDetail(parsed);
        throw new RecorderSetupError(detail.code ?? "RECORDER_ERROR", detail.message ?? `Recorder returned HTTP ${response.status}`, response.status);
      }
      if (!isRecord(parsed) || parsed.success !== true || !("data" in parsed)) throw new RecorderSetupError("RECORDER_PROTOCOL_ERROR", "Recorder returned an invalid setup success envelope", response.status);
      return parsed.data;
    }, this.timeoutMs);
  }
}

export function defaultSetupTokenPath(): string {
  return process.env.RECORDER_TOKEN_PATH ?? DEFAULT_RECORDER_TOKEN_PATH;
}
