# Automatic Snapshot Transitions Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Capture every permitted direct edit immediately before it runs and let reviewers compare that edit's before-state with the next automatic capture for the same repository path, or with the current worktree when no later capture exists.

**Architecture:** Keep capture at the existing Claude Code/OpenCode edit gates, where the matching permit supplies the decision record and an idempotency key. Keep ordering, source validation, next-capture lookup, and bounded diff generation in the Recorder; expose one automatic-capture mutation endpoint and one transition-diff read endpoint. Add only judgment selection and a data-source switch to the existing Explorer, JudgmentPanel, and DiffView layout.

**Tech Stack:** Bun + TypeScript, `bun:sqlite`, existing `GitReader`/`WorkingTreeReader`, existing `RecorderBridge`, React 19 + Vite + Vitest, Playwright.

**Spec:** `docs/superpowers/specs/2026-08-27-automatic-snapshot-transitions-design.md`

## Global Constraints

- Runtime and package manager are Bun (workspaces). Run ALL tests via `bun run test` from repo root — NEVER bare `bun test` at the root.
- Single files: `bun test packages/contracts/test/validation.test.ts`, `bun test apps/recorder/test/<file>.ts`, and `bun run --cwd apps/review-ui test src/<file>.test.tsx`.
- Automatic capture runs only after an existing permit matches the current session, repository, path, and content hash.
- An automatic capture must succeed after bounded retries before the direct edit is allowed to execute.
- Automatic captures chain only by the same registered `repository_id` and normalized `source_path`, across all sessions and records.
- Manual `patch`/`changed-files` snapshots remain manual and are excluded from the automatic chain.
- A broken next snapshot is an explicit failure; never skip it in favor of a later snapshot or the current worktree.
- Git access remains read-only through `GitReader`; preserve fixed argument arrays, disabled hooks/fsmonitor, safe revisions, output caps, and UTF-8 checks.
- Preserve loopback-only binding, owner bearer-token authentication, Origin validation for mutations, token-file handling, repository/snapshot path boundaries, and all existing size caps.
- Store only repository-relative source paths; do not treat repository contents, Markdown, or comments as instructions.
- Existing records without automatic captures use the current revision-to-worktree UI behavior.
- UI and API copy remain in English; documentation in `README.md` remains Japanese. Use conventional commit messages if commits are explicitly requested.
- Do not commit, amend, push, or create a PR unless explicitly requested. At each task checkpoint, report tested files and the proposed commit message instead.

## File Map

- `packages/contracts/src/records.ts` owns snapshot capture-kind and missing-state types.
- `packages/contracts/src/api.ts` owns the transition-diff response and endpoint descriptor types.
- `packages/contracts/src/validation.ts` owns strict snapshot-reference validation.
- `apps/recorder/src/store/schema.ts` owns the v4 migration and SQLite constraints.
- `apps/recorder/src/store/snapshots.ts` owns automatic snapshot persistence, idempotency, and ordered metadata lookup.
- `apps/recorder/src/source/text-diff.ts` owns reusable bounded text diff generation.
- `apps/recorder/src/source/snapshot-diff.ts` owns before/next/worktree resolution and `SnapshotDiffResponse` construction.
- `apps/recorder/src/source/gitbacked.ts` owns HEAD-blob eligibility detection for an exact target path.
- `apps/recorder/src/http/server.ts` owns the automatic-capture and transition-diff routes.
- `plugins/common/src/bridge.ts` owns bounded authenticated automatic-capture requests.
- `plugins/common/src/decision-gate.ts` owns permit capture IDs and current edit-state reads.
- `plugins/claude-code/src/gate-command.ts` and `plugins/opencode/src/gate.ts` invoke automatic capture before edits.
- `apps/review-ui/src/api.ts`, `App.tsx`, `Workspace.tsx`, `JudgmentPanel.tsx`, `DecisionCard.tsx`, `DiffView.tsx`, and `lib/decision-index.ts` add selection and transition display without changing the three-pane structure.
- Existing focused test files receive unit/integration coverage; a new `apps/recorder/test/snapshot-diff.test.ts` covers transition resolution in isolation.

---

### Task 1: Extend snapshot contracts and validation

**Files:**
- Modify: `packages/contracts/src/records.ts:56-69`
- Modify: `packages/contracts/src/api.ts:1-25`
- Modify: `packages/contracts/src/validation.ts:39,335-379`
- Test: `packages/contracts/test/validation.test.ts:227-263`

**Interfaces:**
- Consumes: existing `SnapshotMode`, `SnapshotReference`, `DiffHunk`, `normalizeRelativePath`, and validation helpers.
- Produces: `SnapshotCaptureKind`, the extended `SnapshotReference`, `SnapshotDiff`, `SnapshotDiffResponse`, and validation rules used by Recorder and Review UI tasks.

- [ ] **Step 1: Write failing contract tests**

Add fixtures and cases next to the current Git snapshot tests:

```ts
const automaticFileSnapshot = {
  snapshot_id: "snapshot-auto",
  record_id: "record-001",
  mode: "changed-files" as const,
  path: "snapshots/record-001/snapshot-auto.snapshot",
  content_hash: "b".repeat(64),
  created_at: "2026-08-27T00:00:00.000Z",
  source_path: "src/example.ts",
  capture_kind: "automatic" as const,
  before_missing: false,
};

test("accepts an automatic file-backed snapshot reference", () => {
  const result = validateSnapshotReference(automaticFileSnapshot);
  expect(result.success).toBe(true);
  if (result.success) {
    expect(result.data.capture_kind).toBe("automatic");
    expect(result.data.source_path).toBe("src/example.ts");
    expect(result.data.before_missing).toBe(false);
  }
});

test("accepts an automatic missing-file snapshot reference", () => {
  const result = validateSnapshotReference({
    ...automaticFileSnapshot,
    before_missing: true,
  });
  expect(result.success).toBe(true);
});

test.each([
  ["missing capture kind", { ...automaticFileSnapshot, capture_kind: undefined }],
  ["missing source path", { ...automaticFileSnapshot, source_path: undefined }],
  ["missing missing flag", { ...automaticFileSnapshot, before_missing: undefined }],
  ["non-boolean missing flag", { ...automaticFileSnapshot, before_missing: "false" }],
  ["escaping source path", { ...automaticFileSnapshot, source_path: "../outside.ts" }],
  ["manual file with source path", { ...automaticFileSnapshot, capture_kind: "manual", source_path: "src/example.ts" }],
])("rejects an invalid automatic snapshot: %s", (_label, value) => {
  expect(validateSnapshotReference(value).success).toBe(false);
});

test("keeps legacy manual file and git references valid", () => {
  expect(validateSnapshotReference({
    snapshot_id: "legacy-file",
    record_id: "record-001",
    mode: "patch",
    path: "snapshots/legacy.snapshot",
    content_hash: "b".repeat(64),
    created_at: "2026-08-27T00:00:00.000Z",
  }).success).toBe(true);
  expect(validateSnapshotReference(gitSnapshotBase).success).toBe(true);
});

test("accepts and discriminates transition responses", () => {
  const resolved: SnapshotDiffResponse = {
    state: "snapshot-resolved",
    path: "src/example.ts",
    from: {
      kind: "snapshot",
      snapshot_id: "before",
      record_id: "record-001",
      created_at: "2026-08-27T00:00:00.000Z",
      content_hash: "a".repeat(64),
      source_path: "src/example.ts",
    },
    to: { kind: "working-tree" },
    hunks: [],
    old_missing: false,
    new_missing: false,
    binary: false,
  };
  expect(resolved.state).toBe("snapshot-resolved");
});
```

