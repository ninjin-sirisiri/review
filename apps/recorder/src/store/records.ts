import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { Database } from "bun:sqlite";
import {
  ContractValidationError,
  ERROR_CODES,
  validateDecisionRecordInput,
  validateReviewSession,
  type AgentType,
  type DecisionRecord,
  type DecisionRecordInput,
  type RevisionRef,
  type ReviewSession,
  type UserDisposition,
  type TargetReference,
  type CheckEvidence,
  type ErrorCode,
} from "../../../../packages/contracts/src/index";
import { createRecorderConfig, type RecorderConfig, type RecorderConfigOverrides } from "../config";
import { migrateSchema } from "./schema";

export interface RepositoryInput {
  repository_id: string;
  root?: string;
  created_at?: string;
}

export interface RepositoryRecord {
  repository_id: string;
  root: string | null;
  created_at: string;
}

export class PersistenceError extends Error {
  readonly code: ErrorCode;

  constructor(code: ErrorCode, message: string) {
    super(message);
    this.name = "PersistenceError";
    this.code = code;
  }
}

type DatabaseOrPath = Database | string;
type ConfigInput = RecorderConfig | RecorderConfigOverrides;

interface DecisionRow {
  record_id: string;
  session_id: string;
  repository_id: string;
  agent_type: AgentType;
  revision_kind: RevisionRef["kind"];
  revision_value: string;
  judgment: string;
  rationale: string;
  checks_json: string;
  open_questions_json: string;
  created_at: string;
  user_disposition: UserDisposition;
}

interface TargetRow {
  repository_id: string;
  path: string;
  line_start: number;
  line_end: number;
  revision_kind: RevisionRef["kind"];
  revision_value: string;
  content_hash: string;
}

interface CheckRow {
  name: string;
  status: CheckEvidence["status"];
  details: string | null;
}

function isDatabase(value: unknown): value is Database {
  return typeof value === "object" && value !== null && "query" in value && typeof value.query === "function";
}

function now(): string {
  return new Date().toISOString();
}

function validationValue<T>(result: { success: true; data: T } | { success: false; error: { code: ErrorCode; message: string; field?: string; details?: Array<{ field?: string; message: string }> } }): T {
  if (!result.success) throw new ContractValidationError(result);
  return result.data;
}
function parseRevision(kind: RevisionRef["kind"], value: string): RevisionRef {
  if (kind === "commit") return { kind, sha: value };
  return { kind, contentHash: value };
}

function prepareDatabaseDirectory(config: RecorderConfig): void {
  mkdirSync(config.dataDir, { recursive: true, mode: 0o700 });
  mkdirSync(dirname(config.databasePath), { recursive: true, mode: 0o700 });
}

function isMemoryDatabasePath(value: string | undefined): boolean {
  return value === "" || value === ":memory:";
}
export class RecordStore {
  readonly db: Database;
  readonly config: RecorderConfig;
  private readonly ownsDatabase: boolean;

  constructor(database: Database, config?: ConfigInput);
  constructor(databasePath?: string, config?: ConfigInput);
  constructor(config?: ConfigInput);
  constructor(databaseOrConfig: DatabaseOrPath | ConfigInput = ":memory:", configInput?: ConfigInput) {
    if (isDatabase(databaseOrConfig)) {
      this.db = databaseOrConfig;
      this.config = createRecorderConfig((configInput ?? {}) as RecorderConfigOverrides);
      this.ownsDatabase = false;
    } else if (typeof databaseOrConfig === "string") {
      const databasePath = databaseOrConfig;
      this.config = isMemoryDatabasePath(databasePath)
        ? createRecorderConfig((configInput ?? {}) as RecorderConfigOverrides)
        : createRecorderConfig({ ...(configInput as RecorderConfigOverrides | undefined), databasePath });
      if (isMemoryDatabasePath(databasePath)) {
        this.db = new Database(":memory:");
      } else {
        prepareDatabaseDirectory(this.config);
        this.db = new Database(this.config.databasePath, { create: true });
      }
      this.ownsDatabase = true;
    } else {
      const options = databaseOrConfig as RecorderConfigOverrides;
      const requestedDatabasePath = options.databasePath ?? options.dbPath;
      this.config = createRecorderConfig(options);
      if (isMemoryDatabasePath(requestedDatabasePath)) {
        this.db = new Database(":memory:");
      } else {
        prepareDatabaseDirectory(this.config);
        this.db = new Database(this.config.databasePath, { create: true });
      }
      this.ownsDatabase = true;
    }
    migrateSchema(this.db);
  }

  close(): void {
    if (this.ownsDatabase) this.db.close();
  }

