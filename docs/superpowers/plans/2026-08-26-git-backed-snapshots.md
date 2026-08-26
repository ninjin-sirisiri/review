# Git-Backed Reference Snapshots Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** When an explicit snapshot POST's content byte-matches `HEAD:<path>` for one of the record's targets, persist only a `{base_sha, source_path}` reference instead of file bytes, resolving it later through read-only git with explicit failure states.

**Architecture:** Transparent server-side optimization inside the existing `POST /v1/decision-records/:recordId/snapshot` flow. A detection helper compares the submitted content hash against `HEAD` blobs of the record's target paths; hits insert a file-less `mode:"git"` snapshot row, misses take the unchanged legacy path. Source resolution branches on the reference mode to re-read via `GitReader.readCommitFile` and verify SHA-256 before returning `snapshot-resolved`.

**Tech Stack:** Bun + TypeScript, bun:sqlite, `createRecorderServer` HTTP server, React 19 + vitest (UI badge), bun test for recorder/contracts.

**Spec:** `docs/superpowers/specs/2026-08-26-git-backed-snapshots-design.md`

## Global Constraints

- Runtime and package manager are Bun (workspaces). Run ALL tests via `bun run test` from repo root — NEVER bare `bun test` at the root.
- Single files: `bun test apps/recorder/test/<file>.ts`, `bun test packages/contracts/test/validation.test.ts`, `bun run --cwd apps/review-ui test src/components/DecisionCard.test.tsx`.
- Security invariants after every task: loopback-only bind, owner bearer token + Origin validation on mutations untouched, Git access read-only via `GitReader` only, size caps inherited, no new endpoints, stored snapshot files stay inside dataDir.
- No silent fallbacks: unresolvable references return explicit failure states (`revision-not-found` / `source-unavailable`), never substituted content.
- Code/comments/UI copy in English. Conventional Commits with explanatory bodies.
- This repo enforces judgment-before-edit gating: if a Write/Edit is rejected asking for a judgment, call `review_record_judgment` targeting that exact file path, then retry the identical edit.

---

### Task 1: Contracts — `"git"` snapshot mode with validated reference fields

**Files:**
- Modify: `packages/contracts/src/records.ts:56-65`
- Modify: `packages/contracts/src/validation.ts` (SNAPSHOT_MODES at line ~39; `validateSnapshotReference` at lines 334-356)
- Test: `packages/contracts/test/validation.test.ts`

**Interfaces:**
- Consumes: existing helpers `hasOnlyKeys`, `nonEmptyString`, `timestamp`, `normalizeRelativePath`, `firstError`, `invalid`, `success`, `hasOwnKey` in `validation.ts`.
- Produces: `SnapshotMode = "changed-files" | "patch" | "git"`; `SnapshotReference.base_sha?: string` (lowercase 40-hex) and `.source_path?: string`. Later tasks import these from `packages/contracts/src/index`.

- [ ] **Step 1: Write the failing tests**

Append to `packages/contracts/test/validation.test.ts`:

```ts
const gitSnapshotBase = {
  snapshot_id: "snapshot-git",
  record_id: "record-001",
  mode: "git" as const,
  path: "",
  content_hash: "b".repeat(64),
  created_at: "2026-08-20T00:00:00.000Z",
  base_sha: "a".repeat(40),
  source_path: "src/example.ts",
};

test("accepts a git-backed snapshot reference", () => {
  const result = validateSnapshotReference(gitSnapshotBase);
  expect(result.success).toBe(true);
  if (result.success) {
    expect(result.data.mode).toBe("git");
    expect(result.data.path).toBe("");
    expect(result.data.base_sha).toBe("a".repeat(40));
    expect(result.data.source_path).toBe("src/example.ts");
  }
});

test.each([
  ["missing base_sha", { ...gitSnapshotBase, base_sha: undefined }],
  ["uppercase sha", { ...gitSnapshotBase, base_sha: "A".repeat(40) }],
  ["short sha", { ...gitSnapshotBase, base_sha: "a".repeat(39) }],
  ["non-hex sha", { ...gitSnapshotBase, base_sha: `${"g".repeat(39)}a` }],
  ["missing source_path", { ...gitSnapshotBase, source_path: undefined }],
  ["escaping source_path", { ...gitSnapshotBase, source_path: "../outside.ts" }],
  ["non-empty storage path", { ...gitSnapshotBase, path: "snapshots/x.snapshot" }],
])("rejects an invalid git snapshot: %s", (_label, value) => {
  expect(validateSnapshotReference(value).success).toBe(false);
});

test("rejects base_sha/source_path on non-git snapshots", () => {
  expect(validateSnapshotReference({ ...gitSnapshotBase, mode: "patch", path: "patch.diff" }).success).toBe(false);
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `bun test packages/contracts/test/validation.test.ts`
Expected: FAIL — `"git"` is not in `SNAPSHOT_MODES` and the new fields are rejected as unsupported.

- [ ] **Step 3: Implement**

In `packages/contracts/src/records.ts` replace lines 56-65 with:

```ts
export type SnapshotMode = "changed-files" | "patch" | "git";

