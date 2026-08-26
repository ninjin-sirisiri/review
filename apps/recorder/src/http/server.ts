import { access, lstat, realpath, stat } from "node:fs/promises";
import { constants as fsConstants } from "node:fs";
import { isAbsolute, relative, resolve, sep } from "node:path";
import {
  ContractValidationError,
  ERROR_CODES,
  type ApiFailure,
  type ApiResponse,
  type DecisionRecord,
  type ErrorCode,
  type SnapshotMode,
  type UserDisposition,
  isRecord,
  validateReviewSession,
} from "../../../../packages/contracts/src/index";
import { createRecorderConfig, type RecorderConfig, type RecorderConfigOverrides } from "../config";
import { ensureOwnerToken, readOwnerToken, validateOwnerBearerToken } from "../auth/token";
import { RepositoryRegistry, SourceResolutionError } from "../repositories/registry";
import { RecordService } from "../records/service";
import { SnapshotStore } from "../store/snapshots";
import { PersistenceError, RecordStore } from "../store/records";
import { SourceResolver, type ResolvedSource, type UnresolvedSource } from "../source/resolve";

export const DEFAULT_MAX_JSON_BYTES = 1_000_000;
export const LOOPBACK_ADDRESS = "127.0.0.1";

export interface RecorderServerOptions {
  config?: RecorderConfig | RecorderConfigOverrides;
  dataDir?: string;
  port?: number;
  maxJsonBytes?: number;
  uiRoot?: string;
}

export interface RecorderServer {
  readonly config: RecorderConfig;
  readonly server: ReturnType<typeof Bun.serve>;
  readonly store: RecordStore;
  readonly snapshots: SnapshotStore;
  readonly registry: RepositoryRegistry;
  readonly resolver: SourceResolver;
  readonly service: RecordService;
  readonly token: string;
  stop(): Promise<void>;
}

type ServerConfigInput = RecorderConfig | RecorderConfigOverrides;
type JsonRecord = Record<string, unknown>;
type RecordQueues = Map<string, Promise<unknown>>;

function enqueueRecord<T>(queues: RecordQueues, recordId: string, operation: () => Promise<T>): Promise<T> {
  const previous = queues.get(recordId) ?? Promise.resolve();
  const current = previous.catch(() => undefined).then(operation);
  queues.set(recordId, current);
  void current.finally(() => {
    if (queues.get(recordId) === current) queues.delete(recordId);
  }).catch(() => undefined);
  return current;
}
type SourceSelection = "repository" | { snapshotId: string };

function isRecorderConfig(value: ServerConfigInput): value is RecorderConfig {
  return "databasePath" in value && "snapshotDir" in value && "tokenPath" in value && "bindAddress" in value;
}

function makeConfig(options: RecorderServerOptions): RecorderConfig {
  if (options.config !== undefined) {
    if (isRecorderConfig(options.config) && options.dataDir === undefined && options.port === undefined) {
      return options.config;
    }
    const base = isRecorderConfig(options.config) ? options.config : createRecorderConfig(options.config);
    return createRecorderConfig({
      ...base,
      ...(options.dataDir === undefined ? {} : { dataDir: options.dataDir }),
      ...(options.port === undefined ? {} : { port: options.port }),
    });
  }
  return createRecorderConfig({
    ...(options.dataDir === undefined ? {} : { dataDir: options.dataDir }),
    ...(options.port === undefined ? {} : { port: options.port }),
  });
}

function response<T>(status: number, payload: ApiResponse<T>, headers?: HeadersInit): Response {
  const responseHeaders = new Headers(headers);
  responseHeaders.set("Content-Type", "application/json; charset=utf-8");
  responseHeaders.set("Cache-Control", "no-store");
  return new Response(JSON.stringify(payload), { status, headers: responseHeaders });
}

function success<T>(data: T, status = 200, headers?: HeadersInit): Response {
  return response(status, { success: true, data }, headers);
}

function failure(code: ErrorCode, message: string, status: number, field?: string, details?: Array<{ field?: string; message: string }>): Response {
  const error: ApiFailure["error"] = { code, message };
  if (field !== undefined) error.field = field;
  if (details !== undefined) error.details = details;
  return response(status, { success: false, error });
}

