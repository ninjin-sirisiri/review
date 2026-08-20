import { Database } from "bun:sqlite";
import { createHash } from "node:crypto";
import { mkdir, readFile, realpath, rm, stat, unlink, writeFile } from "node:fs/promises";
import { existsSync, mkdirSync, realpathSync } from "node:fs";
import { dirname, isAbsolute, relative, resolve, sep } from "node:path";
import {
  ERROR_CODES,
  validateSnapshotReference,
  type SnapshotMode,
  type SnapshotReference,
} from "../../../../packages/contracts/src/index";
import { createRecorderConfig, type RecorderConfig, type RecorderConfigOverrides } from "../config";
import { migrateSchema } from "./schema";
import type { RecordStore } from "./records";
import { PersistenceError } from "./records";

interface SnapshotRow {
  snapshot_id: string;
  record_id: string;
  mode: SnapshotMode;
  path: string;
  content_hash: string;
  created_at: string;
}

type ConfigInput = RecorderConfig | RecorderConfigOverrides;

function hashContent(content: string): string {
  return createHash("sha256").update(content, "utf8").digest("hex");
}

function now(): string {
  return new Date().toISOString();
}

function isRecordStore(value: unknown): value is RecordStore {
  return typeof value === "object" && value !== null && "db" in value && "config" in value;
}

function snapshotMode(value: unknown): value is SnapshotMode {
  return value === "changed-files" || value === "patch";
}
function contentByteLength(content: string): number {
  return new TextEncoder().encode(content).byteLength;
}

export class SnapshotStore {
  readonly db: Database;
  readonly config: RecorderConfig;
  private readonly snapshotRoot: string;
  private readonly canonicalSnapshotRoot: string;
  constructor(store: RecordStore, config?: ConfigInput);
  constructor(database: Database, config?: ConfigInput);
  constructor(storeOrDatabase: RecordStore | Database, configInput?: ConfigInput) {
    if (isRecordStore(storeOrDatabase)) {
      this.db = storeOrDatabase.db;
      this.config = configInput === undefined ? storeOrDatabase.config : createRecorderConfig(configInput as RecorderConfigOverrides);
    } else {
      this.db = storeOrDatabase;
      this.config = createRecorderConfig((configInput ?? {}) as RecorderConfigOverrides);
    }
    migrateSchema(this.db);

    mkdirSync(this.config.dataDir, { recursive: true, mode: 0o700 });
    const ownerRoot = realpathSync(resolve(this.config.dataDir));
    const configuredRoot = resolve(this.config.snapshotDir);
    const lexicalRelative = relative(resolve(this.config.dataDir), configuredRoot);
    if (lexicalRelative === ".." || lexicalRelative.startsWith(`..${sep}`) || isAbsolute(lexicalRelative)) {
      throw new PersistenceError(ERROR_CODES.PATH_OUTSIDE_ROOT, "snapshotDir must be inside dataDir");
    }

    let existingAncestor = configuredRoot;
    while (!existsSync(existingAncestor)) {
      const parent = dirname(existingAncestor);
      if (parent === existingAncestor) {
        throw new PersistenceError(ERROR_CODES.PATH_OUTSIDE_ROOT, "snapshotDir has no resolvable owner-local ancestor");
      }
      existingAncestor = parent;
    }
    const canonicalAncestor = realpathSync(existingAncestor);
    const missingSuffix = relative(existingAncestor, configuredRoot);
    const canonicalRoot = resolve(canonicalAncestor, missingSuffix);
    const canonicalRelative = relative(ownerRoot, canonicalRoot);
    if (canonicalRelative === ".." || canonicalRelative.startsWith(`..${sep}`) || isAbsolute(canonicalRelative)) {
      throw new PersistenceError(ERROR_CODES.PATH_OUTSIDE_ROOT, "snapshotDir resolves outside dataDir");
    }
    this.snapshotRoot = configuredRoot;
    this.canonicalSnapshotRoot = canonicalRoot;
  }

