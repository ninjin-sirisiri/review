import { Database } from "bun:sqlite";

export const SCHEMA_VERSION = 5;

interface Migration {
  readonly sql: string;
  /**
   * Set when a migration rebuilds tables that participate in foreign keys;
   * referential checks are suspended for the duration of the migration only.
   */
  readonly withoutForeignKeys?: boolean;
}

const AGENT_CHECK = "agent_type TEXT NOT NULL CHECK (agent_type IN ('claude-code', 'codex', 'opencode', 'cursor'))";

const MIGRATIONS: readonly Migration[] = [
  {
    sql: `
    CREATE TABLE IF NOT EXISTS repositories (
      repository_id TEXT PRIMARY KEY,
      root TEXT,
      created_at TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS sessions (
      session_id TEXT PRIMARY KEY,
      repository_id TEXT NOT NULL REFERENCES repositories(repository_id) ON DELETE CASCADE,
      ${AGENT_CHECK},
      started_at TEXT NOT NULL,
      ended_at TEXT,
      status TEXT NOT NULL CHECK (status IN ('active', 'completed', 'failed'))
    );

    CREATE TABLE IF NOT EXISTS decision_records (
      decision_id INTEGER PRIMARY KEY AUTOINCREMENT,
      record_id TEXT NOT NULL UNIQUE,
      session_id TEXT NOT NULL REFERENCES sessions(session_id) ON DELETE CASCADE,
      repository_id TEXT NOT NULL REFERENCES repositories(repository_id) ON DELETE CASCADE,
      ${AGENT_CHECK},
      revision_kind TEXT NOT NULL CHECK (revision_kind IN ('commit', 'working-tree')),
      revision_value TEXT NOT NULL,
      judgment TEXT NOT NULL,
      rationale TEXT NOT NULL,
      checks_json TEXT NOT NULL,
      open_questions_json TEXT NOT NULL,
      created_at TEXT NOT NULL,
      user_disposition TEXT NOT NULL CHECK (user_disposition IN ('unreviewed', 'accepted', 'rejected'))
    );

    CREATE TABLE IF NOT EXISTS targets (
      target_id INTEGER PRIMARY KEY AUTOINCREMENT,
      record_id TEXT NOT NULL REFERENCES decision_records(record_id) ON DELETE CASCADE,
      target_index INTEGER NOT NULL,
      repository_id TEXT NOT NULL,
      path TEXT NOT NULL,
      line_start INTEGER NOT NULL CHECK (line_start >= 1),
      line_end INTEGER NOT NULL CHECK (line_end >= line_start),
      revision_kind TEXT NOT NULL CHECK (revision_kind IN ('commit', 'working-tree')),
      revision_value TEXT NOT NULL,
      content_hash TEXT NOT NULL,
      UNIQUE (record_id, target_index)
    );

    CREATE TABLE IF NOT EXISTS checks (
      check_id INTEGER PRIMARY KEY AUTOINCREMENT,
      record_id TEXT NOT NULL REFERENCES decision_records(record_id) ON DELETE CASCADE,
      check_index INTEGER NOT NULL,
      name TEXT NOT NULL,
      status TEXT NOT NULL CHECK (status IN ('passed', 'failed', 'not-run')),
      details TEXT,
      UNIQUE (record_id, check_index)
    );

    CREATE TABLE IF NOT EXISTS snapshots (
      snapshot_id TEXT PRIMARY KEY,
      record_id TEXT NOT NULL REFERENCES decision_records(record_id) ON DELETE CASCADE,
      mode TEXT NOT NULL CHECK (mode IN ('changed-files', 'patch')),
      path TEXT NOT NULL UNIQUE,
      content_hash TEXT NOT NULL,
      created_at TEXT NOT NULL
    );
  `,
  },
  {
    // Rebuild the two tables carrying an agent_type CHECK constraint so databases
    // created before opencode support accept the new value (SQLite cannot alter
    // a CHECK constraint in place).
    withoutForeignKeys: true,
    sql: `
      CREATE TABLE sessions_rebuilt (
        session_id TEXT PRIMARY KEY,
        repository_id TEXT NOT NULL REFERENCES repositories(repository_id) ON DELETE CASCADE,
        ${AGENT_CHECK},
        started_at TEXT NOT NULL,
        ended_at TEXT,
        status TEXT NOT NULL CHECK (status IN ('active', 'completed', 'failed'))
      );
      INSERT INTO sessions_rebuilt (session_id, repository_id, agent_type, started_at, ended_at, status)
        SELECT session_id, repository_id, agent_type, started_at, ended_at, status FROM sessions;
      DROP TABLE sessions;
      ALTER TABLE sessions_rebuilt RENAME TO sessions;

      CREATE TABLE decision_records_rebuilt (
        decision_id INTEGER PRIMARY KEY AUTOINCREMENT,
        record_id TEXT NOT NULL UNIQUE,
        session_id TEXT NOT NULL REFERENCES sessions(session_id) ON DELETE CASCADE,
        repository_id TEXT NOT NULL REFERENCES repositories(repository_id) ON DELETE CASCADE,
        ${AGENT_CHECK},
        revision_kind TEXT NOT NULL CHECK (revision_kind IN ('commit', 'working-tree')),
        revision_value TEXT NOT NULL,
        judgment TEXT NOT NULL,
        rationale TEXT NOT NULL,
        checks_json TEXT NOT NULL,
        open_questions_json TEXT NOT NULL,
        created_at TEXT NOT NULL,
        user_disposition TEXT NOT NULL CHECK (user_disposition IN ('unreviewed', 'accepted', 'rejected'))
      );
      INSERT INTO decision_records_rebuilt (
        decision_id, record_id, session_id, repository_id, agent_type, revision_kind,
        revision_value, judgment, rationale, checks_json, open_questions_json, created_at, user_disposition
      )
        SELECT
          decision_id, record_id, session_id, repository_id, agent_type, revision_kind,
          revision_value, judgment, rationale, checks_json, open_questions_json, created_at, user_disposition
        FROM decision_records;
      DROP TABLE decision_records;
      ALTER TABLE decision_records_rebuilt RENAME TO decision_records;

      PRAGMA foreign_key_check;
    `,
  },
  {
    // Rebuild snapshots: allow mode='git' rows carrying base_sha/source_path instead of a
    // stored file; UNIQUE(path) becomes a partial index so git rows can share ''.
    withoutForeignKeys: true,
    sql: `
      CREATE TABLE snapshots_rebuilt (
        snapshot_id TEXT PRIMARY KEY,
        record_id TEXT NOT NULL REFERENCES decision_records(record_id) ON DELETE CASCADE,
        mode TEXT NOT NULL CHECK (mode IN ('changed-files', 'patch', 'git')),
        path TEXT NOT NULL,
        content_hash TEXT NOT NULL,
        created_at TEXT NOT NULL,
        base_sha TEXT,
        source_path TEXT,
        CHECK (mode = 'git' OR (base_sha IS NULL AND source_path IS NULL)),
        CHECK (mode <> 'git' OR (base_sha IS NOT NULL AND source_path IS NOT NULL AND path = '')),
        CHECK (base_sha IS NULL OR (length(base_sha) = 40 AND base_sha NOT GLOB '*[^0-9a-f]*'))
      );
      INSERT INTO snapshots_rebuilt (snapshot_id, record_id, mode, path, content_hash, created_at, base_sha, source_path)
        SELECT snapshot_id, record_id, mode, path, content_hash, created_at, NULL, NULL FROM snapshots;
      DROP TABLE snapshots;
      ALTER TABLE snapshots_rebuilt RENAME TO snapshots;
      CREATE UNIQUE INDEX snapshots_storage_path_unique ON snapshots(path) WHERE path <> '';
      PRAGMA foreign_key_check;
    `,
  },
  {
    // Rebuild snapshots to add automatic capture metadata and uniqueness constraints.
    withoutForeignKeys: true,
    sql: `
      CREATE TABLE snapshots_rebuilt (
        snapshot_id TEXT PRIMARY KEY,
        record_id TEXT NOT NULL REFERENCES decision_records(record_id) ON DELETE CASCADE,
        mode TEXT NOT NULL CHECK (mode IN ('changed-files', 'patch', 'git')),
        path TEXT NOT NULL,
        content_hash TEXT NOT NULL,
        created_at TEXT NOT NULL,
        base_sha TEXT,
        source_path TEXT,
        capture_kind TEXT NOT NULL DEFAULT 'manual'
          CHECK (capture_kind IN ('manual', 'automatic')),
        before_missing INTEGER NOT NULL DEFAULT 0
          CHECK (before_missing IN (0, 1)),
        capture_sequence INTEGER,
        capture_id TEXT,
        CHECK (mode = 'git' OR (base_sha IS NULL AND (capture_kind = 'automatic' OR source_path IS NULL))),
        CHECK (mode <> 'git' OR (base_sha IS NOT NULL AND source_path IS NOT NULL AND path = '')),
        CHECK (base_sha IS NULL OR (length(base_sha) = 40 AND base_sha NOT GLOB '*[^0-9a-f]*')),
        CHECK (
          capture_kind <> 'automatic'
          OR (source_path IS NOT NULL AND capture_sequence IS NOT NULL AND capture_id IS NOT NULL)
        ),
        CHECK (
          capture_kind <> 'automatic'
          OR before_missing = 0
          OR content_hash = 'e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855'
        )
      );
      INSERT INTO snapshots_rebuilt (
        snapshot_id, record_id, mode, path, content_hash, created_at,
        base_sha, source_path, capture_kind, before_missing, capture_sequence, capture_id
      )
        SELECT
          snapshot_id, record_id, mode, path, content_hash, created_at,
          base_sha, source_path, 'manual', 0, NULL, NULL
        FROM snapshots;
      DROP TABLE snapshots;
      ALTER TABLE snapshots_rebuilt RENAME TO snapshots;
      CREATE UNIQUE INDEX snapshots_storage_path_unique ON snapshots(path) WHERE path <> '';
      CREATE UNIQUE INDEX snapshots_capture_id_unique ON snapshots(capture_id) WHERE capture_id IS NOT NULL;
      CREATE UNIQUE INDEX snapshots_capture_sequence_unique ON snapshots(capture_sequence) WHERE capture_sequence IS NOT NULL;
      PRAGMA foreign_key_check;
    `,
  },
  {
    // Rebuild the two tables carrying an agent_type CHECK constraint so databases
    // created before cursor support accept the new value (SQLite cannot alter
    // a CHECK constraint in place).
    withoutForeignKeys: true,
    sql: `
      CREATE TABLE sessions_rebuilt (
        session_id TEXT PRIMARY KEY,
        repository_id TEXT NOT NULL REFERENCES repositories(repository_id) ON DELETE CASCADE,
        ${AGENT_CHECK},
        started_at TEXT NOT NULL,
        ended_at TEXT,
        status TEXT NOT NULL CHECK (status IN ('active', 'completed', 'failed'))
      );
      INSERT INTO sessions_rebuilt (session_id, repository_id, agent_type, started_at, ended_at, status)
        SELECT session_id, repository_id, agent_type, started_at, ended_at, status FROM sessions;
      DROP TABLE sessions;
      ALTER TABLE sessions_rebuilt RENAME TO sessions;

      CREATE TABLE decision_records_rebuilt (
        decision_id INTEGER PRIMARY KEY AUTOINCREMENT,
        record_id TEXT NOT NULL UNIQUE,
        session_id TEXT NOT NULL REFERENCES sessions(session_id) ON DELETE CASCADE,
        repository_id TEXT NOT NULL REFERENCES repositories(repository_id) ON DELETE CASCADE,
        ${AGENT_CHECK},
        revision_kind TEXT NOT NULL CHECK (revision_kind IN ('commit', 'working-tree')),
        revision_value TEXT NOT NULL,
        judgment TEXT NOT NULL,
        rationale TEXT NOT NULL,
        checks_json TEXT NOT NULL,
        open_questions_json TEXT NOT NULL,
        created_at TEXT NOT NULL,
        user_disposition TEXT NOT NULL CHECK (user_disposition IN ('unreviewed', 'accepted', 'rejected'))
      );
      INSERT INTO decision_records_rebuilt (
        decision_id, record_id, session_id, repository_id, agent_type, revision_kind,
        revision_value, judgment, rationale, checks_json, open_questions_json, created_at, user_disposition
      )
        SELECT
          decision_id, record_id, session_id, repository_id, agent_type, revision_kind,
          revision_value, judgment, rationale, checks_json, open_questions_json, created_at, user_disposition
        FROM decision_records;
      DROP TABLE decision_records;
      ALTER TABLE decision_records_rebuilt RENAME TO decision_records;

      PRAGMA foreign_key_check;
    `,
  },
];

export function migrateSchema(db: Database): void {
  db.exec("PRAGMA foreign_keys = ON;");
  db.exec("CREATE TABLE IF NOT EXISTS schema_migrations (version INTEGER PRIMARY KEY NOT NULL);");
  const row = db.query("SELECT COALESCE(MAX(version), 0) AS version FROM schema_migrations").get() as { version: number };
  let version = row.version;
  while (version < MIGRATIONS.length) {
    const nextVersion = version + 1;
    const migration = MIGRATIONS[nextVersion - 1] as Migration;
    const apply = (): void => {
      db.exec(migration.sql);
      db.query("INSERT INTO schema_migrations (version) VALUES ($version)").run({ $version: nextVersion });
    };
    if (migration.withoutForeignKeys === true) {
      // PRAGMA foreign_keys is a no-op inside a transaction, so it is toggled around it.
      db.exec("PRAGMA foreign_keys = OFF;");
      try {
        db.transaction(apply)();
      } finally {
        db.exec("PRAGMA foreign_keys = ON;");
      }
    } else {
      db.transaction(apply)();
    }
    version = nextVersion;
  }
}

export const createSchema = migrateSchema;