export interface SnapshotReference {
  snapshot_id: string;
  record_id: string;
  mode: SnapshotMode;
  /** Storage-relative file path; empty string for git-backed snapshots (no stored file). */
  path: string;
  content_hash: string;
  created_at: string;
  /** git mode only: concrete commit SHA captured at creation time. */
  base_sha?: string;
  /** git mode only: registered-root-relative source path. */
  source_path?: string;
}
```

In `packages/contracts/src/validation.ts`: add `"git": true` to `SNAPSHOT_MODES`, then replace `validateSnapshotReference` with:

```ts
export function validateSnapshotReference(value: unknown): ValidationResult<SnapshotReference> {
  if (!isRecord(value) || !hasOnlyKeys(value, ["snapshot_id", "record_id", "mode", "path", "content_hash", "created_at", "base_sha", "source_path"])) {
    return invalid("snapshot reference has an unsupported field");
  }
  const requiredError = firstError(
    nonEmptyString(value.snapshot_id, "snapshot_id"),
    nonEmptyString(value.record_id, "record_id"),
    nonEmptyString(value.content_hash, "content_hash", 128),
    timestamp(value.created_at, "created_at"),
  );
  if (requiredError) return requiredError;
  if (typeof value.mode !== "string" || !hasOwnKey(SNAPSHOT_MODES, value.mode)) return invalid("mode is invalid", "mode");
  const mode = value.mode as SnapshotReference["mode"];
  if (mode === "git") {
    if (typeof value.base_sha !== "string" || !/^[0-9a-f]{40}$/.test(value.base_sha)) {
      return invalid("base_sha must be a lowercase 40-character commit SHA for git snapshots", "base_sha");
    }
    const sourcePathResult = normalizeRelativePath(value.source_path, "source_path");
    if (!sourcePathResult.success) return sourcePathResult;
    if (value.path !== "") return invalid("path must be empty for git-backed snapshots", "path");
    return success({
      snapshot_id: value.snapshot_id as string,
      record_id: value.record_id as string,
      mode,
      path: "",
      content_hash: value.content_hash as string,
      created_at: value.created_at as string,
      base_sha: value.base_sha,
      source_path: sourcePathResult.data,
    });
  }
  if (value.base_sha !== undefined || value.source_path !== undefined) {
    return invalid("base_sha and source_path are only allowed on git-backed snapshots", "base_sha");
  }
  const pathResult = normalizeRelativePath(value.path, "path");
  if (!pathResult.success) return pathResult;
  return success({
    snapshot_id: value.snapshot_id as string,
    record_id: value.record_id as string,
    mode,
    path: pathResult.data,
    content_hash: value.content_hash as string,
    created_at: value.created_at as string,
  });
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `bun test packages/contracts/test/validation.test.ts`
Expected: PASS including all pre-existing cases.

- [ ] **Step 5: Commit**

```bash
git add packages/contracts
git commit -m "feat(contracts): add git-backed snapshot mode with validated reference fields"
```

### Task 2: Schema migration v3 — rebuild `snapshots`

**Files:**
- Modify: `apps/recorder/src/store/schema.ts` (SCHEMA_VERSION at line 3; append third MIGRATIONS entry)
- Test: `apps/recorder/test/migration.test.ts`

**Interfaces:**
- Consumes: existing `migrateSchema(db)` version loop and `withoutForeignKeys` flag.
- Produces: `snapshots` table with columns `base_sha TEXT NULL`, `source_path TEXT NULL`, mode CHECK allowing `'git'`, and partial unique index `snapshots_storage_path_unique ON snapshots(path) WHERE path <> ''`. Task 3 relies on these names.

- [ ] **Step 1: Write the failing test**

Append to `apps/recorder/test/migration.test.ts`. The file already contains a legacy-fixture pattern (it builds the pre-v2 schema by hand — see its existing snapshots DDL around line 83); reuse that fixture, insert one legacy snapshot row (`'legacy-snapshot'` bound to an existing legacy record), run `migrateSchema(db)`, then assert:

```ts
const row = db.query("SELECT snapshot_id FROM snapshots").get() as { snapshot_id: string } | null;
expect(row?.snapshot_id).toBe("legacy-snapshot");

const columns = (db.query("PRAGMA table_info(snapshots)").all() as Array<{ name: string }>).map((column) => column.name);
expect(columns).toContain("base_sha");
expect(columns).toContain("source_path");
const preserved = db.query("SELECT base_sha, source_path FROM snapshots WHERE snapshot_id = 'legacy-snapshot'").get() as { base_sha: string | null; source_path: string | null };
expect(preserved.base_sha).toBeNull();
expect(preserved.source_path).toBeNull();

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
```

Follow the surrounding test's actual helper names for building the legacy DB and invoking `migrateSchema`.

- [ ] **Step 2: Run test to verify it fails**

Run: `bun test apps/recorder/test/migration.test.ts`
Expected: FAIL — no `base_sha`/`source_path` columns exist.

- [ ] **Step 3: Implement**

In `apps/recorder/src/store/schema.ts`: set `export const SCHEMA_VERSION = 3;` and append to `MIGRATIONS`:

```ts
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
    CREATE UNIQUE INDEX snapshots_storage_path_unique ON snapshots(path) WHERE path <> '';
    DROP TABLE snapshots;
    ALTER TABLE snapshots_rebuilt RENAME TO snapshots;
    PRAGMA foreign_key_check;
  `,
},
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `bun test apps/recorder/test/migration.test.ts`
Expected: PASS. Then run the whole recorder suite once: `bun test apps/recorder/test` — expected PASS (stores open cleanly on migrated schema).

