import { Database } from "bun:sqlite";

export const SCHEMA_VERSION = 2;

interface Migration {
  readonly sql: string;
  /**
   * Set when a migration rebuilds tables that participate in foreign keys;
   * referential checks are suspended for the duration of the migration only.
   */
  readonly withoutForeignKeys?: boolean;
}

const AGENT_CHECK = "agent_type TEXT NOT NULL CHECK (agent_type IN ('claude-code', 'codex', 'opencode'))";

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