  async create(recordId: string, mode: SnapshotMode, content: string): Promise<SnapshotReference> {
    if (typeof recordId !== "string" || recordId.trim().length === 0) {
      throw new PersistenceError(ERROR_CODES.INVALID_RECORD, "recordId must be a non-empty string");
    }
    if (!snapshotMode(mode)) {
      throw new PersistenceError(ERROR_CODES.INVALID_RECORD, "snapshot mode must be changed-files or patch");
    }
    if (typeof content !== "string") {
      throw new PersistenceError(ERROR_CODES.INVALID_RECORD, "snapshot content must be a string");
    }
    if (contentByteLength(content) > this.config.maxSnapshotContentLength) {
      throw new PersistenceError(ERROR_CODES.PAYLOAD_TOO_LARGE, "snapshot content exceeds the configured maximum length");
    }

    const decision = this.db.query("SELECT 1 AS present FROM decision_records WHERE record_id = $record_id").get({ $record_id: recordId }) as { present: number } | null;
    if (decision === null) {
      throw new PersistenceError(ERROR_CODES.INVALID_RECORD, `decision ${recordId} does not exist`);
    }

    const snapshotId = crypto.randomUUID();
    const ownerDirectory = resolve(this.snapshotRoot, encodeURIComponent(recordId));
    const filePath = resolve(ownerDirectory, `${snapshotId}.snapshot`);
    const configuredRoot = resolve(this.snapshotRoot);
    const fileRelativeToRoot = relative(configuredRoot, filePath);
    if (fileRelativeToRoot === "" || fileRelativeToRoot === ".." || fileRelativeToRoot.startsWith(`..${sep}`) || isAbsolute(fileRelativeToRoot)) {
      throw new PersistenceError(ERROR_CODES.PATH_OUTSIDE_ROOT, "snapshot path escapes the local snapshot directory");
    }
    const path = relative(this.config.dataDir, filePath).split(sep).join("/");
    const createdAt = now();
    const reference: SnapshotReference = {
      snapshot_id: snapshotId,
      record_id: recordId,
      mode,
      path,
      content_hash: hashContent(content),
      created_at: createdAt,
    };
    const validation = validateSnapshotReference(reference);
    if (!validation.success) {
      throw new PersistenceError(validation.error.code, validation.error.message);
    }

    await mkdir(ownerDirectory, { recursive: true });
    try {
      await writeFile(filePath, content, { encoding: "utf8", flag: "wx", mode: 0o600 });
      const transaction = this.db.transaction(() => {
        this.db.query(
          `INSERT INTO snapshots (snapshot_id, record_id, mode, path, content_hash, created_at)
           VALUES ($snapshot_id, $record_id, $mode, $path, $content_hash, $created_at)`,
        ).run({
          $snapshot_id: reference.snapshot_id,
          $record_id: reference.record_id,
          $mode: reference.mode,
          $path: reference.path,
          $content_hash: reference.content_hash,
          $created_at: reference.created_at,
        });
      });
      transaction();
      return reference;
    } catch (error) {
      await rm(filePath, { force: true });
      if (error instanceof PersistenceError) throw error;
      throw error;
    }
  }

  async get(snapshotId: string): Promise<{ reference: SnapshotReference; content: string } | null> {
    const row = this.db.query(
      `SELECT snapshot_id, record_id, mode, path, content_hash, created_at
       FROM snapshots WHERE snapshot_id = $snapshot_id`,
    ).get({ $snapshot_id: snapshotId }) as SnapshotRow | null;
    if (row === null) return null;
    const validation = validateSnapshotReference(row);
    if (!validation.success) return null;
    const filePath = this.resolveStoredPath(row.path);
    if (filePath === null) return null;
    let content: string;
    try {
      const actualPath = await realpath(filePath);
      const actualRoot = await realpath(this.canonicalSnapshotRoot);
      const actualRelative = relative(actualRoot, actualPath);
      if (actualRelative === "" || actualRelative === ".." || actualRelative.startsWith(`..${sep}`) || isAbsolute(actualRelative)) return null;
      const fileInfo = await stat(actualPath);
      if (!fileInfo.isFile() || fileInfo.size > this.config.maxSnapshotContentLength) return null;
      content = await readFile(actualPath, "utf8");
    } catch {
      return null;
    }
    if (hashContent(content) !== row.content_hash) return null;
    return { reference: validation.data, content };
  }

  async delete(snapshotId: string): Promise<void> {
    const row = this.db.query("SELECT path FROM snapshots WHERE snapshot_id = $snapshot_id").get({ $snapshot_id: snapshotId }) as { path: string } | null;
    if (row === null) return;
    const filePath = this.resolveStoredPath(row.path);
    if (filePath === null) throw new PersistenceError(ERROR_CODES.PATH_OUTSIDE_ROOT, "stored snapshot path is outside the local snapshot directory");
    try {
      await unlink(filePath);
    } catch (error) {
      const code = error as NodeJS.ErrnoException;
      if (code.code !== "ENOENT") throw error;
    }
    this.db.query("DELETE FROM snapshots WHERE snapshot_id = $snapshot_id").run({ $snapshot_id: snapshotId });
  }

  private resolveStoredPath(storedPath: string): string | null {
    if (typeof storedPath !== "string" || storedPath.length === 0 || isAbsolute(storedPath)) return null;
    const filePath = resolve(this.config.dataDir, storedPath);
    const dataRelativePath = relative(resolve(this.config.dataDir), filePath);
    const snapshotRelativePath = relative(this.snapshotRoot, filePath);
    if (
      dataRelativePath === ".." ||
      dataRelativePath.startsWith(`..${sep}`) ||
      isAbsolute(dataRelativePath) ||
      snapshotRelativePath === ".." ||
      snapshotRelativePath.startsWith(`..${sep}`) ||
      isAbsolute(snapshotRelativePath)
    ) return null;
    return filePath;
  }
}