- [ ] **Step 5: Commit**

```bash
git add apps/recorder/src/store/schema.ts apps/recorder/test/migration.test.ts
git commit -m "feat(recorder): add snapshot schema v3 with git-backed reference support"
```

---

### Task 3: SnapshotStore — `createGitBacked` / `getReference` / mode-aware get+delete

**Files:**
- Modify: `apps/recorder/src/store/snapshots.ts`
- Test: `apps/recorder/test/snapshot-store.test.ts`

**Interfaces:**
- Consumes: `SnapshotReference` from contracts (Task 1), schema v3 columns (Task 2).
- Produces (Task 5 depends on these exact signatures):
  - `createGitBacked(recordId: string, baseSha: string, sourcePath: string, contentHash: string): Promise<SnapshotReference>`
  - `getReference(snapshotId: string): Promise<SnapshotReference | null>`
  - `get()` returns `null` for git rows; `delete()` removes git rows without touching disk.

- [ ] **Step 1: Write the failing tests**

Append inside the existing `describe("SnapshotStore", ...)` block in `apps/recorder/test/snapshot-store.test.ts` (add `readdirSync` to imports from `node:fs`):

```ts
const sha40 = "a".repeat(40);

async function gitFixture() {
  const dataDir = await mkdtemp(join(tmpdir(), "ai-review-snapshot-git-"));
  temporaryDirectories.push(dataDir);
  const db = new Database(":memory:");
  const store = new RecordStore(db);
  await store.createSession(session);
  await store.insertDecision(decision);
  return { dataDir, db, snapshots: new SnapshotStore(db, createRecorderConfig({ dataDir })) };
}

test("creates git-backed references without writing files", async () => {
  const { dataDir, db, snapshots } = await gitFixture();
  const reference = await snapshots.createGitBacked(decision.record_id, sha40, "changed.ts", "hash-1");
  expect(reference.mode).toBe("git");
  expect(reference.path).toBe("");
  expect(reference.base_sha).toBe(sha40);
  expect(reference.source_path).toBe("changed.ts");
  expect(readdirSync(join(dataDir, "snapshots")).length).toBe(0);

  expect(await snapshots.get(reference.snapshot_id)).toBeNull();
  expect(await snapshots.getReference(reference.snapshot_id)).toEqual(reference);

  const second = await snapshots.createGitBacked(decision.record_id, sha40, "other.ts", "hash-2");
  expect(second.snapshot_id).not.toBe(reference.snapshot_id);
  db.close();
});

test("rejects git-backed creation with an unknown record or malformed fields", async () => {
  const { db, snapshots } = await gitFixture();
  await expect(snapshots.createGitBacked("missing-record", sha40, "a.ts", "h")).rejects.toThrow(/does not exist/);
  await expect(snapshots.createGitBacked(decision.record_id, "ZZ", "a.ts", "h")).rejects.toThrow();
  await expect(snapshots.createGitBacked(decision.record_id, sha40, "../escape.ts", "h")).rejects.toThrow();
  db.close();
});

test("deletes git-backed rows without touching disk", async () => {
  const { db, snapshots } = await gitFixture();
  const reference = await snapshots.createGitBacked(decision.record_id, sha40, "changed.ts", "hash-1");
  await snapshots.delete(reference.snapshot_id);
  expect(await snapshots.getReference(reference.snapshot_id)).toBeNull();
  db.close();
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `bun test apps/recorder/test/snapshot-store.test.ts`
Expected: FAIL — `createGitBacked`/`getReference` do not exist.

- [ ] **Step 3: Implement**

In `apps/recorder/src/store/snapshots.ts` extend `SnapshotRow` and centralize reference building:

```ts
interface SnapshotRow {
  snapshot_id: string;
  record_id: string;
  mode: string;
  path: string;
  content_hash: string;
  created_at: string;
  base_sha: string | null;
  source_path: string | null;
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
  };
}
```

Add methods to `SnapshotStore`:

```ts
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
      `INSERT INTO snapshots (snapshot_id, record_id, mode, path, content_hash, created_at, base_sha, source_path)
       VALUES ($snapshot_id, $record_id, $mode, $path, $content_hash, $created_at, $base_sha, $source_path)`,
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

