import { createHash } from "node:crypto";
import { lstat, realpath, stat } from "node:fs/promises";
import { dirname, isAbsolute, relative, resolve, sep } from "node:path";
import {
  ERROR_CODES,
  type ErrorCode,
} from "../../../../packages/contracts/src/index";
import type { RecordStore } from "../store/records";
export interface RegisteredRepository {
  repository_id: string;
  root: string;
  created_at: string;
}

export class SourceResolutionError extends Error {
  readonly code: ErrorCode;

  constructor(code: ErrorCode, message: string) {
    super(message);
    this.name = "SourceResolutionError";
    this.code = code;
  }
}

export function normalizeSourcePath(relativePath: string): string {
  if (typeof relativePath !== "string" || relativePath.length === 0 || relativePath.includes("\0")) {
    throw new SourceResolutionError(ERROR_CODES.PATH_OUTSIDE_ROOT, "target path must be a non-empty relative path");
  }
  const slashPath = relativePath.replaceAll("\\", "/");
  if (slashPath.startsWith("/") || slashPath.startsWith("//") || /^[A-Za-z]:/.test(slashPath)) {
    throw new SourceResolutionError(ERROR_CODES.PATH_OUTSIDE_ROOT, "target path must be relative to the repository root");
  }
  const segments: string[] = [];
  for (const segment of slashPath.split("/")) {
    if (segment === "" || segment === ".") continue;
    if (segment === "..") {
      throw new SourceResolutionError(ERROR_CODES.PATH_OUTSIDE_ROOT, "target path cannot escape the repository root");
    }
    segments.push(segment);
  }
  if (segments.length === 0) {
    throw new SourceResolutionError(ERROR_CODES.PATH_OUTSIDE_ROOT, "target path must name a file");
  }
  return segments.join("/");
}

function isContained(root: string, candidate: string): boolean {
  const childRelative = relative(root, candidate);
  return childRelative !== ".." && !childRelative.startsWith(`..${sep}`) && !isAbsolute(childRelative);
}

async function canonicalizeTarget(root: string, lexicalTarget: string): Promise<string> {
  let existingAncestor = lexicalTarget;
  while (true) {
    try {
      const canonicalAncestor = await realpath(existingAncestor);
      if (!isContained(root, canonicalAncestor)) {
        throw new SourceResolutionError(ERROR_CODES.PATH_OUTSIDE_ROOT, "target path resolves outside the repository root");
      }
      const missingSuffix = relative(existingAncestor, lexicalTarget);
      const candidate = resolve(canonicalAncestor, missingSuffix);
      if (!isContained(root, candidate)) {
        throw new SourceResolutionError(ERROR_CODES.PATH_OUTSIDE_ROOT, "target path resolves outside the repository root");
      }
      try {
        const canonicalTarget = await realpath(lexicalTarget);
        if (!isContained(root, canonicalTarget) || canonicalTarget === root) {
          throw new SourceResolutionError(ERROR_CODES.PATH_OUTSIDE_ROOT, "target path resolves outside the repository root");
        }
        return canonicalTarget;
      } catch (error) {
        if (error instanceof SourceResolutionError) throw error;
        const fileError = error as NodeJS.ErrnoException;
        if (fileError.code !== "ENOENT" && fileError.code !== "ENOTDIR") throw error;
        return candidate;
      }
    } catch (error) {
      if (error instanceof SourceResolutionError) throw error;
      const fileError = error as NodeJS.ErrnoException;
      if (fileError.code !== "ENOENT" && fileError.code !== "ENOTDIR") throw error;
      const parent = dirname(existingAncestor);
      if (parent === existingAncestor || !isContained(root, parent)) {
        throw new SourceResolutionError(ERROR_CODES.PATH_OUTSIDE_ROOT, "target path cannot be resolved inside the repository root");
      }
      existingAncestor = parent;
    }
  }
}

async function rejectNestedRepository(root: string, target: string): Promise<void> {
  let current = dirname(target);
  while (isContained(root, current) && current !== root) {
    try {
      await lstat(resolve(current, ".git"));
      throw new SourceResolutionError(ERROR_CODES.REPOSITORY_NOT_REGISTERED, "target is inside an unregistered nested repository");
    } catch (error) {
      if (error instanceof SourceResolutionError) throw error;
      const fileError = error as NodeJS.ErrnoException;
      if (fileError.code !== "ENOENT") throw error;
    }
    current = dirname(current);
  }
}
interface BoundedOutput {
  text: string;
  oversized: boolean;
}

