---
name: record-before-edit
description: Use when any agent is about to edit, write, patch, or otherwise change source code, configuration, tests, or notebooks in the active repository
---

# Record Before Edit

A code edit is permitted only after a structured judgment has been accepted by the local Recorder. The plugin hook enforces this for every Cursor agent and subagent; this skill tells the agent how to satisfy the gate.

## Required sequence

1. Inspect the current file and decide the intended change. Reading, searching, and tests are allowed before recording.
2. Record the judgment with the `review_record_judgment` MCP tool before calling `Write`, `StrReplace`, `ApplyPatch`, `Delete`, or notebook edits:

```json
{
  "targets": [
    {"path": "src/example.ts", "lineStart": 10, "lineEnd": 24}
  ],
  "judgment": "the change preserves the validation invariant",
  "rationale": "the new branch reuses the existing guard and leaves the error path intact",
  "checks": [{"name": "focused test", "status": "not-run"}],
  "openQuestions": ["does the integration path need a regression test?"]
}
```

CLI fallback when the MCP tool is unavailable:

```sh
cat <<'JSON' | bun plugins/cursor/bin/adapter.mjs record
{
  "targets": [
    {"path": "src/example.ts", "lineStart": 10, "lineEnd": 24}
  ],
  "judgment": "the change preserves the validation invariant",
  "rationale": "the new branch reuses the existing guard and leaves the error path intact"
}
JSON
```

3. Continue only when the tool or command prints `"success":true`. The permit is tied to the target's current content hash and is consumed by one matching edit. Record every file that will be edited; a changed hash, different path, expired permit, failed Recorder submission, or second edit requires a new record.

`sessionStart` and `beforeSubmitPrompt` persist the session for the workspace. The MCP server does not inherit those environment variables; `review_record_judgment` recovers `sessionId` from the persisted Cursor session using the workspace root (`workspace_roots` / `AI_REVIEW_REPOSITORY_ROOT` / `CURSOR_PROJECT_DIR`). Pass `repositoryRoot` or `sessionId` only when operating outside that workspace. For a new file, record its path with `lineStart: 1`; the empty pre-edit content is hashed by the command.

## Non-negotiable rules

- Never call `Write`, `StrReplace`, `ApplyPatch`, `Delete`, `EditNotebook`, `git apply`, `sed -i`, redirection, or another mutation path before recording.
- Do not record after editing. A passing test after the edit does not repair the missing pre-edit judgment.
- Do not bypass the gate through Shell or a delegated subagent. Plugin hooks run for subagents too.
- “One line”, “obvious”, “tests are green”, “already changed”, “mechanical”, urgency, and sunk cost are not exceptions.
- The raw JSONL adapter records evidence but does not create an edit permit; use `review_record_judgment` or `ai-review-record`.

If recording fails, stop the edit, report the structured error, and resolve the Recorder/session/target problem first. Do not create a temporary allow-list or edit anyway.