async getReference(snapshotId: string): Promise<SnapshotReference | null> {
  const row = this.db.query(
    `SELECT snapshot_id, record_id, mode, path, content_hash, created_at, base_sha, source_path
     FROM snapshots WHERE snapshot_id = $snapshot_id`,
  ).get({ $snapshot_id: snapshotId }) as SnapshotRow | null;
  if (row === null) return null;
  const validation = validateSnapshotReference(referenceFromRow(row));
  return validation.success ? validation.data : null;
}
```

Rewire existing methods:

- In `get()`: replace the SELECT+validate preamble with

```ts
const reference = await this.getReference(snapshotId);
if (reference === null) return null;
if (reference.mode === "git") return null; // git-backed rows have no stored file
```

and use `reference.path` / `reference.content_hash` in the disk-read section that follows (behavior otherwise unchanged).

- Replace `delete()` body with the mode-aware version:

```ts
async delete(snapshotId: string): Promise<void> {
  const reference = await this.getReference(snapshotId);
  if (reference === null) return;
  if (reference.mode !== "git") {
    const filePath = this.resolveStoredPath(reference.path);
    if (filePath === null) throw new PersistenceError(ERROR_CODES.PATH_OUTSIDE_ROOT, "stored snapshot path is outside the local snapshot directory");
    try {
      await unlink(filePath);
    } catch (error) {
      const code = error as NodeJS.ErrnoException;
      if (code.code !== "ENOENT") throw error;
    }
  }
  this.db.query("DELETE FROM snapshots WHERE snapshot_id = $snapshot_id").run({ $snapshot_id: snapshotId });
}
```

- In `create()`, after the existing `snapshotMode(mode)` check add:

```ts
if (mode === "git") throw new PersistenceError(ERROR_CODES.INVALID_RECORD, "use createGitBacked for git-backed snapshots");
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `bun test apps/recorder/test/snapshot-store.test.ts && bun test apps/recorder/test`
Expected: PASS including pre-existing snapshot and store tests.

- [ ] **Step 5: Commit**

```bash
git add apps/recorder/src/store/snapshots.ts apps/recorder/test/snapshot-store.test.ts
git commit -m "feat(recorder): persist file-less git-backed snapshot references"
```

### Task 4: Detection helper — `detectGitBackable`

**Files:**
- Create: `apps/recorder/src/source/gitbacked.ts`
- Test: `apps/recorder/test/gitbacked-detect.test.ts`

**Interfaces:**
- Consumes: `RepositoryRegistry.get(repositoryId)` → `{ root } | null`; `GitReader.resolveRevision(root, "HEAD")` → 40-hex sha (throws `REVISION_NOT_FOUND` on unborn HEAD); `GitReader.readCommitFile(root, sha, path)` → file content at revision.
- Produces (Task 5 consumes): `detectGitBackable(registry: RepositoryRegistry, git: GitReader, record: DecisionRecord, contentHash: string): Promise<GitBackableTarget | null>` where `interface GitBackableTarget { baseSha: string; sourcePath: string }`. Never throws.

- [ ] **Step 1: Write the failing test**

Create `apps/recorder/test/gitbacked-detect.test.ts` modeled on the fixture helpers in `apps/recorder/test/source-resolution.test.ts` (`runGit`, `createFixture`, temp-dir cleanup):

```ts
import { createHash } from "node:crypto";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import type { DecisionRecordInput, TargetReference } from "../../../packages/contracts/src/index";
import { RepositoryRegistry } from "../src/repositories/registry";
import { GitReader } from "../src/source/git";
import { detectGitBackable } from "../src/source/gitbacked";
import { RecordStore } from "../src/store/records";

const temporaryDirectories: string[] = [];

async function runGit(root: string, args: string[]): Promise<string> {
  const process = Bun.spawn({ cmd: ["git", ...args], cwd: root, stdout: "pipe", stderr: "pipe" });
  const [stdout, stderr] = await Promise.all([new Response(process.stdout).text(), new Response(process.stderr).text()]);
  if ((await process.exited) !== 0) throw new Error(`git ${args.join(" ")} failed: ${stderr}`);
  return stdout.trim();
}

function hash(content: string): string {
  return createHash("sha256").update(content, "utf8").digest("hex");
}

interface Fixture { root: string; path: string; commitSha: string; committed: string; working: string }

async function createFixture(): Promise<Fixture> {
  const root = await mkdtemp(join(tmpdir(), "ai-review-gitbacked-"));
  temporaryDirectories.push(root);
  await runGit(root, ["init", "--quiet"]);
  await runGit(root, ["config", "user.email", "fixture@example.test"]);
  await runGit(root, ["config", "user.name", "Fixture"]);
  const path = "src/example.ts";
  const committed = "export const version = 1;\n";
  const working = "export const version = 2;\n";
  await mkdir(join(root, "src"), { recursive: true });
  await writeFile(join(root, path), committed, "utf8");
  await runGit(root, ["add", "--", path]);
  await runGit(root, ["commit", "--quiet", "-m", "fixture"]);
  const commitSha = await runGit(root, ["rev-parse", "HEAD"]);
  await writeFile(join(root, path), working, "utf8");
  return { root, path, commitSha, committed, working };
}

async function registeredRecord(fixture: Fixture, repositoryId: string, registry: RepositoryRegistry): Promise<DecisionRecordInput> {
  const target: TargetReference = {
    repository_id: repositoryId,
    path: fixture.path,
    line_start: 1,
    line_end: 1,
    revision: { kind: "working-tree", contentHash: hash(fixture.working) },
    content_hash: hash(fixture.working),
  };
  void registry;
  return {
    record_id: "detect-record",
    session_id: "detect-session",
    repository_id: repositoryId,
    agent_type: "codex",
    revision: target.revision,
    targets: [target],
    judgment: "Safe",
    rationale: "Fixture",
    checks: [],
    open_questions: [],
    created_at: "2026-08-26T00:00:00Z",
  };
}

afterEach(async () => {
  await Promise.all(temporaryDirectories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })));
});

describe("detectGitBackable", () => {
  test("matches submitted content against the HEAD blob of a target path", async () => {
    const fixture = await createFixture();
    const store = new RecordStore(new Database(":memory:"));
    const registry = new RepositoryRegistry(store);
    const registered = await registry.register(fixture.root);
    const record = await registeredRecord(fixture, registered.repository_id, registry);
    // Roll the worktree forward: detection must compare against HEAD, not the worktree.
    await writeFile(join(fixture.root, fixture.path), fixture.working, "utf8");

    const hit = await detectGitBackable(registry, new GitReader(10_000), record as never, hash(fixture.committed));
    expect(hit).toEqual({ baseSha: fixture.commitSha, sourcePath: fixture.path });

    const miss = await detectGitBackable(registry, new GitReader(10_000), record as never, hash("never committed\n"));
    expect(miss).toBeNull();
  });

  test("returns null for unregistered repositories and unborn HEADs", async () => {
    const fixture = await createFixture();
    const store = new RecordStore(new Database(":memory:"));
    const registry = new RepositoryRegistry(store);
    const record = await registeredRecord(fixture, "unknown-repository", registry);
    expect(await detectGitBackable(registry, new GitReader(10_000), record as never, hash(fixture.committed))).toBeNull();

    const emptyRoot = await mkdtemp(join(tmpdir(), "ai-review-gitbacked-empty-"));
    temporaryDirectories.push(emptyRoot);
    await runGit(emptyRoot, ["init", "--quiet"]);
    await runGit(emptyRoot, ["config", "user.email", "fixture@example.test"]);
    await runGit(emptyRoot, ["config", "user.name", "Fixture"]);
    const unbornRegistered = await registry.register(emptyRoot);
    const unbornRecord = await registeredRecord({ ...fixture, path: "src/example.ts" }, unbornRegistered.repository_id, registry);
    expect(await detectGitBackable(registry, new GitReader(10_000), unbornRecord as never, hash(fixture.committed))).toBeNull();
  });
});
```

