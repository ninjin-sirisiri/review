import { createHash } from "node:crypto";
import { realpath, stat } from "node:fs/promises";
import { isAbsolute, relative, resolve, sep } from "node:path";
import { ERROR_CODES } from "../../../../packages/contracts/src/index";
import { normalizeSourcePath, SourceResolutionError } from "../repositories/registry";
function isContained(root: string, candidate: string): boolean {
  const childRelative = relative(root, candidate);
  return childRelative !== ".." && !childRelative.startsWith(`..${sep}`) && !isAbsolute(childRelative);
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
    const normalizedPath = normalizeSourcePath(relativePath);
    let canonicalRoot: string;
    try {
      canonicalRoot = await realpath(root);
      const rootInformation = await stat(canonicalRoot);
      if (!rootInformation.isDirectory()) throw new Error("working-tree root is not a directory");
    } catch {
      throw new SourceResolutionError(ERROR_CODES.SOURCE_UNAVAILABLE, "repository root cannot be read");
    }
    const lexicalTarget = resolve(canonicalRoot, normalizedPath);
    if (!isContained(canonicalRoot, lexicalTarget)) {
      throw new SourceResolutionError(ERROR_CODES.PATH_OUTSIDE_ROOT, "target path is outside the repository root");
    }
    let canonicalTarget: string;
    try {
      canonicalTarget = await realpath(lexicalTarget);
    } catch {
      throw new SourceResolutionError(ERROR_CODES.SOURCE_UNAVAILABLE, "working-tree file is unavailable");
    }
    if (!isContained(canonicalRoot, canonicalTarget) || canonicalTarget === canonicalRoot) {
      throw new SourceResolutionError(ERROR_CODES.PATH_OUTSIDE_ROOT, "target path resolves outside the repository root");
    }
    let information;
    try {
      information = await stat(canonicalTarget);
    } catch {
      throw new SourceResolutionError(ERROR_CODES.SOURCE_UNAVAILABLE, "working-tree file is unavailable");
    }
    if (!information.isFile()) {
      throw new SourceResolutionError(ERROR_CODES.SOURCE_UNAVAILABLE, "working-tree target is not a file");
    }
    if (information.size > this.maxBytes) {
      throw new SourceResolutionError(ERROR_CODES.PAYLOAD_TOO_LARGE, "working-tree source exceeds the configured source limit");
    }
    let content: string;
    try {
      const bounded = await readBounded(this.fileProvider(canonicalTarget).stream(), this.maxBytes);
      if (bounded.oversized) {
        throw new SourceResolutionError(ERROR_CODES.PAYLOAD_TOO_LARGE, "working-tree source exceeds the configured source limit");
      }
      content = bounded.content;
    } catch (error) {
      if (error instanceof SourceResolutionError) throw error;
      throw new SourceResolutionError(ERROR_CODES.SOURCE_UNAVAILABLE, "working-tree file cannot be read");
    }
    return { content, contentHash: createHash("sha256").update(content, "utf8").digest("hex") };
  }
}
