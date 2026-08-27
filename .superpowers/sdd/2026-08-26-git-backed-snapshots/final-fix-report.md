# Git-Backed Snapshots Final Fix Report

Date: 2026-08-27
Branch: `feat/git-backed-snapshots`
Review package: `review-9babf24..3a32371.diff`

## Changed Files

- `apps/recorder/src/source/gitbacked.ts`
- `apps/recorder/src/source/git.ts`
- `apps/recorder/src/source/resolve.ts`
- `apps/recorder/test/gitbacked-detect.test.ts`
- `apps/recorder/test/http.test.ts`
- `apps/recorder/test/source-resolution.test.ts`

## Finding Resolutions

### 1. Registered repository identity and boundary

- `detectGitBackable` now calls `registry.assertTarget(record.repository_id, target.path)` immediately before each candidate read.
- Boundary, containment, symlink, and registered-root replacement failures return `null` for the complete detection probe rather than being treated as an ordinary unreadable candidate.
- `SourceResolver.resolveGitBackedSnapshot` validates the referenced `source_path` with `registry.assertTarget` before reading Git history. `SourceResolutionError` boundary failures become an explicit `source-unavailable` result.
- The check is inside the git-backed helper, not only in the caller path, so snapshot resolution remains protected after registry/worktree state changes. File-backed snapshots still bypass repository access and retain their existing behavior.
- Regression tests move the registered Git root and replace its original path with a symlink to the moved checkout. Detection returns `null`, and git-backed resolution returns `source-unavailable` instead of reading the replacement path.

### 2. Git blob byte integrity

- `GitReader.readCommitFile` now reads blob stdout with `TextDecoder` options `{ fatal: true, ignoreBOM: true }`.
- Invalid UTF-8 is mapped to `GitReaderError(SOURCE_UNAVAILABLE)`; it cannot be normalized into replacement characters and then hashed as valid snapshot content.
- BOM-preserving/fatal decoding is scoped to commit-file reads. Metadata and ordinary diff reads retain the existing permissive decoder path and existing byte limits.
- Real temporary Git fixtures verify that a BOM-prefixed committed file matches only submitted content containing the BOM, and that invalid UTF-8 cannot be read, detected, or resolved as replacement text.

### 3. SHA-256 repository compatibility

- Detection now requires the resolved `HEAD` ID to match lowercase `/^[0-9a-f]{40}$/` before reading candidates or returning an eligible target.
- A 64-character HEAD therefore returns `null` from detection, allowing the existing file-backed snapshot path to return `201` rather than attempting invalid git-reference persistence.
- The detector has a focused injected-reader regression test, and the HTTP suite has a real `git init --object-format=sha256` fixture that verifies `201`, `mode: "patch"`, no `base_sha`, and successful file-backed snapshot resolution.

### 4. Unexpected git helper rejection containment

- `resolveSnapshot` now uses `return await this.resolveGitBackedSnapshot(...)` inside its existing `try` block.
- An unexpected rejection from the git-backed helper is converted to the existing snapshot-unavailable response path. The helper still preserves `revision-not-found` for a `GitReaderError` with `REVISION_NOT_FOUND`.

## TDD Evidence

Baseline focused tests before adding regressions:

- `bun test apps/recorder/test/gitbacked-detect.test.ts`: 2 pass, 0 fail.
- `bun test apps/recorder/test/source-resolution.test.ts`: 31 pass, 0 fail.
- `bun test apps/recorder/test/http.test.ts`: 26 pass, 0 fail.

RED after adding the regression assertions and before production fixes:

- `gitbacked-detect.test.ts`: 4 failures, 2 passes. The pre-fix detector read the replacement root, stripped the BOM, accepted replacement text for invalid bytes, and returned a 64-character git target.
- `source-resolution.test.ts`: 3 failures, 31 passes. The pre-fix resolver read the replaced root, resolved invalid-byte replacement text, and allowed an unexpected helper rejection to escape.
- `http.test.ts`: 1 failure, 26 passes. The pre-fix SHA-256 snapshot POST returned `422` instead of falling back to `201`.

The invalid-byte fixtures initially encountered an environment Git hook/`awk` multibyte conversion failure during commit setup. The tests use Git's `--no-verify` option only for those raw-byte fixture commits so the intended RED assertions exercise the read path deterministically.

GREEN after the production changes:

- `bun test apps/recorder/test/gitbacked-detect.test.ts`: 6 pass, 0 fail.
- `bun test apps/recorder/test/source-resolution.test.ts`: 34 pass, 0 fail.
- `bun test apps/recorder/test/http.test.ts`: 27 pass, 0 fail.

## Verification

- `bun test apps/recorder/test`: 101 pass, 0 fail across 10 files.
- `bun run build`: success; contracts bundle generated successfully.
- `bun run build && bun run test`: Bun tests 180 pass, 0 fail across 20 files; Review UI Vitest 12 files and 86 tests passed.
- `git diff --check`: passed with no output.
- The working diff contains only the six code/test files listed above before this report is added.

## Self-Review

- The explicit snapshot selection boundary is unchanged; no snapshot discovery or auto-selection was added.
- File-backed snapshot creation, reading, deletion, size limits, path checks, authentication, Origin validation, loopback binding, and read-only Git command configuration were not changed.
- Ordinary diff operations continue to use the existing non-fatal decoder path. `readCommitFile` alone uses strict decoding for snapshot/commit content integrity.
- Detection validates the registered target before each candidate and aborts on boundary failures; ordinary missing candidate files still fall through to the next target.
- Resolution checks the actual referenced `source_path` and keeps `revision-not-found` separate from other unavailable states.
- No secrets or generated database/snapshot files were added.

## Concerns

- `bun run e2e` was not run in this fix wave; the requested focused recorder tests, full recorder suite, contracts build, and monorepo test command passed.
- Strict invalid-UTF-8 rejection is intentional and reports the committed source as unavailable rather than displaying normalized replacement characters.