Note: if `registry.register` rejects an unborn-HEAD repository in this codebase, drop that half of the second test and keep only the unregistered-repository case — check `apps/recorder/src/repositories/registry.ts` behavior first and mirror what `source-resolution.test.ts` already exercises.

- [ ] **Step 2: Run test to verify it fails**

Run: `bun test apps/recorder/test/gitbacked-detect.test.ts`
Expected: FAIL — module `../src/source/gitbacked` does not exist.

- [ ] **Step 3: Implement**

Create `apps/recorder/src/source/gitbacked.ts`:

```ts
import { createHash } from "node:crypto";
import type { DecisionRecord } from "../../../../packages/contracts/src/index";
import type { RepositoryRegistry } from "../repositories/registry";
import { GitReader } from "./git";

export interface GitBackableTarget {
  baseSha: string;
  sourcePath: string;
}

/**
 * Transparent optimization probe: returns the first record target whose HEAD
 * blob byte-matches the submitted content. Never throws — any failure means
 * "not eligible", and the caller stores a regular file-backed snapshot.
 */
export async function detectGitBackable(
  registry: RepositoryRegistry,
  git: GitReader,
  record: DecisionRecord,
  contentHash: string,
): Promise<GitBackableTarget | null> {
  try {
    const repository = await registry.get(record.repository_id);
    if (repository === null) return null;
    const headSha = await git.resolveRevision(repository.root, "HEAD");
    for (const target of record.targets) {
      try {
        const blob = await git.readCommitFile(repository.root, headSha, target.path);
        const blobHash = createHash("sha256").update(blob, "utf8").digest("hex");
        if (blobHash === contentHash) return { baseSha: headSha, sourcePath: target.path };
      } catch {
        // Candidate path unreadable at HEAD; try the next target.
      }
    }
    return null;
  } catch {
    return null;
  }
}
```

If the exported `DecisionRecord` type name differs in contracts (check `packages/contracts/src/index` exports used by `service.ts`), import whichever type `RecordService.listDecisions()` returns.

- [ ] **Step 4: Run tests to verify they pass**

Run: `bun test apps/recorder/test/gitbacked-detect.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add apps/recorder/src/source/gitbacked.ts apps/recorder/test/gitbacked-detect.test.ts
git commit -m "feat(recorder): add HEAD blob matcher for git-backed snapshot eligibility"
```

---

### Task 5: HTTP wiring + resolver git branch

**Files:**
- Modify: `apps/recorder/src/http/server.ts` (snapshot POST handler lines 492-502; `resolveRecordSources` lines 249-261)
- Modify: `apps/recorder/src/source/resolve.ts` (`resolveSnapshot` lines 80-99)
- Test: `apps/recorder/test/http.test.ts`, `apps/recorder/test/source-resolution.test.ts`

**Interfaces:**
- Consumes: Task 3 `snapshots.createGitBacked/getReference`, Task 4 `detectGitBackable`.
- Produces: unchanged HTTP envelope (`201` + reference JSON); git-backed references now serialize through the existing `resolved.snapshot` field with `mode:"git"` plus `base_sha`/`source_path`; resolution returns `snapshot-resolved` or explicit failure states per spec §8.

