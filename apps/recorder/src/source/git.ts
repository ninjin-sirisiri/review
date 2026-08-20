import { realpath, stat } from "node:fs/promises";
import {
  ERROR_CODES,
  type ErrorCode,
} from "../../../../packages/contracts/src/index";
import { normalizeSourcePath, SourceResolutionError } from "../repositories/registry";
import {
  WorkingTreePathMissingError,
  WorkingTreeReader,
  validateEnumeratedPath,
} from "./worktree";
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

type DiffOperation =
  | { kind: "equal"; line: string }
  | { kind: "delete"; line: string }
  | { kind: "insert"; line: string };

interface DiffEntry {
  operation: DiffOperation;
  oldLine: number | null;
  newLine: number | null;
  oldBefore: number;
  newBefore: number;
}

const MAX_DIFF_WORK = 8 * 1024 * 1024;

function diffWorkBudget(maxBytes: number): number {
  return Math.min(MAX_DIFF_WORK, Math.max(100_000, maxBytes * 2));
}

function lineDiff(previous: string[], current: string[], maxWork: number): DiffOperation[] | null {
  const maxDistance = previous.length + current.length;
  let frontier = new Map<number, number>([[1, 0]]);
  const trace: Map<number, number>[] = [];
  let work = 0;

  const spendWork = (): boolean => {
    if (work >= maxWork) return false;
    work += 1;
    return true;
  };

  for (let distance = 0; distance <= maxDistance; distance += 1) {
    if (!spendWork()) return null;
    const nextFrontier = new Map<number, number>();
    for (let diagonal = -distance; diagonal <= distance; diagonal += 2) {
      if (!spendWork()) return null;
      const down = diagonal === -distance || (diagonal !== distance && (frontier.get(diagonal - 1) ?? -1) < (frontier.get(diagonal + 1) ?? -1));
      let x = down ? (frontier.get(diagonal + 1) ?? 0) : (frontier.get(diagonal - 1) ?? 0) + 1;
      let y = x - diagonal;
      while (x < previous.length && y < current.length && previous[x] === current[y]) {
        if (!spendWork()) return null;
        x += 1;
        y += 1;
      }
      if (!spendWork()) return null;
      nextFrontier.set(diagonal, x);
      if (x >= previous.length && y >= current.length) {
        trace.push(nextFrontier);
        const operations: DiffOperation[] = [];
        let backtrackX = previous.length;
        let backtrackY = current.length;
        for (let step = trace.length - 1; step > 0; step -= 1) {
          const prior = trace[step - 1]!;
          const backtrackDiagonal = backtrackX - backtrackY;
          const backtrackDown =
            backtrackDiagonal === -step ||
            (backtrackDiagonal !== step && (prior.get(backtrackDiagonal - 1) ?? -1) < (prior.get(backtrackDiagonal + 1) ?? -1));
          const priorDiagonal = backtrackDown ? backtrackDiagonal + 1 : backtrackDiagonal - 1;
          const priorX = prior.get(priorDiagonal) ?? 0;
          const priorY = priorX - priorDiagonal;
          while (backtrackX > priorX && backtrackY > priorY) {
            operations.push({ kind: "equal", line: previous[backtrackX - 1]! });
            backtrackX -= 1;
            backtrackY -= 1;
          }
          if (backtrackX === priorX) {
            operations.push({ kind: "insert", line: current[backtrackY - 1]! });
            backtrackY -= 1;
          } else {
            operations.push({ kind: "delete", line: previous[backtrackX - 1]! });
            backtrackX -= 1;
          }
        }
        while (backtrackX > 0 && backtrackY > 0) {
          operations.push({ kind: "equal", line: previous[backtrackX - 1]! });
          backtrackX -= 1;
          backtrackY -= 1;
        }
        while (backtrackX > 0) {
          operations.push({ kind: "delete", line: previous[backtrackX - 1]! });
          backtrackX -= 1;
        }
        while (backtrackY > 0) {
          operations.push({ kind: "insert", line: current[backtrackY - 1]! });
          backtrackY -= 1;
        }
        return operations.reverse();
      }
    }
    trace.push(nextFrontier);
    frontier = nextFrontier;
  }
  return null;
}

