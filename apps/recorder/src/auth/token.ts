import { chmod, mkdir, readFile, realpath, writeFile } from "node:fs/promises";
import { dirname, isAbsolute, relative, resolve, sep } from "node:path";
import { randomBytes, timingSafeEqual } from "node:crypto";
import type { RecorderConfig } from "../config";

function assertContained(ownerRoot: string, tokenPath: string): void {
  const relativePath = relative(ownerRoot, tokenPath);
  if (relativePath === ".." || relativePath.startsWith(`..${sep}`) || isAbsolute(relativePath)) {
    throw new RangeError("tokenPath must resolve inside dataDir");
  }
}

async function canonicalTokenPath(config: Pick<RecorderConfig, "dataDir" | "tokenPath">): Promise<{ ownerRoot: string; tokenPath: string }> {
  const lexicalDataDir = resolve(config.dataDir);
  const lexicalTokenPath = resolve(config.tokenPath);
  assertContained(lexicalDataDir, lexicalTokenPath);
  const ownerRoot = await realpath(lexicalDataDir);
  let existingPath = lexicalTokenPath;
  while (true) {
    try {
      const canonicalExisting = await realpath(existingPath);
      const canonicalToken = resolve(canonicalExisting, relative(existingPath, lexicalTokenPath));
      assertContained(ownerRoot, canonicalToken);
      return { ownerRoot, tokenPath: canonicalToken };
    } catch (error) {
      const errno = error as NodeJS.ErrnoException;
      if (errno.code !== "ENOENT") throw error;
      const parent = dirname(existingPath);
      if (parent === existingPath) throw error;
      existingPath = parent;
    }
  }
}

export async function ensureOwnerToken(config: Pick<RecorderConfig, "dataDir" | "tokenPath">): Promise<string> {
  await mkdir(config.dataDir, { recursive: true, mode: 0o700 });
  const paths = await canonicalTokenPath(config);
  await mkdir(dirname(paths.tokenPath), { recursive: true, mode: 0o700 });
  await chmod(paths.ownerRoot, 0o700);
  try {
    const token = (await readFile(paths.tokenPath, "utf8")).trim();
    if (token.length === 0) throw new Error("owner token is empty");
    await chmod(paths.tokenPath, 0o600);
    return token;
  } catch (error) {
    const errno = error as NodeJS.ErrnoException;
    if (errno.code !== "ENOENT" && errno.code !== undefined) throw error;
  }
  const token = randomBytes(32).toString("hex");
  try {
    await writeFile(paths.tokenPath, `${token}\n`, { encoding: "utf8", mode: 0o600, flag: "wx" });
    return token;
  } catch (error) {
    const errno = error as NodeJS.ErrnoException;
    if (errno.code !== "EEXIST") throw error;
    const existing = (await readFile(paths.tokenPath, "utf8")).trim();
    if (existing.length === 0) throw new Error("owner token is empty");
    await chmod(paths.tokenPath, 0o600);
    return existing;
  }
}

export async function readOwnerToken(config: Pick<RecorderConfig, "dataDir" | "tokenPath">): Promise<string> {
  const paths = await canonicalTokenPath(config);
  const token = (await readFile(paths.tokenPath, "utf8")).trim();
  if (token.length === 0) throw new Error("owner token is empty");
  return token;
}

export function validateOwnerBearerToken(header: string | null, token: string): boolean {
  if (header === null) return false;
  const match = /^Bearer[ \t]+([^ \t]+)[ \t]*$/i.exec(header);
  if (match === null || match[1] === undefined) return false;
  const supplied = Buffer.from(match[1], "utf8");
  const expected = Buffer.from(token, "utf8");
  return supplied.length === expected.length && timingSafeEqual(supplied, expected);
}
