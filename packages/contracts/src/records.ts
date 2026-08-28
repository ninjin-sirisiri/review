export type AgentType = "claude-code" | "codex" | "opencode";

export type RevisionRef =
  | { kind: "commit"; sha: string }
  | { kind: "working-tree"; contentHash: string };

export type UserDisposition = "unreviewed" | "accepted" | "rejected";

export type CheckStatus = "passed" | "failed" | "not-run";

export interface TargetReference {
  repository_id: string;
  path: string;
  line_start: number;
  line_end: number;
  revision: RevisionRef;
  content_hash: string;
}

export interface CheckEvidence {
  name: string;
  status: CheckStatus;
  details?: string;
}

export interface DecisionRecordInput {
  record_id: string;
  session_id: string;
  repository_id: string;
  agent_type: AgentType;
  revision: RevisionRef;
  targets: TargetReference[];
  judgment: string;
  rationale: string;
  checks: CheckEvidence[];
  open_questions: string[];
  created_at: string;
  user_disposition?: UserDisposition;
}

export interface DecisionRecord extends DecisionRecordInput {
  user_disposition: UserDisposition;
}

export type ReviewSessionStatus = "active" | "completed" | "failed";

export interface ReviewSession {
  session_id: string;
  repository_id: string;
  agent_type: AgentType;
  started_at: string;
  ended_at?: string;
  status: ReviewSessionStatus;
}

export type SnapshotMode = "changed-files" | "patch" | "git";

export type SnapshotCaptureKind = "manual" | "automatic";

export interface SnapshotReference {
  snapshot_id: string;
  record_id: string;
  mode: SnapshotMode;
  /** Storage-relative file path; empty string for git-backed snapshots (no stored file). */
  path: string;
  content_hash: string;
  created_at: string;
  /** git mode only: concrete commit SHA captured at creation time. */
  base_sha?: string;
  /** Registered-root-relative source path for git and automatic snapshots. */
  source_path?: string;
  capture_kind?: SnapshotCaptureKind;
  before_missing?: boolean;
}
