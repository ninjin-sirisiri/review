# AI Code Review Evidence Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build a local-first tool that records structured Claude Code/Codex judgments and links them to the exact files, lines, and Git revisions they describe.

**Architecture:** A Bun/TypeScript local Recorder owns validation, persistence, repository registration, and read-only source resolution. Thin Claude Code and Codex adapters send a shared record contract; a React review UI reads the local API and displays judgment, evidence, diff, and stale-reference warnings. Source code is resolved from registered files/Git by default, not copied into records.

**Tech Stack:** Bun runtime, TypeScript, Bun HTTP server, `bun:sqlite`, React, Vite, Bun test, Playwright.

**Spec:** `docs/superpowers/specs/2026-08-20-ai-code-review-evidence-design.md`

## Global Constraints

- Local-first; Recorder binds to `127.0.0.1` and stores data locally.
- The standard record stores references, not source-code bodies or full AI transcripts.
- The only `user_disposition` values are `unreviewed`, `accepted`, and `rejected`.
- The MVP records at least one structured session summary; adapters may emit additional explicit decision events, but never token-level or every-tool-call logs.
- Only the current working tree or a user-selected commit may be resolved; plugin requests must not trigger a full Git-history scan.
- Recorder is read-only against repositories and never runs Git hooks, builds, tests, or arbitrary commands.
- Canonicalize and validate repository roots and target paths before reading; reject root escape through symlinks or unregistered submodules.
- Never silently remap a hash-mismatched record to current code.
- Plugin/Recorder failure must not fail the AI coding operation; bounded structured-record retry is required.
- No cloud persistence, team sharing, vulnerability scanner, automatic repair, automatic merge, or always-on transcript storage in the MVP.
- Escape repository text, Markdown, and filenames before rendering in the UI.

---

## File Map

Create a Bun workspace with focused packages:

- `package.json` — workspace scripts and dependency boundaries.
- `tsconfig.json` — shared strict TypeScript configuration.
- `bunfig.toml` — Bun test/runtime configuration.
- `packages/contracts/src/records.ts` — canonical record and reference types.
- `packages/contracts/src/api.ts` — API envelopes and error codes.
- `packages/contracts/src/validation.ts` — runtime validation and normalization.
- `packages/contracts/src/index.ts` — public contract exports.
- `apps/recorder/src/config.ts` — data directory, token path, size limits, and bind address.
- `apps/recorder/src/auth/token.ts` — owner-only token creation and bearer validation.
- `apps/recorder/src/store/schema.ts` — SQLite schema and migrations.
- `apps/recorder/src/store/snapshots.ts` — explicit local patch/changed-file snapshot persistence.
- `apps/recorder/src/store/records.ts` — repository, session, decision, target, check, and disposition persistence.
- `apps/recorder/src/repositories/registry.ts` — registered repository roots and canonical path checks.
- `apps/recorder/src/source/git.ts` — fixed-argument, read-only Git access.
- `apps/recorder/src/source/worktree.ts` — safe working-tree reads and content hashes.
- `apps/recorder/src/source/resolve.ts` — revision/hash/line resolution and stale-reference states.
- `apps/recorder/src/records/service.ts` — record validation, idempotency, and source binding.
- `apps/recorder/src/queue/retry.ts` — bounded structured-record retry queue.
- `apps/recorder/src/http/server.ts` — authenticated local API routes and static UI serving.
- `apps/recorder/src/index.ts` — Recorder process entrypoint.
- `apps/review-ui/src/api.ts` — typed API client.
- `apps/review-ui/src/App.tsx` — timeline and selected-record layout.
- `apps/review-ui/src/components/DecisionList.tsx` — judgment timeline.
- `apps/review-ui/src/components/DecisionDetail.tsx` — rationale, checks, open questions, and disposition.
- `apps/review-ui/src/components/SourceReference.tsx` — file/line/diff display and stale state.
- `apps/review-ui/src/main.tsx` — UI entrypoint.
- `plugins/common/src/bridge.ts` — local Recorder transport and bounded retry behavior.
- `plugins/common/src/adapter-contract.ts` — host-neutral event-to-record mapping.
- `plugins/claude-code/src/index.ts` — Claude Code adapter entrypoint.
- `plugins/codex/src/index.ts` — Codex adapter entrypoint.
- `tests/e2e/review-flow.spec.ts` — end-to-end review and stale-reference journey.
- `playwright.config.ts` — local Recorder startup and browser test configuration.
- `tests/fixtures/repositories/*` — deterministic Git/worktree fixtures.

