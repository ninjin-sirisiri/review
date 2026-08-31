import { createHash } from "node:crypto";
import { lstat, readFile, realpath, stat } from "node:fs/promises";
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

const MAX_GITFILE_BYTES = 8_192;

function gitdirPointer(contents: string): string | null {
  for (const line of contents.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed.startsWith("gitdir:")) continue;
    const pointer = trimmed.slice("gitdir:".length).trim();
    if (pointer.length === 0 || pointer.includes("\0")) return null;
    return pointer;
  }
  return null;
}

async function readGitMetadataFile(path: string, size: number): Promise<string | null> {
  if (!Number.isSafeInteger(size) || size <= 0 || size > MAX_GITFILE_BYTES) return null;
  let contents: string;
  try {
    contents = await readFile(path, "utf8");
  } catch {
    return null;
  }
  if (new TextEncoder().encode(contents).byteLength > MAX_GITFILE_BYTES) return null;
  return contents;
}

async function canonicalPath(base: string, candidate: string): Promise<string | null> {
  if (candidate.includes("\0")) return null;
  const lexical = isAbsolute(candidate) ? candidate : resolve(base, candidate);
  try {
    return await realpath(lexical);
  } catch {
    return null;
  }
}

async function isLinkedWorktreeOfRoot(root: string, worktreeRoot: string, gitFile: string, size: number): Promise<boolean> {
  const contents = await readGitMetadataFile(gitFile, size);
  if (contents === null) return false;
  const pointer = gitdirPointer(contents);
  if (pointer === null) return false;
  const canonicalGitdir = await canonicalPath(worktreeRoot, pointer);
  if (canonicalGitdir === null) return false;
  let gitdirInformation;
  try {
    gitdirInformation = await lstat(canonicalGitdir);
  } catch {
    return false;
  }
  if (!gitdirInformation.isDirectory()) return false;
  let canonicalWorktrees: string;
  try {
    const gitDirectory = resolve(root, ".git");
    const information = await lstat(gitDirectory);
    if (!information.isDirectory()) return false;
    canonicalWorktrees = await realpath(resolve(gitDirectory, "worktrees"));
  } catch {
    return false;
  }
  if (!isContained(canonicalWorktrees, canonicalGitdir) || canonicalGitdir === canonicalWorktrees) return false;
  const backPointerPath = resolve(canonicalGitdir, "gitdir");
  let backPointerInformation;
  try {
    backPointerInformation = await lstat(backPointerPath);
  } catch {
    return false;
  }
  if (!backPointerInformation.isFile()) return false;
  const backPointer = await readGitMetadataFile(backPointerPath, backPointerInformation.size);
  if (backPointer === null) return false;
  const canonicalBackPointer = await canonicalPath(canonicalGitdir, backPointer.trim());
  const canonicalGitFile = await canonicalPath(worktreeRoot, gitFile);
  return canonicalBackPointer !== null && canonicalGitFile !== null && canonicalBackPointer === canonicalGitFile;
}

async function rejectNestedRepository(root: string, target: string): Promise<void> {
  let current = dirname(target);
  while (isContained(root, current) && current !== root) {
    const gitPath = resolve(current, ".git");
    try {
      const information = await lstat(gitPath);
      if (information.isFile() && await isLinkedWorktreeOfRoot(root, current, gitPath, information.size)) {
        current = dirname(current);
        continue;
      }
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

  async list(): Promise<RegisteredRepository[]> {
    const rows = this.store.db.query(
      "SELECT repository_id, root, created_at FROM repositories ORDER BY created_at, repository_id",
    ).all() as Array<{ repository_id: string; root: string | null; created_at: string }>;
    return rows.flatMap((row) => (
      row.root === null || !isAbsolute(row.root)
        ? []
        : [{ repository_id: row.repository_id, root: row.root, created_at: row.created_at }]
    ));
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