Change the invalid non-Git test so it rejects `base_sha` and accepts `source_path` only when `capture_kind` is `automatic`.

- [ ] **Step 2: Run focused tests and verify the new cases fail**

Run: `bun test packages/contracts/test/validation.test.ts`

Expected: FAIL because the capture fields and transition types are not defined and the current validator rejects automatic file source paths.

- [ ] **Step 3: Implement the contract types**

In `records.ts`, add:

```ts
export type SnapshotCaptureKind = "manual" | "automatic";

export interface SnapshotReference {
  snapshot_id: string;
  record_id: string;
  mode: SnapshotMode;
  path: string;
  content_hash: string;
  created_at: string;
  base_sha?: string;
  source_path?: string;
  capture_kind?: SnapshotCaptureKind;
  before_missing?: boolean;
}
```

In `api.ts`, add the response types after `FileDiff`:

```ts
export interface SnapshotEndpoint {
  kind: "snapshot";
  snapshot_id: string;
  record_id: string;
  created_at: string;
  content_hash: string;
  source_path: string;
  base_sha?: string;
}

export interface WorkingTreeEndpoint {
  kind: "working-tree";
}

export interface SnapshotDiff {
  state: "snapshot-resolved";
  path: string;
  from: SnapshotEndpoint;
  to: SnapshotEndpoint | WorkingTreeEndpoint;
  hunks: DiffHunk[];
  old_missing: boolean;
  new_missing: boolean;
  binary: boolean;
}

export type SnapshotDiffResponse =
  | SnapshotDiff
  | { state: "legacy-fallback"; reason: "automatic-snapshot-not-found"; path: string }
  | { state: "source-unavailable" | "revision-not-found"; path: string; message: string };
```

- [ ] **Step 4: Implement strict validation rules**

Update `validateSnapshotReference` to allow `capture_kind` and `before_missing` keys while retaining all existing required-field checks. Apply these branches after validating the snapshot mode:

```ts
const captureKind = value.capture_kind;
if (captureKind !== undefined && captureKind !== "manual" && captureKind !== "automatic") {
  return invalid("capture_kind is invalid", "capture_kind");
}
if (value.before_missing !== undefined && typeof value.before_missing !== "boolean") {
  return invalid("before_missing must be a boolean", "before_missing");
}

if (mode === "git") {
  // Keep the existing lowercase 40-hex base_sha and empty storage path checks.
  // source_path remains required for every Git-backed reference.
  // Automatic Git references additionally require capture_kind=automatic and before_missing.
}

if (mode !== "git" && value.base_sha !== undefined) {
  return invalid("base_sha is only allowed on git-backed snapshots", "base_sha");
}
if (captureKind === "automatic") {
  const sourcePathResult = normalizeRelativePath(value.source_path, "source_path");
  if (!sourcePathResult.success) return sourcePathResult;
  if (typeof value.before_missing !== "boolean") return invalid("before_missing is required for automatic snapshots", "before_missing");
  // Return source_path, capture_kind, and before_missing in the normalized value.
} else if (mode !== "git" && value.source_path !== undefined) {
  return invalid("source_path is only allowed on automatic snapshots", "source_path");
}
```

Preserve optional-field omission for legacy manual references and preserve `source_path` for manual Git references. Do not import Node-only crypto into contracts; the empty-file hash invariant is enforced by `SnapshotStore` and the HTTP handler where content is available.

- [ ] **Step 5: Run focused tests and the contracts package suite**

Run: `bun test packages/contracts/test/validation.test.ts && bun test packages/contracts/test`

Expected: PASS, including all pre-existing validation cases.

- [ ] **Step 6: Review checkpoint**

Verify that the exact exported names are `SnapshotCaptureKind`, `SnapshotEndpoint`, `WorkingTreeEndpoint`, `SnapshotDiff`, and `SnapshotDiffResponse`; later tasks must import these names rather than duplicate shapes.

### Task 2: Migrate the snapshot schema to v4

**Files:**
- Modify: `apps/recorder/src/store/schema.ts:3,16-158`
- Modify: `apps/recorder/test/migration.test.ts:124-282`

**Interfaces:**
- Consumes: v3 `snapshots` schema and Task 1 snapshot fields.
- Produces: v4 columns `capture_kind`, `before_missing`, `capture_sequence`, and `capture_id`, plus partial unique indexes used by `SnapshotStore`.

- [ ] **Step 1: Extend migration tests before implementation**

Update fresh and legacy version assertions from `3` to `4`. Add assertions to the existing legacy snapshot migration test:

```ts
const snapshotColumns = (migrated.query("PRAGMA table_info(snapshots)").all() as Array<{ name: string }>).map((column) => column.name);
expect(snapshotColumns).toEqual(expect.arrayContaining(["capture_kind", "before_missing", "capture_sequence", "capture_id"]));

const legacy = migrated.query(
  "SELECT capture_kind, before_missing, capture_sequence, capture_id FROM snapshots WHERE snapshot_id = 'legacy-snapshot'",
).get() as { capture_kind: string; before_missing: number; capture_sequence: number | null; capture_id: string | null };
expect(legacy).toEqual({ capture_kind: "manual", before_missing: 0, capture_sequence: null, capture_id: null });

migrated.query(`
  INSERT INTO snapshots (
    snapshot_id, record_id, mode, path, content_hash, created_at,
    base_sha, source_path, capture_kind, before_missing, capture_sequence, capture_id
  ) VALUES ('automatic-1', 'legacy-record', 'changed-files', 'snapshots/automatic-1.snapshot',
    '${"b".repeat(64)}', '2026-08-27T00:00:00Z', NULL, 'src/a.ts', 'automatic', 0, 1, 'capture-1')
`);

expect(() => migrated.query(`
  INSERT INTO snapshots (
    snapshot_id, record_id, mode, path, content_hash, created_at,
    base_sha, source_path, capture_kind, before_missing, capture_sequence, capture_id
  ) VALUES ('automatic-bad', 'legacy-record', 'changed-files', 'snapshots/automatic-bad.snapshot',
    '${"b".repeat(64)}', '2026-08-27T00:00:00Z', NULL, NULL, 'automatic', 0, 2, 'capture-bad')
`).run()).toThrow();

expect(() => migrated.query(`
  INSERT INTO snapshots (
    snapshot_id, record_id, mode, path, content_hash, created_at,
    base_sha, source_path, capture_kind, before_missing, capture_sequence, capture_id
  ) VALUES ('capture-duplicate', 'legacy-record', 'changed-files', 'snapshots/capture-duplicate.snapshot',
    '${"b".repeat(64)}', '2026-08-27T00:00:00Z', NULL, 'src/b.ts', 'automatic', 0, 2, 'capture-1')
