import { readFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import type { DecisionRecordInput } from "../../../packages/contracts/src/index";
import type { AdapterBridge, SubmitFailure, SubmitResult } from "./adapter-contract";

export const DEFAULT_RECORDER_ENDPOINT = "http://127.0.0.1:4318/v1/decision-records";
export const DEFAULT_RECORDER_TOKEN_PATH = join(homedir(), ".ai-code-review-evidence", "token");
const MAX_RESPONSE_BYTES = 1_000_000;

export type FetchLike = (input: string | URL | Request, init?: RequestInit) => Promise<Response>;

export interface RecorderBridgeOptions {
  /** Full local endpoint; non-loopback hosts are rejected. */
  endpoint?: string;
  /** Owner token file, never a command-line argument. */
  tokenPath?: string;
  fetchImpl?: FetchLike;
  queueCapacity?: number;
  maxAttempts?: number;
  retryBaseDelayMs?: number;
  maxRetryDelayMs?: number;
  maxRetryDurationMs?: number;
}

function positiveInteger(value: number, field: string): number {
  if (!Number.isSafeInteger(value) || value <= 0) throw new RangeError(`${field} must be a positive integer`);
  return value;
}

function nonNegativeInteger(value: number, field: string): number {
  if (!Number.isSafeInteger(value) || value < 0) throw new RangeError(`${field} must be a non-negative integer`);
  return value;
}

function localEndpoint(value: string): string {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new RangeError("Recorder endpoint must be a valid URL");
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") throw new RangeError("Recorder endpoint must use HTTP or HTTPS");
  if (url.hostname !== "127.0.0.1" && url.hostname !== "localhost" && url.hostname !== "[::1]") {
    throw new RangeError("Recorder endpoint must use a loopback host");
  }
  return url.toString();
}

function responseFailure(recordId: string, code: string, message: string, attempts: number, status?: number): SubmitFailure {
  return {
    success: false,
    code,
    message,
    error: message,
    recordId,
    attempts,
    ...(status === undefined ? {} : { status }),
  };
}

function retryableStatus(status: number): boolean {
  return status === 408 || status === 425 || status === 429 || status >= 500;
}

async function boundedResponseJson(response: Response): Promise<unknown> {
  const body = await response.text();
  if (new TextEncoder().encode(body).byteLength > MAX_RESPONSE_BYTES) throw new Error("Recorder response exceeds the adapter limit");
  if (body.length === 0) return null;
  try {
    return JSON.parse(body) as unknown;
  } catch {
    throw new Error("Recorder returned malformed JSON");
  }
}

function responseErrorBody(body: unknown): { code?: string; message?: string } {
  if (typeof body !== "object" || body === null || Array.isArray(body)) return {};
  const root = body as Record<string, unknown>;
  if (typeof root.error !== "object" || root.error === null || Array.isArray(root.error)) return {};
  const error = root.error as Record<string, unknown>;
  return {
    ...(typeof error.code === "string" ? { code: error.code } : {}),
    ...(typeof error.message === "string" ? { message: error.message } : {}),
  };
}

function sleep(milliseconds: number): Promise<void> {
  if (milliseconds <= 0) return Promise.resolve();
  const { promise, resolve } = Promise.withResolvers<void>();
  setTimeout(resolve, milliseconds);
  return promise;
}

async function requestWithTimeout(
  fetchImpl: FetchLike,
  endpoint: string,
  init: RequestInit,
  timeoutMs: number,
): Promise<{ response: Response; body: unknown }> {
  const controller = new AbortController();
  const request = fetchImpl(endpoint, { ...init, signal: controller.signal }).then(async (response) => ({ response, body: await boundedResponseJson(response) }));
  const timeout = Promise.withResolvers<{ response: Response; body: unknown }>();
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

export class RecorderBridge implements AdapterBridge {
  readonly endpoint: string;
  readonly tokenPath: string;
  readonly queueCapacity: number;
  readonly maxAttempts: number;
  readonly retryBaseDelayMs: number;
  readonly maxRetryDelayMs: number;
  readonly maxRetryDurationMs: number;
  readonly fetchImpl: FetchLike;
  private readonly pending = new Map<string, Promise<SubmitResult>>();

  constructor(options: RecorderBridgeOptions = {}) {
    const endpointValue = options.endpoint ?? process.env.RECORDER_URL ?? DEFAULT_RECORDER_ENDPOINT;
    this.endpoint = localEndpoint(endpointValue);
    this.tokenPath = options.tokenPath ?? process.env.RECORDER_TOKEN_PATH ?? DEFAULT_RECORDER_TOKEN_PATH;
    this.queueCapacity = positiveInteger(options.queueCapacity ?? 32, "queueCapacity");
    this.maxAttempts = positiveInteger(options.maxAttempts ?? 3, "maxAttempts");
    this.retryBaseDelayMs = nonNegativeInteger(options.retryBaseDelayMs ?? 50, "retryBaseDelayMs");
    this.maxRetryDelayMs = nonNegativeInteger(options.maxRetryDelayMs ?? 500, "maxRetryDelayMs");
    this.maxRetryDurationMs = positiveInteger(options.maxRetryDurationMs ?? 2_000, "maxRetryDurationMs");
    this.fetchImpl = options.fetchImpl ?? fetch;
  }

  submit(record: DecisionRecordInput): Promise<SubmitResult> {
    const pendingKey = `record:${record.record_id}`;
    const existing = this.pending.get(pendingKey);
    if (existing !== undefined) return existing;
    if (this.pending.size >= this.queueCapacity) {
      return Promise.resolve(responseFailure(record.record_id, "QUEUE_EXHAUSTED", "Recorder queue capacity is exhausted", 0));
    }
    const operation = this.postWithRetry(record.record_id, this.endpoint, record).finally(() => {
      if (this.pending.get(pendingKey) === operation) this.pending.delete(pendingKey);
    });
    this.pending.set(pendingKey, operation);
    return operation;
  }

  captureAutomaticSnapshot(input: {
    recordId: string;
    captureId: string;
    sourcePath: string;
    content: string;
    beforeMissing: boolean;
  }): Promise<SubmitResult> {
    const pendingKey = `capture:${input.captureId}`;
    const existing = this.pending.get(pendingKey);
    if (existing !== undefined) return existing;
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
      before_missing: input.beforeMissing,
    }, true).finally(() => {
      if (this.pending.get(pendingKey) === operation) this.pending.delete(pendingKey);
    });
    this.pending.set(pendingKey, operation);
    return operation;
  }

  private async postWithRetry(recordId: string, endpoint: string, body: unknown, preserveServerFailure = false): Promise<SubmitResult> {
    const startedAt = Date.now();
    let attempts = 0;
    let lastFailure: SubmitFailure | undefined;
    let lastServerFailure: SubmitFailure | undefined;
    while (attempts < this.maxAttempts && Date.now() - startedAt <= this.maxRetryDurationMs) {
      attempts += 1;
      try {
        const token = (await readFile(this.tokenPath, "utf8")).trim();
        if (token.length === 0) throw new Error("Recorder token file is empty");
        const remaining = this.maxRetryDurationMs - (Date.now() - startedAt);
        if (remaining <= 0) break;
        const { response, body: responseBody } = await requestWithTimeout(this.fetchImpl, endpoint, {
          method: "POST",
          headers: {
            authorization: `Bearer ${token}`,
            "content-type": "application/json",
          },
          body: JSON.stringify(body),
        }, remaining);
        if (response.ok) {
          if (typeof responseBody !== "object" || responseBody === null || Array.isArray(responseBody) || (responseBody as Record<string, unknown>).success !== true) {
            const detail = responseErrorBody(responseBody);
            if (preserveServerFailure && (detail.code !== undefined || detail.message !== undefined)) {
              return responseFailure(recordId, detail.code ?? "RECORDER_PROTOCOL_ERROR", detail.message ?? "Recorder returned an invalid success envelope", attempts, response.status);
            }
            return responseFailure(recordId, "RECORDER_PROTOCOL_ERROR", "Recorder returned an invalid success envelope", attempts, response.status);
          }
          return {
            success: true,
            status: response.status,
            duplicate: response.status === 200,
            recordId,
          };
        }
        const detail = responseErrorBody(responseBody);
        const failure = responseFailure(
          recordId,
          detail.code ?? (retryableStatus(response.status) ? "RECORDER_UNAVAILABLE" : "RECORDER_ERROR"),
          detail.message ?? `Recorder returned HTTP ${response.status}`,
          attempts,
          response.status,
        );
        lastFailure = failure;
        lastServerFailure = failure;
        if (!retryableStatus(response.status)) return failure;
      } catch (error) {
        lastFailure = responseFailure(recordId, "RECORDER_UNAVAILABLE", error instanceof Error ? error.message : String(error), attempts);
      }
      const elapsed = Date.now() - startedAt;
      if (attempts >= this.maxAttempts || elapsed >= this.maxRetryDurationMs) break;
      const delay = Math.min(this.maxRetryDelayMs, this.retryBaseDelayMs * 2 ** (attempts - 1), this.maxRetryDurationMs - elapsed);
      await sleep(delay);
    }
    if (preserveServerFailure && lastServerFailure !== undefined) {
      return { ...lastServerFailure, attempts };
    }
    return responseFailure(
      recordId,
      lastFailure?.code === "RECORDER_ERROR" ? "RECORDER_ERROR" : "RECORDER_UNAVAILABLE",
      "Recorder unavailable after bounded retries",
      attempts,
      lastFailure?.status,
    );
  }
}
