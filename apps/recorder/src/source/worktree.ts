import { createHash } from "node:crypto";
import { lstat, realpath, readlink, stat } from "node:fs/promises";
import { isAbsolute, relative, resolve, sep } from "node:path";
import { ERROR_CODES } from "../../../../packages/contracts/src/index";
import { normalizeSourcePath, SourceResolutionError } from "../repositories/registry";
function isContained(root: string, candidate: string): boolean {
  const childRelative = relative(root, candidate);
  return childRelative !== ".." && !childRelative.startsWith(`..${sep}`) && !isAbsolute(childRelative);
}

function isMissing(error: unknown): boolean {
  const code = (error as NodeJS.ErrnoException).code;
  return code === "ENOENT" || code === "ENOTDIR";
}

export function validateEnumeratedPath(root: string, path: string): string {
  if (path.length === 0 || path.includes("\0") || path.startsWith("/") || path.split("/").some((segment) => segment === "" || segment === "." || segment === "..")) {
    throw new SourceResolutionError(ERROR_CODES.SOURCE_UNAVAILABLE, "Git returned an unsafe repository path");
  }
  const candidate = resolve(root, path);
  if (!isContained(root, candidate) || candidate === root) {
    throw new SourceResolutionError(ERROR_CODES.SOURCE_UNAVAILABLE, "Git returned a path outside the repository root");
  }
  return path;
}

export class WorkingTreePathMissingError extends SourceResolutionError {
  constructor(message = "working-tree path is absent") {
    super(ERROR_CODES.SOURCE_UNAVAILABLE, message);
    this.name = "WorkingTreePathMissingError";
  }
}

export interface WorkingTreeFile {
  stream(): ReadableStream<Uint8Array>;
}

export type WorkingTreeFileProvider = (path: string) => WorkingTreeFile;

interface BoundedContent {
  content: string;
  oversized: boolean;
}

async function readBounded(stream: ReadableStream<Uint8Array>, maxBytes: number): Promise<BoundedContent> {
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
  if (oversized) return { content: "", oversized: true };
  const bytes = new Uint8Array(totalBytes);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return { content: new TextDecoder().decode(bytes), oversized: false };
}

export class WorkingTreeReader {
  readonly maxBytes: number;
  readonly fileProvider: WorkingTreeFileProvider;

  constructor(maxBytes = 4 * 1024 * 1024, fileProvider: WorkingTreeFileProvider = (path) => Bun.file(path)) {
    if (!Number.isSafeInteger(maxBytes) || maxBytes <= 0) throw new RangeError("maxBytes must be a positive integer");
    this.maxBytes = maxBytes;
    this.fileProvider = fileProvider;
  }

  async readFile(root: string, relativePath: string): Promise<{ content: string; contentHash: string }> {
    return this.readFileInternal(root, normalizeSourcePath(relativePath), false);
  }

  async readEnumeratedFile(root: string, path: string): Promise<{ content: string; contentHash: string }> {
    return this.readFileInternal(root, path, true);
  }

  private async readFileInternal(root: string, path: string, enumerated: boolean): Promise<{ content: string; contentHash: string }> {
    let canonicalRoot: string;
    try {
      canonicalRoot = await realpath(root);
      const rootInformation = await stat(canonicalRoot);
      if (!rootInformation.isDirectory()) throw new Error("working-tree root is not a directory");
    } catch {
      throw new SourceResolutionError(ERROR_CODES.SOURCE_UNAVAILABLE, "repository root cannot be read");
    }
    const safePath = enumerated ? validateEnumeratedPath(canonicalRoot, path) : path;
    const lexicalTarget = resolve(canonicalRoot, safePath);
    if (!isContained(canonicalRoot, lexicalTarget)) {
      throw new SourceResolutionError(ERROR_CODES.PATH_OUTSIDE_ROOT, "target path is outside the repository root");
    }
    let information;
    try {
      information = await lstat(lexicalTarget);
    } catch (error) {
      if (isMissing(error)) throw new WorkingTreePathMissingError();
      throw new SourceResolutionError(ERROR_CODES.SOURCE_UNAVAILABLE, "working-tree file is unavailable");
    }
    let content: string;
    if (information.isSymbolicLink()) {
      try {
        content = await readlink(lexicalTarget, "utf8");
      } catch (error) {
        if (isMissing(error)) throw new WorkingTreePathMissingError();
        throw new SourceResolutionError(ERROR_CODES.SOURCE_UNAVAILABLE, "working-tree symlink cannot be read");
      }
      if (new TextEncoder().encode(content).byteLength > this.maxBytes) {
        throw new SourceResolutionError(ERROR_CODES.PAYLOAD_TOO_LARGE, "working-tree source exceeds the configured source limit");
      }
    } else {
      if (!information.isFile()) {
        throw new SourceResolutionError(ERROR_CODES.SOURCE_UNAVAILABLE, "working-tree target is not a file");
      }
      if (information.size > this.maxBytes) {
        throw new SourceResolutionError(ERROR_CODES.PAYLOAD_TOO_LARGE, "working-tree source exceeds the configured source limit");
      }
      try {
        const bounded = await readBounded(this.fileProvider(lexicalTarget).stream(), this.maxBytes);
        if (bounded.oversized) {
          throw new SourceResolutionError(ERROR_CODES.PAYLOAD_TOO_LARGE, "working-tree source exceeds the configured source limit");
        }
        content = bounded.content;
      } catch (error) {
        if (error instanceof SourceResolutionError) throw error;
        throw new SourceResolutionError(ERROR_CODES.SOURCE_UNAVAILABLE, "working-tree file cannot be read");
      }
    }
    return { content, contentHash: createHash("sha256").update(content, "utf8").digest("hex") };
  }
}