  async createRepository(input: RepositoryInput): Promise<RepositoryRecord> {
    if (typeof input.repository_id !== "string" || input.repository_id.trim().length === 0) {
      throw new PersistenceError(ERROR_CODES.INVALID_RECORD, "repository_id must be a non-empty string");
    }
    const createdAt = input.created_at ?? now();
    const root = input.root ?? null;
    const transaction = this.db.transaction(() => {
      this.db.query(
        `INSERT INTO repositories (repository_id, root, created_at)
         VALUES ($repository_id, $root, $created_at)
         ON CONFLICT(repository_id) DO UPDATE SET root = COALESCE(excluded.root, repositories.root)`,
      ).run({ $repository_id: input.repository_id, $root: root === null ? null : root, $created_at: createdAt });
      return this.readRepository(input.repository_id);
    });
    return Promise.resolve(transaction());
  }

  async createSession(input: ReviewSession): Promise<ReviewSession> {
    const result = validateReviewSession(input);
    const session = validationValue(result);
    const transaction = this.db.transaction(() => {
      this.ensureRepository(session.repository_id, session.started_at);
      this.db.query(
        `INSERT OR IGNORE INTO sessions
          (session_id, repository_id, agent_type, started_at, ended_at, status)
         VALUES ($session_id, $repository_id, $agent_type, $started_at, $ended_at, $status)`,
      ).run({
        $session_id: session.session_id,
        $repository_id: session.repository_id,
        $agent_type: session.agent_type,
        $started_at: session.started_at,
        $ended_at: session.ended_at ?? null,
        $status: session.status,
      });
      const stored = this.readSession(session.session_id);
      if (stored === null) throw new PersistenceError(ERROR_CODES.INVALID_RECORD, "session could not be read after insertion");
      return stored;
    });
    return Promise.resolve(transaction());
  }

  async insertDecision(input: DecisionRecordInput): Promise<DecisionRecord> {
    const result = validateDecisionRecordInput(input);
    const validated = validationValue(result);
    for (const target of validated.targets) {
      if (target.repository_id !== validated.repository_id) {
        throw new PersistenceError(ERROR_CODES.INVALID_RECORD, "target.repository_id must match repository_id");
      }
    }
    const decision: DecisionRecord = {
      ...validated,
      user_disposition: validated.user_disposition ?? "unreviewed",
    };

    const transaction = this.db.transaction(() => {
      const existing = this.readDecision(decision.record_id);
      if (existing !== null) return existing;

      const session = this.readSession(decision.session_id);
      if (session === null) {
        throw new PersistenceError(ERROR_CODES.INVALID_RECORD, `session ${decision.session_id} does not exist`);
      }
      if (session.repository_id !== decision.repository_id || session.agent_type !== decision.agent_type) {
        throw new PersistenceError(ERROR_CODES.INVALID_RECORD, "decision does not match its session");
      }
      this.db.query(
        `INSERT OR IGNORE INTO decision_records
          (record_id, session_id, repository_id, agent_type, revision_kind, revision_value,
           judgment, rationale, checks_json, open_questions_json, created_at, user_disposition)
         VALUES ($record_id, $session_id, $repository_id, $agent_type, $revision_kind, $revision_value,
           $judgment, $rationale, $checks_json, $open_questions_json, $created_at, $user_disposition)`,
      ).run({
        $record_id: decision.record_id,
        $session_id: decision.session_id,
        $repository_id: decision.repository_id,
        $agent_type: decision.agent_type,
        $revision_kind: decision.revision.kind,
        $revision_value: decision.revision.kind === "commit" ? decision.revision.sha : decision.revision.contentHash,
        $judgment: decision.judgment,
        $rationale: decision.rationale,
        $checks_json: JSON.stringify(decision.checks),
        $open_questions_json: JSON.stringify(decision.open_questions),
        $created_at: decision.created_at,
        $user_disposition: decision.user_disposition,
      });
      for (const [targetIndex, target] of decision.targets.entries()) {
        this.db.query(
          `INSERT INTO targets
            (record_id, target_index, repository_id, path, line_start, line_end,
             revision_kind, revision_value, content_hash)
           VALUES ($record_id, $target_index, $repository_id, $path, $line_start, $line_end,
             $revision_kind, $revision_value, $content_hash)`,
        ).run({
          $record_id: decision.record_id,
          $target_index: targetIndex,
          $repository_id: target.repository_id,
          $path: target.path,
          $line_start: target.line_start,
          $line_end: target.line_end,
          $revision_kind: target.revision.kind,
          $revision_value: target.revision.kind === "commit" ? target.revision.sha : target.revision.contentHash,
          $content_hash: target.content_hash,
        });
      }
      for (const [checkIndex, check] of decision.checks.entries()) {
        this.db.query(
          `INSERT INTO checks (record_id, check_index, name, status, details)
           VALUES ($record_id, $check_index, $name, $status, $details)`,
        ).run({
          $record_id: decision.record_id,
          $check_index: checkIndex,
          $name: check.name,
          $status: check.status,
          $details: check.details ?? null,
        });
      }
      return this.readDecision(decision.record_id);
    });
    const stored = transaction();
    if (stored === null) throw new PersistenceError(ERROR_CODES.INVALID_RECORD, "decision record could not be read after insertion");
    return stored;
  }