`).run()).toThrow();
```

Also assert that a second automatic row can use `path` values that differ, and that the existing partial storage-path index still rejects duplicate non-empty storage paths while allowing multiple Git rows with `path=''`.

- [ ] **Step 2: Run the migration test and verify it fails**

Run: `bun test apps/recorder/test/migration.test.ts`

Expected: FAIL because v4 columns and indexes do not exist and the current migration version is 3.

- [ ] **Step 3: Add the v4 table rebuild**

Set `SCHEMA_VERSION` to `4` and append a migration with `withoutForeignKeys: true`. The rebuilt table must include all v3 columns plus:

```sql
capture_kind TEXT NOT NULL DEFAULT 'manual'
  CHECK (capture_kind IN ('manual', 'automatic')),
before_missing INTEGER NOT NULL DEFAULT 0
  CHECK (before_missing IN (0, 1)),
capture_sequence INTEGER,
capture_id TEXT,
CHECK (
  capture_kind <> 'automatic'
  OR (source_path IS NOT NULL AND capture_sequence IS NOT NULL AND capture_id IS NOT NULL)
),
CHECK (
  capture_kind <> 'automatic'
  OR before_missing = 0
  OR content_hash = 'e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855'
)
```

Copy v3 rows with `capture_kind='manual'`, `before_missing=0`, and NULL sequence/ID. Complete the migration in this order so indexes attach to the rebuilt table:

```sql
INSERT INTO snapshots_rebuilt (..., capture_kind, before_missing, capture_sequence, capture_id)
  SELECT ..., 'manual', 0, NULL, NULL FROM snapshots;
DROP TABLE snapshots;
ALTER TABLE snapshots_rebuilt RENAME TO snapshots;
CREATE UNIQUE INDEX snapshots_storage_path_unique ON snapshots(path) WHERE path <> '';
CREATE UNIQUE INDEX snapshots_capture_id_unique ON snapshots(capture_id) WHERE capture_id IS NOT NULL;
CREATE UNIQUE INDEX snapshots_capture_sequence_unique ON snapshots(capture_sequence) WHERE capture_sequence IS NOT NULL;
PRAGMA foreign_key_check;
```

Use the same full column list and foreign-key handling as the existing v3 migration; do not change repositories, sessions, records, targets, or checks in this task.

- [ ] **Step 4: Run migration and recorder store tests**

Run: `bun test apps/recorder/test/migration.test.ts && bun test apps/recorder/test/store.test.ts`

Expected: PASS with legacy rows preserved, v4 constraints active, and all existing store behavior unchanged.

- [ ] **Step 5: Review checkpoint**

Inspect the migrated table with `PRAGMA table_info(snapshots)` and `sqlite_master`. Confirm the three indexes are attached after the table rename and `PRAGMA foreign_key_check` returns no rows.

### Task 3: Add ordered and idempotent automatic snapshot persistence

**Files:**
- Modify: `apps/recorder/src/store/snapshots.ts:17-275`
- Test: `apps/recorder/test/snapshot-store.test.ts`

**Interfaces:**
- Consumes: Task 1 `SnapshotReference` validation and Task 2 v4 schema.
- Produces:
  - `AutomaticSnapshotInput` with `recordId`, `captureId`, `sourcePath`, `content`, and `beforeMissing`.
  - `AutomaticGitSnapshotInput` with the same identity fields plus `baseSha` and `contentHash`.
  - `AutomaticSnapshotMetadata` with `reference`, `beforeMissing`, and `captureSequence`.
  - `createAutomatic(input): Promise<SnapshotReference>`.
  - `createAutomaticGitBacked(input): Promise<SnapshotReference>`.
  - `getAutomaticForRecord(recordId, sourcePath): Promise<AutomaticSnapshotMetadata | null>`.
  - `getNextAutomatic(repositoryId, sourcePath, afterSequence): Promise<AutomaticSnapshotMetadata | null>`.

- [ ] **Step 1: Write failing store tests**

Add a fixture using the existing `RecordStore` and `SnapshotStore` setup. Cover file-backed, Git-backed, missing, duplicate, and ordered rows:

```ts
test("stores an automatic file snapshot with source metadata and sequence", async () => {
  const context = await automaticFixture();
  const reference = await context.snapshots.createAutomatic({
    recordId: decision.record_id,
    captureId: "capture-1",
    sourcePath: "changed.ts",
    content: "before\n",
    beforeMissing: false,
  });

  expect(reference).toMatchObject({
    mode: "changed-files",
    source_path: "changed.ts",
    capture_kind: "automatic",
    before_missing: false,
  });
  expect(await context.snapshots.get(reference.snapshot_id)).toMatchObject({ content: "before\n" });
  expect((await context.snapshots.getAutomaticForRecord(decision.record_id, "changed.ts"))?.captureSequence).toBe(1);
});

test("stores an automatic missing-file snapshot without treating it as an empty file", async () => {
  const context = await automaticFixture();
  const reference = await context.snapshots.createAutomatic({
    recordId: decision.record_id,
    captureId: "capture-missing",
    sourcePath: "changed.ts",
    content: "",
    beforeMissing: true,
  });
  expect(reference.before_missing).toBe(true);
});

test("reuses an identical capture and rejects a conflicting capture", async () => {
  const context = await automaticFixture();
  const input = { recordId: decision.record_id, captureId: "capture-repeat", sourcePath: "changed.ts", content: "before", beforeMissing: false };
  const first = await context.snapshots.createAutomatic(input);
  const second = await context.snapshots.createAutomatic(input);
  expect(second).toEqual(first);
  await expect(context.snapshots.createAutomatic({ ...input, content: "different" })).rejects.toThrow();
  expect((context.db.query("SELECT COUNT(*) AS count FROM snapshots WHERE capture_id = 'capture-repeat'").get() as { count: number }).count).toBe(1);
});

test("finds the next automatic snapshot across sessions but not across paths or repositories", async () => {
  const context = await automaticSequenceFixture();
  const before = await context.snapshots.createAutomatic({ ...context.input, captureId: "capture-1", content: "one" });
  await context.snapshots.createAutomatic({ ...context.otherRecordInput, captureId: "capture-other-path", sourcePath: "other.ts", content: "ignored" });
  const next = await context.snapshots.createAutomatic({ ...context.input, captureId: "capture-2", content: "two" });
  expect((await context.snapshots.getNextAutomatic(context.repositoryId, context.input.sourcePath, beforeSequence(before)))?.reference.snapshot_id).toBe(next.snapshot_id);
});
```

Use actual helper names and record fixtures from the file; `beforeSequence` may read the metadata returned by `getAutomaticForRecord` rather than exposing sequence on `SnapshotReference`.

- [ ] **Step 2: Run the focused store test and verify it fails**

Run: `bun test apps/recorder/test/snapshot-store.test.ts`

Expected: FAIL because the automatic methods and v4 columns are not implemented.

- [ ] **Step 3: Add row metadata and reference normalization**

