import { createHash } from "node:crypto";
import {
  ERROR_CODES,
  type DecisionRecord,
  type SnapshotDiffResponse,
  type SnapshotEndpoint,
} from "../../../../packages/contracts/src/index";
import { RepositoryRegistry, SourceResolutionError, normalizeSourcePath } from "../repositories/registry";
import type { SnapshotStore, AutomaticSnapshotMetadata } from "../store/snapshots";
import { GitReader } from "./git";
import { diffText } from "./text-diff";
import { WorkingTreePathMissingError, WorkingTreeReader } from "./worktree";

export interface SnapshotDiffDependencies {
  registry: RepositoryRegistry;
  snapshots: SnapshotStore;
  git: GitReader;
  worktree: WorkingTreeReader;
}

interface SnapshotSide {
  content: string;
  missing: boolean;
}

function hashContent(content: string): string {
  return createHash("sha256").update(content, "utf8").digest("hex");
}

function unavailableError(message: string): SourceResolutionError {
  return new SourceResolutionError(ERROR_CODES.SOURCE_UNAVAILABLE, message);
}

function responseForFailure(path: string, error: unknown): SnapshotDiffResponse {
  if (error instanceof SourceResolutionError && error.code === ERROR_CODES.PAYLOAD_TOO_LARGE) throw error;
  if (error instanceof SourceResolutionError && error.code === ERROR_CODES.REVISION_NOT_FOUND) {
    return { state: "revision-not-found", path, message: error.message };
  }
  return {
    state: "source-unavailable",
    path,
    message: error instanceof Error ? error.message : "source is unavailable",
  };
}

function snapshotEndpoint(metadata: AutomaticSnapshotMetadata, path: string): SnapshotEndpoint {
  const reference = metadata.reference;
  if (typeof reference.source_path !== "string") throw unavailableError("automatic snapshot source path is unavailable");
  return {
    kind: "snapshot",
    snapshot_id: reference.snapshot_id,
    record_id: reference.record_id,
    created_at: reference.created_at,
    content_hash: reference.content_hash,
    source_path: reference.source_path || path,
    ...(reference.base_sha === undefined ? {} : { base_sha: reference.base_sha }),
  };
}

async function readAutomaticSnapshot(
  metadata: AutomaticSnapshotMetadata,
  path: string,
  repositoryId: string,
  dependencies: SnapshotDiffDependencies,
): Promise<SnapshotSide> {
  const reference = metadata.reference;
  if (reference.source_path !== path || reference.capture_kind !== "automatic" || reference.before_missing !== metadata.beforeMissing) {
    throw unavailableError("automatic snapshot metadata is unavailable");
  }

  if (reference.mode === "git") {
    if (metadata.beforeMissing || typeof reference.base_sha !== "string" || typeof reference.source_path !== "string") {
      throw unavailableError("Git-backed automatic snapshot metadata is unavailable");
    }
    await dependencies.registry.assertTarget(repositoryId, path);
    const repository = await dependencies.registry.get(repositoryId);
    if (repository === null) throw unavailableError("repository is unavailable");
    const content = await dependencies.git.readCommitFile(repository.root, reference.base_sha, reference.source_path);
    if (hashContent(content) !== reference.content_hash) {
      throw unavailableError("snapshot is unavailable or has been tampered with");
    }
    return { content, missing: false };
  }

  const stored = await dependencies.snapshots.get(reference.snapshot_id);
  if (
    stored === null
    || stored.reference.snapshot_id !== reference.snapshot_id
    || stored.reference.record_id !== reference.record_id
    || stored.reference.mode === "git"
    || stored.reference.path !== reference.path
    || stored.reference.source_path !== path
    || stored.reference.capture_kind !== "automatic"
    || stored.reference.before_missing !== metadata.beforeMissing
    || stored.reference.content_hash !== reference.content_hash
    || (metadata.beforeMissing && stored.content.length > 0)
  ) {
    throw unavailableError("snapshot is unavailable or has been tampered with");
  }
  return { content: stored.content, missing: metadata.beforeMissing };
}

async function readCurrentWorktree(
  path: string,
  repositoryId: string,
  dependencies: SnapshotDiffDependencies,
): Promise<SnapshotSide> {
  await dependencies.registry.assertTarget(repositoryId, path);
  const repository = await dependencies.registry.get(repositoryId);
  if (repository === null) throw unavailableError("repository is unavailable");
  try {
    return {
      content: (await dependencies.worktree.readEnumeratedFile(repository.root, path)).content,
      missing: false,
    };
  } catch (error) {
    if (error instanceof WorkingTreePathMissingError) return { content: "", missing: true };
    throw error;
  }
}

export async function resolveSnapshotDiff(
  record: DecisionRecord,
  sourcePath: string,
  dependencies: SnapshotDiffDependencies,
): Promise<SnapshotDiffResponse> {
  let path: string;
  try {
    path = normalizeSourcePath(sourcePath);
  } catch (error) {
    return responseForFailure(sourcePath, error);
  }

  const target = record.targets.find((candidate) => candidate.repository_id === record.repository_id && candidate.path === path);
  if (target === undefined) {
    return { state: "source-unavailable", path, message: "path is not an exact target of the decision record" };
  }

  let before: AutomaticSnapshotMetadata | null;
  try {
    before = await dependencies.snapshots.getAutomaticForRecord(record.record_id, path);
  } catch (error) {
    return responseForFailure(path, error);
  }
  if (before === null) {
    return { state: "legacy-fallback", reason: "automatic-snapshot-not-found", path };
  }

  let beforeSide: SnapshotSide;
  try {
    beforeSide = await readAutomaticSnapshot(before, path, record.repository_id, dependencies);
  } catch (error) {
    return responseForFailure(path, error);
  }

  let next: AutomaticSnapshotMetadata | null;
  try {
    next = await dependencies.snapshots.getNextAutomatic(record.repository_id, path, before.captureSequence);
  } catch (error) {
    return responseForFailure(path, error);
  }

  let after: SnapshotSide;
  let to: SnapshotEndpoint | { kind: "working-tree" };
  try {
    if (next !== null) {
      after = await readAutomaticSnapshot(next, path, record.repository_id, dependencies);
      to = snapshotEndpoint(next, path);
    } else {
      after = await readCurrentWorktree(path, record.repository_id, dependencies);
      to = { kind: "working-tree" };
    }
  } catch (error) {
    return responseForFailure(path, error);
  }

  const diff = diffText(path, beforeSide.content, after.content, {
    maxWork: dependencies.git.maxDiffWork,
    maxOutputBytes: dependencies.git.maxBytes,
  });
  return {
    state: "snapshot-resolved",
    path,
    from: snapshotEndpoint(before, path),
    to,
    hunks: diff.hunks,
    old_missing: beforeSide.missing,
    new_missing: after.missing,
    binary: diff.binary,
  };
}
