export interface DiffLine {
  type: "context" | "add" | "del";
  oldLine: number | null;
  newLine: number | null;
  content: string;
}

export interface DiffHunk {
  oldStart: number;
  newStart: number;
  lines: DiffLine[];
}

export interface FileDiff {
  path: string;
  /** Resolved base commit SHA (rev-parse result when base=HEAD). */
  base_sha: string;
  hunks: DiffHunk[];
  /** The base commit does not contain this file (created after base). */
  old_missing: boolean;
  /** The diff current does not contain this file. */
  new_missing: boolean;
  /** A NUL byte was detected on either side; hunks is empty when true. */
  binary: boolean;
}

export type ReviewView =
  | { kind: "working-tree" }
  | { kind: "local-branch"; name: string; sha: string };

export interface LocalBranch {
  name: string;
  sha: string;
}

export interface BranchList {
  repository_id: string;
  head_branch: string | null;
  branches: LocalBranch[];
}

export interface RepositoryFiles {
  repository_id: string;
  view: ReviewView;
  paths: string[];
}

export interface SnapshotEndpoint {
  kind: "snapshot";
  snapshot_id: string;
  record_id: string;
  created_at: string;
  content_hash: string;
  source_path: string;
  base_sha?: string;
}

export interface WorkingTreeEndpoint {
  kind: "working-tree";
}

export interface SnapshotDiff {
  state: "snapshot-resolved";
  path: string;
  from: SnapshotEndpoint;
  to: SnapshotEndpoint | WorkingTreeEndpoint;
  hunks: DiffHunk[];
  old_missing: boolean;
  new_missing: boolean;
  binary: boolean;
}

export type SnapshotDiffResponse =
  | SnapshotDiff
  | { state: "legacy-fallback"; reason: "automatic-snapshot-not-found"; path: string }
  | { state: "source-unavailable" | "revision-not-found"; path: string; message: string };

export const ERROR_CODES = {
  UNAUTHORIZED: "UNAUTHORIZED",
  INVALID_RECORD: "INVALID_RECORD",
  REPOSITORY_NOT_REGISTERED: "REPOSITORY_NOT_REGISTERED",
  PATH_OUTSIDE_ROOT: "PATH_OUTSIDE_ROOT",
  REVISION_NOT_FOUND: "REVISION_NOT_FOUND",
  HASH_MISMATCH: "HASH_MISMATCH",
  SOURCE_UNAVAILABLE: "SOURCE_UNAVAILABLE",
  DUPLICATE_RECORD: "DUPLICATE_RECORD",
  PAYLOAD_TOO_LARGE: "PAYLOAD_TOO_LARGE",
} as const;

export type ErrorCode = (typeof ERROR_CODES)[keyof typeof ERROR_CODES];

export interface ApiSuccess<T> {
  success: true;
  data: T;
}

export interface ApiErrorDetail {
  field?: string;
  message: string;
}

export interface ApiFailure {
  success: false;
  error: {
    code: ErrorCode;
    message: string;
    field?: string;
    details?: ApiErrorDetail[];
  };
}

export type ApiResponse<T> = ApiSuccess<T> | ApiFailure;