Extend `SnapshotRow` with `capture_kind`, `before_missing`, `capture_sequence`, and `capture_id`. Update `referenceFromRow` to include `capture_kind` and `before_missing` only where the stored row is automatic, while preserving `base_sha`/`source_path` behavior for Git rows:

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
  capture_kind: "manual" | "automatic";
  before_missing: number;
  capture_sequence: number | null;
  capture_id: string | null;
}

interface AutomaticSnapshotMetadata {
  reference: SnapshotReference;
  beforeMissing: boolean;
  captureSequence: number;
}
```

Every read must validate the normalized reference with `validateSnapshotReference`; invalid rows return `null`.

- [ ] **Step 4: Implement automatic file and Git creation**

Implement `createAutomatic` and `createAutomaticGitBacked` with these exact behaviors:

```ts
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

async createAutomatic(input: AutomaticSnapshotInput): Promise<SnapshotReference>;
async createAutomaticGitBacked(input: AutomaticGitSnapshotInput): Promise<SnapshotReference>;
```

Both methods must validate a non-empty record ID, record existence, non-empty capture ID, safe source path, content limit, and snapshot reference. `createAutomatic` hashes the supplied UTF-8 content and rejects `beforeMissing=true` unless the content is empty. It writes a 0600 file under the existing owner-local snapshot directory, then inserts the row with `capture_kind='automatic'`, `capture_sequence=MAX+1`, and the capture ID. `createAutomaticGitBacked` writes no file, uses `mode='git'`, `path=''`, `before_missing=0`, and inserts the same sequence/idempotency metadata.

Perform the capture-ID lookup before writing. If an identical row already exists, return its validated reference. If a unique-index race finds an existing capture ID after a failed insert, remove any newly written file, load the existing row, compare record/path/hash/missing/mode, and return it only when identical; otherwise throw `PersistenceError(ERROR_CODES.INVALID_RECORD, ...)`.

Assign sequence inside the same SQLite transaction as the insert:

```sql
SELECT COALESCE(MAX(capture_sequence), 0) + 1 AS next_sequence
FROM snapshots
WHERE capture_sequence IS NOT NULL
```

Keep `create()` manual and unchanged except for populating `capture_kind='manual'` explicitly where needed. Keep `createGitBacked()` manual and preserve its existing behavior.

- [ ] **Step 5: Implement ordered metadata lookup**

Add `getAutomaticForRecord` and `getNextAutomatic` using validated references and no content reads:

```sql
SELECT s.snapshot_id, s.record_id, s.mode, s.path, s.content_hash, s.created_at,
       s.base_sha, s.source_path, s.capture_kind, s.before_missing,
       s.capture_sequence, s.capture_id
FROM snapshots AS s
WHERE s.record_id = $record_id
  AND s.source_path = $source_path
  AND s.capture_kind = 'automatic'
ORDER BY s.capture_sequence ASC
LIMIT 1
```

For the next lookup, join `decision_records` and add `d.repository_id=$repository_id` and `s.capture_sequence > $after_sequence`. Return `null` only when no row exists. If reference validation fails for a selected row, throw a `PersistenceError` with `ERROR_CODES.SOURCE_UNAVAILABLE` rather than skipping the row; this lets the transition resolver return an explicit failure without falling through to the worktree.

- [ ] **Step 6: Run store tests and the recorder store suite**

Run: `bun test apps/recorder/test/snapshot-store.test.ts && bun test apps/recorder/test`

Expected: PASS, including legacy manual snapshots, Git-backed snapshots, delete behavior, size limits, and new automatic cases.

- [ ] **Step 7: Review checkpoint**

Confirm no automatic method writes outside `snapshotDir`, Git-backed automatic rows create no file, `get()` still returns `null` for Git rows, and deleting automatic Git rows does not attempt to unlink an empty path.

### Task 4: Extract bounded text diffing and implement transition resolution

**Files:**
- Create: `apps/recorder/src/source/text-diff.ts`
- Create: `apps/recorder/src/source/snapshot-diff.ts`
- Modify: `apps/recorder/src/source/git.ts:67-233,382-425,428-459`
- Test: `apps/recorder/test/snapshot-diff.test.ts`
- Test: `apps/recorder/test/source-resolution.test.ts` for Git-backed and worktree regressions

**Interfaces:**
- Consumes: Task 1 `SnapshotDiffResponse`, Task 3 ordered metadata, existing `GitReader`, `WorkingTreeReader`, and `RepositoryRegistry`.
- Produces:
  - `diffText(path, previous, current, options): TextDiffResult` in `text-diff.ts`.
  - `SnapshotDiffDependencies` and `resolveSnapshotDiff(record, sourcePath, dependencies): Promise<SnapshotDiffResponse>` in `snapshot-diff.ts`.

- [ ] **Step 1: Write failing transition tests**

Create a fixture with one registered Git repository, two records in different sessions, and automatic rows for the same path. Test the full selection algorithm:

```ts
test("compares an automatic before snapshot with the first later snapshot across sessions", async () => {
  const context = await createTransitionFixture();
  const before = await context.snapshots.createAutomatic({
    recordId: context.firstRecord.record_id,
    captureId: "capture-before",
    sourcePath: context.path,
    content: "const value = 1;\n",
    beforeMissing: false,
  });
  await context.snapshots.createAutomatic({
    recordId: context.secondRecord.record_id,
    captureId: "capture-next",
    sourcePath: context.path,
    content: "const value = 2;\n",
    beforeMissing: false,
  });

  const result = await resolveSnapshotDiff(context.firstRecord, context.path, context.dependencies);
  expect(result.state).toBe("snapshot-resolved");
  if (result.state === "snapshot-resolved") {
    expect(result.from.snapshot_id).toBe(before.snapshot_id);
    expect(result.to.kind).toBe("snapshot");
    expect(result.hunks.flatMap((hunk) => hunk.lines)).toContainEqual(expect.objectContaining({ type: "add", content: "const value = 2;" }));
  }
});

test("uses the current worktree when there is no later automatic snapshot", async () => {
  const context = await createTransitionFixture();
  await context.snapshots.createAutomatic({
    recordId: context.firstRecord.record_id,
    captureId: "capture-before",
    sourcePath: context.path,
    content: "before\n",
    beforeMissing: false,
  });
  await writeFile(join(context.root, context.path), "after\n", "utf8");
  const result = await resolveSnapshotDiff(context.firstRecord, context.path, context.dependencies);
  expect(result).toMatchObject({ state: "snapshot-resolved", to: { kind: "working-tree" } });
});

test("returns legacy-fallback when the selected record has no automatic snapshot", async () => {
  const context = await createTransitionFixture();
  await expect(resolveSnapshotDiff(context.manualRecord, context.path, context.dependencies)).resolves.toEqual({
    state: "legacy-fallback",
    reason: "automatic-snapshot-not-found",
    path: context.path,
  });
});

