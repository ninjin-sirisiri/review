import { realpath, stat } from "node:fs/promises";
import {
  ERROR_CODES,
  type ErrorCode,
} from "../../../../packages/contracts/src/index";
import { normalizeSourcePath, SourceResolutionError } from "../repositories/registry";
import { WorkingTreeReader } from "./worktree";

interface GitResult {
  stdout: string;
  stderr: string;
  exitCode: number;
  oversized: boolean;
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

function isSafeRevision(revision: string): boolean {
  return revision.length > 0 && revision.length <= 128 && !revision.startsWith("-") && !revision.includes("\0") && /^[A-Za-z0-9._/-]+$/.test(revision) && !revision.includes("..") && !revision.includes("@{");
}

export class GitReaderError extends SourceResolutionError {
  constructor(code: ErrorCode, message: string) {
    super(code, message);
    this.name = "GitReaderError";
  }
}
function buildTextDiff(path: string, previous: string, current: string): string {
  const previousLines = previous.split("\n");
  const currentLines = current.split("\n");
  let prefix = 0;
  while (prefix < previousLines.length && prefix < currentLines.length && previousLines[prefix] === currentLines[prefix]) prefix += 1;
  let suffix = 0;
  while (
    suffix < previousLines.length - prefix &&
    suffix < currentLines.length - prefix &&
    previousLines[previousLines.length - suffix - 1] === currentLines[currentLines.length - suffix - 1]
  ) suffix += 1;
  const removed = previousLines.slice(prefix, previousLines.length - suffix);
  const added = currentLines.slice(prefix, currentLines.length - suffix);
  const hunk = [...removed.map((line) => `-${line}`), ...added.map((line) => `+${line}`)].join("\n");
  return `diff --git a/${path} b/${path}\n--- a/${path}\n+++ b/${path}\n@@ -${prefix + 1},${removed.length} +${prefix + 1},${added.length} @@\n${hunk}\n`;
}


export class GitReader {
  readonly maxBytes: number;

  constructor(maxBytes = 4 * 1024 * 1024) {
    if (!Number.isSafeInteger(maxBytes) || maxBytes <= 0) throw new RangeError("maxBytes must be a positive integer");
    this.maxBytes = maxBytes;
  }

  private async execute(root: string, args: string[], configArgs: string[] = []): Promise<GitResult> {
    let canonicalRoot: string;
    try {
      canonicalRoot = await realpath(root);
      const information = await stat(canonicalRoot);
      if (!information.isDirectory()) throw new Error("git root is not a directory");
    } catch {
      throw new GitReaderError(ERROR_CODES.SOURCE_UNAVAILABLE, "repository root cannot be read");
    }
    const child = Bun.spawn({
      cmd: ["git", "-C", canonicalRoot, ...configArgs, ...args],
      stdout: "pipe",
      stderr: "pipe",
      env: {
        PATH: process.env.PATH ?? "/usr/bin:/bin",
        GIT_CONFIG_NOSYSTEM: "1",
        GIT_CONFIG_GLOBAL: "/dev/null",
        GIT_PAGER: "cat",
        GIT_TERMINAL_PROMPT: "0",
      },
    });
    const [stdout, stderr, exitCode] = await Promise.all([
      readBounded(child.stdout, this.maxBytes),
      readBounded(child.stderr, this.maxBytes),
      child.exited,
    ]);
    return {
      stdout: stdout.text,
      stderr: stderr.text,
      exitCode,
      oversized: stdout.oversized || stderr.oversized,
    };
  }

  private async verifyRepository(root: string): Promise<void> {
    let canonicalRoot: string;
    try {
      canonicalRoot = await realpath(root);
    } catch {
      throw new GitReaderError(ERROR_CODES.SOURCE_UNAVAILABLE, "repository root cannot be resolved");
    }
    const result = await this.execute(canonicalRoot, ["rev-parse", "--show-toplevel"]);
    if (result.oversized) throw new GitReaderError(ERROR_CODES.PAYLOAD_TOO_LARGE, "Git metadata exceeds the configured source limit");
    if (result.exitCode !== 0) throw new GitReaderError(ERROR_CODES.SOURCE_UNAVAILABLE, "root is not an available Git worktree");
    let discoveredRoot: string;
    try {
      discoveredRoot = await realpath(result.stdout.trim());
    } catch {
      throw new GitReaderError(ERROR_CODES.SOURCE_UNAVAILABLE, "Git worktree root cannot be resolved");
    }
    if (discoveredRoot !== canonicalRoot) {
      throw new GitReaderError(ERROR_CODES.SOURCE_UNAVAILABLE, "Git worktree root differs from the registered root");
    }
  }

