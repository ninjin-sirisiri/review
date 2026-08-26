import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import type { ReviewSession } from "../../../packages/contracts/src/index";
import { migrateSchema } from "../src/store/schema";

const temporaryDirectories: string[] = [];

beforeEach(() => {
  // Keep the gate environment out of the migration path.
  delete process.env.AI_REVIEW_SESSION_ID;
});

afterEach(async () => {
  await Promise.all(temporaryDirectories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })));
});

async function databaseFile(): Promise<string> {
  const directory = await mkdtemp(join(tmpdir(), "ai-review-migration-"));
  temporaryDirectories.push(directory);
  return join(directory, "records.sqlite");
}

// Schema as written by recorder versions before opencode support.
const LEGACY_MIGRATION = `
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
`;

function seedLegacyData(db: Database): void {
  db.exec(LEGACY_MIGRATION);
  db.exec("CREATE TABLE IF NOT EXISTS schema_migrations (version INTEGER PRIMARY KEY NOT NULL);");
  db.query("INSERT INTO schema_migrations (version) VALUES ($version)").run({ $version: 1 });
  db.exec(`
    INSERT INTO repositories (repository_id, root, created_at) VALUES ('repo-1', '/tmp/repo-1', '2026-08-01T00:00:00.000Z');
    INSERT INTO sessions (session_id, repository_id, agent_type, started_at, status)
      VALUES ('session-legacy', 'repo-1', 'codex', '2026-08-01T00:00:00.000Z', 'active');
    INSERT INTO decision_records (
      record_id, session_id, repository_id, agent_type, revision_kind, revision_value,
      judgment, rationale, checks_json, open_questions_json, created_at, user_disposition
    ) VALUES (
      'record-legacy', 'session-legacy', 'repo-1', 'codex', 'working-tree', 'hash',
      'legacy judgment', 'legacy rationale', '[]', '[]', '2026-08-01T00:00:00.000Z', 'unreviewed'
    );
    INSERT INTO targets (record_id, target_index, repository_id, path, line_start, line_end, revision_kind, revision_value, content_hash)
      VALUES ('record-legacy', 0, 'repo-1', 'src/example.ts', 1, 1, 'working-tree', 'hash', 'target-hash');
    INSERT INTO checks (record_id, check_index, name, status) VALUES ('record-legacy', 0, 'tests', 'passed');
  `);
}

function opencodeSession(repositoryId = "repo-1"): ReviewSession {
  return {
    session_id: "session-opencode",
    repository_id: repositoryId,
    agent_type: "opencode",
    started_at: "2026-08-24T00:00:00.000Z",
    status: "active",
  };
}

test("fresh databases accept every supported agent type", () => {
  const db = new Database(":memory:");
  try {
    migrateSchema(db);
    const version = db.query("SELECT MAX(version) AS version FROM schema_migrations").get() as { version: number };
    expect(version.version).toBe(3);

    db.exec("INSERT INTO repositories (repository_id, root, created_at) VALUES ('repo-1', '/tmp/repo-1', '2026-08-24T00:00:00.000Z')");
    for (const agentType of ["claude-code", "codex", "opencode"] as const) {
      db.query("INSERT INTO sessions (session_id, repository_id, agent_type, started_at, status) VALUES ($id, $repo, $agent, $started, $status)").run({
        $id: `session-${agentType}`,
        $repo: "repo-1",
        $agent: agentType,
        $started: "2026-08-24T00:00:00.000Z",
        $status: "active",
      });
    }
    expect((db.query("SELECT COUNT(*) AS count FROM sessions").get() as { count: number }).count).toBe(3);
  } finally {
    db.close();
  }
});

test("migrating a legacy database preserves rows and unlocks the opencode agent type", async () => {
  const file = await databaseFile();
  const seeded = new Database(file);
  try {
    seedLegacyData(seeded);
  } finally {
    seeded.close();
  }

  const migrated = new Database(file);
  try {
    migrateSchema(migrated);

    const version = migrated.query("SELECT MAX(version) AS version FROM schema_migrations").get() as { version: number };
    expect(version.version).toBe(3);

    const legacySession = migrated.query("SELECT agent_type FROM sessions WHERE session_id = 'session-legacy'").get() as { agent_type: string };
    expect(legacySession.agent_type).toBe("codex");
    const legacyRecord = migrated.query("SELECT judgment FROM decision_records WHERE record_id = 'record-legacy'").get() as { judgment: string };
    expect(legacyRecord.judgment).toBe("legacy judgment");
    const legacyTargets = migrated.query("SELECT COUNT(*) AS count FROM targets WHERE record_id = 'record-legacy'").get() as { count: number };
    const legacyChecks = migrated.query("SELECT COUNT(*) AS count FROM checks WHERE record_id = 'record-legacy'").get() as { count: number };
    expect(legacyTargets.count).toBe(1);
    expect(legacyChecks.count).toBe(1);

    const foreignKeyIssues = migrated.query("PRAGMA foreign_key_check").all() as unknown[];
    expect(foreignKeyIssues).toHaveLength(0);

    migrated.query("INSERT INTO sessions (session_id, repository_id, agent_type, started_at, status) VALUES ($id, $repo, $agent, $started, $status)").run({
      $id: opencodeSession().session_id,
      $repo: "repo-1",
      $agent: "opencode",
      $started: opencodeSession().started_at,
      $status: "active",
    });
    const inserted = migrated.query("SELECT agent_type FROM sessions WHERE session_id = 'session-opencode'").get() as { agent_type: string };
    expect(inserted.agent_type).toBe("opencode");
  } finally {
    migrated.close();
  }
});