function buildTextDiff(path: string, previous: string, current: string, maxWork: number): string {
  const operations = lineDiff(previous.split("\n"), current.split("\n"), maxWork);
  if (operations === null) {
    throw new GitReaderError(ERROR_CODES.PAYLOAD_TOO_LARGE, "Git diff work exceeds the configured source limit");
  }
  const entries: DiffEntry[] = [];
  let oldLine = 0;
  let newLine = 0;
  for (const operation of operations) {
    entries.push({
      operation,
      oldLine: operation.kind === "insert" ? null : oldLine + 1,
      newLine: operation.kind === "delete" ? null : newLine + 1,
      oldBefore: oldLine,
      newBefore: newLine,
    });
    if (operation.kind !== "insert") oldLine += 1;
    if (operation.kind !== "delete") newLine += 1;
  }
  const changes = entries.flatMap((entry, index) => (entry.operation.kind === "equal" ? [] : [index]));
  if (changes.length === 0) return "";

  const hunks: string[] = [];
  let start = Math.max(0, changes[0]! - 3);
  let end = Math.min(entries.length - 1, changes[0]! + 3);
  for (let change = 1; change < changes.length; change += 1) {
    const nextStart = Math.max(0, changes[change]! - 3);
    const nextEnd = Math.min(entries.length - 1, changes[change]! + 3);
    if (nextStart <= end + 1) {
      end = Math.max(end, nextEnd);
      continue;
    }
    hunks.push(formatHunk(entries, start, end));
    start = nextStart;
    end = nextEnd;
  }
  hunks.push(formatHunk(entries, start, end));
  return `diff --git a/${path} b/${path}\n--- a/${path}\n+++ b/${path}\n${hunks.join("")}`;
}

function formatHunk(entries: DiffEntry[], start: number, end: number): string {
  const hunkEntries = entries.slice(start, end + 1);
  const first = hunkEntries[0]!;
  const oldStart = first.oldLine ?? first.oldBefore + 1;
  const newStart = first.newLine ?? first.newBefore + 1;
  const oldCount = hunkEntries.filter((entry) => entry.oldLine !== null).length;
  const newCount = hunkEntries.filter((entry) => entry.newLine !== null).length;
  const body = hunkEntries
    .map((entry) => `${entry.operation.kind === "equal" ? " " : entry.operation.kind === "delete" ? "-" : "+"}${entry.operation.line}`)
    .join("\n");
  return `@@ -${oldStart},${oldCount} +${newStart},${newCount} @@\n${body}\n`;
}


export class GitReader {
  readonly maxBytes: number;
  readonly maxDiffWork: number;

  constructor(maxBytes = 4 * 1024 * 1024) {
    if (!Number.isSafeInteger(maxBytes) || maxBytes <= 0) throw new RangeError("maxBytes must be a positive integer");
    this.maxBytes = maxBytes;
    this.maxDiffWork = diffWorkBudget(maxBytes);
  }

  private async execute(root: string, args: string[]): Promise<GitResult> {
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
    return result.stdout
      .split("\0")
      .filter((path) => path.length > 0)
      .map((path) => validateEnumeratedPath(root, path));
  }

  private async listWorktreePaths(root: string): Promise<string[]> {
    const result = await this.execute(root, ["ls-files", "-z"]);
    if (result.oversized) throw new GitReaderError(ERROR_CODES.PAYLOAD_TOO_LARGE, "Git worktree metadata exceeds the configured source limit");
    if (result.exitCode !== 0) throw new GitReaderError(ERROR_CODES.SOURCE_UNAVAILABLE, "Git worktree files cannot be listed");
    return result.stdout
      .split("\0")
      .filter((path) => path.length > 0)
      .map((path) => validateEnumeratedPath(root, path));
  }

  private async readCommitBlob(root: string, sha: string, path: string): Promise<string> {
    const result = await this.execute(root, ["show", "--no-ext-diff", "--no-textconv", "--format=", `${sha}:${path}`]);
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
    return this.readCommitBlob(root, sha, normalizedPath);
  }

  async readDiff(root: string, sha: string): Promise<string> {
    await this.verifyRepository(root);
    await this.verifyRevision(root, sha);
    const [treePaths, worktreePaths] = await Promise.all([this.listTreePaths(root, sha), this.listWorktreePaths(root)]);
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
