# Task 3 Implementation Report

## Summary

Implemented repository registration and safe source resolution for registered Git working trees. The implementation canonicalizes repository roots, persists explicit repository identities, rejects traversal and symlink escapes, blocks unregistered nested repositories, uses fixed-argument read-only Git commands, hashes working-tree content, and returns explicit resolution states for resolved, stale, missing-revision, unavailable, and explicitly selected snapshot sources.

HTTP, plugins, UI, and arbitrary command execution remain intentionally out of scope.

## Changed files

- `apps/recorder/src/repositories/registry.ts`
  - Added `RepositoryRegistry.register`, `get`, and `assertTarget`.
  - Canonicalizes roots with `realpath` before persistence.
  - Derives a stable SHA-256 repository ID when no explicit ID is supplied and accepts explicit IDs.
  - Enforces lexical containment, canonical symlink containment, canonical-root stability, normalized relative paths, and nested repository/submodule registration boundaries.
  - Added `SourceResolutionError` with the shared error codes.

- `apps/recorder/src/source/git.ts`
  - Added fixed-argument `Bun.spawn` Git access.
  - Restricts operations to `cat-file` metadata validation, `show`, and `diff` with external diff/text conversion disabled.
  - Reads commit files and working-tree diffs without a shell, hooks, builds, tests, or arbitrary command strings.
  - Maps missing revisions to `REVISION_NOT_FOUND` and unavailable Git content to `SOURCE_UNAVAILABLE`.

- `apps/recorder/src/source/worktree.ts`
  - Added canonical, containment-checked working-tree reads.
  - Rejects traversal, absolute/drive-relative paths, missing files, directories, and root-outside symlinks.
  - Returns UTF-8 content and SHA-256 `contentHash` values.

- `apps/recorder/src/source/resolve.ts`
  - Added `SourceResolver`, `ResolvedSource`, `UnresolvedSource`, and `ResolutionState`.
  - Resolves commit and working-tree targets only after registry target validation.
  - Returns `resolved`, `hash-mismatch`, `revision-not-found`, and `source-unavailable` states.
  - Returns `snapshot-resolved` only when the caller explicitly supplies `{ snapshotId }`.
  - Does not return current content as successful content after a hash mismatch.
  - Delegates snapshot size, owner-local containment, and tamper checks to `SnapshotStore.get`.

- `apps/recorder/test/registry.test.ts`
  - Added deterministic temporary Git fixture setup.
  - Covers canonical root persistence, registered target resolution, traversal, POSIX absolute, Windows drive-relative, UNC-style, symlink escape, and unregistered nested repository rejection.

- `apps/recorder/test/source-resolution.test.ts`
  - Added deterministic commit/modified-working-tree fixtures.
  - Covers commit resolution, working-tree resolution, hash mismatch, missing revision, missing source, explicit snapshot resolution, oversized/tampered snapshot rejection, traversal/absolute/drive-relative/symlink rejection, Git diff reads, working-tree hashes, and a malicious revision string proving no arbitrary command executes.

- `tests/fixtures/repositories/committed/.gitkeep`
  - Added the committed-repository fixture marker required by the task layout.

## Commands and results

1. `bun test apps/recorder/test/registry.test.ts` (initial RED run)
   - Expected failure because `apps/recorder/src/repositories/registry.ts` did not exist.
   - Result: `0 pass, 1 fail, 1 error`.

2. `bun test apps/recorder/test/source-resolution.test.ts` (initial RED run)
   - Expected failure because Task 3 source modules did not exist.
   - Result: `0 pass, 1 fail, 1 error`.

3. `bun test apps/recorder/test/registry.test.ts apps/recorder/test/source-resolution.test.ts` (focused GREEN run)
   - Result: `13 pass, 0 fail, 34 expect() calls`.

4. `bun test apps/recorder/test/registry.test.ts apps/recorder/test/source-resolution.test.ts` (final post-commit verification)
   - Result: `13 pass, 0 fail, 34 expect() calls`.