The adapters use a shared host-neutral JSONL input contract and a single local bridge. Each host entrypoint reads one `HostDecisionEvent` per line from stdin and emits one bounded success/error result per line; host-specific launch/configuration files only invoke that entrypoint at session finalization or an explicit judgment event and never duplicate Recorder logic.

---

### Task 1: Scaffold the workspace and canonical contracts

**Files:**
- Create: `package.json`, `tsconfig.json`, `bunfig.toml`
- Create: `packages/contracts/src/records.ts`
- Create: `packages/contracts/src/api.ts`
- Create: `packages/contracts/src/validation.ts`
- Create: `packages/contracts/src/index.ts`
- Test: `packages/contracts/test/validation.test.ts`

**Interfaces:**
- Produces `AgentType = "claude-code" | "codex"`.
- Produces `RevisionRef = { kind: "commit"; sha: string } | { kind: "working-tree"; contentHash: string }`.
- Produces `TargetReference`, `CheckEvidence`, `DecisionRecordInput`, `DecisionRecord`, `ReviewSession`, `SnapshotReference`, and `UserDisposition = "unreviewed" | "accepted" | "rejected"`.
- Produces `ApiSuccess<T>`, `ApiFailure`, and stable error codes: `UNAUTHORIZED`, `INVALID_RECORD`, `REPOSITORY_NOT_REGISTERED`, `PATH_OUTSIDE_ROOT`, `REVISION_NOT_FOUND`, `HASH_MISMATCH`, `SOURCE_UNAVAILABLE`, `DUPLICATE_RECORD`, `PAYLOAD_TOO_LARGE`.
- Root scripts are `test`, `build`, `dev`, `recorder`, and `e2e`; `recorder` accepts `--data-dir` and `--port`.

- [ ] **Step 1: Write failing validation tests** for valid commit and working-tree references, the three dispositions, missing required fields, invalid paths, invalid line ranges, and oversized text fields.
- [ ] **Step 2: Run `bun test packages/contracts/test/validation.test.ts`** and confirm the tests fail because the contract validators do not exist.
- [ ] **Step 3: Implement strict types and runtime validators**. Normalize path separators, reject absolute target paths, require positive line numbers, require a client-generated `record_id`, and return structured error codes.
- [ ] **Step 4: Add JSON serialization fixtures** proving Claude Code and Codex adapters can emit the same `DecisionRecordInput` shape without source-code bodies or transcript fields.
- [ ] **Step 5: Run the focused contract tests** and then `bun test packages/contracts`.
- [ ] **Step 6: Commit the contract package** with `git add package.json tsconfig.json bunfig.toml packages/contracts && git commit -m "feat: define review record contracts"`.

### Task 2: Implement local persistence and record service

**Files:**
- Create: `apps/recorder/src/config.ts`
- Create: `apps/recorder/src/store/schema.ts`
- Create: `apps/recorder/src/store/records.ts`
- Create: `apps/recorder/src/store/snapshots.ts`
- Create: `apps/recorder/src/records/service.ts`
- Test: `apps/recorder/test/store.test.ts`
- Test: `apps/recorder/test/record-service.test.ts`
- Test: `apps/recorder/test/snapshot-store.test.ts`

**Interfaces:**
- `RecordStore.createSession(input): Promise<ReviewSession>`
- `RecordStore.insertDecision(input): Promise<DecisionRecord>`
- `RecordStore.getDecision(recordId): Promise<DecisionRecord | null>`
- `RecordStore.listDecisions(repositoryId): Promise<DecisionRecord[]>`
- `RecordStore.setDisposition(recordId, disposition): Promise<DecisionRecord>`
- `RecordService.record(input): Promise<DecisionRecord>`
- `RecordService.setDisposition(recordId, disposition): Promise<DecisionRecord>`
- `SnapshotStore.create(recordId, mode, content): Promise<SnapshotReference>`
- `SnapshotStore.delete(snapshotId): Promise<void>`
- `SnapshotStore.get(snapshotId): Promise<{ reference: SnapshotReference; content: string } | null>`
- `RecordService.createSnapshot(recordId, mode, content): Promise<SnapshotReference>`