function statusForError(code: ErrorCode): number {
  if (code === ERROR_CODES.UNAUTHORIZED) return 401;
  if (code === ERROR_CODES.PAYLOAD_TOO_LARGE) return 413;
  if (code === ERROR_CODES.REPOSITORY_NOT_REGISTERED) return 404;
  if (code === ERROR_CODES.PATH_OUTSIDE_ROOT) return 422;
  if (code === ERROR_CODES.REVISION_NOT_FOUND) return 404;
  if (code === ERROR_CODES.INVALID_RECORD) return 422;
  return 422;
}

function errorResponse(error: unknown): Response {
  if (error instanceof ContractValidationError || error instanceof PersistenceError || error instanceof SourceResolutionError) {
    const payload = failure(error.code, error.message, statusForError(error.code), error instanceof ContractValidationError ? error.field : undefined);
    if (error.code === ERROR_CODES.PAYLOAD_TOO_LARGE) {
      // The rejected request body was never consumed, so the client's upload stalls
      // on TCP backpressure and Bun's graceful stop() would wait on the unfinished
      // request forever. Declaring Connection: close makes Bun drop the socket
      // right after flushing this response.
      payload.headers.set("Connection", "close");
    }
    return payload;
  }
  if (error instanceof SyntaxError) return failure(ERROR_CODES.INVALID_RECORD, "request body must contain valid JSON", 400);
  return failure(ERROR_CODES.SOURCE_UNAVAILABLE, "request could not be processed", 500);
}


function isAllowedOrigin(origin: string | null): boolean {
  if (origin === null) return true;
  try {
    const parsed = new URL(origin);
    return (parsed.protocol === "http:" || parsed.protocol === "https:") && (parsed.hostname === "127.0.0.1" || parsed.hostname === "localhost");
  } catch {
    return false;
  }
}

function isMutation(method: string): boolean {
  return method !== "GET" && method !== "HEAD" && method !== "OPTIONS";
}

async function parseJsonBody(request: Request, maxBytes: number): Promise<unknown> {
  const declaredLength = request.headers.get("content-length");
  if (declaredLength !== null) {
    const length = Number(declaredLength);
    if (!Number.isFinite(length) || length < 0 || length > maxBytes) {
      throw new PersistenceError(ERROR_CODES.PAYLOAD_TOO_LARGE, "request body exceeds the configured maximum length");
    }
  }
  const reader = request.body?.getReader();
  if (reader === undefined) return JSON.parse("");
  const chunks: Uint8Array[] = [];
  let total = 0;
  try {
    while (true) {
      const result = await reader.read();
      if (result.done) break;
      const chunk = result.value;
      if (chunk.byteLength > maxBytes - total) {
        await reader.cancel();
        throw new PersistenceError(ERROR_CODES.PAYLOAD_TOO_LARGE, "request body exceeds the configured maximum length");
      }
      chunks.push(chunk);
      total += chunk.byteLength;
    }
  } finally {
    reader.releaseLock();
  }
  const body = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    body.set(chunk, offset);
    offset += chunk.byteLength;
  }
  let content: string;
  try {
    content = new TextDecoder("utf-8", { fatal: true }).decode(body);
  } catch {
    throw new SyntaxError("request body must contain valid UTF-8 JSON");
  }
  return JSON.parse(content);
}

function requireJsonContentType(request: Request): Response | null {
  const contentType = request.headers.get("content-type");
  if (contentType === null || contentType.split(";", 1)[0]?.trim().toLowerCase() !== "application/json") {
    return failure(ERROR_CODES.INVALID_RECORD, "content-type must be application/json", 400);
  }
  return null;
}

function routeParts(pathname: string): string[] | null {
  if (!pathname.startsWith("/v1/")) return null;
  try {
    return pathname.slice(4).split("/").map((part) => decodeURIComponent(part));
  } catch {
    return [];
  }
}