test("does not skip a broken next snapshot", async () => {
  const context = await createTransitionFixture();
  const before = await context.snapshots.createAutomatic({ ...context.firstInput, captureId: "capture-before", content: "one" });
  const next = await context.snapshots.createAutomatic({ ...context.secondInput, captureId: "capture-next", content: "two" });
  await writeFile(join(context.dataDir, next.path), "tampered", "utf8");
  const result = await resolveSnapshotDiff(context.firstRecord, context.path, context.dependencies);
  expect(result.state).toBe("source-unavailable");
  expect(before.snapshot_id).not.toBe(next.snapshot_id);
});
```

Add cases for missing before/after, identical content, binary content, invalid UTF-8 Git content, deleted current files, missing Git revisions, path mismatch, and different repositories. Keep the exact failure state names from `SnapshotDiffResponse`.

- [ ] **Step 2: Run the new transition test and verify it fails**

Run: `bun test apps/recorder/test/snapshot-diff.test.ts`

Expected: FAIL because the transition module and reusable text diff function do not exist.

- [ ] **Step 3: Extract the existing line-diff algorithm without changing output**

Move the private `DiffOperation`, `DiffEntry`, `GroupedHunk`, `lineDiff`, `toEntries`, `groupHunks`, and hunk construction logic into `text-diff.ts`. Export:

```ts
export interface TextDiffResult {
  hunks: DiffHunk[];
  binary: boolean;
}

export interface TextDiffOptions {
  maxWork: number;
}

export function diffText(path: string, previous: string, current: string, options: TextDiffOptions): TextDiffResult {
  // Detect NUL bytes first; return binary=true and no hunks.
  // Use the existing lineDiff budget and throw a named error carrying PAYLOAD_TOO_LARGE when exhausted.
}
```

Keep hunk line numbering, three-line context, empty-side zero-line behavior, and `PAYLOAD_TOO_LARGE` classification identical to `GitReader` today. Update `readPathDiff` and `readDiff` to call `diffText`; retain Git-specific reading, path checks, and error wrapping in `git.ts`. Run existing source-resolution diff tests immediately after extraction.

- [ ] **Step 4: Implement transition source loading**

In `snapshot-diff.ts`, define:

```ts
export interface SnapshotDiffDependencies {
  registry: RepositoryRegistry;
  snapshots: SnapshotStore;
  git: GitReader;
  worktree: WorkingTreeReader;
}

export async function resolveSnapshotDiff(
  record: DecisionRecord,
  sourcePath: string,
  dependencies: SnapshotDiffDependencies,
): Promise<SnapshotDiffResponse>;
```

Implement in this order:

1. Normalize `sourcePath` with `normalizeSourcePath` and require an exact matching target whose `repository_id` equals the record repository.
2. Call `getAutomaticForRecord(record.record_id, normalizedPath)`. Return `legacy-fallback` if absent.
3. Read the before content. For file-backed rows call `snapshots.get()` and use metadata `beforeMissing`; for Git-backed rows require `base_sha`/`source_path`, load through `registry.get()` and `git.readCommitFile()`, and classify a missing revision as `revision-not-found`.
4. Call `getNextAutomatic(record.repository_id, normalizedPath, before.captureSequence)`. If present, read it with the same validation rules. If it fails, return its explicit unavailable/revision state and do not continue.
5. If no next row exists, read the current worktree through `WorkingTreeReader`. Convert `WorkingTreePathMissingError` to an after missing state; return other source failures explicitly.
6. Call `diffText` with `git.maxDiffWork` and return `SnapshotDiff` with descriptors, hunk data, `old_missing`, `new_missing`, and `binary`.

Do not use `SourceResolver.resolve` for the transition because the before/after pair has distinct missing semantics and the current resolver is intentionally record-target oriented. Reuse its error classes and source readers.

- [ ] **Step 5: Run transition, source-resolution, and recorder tests**

Run: `bun test apps/recorder/test/snapshot-diff.test.ts && bun test apps/recorder/test/source-resolution.test.ts && bun test apps/recorder/test`

Expected: PASS, with all existing commit/worktree/diff behavior unchanged.

- [ ] **Step 6: Review checkpoint**

Compare `readPathDiff` output before and after extraction for separated edits, dense edits, binary content, created files, deleted files, and no-change files. Confirm transition resolution never falls through from a present-but-invalid next row to the worktree.

### Task 5: Add Recorder automatic-capture and transition-diff routes

**Files:**
- Modify: `apps/recorder/src/source/gitbacked.ts:20-44`
- Modify: `apps/recorder/src/http/server.ts:195-263,377-525`
- Test: `apps/recorder/test/http.test.ts`

**Interfaces:**
- Consumes: Task 1 response types, Task 3 automatic store methods, Task 4 `resolveSnapshotDiff`, existing `SourceResolver` readers, and existing auth/router helpers.
- Produces:
  - `POST /v1/decision-records/:recordId/automatic-snapshot` returning `SnapshotReference`.
  - `GET /v1/decision-records/:recordId/snapshot-diff?path=...` returning `SnapshotDiffResponse`.

- [ ] **Step 1: Write failing HTTP tests**

Extend the existing HTTP fixture with a registered Git repository, a committed target, and two sessions/records. Add these cases:

```ts
test("creates an automatic snapshot only for the current target state", async () => {
  const response = await request("/v1/decision-records/record-1/automatic-snapshot", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      capture_id: "capture-http-1",
      source_path: "src/example.ts",
      content: "export const answer = 42;\n",
      before_missing: false,
    }),
  });
  expect(response.status).toBe(201);
  const payload = await json<{ success: true; data: { capture_kind: string; source_path: string } }>(response);
  expect(payload.data).toMatchObject({ capture_kind: "automatic", source_path: "src/example.ts" });
});

test("automatic capture is idempotent and rejects a changed retry", async () => {
  const input = {
    capture_id: "capture-http-repeat",
    source_path: "src/example.ts",
    content: "before\n",
    before_missing: false,
  };
  const first = await request("/v1/decision-records/record-1/automatic-snapshot", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(input) });
  const second = await request("/v1/decision-records/record-1/automatic-snapshot", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(input) });
  expect((await json<{ success: true; data: { snapshot_id: string } }>(first)).data.snapshot_id)
    .toBe((await json<{ success: true; data: { snapshot_id: string } }>(second)).data.snapshot_id);
  const conflict = await request("/v1/decision-records/record-1/automatic-snapshot", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ ...input, content: "different\n" }) });
  expect(conflict.status).toBe(422);
});

test("serves snapshot-to-snapshot and snapshot-to-worktree transition diffs", async () => {
  const before = await postAutomatic("record-1", "capture-http-before", "src/example.ts", "one\n");
  const transition = await request("/v1/decision-records/record-1/snapshot-diff?path=src%2Fexample.ts");
  expect(await json<{ success: true; data: { state: string; from: { snapshot_id: string }; to: { kind: string } } }>(transition)).toMatchObject({
    success: true,
    data: { state: "snapshot-resolved", from: { snapshot_id: before.snapshot_id } },
  });
});

