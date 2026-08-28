import { Database } from "bun:sqlite";
import { createHash } from "node:crypto";
import { constants as fsConstants } from "node:fs";
import { existsSync, mkdirSync, realpathSync } from "node:fs";
import { dirname, isAbsolute, relative, resolve, sep } from "node:path";
import {
  ERROR_CODES,
  validateSnapshotReference,
  type SnapshotCaptureKind,
  type SnapshotMode,
  type SnapshotReference,
} from "../../../../packages/contracts/src/index";
import { createRecorderConfig, type RecorderConfig, type RecorderConfigOverrides } from "../config";
import { migrateSchema } from "./schema";
import type { RecordStore } from "./records";
import { PersistenceError } from "./records";
import {
  closeOpenedFile,
  closeParentPath,
  closeFd,
  openDirectory,
  openDirectoryAt,
  openDirectoryPath,
  openFilePath,
  openParentPath,
  readOpenedFile,
  renameAt,
  unlinkAt,
  writeFileAt,
  type OpenedSecureFile,
  type OpenedSecureParent,
} from "./secure-files";

interface SnapshotRow {
  snapshot_id: string;
  record_id: string;
  mode: string;
  path: string;
  content_hash: string;
  created_at: string;
  base_sha: string | null;
  source_path: string | null;
  capture_kind: SnapshotCaptureKind;
  before_missing: number;
  capture_sequence: number | null;
  capture_id: string | null;
}

function referenceFromRow(row: SnapshotRow): SnapshotReference {
  return {
    snapshot_id: row.snapshot_id,
    record_id: row.record_id,
    mode: row.mode as SnapshotReference["mode"],
    path: row.path,
    content_hash: row.content_hash,
    created_at: row.created_at,
    ...(row.base_sha === null || row.source_path === null ? {} : { base_sha: row.base_sha, source_path: row.source_path }),
    ...(row.capture_kind === "automatic"
      ? { source_path: row.source_path ?? "", capture_kind: "automatic", before_missing: row.before_missing === 1 }
      : {}),
  };
}

export interface AutomaticSnapshotInput {
  recordId: string;
  captureId: string;
  sourcePath: string;
  content: string;
  beforeMissing: boolean;
}

export interface AutomaticGitSnapshotInput {
  recordId: string;
  captureId: string;
  sourcePath: string;
  baseSha: string;
  contentHash: string;
}

export interface AutomaticSnapshotLookup {
  recordId: string;
  captureId: string;
  sourcePath: string;
  contentHash: string;
  beforeMissing: boolean;
}

export interface AutomaticSnapshotMetadata {
  reference: SnapshotReference;
  beforeMissing: boolean;
  captureSequence: number;
}