- [ ] **Step 1: Write the failing tests**

(a) Append to `apps/recorder/test/source-resolution.test.ts` inside `describe("source resolution", ...)`:

```ts
test("resolves a git-backed snapshot through read-only history and reports dangling references", async () => {
  const context = await createResolverFixture();
  const headSha = context.resolver.git.resolveRevision
    ? await context.resolver.git.resolveRevision(context.fixture.root, "HEAD")
    : await (async () => {
        const process = Bun.spawn({ cmd: ["git", "rev-parse", "HEAD"], cwd: context.fixture.root, stdout: "pipe", stderr: "pipe" });
        return (await new Response(process.stdout).text()).trim();
      })();
  const reference = await context.snapshots.createGitBacked(
    "source-resolution-record",
    headSha,
    context.fixture.path,
    hash(context.fixture.committed),
  );
  const commitTarget = target(context.fixture, { kind: "working-tree", contentHash: hash(context.fixture.committed) }, context.fixture.committed);
  commitTarget.repository_id = context.repositoryId;

  const resolved = await context.resolver.resolve(commitTarget, { snapshotId: reference.snapshot_id });
  expect(resolved.state).toBe("snapshot-resolved");
  if (resolved.state === "snapshot-resolved") {
    expect(resolved.content).toBe(context.fixture.committed);
    expect(resolved.snapshot?.base_sha).toBe(headSha);
  }
  await rm(context.fixture.root, { recursive: true, force: true });
  const unavailable = await context.resolver.resolve(commitTarget, { snapshotId: reference.snapshot_id });
  expect(unavailable.state).toBe("source-unavailable");
});
```

(b) Append to `apps/recorder/test/http.test.ts` inside the main describe (the harness registers `repo-1` via `/v1/repositories` in tests that need it — replicate that registration, then `git init`+commit inside `root` before registering):

```ts
test("stores a git-backed reference when snapshot content matches HEAD and serves it back", async () => {
  await runGit(["init"]);
  await runGit(["config", "user.email", "fixture@example.test"]);
  await runGit(["config", "user.name", "Fixture"]);
  await writeFile(join(root, "src", "example.ts"), "export const answer = 42;\n", "utf8");
  await runGit(["add", "--", "src/example.ts"]);
  await runGit(["commit", "-m", "fixture"]);
  await request("/v1/repositories", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ root, repository_id: "repo-1" }),
  });
  await request("/v1/sessions", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ repository_id: "repo-1", agent_type: "codex", session_id: "session-1", started_at: "2026-08-20T00:00:00Z", status: "active" }),
  });
  await request("/v1/decision-records", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body()),
  });

  const stored = await request("/v1/decision-records/record-1/snapshot", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ mode: "patch", content: "export const answer = 42;\n" }),
  });
  expect(stored.status).toBe(201);
  const payload = await json<{ success: true; data: { mode: string; path: string; base_sha?: string } }>(stored);
  expect(payload.data.mode).toBe("git");
  expect(payload.data.path).toBe("");
  expect(payload.data.base_sha).toMatch(/^[0-9a-f]{40}$/);

  const source = await request("/v1/decision-records/record-1/source?source=snapshot:" + payload.data.snapshot_id);
  expect(await json<{ success: true; data: { state: string; content: string } }>(source)).toMatchObject({
    success: true,
    data: { state: "snapshot-resolved", content: "export const answer = 42;\n" },
  });
});

test("stores a regular snapshot when content does not match any HEAD blob", async () => {
  await request("/v1/repositories", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ root, repository_id: "repo-1" }),
  });
  await request("/v1/sessions", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ repository_id: "repo-1", agent_type: "codex", session_id: "session-1", started_at: "2026-08-20T00:00:00Z", status: "active" }),
  });
  await request("/v1/decision-records", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body()),
  });
  const stored = await request("/v1/decision-records/record-1/snapshot", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ mode: "patch", content: "unmatchable text\n" }),
  });
  expect(stored.status).toBe(201);
  const payload = await json<{ success: true; data: { mode: string } }>(stored);
  expect(payload.data.mode).toBe("patch");
});
```

Adjust session/record creation calls to match how existing tests in this file create them (copy their exact request shapes).

Note: `body()` hashes `"export const answer = 42;\n"` for its target — that is why the committed content above matches it.

- [ ] **Step 2: Run tests to verify they fail**

Run: `bun test apps/recorder/test/source-resolution.test.ts && bun test apps/recorder/test/http.test.ts`
Expected: FAIL — POST still writes file-backed snapshots (`mode:"patch"` returned) and resolver has no git branch.

- [ ] **Step 3: Implement**

In `apps/recorder/src/http/server.ts`:

Add imports: `createHash` from `node:crypto` (if absent) and `detectGitBackable` from `../source/gitbacked`. Replace the POST snapshot handler body (lines 492-502):