  private async verifyRevision(root: string, revision: string): Promise<void> {
    if (!isSafeRevision(revision)) {
      throw new GitReaderError(ERROR_CODES.REVISION_NOT_FOUND, "revision is not an allowed commit reference");
    }
    const result = await this.execute(root, ["cat-file", "-e", `${revision}^{commit}`]);
    if (result.oversized) throw new GitReaderError(ERROR_CODES.PAYLOAD_TOO_LARGE, "Git metadata exceeds the configured source limit");
    if (result.exitCode !== 0) {
      const details = `${result.stdout}\n${result.stderr}`.toLowerCase();
      if (details.includes("not a valid object name") || details.includes("unknown revision") || details.includes("bad object") || details.includes("ambiguous argument")) {
        throw new GitReaderError(ERROR_CODES.REVISION_NOT_FOUND, "revision was not found");
      }
      throw new GitReaderError(ERROR_CODES.SOURCE_UNAVAILABLE, "Git repository data is unavailable");
    }
  }

  private async listTreePaths(root: string, sha: string): Promise<string[]> {
    const result = await this.execute(root, ["ls-tree", "-r", "--name-only", "-z", sha]);
    if (result.oversized) throw new GitReaderError(ERROR_CODES.PAYLOAD_TOO_LARGE, "Git tree metadata exceeds the configured source limit");
    if (result.exitCode !== 0) throw new GitReaderError(ERROR_CODES.SOURCE_UNAVAILABLE, "Git tree cannot be read");
    return result.stdout.split("\0").filter((path) => path.length > 0).map((path) => normalizeSourcePath(path));
  }

  private async listWorktreePaths(root: string): Promise<string[]> {
    const result = await this.execute(root, ["ls-files", "-z"]);
    if (result.oversized) throw new GitReaderError(ERROR_CODES.PAYLOAD_TOO_LARGE, "Git worktree metadata exceeds the configured source limit");
    if (result.exitCode !== 0) throw new GitReaderError(ERROR_CODES.SOURCE_UNAVAILABLE, "Git worktree files cannot be listed");
    return result.stdout.split("\0").filter((path) => path.length > 0).map((path) => normalizeSourcePath(path));
  }

  private async readCommitBlob(root: string, sha: string, path: string): Promise<string | null> {
    const result = await this.execute(root, ["show", "--no-ext-diff", "--no-textconv", "--format=", `${sha}:${path}`]);
    if (result.oversized) throw new GitReaderError(ERROR_CODES.PAYLOAD_TOO_LARGE, "Git source exceeds the configured source limit");
    if (result.exitCode !== 0) return null;
    return result.stdout;
  }

  async readCommitFile(root: string, sha: string, relativePath: string): Promise<string> {
    const normalizedPath = normalizeSourcePath(relativePath);
    await this.verifyRepository(root);
    await this.verifyRevision(root, sha);
    const content = await this.readCommitBlob(root, sha, normalizedPath);
    if (content === null) {
      throw new GitReaderError(ERROR_CODES.SOURCE_UNAVAILABLE, "file is not available at the requested revision");
    }
    return content;
  }

  async readDiff(root: string, sha: string): Promise<string> {
    await this.verifyRepository(root);
    await this.verifyRevision(root, sha);
    const [treePaths, worktreePaths] = await Promise.all([this.listTreePaths(root, sha), this.listWorktreePaths(root)]);
    const paths = new Set([...treePaths, ...worktreePaths]);
    const worktree = new WorkingTreeReader(this.maxBytes);
    let diff = "";
    for (const path of paths) {
      const previous = (await this.readCommitBlob(root, sha, path)) ?? "";
      let current = "";
      try {
        current = (await worktree.readFile(root, path)).content;
      } catch (error) {
        if (!(error instanceof SourceResolutionError) || error.code !== ERROR_CODES.SOURCE_UNAVAILABLE) throw error;
      }
      if (previous === current) continue;
      diff += buildTextDiff(path, previous, current);
      if (new TextEncoder().encode(diff).byteLength > this.maxBytes) {
        throw new GitReaderError(ERROR_CODES.PAYLOAD_TOO_LARGE, "Git diff exceeds the configured source limit");
      }
    }
    return diff;
  }
}