interface AutomaticSnapshotIdentity {
  recordId: string;
  sourcePath: string;
  contentHash: string;
  beforeMissing: boolean;
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
  private readonly dataDirFd: number;
  private readonly snapshotRootRelative: string;
  private snapshotRootFd: number | null = null;
  private closed = false;
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
    try {
      this.dataDirFd = openDirectory(ownerRoot);
    } catch {
      throw new PersistenceError(ERROR_CODES.PATH_OUTSIDE_ROOT, "dataDir cannot be opened as an owner-local directory");
    }
    this.snapshotRootRelative = relative(resolve(this.config.dataDir), configuredRoot).split(sep).join("/");
  }

  close(): void {
    if (this.closed) return;
    this.closed = true;
    if (this.snapshotRootFd !== null && this.snapshotRootFd !== this.dataDirFd) closeFd(this.snapshotRootFd);
    closeFd(this.dataDirFd);
  }

  async create(recordId: string, mode: SnapshotMode, content: string): Promise<SnapshotReference> {
    if (typeof recordId !== "string" || recordId.trim().length === 0) {
      throw new PersistenceError(ERROR_CODES.INVALID_RECORD, "recordId must be a non-empty string");
    }
    if (!snapshotMode(mode)) {
      throw new PersistenceError(ERROR_CODES.INVALID_RECORD, "snapshot mode must be changed-files or patch");
    }
    if (mode === "git") throw new PersistenceError(ERROR_CODES.INVALID_RECORD, "use createGitBacked for git-backed snapshots");
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
    const ownerName = encodeURIComponent(recordId);
    const fileName = `${snapshotId}.snapshot`;
    const path = this.storagePath(ownerName, fileName);
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

    let ownerFd: number | undefined;
    try {
      ownerFd = this.openOwnerDirectory(recordId);
      this.writeSnapshotFile(ownerFd, fileName, content);
      const transaction = this.db.transaction(() => {
        this.db.query(
          `INSERT INTO snapshots (snapshot_id, record_id, mode, path, content_hash, created_at, capture_kind)
           VALUES ($snapshot_id, $record_id, $mode, $path, $content_hash, $created_at, 'manual')`,
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
      if (ownerFd !== undefined) this.removeFile(ownerFd, fileName);
      if (error instanceof PersistenceError) throw error;
      throw error;
    } finally {
      if (ownerFd !== undefined) closeFd(ownerFd);
    }
  }

  async createGitBacked(recordId: string, baseSha: string, sourcePath: string, contentHash: string): Promise<SnapshotReference> {
    if (typeof recordId !== "string" || recordId.trim().length === 0) {
      throw new PersistenceError(ERROR_CODES.INVALID_RECORD, "recordId must be a non-empty string");
    }
    const decision = this.db.query("SELECT 1 AS present FROM decision_records WHERE record_id = $record_id").get({ $record_id: recordId }) as { present: number } | null;
    if (decision === null) {
      throw new PersistenceError(ERROR_CODES.INVALID_RECORD, `decision ${recordId} does not exist`);
    }
    const reference: SnapshotReference = {
      snapshot_id: crypto.randomUUID(),
      record_id: recordId,
      mode: "git",
      path: "",
      content_hash: contentHash,
      created_at: now(),
      base_sha: baseSha,
      source_path: sourcePath,
    };
    const validation = validateSnapshotReference(reference);
    if (!validation.success) {
      throw new PersistenceError(validation.error.code, validation.error.message);
    }
    this.db.transaction(() => {
      this.db.query(
        `INSERT INTO snapshots (snapshot_id, record_id, mode, path, content_hash, created_at, base_sha, source_path, capture_kind)
         VALUES ($snapshot_id, $record_id, $mode, $path, $content_hash, $created_at, $base_sha, $source_path, 'manual')`,
      ).run({
        $snapshot_id: reference.snapshot_id,
        $record_id: reference.record_id,
        $mode: reference.mode,
        $path: "",
        $content_hash: reference.content_hash,
        $created_at: reference.created_at,
        $base_sha: reference.base_sha ?? null,
        $source_path: reference.source_path ?? null,
      });
    })();
    return validation.data;
  }

  async createAutomatic(input: AutomaticSnapshotInput): Promise<SnapshotReference> {
    this.ensureNonEmpty(input.recordId, "recordId");
    this.ensureNonEmpty(input.captureId, "captureId");
    this.ensureRecord(input.recordId);
    if (typeof input.content !== "string") {
      throw new PersistenceError(ERROR_CODES.INVALID_RECORD, "snapshot content must be a string");
    }
    if (typeof input.beforeMissing !== "boolean") {
      throw new PersistenceError(ERROR_CODES.INVALID_RECORD, "beforeMissing must be a boolean");
    }
    if (input.beforeMissing && input.content.length > 0) {
      throw new PersistenceError(ERROR_CODES.INVALID_RECORD, "beforeMissing snapshots must have empty content");
    }
    if (contentByteLength(input.content) > this.config.maxSnapshotContentLength) {
      throw new PersistenceError(ERROR_CODES.PAYLOAD_TOO_LARGE, "snapshot content exceeds the configured maximum length");
    }

    const snapshotId = crypto.randomUUID();
    const ownerName = encodeURIComponent(input.recordId);
    const fileName = `${snapshotId}.snapshot`;
    const path = this.storagePath(ownerName, fileName);
    const candidateValidation = validateSnapshotReference({
      snapshot_id: snapshotId,
      record_id: input.recordId,
      mode: "changed-files",
      path,
      content_hash: hashContent(input.content),
      created_at: now(),
      source_path: input.sourcePath,
      capture_kind: "automatic",
      before_missing: input.beforeMissing,
    });
    if (!candidateValidation.success) {
      throw new PersistenceError(candidateValidation.error.code, candidateValidation.error.message);
    }
    const reference = candidateValidation.data;
    const identity: AutomaticSnapshotIdentity = {
      recordId: input.recordId,
      sourcePath: reference.source_path as string,
      contentHash: reference.content_hash,
      beforeMissing: input.beforeMissing,
    };
    const existing = this.readSnapshotByCaptureId(input.captureId);
    if (existing !== null) return this.referenceForMatchingCapture(existing, identity, input.captureId);

    let ownerFd: number | undefined;
    try {
      ownerFd = this.openOwnerDirectory(input.recordId);
      this.writeSnapshotFile(ownerFd, fileName, input.content);
      const result = this.insertAutomaticRow(reference, input.captureId, identity);
      if (result.reused) this.removeFile(ownerFd, fileName);
      return result.reference;
    } catch (error) {
      if (ownerFd !== undefined) this.removeFile(ownerFd, fileName);
      if (error instanceof PersistenceError) throw error;
      const existingAfterRace = this.readSnapshotByCaptureId(input.captureId);
      if (existingAfterRace !== null) return this.referenceForMatchingCapture(existingAfterRace, identity, input.captureId);
      throw error;
    } finally {
      if (ownerFd !== undefined) closeFd(ownerFd);
    }
  }

  async createAutomaticGitBacked(input: AutomaticGitSnapshotInput): Promise<SnapshotReference> {
    this.ensureNonEmpty(input.recordId, "recordId");
    this.ensureNonEmpty(input.captureId, "captureId");
    this.ensureRecord(input.recordId);

    const snapshotId = crypto.randomUUID();
    const candidateValidation = validateSnapshotReference({
      snapshot_id: snapshotId,
      record_id: input.recordId,
      mode: "git",
      path: "",
      content_hash: input.contentHash,
      created_at: now(),
      base_sha: input.baseSha,
      source_path: input.sourcePath,
      capture_kind: "automatic",
      before_missing: false,
    });
    if (!candidateValidation.success) {
      throw new PersistenceError(candidateValidation.error.code, candidateValidation.error.message);
    }
    const reference = candidateValidation.data;
    const identity: AutomaticSnapshotIdentity = {
      recordId: input.recordId,
      sourcePath: reference.source_path as string,
      contentHash: reference.content_hash,
      beforeMissing: false,
    };
    const existing = this.readSnapshotByCaptureId(input.captureId);
    if (existing !== null) return this.referenceForMatchingCapture(existing, identity, input.captureId);

    try {
      return this.insertAutomaticRow(reference, input.captureId, identity).reference;
    } catch (error) {
      if (error instanceof PersistenceError) throw error;
      const existingAfterRace = this.readSnapshotByCaptureId(input.captureId);
      if (existingAfterRace !== null) return this.referenceForMatchingCapture(existingAfterRace, identity, input.captureId);
      throw error;
    }
  }

  async getAutomaticByCaptureId(input: AutomaticSnapshotLookup): Promise<SnapshotReference | null> {
    this.ensureNonEmpty(input.recordId, "recordId");
    this.ensureNonEmpty(input.captureId, "captureId");
    this.ensureNonEmpty(input.sourcePath, "sourcePath");
    this.ensureNonEmpty(input.contentHash, "contentHash");
    if (typeof input.beforeMissing !== "boolean") {
      throw new PersistenceError(ERROR_CODES.INVALID_RECORD, "beforeMissing must be a boolean");
    }

    const existing = this.readSnapshotByCaptureId(input.captureId);
    if (existing === null) return null;
    const validation = validateSnapshotReference(referenceFromRow(existing));
    const identity: AutomaticSnapshotIdentity = {
      recordId: input.recordId,
      sourcePath: input.sourcePath,
      contentHash: input.contentHash,
      beforeMissing: input.beforeMissing,
    };
    if (!validation.success || !this.matchesAutomaticIdentity(validation.data, identity)) {
      throw new PersistenceError(ERROR_CODES.INVALID_RECORD, `capture ${input.captureId} conflicts with an existing snapshot`);
    }
    return validation.data;
  }

  async getAutomaticForRecord(recordId: string, sourcePath: string): Promise<AutomaticSnapshotMetadata | null> {
    const row = this.db.query(
      `SELECT snapshot_id, record_id, mode, path, content_hash, created_at,
              base_sha, source_path, capture_kind, before_missing, capture_sequence, capture_id
       FROM snapshots
       WHERE record_id = $record_id
         AND source_path = $source_path
         AND capture_kind = 'automatic'
       ORDER BY capture_sequence ASC
       LIMIT 1`,
    ).get({ $record_id: recordId, $source_path: sourcePath }) as SnapshotRow | null;
    return row === null ? null : this.automaticMetadataFromRow(row);
  }

  async getNextAutomatic(repositoryId: string, sourcePath: string, afterSequence: number): Promise<AutomaticSnapshotMetadata | null> {
    const row = this.db.query(
      `SELECT s.snapshot_id, s.record_id, s.mode, s.path, s.content_hash, s.created_at,
              s.base_sha, s.source_path, s.capture_kind, s.before_missing, s.capture_sequence, s.capture_id
       FROM snapshots AS s
       JOIN decision_records AS d ON d.record_id = s.record_id
       WHERE d.repository_id = $repository_id
         AND s.source_path = $source_path
         AND s.capture_kind = 'automatic'
         AND s.capture_sequence > $after_sequence
       ORDER BY s.capture_sequence ASC
       LIMIT 1`,
    ).get({ $repository_id: repositoryId, $source_path: sourcePath, $after_sequence: afterSequence }) as SnapshotRow | null;
    return row === null ? null : this.automaticMetadataFromRow(row);
  }

  async getReference(snapshotId: string): Promise<SnapshotReference | null> {
    const row = this.db.query(
      `SELECT snapshot_id, record_id, mode, path, content_hash, created_at,
              base_sha, source_path, capture_kind, before_missing, capture_sequence, capture_id
       FROM snapshots WHERE snapshot_id = $snapshot_id`,
    ).get({ $snapshot_id: snapshotId }) as SnapshotRow | null;
    if (row === null) return null;
    const validation = validateSnapshotReference(referenceFromRow(row));
    return validation.success ? validation.data : null;
  }

  async get(snapshotId: string): Promise<{ reference: SnapshotReference; content: string } | null> {
    const reference = await this.getReference(snapshotId);
    if (reference === null) return null;
    if (reference.mode === "git") return null; // git-backed rows have no stored file
    if (this.resolveStoredPath(reference.path) === null) return null;
    let opened: OpenedSecureFile | undefined;
    try {
      opened = openFilePath(this.dataDirFd, reference.path, fsConstants.O_RDONLY);
      const loaded = readOpenedFile(opened, this.config.maxSnapshotContentLength);
      if (loaded === null) return null;
      if (hashContent(loaded.content) !== reference.content_hash) return null;
      return { reference, content: loaded.content };
    } catch {
      return null;
    } finally {
      if (opened !== undefined) closeOpenedFile(opened);
    }
  }

  async delete(snapshotId: string): Promise<void> {
    const reference = await this.getReference(snapshotId);
    if (reference === null) return;
    if (reference.mode !== "git") {
      if (this.resolveStoredPath(reference.path) === null) throw new PersistenceError(ERROR_CODES.PATH_OUTSIDE_ROOT, "stored snapshot path is outside the local snapshot directory");
      let parent: OpenedSecureParent | undefined;
      try {
        parent = openParentPath(this.dataDirFd, reference.path);
        try {
          unlinkAt(parent.parentFd, parent.name);
        } catch (error) {
          if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
        }
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "ENOENT") {
          throw new PersistenceError(ERROR_CODES.PATH_OUTSIDE_ROOT, "stored snapshot path cannot be safely accessed");
        }
      } finally {
        if (parent !== undefined) closeParentPath(parent);
      }
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

  private storagePath(ownerName: string, fileName: string): string {
    return [this.snapshotRootRelative, ownerName, fileName].filter((part) => part.length > 0).join("/");
  }

  private openOwnerDirectory(recordId: string): number {
    try {
      const snapshotRootFd = this.openSnapshotRoot(true);
      return openDirectoryAt(snapshotRootFd, encodeURIComponent(recordId), true);
    } catch {
      throw new PersistenceError(ERROR_CODES.PATH_OUTSIDE_ROOT, "snapshot path cannot be opened inside the local snapshot directory");
    }
  }

  private openSnapshotRoot(create: boolean): number {
    if (this.snapshotRootFd !== null) return this.snapshotRootFd;
    try {
      const opened = openDirectoryPath(this.dataDirFd, this.snapshotRootRelative, create);
      this.snapshotRootFd = opened;
      return opened;
    } catch {
      throw new PersistenceError(ERROR_CODES.PATH_OUTSIDE_ROOT, "snapshot directory cannot be opened inside dataDir");
    }
  }

  private removeFile(ownerFd: number, fileName: string): void {
    try {
      unlinkAt(ownerFd, fileName);
    } catch {
      // Cleanup must not replace the original persistence error.
    }
  }

  private ensureNonEmpty(value: unknown, field: string): asserts value is string {
    if (typeof value !== "string" || value.trim().length === 0) {
      throw new PersistenceError(ERROR_CODES.INVALID_RECORD, `${field} must be a non-empty string`);
    }
  }

  private ensureRecord(recordId: string): void {
    const decision = this.db.query("SELECT 1 AS present FROM decision_records WHERE record_id = $record_id").get({ $record_id: recordId }) as { present: number } | null;
    if (decision === null) {
      throw new PersistenceError(ERROR_CODES.INVALID_RECORD, `decision ${recordId} does not exist`);
    }
  }

  private readSnapshotByCaptureId(captureId: string): SnapshotRow | null {
    return this.db.query(
      `SELECT snapshot_id, record_id, mode, path, content_hash, created_at,
              base_sha, source_path, capture_kind, before_missing, capture_sequence, capture_id
       FROM snapshots WHERE capture_id = $capture_id`,
    ).get({ $capture_id: captureId }) as SnapshotRow | null;
  }

  private referenceForMatchingCapture(row: SnapshotRow, identity: AutomaticSnapshotIdentity, captureId: string): SnapshotReference {
    const validation = validateSnapshotReference(referenceFromRow(row));
    if (!validation.success || !this.matchesAutomaticIdentity(validation.data, identity)) {
      throw new PersistenceError(ERROR_CODES.INVALID_RECORD, `capture ${captureId} conflicts with an existing snapshot`);
    }
    return validation.data;
  }

  private matchesAutomaticIdentity(reference: SnapshotReference, identity: AutomaticSnapshotIdentity): boolean {
    return reference.capture_kind === "automatic"
      && reference.record_id === identity.recordId
      && reference.source_path === identity.sourcePath
      && reference.content_hash === identity.contentHash
      && reference.before_missing === identity.beforeMissing;
  }

  private nextCaptureSequence(): number {
    const row = this.db.query(
      `SELECT COALESCE(MAX(capture_sequence), 0) + 1 AS next_sequence
       FROM snapshots
       WHERE capture_sequence IS NOT NULL`,
    ).get() as { next_sequence: number };
    return row.next_sequence;
  }

  private insertAutomaticRow(
    reference: SnapshotReference,
    captureId: string,
    identity: AutomaticSnapshotIdentity,
  ): { reference: SnapshotReference; reused: boolean } {
    const transaction = this.db.transaction(() => {
      const existing = this.readSnapshotByCaptureId(captureId);
      if (existing !== null) {
        return { reference: this.referenceForMatchingCapture(existing, identity, captureId), reused: true };
      }
      const captureSequence = this.nextCaptureSequence();
      this.db.query(
        `INSERT INTO snapshots (
           snapshot_id, record_id, mode, path, content_hash, created_at,
           base_sha, source_path, capture_kind, before_missing, capture_sequence, capture_id
         ) VALUES (
           $snapshot_id, $record_id, $mode, $path, $content_hash, $created_at,
           $base_sha, $source_path, 'automatic', $before_missing, $capture_sequence, $capture_id
         )`,
      ).run({
        $snapshot_id: reference.snapshot_id,
        $record_id: reference.record_id,
        $mode: reference.mode,
        $path: reference.path,
        $content_hash: reference.content_hash,
        $created_at: reference.created_at,
        $base_sha: reference.base_sha ?? null,
        $source_path: reference.source_path ?? null,
        $before_missing: reference.before_missing ? 1 : 0,
        $capture_sequence: captureSequence,
        $capture_id: captureId,
      });
      return { reference, reused: false };
    });
    return transaction();
  }

  private writeSnapshotFile(ownerFd: number, fileName: string, content: string): void {
    const temporaryName = `${fileName}.${crypto.randomUUID()}.tmp`;
    try {
      writeFileAt(ownerFd, temporaryName, content);
      renameAt(ownerFd, temporaryName, fileName);
    } catch (error) {
      this.removeFile(ownerFd, temporaryName);
      throw error;
    }
  }

  private automaticMetadataFromRow(row: SnapshotRow): AutomaticSnapshotMetadata {
    const validation = validateSnapshotReference(referenceFromRow(row));
    const beforeMissing = validation.success ? validation.data.before_missing : undefined;
    if (
      !validation.success
      || validation.data.capture_kind !== "automatic"
      || typeof beforeMissing !== "boolean"
      || typeof row.capture_sequence !== "number"
      || !Number.isSafeInteger(row.capture_sequence)
    ) {
      throw new PersistenceError(ERROR_CODES.SOURCE_UNAVAILABLE, "automatic snapshot reference is unavailable");
    }
    return {
      reference: validation.data,
      beforeMissing,
      captureSequence: row.capture_sequence,
    };
  }
}
