import { realpath, stat } from "node:fs/promises";
import {
  ERROR_CODES,
  type ErrorCode,
} from "../../../../packages/contracts/src/index";
import type { FileDiff, DiffHunk, LocalBranch } from "../../../../packages/contracts/src/index";
import { normalizeSourcePath, SourceResolutionError } from "../repositories/registry";
import {
  WorkingTreePathMissingError,
  WorkingTreeReader,
  validateEnumeratedPath,
} from "./worktree";
import { diffText, formatUnifiedDiff, TextDiffError, type TextDiffOptions } from "./text-diff";
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

interface DecoderOptions {
  fatal?: boolean;
  ignoreBOM?: boolean;
}

async function readBounded(stream: ReadableStream<Uint8Array>, maxBytes: number, decoderOptions: DecoderOptions = {}): Promise<BoundedOutput> {
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
  return { text: new TextDecoder("utf-8", decoderOptions).decode(content), oversized: false };
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

const MAX_DIFF_WORK = 8 * 1024 * 1024;

function diffWorkBudget(maxBytes: number): number {
  return Math.min(MAX_DIFF_WORK, Math.max(100_000, maxBytes * 2));
}

function diffForGit(path: string, previous: string, current: string, maxWork: number, options: Omit<TextDiffOptions, "maxWork"> = {}) {
  try {
    return diffText(path, previous, current, { maxWork, ...options });
  } catch (error) {
    if (error instanceof TextDiffError) throw new GitReaderError(error.code, error.message);
    throw error;
  }
}

function buildTextDiff(path: string, previous: string, current: string, maxWork: number): string {
  const result = diffForGit(path, previous, current, maxWork, { emptySide: "split", binary: "diff" });
  return formatUnifiedDiff(path, result.hunks);
}

type DiffCurrent = { kind: "working-tree" } | { kind: "commit"; sha: string };

export class GitReader {
  readonly maxBytes: number;
  readonly maxDiffWork: number;

  constructor(maxBytes = 4 * 1024 * 1024) {
    if (!Number.isSafeInteger(maxBytes) || maxBytes <= 0) throw new RangeError("maxBytes must be a positive integer");
    this.maxBytes = maxBytes;
    this.maxDiffWork = diffWorkBudget(maxBytes);
  }

  private async execute(root: string, args: string[], stdoutDecoderOptions?: DecoderOptions): Promise<GitResult> {
    let canonicalRoot: string;
    try {
      canonicalRoot = await realpath(root);
      const information = await stat(canonicalRoot);
      if (!information.isDirectory()) throw new Error("git root is not a directory");
    } catch {
      throw new GitReaderError(ERROR_CODES.SOURCE_UNAVAILABLE, "repository root cannot be read");
    }
    const child = Bun.spawn({
      cmd: [
        "git",
        "-C",
        canonicalRoot,
        "-c",
        "core.hooksPath=/dev/null",
        "-c",
        "core.fsmonitor=false",
        ...args,
      ],
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
      readBounded(child.stdout, this.maxBytes, stdoutDecoderOptions),
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

  async listCommitFiles(root: string, sha: string): Promise<string[]> {
    await this.verifyRepository(root);
    await this.verifyRevision(root, sha);
    const result = await this.execute(root, ["ls-tree", "-r", "--name-only", "-z", sha]);
    if (result.oversized) throw new GitReaderError(ERROR_CODES.PAYLOAD_TOO_LARGE, "Git tree metadata exceeds the configured source limit");
    if (result.exitCode !== 0) throw new GitReaderError(ERROR_CODES.SOURCE_UNAVAILABLE, "Git tree cannot be read");
    return result.stdout
      .split("\0")
      .filter((path) => path.length > 0)
      .map((path) => validateEnumeratedPath(root, path));
  }

  async listWorktreeFiles(root: string): Promise<string[]> {
    const result = await this.execute(root, ["ls-files", "-z"]);
    if (result.oversized) throw new GitReaderError(ERROR_CODES.PAYLOAD_TOO_LARGE, "Git worktree metadata exceeds the configured source limit");
    if (result.exitCode !== 0) throw new GitReaderError(ERROR_CODES.SOURCE_UNAVAILABLE, "Git worktree files cannot be listed");
    return result.stdout
      .split("\0")
      .filter((path) => path.length > 0)
      .map((path) => validateEnumeratedPath(root, path));
  }

  async listLocalBranches(root: string): Promise<{ head_branch: string | null; branches: LocalBranch[] }> {
    await this.verifyRepository(root);
    const result = await this.execute(root, ["for-each-ref", "--format=%(refname)%00%(objectname)%00%(HEAD)", "refs/heads"]);
    if (result.oversized) throw new GitReaderError(ERROR_CODES.PAYLOAD_TOO_LARGE, "Git metadata exceeds the configured source limit");
    if (result.exitCode !== 0) throw new GitReaderError(ERROR_CODES.SOURCE_UNAVAILABLE, "Git local branches cannot be listed");
    const branches: LocalBranch[] = [];
    let head_branch: string | null = null;
    for (const record of result.stdout.split("\n")) {
      if (record.length === 0) continue;
      const [refname, objectname, head] = record.split("\0");
      if (refname === undefined || !refname.startsWith("refs/heads/")) continue;
      const name = refname.slice("refs/heads/".length);
      if (name.length === 0 || !isSafeRevision(name) || objectname === undefined || !/^[0-9a-f]{40}$/.test(objectname)) continue;
      branches.push({ name, sha: objectname });
      if (head === "*") head_branch = name;
    }
    branches.sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
    return { head_branch, branches };
  }

  async resolveLocalBranch(root: string, name: string): Promise<LocalBranch> {
    const listed = await this.listLocalBranches(root);
    const found = listed.branches.find((branch) => branch.name === name);
    if (!found) throw new GitReaderError(ERROR_CODES.REVISION_NOT_FOUND, "revision was not found");
    return found;
  }

  private async readCommitBlob(root: string, sha: string, path: string, strictUtf8 = false): Promise<string> {
    let result: GitResult;
    try {
      result = await this.execute(
        root,
        ["show", "--no-ext-diff", "--no-textconv", "--format=", `${sha}:${path}`],
        strictUtf8 ? { fatal: true, ignoreBOM: true } : undefined,
      );
    } catch (error) {
      if (strictUtf8) throw new GitReaderError(ERROR_CODES.SOURCE_UNAVAILABLE, "Git source blob is unavailable");
      throw error;
    }
    if (result.oversized) throw new GitReaderError(ERROR_CODES.PAYLOAD_TOO_LARGE, "Git source exceeds the configured source limit");
    if (result.exitCode !== 0) {
      throw new GitReaderError(ERROR_CODES.SOURCE_UNAVAILABLE, "Git source blob is unavailable");
    }
    return result.stdout;
  }

  async readCommitFile(root: string, sha: string, relativePath: string): Promise<string> {
    const normalizedPath = normalizeSourcePath(relativePath);
    await this.verifyRepository(root);
    await this.verifyRevision(root, sha);
    return this.readCommitBlob(root, sha, normalizedPath, true);
  }

  async resolveRevision(root: string, base: string): Promise<string> {
    await this.verifyRepository(root);
    if (base !== "HEAD" && !isSafeRevision(base)) {
      throw new GitReaderError(ERROR_CODES.REVISION_NOT_FOUND, "revision is not an allowed commit reference");
    }
    const result = await this.execute(root, ["rev-parse", `${base}^{commit}`]);
    if (result.oversized) throw new GitReaderError(ERROR_CODES.PAYLOAD_TOO_LARGE, "Git metadata exceeds the configured source limit");
    if (result.exitCode !== 0) throw new GitReaderError(ERROR_CODES.REVISION_NOT_FOUND, "revision was not found");
    return result.stdout.trim();
  }

  async readPathDiff(
    root: string,
    sha: string,
    relativePath: string,
    current: DiffCurrent = { kind: "working-tree" },
  ): Promise<FileDiff> {
    const normalizedPath = normalizeSourcePath(relativePath);
    await this.verifyRepository(root);
    await this.verifyRevision(root, sha);
    const treePaths = new Set(await this.listCommitFiles(root, sha));
    // A missing base side stays "" here; the guarded split below maps it to ZERO lines on purpose.
    let previous = "";
    let oldMissing = true;
    if (treePaths.has(normalizedPath)) {
      previous = await this.readCommitBlob(root, sha, normalizedPath);
      oldMissing = false;
    }
    let currentContent = "";
    let newMissing = true;
    if (current.kind === "commit") {
      await this.verifyRevision(root, current.sha);
      const currentPaths = new Set(await this.listCommitFiles(root, current.sha));
      if (currentPaths.has(normalizedPath)) {
        currentContent = await this.readCommitBlob(root, current.sha, normalizedPath);
        newMissing = false;
      } else {
        currentContent = "";
        newMissing = true;
      }
    } else {
      try {
        currentContent = (await new WorkingTreeReader(this.maxBytes).readEnumeratedFile(root, normalizedPath)).content;
        newMissing = false;
      } catch (error) {
        if (!(error instanceof WorkingTreePathMissingError)) throw error;
        // Same convention: a missing working-tree side stays "" and becomes ZERO lines below.
        currentContent = "";
      }
    }
    const result = diffForGit(normalizedPath, previous, currentContent, this.maxDiffWork, { maxOutputBytes: this.maxBytes });
    return { path: normalizedPath, base_sha: sha, hunks: result.hunks, old_missing: oldMissing, new_missing: newMissing, binary: result.binary };
  }

  async readDiff(root: string, sha: string): Promise<string> {
    await this.verifyRepository(root);
    await this.verifyRevision(root, sha);
    const [treePaths, worktreePaths] = await Promise.all([this.listCommitFiles(root, sha), this.listWorktreeFiles(root)]);
    const treePathSet = new Set(treePaths);
    const worktreePathSet = new Set(worktreePaths);
    const paths = new Set([...treePaths, ...worktreePaths]);
    const worktree = new WorkingTreeReader(this.maxBytes);
    const encoder = new TextEncoder();
    let diff = "";
    for (const path of paths) {
      const previous = treePathSet.has(path) ? await this.readCommitBlob(root, sha, path) : "";
      let current = "";
      if (worktreePathSet.has(path)) {
        try {
          current = (await worktree.readEnumeratedFile(root, path)).content;
        } catch (error) {
          if (error instanceof WorkingTreePathMissingError) {
            current = "";
          } else {
            throw error;
          }
        }
      }
      if (previous === current) continue;
      const patch = buildTextDiff(path, previous, current, this.maxDiffWork);
      diff += patch;
      if (encoder.encode(diff).byteLength > this.maxBytes) {
        throw new GitReaderError(ERROR_CODES.PAYLOAD_TOO_LARGE, "Git diff exceeds the configured source limit");
      }
    }
    return diff;
  }
}