async function readBounded(stream: ReadableStream<Uint8Array>, maxBytes: number): Promise<BoundedOutput> {
  const reader = stream.getReader();
  const chunks: Uint8Array[] = [];
  let totalBytes = 0;
  let oversized = false;
  try {
    while (true) {
      const next = await reader.read();
      if (next.done) break;
      totalBytes += next.value.byteLength;
      if (totalBytes <= maxBytes) chunks.push(next.value);
      else oversized = true;
    }
  } finally {
    reader.releaseLock();
  }
  if (oversized) return { text: "", oversized: true };
  const content = new Uint8Array(totalBytes);
  let offset = 0;
  for (const chunk of chunks) {
    content.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return { text: new TextDecoder().decode(content), oversized: false };
}


async function discoverGitTopLevel(root: string, maxBytes: number): Promise<string | null> {
  try {
    const child = Bun.spawn({
      cmd: [
        "git",
        "-C",
        root,
        "-c",
        "core.hooksPath=/dev/null",
        "-c",
        "core.fsmonitor=false",
        "rev-parse",
        "--show-toplevel",
      ],
      stdout: "pipe",
      stderr: "pipe",
      env: {
        PATH: process.env.PATH ?? "/usr/bin:/bin",
        GIT_CONFIG_NOSYSTEM: "1",
        GIT_CONFIG_GLOBAL: "/dev/null",
        GIT_TERMINAL_PROMPT: "0",
      },
    });
    const [stdout, stderr, exitCode] = await Promise.all([
      readBounded(child.stdout, maxBytes),
      readBounded(child.stderr, maxBytes),
      child.exited,
    ]);
    if (stdout.oversized || stderr.oversized) {
      throw new SourceResolutionError(ERROR_CODES.PAYLOAD_TOO_LARGE, "Git metadata exceeds the configured source limit");
    }
    if (exitCode !== 0) return null;
    return stdout.text.trim() || null;
  } catch (error) {
    if (error instanceof SourceResolutionError) throw error;
    return null;
  }
}
export class RepositoryRegistry {
  readonly store: RecordStore;

  constructor(store: RecordStore) {
    this.store = store;
  }

  async register(root: string, repositoryId?: string): Promise<RegisteredRepository> {
    if (typeof root !== "string" || root.trim().length === 0) {
      throw new SourceResolutionError(ERROR_CODES.INVALID_RECORD, "repository root must be a non-empty string");
    }
    let canonicalRoot: string;
    try {
      canonicalRoot = await realpath(root);
      const information = await stat(canonicalRoot);
      if (!information.isDirectory()) throw new Error("repository root is not a directory");
    } catch {
      throw new SourceResolutionError(ERROR_CODES.SOURCE_UNAVAILABLE, "repository root cannot be resolved");
    }
    const gitTopLevel = await discoverGitTopLevel(canonicalRoot, this.store.config.maxSourceContentLength);
    if (gitTopLevel !== null) {
      let canonicalGitTopLevel: string;
      try {
        canonicalGitTopLevel = await realpath(gitTopLevel);
      } catch {
        throw new SourceResolutionError(ERROR_CODES.SOURCE_UNAVAILABLE, "Git worktree root cannot be resolved");
      }
      if (canonicalGitTopLevel !== canonicalRoot) {
        throw new SourceResolutionError(ERROR_CODES.PATH_OUTSIDE_ROOT, "registered root is nested under a different Git checkout");
      }
    }
    const id = repositoryId ?? createHash("sha256").update(canonicalRoot, "utf8").digest("hex");
    if (typeof id !== "string" || id.trim().length === 0 || id.length > 256) {
      throw new SourceResolutionError(ERROR_CODES.INVALID_RECORD, "repository_id must be a non-empty string");
    }
    const existing = this.store.db.query(
      "SELECT root FROM repositories WHERE repository_id = $repository_id",
    ).get({ $repository_id: id }) as { root: string | null } | null;
    if (existing !== null && existing.root !== null && existing.root !== canonicalRoot) {
      throw new SourceResolutionError(ERROR_CODES.INVALID_RECORD, "repository_id is already registered to a different root");
    }
    const stored = await this.store.createRepository({ repository_id: id, root: canonicalRoot });
    if (stored.root !== canonicalRoot) {
      throw new SourceResolutionError(ERROR_CODES.SOURCE_UNAVAILABLE, "registered repository root was not canonicalized");
    }
    return { repository_id: stored.repository_id, root: canonicalRoot, created_at: stored.created_at };
  }

  async get(repositoryId: string): Promise<RegisteredRepository | null> {
    if (typeof repositoryId !== "string" || repositoryId.trim().length === 0) return null;
    const row = this.store.db.query(
      "SELECT repository_id, root, created_at FROM repositories WHERE repository_id = $repository_id",
    ).get({ $repository_id: repositoryId }) as { repository_id: string; root: string | null; created_at: string } | null;
    if (row === null || row.root === null || !isAbsolute(row.root)) return null;
    return { repository_id: row.repository_id, root: row.root, created_at: row.created_at };
  }

  async assertTarget(repositoryId: string, relativePath: string): Promise<string> {
    const repository = await this.get(repositoryId);
    if (repository === null) {
      throw new SourceResolutionError(ERROR_CODES.REPOSITORY_NOT_REGISTERED, "repository is not registered");
    }
    try {
      const currentRoot = await realpath(repository.root);
      const rootInformation = await stat(currentRoot);
      if (!rootInformation.isDirectory() || currentRoot !== repository.root) {
        throw new SourceResolutionError(ERROR_CODES.PATH_OUTSIDE_ROOT, "registered repository root no longer resolves to its canonical root");
      }
    } catch (error) {
      if (error instanceof SourceResolutionError) throw error;
      throw new SourceResolutionError(ERROR_CODES.SOURCE_UNAVAILABLE, "registered repository root is unavailable");
    }
    const normalizedPath = normalizeSourcePath(relativePath);
    const lexicalTarget = resolve(repository.root, normalizedPath);
    if (!isContained(repository.root, lexicalTarget) || lexicalTarget === repository.root) {
      throw new SourceResolutionError(ERROR_CODES.PATH_OUTSIDE_ROOT, "target path is outside the repository root");
    }
    const canonicalTarget = await canonicalizeTarget(repository.root, lexicalTarget);
    await rejectNestedRepository(repository.root, canonicalTarget);
    return canonicalTarget;
  }
}
