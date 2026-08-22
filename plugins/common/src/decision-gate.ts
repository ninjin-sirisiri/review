import { createHash, randomUUID } from "node:crypto";
import { lstat, mkdir, readFile, readdir, realpath, rename, rm, stat, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { isAbsolute, join, relative, resolve, sep } from "node:path";
import {
  isRecord,
  type AgentType,
  type CheckEvidence,
  type RevisionRef,
} from "../../../packages/contracts/src/index";
import type { HostDecisionEvent, HostTargetReference } from "./adapter-contract";

const DEFAULT_PERMIT_TTL_MS = 10 * 60 * 1_000;
const MAX_HASH_BYTES = 10 * 1_024 * 1_024;
const PROPOSAL_KEYS = [
  "sessionId",
  "repositoryRoot",
  "revision",
  "targets",
  "judgment",
  "rationale",
  "checks",
  "openQuestions",
  "recordId",
  "createdAt",
] as const;
const TARGET_KEYS = ["path", "lineStart", "lineEnd", "revision", "contentHash"] as const;

export interface DecisionProposal {
  sessionId?: string;
  repositoryRoot?: string;
  revision?: RevisionRef;
  targets: Array<{
    path: string;
    lineStart: number;
    lineEnd?: number;
    revision?: RevisionRef;
    contentHash?: string;
  }>;
  judgment: string;
  rationale: string;
  checks?: CheckEvidence[];
  openQuestions?: string[];
  recordId?: string;
  createdAt?: string;
}

export interface DecisionProposalDefaults {
  sessionId?: string;
  repositoryRoot?: string;
}

export interface GateStorageOptions {
  gateRoot?: string;
  ttlMs?: number;
}

export interface GrantedDecisionPermits {
  permits: number;
  gateDirectory: string;
  expiresAt: string;
}

export interface ConsumeDecisionPermitOptions {
  sessionId: string;
  repositoryRoot: string;
  filePath: string;
  gateRoot?: string;
}

interface DecisionPermit {
  sessionId: string;
  repositoryRoot: string;
  recordId: string;
  path: string;
  contentHash: string;
  expiresAt: string;
}

function fail(message: string): never {
  throw new Error(message);
}

function nonEmptyString(value: unknown, field: string): string {
  if (typeof value !== "string" || value.trim().length === 0) fail(`${field} must be a non-empty string`);
  return value;
}

function onlyKeys(value: Record<string, unknown>, allowed: readonly string[], label: string): void {
  const unexpected = Object.keys(value).find((key) => !allowed.includes(key));
  if (unexpected !== undefined) fail(`${label}.${unexpected} is not supported`);
}

function sha256(value: string): string {
  return createHash("sha256").update(value, "utf8").digest("hex");
}

function hashText(value: string): string {
  return sha256(value);
}

function normalizedRelativePath(root: string, candidate: string): string {
  const absoluteCandidate = resolve(root, candidate);
  const relativeCandidate = relative(root, absoluteCandidate);
  if (relativeCandidate === "" || relativeCandidate === ".." || relativeCandidate.startsWith(`..${sep}`) || isAbsolute(relativeCandidate)) {
    fail("target path must stay inside repositoryRoot");
  }
  return relativeCandidate.split(sep).join("/");
}

async function currentFileText(path: string): Promise<string> {
  try {
    const details = await stat(path);
    if (!details.isFile()) fail(`target is not a regular file: ${path}`);
    if (details.size > MAX_HASH_BYTES) fail(`target exceeds the hash size limit: ${path}`);
    return await readFile(path, "utf8");
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code === "ENOENT") return "";
    if (error instanceof Error && error.message.startsWith("target ")) throw error;
    throw new Error(`target could not be read: ${path}`);
  }
}

async function canonicalPath(root: string, filePath: string): Promise<{ root: string; path: string } | null> {
  let canonicalRoot: string;
  try {
    canonicalRoot = await realpath(root);
  } catch {
    return null;
  }
  try {
    if ((await lstat(filePath)).isSymbolicLink()) return null;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") return null;
  }
  let canonicalFile: string;
  try {
    canonicalFile = await realpath(filePath);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") return null;
    try {
      const parent = await realpath(resolve(filePath, ".."));
      canonicalFile = resolve(parent, filePath.split(sep).pop() ?? "");
    } catch {
      return null;
    }
  }
  const relativeFile = relative(canonicalRoot, canonicalFile);
  if (relativeFile === "" || relativeFile === ".." || relativeFile.startsWith(`..${sep}`) || isAbsolute(relativeFile)) return null;
  return { root: canonicalRoot, path: canonicalFile };
}

async function hashExistingFile(path: string): Promise<string> {
  return hashText(await currentFileText(path));
}

function gateBase(options: GateStorageOptions): string {
  return options.gateRoot ?? process.env.AI_REVIEW_GATE_ROOT ?? join(homedir(), ".ai-code-review-evidence", "gates");
}