function parseSnapshotSelection(value: string | null): SourceSelection | null {
  if (value === "repository") return "repository";
  if (value !== null && value.startsWith("snapshot:") && value.length > "snapshot:".length) {
    return { snapshotId: value.slice("snapshot:".length) };
  }
  return null;
}

function serializeSource(source: ResolvedSource | UnresolvedSource): Record<string, unknown> {
  if (source.state === "resolved" || source.state === "snapshot-resolved") {
    const resolved = source as ResolvedSource;
    return {
      state: resolved.state,
      repository_id: resolved.repositoryId,
      path: resolved.path,
      revision: resolved.revision,
      target: resolved.target,
      content: resolved.content,
      content_hash: resolved.contentHash,
      ...(resolved.snapshot === undefined ? {} : { snapshot: resolved.snapshot }),
    };
  }
  const unresolved = source as UnresolvedSource;
  return {
    state: unresolved.state,
    repository_id: unresolved.repositoryId,
    path: unresolved.path,
    revision: unresolved.revision,
    target: unresolved.target,
    expected_hash: unresolved.expectedHash,
    ...(unresolved.actualHash === undefined ? {} : { actual_hash: unresolved.actualHash }),
    ...(unresolved.message === undefined ? {} : { message: unresolved.message }),
  };
}

function unavailableSnapshotSource(record: DecisionRecord, message: string): Array<Record<string, unknown>> {
  return record.targets.map((target) => serializeSource({
    state: "source-unavailable",
    repositoryId: target.repository_id,
    path: target.path,
    revision: target.revision,
    target,
    expectedHash: target.content_hash,
    message,
  }));
}

async function resolveRecordSources(record: DecisionRecord, resolver: SourceResolver, selection: SourceSelection = "repository"): Promise<Array<Record<string, unknown>>> {
  if (typeof selection === "object") {
    const snapshot = await resolver.snapshots?.get(selection.snapshotId);
    if (snapshot === null || snapshot === undefined) return unavailableSnapshotSource(record, "snapshot is unavailable or has been tampered with");
    if (snapshot.reference.record_id !== record.record_id) return unavailableSnapshotSource(record, "snapshot does not belong to this decision record");
  }
  const sources: Array<Record<string, unknown>> = [];
  for (const target of record.targets) {
    const resolved = await resolver.resolve(target, selection);
    sources.push(serializeSource(resolved));
  }
  return sources;
}

function recordView(record: DecisionRecord, sources: Array<Record<string, unknown>>): { record: DecisionRecord; sources: Array<Record<string, unknown>> } {
  return { record, sources };
}

function unknownRoute(): Response {
  return failure(ERROR_CODES.INVALID_RECORD, "route is not supported", 404);
}

function staticPath(root: string, pathname: string): string | null {
  let decoded: string;
  try {
    decoded = decodeURIComponent(pathname);
  } catch {
    return null;
  }
  const relativePath = decoded === "/" ? "index.html" : decoded.replace(/^\/+/, "");
  const candidate = resolve(root, relativePath);
  const relativeCandidate = relative(root, candidate);
  if (relativeCandidate === ".." || relativeCandidate.startsWith(`..${sep}`) || isAbsolute(relativeCandidate)) return null;
  return candidate;
}

async function serveStatic(root: string | undefined, request: Request): Promise<Response | null> {
  if (root === undefined || (request.method !== "GET" && request.method !== "HEAD")) return null;
  let canonicalRoot: string;
  try {
    canonicalRoot = await realpath(resolve(root));
  } catch {
    return new Response("Not Found", { status: 404 });
  }
  const filePath = staticPath(canonicalRoot, new URL(request.url).pathname);
  if (filePath === null) return new Response("Not Found", { status: 404 });
  let canonicalFile: string;
  try {
    canonicalFile = await realpath(filePath);
    await access(canonicalFile, fsConstants.R_OK);
    if (!(await stat(canonicalFile)).isFile()) return new Response("Not Found", { status: 404 });
  } catch {
    return new Response("Not Found", { status: 404 });
  }
  const relativeFile = relative(canonicalRoot, canonicalFile);
  if (relativeFile === ".." || relativeFile.startsWith(`..${sep}`) || isAbsolute(relativeFile)) return new Response("Not Found", { status: 404 });
  const file = Bun.file(canonicalFile);
  const headers = new Headers({ "Cache-Control": "no-store" });
  const type = file.type || "application/octet-stream";
  headers.set("Content-Type", type);
  if (request.method === "HEAD") return new Response(null, { status: 200, headers });
  return new Response(file, { status: 200, headers });
}
function overlapsPath(first: string, second: string): boolean {
  const relativePath = relative(first, second);
  return relativePath === "" || (!isAbsolute(relativePath) && relativePath !== ".." && !relativePath.startsWith(`..${sep}`));
}

