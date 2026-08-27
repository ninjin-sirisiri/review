import { createHash } from "node:crypto";
import type { DecisionRecord } from "../../../../packages/contracts/src/index";
import type { RepositoryRegistry } from "../repositories/registry";
import { GitReader } from "./git";

export interface GitBackableTarget {
  baseSha: string;
  sourcePath: string;
}

/**
 * Transparent optimization probe: returns the first record target whose HEAD
 * blob byte-matches the submitted content. Never throws: any failure means
 * "not eligible", and the caller stores a regular file-backed snapshot.
 */
export async function detectGitBackable(
  registry: RepositoryRegistry,
  git: GitReader,
  record: DecisionRecord,
  contentHash: string,
): Promise<GitBackableTarget | null> {
  try {
    const repository = await registry.get(record.repository_id);
    if (repository === null) return null;
    const headSha = await git.resolveRevision(repository.root, "HEAD");
    if (!/^[0-9a-f]{40}$/.test(headSha)) return null;
    for (const target of record.targets) {
      try {
        await registry.assertTarget(record.repository_id, target.path);
      } catch {
        return null;
      }
      try {
        const blob = await git.readCommitFile(repository.root, headSha, target.path);
        const blobHash = createHash("sha256").update(blob, "utf8").digest("hex");
        if (blobHash === contentHash) return { baseSha: headSha, sourcePath: target.path };
      } catch {
        // Candidate path unreadable at HEAD; try the next target.
      }
    }
    return null;
  } catch {
    return null;
  }
}
