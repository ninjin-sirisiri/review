import { ContractValidationError, isRecord, parseSnapshotDiffResponse } from "../../../packages/contracts/src/index";
import type {
  ApiResponse,
  BranchList,
  CheckEvidence,
  DecisionRecord,
  FileDiff,
  RepositoryFiles,
  RevisionRef,
  SnapshotDiff,
  SnapshotDiffResponse,
  TargetReference,
  UserDisposition,
} from "../../../packages/contracts/src/index";

export type DecisionRecordSummary = Pick<
  DecisionRecord,
  | "record_id"
  | "session_id"
  | "repository_id"
  | "agent_type"
  | "revision"
  | "targets"
  | "judgment"
  | "created_at"
  | "user_disposition"
>;

export interface RegisteredRepositorySummary {
  repository_id: string;
  root: string;
  created_at: string;
}

export interface ResolvedSourceReference {
  state: "resolved" | "snapshot-resolved";
  repository_id: string;
  path: string;
  revision: RevisionRef;
  target: TargetReference;
  content: string;
  content_hash: string;
  snapshot?: {
    snapshot_id: string;
    record_id: string;
    mode: "changed-files" | "patch" | "git";
    path: string;
    content_hash: string;
    created_at: string;
    base_sha?: string;
    source_path?: string;
  };
}

export interface UnresolvedSourceReference {
  state: "hash-mismatch" | "revision-not-found" | "source-unavailable";
  repository_id: string;
  path: string;
  revision: RevisionRef;
  target: TargetReference;
  expected_hash: string;
  actual_hash?: string;
  message?: string;
}

export type SourceReferenceData = ResolvedSourceReference | UnresolvedSourceReference;

export interface DecisionRecordDetail {
  record: DecisionRecord;
  sources: SourceReferenceData[];
}

export type ReviewApiErrorCode =
  | "UNAUTHORIZED"
  | "INVALID_RECORD"
  | "REPOSITORY_NOT_REGISTERED"
  | "PATH_OUTSIDE_ROOT"
  | "REVISION_NOT_FOUND"
  | "HASH_MISMATCH"
  | "SOURCE_UNAVAILABLE"
  | "DUPLICATE_RECORD"
  | "PAYLOAD_TOO_LARGE"
  | "NETWORK_ERROR"
  | "INVALID_RESPONSE"
  | "UNKNOWN";

export class ReviewApiError extends Error {
  readonly status: number;
  readonly code: ReviewApiErrorCode;
  readonly details: Array<{ field?: string; message: string }> | undefined;

  constructor(
    message: string,
    options: {
      status?: number;
      code?: ReviewApiErrorCode;
      details?: Array<{ field?: string; message: string }> | undefined;
    } = {},
  ) {
    super(message);
    this.name = "ReviewApiError";
    this.status = options.status ?? 0;
    this.code = options.code ?? "UNKNOWN";
    this.details = options.details;
  }
}

export type FetchLike = (input: RequestInfo | URL, init?: RequestInit) => Promise<Response>;

export interface ReviewApiOptions {
  baseUrl?: string;
  fetchImpl?: FetchLike;
}

function normalizeCode(value: unknown): ReviewApiErrorCode {
  if (
    value === "UNAUTHORIZED" ||
    value === "INVALID_RECORD" ||
    value === "REPOSITORY_NOT_REGISTERED" ||
    value === "PATH_OUTSIDE_ROOT" ||
    value === "REVISION_NOT_FOUND" ||
    value === "HASH_MISMATCH" ||
    value === "SOURCE_UNAVAILABLE" ||
    value === "DUPLICATE_RECORD" ||
    value === "PAYLOAD_TOO_LARGE"
  ) {
    return value;
  }
  return "UNKNOWN";
}

function responseError(payload: unknown, status: number): ReviewApiError {
  if (isRecord(payload) && payload.success === false && isRecord(payload.error)) {
    const error = payload.error;
    return new ReviewApiError(
      typeof error.message === "string" ? error.message : "Recorder request failed",
      {
        status,
        code: normalizeCode(error.code),
        details: Array.isArray(error.details)
          ? error.details.filter(
              (detail): detail is { field?: string; message: string } =>
                isRecord(detail) && typeof detail.message === "string",
            )
          : undefined,
      },
    );
  }
  return new ReviewApiError(`Recorder request failed with status ${status}`, { status });
}

function apiData<T>(payload: unknown, status: number): T {
  if (!isRecord(payload) || payload.success !== true || !("data" in payload)) {
    throw responseError(payload, status);
  }
  return payload.data as T;
}

function joinUrl(baseUrl: string, path: string): string {
  if (baseUrl.length === 0) return path;
  return `${baseUrl.replace(/\/$/, "")}${path}`;
}

export class ReviewApi {
  private readonly baseUrl: string;
  private readonly token: string;
  private readonly fetchImpl: FetchLike;

  constructor(token: string, options: ReviewApiOptions = {}) {
    const normalizedToken = token.trim();
    if (normalizedToken.length === 0) {
      throw new ReviewApiError("Owner bearer token is required", { status: 401, code: "UNAUTHORIZED" });
    }
    this.token = normalizedToken;
    this.baseUrl = options.baseUrl ?? "";
    this.fetchImpl = options.fetchImpl ?? globalThis.fetch.bind(globalThis);
  }