test("returns legacy fallback for records without automatic snapshots", async () => {
  const response = await request("/v1/decision-records/manual-record/snapshot-diff?path=src%2Fexample.ts");
  expect(await json<{ success: true; data: { state: string; reason: string } }>(response)).toMatchObject({
    success: true,
    data: { state: "legacy-fallback", reason: "automatic-snapshot-not-found" },
  });
});
```

Add tests for missing/incorrect bearer token, disallowed Origin on POST, unknown record, non-target path, path traversal, current-content hash conflict, oversized body, missing current file, and a broken next snapshot. Reuse exact request/auth helpers and session/record bodies already present in `http.test.ts`.

- [ ] **Step 2: Run focused HTTP tests and verify they fail**

Run: `bun test apps/recorder/test/http.test.ts`

Expected: FAIL because both routes are unknown and exact-path Git detection is not yet available.

- [ ] **Step 3: Make HEAD matching path-specific**

Update `detectGitBackable` in `gitbacked.ts` to accept an optional `sourcePath?: string` after `contentHash`. When supplied, filter `record.targets` to that normalized exact path before reading HEAD blobs. Keep the existing four-argument behavior for the explicit snapshot optimization path and continue swallowing Git eligibility failures as `null`.

The automatic route must call:

```ts
const eligible = await detectGitBackable(registry, resolver.git, record, contentHash, normalizedSourcePath);
```

It must never choose a different target merely because it has the same content hash.

- [ ] **Step 4: Implement automatic snapshot request validation**

Add a strict object-key check for `capture_id`, `source_path`, `content`, and `before_missing`. Validate non-empty strings and a boolean before calling readers. Fetch the record and require that exactly one target has the normalized source path and the same repository ID. Call `registry.assertTarget` to validate the canonical boundary.

Read the current file using `resolver.worktree.readFile`. Convert `WorkingTreePathMissingError` to `{ content: "", beforeMissing: true }`; rethrow other errors through the existing error response. Reject if the submitted `before_missing` or SHA-256 content hash differs from the observed current state. Check the snapshot limit before detection so a large body cannot be accepted as a Git reference.

When the content matches HEAD, call `createAutomaticGitBacked`; otherwise call `createAutomatic`. The `postAutomatic` test helper must write the requested content to the fixture worktree immediately before each request so the server-side current-state verification succeeds. Return the same success envelope with status `201` for a new row and `200` for an idempotent existing row. Preserve the existing error mapper for `PersistenceError` and `SourceResolutionError`.

- [ ] **Step 5: Implement the transition-diff route**

Add a GET branch after the existing source route:

```ts
if (request.method === "GET" && parts.length === 3 && parts[0] === "decision-records" && parts[2] === "snapshot-diff") {
  const path = url.searchParams.get("path");
  if (path === null || path.trim().length === 0) return failure(ERROR_CODES.INVALID_RECORD, "path query parameter is required", 422, "path");
  const record = await service.getDecision(parts[1] ?? "");
  if (record === null) return failure(ERROR_CODES.INVALID_RECORD, "decision record was not found", 404);
  const result = await resolveSnapshotDiff(record, path, { registry, snapshots, git: resolver.git, worktree: resolver.worktree });
  return success(result);
}
```

Return `success(result)` for all discriminated transition states; convert only payload-size and malformed input failures to the existing error envelope/status.

Keep record ownership inside `resolveSnapshotDiff`; do not accept a snapshot ID supplied by the browser for this route.

- [ ] **Step 6: Run HTTP and recorder suites**

Run: `bun test apps/recorder/test/http.test.ts && bun test apps/recorder/test`

Expected: PASS, including authentication/Origin regressions, explicit snapshot behavior, Git-backed resolution, and the new routes.

- [ ] **Step 7: Review checkpoint**

Verify no endpoint exposes snapshot contents for another record, an automatic request cannot target a non-target path, a corrupted next row is not skipped, and the manual snapshot route still accepts only its original request contract.

### Task 6: Add automatic capture to the common bridge and edit gates

**Files:**
- Modify: `plugins/common/src/decision-gate.ts:71-173,276-291,303-354`
- Modify: `plugins/common/src/bridge.ts:13-24,50-205`
- Modify: `plugins/claude-code/src/gate-command.ts:120-171`
- Modify: `plugins/opencode/src/gate.ts:23-118`
- Modify: `plugins/opencode/src/index.ts:36-85`
- Tests: `plugins/common/test/bridge.test.ts`, `plugins/common/test/decision-gate.test.ts`, `plugins/claude-code/test/gate.test.ts`, `plugins/opencode/test/gate.test.ts`, `plugins/opencode/test/plugin.test.ts`

**Interfaces:**
- Consumes: Task 5 automatic-capture endpoint and existing permit/gate behavior.
- Produces: `RecorderBridge.captureAutomaticSnapshot`, permit metadata lookup with `recordId`/`captureId`, and fail-closed pre-edit behavior shared by Claude Code and OpenCode.

- [ ] **Step 1: Write failing bridge and gate tests**

In bridge tests, assert the request path, body, token header, bounded retry, and success/failure result:

```ts
test("posts an automatic snapshot to the record-specific endpoint", async () => {
  const requests: Request[] = [];
  const bridge = new RecorderBridge({
    endpoint: "http://127.0.0.1:4318/v1/decision-records",
    tokenPath: tokenFile,
    fetchImpl: async (input, init) => {
      requests.push(new Request(input, init));
      return Response.json({ success: true, data: { snapshot_id: "snapshot-1" } }, { status: 201 });
    },
  });
  const result = await bridge.captureAutomaticSnapshot({
    recordId: "record-1",
    captureId: "capture-1",
    sourcePath: "src/a.ts",
    content: "before\n",
    beforeMissing: false,
  });
  expect(result.success).toBe(true);
  expect(new URL(requests[0]!.url).pathname).toBe("/v1/decision-records/record-1/automatic-snapshot");
  expect(await requests[0]!.json()).toMatchObject({ capture_id: "capture-1", source_path: "src/a.ts" });
});
```

In both gate test files, add cases that a matching permit calls the capture callback/bridge before returning permission, a failed capture returns a denial containing the failure message, and a second pre-hook with the same permit reuses the same capture ID. Keep existing tests proving a blocked edit does not consume the permit.

- [ ] **Step 2: Run focused plugin tests and verify they fail**

Run: `bun test plugins/common/test/bridge.test.ts plugins/common/test/decision-gate.test.ts plugins/claude-code/test/gate.test.ts plugins/opencode/test/gate.test.ts plugins/opencode/test/plugin.test.ts`

Expected: FAIL because the bridge method, permit metadata, and pre-edit capture path do not exist.

- [ ] **Step 3: Add permit capture identity and current-state reading**

Extend the internal permit with a generated `captureId` and persist it in each permit JSON. Change the private matching result from only `{ path }` to `{ path, permit }`, and expose a safe read-only helper:

```ts
export interface MatchingDecisionPermit {
  recordId: string;
  captureId: string;
  sessionId: string;
  repositoryRoot: string;
  path: string;
  contentHash: string;
}