  getDecision(recordId: string): Promise<DecisionRecord | null> {
    return Promise.resolve(this.readDecision(recordId));
  }

  listDecisions(repositoryId: string): Promise<DecisionRecord[]> {
    const rows = this.db.query(
      `SELECT record_id FROM decision_records
       WHERE repository_id = $repository_id
       ORDER BY created_at ASC, decision_id ASC`,
    ).all({ $repository_id: repositoryId }) as Array<{ record_id: string }>;
    return Promise.resolve(rows.flatMap(({ record_id }) => {
      const decision = this.readDecision(record_id);
      return decision === null ? [] : [decision];
    }));
  }

  async setDisposition(recordId: string, disposition: UserDisposition): Promise<DecisionRecord> {
    if (disposition !== "unreviewed" && disposition !== "accepted" && disposition !== "rejected") {
      throw new PersistenceError(ERROR_CODES.INVALID_RECORD, "user_disposition is invalid");
    }
    const transaction = this.db.transaction(() => {
      const existing = this.readDecision(recordId);
      if (existing === null) {
        throw new PersistenceError(ERROR_CODES.INVALID_RECORD, `decision ${recordId} does not exist`);
      }
      this.db.query(
        `UPDATE decision_records SET user_disposition = $user_disposition WHERE record_id = $record_id`,
      ).run({ $user_disposition: disposition, $record_id: recordId });
      const updated = this.readDecision(recordId);
      if (updated === null) throw new PersistenceError(ERROR_CODES.INVALID_RECORD, "decision disappeared after update");
      return updated;
    });
    return Promise.resolve(transaction());
  }

  getSession(sessionId: string): Promise<ReviewSession | null> {
    return Promise.resolve(this.readSession(sessionId));
  }

  private ensureRepository(repositoryId: string, createdAt: string): void {
    this.db.query(
      `INSERT OR IGNORE INTO repositories (repository_id, root, created_at)
       VALUES ($repository_id, NULL, $created_at)`,
    ).run({ $repository_id: repositoryId, $created_at: createdAt });
  }

  private readRepository(repositoryId: string): RepositoryRecord {
    const row = this.db.query(
      "SELECT repository_id, root, created_at FROM repositories WHERE repository_id = $repository_id",
    ).get({ $repository_id: repositoryId }) as RepositoryRecord | null;
    if (row === null) throw new PersistenceError(ERROR_CODES.INVALID_RECORD, `repository ${repositoryId} does not exist`);
    return row;
  }

  private readSession(sessionId: string): ReviewSession | null {
    const row = this.db.query(
      `SELECT session_id, repository_id, agent_type, started_at, ended_at, status
       FROM sessions WHERE session_id = $session_id`,
    ).get({ $session_id: sessionId }) as (ReviewSession & { ended_at: string | null }) | null;
    if (row === null) return null;
    return {
      session_id: row.session_id,
      repository_id: row.repository_id,
      agent_type: row.agent_type,
      started_at: row.started_at,
      ...(row.ended_at === null ? {} : { ended_at: row.ended_at }),
      status: row.status,
    };
  }

  private readDecision(recordId: string): DecisionRecord | null {
    const row = this.db.query(
      `SELECT record_id, session_id, repository_id, agent_type, revision_kind, revision_value,
              judgment, rationale, checks_json, open_questions_json, created_at, user_disposition
       FROM decision_records WHERE record_id = $record_id`,
    ).get({ $record_id: recordId }) as DecisionRow | null;
    if (row === null) return null;

    let checks: CheckEvidence[];
    let openQuestions: string[];
    try {
      checks = JSON.parse(row.checks_json) as CheckEvidence[];
      openQuestions = JSON.parse(row.open_questions_json) as string[];
    } catch (error) {
      throw new PersistenceError(ERROR_CODES.INVALID_RECORD, `stored decision ${recordId} contains invalid JSON: ${String(error)}`);
    }
    const targetRows = this.db.query(
      `SELECT repository_id, path, line_start, line_end, revision_kind, revision_value, content_hash
       FROM targets WHERE record_id = $record_id ORDER BY target_index ASC`,
    ).all({ $record_id: recordId }) as TargetRow[];
    const targets: TargetReference[] = targetRows.map((target) => ({
      repository_id: target.repository_id,
      path: target.path,
      line_start: target.line_start,
      line_end: target.line_end,
      revision: parseRevision(target.revision_kind, target.revision_value),
      content_hash: target.content_hash,
    }));
    const decision: DecisionRecord = {
      record_id: row.record_id,
      session_id: row.session_id,
      repository_id: row.repository_id,
      agent_type: row.agent_type,
      revision: parseRevision(row.revision_kind, row.revision_value),
      targets,
      judgment: row.judgment,
      rationale: row.rationale,
      checks,
      open_questions: openQuestions,
      created_at: row.created_at,
      user_disposition: row.user_disposition,
    };
    return validationValue(validateDecisionRecordInput(decision)) as DecisionRecord;
  }
}