  private async request<T>(
    path: string,
    init: RequestInit = {},
    parseData: (data: unknown, status: number) => T = (data) => data as T,
  ): Promise<T> {
    let response: Response;
    try {
      response = await this.fetchImpl(joinUrl(this.baseUrl, path), {
        ...init,
        headers: {
          Accept: "application/json",
          Authorization: `Bearer ${this.token}`,
          ...(init.body === undefined ? {} : { "Content-Type": "application/json" }),
          ...init.headers,
        },
      });
    } catch (error) {
      throw new ReviewApiError(error instanceof Error ? error.message : "Unable to reach Recorder", {
        code: "NETWORK_ERROR",
      });
    }

    let payload: unknown;
    try {
      payload = await response.json();
    } catch {
      throw new ReviewApiError("Recorder returned an invalid JSON response", {
        status: response.status,
        code: "INVALID_RESPONSE",
      });
    }
    if (!response.ok) throw responseError(payload, response.status);
    return parseData(apiData<unknown>(payload, response.status), response.status);
  }

  listDecisions(repositoryId: string): Promise<DecisionRecordSummary[]> {
    const normalizedRepositoryId = repositoryId.trim();
    if (normalizedRepositoryId.length === 0) {
      return Promise.reject(new ReviewApiError("Repository ID is required", { status: 422, code: "INVALID_RECORD" }));
    }
    return this.request<DecisionRecordSummary[]>(
      `/v1/decision-records?repository_id=${encodeURIComponent(normalizedRepositoryId)}`,
    );
  }

  listRepositories(): Promise<RegisteredRepositorySummary[]> {
    return this.request<RegisteredRepositorySummary[]>("/v1/repositories");
  }

  listBranches(repositoryId: string): Promise<BranchList> {
    const normalizedRepositoryId = repositoryId.trim();
    if (normalizedRepositoryId.length === 0) {
      return Promise.reject(new ReviewApiError("Repository ID is required", { status: 422, code: "INVALID_RECORD" }));
    }
    return this.request<BranchList>(
      `/v1/repositories/${encodeURIComponent(normalizedRepositoryId)}/branches`,
    );
  }

  listRepositoryFiles(repositoryId: string, branch?: string): Promise<RepositoryFiles> {
    const normalizedRepositoryId = repositoryId.trim();
    if (normalizedRepositoryId.length === 0) {
      return Promise.reject(new ReviewApiError("Repository ID is required", { status: 422, code: "INVALID_RECORD" }));
    }
    const params = new URLSearchParams();
    if (typeof branch === "string") params.set("branch", branch);
    const query = params.toString();
    return this.request<RepositoryFiles>(
      `/v1/repositories/${encodeURIComponent(normalizedRepositoryId)}/files${query.length === 0 ? "" : `?${query}`}`,
    );
  }

  getFileDiff(repositoryId: string, path: string, base = "HEAD", branch?: string): Promise<FileDiff> {
    const normalizedRepositoryId = repositoryId.trim();
    if (normalizedRepositoryId.length === 0) {
      return Promise.reject(new ReviewApiError("Repository ID is required", { status: 422, code: "INVALID_RECORD" }));
    }
    const params = new URLSearchParams({ path, base });
    if (typeof branch === "string") params.set("branch", branch);
    return this.request<FileDiff>(`/v1/repositories/${encodeURIComponent(normalizedRepositoryId)}/diff?${params.toString()}`);
  }

  getDecision(recordId: string): Promise<DecisionRecordDetail> {
    const normalizedRecordId = recordId.trim();
    if (normalizedRecordId.length === 0) {
      return Promise.reject(new ReviewApiError("Decision record ID is required", { status: 422, code: "INVALID_RECORD" }));
    }
    return this.request<DecisionRecordDetail>(`/v1/decision-records/${encodeURIComponent(normalizedRecordId)}`);
  }

  getSnapshotDiff(recordId: string, path: string): Promise<SnapshotDiffResponse> {
    const normalizedRecordId = recordId.trim();
    if (normalizedRecordId.length === 0) {
      return Promise.reject(new ReviewApiError("Decision record ID is required", { status: 422, code: "INVALID_RECORD" }));
    }
    return this.request<SnapshotDiffResponse>(
      `/v1/decision-records/${encodeURIComponent(normalizedRecordId)}/snapshot-diff?path=${encodeURIComponent(path)}`,
      {},
      (data, status) => {
        try {
          return parseSnapshotDiffResponse(data);
        } catch (error) {
          const message = error instanceof ContractValidationError
            ? `Recorder returned an invalid snapshot transition response: ${error.message}`
            : "Recorder returned an invalid snapshot transition response";
          throw new ReviewApiError(message, {
            status,
            code: "INVALID_RESPONSE",
            details: error instanceof ContractValidationError && error.field !== undefined
              ? [{ field: error.field, message: error.message }]
              : undefined,
          });
        }
      },
    );
  }

  async setDisposition(recordId: string, disposition: UserDisposition): Promise<DecisionRecordDetail> {
    if (disposition !== "unreviewed" && disposition !== "accepted" && disposition !== "rejected") {
      throw new ReviewApiError("Disposition must be unreviewed, accepted, or rejected", {
        status: 422,
        code: "INVALID_RECORD",
      });
    }
    const normalizedRecordId = recordId.trim();
    await this.request<DecisionRecord>(`/v1/decision-records/${encodeURIComponent(normalizedRecordId)}/disposition`, {
      method: "PATCH",
      body: JSON.stringify({ user_disposition: disposition }),
    });
    return this.getDecision(normalizedRecordId);
  }
}

export type { CheckEvidence, DecisionRecord, FileDiff, SnapshotDiff, SnapshotDiffResponse, TargetReference, UserDisposition };
export type ApiEnvelope<T> = ApiResponse<T>;