export async function findDecisionPermit(options: ConsumeDecisionPermitOptions): Promise<MatchingDecisionPermit | null>;
```

Keep `peekDecisionPermit` returning boolean for existing consumers by delegating to `findDecisionPermit`. Validate `captureId` when parsing old/new permit JSON; old permit files without it are treated as non-matching and remain safe to remove through normal expiry cleanup.

Add an exported helper that returns `{ content, beforeMissing }`, using the existing canonical path and size checks. A missing final file returns empty content with `beforeMissing=true`; symlink escapes, directories, unreadable files, invalid UTF-8, and oversized files return failure rather than an empty snapshot.

- [ ] **Step 4: Implement bounded bridge capture**

Add to `RecorderBridge`:

```ts
captureAutomaticSnapshot(input: {
  recordId: string;
  captureId: string;
  sourcePath: string;
  content: string;
  beforeMissing: boolean;
}): Promise<SubmitResult>;
```

Reuse the token-file read, loopback URL validation, bounded response size, timeout, retry count, retry duration, and retryable status classification already used by `submit`. Build the endpoint by appending `/${encodeURIComponent(recordId)}/automatic-snapshot` to the configured `/v1/decision-records` endpoint. Use `captureId` as the in-flight deduplication key so concurrent calls for one permit share one request. Treat any non-success envelope or non-2xx response as a failed capture; return the exact server message for the gate denial.

- [ ] **Step 5: Wire Claude Code pre-edit capture**

In `checkPreToolUse`, replace the boolean-only permit peek for direct edit tools with `findDecisionPermit`. After a matching permit is found:

1. Read current state with the common helper.
2. Compute the repository-relative path from the canonical root.
3. Call `options.bridge ?? new RecorderBridge()` with the permit record/capture IDs and state.
4. Return `null` only when the bridge result is successful.
5. Return `deny("Automatic snapshot failed before edit: ...")` for a failed result.

Keep Bash mutation denial unchanged and do not consume permits in the pre-hook. Define a shared structural type for the injectable capture operation:

```ts
export interface AutomaticSnapshotBridge {
  captureAutomaticSnapshot(input: {
    recordId: string;
    captureId: string;
    sourcePath: string;
    content: string;
    beforeMissing: boolean;
  }): Promise<SubmitResult>;
}
```

Add `bridge?: AutomaticSnapshotBridge` to Claude's `PreToolUse` options and `snapshotBridge?: AutomaticSnapshotBridge` to OpenCode's `GateContext`; keep the common `GateStorageOptions` free of Recorder dependencies. Do not put token data into error messages.

- [ ] **Step 6: Wire OpenCode pre-edit capture**

Add the same capture operation to `gateToolUse` after matching the permit and before returning `null`. Pass a single shared `RecorderBridge` from the plugin factory through `gateContext` so one OpenCode session does not create unrelated in-flight queues. Keep `gateToolUseAfter` unchanged except for its existing permit consumption.

The OpenCode plugin must still call `ensureRegistered` before gate evaluation. A registration failure keeps the existing gate behavior; an automatic capture failure explicitly denies the edit.

- [ ] **Step 7: Run plugin tests and rebuild the Claude bundle**

Run: `bun test plugins/common/test/bridge.test.ts plugins/common/test/decision-gate.test.ts plugins/claude-code/test/gate.test.ts plugins/opencode/test/gate.test.ts plugins/opencode/test/plugin.test.ts && bun run build:claude-plugin`

Expected: PASS. The build may update `plugins/claude-code/bin/adapter.mjs`; inspect that generated diff and include it only if the repository tracks generated plugin output.

- [ ] **Step 8: Review checkpoint**

Prove that a failed capture leaves the permit available for retry, a successful edit consumes it only in the existing post-hook, Bash remains denied without capture, and the same permit never produces two rows after timeout/retry or duplicate hook invocation.

### Task 7: Expose the transition diff to Review UI with minimal layout changes

**Files:**
- Modify: `apps/review-ui/src/api.ts:1-10,31-62,206-260`
- Modify: `apps/review-ui/src/lib/decision-index.ts:31-63`
- Modify: `apps/review-ui/src/App.tsx:46-213,288-302`
- Modify: `apps/review-ui/src/components/Workspace.tsx:11-97`
- Modify: `apps/review-ui/src/components/JudgmentPanel.tsx:13-95`
- Modify: `apps/review-ui/src/components/DecisionCard.tsx:4-179`
- Modify: `apps/review-ui/src/components/DiffView.tsx:6-239`
- Modify: `apps/review-ui/src/styles/components.css`
- Tests: `apps/review-ui/src/api.test.ts`, `App.test.tsx`, `components/Workspace.test.tsx`, `components/JudgmentPanel.test.tsx`, `components/DecisionCard.test.tsx`, `components/DiffView.test.tsx`

**Interfaces:**
- Consumes: Task 1 `SnapshotDiffResponse` and Task 5 transition-diff route.
- Produces: `ReviewApi.getSnapshotDiff(recordId, path)`, selected-judgment state, and a central DiffView mode for `SnapshotDiff` without adding a new pane.

- [ ] **Step 1: Write failing UI/API tests**

In `api.test.ts`, assert the encoded path and typed response:

```ts
it("fetches a snapshot transition diff", async () => {
  const fetchImpl = vi.fn(async () => Response.json({
    success: true,
    data: { state: "legacy-fallback", reason: "automatic-snapshot-not-found", path: "src/a.ts" },
  }));
  const api = new ReviewApi("token", { fetchImpl });
  await expect(api.getSnapshotDiff("record-1", "src/a.ts")).resolves.toMatchObject({ state: "legacy-fallback" });
  expect(fetchImpl).toHaveBeenCalledWith(
    "/v1/decision-records/record-1/snapshot-diff?path=src%2Fa.ts",
    expect.objectContaining({ headers: expect.objectContaining({ Authorization: "Bearer token" }) }),
  );
});
```

Add component tests that a ready card exposes a selection control, selected state is announced, selecting a card calls the parent, a resolved `SnapshotDiff` renders before/after labels and hunk lines, `working-tree` is shown when there is no next snapshot, and a transition error does not render current full text. Add an App/Workspace test that selecting a legacy record leaves the existing repository diff visible.

- [ ] **Step 2: Run focused UI tests and verify they fail**

Run: `bun run --cwd apps/review-ui test src/api.test.ts src/components/DecisionCard.test.tsx src/components/DiffView.test.tsx src/components/Workspace.test.tsx src/App.test.tsx`

Expected: FAIL because the API method, selection props, and snapshot transition rendering do not exist.

- [ ] **Step 3: Add the API method and transition state types**

Import `SnapshotDiffResponse` from contracts and add:

```ts
getSnapshotDiff(recordId: string, path: string): Promise<SnapshotDiffResponse> {
  const normalizedRecordId = recordId.trim();
  if (normalizedRecordId.length === 0) {
    return Promise.reject(new ReviewApiError("Decision record ID is required", { status: 422, code: "INVALID_RECORD" }));
  }
  return this.request<SnapshotDiffResponse>(
    `/v1/decision-records/${encodeURIComponent(normalizedRecordId)}/snapshot-diff?path=${encodeURIComponent(path)}`,
  );
}
```

Re-export the contract response type from `api.ts` if component imports need it. Do not add a second hand-written copy of the response union.

- [ ] **Step 4: Add explicit judgment selection**

Add `selectedRecordId: string | null` and `onSelectJudgment(recordId: string)` to `WorkspaceProps` and `JudgmentPanelProps`. Add `selected` and `onSelect` to `DecisionCardProps`. Render a small button in the existing card header/meta area:

```tsx
<button
  type="button"
  className="decision-card__select"
  aria-pressed={selected}
  onClick={onSelect}
