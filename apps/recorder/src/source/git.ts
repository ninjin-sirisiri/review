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
      cmd: ["git", "-C", canonicalRoot, ...args],
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
      new Response(child.stdout).text(),
      new Response(child.stderr).text(),
      child.exited,
    ]);
    return { stdout, stderr, exitCode };
  }

  private async verifyRevision(root: string, revision: string): Promise<void> {
    if (!isSafeRevision(revision)) {
      throw new GitReaderError(ERROR_CODES.REVISION_NOT_FOUND, "revision is not an allowed commit reference");
    }
    const result = await this.execute(root, ["cat-file", "-e", `${revision}^{commit}`]);
    if (result.exitCode !== 0) {
      throw new GitReaderError(ERROR_CODES.REVISION_NOT_FOUND, "revision was not found");
    }
  }

  async readCommitFile(root: string, sha: string, relativePath: string): Promise<string> {
    const normalizedPath = normalizeSourcePath(relativePath);
    await this.verifyRevision(root, sha);
    const result = await this.execute(root, ["show", "--no-ext-diff", "--no-textconv", "--format=", `${sha}:${normalizedPath}`]);
    if (result.exitCode !== 0) {
      throw new GitReaderError(ERROR_CODES.SOURCE_UNAVAILABLE, "file is not available at the requested revision");
    }
    return result.stdout;
  }

  async readDiff(root: string, sha: string): Promise<string> {
    await this.verifyRevision(root, sha);
    const result = await this.execute(root, ["diff", "--no-ext-diff", "--no-textconv", sha, "--"]);
    if (result.exitCode !== 0) {
      throw new GitReaderError(ERROR_CODES.SOURCE_UNAVAILABLE, "diff is not available for the requested revision");
    }
    return result.stdout;
  }
}