test("legacy databases still reject unsupported agent types after migration", async () => {
  const file = await databaseFile();
  const seeded = new Database(file);
  try {
    seedLegacyData(seeded);
  } finally {
    seeded.close();
  }

  const migrated = new Database(file);
  try {
    migrateSchema(migrated);
    let rejected = false;
    try {
      migrated.query("INSERT INTO sessions (session_id, repository_id, agent_type, started_at, status) VALUES ($id, $repo, $agent, $started, $status)").run({
        $id: "session-bogus",
        $repo: "repo-1",
        $agent: "bogus-agent",
        $started: "2026-08-24T00:00:00.000Z",
        $status: "active",
      });
    } catch {
      rejected = true;
    }
    expect(rejected).toBe(true);
  } finally {
    migrated.close();
  }
});

test("migrating a legacy database rebuilds snapshots for git-backed rows", async () => {
  const file = await databaseFile();
  const seeded = new Database(file);
  try {
    seedLegacyData(seeded);
    seeded.exec(`
      INSERT INTO decision_records (
        record_id, session_id, repository_id, agent_type, revision_kind, revision_value,
        judgment, rationale, checks_json, open_questions_json, created_at, user_disposition
      ) VALUES (
        'legacy-record', 'session-legacy', 'repo-1', 'codex', 'working-tree', 'hash',
        'snapshot judgment', 'snapshot rationale', '[]', '[]', '2026-08-01T00:00:00.000Z', 'unreviewed'
      );
      INSERT INTO snapshots (snapshot_id, record_id, mode, path, content_hash, created_at)
        VALUES ('legacy-snapshot', 'legacy-record', 'patch', 'legacy.snapshot', 'legacy-hash', '2026-08-01T00:00:00.000Z');
    `);
  } finally {
    seeded.close();
  }

  const db = new Database(file);
  try {
    migrateSchema(db);

    const version = db.query("SELECT MAX(version) AS version FROM schema_migrations").get() as { version: number };
    expect(version.version).toBe(3);

    const row = db.query("SELECT snapshot_id FROM snapshots").get() as { snapshot_id: string } | null;
    expect(row?.snapshot_id).toBe("legacy-snapshot");

    const columns = (db.query("PRAGMA table_info(snapshots)").all() as Array<{ name: string }>).map((column) => column.name);
    expect(columns).toContain("base_sha");
    expect(columns).toContain("source_path");
    const preserved = db.query("SELECT base_sha, source_path FROM snapshots WHERE snapshot_id = 'legacy-snapshot'").get() as { base_sha: string | null; source_path: string | null };
    expect(preserved.base_sha).toBeNull();
    expect(preserved.source_path).toBeNull();

    const indexes = (db.query("SELECT name FROM sqlite_master WHERE type = 'index' AND tbl_name = 'snapshots'").all() as Array<{ name: string }>).map((index) => index.name);
    expect(indexes).toContain("snapshots_storage_path_unique");

    // Two git rows may share path=''.
    db.query(
      "INSERT INTO snapshots (snapshot_id, record_id, mode, path, content_hash, created_at, base_sha, source_path) VALUES ($id, 'legacy-record', 'git', '', 'h1', '2026-08-26T00:00:00Z', $sha, 'src/a.ts')",
    ).run({ $id: "git-1", $sha: "a".repeat(40) });
    db.query(
      "INSERT INTO snapshots (snapshot_id, record_id, mode, path, content_hash, created_at, base_sha, source_path) VALUES ($id, 'legacy-record', 'git', '', 'h2', '2026-08-26T00:00:00Z', $sha, 'src/b.ts')",
    ).run({ $id: "git-2", $sha: "b".repeat(40) });

    // Constraint matrix.
    expect(() =>
      db.query("INSERT INTO snapshots VALUES ('bad-sha', 'legacy-record', 'git', '', 'h', '2026-08-26T00:00:00Z', 'zz', 'src/c.ts')").run(),
    ).toThrow();
    expect(() =>
      db.query(`INSERT INTO snapshots VALUES ('file-with-sha', 'legacy-record', 'patch', 'p.snapshot', 'h', '2026-08-26T00:00:00Z', '${"a".repeat(40)}', null)`).run(),
    ).toThrow();
    // Duplicate real storage paths still collide through the partial index; a second distinct path is fine.
    db.query("INSERT INTO snapshots VALUES ('dup-path', 'legacy-record', 'patch', 'same.snapshot', 'h', '2026-08-26T00:00:00Z', null, null)").run();
    expect(() =>
      db.query("INSERT INTO snapshots VALUES ('dup-path-2', 'legacy-record', 'patch', 'same.snapshot', 'h', '2026-08-26T00:00:00Z', null, null)").run(),
    ).toThrow();
  } finally {
    db.close();
  }
});