```ts
if (request.method === "POST" && parts.length === 3 && parts[0] === "decision-records" && parts[2] === "snapshot") {
  const contentError = requireJsonContentType(request);
  if (contentError) return contentError;
  const input = requireObject(await parseJsonBody(request, maxJsonBytes), "snapshot request must be an object");
  const mode = input.mode;
  const content = input.content;
  if (mode !== "changed-files" && mode !== "patch") throw new PersistenceError(ERROR_CODES.INVALID_RECORD, "mode must be changed-files or patch");
  if (typeof content !== "string") throw new PersistenceError(ERROR_CODES.INVALID_RECORD, "content must be a string");
  const recordId = parts[1] ?? "";
  const contentHash = createHash("sha256").update(content, "utf8").digest("hex");
  const record = await service.getDecision(recordId);
  let reference;
  if (record !== null) {
    const eligible = await detectGitBackable(registry, resolver.git, record, contentHash);
    reference = eligible !== null && contentByteLengthWithinLimit(content)
      ? await snapshots.createGitBacked(recordId, eligible.baseSha, eligible.sourcePath, contentHash)
      : await service.createSnapshot(recordId, mode as SnapshotMode, content);
  } else {
    reference = await service.createSnapshot(recordId, mode as SnapshotMode, content);
  }
  return success(reference, 201);
}
```

Define `contentByteLengthWithinLimit(content: string): boolean` near the other helpers as

```ts
function contentByteLengthWithinLimit(content: string): boolean {
  return new TextEncoder().encode(content).byteLength <= maxSourceContentLength(config);
}
```

or inline the equivalent size check using the same configured limit `SnapshotStore.create()` enforces (read `snapshots.config.maxSnapshotContentLength`). The intent per spec §7: eligibility never bypasses the legacy size cap — oversized content falls back to the normal erroring path.

In `resolveRecordSources` (line ~251), switch the ownership pre-check from `resolver.snapshots?.get(...)` to `resolver.snapshots?.getReference(...)` (same null/undefined handling and record_id comparison).

In `apps/recorder/src/source/resolve.ts`: import `GitReaderError` (already imported via `./git`) and replace `resolveSnapshot`:

```ts
private async resolveSnapshot(target: TargetReference, snapshotId: string): Promise<ResolvedSource | UnresolvedSource> {
  if (this.snapshots === undefined) return this.unavailable(target, target.path, "snapshot storage is unavailable");
  const reference = await this.snapshots.getReference(snapshotId);
  if (reference === null) return this.unavailable(target, target.path, "snapshot is unavailable or has been tampered with");
  if (reference.mode === "git") {
    if (typeof reference.base_sha !== "string" || typeof reference.source_path !== "string") {
      return this.unavailable(target, target.path, "snapshot is unavailable or has been tampered with");
    }
    return this.resolveGitBackedSnapshot(target, reference.base_sha, reference.source_path, reference);
  }
  const stored = await this.snapshots.get(snapshotId);
  if (stored === null) return this.unavailable(target, target.path, "snapshot is unavailable or has been tampered with");
  return {
    state: "snapshot-resolved",
    repositoryId: target.repository_id,
    path: target.path,
    revision: target.revision,
    target,
    content: stored.content,
    contentHash: stored.reference.content_hash,
    snapshot: stored.reference,
  };
}

private async resolveGitBackedSnapshot(
  target: TargetReference,
  baseSha: string,
  sourcePath: string,
  reference: SnapshotReference,
): Promise<ResolvedSource | UnresolvedSource> {
  const repository = await this.registry.get(target.repository_id);
  if (repository === null) return this.unavailable(target, target.path, "repository is unavailable");
  let content: string;
  try {
    content = await this.git.readCommitFile(repository.root, baseSha, sourcePath);
  } catch (error) {
    if (error instanceof GitReaderError && error.code === ERROR_CODES.REVISION_NOT_FOUND) {
      return this.unavailable(target, target.path, "snapshotted revision was not found", "revision-not-found");
    }
    return this.unavailable(target, target.path, "snapshot is unavailable or has been tampered with");
  }
  const contentHash = createHash("sha256").update(content, "utf8").digest("hex");
  if (contentHash !== reference.content_hash) {
    return this.unavailable(target, target.path, "snapshot is unavailable or has been tampered with");
  }
  return {
    state: "snapshot-resolved",
    repositoryId: target.repository_id,
    path: target.path,
    revision: target.revision,
    target,
    content,
    contentHash,
    snapshot: reference,
  };
}
```

(`createHash` is already imported in resolve.ts.)

- [ ] **Step 4: Run tests to verify they pass**

Run: `bun test apps/recorder/test`
Expected: PASS — all recorder suites including the two new HTTP cases and the resolver case.

- [ ] **Step 5: Commit**

```bash
git add apps/recorder/src/http/server.ts apps/recorder/src/source/resolve.ts apps/recorder/test/http.test.ts apps/recorder/test/source-resolution.test.ts
git commit -m "feat(recorder): transparently store git-backed snapshots and resolve them from history"
```

### Task 6: Review UI — provenance badge for git-backed snapshots

**Files:**
- Modify: `apps/review-ui/src/api.ts:39-46` (`ResolvedSourceReference.snapshot`)
- Modify: `apps/review-ui/src/components/DecisionCard.tsx` (meta line, around line 73-75)
- Modify: `apps/review-ui/styles.css` (or the stylesheet that already styles `.decision-card__meta`) — one small rule
- Test: `apps/review-ui/src/components/DecisionCard.test.tsx`