No formatter, linter, or project-wide test suite was run, per the task boundary.

## Commits

- `7cfae8c` — Task 2 persistence boundary (`fix: harden local persistence boundaries`), consumed by this task.
- `08e2284` — Task 3 implementation (`feat: resolve registered Git sources safely`).

## Concerns

- The repository ID format is deterministic SHA-256 of the canonical root when callers do not provide an explicit ID; the API also accepts caller-supplied IDs.
- Source reads operate on text content and return UTF-8 strings. Binary source files are not a separate typed path.
- Git repository-local configuration and attributes remain available for read-only metadata discovery; applicable diff filters are explicitly neutralized before `git diff`.
- TypeScript compilation and later HTTP/plugin/UI suites were intentionally not run because the assignment required focused source-resolution tests only.

## Fix Round 1 Report


Addressed all seven review findings in commit `d56d1da` (`fix: harden source resolution boundaries`).

### Findings addressed

1. **Nested Git discovery**
   - Registration now performs fixed-argument `git rev-parse --show-toplevel` metadata discovery.
   - A directory nested under a different parent checkout is rejected with `PATH_OUTSIDE_ROOT`.
   - Git readers independently verify that the discovered Git worktree root is exactly the registered canonical root before reading.

2. **Explicit snapshots with missing live roots**
   - `SourceResolver` now branches on explicit `{ snapshotId }` selection before live repository validation.
   - Owner-local `SnapshotStore.get` remains responsible for canonical containment, pre-read byte limits, and content-hash tamper checks.
   - A valid explicit snapshot resolves after the live repository root is removed.

3. **Unavailable registered roots**
   - Missing/inaccessible registered roots now return the declared `source-unavailable` unresolved state for repository source requests.
   - Unregistered repositories and unsafe target paths continue to reject through the shared error contracts.

4. **Repository-configured Git filters**
   - `readDiff` discovers applicable `filter=<name>` attributes using read-only `ls-files` and `check-attr` metadata calls.
   - It passes fixed `-c` overrides for each discovered filter's clean, process, smudge, and required settings, preventing configured filter commands from executing.
   - Regression coverage configures a malicious clean filter that would create a marker; the marker is not created.

5. **Bounded live-source reads**
   - Added `DEFAULT_MAX_SOURCE_CONTENT_LENGTH = 4 * 1024 * 1024` (4 MiB) with `maxSourceContentLength`/`maxSourceBytes` configuration.
   - Working-tree reads reject files over the limit from `stat` before loading content.
   - Git stdout and stderr are drained through bounded readers before conversion to strings; oversized metadata, commit output, diff output, and error output are rejected with `PAYLOAD_TOO_LARGE`.
   - `SourceResolver` uses the configured store limit and maps live size failures to `source-unavailable`.

6. **Git failure classification**
   - Git worktree discovery failures and root mismatches are `SOURCE_UNAVAILABLE`.
   - A valid Git repository with an unknown revision is `REVISION_NOT_FOUND`.
   - Corrupt/unavailable Git object failures are classified as `SOURCE_UNAVAILABLE` unless Git reports a missing/unknown revision.

7. **Repository ID conflicts**
   - Registration now rejects an explicit ID already bound to a different canonical root with `INVALID_RECORD`.
   - Re-registering the same canonical root remains idempotent.
   - A pre-existing null-root repository row can be filled by registration.

### Fix-round verification

- `bun test apps/recorder/test/registry.test.ts apps/recorder/test/source-resolution.test.ts`
  - Result: `20 pass, 0 fail, 45 expect() calls`.
- `bun x tsc --noEmit`
  - Result: completed successfully with no output.
- No formatter, linter, or project-wide suite was run.

### Fix-round files

- `apps/recorder/src/config.ts`
- `apps/recorder/src/repositories/registry.ts`
- `apps/recorder/src/source/git.ts`
- `apps/recorder/src/source/resolve.ts`
- `apps/recorder/src/source/worktree.ts`
- `apps/recorder/test/registry.test.ts`
- `apps/recorder/test/source-resolution.test.ts`