function gateDirectory(root: string, sessionId: string, options: GateStorageOptions = {}): string {
  return join(gateBase(options), sha256(root), sha256(sessionId));
}

function permitPath(directory: string): string {
  return join(directory, `permit-${randomUUID()}.json`);
}

function parseProposal(value: unknown): DecisionProposal {
  if (!isRecord(value)) fail("decision proposal must be an object");
  onlyKeys(value, PROPOSAL_KEYS, "proposal");
  if (!Array.isArray(value.targets) || value.targets.length === 0) fail("proposal.targets must contain at least one target");
  if (typeof value.judgment !== "string" || value.judgment.trim().length === 0) fail("proposal.judgment must be a non-empty string");
  if (typeof value.rationale !== "string" || value.rationale.trim().length === 0) fail("proposal.rationale must be a non-empty string");
  const targets = value.targets.map((candidate, index) => {
    if (!isRecord(candidate)) fail(`proposal.targets[${index}] must be an object`);
    onlyKeys(candidate, TARGET_KEYS, `proposal.targets[${index}]`);
    const path = nonEmptyString(candidate.path, `proposal.targets[${index}].path`);
    if (!Number.isSafeInteger(candidate.lineStart) || (candidate.lineStart as number) < 1) fail(`proposal.targets[${index}].lineStart must be a positive integer`);
    if (candidate.lineEnd !== undefined && (!Number.isSafeInteger(candidate.lineEnd) || (candidate.lineEnd as number) < (candidate.lineStart as number))) {
      fail(`proposal.targets[${index}].lineEnd must be at or after lineStart`);
    }
    return {
      path,
      lineStart: candidate.lineStart as number,
      ...(candidate.lineEnd === undefined ? {} : { lineEnd: candidate.lineEnd as number }),
      ...(candidate.revision === undefined ? {} : { revision: candidate.revision as RevisionRef }),
      ...(candidate.contentHash === undefined ? {} : { contentHash: nonEmptyString(candidate.contentHash, `proposal.targets[${index}].contentHash`) }),
    };
  });
  return {
    ...(value.sessionId === undefined ? {} : { sessionId: nonEmptyString(value.sessionId, "proposal.sessionId") }),
    ...(value.repositoryRoot === undefined ? {} : { repositoryRoot: nonEmptyString(value.repositoryRoot, "proposal.repositoryRoot") }),
    ...(value.revision === undefined ? {} : { revision: value.revision as RevisionRef }),
    targets,
    judgment: value.judgment,
    rationale: value.rationale,
    ...(value.checks === undefined ? {} : { checks: value.checks as CheckEvidence[] }),
    ...(value.openQuestions === undefined ? {} : { openQuestions: value.openQuestions as string[] }),
    ...(value.recordId === undefined ? {} : { recordId: nonEmptyString(value.recordId, "proposal.recordId") }),
    ...(value.createdAt === undefined ? {} : { createdAt: nonEmptyString(value.createdAt, "proposal.createdAt") }),
  };
}

export async function normalizeDecisionProposal(value: unknown, defaults: DecisionProposalDefaults): Promise<HostDecisionEvent> {
  const proposal = parseProposal(value);
  const sessionId = proposal.sessionId ?? defaults.sessionId;
  if (sessionId === undefined) fail("sessionId is required; start the plugin session first");
  const repositoryRoot = resolve(proposal.repositoryRoot ?? defaults.repositoryRoot ?? process.cwd());
  if (!isAbsolute(repositoryRoot)) fail("repositoryRoot must be an absolute path");
  const canonicalRoot = await realpath(repositoryRoot).catch(() => fail("repositoryRoot does not exist"));
  const targetData: Array<{ path: string; lineStart: number; lineEnd: number; contentHash: string; revision?: RevisionRef }> = [];
  for (const target of proposal.targets) {
    const path = normalizedRelativePath(canonicalRoot, target.path);
    if (await canonicalPath(canonicalRoot, resolve(canonicalRoot, path)) === null) {
      fail(`target path must resolve inside repositoryRoot: ${path}`);
    }
    const text = await currentFileText(resolve(canonicalRoot, path));
    const contentHash = hashText(text);
    if (target.contentHash !== undefined && target.contentHash !== contentHash) {
      fail(`target contentHash does not match the current file: ${path}`);
    }
    const lineCount = Math.max(1, text.split(/\r?\n/).length - (text.endsWith("\n") ? 1 : 0));
    targetData.push({
      path,
      lineStart: target.lineStart,
      lineEnd: target.lineEnd ?? Math.max(target.lineStart, lineCount),
      contentHash,
      ...(target.revision === undefined ? {} : { revision: target.revision }),
    });
  }
  const revision = proposal.revision ?? {
    kind: "working-tree" as const,
    contentHash: sha256(targetData.map((target) => `${target.path}\0${target.contentHash}`).sort().join("\n")),
  };
  return {
    sessionId,
    repositoryRoot: canonicalRoot,
    revision,
    targets: targetData.map((target): HostTargetReference => ({
      path: target.path,
      lineStart: target.lineStart,
      lineEnd: target.lineEnd,
      revision: target.revision ?? revision,
      contentHash: target.contentHash,
    })),
    judgment: proposal.judgment,
    rationale: proposal.rationale,
    checks: proposal.checks ?? [],
    openQuestions: proposal.openQuestions ?? [],
    ...(proposal.recordId === undefined ? {} : { recordId: proposal.recordId }),
    ...(proposal.createdAt === undefined ? {} : { createdAt: proposal.createdAt }),
  };
}