**Interfaces:**
- Consumes: serialized `snapshot` object now carrying `mode: "changed-files" | "patch" | "git"` and optional `base_sha`, `source_path` (Task 5 output).
- Produces: a `.snapshot-provenance` element rendering `snapshot @<sha8>` only when `base_sha` exists.

- [ ] **Step 1: Write the failing test**

Append to `apps/review-ui/src/components/DecisionCard.test.tsx` (reuse its existing `detailFixture()` helper; add `snapshot` to one resolved source):

```ts
test("shows git provenance for snapshot-resolved sources", async () => {
  const detail = detailFixture();
  const source = detail.sources[0] as Extract<(typeof detail.sources)[number], { state: "snapshot-resolved" }>;
  source.snapshot = {
    ...source.snapshot!,
    mode: "git",
    base_sha: "a1b2c3d4e5f6a7b8c9d0a1b2c3d4e5f6a7b8c9d0",
    source_path: "src/example.ts",
  } as typeof source.snapshot;
  render(<DecisionCard detail={detail} />);
  const badge = screen.getByText(/@a1b2c3d4/);
  expect(badge).toBeDefined();
});

test("hides provenance when the snapshot has no base_sha", () => {
  render(<DecisionCard detail={detailFixture()} />);
  expect(screen.queryByText(/@/)).toBeNull();
});
```

Adjust fixture access to match the actual helper names/shapes in that test file.

- [ ] **Step 2: Run tests to verify they fail**

Run: `bun run --cwd apps/review-ui test src/components/DecisionCard.test.tsx`
Expected: FAIL — no `.snapshot-provenance` badge is rendered.

- [ ] **Step 3: Implement**

In `apps/review-ui/src/api.ts`, update the inline `snapshot` type:

```ts
snapshot?: {
  snapshot_id: string;
  record_id: string;
  mode: "changed-files" | "patch" | "git";
  path: string;
  content_hash: string;
  created_at: string;
  base_sha?: string;
  source_path?: string;
};
```

In `DecisionCard.tsx`, compute provenance and render it in the meta `<p>`:

```tsx
const gitSnapshot = detail.sources.find(
  (source) =>
    (source.state === "resolved" || source.state === "snapshot-resolved") &&
    source.snapshot?.mode === "git" &&
    typeof source.snapshot.base_sha === "string",
);
const provenance = gitSnapshot !== undefined && gitSnapshot.state !== "hash-mismatch"
  ? gitSnapshot.snapshot?.base_sha?.slice(0, 8)
  : undefined;
```

and inside the meta line after `revision {revisionText(...)}`:

```tsx
{provenance !== undefined && (
  <span className="snapshot-provenance" title="Snapshot stored as a git reference">
    {" · "}snapshot @{provenance}
  </span>
)}
```

Add to the stylesheet near other decision-card rules:

```css
.snapshot-provenance { color: var(--muted, #6b7280); font-family: monospace; }
```

(match existing variable names in that file).

- [ ] **Step 4: Run tests to verify they pass**

Run: `bun run --cwd apps/review-ui test src/components/DecisionCard.test.tsx && bun run --cwd apps/review-ui test`
Expected: PASS — full UI suite green.

- [ ] **Step 5: Commit**

```bash
git add apps/review-ui/src/api.ts apps/review-ui/src/components/DecisionCard.tsx apps/review-ui/src/components/DecisionCard.test.tsx apps/review-ui/styles.css
git commit -m "feat(review-ui): show @sha provenance for git-backed snapshots"
```

---

### Task 7: Full regression + docs

**Files:**
- Modify: none expected (fix anything the suites surface)

**Interfaces:**
- Consumes: all prior tasks.
- Produces: green monorepo suite and E2E.

- [ ] **Step 1: Run the complete test suite**

Run: `bun run build && bun run test`
Expected: PASS (contracts, recorder, plugins, review-ui).

- [ ] **Step 2: Run E2E**

Run: `bun run e2e`
Expected: PASS — existing Playwright specs unchanged and green.

- [ ] **Step 3: Manual smoke check**

Start the recorder per CLAUDE.md (`--ui-root "$PWD/apps/review-ui/dist"`), register this repo, POST a snapshot whose content equals a committed file at HEAD, confirm the response has `mode:"git"` with no file under `--data-dir/snapshots/`, and view the record in the UI showing the `@<sha8>` badge and full text.

- [ ] **Step 4: Fix fallout if any, commit**

Only if steps 1-3 surfaced fixes:

```bash
git add -A
git commit -m "fix(recorder): address regression findings from git-backed snapshot rollout"
```

---

## Plan self-review notes

- Spec §4 contracts → Task 1; §5 schema v3 → Task 2; §6 store → Task 3; §7 detection → Tasks 4-5; §8 resolution → Task 5; §9 UI → Task 6; §12 tests distributed per task plus Task 7 regression. No spec section is left without a task.
- Naming consistency: `createGitBacked(recordId, baseSha, sourcePath, contentHash)` and `getReference(snapshotId)` are used identically in Tasks 3 and 5; `detectGitBackable(registry, git, record, contentHash)` matches between Tasks 4 and 5.
- Known implementation-detail risk flagged inside tasks: http.test.ts session/record creation must copy the exact request shapes already used by that file; migration test must reuse the file's existing legacy-fixture helpers.