>
  {selected ? "Viewing subsequent changes" : "View subsequent changes"}
</button>
```

Do not attach selection to the entire article, because target-link and disposition controls must remain independent. Add a selected border/background rule in `components.css` without changing grid columns or pane order.

- [ ] **Step 5: Fetch selected transition data in App**

Keep the existing `diff`, `fullText`, and repository load path. Add:

```ts
const [selectedRecordId, setSelectedRecordId] = useState<string | null>(null);
const [snapshotDiff, setSnapshotDiff] = useState<SnapshotDiff | null>(null);
const [snapshotDiffLoading, setSnapshotDiffLoading] = useState(false);
const [snapshotDiffError, setSnapshotDiffError] = useState<ReviewApiError | Error | null>(null);
```

When `openFile` changes path, clear the selected record and transition state. Implement `selectJudgment(recordId)` only for the current `selectedPath`; set the selected ID, clear transition error, call `api.getSnapshotDiff(recordId, selectedPath)`, and use the request token to discard stale responses. For `legacy-fallback`, clear `snapshotDiff` and leave the existing repository diff in place. For `snapshot-resolved`, store the result and let the central view render it. For an unresolved transition response, convert it into an error object without populating `fullText`.

When no judgment is selected, clear transition state and keep the current repository diff. Reset the new state in `resetSession`. Pass all state and callbacks through `Workspace` to `JudgmentPanel` and `DiffView`.

- [ ] **Step 6: Render transition data in DiffView**

Add an optional `snapshotDiff` prop plus loading/error props. Reuse the existing `LineRow`, anchor, scrolling, binary, and empty-state patterns. In snapshot mode:

- Header shows the selected path, `before snapshot`, and either `next snapshot` with its short Git SHA/time or `after: working tree`.
- Hunk rows use the existing old/new line model.
- A no-hunk resolved result says there were no changes between the selected judgment and the next state.
- `binary=true` uses the existing binary message.
- Error state does not render repository `fullText`.

Use a transition anchor helper in `decision-index.ts` that maps the selected target lines to the `old` side. Keep `decisionAnchors(detail)` unchanged for repository mode.

- [ ] **Step 7: Run the full UI suite**

Run: `bun run --cwd apps/review-ui test`

Expected: PASS, including existing theme, explorer, diff, judgment, and App tests.

- [ ] **Step 8: Review checkpoint**

Verify the page still has the Explorer, central DiffView, and JudgmentPanel in the existing order; selecting a judgment changes only the central data source and card state; disposition, target navigation, block filters, retries, and legacy records still behave as before.

### Task 8: Document the behavior and add end-to-end regression coverage

**Files:**
- Modify: `README.md:284-322,324-344`
- Modify: `tests/e2e/review-flow.spec.ts`
- Modify: `tests/e2e/security-boundaries.spec.ts` for automatic-capture route security cases
- Generated: `plugins/claude-code/bin/adapter.mjs` only through `bun run build:claude-plugin`

**Interfaces:**
- Consumes: all prior tasks and the approved spec.
- Produces: user-facing Japanese documentation, an end-to-end proof of before/next/worktree comparison, and a clean generated Claude plugin bundle.

- [ ] **Step 1: Add the failing E2E scenario**

Use the existing Playwright recorder harness rather than starting an unrelated server. The scenario must:

1. Create a repository with a committed target file.
2. Register two sessions/records for the same repository path.
3. Submit an automatic before snapshot for the first record.
4. Change the file and submit the next automatic snapshot for the second record.
5. Open the repository and file in the UI.
6. Select the first judgment from the judgment list.
7. Assert that the central diff shows the before/next labels and changed lines.
8. Delete or omit the second capture in a second case and assert `after: working tree`.

If the current E2E harness cannot invoke the new API directly, use its existing authenticated `request` helper to seed the rows; do not bypass the Recorder database.

- [ ] **Step 2: Run the focused E2E test and verify the new scenario fails**

Run: `bunx playwright test tests/e2e/review-flow.spec.ts`

Expected: FAIL until the routes, UI selection, and generated UI build are complete.

- [ ] **Step 3: Document automatic capture and comparison**

In the Japanese snapshot section of `README.md`, explain:

- Direct edits through installed Claude Code/OpenCode gates save an edit-before automatic snapshot.
- The edit is blocked when the Recorder cannot save that snapshot.
- A selected judgment is compared with the next automatic snapshot for the same repository/path, or the current worktree when there is no next capture.
- Existing manual snapshots remain explicit and are not part of this chain.
- Existing records without automatic captures keep the legacy display.

Document the two endpoint request/response shapes and state that automatic-capture requests are intended for the installed local adapters, not for arbitrary content injection.

- [ ] **Step 4: Run all verification commands**

Run in order:

```bash
bun run build
bun run build:claude-plugin
bun run test
bun run e2e
```

Expected: all commands pass. Inspect `git diff --check`, `git status --short`, and generated bundle changes after the commands. Do not add `.ai-review/`, tokens, SQLite files, snapshots, or unrelated worktree changes.

- [ ] **Step 5: Perform the manual smoke check**

Start the Recorder with a separate UI root as documented in `CLAUDE.md`. With a small fixture repository, verify:

- An accepted direct edit creates an automatic capture before the edit.
- The capture has a normalized source path and sequence.
- A second judgment for the same file becomes the next comparison endpoint.
- Without a second capture, the current worktree is used.
- Stopping/removing the next source produces an explicit failure rather than a current-worktree fallback.
- The existing manual snapshot route and UI path remain available.

- [ ] **Step 6: Review checkpoint**

Report the complete test output, E2E result, changed-file list, and any residual limitations. Propose separate Conventional Commit messages for contracts/schema, Recorder, plugins, UI, and docs; wait for explicit commit authorization before creating commits.

## Plan Self-Review

- Spec sections 1-5 are covered by Tasks 1, 3, 5, and 6: contracts, pre-edit capture, fail-closed behavior, idempotency, missing files, and direct edit gates.
- Spec section 6 is covered by Tasks 1-3: v4 migration, automatic/manual distinction, source path, missing flag, sequence, and capture ID.
- Spec sections 7-8 are covered by Tasks 4, 5, and 7: cross-session next lookup, explicit failure states, transition response, judgment selection, and unchanged three-pane UI.
- Spec section 9 and the security invariants are repeated in Global Constraints and tested in Tasks 2, 5, 6, and 8.
- Spec sections 10-11 are mapped to concrete edge-case tests in Tasks 3-5 and UI/E2E tests in Tasks 7-8.
- Spec sections 12-13 are covered by the task order and final verification commands.
- There are no unresolved placeholders or unnamed implementation dependencies. The response types and method names are defined before later tasks consume them.
- The existing v3 migration index-order hazard is explicitly avoided by creating indexes only after renaming the rebuilt table.