- [ ] **Step 1: Write failing SQLite tests** for schema creation, session insertion, decision insertion, target/check persistence, snapshot create/delete, disposition updates, and duplicate `record_id` handling.
- [ ] **Step 2: Run the focused store tests** and confirm they fail because the schema and store methods do not exist.
- [ ] **Step 3: Implement migrations** for `repositories`, `sessions`, `decision_records`, `targets`, `checks`, and `snapshots`; use foreign keys, owner-local snapshot paths, and a unique constraint on `decision_records.record_id`.
- [ ] **Step 4: Implement immutable record insertion**. Do not update judgment, rationale, target, or checks after insertion; only `user_disposition` may change.
- [ ] **Step 5: Implement the service boundary** so validation happens before a transaction and duplicate submissions return the existing record without creating a second row.
- [ ] **Step 6: Run store and service tests** and verify that a rejected record remains available for later review.
- [ ] **Step 7: Commit persistence** with `git add apps/recorder/src packages/contracts && git commit -m "feat: persist review sessions and decisions"`.

### Task 3: Add repository registry and safe source resolution

**Files:**
- Create: `apps/recorder/src/repositories/registry.ts`
- Create: `apps/recorder/src/source/git.ts`
- Create: `apps/recorder/src/source/worktree.ts`
- Create: `apps/recorder/src/source/resolve.ts`
- Test: `apps/recorder/test/registry.test.ts`
- Test: `apps/recorder/test/source-resolution.test.ts`
- Create: `tests/fixtures/repositories/committed/.gitkeep`

**Interfaces:**
- `RepositoryRegistry.register(root): Promise<RegisteredRepository>`
- `RepositoryRegistry.get(repositoryId): Promise<RegisteredRepository | null>`
- `RepositoryRegistry.assertTarget(repositoryId, relativePath): Promise<string>`
- `SourceResolver.resolve(target, source: "repository" | { snapshotId: string }): Promise<ResolvedSource | UnresolvedSource>`
- `GitReader.readCommitFile(root, sha, relativePath): Promise<string>`
- `GitReader.readDiff(root, sha): Promise<string>`
- `WorkingTreeReader.readFile(root, relativePath): Promise<{ content: string; contentHash: string }>`

- [ ] **Step 1: Create deterministic fixture repositories** with one committed file, one modified working-tree file, a root-outside symlink, and an optional unregistered submodule fixture.
- [ ] **Step 2: Write failing security tests** for canonical root registration, path traversal, absolute paths, symlink escape, unregistered submodules, and revision selection.
- [ ] **Step 3: Implement registry canonicalization** with `realpath`, root containment checks, and explicit repository IDs. Store only canonical roots.
- [ ] **Step 4: Implement fixed-argument Git access** using `Bun.spawn` with an argument array. Allow only `show`, `diff`, and read-only metadata commands; never invoke a shell, hooks, builds, or tests.
- [ ] **Step 5: Implement working-tree reads and content hashes** without following a resolved path outside the registered root.
- [ ] **Step 6: Implement resolution states**: `resolved`, `hash-mismatch`, `revision-not-found`, `source-unavailable`, and `snapshot-resolved`. A mismatch must never return the current file as a successful resolution; a snapshot is used only when the user explicitly selected it.
- [ ] **Step 7: Run registry and source-resolution tests**, including a fixture that proves no arbitrary command executes during source resolution.
- [ ] **Step 8: Commit safe source resolution** with `git add apps/recorder/src/repositories apps/recorder/src/source apps/recorder/test tests/fixtures && git commit -m "feat: resolve registered Git sources safely"`.

### Task 4: Expose the authenticated local Recorder API

**Files:**
- Create: `apps/recorder/src/auth/token.ts`
- Create: `apps/recorder/src/http/server.ts`
- Create: `apps/recorder/src/index.ts`
- Test: `apps/recorder/test/http.test.ts`

**Interfaces:**
- `POST /v1/repositories` — register a repository root.
- `POST /v1/sessions` — create a review session.
- `POST /v1/decision-records` — validate, resolve, and persist a decision.
- `GET /v1/decision-records/:recordId` — return a record with resolved source state.
- `GET /v1/decision-records` — list records for a repository.
- `PATCH /v1/decision-records/:recordId/disposition` — set one of the three dispositions.
- `GET /v1/decision-records/:recordId/source?source=repository|snapshot:<snapshotId>` — return only a validated source view or an explicit unresolved state.
- `POST /v1/decision-records/:recordId/snapshot` — body `{ mode: "changed-files" | "patch"; content: string }`; explicitly save a local snapshot.
- `DELETE /v1/snapshots/:snapshotId` — delete a locally stored snapshot.