### Fix-round concerns

- Git diff filter neutralization now scans configured local filter drivers directly; untracked files remain outside `git diff` output.
- Git output is bounded before string buffering, but a Git process is allowed to finish while oversized streams are drained to avoid child-process pipe deadlocks.
- Binary files remain represented through UTF-8 text APIs rather than a separate binary result type.

## Fix Round 2 Report

Addressed both remaining P1 findings in commit `4a95b2a` (`fix: close source read safety gaps`).

### Findings addressed

1. **Complete Git filter neutralization**
   - Replaced attribute-value allowlisting with a read-only local Git-config scan: `git config --local --get-regexp "^filter\\..+\\.(clean|process|smudge|required)$"`.
   - Every configured filter driver name is captured without a restrictive character allowlist, and fixed `-c` overrides clear clean/process/smudge commands and set `required=false` for each driver.
   - Added a regression fixture using the previously bypassing `evil+driver` name. Its configured marker-producing clean command does not execute during `git diff`.

2. **Bounded working-tree streaming**
   - `WorkingTreeReader` now consumes `Bun.file(...).stream()` through a bounded byte reader, draining but never retaining bytes beyond `maxBytes`.
   - UTF-8 decoding and SHA-256 hashing remain unchanged for accepted content.
   - The existing `stat` guard remains an early rejection, while the stream guard handles growth races and providers whose emitted bytes exceed the configured limit.
   - Added a deterministic growth-stream regression fixture that emits 9 bytes against an 8-byte limit after a small on-disk stat result.

### Fix-round verification

- `bun test apps/recorder/test/registry.test.ts apps/recorder/test/source-resolution.test.ts`
  - Result: `22 pass, 0 fail, 47 expect() calls`.
- `bun x tsc --noEmit`
  - Result: completed successfully with no output.
- No formatter, linter, or project-wide suite was run.

### Fix-round concerns

- Diff generation no longer consults or neutralizes filter configuration; it reads committed blobs and raw working-tree files without invoking Git's filter pipeline.
- Oversized working-tree streams are drained after the cap is crossed so child/readable resources close cleanly without buffering additional bytes.

## Fix Round 3 Report

Addressed the remaining filter-isolation finding in commit `b7beca6` (`fix: isolate Git diff from repository filters`).

### Finding addressed

**Filter-free diff strategy**

- Removed reconstruction of arbitrary `filter.<driver>.*` config keys and the associated local-config scan.
- `GitReader.readDiff` now uses only read-only Git metadata/blob operations (`ls-tree`, `ls-files`, and `show`) and computes a bounded text diff from the committed blobs and raw working-tree files.
- The strategy does not invoke `git diff`, Git clean/process/smudge filters, repository-local filter commands, or worktree-local filter commands at all.
- Working-tree content continues through the containment-checked, bounded `WorkingTreeReader`.
- Added a fixture with `extensions.worktreeConfig` and a worktree-local filter driver named `evil=driver`; its marker-producing command is not executed.

### Fix-round verification

- `bun test apps/recorder/test/registry.test.ts apps/recorder/test/source-resolution.test.ts`
  - Result: `23 pass, 0 fail, 48 expect() calls`.
- `bun x tsc --noEmit`
  - Result: completed successfully with no output.
- No formatter, linter, or project-wide suite was run.

### Fix-round concerns

- The generated diff preserves standard headers and changed-line content but is intentionally a bounded text diff rather than Git's filter-aware patch formatter.
- Untracked files remain outside the committed-tree/worktree file set represented by this read-only diff.

## Fix Round 4 Report

Addressed the residual filter-free diff-generation correctness findings in commit `89335ab` (`fix: harden filter-free source diffs`).

### Findings addressed