async function canonicalPathAndStorageRoot(path: string): Promise<{ path: string; storageRoot: string }> {
  const lexicalPath = resolve(path);
  try {
    if ((await lstat(lexicalPath)).isSymbolicLink()) {
      throw new RangeError("databasePath must not be a symlink");
    }
  } catch (error) {
    const errno = error as NodeJS.ErrnoException;
    if (errno.code !== "ENOENT") throw error;
  }
  let existingPath = lexicalPath;
  while (true) {
    try {
      const canonicalExisting = await realpath(existingPath);
      const suffix = relative(existingPath, lexicalPath);
      const canonicalPath = resolve(canonicalExisting, suffix);
      const storageRoot = suffix === "" ? resolve(canonicalPath, "..") : canonicalExisting;
      return { path: canonicalPath, storageRoot };
    } catch (error) {
      const errno = error as NodeJS.ErrnoException;
      if (errno.code !== "ENOENT") throw error;
      const parent = resolve(existingPath, "..");
      if (parent === existingPath) throw error;
      existingPath = parent;
    }
  }
}

async function validateUiRoot(dataDir: string, databasePath: string, uiRoot: string | undefined): Promise<string | undefined> {
  if (uiRoot === undefined) return undefined;
  const canonicalDataDir = await realpath(resolve(dataDir));
  const canonicalUiRoot = await realpath(resolve(uiRoot));
  const database = await canonicalPathAndStorageRoot(databasePath);
  if (
    overlapsPath(canonicalDataDir, canonicalUiRoot) ||
    overlapsPath(canonicalUiRoot, canonicalDataDir) ||
    overlapsPath(canonicalUiRoot, database.path) ||
    overlapsPath(database.path, canonicalUiRoot) ||
    overlapsPath(canonicalUiRoot, database.storageRoot) ||
    overlapsPath(database.storageRoot, canonicalUiRoot)
  ) {
    throw new RangeError("uiRoot must not overlap owner storage");
  }
  return canonicalUiRoot;
}

function requireObject(value: unknown, message: string): JsonRecord {
  if (!isRecord(value)) throw new PersistenceError(ERROR_CODES.INVALID_RECORD, message);
  return value;
}

function parseDisposition(value: unknown): UserDisposition {
  if (value !== "unreviewed" && value !== "accepted" && value !== "rejected") {
    throw new PersistenceError(ERROR_CODES.INVALID_RECORD, "user_disposition must be unreviewed, accepted, or rejected");
  }
  return value;
}