- [ ] **Step 1: Write failing HTTP tests** for bearer authentication, loopback binding, success/error envelopes, repository registration, record creation, duplicate record submission, disposition updates, explicit snapshot create/delete, and source mismatch responses.
- [ ] **Step 2: Run the focused HTTP tests** and confirm they fail because the server and token validator do not exist.
- [ ] **Step 3: Implement owner-only token creation** under the application data directory with restrictive permissions; read the token for local plugin requests without placing it in command arguments.
- [ ] **Step 4: Implement the API router** with fixed route matching, JSON size limits, content-type validation, and the contract error codes from Task 1.
- [ ] **Step 5: Bind only to `127.0.0.1`** and reject invalid bearer tokens and disallowed browser origins for state-changing requests.
- [ ] **Step 6: Serve the built review UI as read-only source data plus explicit disposition mutations**; escape source content at the UI layer and do not evaluate repository text.
- [ ] **Step 7: Run HTTP tests and a manual smoke command** that starts the Recorder, creates a repository, posts a fixture record, fetches it, and stops the server.
- [ ] **Step 8: Commit the local API** with `git add apps/recorder/src apps/recorder/test && git commit -m "feat: add authenticated local recorder API"`.

### Task 5: Implement the shared plugin bridge and host adapters

**Files:**
- Create: `plugins/common/src/adapter-contract.ts`
- Create: `plugins/common/src/bridge.ts`
- Create: `plugins/claude-code/src/index.ts`
- Create: `plugins/codex/src/index.ts`
- Create: `plugins/common/test/bridge.test.ts`
- Test: `plugins/claude-code/test/adapter.test.ts`
- Test: `plugins/codex/test/adapter.test.ts`

**Interfaces:**
- `HostDecisionEvent` — host-neutral input with `sessionId`, `repositoryRoot`, `revision`, `targets`, `judgment`, `rationale`, `checks`, and `openQuestions`.
- `mapHostEvent(agentType, event): DecisionRecordInput` — shared normalization function.
- `RecorderBridge.submit(record): Promise<SubmitResult>` — posts to `/v1/decision-records` with local bearer authentication.
- `runAdapter(agentType, stdin, stdout): Promise<void>` — reads JSONL events and emits bounded success/error results.

- [ ] **Step 1: Write failing adapter tests** for Claude Code and Codex event fixtures mapping to byte-for-byte equivalent canonical records, excluding source bodies and transcripts.
- [ ] **Step 2: Write failing bridge tests** for successful submission, duplicate idempotency, Recorder-unavailable retry, bounded queue exhaustion, and non-blocking error reporting.
- [ ] **Step 3: Implement the shared mapper** with strict validation, stable `record_id` derivation or requirement, and no host-specific fields in the canonical record.
- [ ] **Step 4: Implement the bridge** using a fixed local URL, token-file lookup, bounded structured-record queue, exponential retry capped at a finite duration, and a user-visible failure after exhaustion.
- [ ] **Step 5: Implement the Claude Code and Codex entrypoints** as JSONL processes: read one `HostDecisionEvent` per stdin line, map it with `mapHostEvent`, submit through `RecorderBridge`, and emit one result line. The host launch configuration must send a session-finalization event and any explicit judgment events it exposes; the entrypoints must never read arbitrary repository files or duplicate Recorder validation.
- [ ] **Step 6: Run all adapter and bridge tests** with a fake Recorder; verify that Recorder downtime does not cause the adapter process to return a coding-operation failure.
- [ ] **Step 7: Commit the plugin bridge and adapters** with `git add plugins && git commit -m "feat: add Claude Code and Codex record adapters"`.

### Task 6: Build the review UI

**Files:**
- Create: `apps/review-ui/src/api.ts`
- Create: `apps/review-ui/src/App.tsx`
- Create: `apps/review-ui/src/components/DecisionList.tsx`
- Create: `apps/review-ui/src/components/DecisionDetail.tsx`
- Create: `apps/review-ui/src/components/SourceReference.tsx`
- Create: `apps/review-ui/src/main.tsx`
- Test: `apps/review-ui/src/components/DecisionDetail.test.tsx`
- Test: `apps/review-ui/src/components/SourceReference.test.tsx`

**Interfaces:**
- `ReviewApi.listDecisions(repositoryId): Promise<DecisionRecordSummary[]>`
- `ReviewApi.getDecision(recordId): Promise<DecisionRecordDetail>`
- `ReviewApi.setDisposition(recordId, disposition): Promise<DecisionRecordDetail>`
- `SourceReference` renders `resolved`, `hash-mismatch`, `revision-not-found`, and `source-unavailable` states without treating source text as HTML.

