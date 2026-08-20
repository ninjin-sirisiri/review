import { Database } from "bun:sqlite";

export const SCHEMA_VERSION = 1;

const MIGRATIONS: readonly string[] = [
  `
    CREATE TABLE IF NOT EXISTS repositories (
      repository_id TEXT PRIMARY KEY,
      root TEXT,
      created_at TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS sessions (
      session_id TEXT PRIMARY KEY,
      repository_id TEXT NOT NULL REFERENCES repositories(repository_id) ON DELETE CASCADE,
      agent_type TEXT NOT NULL CHECK (agent_type IN ('claude-code', 'codex')),
      started_at TEXT NOT NULL,
      ended_at TEXT,
      status TEXT NOT NULL CHECK (status IN ('active', 'completed', 'failed'))
    );

    CREATE TABLE IF NOT EXISTS decision_records (
      decision_id INTEGER PRIMARY KEY AUTOINCREMENT,
      record_id TEXT NOT NULL UNIQUE,
      session_id TEXT NOT NULL REFERENCES sessions(session_id) ON DELETE CASCADE,
      repository_id TEXT NOT NULL REFERENCES repositories(repository_id) ON DELETE CASCADE,
      agent_type TEXT NOT NULL CHECK (agent_type IN ('claude-code', 'codex')),
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
];

export function migrateSchema(db: Database): void {
  db.exec("PRAGMA foreign_keys = ON;");
  db.exec("CREATE TABLE IF NOT EXISTS schema_migrations (version INTEGER PRIMARY KEY NOT NULL);");
  const row = db.query("SELECT COALESCE(MAX(version), 0) AS version FROM schema_migrations").get() as { version: number };
  let version = row.version;
  while (version < MIGRATIONS.length) {
    const nextVersion = version + 1;
    db.transaction(() => {
      db.exec(MIGRATIONS[nextVersion - 1] as string);
      db.query("INSERT INTO schema_migrations (version) VALUES ($version)").run({ $version: nextVersion });
    })();
    version = nextVersion;
  }
}

export const createSchema = migrateSchema;