async function handleRequest(
  request: Request,
  token: string,
  service: RecordService,
  store: RecordStore,
  registry: RepositoryRegistry,
  resolver: SourceResolver,
  snapshots: SnapshotStore,
  maxJsonBytes: number,
  uiRoot: string | undefined,
  recordQueues: RecordQueues,
): Promise<Response> {
  const url = new URL(request.url);
  const parts = routeParts(url.pathname);
  const staticResponse = parts === null ? await serveStatic(uiRoot, request) : null;
  if (staticResponse !== null && (request.method === "GET" || request.method === "HEAD")) return staticResponse;
  if (!validateOwnerBearerToken(request.headers.get("authorization"), token)) return failure(ERROR_CODES.UNAUTHORIZED, "owner bearer token is required", 401);
  if (parts === null) return staticResponse ?? new Response("Not Found", { status: 404 });
  if (isMutation(request.method) && !isAllowedOrigin(request.headers.get("origin"))) {
    return failure(ERROR_CODES.UNAUTHORIZED, "browser origin is not allowed", 403);
  }
  if (request.method === "OPTIONS") return new Response(null, { status: 204 });

  try {
    if (request.method === "POST" && parts.length === 1 && parts[0] === "repositories") {
      const contentError = requireJsonContentType(request);
      if (contentError) return contentError;
      const input = requireObject(await parseJsonBody(request, maxJsonBytes), "repository request must be an object");
      const root = input.root;
      const repositoryId = input.repository_id;
      if (typeof root !== "string") throw new PersistenceError(ERROR_CODES.INVALID_RECORD, "root must be a string");
      if (repositoryId !== undefined && typeof repositoryId !== "string") throw new PersistenceError(ERROR_CODES.INVALID_RECORD, "repository_id must be a string");
      const repository = await registry.register(root, repositoryId);
      return success(repository, 201);
    }

    if (request.method === "POST" && parts.length === 1 && parts[0] === "sessions") {
      const contentError = requireJsonContentType(request);
      if (contentError) return contentError;
      const input = await parseJsonBody(request, maxJsonBytes);
      const validation = validateReviewSession(input);
      if (!validation.success) return failure(validation.error.code, validation.error.message, 422, validation.error.field, validation.error.details);
      return success(await store.createSession(validation.data), 201);
    }

    if (request.method === "POST" && parts.length === 1 && parts[0] === "decision-records") {
      const contentError = requireJsonContentType(request);
      if (contentError) return contentError;
      const input = await parseJsonBody(request, maxJsonBytes);
      const canonicalInput = await service.preflight(input);
      return enqueueRecord(recordQueues, canonicalInput.record_id, async () => {
        const existing = await service.getDecision(canonicalInput.record_id);
        if (existing !== null) {
          const sources = await resolveRecordSources(existing, resolver);
          return success(recordView(existing, sources), 200);
        }
        const candidate: DecisionRecord = { ...canonicalInput, user_disposition: canonicalInput.user_disposition ?? "unreviewed" };
        const sources = await resolveRecordSources(candidate, resolver);
        const record = await service.record(canonicalInput);
        return success(recordView(record, sources), 201);
      });
    }

    if (request.method === "GET" && parts.length === 2 && parts[0] === "decision-records" && parts[1] !== undefined) {
      const record = await service.getDecision(parts[1]);
      if (record === null) return failure(ERROR_CODES.INVALID_RECORD, "decision record was not found", 404);
      const sources = await resolveRecordSources(record, resolver);
      return success(recordView(record, sources));
    }

    if (request.method === "GET" && parts.length === 1 && parts[0] === "decision-records") {
      const repositoryId = url.searchParams.get("repository_id");
      if (repositoryId === null || repositoryId.trim().length === 0) return failure(ERROR_CODES.INVALID_RECORD, "repository_id query parameter is required", 422, "repository_id");
      return success(await service.listDecisions(repositoryId));
    }

    if (request.method === "GET" && parts.length === 1 && parts[0] === "repositories") {
      return success(await registry.list());
    }

    if (request.method === "GET" && parts.length === 3 && parts[0] === "repositories" && parts[2] === "files") {
      const repository = await registry.get(parts[1] ?? "");
      if (repository === null) return failure(ERROR_CODES.REPOSITORY_NOT_REGISTERED, "repository is not registered", 404);
      const paths = await resolver.git.listWorktreeFiles(repository.root);
      paths.sort();
      return success({ repository_id: repository.repository_id, paths });
    }

    if (request.method === "GET" && parts.length === 3 && parts[0] === "repositories" && parts[2] === "diff") {
      const repository = await registry.get(parts[1] ?? "");
      if (repository === null) return failure(ERROR_CODES.REPOSITORY_NOT_REGISTERED, "repository is not registered", 404);
      const pathParam = url.searchParams.get("path");
      if (pathParam === null || pathParam.trim().length === 0) return failure(ERROR_CODES.INVALID_RECORD, "path query parameter is required", 422, "path");
      await registry.assertTarget(repository.repository_id, pathParam);
      const base = url.searchParams.get("base") ?? "HEAD";
      const baseSha = await resolver.git.resolveRevision(repository.root, base);
      return success(await resolver.git.readPathDiff(repository.root, baseSha, pathParam));
    }

    if (request.method === "PATCH" && parts.length === 3 && parts[0] === "decision-records" && parts[2] === "disposition") {
      const contentError = requireJsonContentType(request);
      if (contentError) return contentError;
      const input = requireObject(await parseJsonBody(request, maxJsonBytes), "disposition request must be an object");
      const disposition = parseDisposition(input.user_disposition ?? input.disposition);
      return success(await service.setDisposition(parts[1] ?? "", disposition));
    }

    if (request.method === "GET" && parts.length === 3 && parts[0] === "decision-records" && parts[2] === "source") {
      const record = await service.getDecision(parts[1] ?? "");
      if (record === null) return failure(ERROR_CODES.INVALID_RECORD, "decision record was not found", 404);
      const selection = parseSnapshotSelection(url.searchParams.get("source"));
      if (selection === null) return failure(ERROR_CODES.INVALID_RECORD, "source must be repository or snapshot:<snapshotId>", 422, "source");
      const sources = await resolveRecordSources(record, resolver, selection);
      if (sources.length === 1) return success(sources[0]);
      return success(sources);
    }

    if (request.method === "POST" && parts.length === 3 && parts[0] === "decision-records" && parts[2] === "snapshot") {
      const contentError = requireJsonContentType(request);
      if (contentError) return contentError;
      const input = requireObject(await parseJsonBody(request, maxJsonBytes), "snapshot request must be an object");
      const mode = input.mode;
      const content = input.content;
      if (mode !== "changed-files" && mode !== "patch") throw new PersistenceError(ERROR_CODES.INVALID_RECORD, "mode must be changed-files or patch");
      if (typeof content !== "string") throw new PersistenceError(ERROR_CODES.INVALID_RECORD, "content must be a string");
      const reference = await service.createSnapshot(parts[1] ?? "", mode as SnapshotMode, content);
      return success(reference, 201);
    }

    if (request.method === "DELETE" && parts.length === 2 && parts[0] === "snapshots") {
      await snapshots.delete(parts[1] ?? "");
      return success(null);
    }

    return unknownRoute();
  } catch (error) {
    return errorResponse(error);
  }
}
export async function createRecorderServer(options: RecorderServerOptions = {}): Promise<RecorderServer> {
  const config = makeConfig(options);
  if (config.bindAddress !== LOOPBACK_ADDRESS) throw new RangeError("Recorder API must bind to 127.0.0.1");
  const token = await ensureOwnerToken(config);
  const staticUiRoot = await validateUiRoot(config.dataDir, config.databasePath, options.uiRoot);
  const store = new RecordStore(config);
  const snapshots = new SnapshotStore(store, config);
  const registry = new RepositoryRegistry(store);
  const resolver = new SourceResolver(registry, snapshots);
  const service = new RecordService(store, snapshots);
  const recordQueues: RecordQueues = new Map();
  const maxJsonBytes = options.maxJsonBytes ?? DEFAULT_MAX_JSON_BYTES;
  if (!Number.isSafeInteger(maxJsonBytes) || maxJsonBytes <= 0) throw new RangeError("maxJsonBytes must be a positive integer");
  const server = Bun.serve({
    hostname: config.bindAddress,
    port: config.port,
    fetch: async (request) => {
      try {
        return await handleRequest(request, token, service, store, registry, resolver, snapshots, maxJsonBytes, staticUiRoot, recordQueues);
      } catch (error) {
        return errorResponse(error);
      }
    },
  });
  return {
    config,
    server,
    store,
    snapshots,
    registry,
    resolver,
    service,
    token,
    async stop() {
      await server.stop();
      store.close();
    },
  };
}

export async function createRecorderServerFromConfig(config: RecorderConfig): Promise<RecorderServer> {
  return createRecorderServer({ config });
}

export async function getRecorderToken(config: RecorderConfig): Promise<string> {
  return readOwnerToken(config);
}