- [ ] **Step 1: Write failing component tests** for the timeline, judgment detail, three disposition states, checks/open questions, resolved source, and hash mismatch warning.
- [ ] **Step 2: Run focused UI tests** and confirm they fail because the components do not exist.
- [ ] **Step 3: Implement the typed API client** using the shared contracts and explicit error rendering; do not create a fallback that displays current code for unresolved records.
- [ ] **Step 4: Implement the timeline and detail layout** so selecting a record shows judgment, target, rationale, checks, open questions, and user disposition together.
- [ ] **Step 5: Implement source rendering** with escaped text, line numbers, diff metadata, and a prominent stale/unresolved state.
- [ ] **Step 6: Implement disposition mutations** with optimistic UI disabled until the API confirms success; show an error without changing the displayed state on failure.
- [ ] **Step 7: Run UI tests and build the static bundle** for Recorder serving.
- [ ] **Step 8: Commit the review UI** with `git add apps/review-ui && git commit -m "feat: add linked review interface"`.

### Task 7: Verify the complete local workflow and harden boundaries

**Files:**
- Create: `tests/e2e/review-flow.spec.ts`
- Create: `tests/e2e/security-boundaries.spec.ts`
- Create: `playwright.config.ts`
- Modify: `apps/recorder/src/*` only where failures identify a contract violation
- Modify: `plugins/*` only where failures identify a contract violation

**Interfaces:**
- Starts the Recorder on an ephemeral local port with a temporary data directory.
- Uses a temporary Git repository and a fake plugin bridge.
- Exercises the same HTTP and UI paths used by real adapters.

- [ ] **Step 1: Write the failing E2E journey**: create a temporary repository, register it, submit a decision, open the UI, inspect the linked line, set `accepted`, edit the file, reload, and observe `hash-mismatch`.
- [ ] **Step 2: Write failing security E2E cases** for invalid bearer token, root-outside path, symlink escape, unregistered submodule, source-text rendering, and no command execution during resolution.
- [ ] **Step 3: Run the E2E suite** and record the first failure for each acceptance criterion.
- [ ] **Step 4: Fix only contract-preserving implementation defects**; do not weaken tests or silently remap unresolved sources.
- [ ] **Step 5: Run the focused package tests, UI build, and Playwright suite** from a clean temporary data directory.
- [ ] **Step 6: Start the actual Recorder and exercise the complete workflow manually** with both adapter fixtures; verify that a failed Recorder submission does not stop the host adapter.
- [ ] **Step 7: Review the final diff for source leakage, arbitrary command execution, path traversal, missing error propagation, and accidental transcript persistence.**
- [ ] **Step 8: Commit the verification and hardening changes** with `git add . && git commit -m "test: verify local review workflow and boundaries"`.

## Verification Commands

Run after all tasks in order:

```bash
bun test
bun run build
bun run e2e
```

Run the actual local smoke flow:

```bash
bun run recorder --data-dir "$(mktemp -d)"
```

Then register a temporary Git repository, submit a fixture decision through the common bridge, open the local Review UI, confirm the linked target, edit the target file, and confirm the stale-reference warning. Stop the Recorder after the smoke flow.

## Plan Self-Review

- **Spec coverage:** Tasks 1–2 cover the record contract, local persistence, dispositions, and optional snapshots; Task 3 covers repository registration, Git/worktree resolution, hashes, symlinks, submodules, snapshot resolution, and read-only execution; Task 4 covers the authenticated local API and error envelopes; Task 5 covers both adapters, structured session summaries, retries, and non-blocking failures; Task 6 covers timeline, evidence, source links, dispositions, stale states, and escaping; Task 7 covers the required E2E and security-boundary scenarios.
- **Scope check:** The components share one canonical contract and one local Recorder, so they form one coherent vertical product plan rather than unrelated subsystem plans.
- **Placeholder scan:** No step depends on unfinished follow-up work, unbounded research, or unspecified fallback. Host adapters use the explicit shared JSON event and bridge contract; host-specific launch configuration remains thin and cannot duplicate core behavior.
- **Type consistency:** `DecisionRecordInput`, `DecisionRecord`, `TargetReference`, `RevisionRef`, `UserDisposition`, `ApiSuccess`, and `ApiFailure` are defined in Task 1 and consumed consistently by Tasks 2–7.