export async function grantDecisionPermits(event: HostDecisionEvent, options: GateStorageOptions & { recordId: string }): Promise<GrantedDecisionPermits> {
  const recordId = nonEmptyString(options.recordId, "recordId");
  const sessionId = nonEmptyString(event.sessionId, "sessionId");
  const root = await realpath(event.repositoryRoot).catch(() => fail("repositoryRoot does not exist"));
  const ttlMs = options.ttlMs ?? DEFAULT_PERMIT_TTL_MS;
  if (!Number.isSafeInteger(ttlMs) || ttlMs <= 0) fail("permit ttl must be a positive integer");
  const expiresAt = new Date(Date.now() + ttlMs).toISOString();
  const directory = gateDirectory(root, sessionId, options);
  await mkdir(directory, { recursive: true, mode: 0o700 });
  for (const target of event.targets) {
    const path = normalizedRelativePath(root, target.path);
    const permit: DecisionPermit = { sessionId, repositoryRoot: root, recordId, path, contentHash: target.contentHash, expiresAt };
    await writeFile(permitPath(directory), `${JSON.stringify(permit)}\n`, { encoding: "utf8", mode: 0o600 });
  }
  return { permits: event.targets.length, gateDirectory: directory, expiresAt };
}

async function claimPermit(path: string): Promise<string | null> {
  const claimed = `${path}.claim-${process.pid}-${randomUUID()}`;
  try {
    await rename(path, claimed);
    return claimed;
  } catch {
    return null;
  }
}

export async function consumeDecisionPermit(options: ConsumeDecisionPermitOptions): Promise<boolean> {
  const canonical = await canonicalPath(options.repositoryRoot, options.filePath);
  if (canonical === null) return false;
  const directory = gateDirectory(canonical.root, options.sessionId, options.gateRoot === undefined ? {} : { gateRoot: options.gateRoot });
  let entries;
  try {
    entries = await readdir(directory, { withFileTypes: true });
  } catch {
    return false;
  }
  const relativeFile = relative(canonical.root, canonical.path).split(sep).join("/");
  for (const entry of entries) {
    if (!entry.isFile() || !entry.name.endsWith(".json")) continue;
    const original = join(directory, entry.name);
    let raw: string;
    try {
      raw = await readFile(original, "utf8");
    } catch {
      continue;
    }
    let permit: DecisionPermit;
    try {
      const value = JSON.parse(raw) as Partial<DecisionPermit>;
      if (typeof value.sessionId !== "string" || typeof value.repositoryRoot !== "string" || typeof value.recordId !== "string" || typeof value.path !== "string" || typeof value.contentHash !== "string" || typeof value.expiresAt !== "string") continue;
      permit = value as DecisionPermit;
    } catch {
      continue;
    }
    if (permit.sessionId !== options.sessionId || permit.repositoryRoot !== canonical.root || permit.path !== relativeFile) continue;
    if (Date.parse(permit.expiresAt) <= Date.now()) {
      await rm(original, { force: true }).catch(() => undefined);
      continue;
    }
    const actualHash = await hashExistingFile(canonical.path).catch(() => null);
    if (actualHash !== permit.contentHash) continue;
    const claimed = await claimPermit(original);
    if (claimed === null) continue;
    await rm(claimed, { force: true }).catch(() => undefined);
    return true;
  }
  return false;
}

export function likelyCodeMutation(command: string): boolean {
  const normalized = command.replaceAll("\\", "/");
  return /(?:^|[;&|]\s*)(?:apply_patch|patch)\b/i.test(normalized)
    || /\bgit\s+(?:apply|am|checkout|restore|reset|rebase|merge)\b/i.test(normalized)
    || /\b(?:sed|perl)\s+[^\n]*-i(?:\s|$)/i.test(normalized)
    || /\b(?:tee|install|cp|mv)\s+[^\n]*(?:>|$)/i.test(normalized)
    || /(?:^|\s)(?:>|>>|1>|2>)\s*[^\s|;&]+/.test(normalized)
    || /\b(?:python|python3|node|nodejs|bun)\s+[^\n]*(?:writeFile|appendFile|write_text|open\s*\([^)]*['"][wax+])/i.test(normalized);
}

export function defaultGateRoot(): string {
  return process.env.AI_REVIEW_GATE_ROOT ?? join(homedir(), ".ai-code-review-evidence", "gates");
}
