import { chmod, mkdir, readFile, writeFile } from "node:fs/promises";
import { randomBytes, timingSafeEqual } from "node:crypto";
import { isAbsolute, relative, resolve, sep } from "node:path";
import type { RecorderConfig } from "../config";

function assertTokenPathInsideDataDir(config: Pick<RecorderConfig, "dataDir" | "tokenPath">): void {
  const dataDir = resolve(config.dataDir);
  const tokenPath = resolve(config.tokenPath);
  const relativePath = relative(dataDir, tokenPath);
  if (relativePath === ".." || relativePath.startsWith(`..${sep}`) || isAbsolute(relativePath)) {
    throw new RangeError("tokenPath must be inside dataDir");
  }
}

export async function ensureOwnerToken(config: Pick<RecorderConfig, "dataDir" | "tokenPath">): Promise<string> {
  assertTokenPathInsideDataDir(config);
  await mkdir(config.dataDir, { recursive: true, mode: 0o700 });
  await chmod(config.dataDir, 0o700);
  try {
    const token = (await readFile(config.tokenPath, "utf8")).trim();
    if (token.length === 0) throw new Error("owner token is empty");
    await chmod(config.tokenPath, 0o600);
    return token;
  } catch (error) {
    const errno = error as NodeJS.ErrnoException;
    if (errno.code !== "ENOENT" && errno.code !== undefined) throw error;
  }
  const token = randomBytes(32).toString("hex");
  try {
    await writeFile(config.tokenPath, `${token}\n`, { encoding: "utf8", mode: 0o600, flag: "wx" });
    return token;
  } catch (error) {
    const errno = error as NodeJS.ErrnoException;
    if (errno.code !== "EEXIST") throw error;
    const existing = (await readFile(config.tokenPath, "utf8")).trim();
    if (existing.length === 0) throw new Error("owner token is empty");
    await chmod(config.tokenPath, 0o600);
    return existing;
  }
}

export async function readOwnerToken(config: Pick<RecorderConfig, "dataDir" | "tokenPath">): Promise<string> {
  assertTokenPathInsideDataDir(config);
  const token = (await readFile(config.tokenPath, "utf8")).trim();
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
