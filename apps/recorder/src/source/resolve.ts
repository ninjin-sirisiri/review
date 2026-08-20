import { createHash } from "node:crypto";
import {
  ERROR_CODES,
  type RevisionRef,
  type SnapshotReference,
  type TargetReference,
} from "../../../../packages/contracts/src/index";
import { RepositoryRegistry, SourceResolutionError } from "../repositories/registry";
import { GitReader } from "./git";
import { WorkingTreeReader } from "./worktree";
import type { SnapshotStore } from "../store/snapshots";

interface LoadedSnapshot {
  reference: SnapshotReference;
  content: string;
}

export type ResolutionState = "resolved" | "hash-mismatch" | "revision-not-found" | "source-unavailable" | "snapshot-resolved";

export interface ResolvedSource {
  state: "resolved" | "snapshot-resolved";
  repositoryId: string;
  path: string;
  revision: RevisionRef;
  target: TargetReference;
  content: string;
  contentHash: string;
  snapshot?: SnapshotReference;
}

export interface UnresolvedSource {
  state: "hash-mismatch" | "revision-not-found" | "source-unavailable";
  repositoryId: string;
  path: string;
  revision: RevisionRef;
  target: TargetReference;
  expectedHash: string;
  actualHash?: string;
  message?: string;
  content?: undefined;
  contentHash?: undefined;
}

export class SourceResolver {
  readonly registry: RepositoryRegistry;
  readonly git: GitReader;
  readonly worktree: WorkingTreeReader;
  readonly snapshots?: SnapshotStore;

  constructor(registry: RepositoryRegistry, snapshots?: SnapshotStore, git = new GitReader(), worktree = new WorkingTreeReader()) {
    this.registry = registry;
    this.snapshots = snapshots;
    this.git = git;
    this.worktree = worktree;
  }

  async resolve(target: TargetReference, source: "repository" | { snapshotId: string }): Promise<ResolvedSource | UnresolvedSource> {
    const canonicalPath = await this.registry.assertTarget(target.repository_id, target.path);
    if (typeof source === "object" && source !== null && typeof source.snapshotId === "string") {
      return this.resolveSnapshot(target, canonicalPath, source.snapshotId);
    }
    if (source !== "repository") {
      return this.unavailable(target, canonicalPath, "source selection is not supported");
    }
    if (target.revision.kind === "commit") {
      return this.resolveCommit(target, canonicalPath);
    }
    return this.resolveWorkingTree(target, canonicalPath);
  }

  private async resolveSnapshot(target: TargetReference, canonicalPath: string, snapshotId: string): Promise<ResolvedSource | UnresolvedSource> {
    if (this.snapshots === undefined) return this.unavailable(target, canonicalPath, "snapshot storage is unavailable");
    let stored: LoadedSnapshot | null;
    try {
      stored = await this.snapshots.get(snapshotId);
    } catch {
      stored = null;
    }
    if (stored === null) return this.unavailable(target, canonicalPath, "snapshot is unavailable or has been tampered with");
    return {
      state: "snapshot-resolved",
      repositoryId: target.repository_id,
      path: target.path,
      revision: target.revision,
      target,
      content: stored.content,
      contentHash: stored.reference.content_hash,
      snapshot: stored.reference,
    };
  }

  private async resolveCommit(target: TargetReference, canonicalPath: string): Promise<ResolvedSource | UnresolvedSource> {
    const repository = await this.registry.get(target.repository_id);
    if (repository === null) return this.unavailable(target, canonicalPath, "repository is unavailable");
    let content: string;
    try {
      content = await this.git.readCommitFile(repository.root, target.revision.sha, target.path);
    } catch (error) {
      if (error instanceof SourceResolutionError && error.code === ERROR_CODES.REVISION_NOT_FOUND) {
        return this.unavailable(target, canonicalPath, "revision was not found", "revision-not-found");
      }
      return this.unavailable(target, canonicalPath, "source is unavailable");
    }
    return this.compareContent(target, canonicalPath, content);
  }

  private async resolveWorkingTree(target: TargetReference, canonicalPath: string): Promise<ResolvedSource | UnresolvedSource> {
    let content: string;
    try {
      const repository = await this.registry.get(target.repository_id);
      if (repository === null) return this.unavailable(target, canonicalPath, "repository is unavailable");
      content = (await this.worktree.readFile(repository.root, target.path)).content;
    } catch {
      return this.unavailable(target, canonicalPath, "working-tree source is unavailable");
    }
    return this.compareContent(target, canonicalPath, content);
  }

  private compareContent(target: TargetReference, canonicalPath: string, content: string): ResolvedSource | UnresolvedSource {
    const contentHash = createHash("sha256").update(content, "utf8").digest("hex");
    if (contentHash !== target.content_hash) {
      return {
        state: "hash-mismatch",
        repositoryId: target.repository_id,
        path: target.path,
        revision: target.revision,
        target,
        expectedHash: target.content_hash,
        actualHash: contentHash,
        message: "source content hash does not match the recorded target",
      };
    }
    return {
      state: "resolved",
      repositoryId: target.repository_id,
      path: target.path,
      revision: target.revision,
      target,
      content,
      contentHash,
    };
  }

  private unavailable(target: TargetReference, canonicalPath: string, message: string, state: "source-unavailable" | "revision-not-found" = "source-unavailable"): UnresolvedSource {
    return {
      state,
      repositoryId: target.repository_id,
      path: target.path,
      revision: target.revision,
      target,
      expectedHash: target.content_hash,
      message,
    };
  }
}

export { SourceResolutionError } from "../repositories/registry";
