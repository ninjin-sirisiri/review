import { realpath, stat } from "node:fs/promises";
import {
  ERROR_CODES,
  type ErrorCode,
} from "../../../../packages/contracts/src/index";
import { normalizeSourcePath, SourceResolutionError } from "../repositories/registry";

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

  private async discoverFilterOverrides(root: string): Promise<string[]> {
    const listed = await this.execute(root, ["ls-files", "-z"]);
    if (listed.oversized) throw new GitReaderError(ERROR_CODES.PAYLOAD_TOO_LARGE, "Git file metadata exceeds the configured source limit");
    const paths = listed.stdout.split("\0").filter((path) => path.length > 0);
    const filters = new Set<string>();
    for (let offset = 0; offset < paths.length; offset += 256) {
      const batch = paths.slice(offset, offset + 256);
      const attributes = await this.execute(root, ["check-attr", "-z", "filter", "--", ...batch]);
      if (attributes.oversized) throw new GitReaderError(ERROR_CODES.PAYLOAD_TOO_LARGE, "Git attribute metadata exceeds the configured source limit");
      const fields = attributes.stdout.split("\0");
      for (let index = 2; index < fields.length; index += 3) {
        const value = fields[index];
        if (value !== undefined && /^[A-Za-z0-9._-]+$/.test(value) && value !== "unspecified" && value !== "unset") filters.add(value);
      }
    }
    const configArgs: string[] = [];
    for (const filter of filters) {
      configArgs.push("-c", `filter.${filter}.clean=`, "-c", `filter.${filter}.process=`, "-c", `filter.${filter}.smudge=`, "-c", `filter.${filter}.required=false`);
    }
    return configArgs;
  }

  async readCommitFile(root: string, sha: string, relativePath: string): Promise<string> {
    const normalizedPath = normalizeSourcePath(relativePath);
    await this.verifyRepository(root);
    await this.verifyRevision(root, sha);
    const result = await this.execute(root, ["show", "--no-ext-diff", "--no-textconv", "--format=", `${sha}:${normalizedPath}`]);
    if (result.oversized) throw new GitReaderError(ERROR_CODES.PAYLOAD_TOO_LARGE, "Git source exceeds the configured source limit");
    if (result.exitCode !== 0) {
      throw new GitReaderError(ERROR_CODES.SOURCE_UNAVAILABLE, "file is not available at the requested revision");
    }
    return result.stdout;
  }
  async readDiff(root: string, sha: string): Promise<string> {
    await this.verifyRepository(root);
    await this.verifyRevision(root, sha);
    const configArgs = await this.discoverFilterOverrides(root);
    const result = await this.execute(root, ["diff", "--no-ext-diff", "--no-textconv", sha, "--"], configArgs);
    if (result.oversized) throw new GitReaderError(ERROR_CODES.PAYLOAD_TOO_LARGE, "Git diff exceeds the configured source limit");
    if (result.exitCode !== 0) {
      throw new GitReaderError(ERROR_CODES.SOURCE_UNAVAILABLE, "diff is not available for the requested revision");
    }
    return result.stdout;
  }
}
