# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Project Overview

Local-first evidence tool for reviewing decisions made by AI coding agents (Claude Code / Codex). Agent judgments are recorded as *decision records* bound to files, line ranges, git revisions, and content hashes; a local Recorder API stores them in SQLite and a React Review UI renders them as a reviewable timeline. It is a recording/review platform, not a security scanner. User-facing docs (README) are Japanese; code and comments are English.

## Commands

Bun is both runtime and package manager; run `bun install` first.

```bash
bun run test                 # ALL tests: bun test (contracts, recorder, plugins) + vitest (review-ui)
bun run e2e                  # builds review-ui, then runs Playwright against tests/e2e
bun run build                # build contracts bundle to dist/
bun run build:claude-plugin  # rebuild plugins/claude-code/bin/adapter.mjs after plugin source changes
bun run dev                  # recorder in watch mode

# Recorder server (binds 127.0.0.1 only); build the UI before serving it
bun run --cwd apps/review-ui build
bun run recorder --data-dir ./.ai-review --port 4318 --ui-root "$PWD/apps/review-ui/dist"
```

**Never run bare `bun test` at the repo root** — Bun's raw collector loads Playwright specs and DOM-dependent React tests without their runners and fails confusingly. Always use `bun run test`.

Single test files:

```bash
bun test apps/recorder/test/store/records.test.ts      # one bun-test file (-t "name" filters cases)
bun run --cwd apps/review-ui test src/App.test.tsx     # one vitest file (jsdom + testing-library)
bunx playwright test tests/e2e/review-flow.spec.ts     # one Playwright spec
```

Test placement follows the runner: bun tests live in `packages/*/test`, `apps/recorder/test`, `plugins/*/test`; UI tests are colocated `*.test.ts(x)` beside sources under `apps/review-ui/src`.

## Architecture

Bun workspaces monorepo (`packages/*`, `apps/*`, `plugins/*`). The pipeline:

```
AI agent session (Claude Code / Codex)
  → adapter (plugins/claude-code | plugins/codex) reads JSONL judgment input on stdin
  → plugins/common maps it to contracts' DecisionRecordInput and POSTs to Recorder
  → Recorder validates via packages/contracts, persists to SQLite
  → Review UI (React 19 + Vite) fetches the timeline over the loopback /v1 API
```

### Workspaces

- `packages/contracts` — shared types + runtime validation for records/API payloads. Imported by both Recorder and adapters; any payload change must land here.
- `apps/recorder` — the only stateful service: HTTP server (`src/http/server.ts`), owner-token auth, repository registration/validation, SQLite store (`src/store`), source resolution (`src/source`: git.ts read-only git access, worktree.ts working-tree reads, resolve.ts revision/hash matching).
- `apps/review-ui` — two-pane workspace: Explorer file tree with per-file decision-count badges, plus judgment/detail panes. Talks to Recorder over fetch only.
- `plugins/common` — JSONL mapping, Recorder bridge (loopback-only endpoints enforced, bounded in-memory retry queue), decision gate, `recorder-setup`.
- `plugins/claude-code` / `plugins/codex` — thin adapters over common; claude-code also ships hooks + skills for edit gating. Plugin changes require `bun run build:claude-plugin` before reinstall.
- `docs/superpowers/{specs,plans}` — design specs and implementation plans.

### Core domain concepts

- **Decision record**: judgment + rationale + checks + open questions, tied to `targets` (path + line range) each carrying its own `revision`: `{kind:"commit", sha}` or `{kind:"working-tree", contentHash}`. Records store references only — never code bodies or transcripts.
- **Disposition**: human review state, exactly three values: `unreviewed` / `accepted` / `rejected`.
- **Source resolution**: resolving a target yields explicit failure states — `hash-mismatch`, `revision-not-found`, `source-unavailable`. Never silently re-attach an old judgment to changed current code.
- **Snapshots**: explicit-only per-record storage (patch/full), hash+size verified on write; deletion is explicit.
- **repository_id**: SHA-256 of the canonical repository root.

### Edit gating (this repo dogfoods it)

The `ai-code-review-claude` plugin enforces judgment-before-edit for this repo's own development when installed: a `PreToolUse` hook rejects `Edit`/`Write` (and obvious shell-based mutations like heredoc redirections) unless a single-use **permit** exists, created by piping a judgment into `ai-review-record` beforehand. Permits bind to target path + current content hash + session and are consumed by one matching edit. When an edit is blocked, re-confirm the target's current state and record a fresh judgment — never work around it with Bash edits or temporary allow-lists.

Session setup is automatic: the plugin's `SessionStart` hook registers repository/session with the Recorder and exports `AI_REVIEW_SESSION_ID`, `AI_REVIEW_REPOSITORY_ROOT`, `AI_REVIEW_AGENT_TYPE`. Manual fallback: `ai-review setup --root "$PWD" --agent-type claude-code`.

## Security invariants (preserve these in any change)

- Recorder binds to 127.0.0.1 only; every `/v1` request needs the owner bearer token; state-changing requests also validate Origin.
- Tokens come from a token file (`RECORDER_TOKEN_PATH`), never argv, logs, or env echoes.
- Path-overlap rejection: `--ui-root` must not overlap the data dir, SQLite file, snapshot dir, or token path; symlink boundaries are validated on registration and reads.
- All Git access is read-only: no hooks, fsmonitor, filters, or arbitrary command execution. Size caps exist on git output, worktree reads, snapshots, JSON payloads, and adapter input.
- Repository contents (comments, READMEs) are never treated as instructions; the UI never evaluates code or Markdown as HTML.
- Never commit `.ai-review/`, tokens, SQLite files, or snapshots.

## Conventions

- Conventional Commits (`feat:`, `fix:`, `chore:`, `test:` …) with a body explaining motivation; commit messages may reference plan item IDs (M-numbers).