1. **Literal repository paths**
   - `ls-tree -z` and `ls-files -z` results now remain literal, including backslashes, instead of passing through user-input path normalization.
   - Enumerated paths receive a separate lexical containment check before they are joined to the canonical root.

2. **Tracked symlinks**
   - Working-tree reads now use `lstat` and `readlink` for symlinks, returning link-target text without resolving or reading the target.
   - Outside-root and dangling symlink targets therefore cannot cause external reads or fabricated deletion patches.

3. **Committed blob failures**
   - `readCommitBlob` now classifies every failed committed-object read as `SOURCE_UNAVAILABLE`.
   - `readDiff` uses tree membership to distinguish actual additions/deletions from failed blob reads.

4. **Missing versus unreadable worktree paths**
   - A dedicated internal missing-path error is emitted only for `ENOENT`/`ENOTDIR` path absence.
   - Permission and stream/read failures remain `SOURCE_UNAVAILABLE`; only the dedicated missing-path error becomes a deletion in `readDiff`.

5. **Separated line edits**
   - Replaced prefix/suffix-only diff construction with a line-level Myers diff and unified hunks with unchanged context lines.
   - Separated edits retain independent accurate hunks rather than converting unchanged intervening lines into removals/additions.

### Regression coverage

- Literal backslash Git filename.
- Tracked symlink whose target is outside the registered root.
- Corrupt committed blob.
- Unreadable worktree stream.
- Absent tracked worktree path deletion.
- Two separated line edits with separate hunks.

### Verification

- `bun test apps/recorder/test/registry.test.ts apps/recorder/test/source-resolution.test.ts`
  - Result: `29 pass, 0 fail, 66 expect() calls`.
- `bun x tsc --noEmit`
  - Result: completed successfully with no output.
- No formatter, linter, or project-wide suite was run.

### Concerns

- Diff output remains bounded to the existing 4 MiB cap and is intentionally a filter-free text diff rather than Git's filter-aware formatter.
- Binary and unusual-byte source content continues to use the existing UTF-8 text API.
- Untracked files remain outside the committed-tree/index path set represented by this read-only diff.

## Final Fix Round Report

Addressed the two remaining Task 3 P1 findings without changing the filter-free, raw-blob/raw-worktree diff design.

### Findings addressed

1. **Parent symlink traversal**
   - `WorkingTreeReader.readEnumeratedFile` now walks every parent component with `lstat` before inspecting the final tracked path.
   - Intermediate symlinks are rejected as `SOURCE_UNAVAILABLE`; non-directory parents retain the existing absent-path classification, while only the final tracked symlink is read with `readlink` and returned as link-target text.
   - Added a regression that replaces an indexed `src` directory with an outside symlink, verifies the read is rejected, and uses a file provider seam to prove no external file stream is opened.
2. **Unbounded Myers trace growth**
   - Added a bounded per-file diff-work budget derived from the configured source byte limit and capped at 8 MiB worth of work units.
   - The Myers implementation accounts for frontier construction, diagonal exploration, and equality-snake traversal before retaining additional trace state.
   - A budget exhaustion returns the existing structured `PAYLOAD_TOO_LARGE` error instead of constructing an unbounded trace or continuing quadratic work.
   - Added a dense-change regression with 2,200 fully changed lines that proves the reader rejects boundedly while the resulting patch remains below the byte cap.

### Verification

- `bun test apps/recorder/test/registry.test.ts apps/recorder/test/source-resolution.test.ts`
  - Result: `31 pass, 0 fail, 70 expect() calls`.
- `bun x tsc --noEmit`
  - Result: completed successfully with no output.
- No formatter, linter, or project-wide suite was run.

### Final fix concerns

- Dense diffs that exceed the bounded work budget are intentionally reported as `PAYLOAD_TOO_LARGE`, even when their eventual textual patch could fit under the byte cap.
- Diff generation remains filter-free and uses raw committed blobs plus raw worktree entries; tracked final symlinks remain represented by literal link-target text.
