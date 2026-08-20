# Task 7 Report: Complete Workflow and Security Boundaries

## Scope

Task 7 verifies the local Recorder, adapter JSONL bridge, source resolver, and built Review UI as one workflow. The suite uses a temporary data directory, ephemeral Recorder port, temporary Git repositories, actual Codex and Claude Code plugin entrypoints, and a headless Chromium browser.

The only production change is the concrete CLI contract required by the tests: Recorder now accepts `--ui-root`/`--ui-root=<path>` and passes it to the existing static UI safety validation. The E2E command installs/runs the Playwright test runner through the checked-in `@playwright/test` development dependency.

## RED evidence

The first actual Recorder E2E run started the Recorder with the required UI root and failed before startup because the CLI rejected the required `--ui-root` argument. The failing output was:

```text
Error: Recorder exited before startup (1):
```

The CLI parser had no UI-root branch at that point. The tests were retained unchanged; the parser/startup path was fixed so the same journey could reach the UI.

## Test guarantees

| Guarantee | Test | Result |
|---|---|---|
| A temporary Git repository can be registered, a session and decision can be submitted through the real Codex JSONL plugin, the public shell can be opened, linked source inspected, disposition accepted, and a later edit produces `hash-mismatch` without rendering current code | `tests/e2e/review-flow.spec.ts` complete workflow | PASS |
| Both Codex and Claude Code adapter entrypoints submit through the common bridge and return successful JSONL results | `tests/e2e/review-flow.spec.ts` adapter fixtures | PASS |
| A failed Recorder submission returns a bounded failure while the host adapter exits normally | `tests/e2e/review-flow.spec.ts` outage test | PASS |
| Public UI navigation is available while an invalid bearer is rejected by `/v1` | `tests/e2e/security-boundaries.spec.ts` bearer/UI shell test | PASS |
| Chunked JSON exceeding the configured request limit returns `PAYLOAD_TOO_LARGE` and malformed UTF-8 returns an invalid-record envelope | `tests/e2e/security-boundaries.spec.ts` request-body test | PASS |
| Root-outside paths, direct symlink escapes, parent-symlink escapes, and nested unregistered Git roots are rejected without source disclosure | `tests/e2e/security-boundaries.spec.ts` path-boundary test | PASS |
| Source text containing HTML/script markup is rendered as text and does not execute | `tests/e2e/security-boundaries.spec.ts` source-rendering test | PASS |
| A snapshot belonging to another decision record is unavailable and its content is not returned | `tests/e2e/security-boundaries.spec.ts` snapshot ownership test | PASS |
| UI root overlap with Recorder owner storage is rejected during actual Recorder startup | `tests/e2e/security-boundaries.spec.ts` overlap test | PASS |
| Oversized working-tree source and oversized patch snapshot content are bounded and not returned | `tests/e2e/security-boundaries.spec.ts` source/patch cap test | PASS |
| Revision/path filter text cannot execute shell commands or create a marker file | `tests/e2e/security-boundaries.spec.ts` command non-execution test | PASS |

## Verification commands and evidence

- `bun test apps/recorder/test plugins/common/test plugins/codex/test plugins/claude-code/test packages/contracts/test` — **93 pass, 0 fail**, 258 expectations across 10 files.
- `bun run --cwd apps/review-ui test` — **4 files / 14 tests pass**.
- `bunx tsc --noEmit` — **PASS**, no diagnostics.
- `bun run build` — **PASS**, contracts bundle generated.
- `bun run --cwd apps/review-ui build` — **PASS**, Vite production bundle generated.
- `bun run e2e` — **11 passed**, 0 failed, 1 Chromium worker. This command builds the UI first and then runs `bunx playwright test`.
- Live smoke process: `bun run recorder --data-dir <temporary-dir> --port 0` — Recorder reported an ephemeral loopback URL; repository registration and session creation returned HTTP 201; live Codex and Claude Code plugin processes each exited 0 and returned successful JSONL submissions. The Recorder was stopped after the smoke flow and no Recorder process remained.

## Files

- `playwright.config.ts`
- `tests/e2e/review-flow.spec.ts`
- `tests/e2e/security-boundaries.spec.ts`
- `apps/recorder/src/index.ts`
- `package.json` / `bun.lock`

## Concerns / intentional limits

- The Recorder API intentionally remains bearer-protected and mutation Origin-protected; the UI token is only held in React state and is not persisted or placed in the URL.
- The source/patch cap E2E verifies the public HTTP contracts (large live source is suppressed and oversized patch snapshot content is rejected). Existing focused source-resolution tests continue to cover the internal Git diff algorithm's work and output bounds.
- No formatters, linters, or project-wide test suites were run, per Task 7 instructions.

## Reviewer follow-up

The follow-up pass tightened three assertion gaps without weakening the original tests:

- Path-boundary cases now assert each actual HTTP status, error code, and response body excludes the outside secret text.
- The complete journey now fetches the accepted decision through the authenticated API, verifies persisted `user_disposition: "accepted"`, reloads after editing, then verifies the API source state is `hash-mismatch` and excludes current source content.
- Snapshot content-limit verification now runs a separate Recorder fixture created with `createRecorderConfig({ maxSnapshotBytes: 64 })`; its 65-byte patch body is below the 1,000,000-byte JSON request limit and receives the snapshot-specific `PAYLOAD_TOO_LARGE` response.

Post-follow-up verification:

- `bunx tsc --noEmit` — PASS.
- `node node_modules/@playwright/test/cli.js test tests/e2e/security-boundaries.spec.ts --config=playwright.config.ts` — 8 passed.
- `node node_modules/@playwright/test/cli.js test tests/e2e/review-flow.spec.ts --config=playwright.config.ts` — 3 passed.
- Final focused package tests — 93 passed; UI tests — 14 passed; UI build — PASS.
- Final `bun run e2e` — 11 passed.
- Final live smoke — repository/session HTTP 201; Codex and Claude Code adapters each exited 0 with successful submission envelopes.
