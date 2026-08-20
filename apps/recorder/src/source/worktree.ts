import { createHash } from "node:crypto";
import { realpath, stat } from "node:fs/promises";
import { isAbsolute, relative, resolve, sep } from "node:path";
import { ERROR_CODES } from "../../../../packages/contracts/src/index";
import { normalizeSourcePath, SourceResolutionError } from "../repositories/registry";
function isContained(root: string, candidate: string): boolean {
  const childRelative = relative(root, candidate);
  return childRelative !== ".." && !childRelative.startsWith(`..${sep}`) && !isAbsolute(childRelative);
}

export class WorkingTreeReader {
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
    let content: string;
    try {
      content = await Bun.file(canonicalTarget).text();
    } catch {
      throw new SourceResolutionError(ERROR_CODES.SOURCE_UNAVAILABLE, "working-tree file cannot be read");
    }
    return { content, contentHash: createHash("sha256").update(content, "utf8").digest("hex") };
  }
}
