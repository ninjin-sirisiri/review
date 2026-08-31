# Review view local branch Implementation Plan

**Goal:** Let Review UI browse a local branch tip read-only when a registered repository has two or more local branches, without checkout and without changing decision records.

**Architecture:** Recorder keeps the registered root. A new `GET /v1/repositories/:id/branches` lists `refs/heads` only. Existing `files` and `diff` accept an optional `branch` short name, re-matched against `refs/heads` on that request, and use that tip as diff current. The working tree remains the default review view. The header select appears only when `branches.length >= 2`.

**Tech Stack:** Bun, TypeScript, contracts in `packages/contracts`, Recorder `GitReader` + HTTP, React 19 Review UI, Vitest, Playwright.

**Spec:** docs/sdd/specs/2026-08-31-review-view-local-branch-design.md

## Global Constraints

- 選択 UI を出す条件は `branches.length >= 2` のみ。
- 初期 review view は作業ツリー。
- ブランチ名の表示順はサーバーが一覧を辞書順にした結果。
- review view はタブ内メモリのみ。リロードと Clear session で作業ツリー。
- `branch` 省略は作業ツリー。予約名 `working-tree` は使わない。
- view 用に一覧外の文字列を `rev-parse` しない。view 用にクライアント提出の SHA を使わない。
- remote-tracking と tag を review view にしない。
- 新しい `ERROR_CODES` を足さない。
- 判断をブランチで絞らない。
- checkout しない。
- ワークスペース表示は `files` 到着で開始し、`branches` 完了を待たない。
- 選択変更後の Explorer は `paths` ∪ 判断索引。
- Git 実行は既存の hooksPath / fsmonitor / 環境変数制限のまま。
- 履歴全体の walk や fetch を追加しない。
- `branch` 値は、そのリクエスト時点の `refs/heads` 一覧との完全一致後にだけ使う。クライアント提出の SHA を view にしない。
- トークンは今どおりメモリのみ。ブランチ名もストレージに書かない。
- `--ui-root` と data dir の非重複、登録ルート外拒否は維持する。
- RecordStore、RepositoryRegistry、判断の source 解決、git-backed snapshot、全プラグイン、edit gate は変えない。

## File structure

| Path | Responsibility |
|---|---|
| `packages/contracts/src/api.ts` | `ReviewView`, `LocalBranch`, `BranchList`, `RepositoryFiles`; `FileDiff.new_missing` comment |
| `packages/contracts/src/validation.ts` | `validateReviewView`, `validateBranchList`, `validateRepositoryFiles` |
| `packages/contracts/test/validation.test.ts` | Contract tests for those payloads |
| `apps/recorder/src/source/git.ts` | `listLocalBranches`, `resolveLocalBranch`, `listCommitFiles`, `readPathDiff` current side |
| `apps/recorder/test/source-resolution.test.ts` | GitReader tests |
| `apps/recorder/src/http/server.ts` | `GET .../branches`; `files`/`diff` `branch` query |
| `apps/recorder/test/http.test.ts` | HTTP tests |
| `apps/review-ui/src/api.ts` | `listBranches`, `listRepositoryFiles`/`getFileDiff` `branch` |
| `apps/review-ui/src/api.test.ts` | Client tests |
| `apps/review-ui/src/lib/decision-index.ts` | Working-tree anchors only when review view is the working tree |
| `apps/review-ui/src/lib/decision-index.test.ts` | Anchor tests |
| `apps/review-ui/src/App.tsx` | Review view state, header select, reload files/diff |
| `apps/review-ui/src/App.test.tsx` | Picker visibility, switch, fallback |
| `apps/review-ui/src/styles/components.css` | Header select layout |
| `tests/e2e/review-view-branch.spec.ts` | Two-branch explorer switch |

Do not add plugin, RecordStore, or snapshot-diff query changes.

## Task 1: Contracts for branch list and files view

**Files:**
- Modify: `packages/contracts/src/api.ts`
- Modify: `packages/contracts/src/validation.ts`
- Modify: `packages/contracts/test/validation.test.ts`

**Interfaces:**
- `ReviewView` = `{ kind: "working-tree" }` or `{ kind: "local-branch"; name: string; sha: string }`
- `LocalBranch` = `{ name: string; sha: string }`
- `BranchList` = `{ repository_id: string; head_branch: string | null; branches: LocalBranch[] }`
- `RepositoryFiles` = `{ repository_id: string; view: ReviewView; paths: string[] }`
- `sha` is 40 lowercase hex. `name` is a non-empty string. If `head_branch` is a string, it must equal some `branches[].name`. If `branches` is empty, `head_branch` is `null`.
- `validateBranchList` / `validateRepositoryFiles` return the same `ValidationResult<T>` as `validateSnapshotDiffResponse`.
- Do not add error codes. Do not change decision-record types.

- [ ] **Step 1: Write the failing tests**

In `packages/contracts/src/api.ts` add the types (tests import them). In `packages/contracts/src/validation.ts` add the three validate functions so the tests compile, but make them `return failure(ERROR_CODES.INVALID_RECORD, "not implemented")` until Step 2, or omit them so Step 1 fails to compile — prefer exporting stubs that always fail so `bun test packages/contracts/test/validation.test.ts` runs red.

Add to `packages/contracts/test/validation.test.ts`:

```ts
import {
  validateBranchList,
  validateRepositoryFiles,
} from "../src/index";

const shaA = "0123456789abcdef0123456789abcdef01234567";
const shaB = "89abcdef0123456789abcdef0123456789abcdef";

describe("branch list and repository files", () => {
  test("accepts a sorted local-branch list with a matching head_branch", () => {
    const result = validateBranchList({
      repository_id: "repo-1",
      head_branch: "main",
      branches: [
        { name: "feat/x", sha: shaA },
        { name: "main", sha: shaB },
      ],
    });
    expect(result.success).toBe(true);
  });

  test("accepts an unborn repository list", () => {
    const result = validateBranchList({
      repository_id: "repo-1",
      head_branch: null,
      branches: [],
    });
    expect(result.success).toBe(true);
  });

  test("rejects head_branch that is not in branches", () => {
    const result = validateBranchList({
      repository_id: "repo-1",
      head_branch: "missing",
      branches: [{ name: "main", sha: shaA }],
    });
    expect(result.success).toBe(false);
    if (!result.success) expect(result.error.code).toBe(ERROR_CODES.INVALID_RECORD);
  });

  test("rejects a remote-style extra field and a short sha", () => {
    expect(validateBranchList({
      repository_id: "repo-1",
      head_branch: null,
      branches: [{ name: "main", sha: shaA }],
      remotes: [],
    }).success).toBe(false);
    expect(validateBranchList({
      repository_id: "repo-1",
      head_branch: null,
      branches: [{ name: "main", sha: "abc" }],
    }).success).toBe(false);
  });

  test("accepts working-tree and local-branch files payloads", () => {
    expect(validateRepositoryFiles({
      repository_id: "repo-1",
      view: { kind: "working-tree" },
      paths: ["src/a.ts"],
    }).success).toBe(true);
    expect(validateRepositoryFiles({
      repository_id: "repo-1",
      view: { kind: "local-branch", name: "feat/x", sha: shaA },
      paths: ["src/a.ts"],
    }).success).toBe(true);
  });

  test("rejects a files payload without view", () => {
    const result = validateRepositoryFiles({
      repository_id: "repo-1",
      paths: ["src/a.ts"],
    });
    expect(result.success).toBe(false);
  });
});
```

Also change the `FileDiff` comment in `api.ts` from “The working tree no longer contains this file.” to “The diff current does not contain this file.”

Run:

```bash
bun test packages/contracts/test/validation.test.ts
```

Expected: FAIL — validators missing or always invalid.

- [ ] **Step 2: Implement the types and validators**

Add to `packages/contracts/src/api.ts` (next to `FileDiff`):

```ts
export type ReviewView =
  | { kind: "working-tree" }
  | { kind: "local-branch"; name: string; sha: string };

export interface LocalBranch {
  name: string;
  sha: string;
}

export interface BranchList {
  repository_id: string;
  head_branch: string | null;
  branches: LocalBranch[];
}

export interface RepositoryFiles {
  repository_id: string;
  view: ReviewView;
  paths: string[];
}
```

Implement validators with `isRecord`, `hasOnlyKeys`, `repository_id` as non-empty string, `name` as non-empty string, `sha` matching `/^[0-9a-f]{40}$/`, `paths` as an array of non-empty strings. `view.kind === "working-tree"` allows only `{ kind }`. `view.kind === "local-branch"` requires `name` and `sha`. Export the new functions from `validation.ts` (already re-exported by `src/index.ts` via `export * from "./validation"`).

Run:

```bash
bun test packages/contracts/test/validation.test.ts
```

Expected: PASS.

- [ ] **Step 3: Regression**

```bash
bun test packages/contracts/test
```

Expected: PASS. Do not edit plugins or Recorder in this task.

## Task 2: GitReader local branches and commit trees

**Files:**
- Modify: `apps/recorder/src/source/git.ts`
- Modify: `apps/recorder/test/source-resolution.test.ts`

**Interfaces:**
- `listLocalBranches(root: string): Promise<{ head_branch: string | null; branches: LocalBranch[] }>`
- `resolveLocalBranch(root: string, name: string): Promise<LocalBranch>`
- `listCommitFiles(root: string, sha: string): Promise<string[]>` (public form of private `listTreePaths`)
- Listing uses `for-each-ref` with `refs/heads` only, through existing `execute` (hooksPath `/dev/null`, fsmonitor false, same env).
- Do not `rev-parse` the user-supplied name. `resolveLocalBranch` calls `listLocalBranches` and returns the entry whose `name` equals `name` exactly, or throws `GitReaderError(REVISION_NOT_FOUND)`.
- Omit a ref whose short name fails the existing `isSafeRevision` predicate (`length` 1–128, no leading `-`, no NUL, `^[A-Za-z0-9._/-]+$`, no `..`, no `@{`). One omitted name does not fail the whole list.
- Sort `branches` with the same algorithm as `files`: `branches.sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0))`.
- `head_branch` is the short name of the currently checked-out local branch when that name remains in `branches`; otherwise `null`.
- Do not checkout. Do not list `refs/remotes` or tags.

- [ ] **Step 1: Write the failing tests**

Add tests to `apps/recorder/test/source-resolution.test.ts` using the existing `runGit` helper. Initialize with `git init -b main --quiet`.

```ts
test("listLocalBranches returns only refs/heads, sorted, with head_branch", async () => {
  const root = await mkdtemp(join(tmpdir(), "ai-review-branches-"));
  temporaryDirectories.push(root);
  await runGit(root, ["init", "-b", "main", "--quiet"]);
  await runGit(root, ["config", "user.email", "fixture@example.test"]);
  await runGit(root, ["config", "user.name", "Fixture"]);
  await writeFile(join(root, "README.md"), "main\n", "utf8");
  await runGit(root, ["add", "--", "README.md"]);
  await runGit(root, ["commit", "--quiet", "-m", "main"]);
  const mainSha = await runGit(root, ["rev-parse", "HEAD"]);
  await runGit(root, ["branch", "feat/x"]);
  await runGit(root, ["tag", "v1"]);
  await mkdir(join(root, ".git", "refs", "remotes", "origin"), { recursive: true });
  await writeFile(join(root, ".git", "refs", "remotes", "origin", "main"), `${mainSha}\n`, "utf8");
  await runGit(root, ["update-ref", "refs/heads/weird@name", mainSha]);

  const listed = await new GitReader().listLocalBranches(root);
  expect(listed.branches.map((branch) => branch.name)).toEqual(["feat/x", "main"]);
  expect(listed.head_branch).toBe("main");
  expect(listed.branches.find((branch) => branch.name === "main")?.sha).toBe(mainSha);
  await expect(new GitReader().resolveLocalBranch(root, "feat/x")).resolves.toMatchObject({ name: "feat/x" });
  await expect(new GitReader().resolveLocalBranch(root, "origin/main")).rejects.toMatchObject({ code: "REVISION_NOT_FOUND" });
  await expect(new GitReader().resolveLocalBranch(root, "v1")).rejects.toMatchObject({ code: "REVISION_NOT_FOUND" });
  await expect(new GitReader().resolveLocalBranch(root, "weird@name")).rejects.toMatchObject({ code: "REVISION_NOT_FOUND" });
});

test("listLocalBranches is empty for an unborn repository and has null head_branch when detached", async () => {
  const unborn = await mkdtemp(join(tmpdir(), "ai-review-unborn-"));
  temporaryDirectories.push(unborn);
  await runGit(unborn, ["init", "-b", "main", "--quiet"]);
  expect(await new GitReader().listLocalBranches(unborn)).toEqual({ head_branch: null, branches: [] });

  const detached = await mkdtemp(join(tmpdir(), "ai-review-detached-"));
  temporaryDirectories.push(detached);
  await runGit(detached, ["init", "-b", "main", "--quiet"]);
  await runGit(detached, ["config", "user.email", "fixture@example.test"]);
  await runGit(detached, ["config", "user.name", "Fixture"]);
  await writeFile(join(detached, "README.md"), "x\n", "utf8");
  await runGit(detached, ["add", "--", "README.md"]);
  await runGit(detached, ["commit", "--quiet", "-m", "main"]);
  await runGit(detached, ["branch", "other"]);
  await runGit(detached, ["switch", "--detach", "--quiet", "HEAD"]);
  const listed = await new GitReader().listLocalBranches(detached);
  expect(listed.head_branch).toBe(null);
  expect(listed.branches.map((branch) => branch.name).sort()).toEqual(["main", "other"]);
});

test("listCommitFiles lists the tree at a commit, not the working tree", async () => {
  const context = await createResolverFixture();
  await writeFile(join(context.fixture.root, "src/only-worktree.ts"), "x\n", "utf8");
  const git = new GitReader();
  const commitPaths = await git.listCommitFiles(context.fixture.root, context.fixture.commitSha);
  const worktreePaths = await git.listWorktreeFiles(context.fixture.root);
  expect(commitPaths).toContain(context.fixture.path);
  expect(commitPaths).not.toContain("src/only-worktree.ts");
  expect(worktreePaths).toContain("src/only-worktree.ts");
  context.store.close();
});
```

Run:

```bash
bun test apps/recorder/test/source-resolution.test.ts
```

Expected: FAIL — `listLocalBranches` / `resolveLocalBranch` / `listCommitFiles` missing.

- [ ] **Step 2: Implement listing**

In `git.ts`:

1. Keep `isSafeRevision` as the single predicate. Use it when filtering listed names.
2. `listLocalBranches`: `verifyRepository`, then `execute(root, ["for-each-ref", "--format=%(refname:short)%00%(objectname)%00%(HEAD)", "refs/heads"])`. On oversized throw `PAYLOAD_TOO_LARGE`. On non-zero exit throw `SOURCE_UNAVAILABLE` (empty unborn repo still exits 0 with empty stdout). Parse records as newline-separated triples split on `\0`. Keep entries whose name passes `isSafeRevision` and whose object name matches `/^[0-9a-f]{40}$/`. `head_branch` is the kept name whose HEAD field is `*`, else `null`. Sort as specified.
3. `resolveLocalBranch`: `const listed = await this.listLocalBranches(root); const found = listed.branches.find((branch) => branch.name === name); if (!found) throw new GitReaderError(ERROR_CODES.REVISION_NOT_FOUND, "revision was not found"); return found;`
4. `listCommitFiles`: `verifyRepository`, `verifyRevision`, then the current `listTreePaths` body. Replace internal `listTreePaths` call sites with `listCommitFiles` or make `listTreePaths` call `listCommitFiles`.

Do not pass `name` to `rev-parse`.

Run:

```bash
bun test apps/recorder/test/source-resolution.test.ts
```

Expected: PASS for the new tests. Existing `readPathDiff` tests still pass (signature unchanged in this task).

## Task 3: GitReader diff current from a commit

**Files:**
- Modify: `apps/recorder/src/source/git.ts`
- Modify: `apps/recorder/test/source-resolution.test.ts`

**Interfaces:**
- Extend `readPathDiff(root, baseSha, relativePath, current?: { kind: "working-tree" } | { kind: "commit"; sha: string })`.
- Omit `current` or `kind: "working-tree"`: existing behavior (new side is the working tree).
- `kind: "commit"`: new side is `readCommitBlob` at `current.sha` when that path exists in `listCommitFiles(root, current.sha)`; otherwise `new_missing: true` and empty new side. Do not read the working tree.
- `new_missing` means the diff current does not contain the path.
- Existing callers (HTTP `readPathDiff` without fourth argument, `readDiff`) stay on the working tree.

- [ ] **Step 1: Write the failing tests**

```ts
test("readPathDiff can use a commit tree as the new side instead of the working tree", async () => {
  const root = await mkdtemp(join(tmpdir(), "ai-review-diff-current-"));
  temporaryDirectories.push(root);
  await runGit(root, ["init", "-b", "main", "--quiet"]);
  await runGit(root, ["config", "user.email", "fixture@example.test"]);
  await runGit(root, ["config", "user.name", "Fixture"]);
  await mkdir(join(root, "src"), { recursive: true });
  await writeFile(join(root, "src/file.ts"), "main-version\n", "utf8");
  await runGit(root, ["add", "--", "src/file.ts"]);
  await runGit(root, ["commit", "--quiet", "-m", "main"]);
  const mainSha = await runGit(root, ["rev-parse", "HEAD"]);
  await runGit(root, ["switch", "-c", "feat/x", "--quiet"]);
  await writeFile(join(root, "src/file.ts"), "feature-version\n", "utf8");
  await writeFile(join(root, "src/only-on-feature.ts"), "feature-only\n", "utf8");
  await runGit(root, ["add", "--", "src/file.ts", "src/only-on-feature.ts"]);
  await runGit(root, ["commit", "--quiet", "-m", "feature"]);
  const featureSha = await runGit(root, ["rev-parse", "HEAD"]);
  await runGit(root, ["switch", "--quiet", "main"]);
  await writeFile(join(root, "src/file.ts"), "dirty-worktree\n", "utf8");

  const git = new GitReader();
  const vsFeature = await git.readPathDiff(root, mainSha, "src/file.ts", { kind: "commit", sha: featureSha });
  expect(vsFeature.base_sha).toBe(mainSha);
  expect(vsFeature.old_missing).toBe(false);
  expect(vsFeature.new_missing).toBe(false);
  expect(vsFeature.hunks.some((hunk) => hunk.lines.some((line) => line.type === "add" && line.content === "feature-version"))).toBe(true);
  expect(vsFeature.hunks.some((hunk) => hunk.lines.some((line) => line.content === "dirty-worktree"))).toBe(false);

  const missingOnMain = await git.readPathDiff(root, mainSha, "src/only-on-feature.ts", { kind: "commit", sha: featureSha });
  expect(missingOnMain.old_missing).toBe(true);
  expect(missingOnMain.new_missing).toBe(false);

  const missingOnFeature = await git.readPathDiff(root, featureSha, "src/only-on-feature.ts", { kind: "commit", sha: mainSha });
  expect(missingOnFeature.old_missing).toBe(false);
  expect(missingOnFeature.new_missing).toBe(true);

  const worktree = await git.readPathDiff(root, mainSha, "src/file.ts");
  expect(worktree.hunks.some((hunk) => hunk.lines.some((line) => line.content === "dirty-worktree"))).toBe(true);
});
```

Run:

```bash
bun test apps/recorder/test/source-resolution.test.ts
```

Expected: FAIL — fourth argument ignored or missing; new side still the worktree.

- [ ] **Step 2: Implement commit current**

In `readPathDiff`, after reading the base blob from `baseSha`:

```ts
type DiffCurrent = { kind: "working-tree" } | { kind: "commit"; sha: string };

async readPathDiff(
  root: string,
  sha: string,
  relativePath: string,
  current: DiffCurrent = { kind: "working-tree" },
): Promise<FileDiff> {
  // existing base-side read using listCommitFiles(root, sha)
  if (current.kind === "commit") {
    await this.verifyRevision(root, current.sha);
    const currentPaths = new Set(await this.listCommitFiles(root, current.sha));
    if (currentPaths.has(normalizedPath)) {
      currentContent = await this.readCommitBlob(root, current.sha, normalizedPath);
      newMissing = false;
    } else {
      currentContent = "";
      newMissing = true;
    }
  } else {
    // existing WorkingTreeReader path
  }
}
```

Do not call `WorkingTreeReader` when `current.kind === "commit"`.

Run:

```bash
bun test apps/recorder/test/source-resolution.test.ts
```

Expected: PASS.

## Task 4: HTTP branches, files view, and diff branch

**Files:**
- Modify: `apps/recorder/src/http/server.ts`
- Modify: `apps/recorder/test/http.test.ts`

**Interfaces:**
- `GET /v1/repositories/:id/branches` → `success(BranchList)` with `repository_id` from the registered repo.
- `GET /v1/repositories/:id/files` includes `view`. Omit `branch` → `{ kind: "working-tree" }` and `listWorktreeFiles`. Present `branch` after `trim()`: empty → `422 INVALID_RECORD` field `branch`. Else `resolveLocalBranch` then `listCommitFiles` at that sha and `view: { kind: "local-branch", name, sha }`.
- `GET /v1/repositories/:id/diff`: same `branch` rules. When `branch` resolves, `readPathDiff(..., { kind: "commit", sha: branch.sha })`. When `branch` is set and `base` is omitted or `HEAD`, resolve the old side to `branch.sha` (not worktree HEAD). When `branch` is omitted, keep today’s `base` default `HEAD` and working-tree new side.
- Unknown `branch` → `404 REVISION_NOT_FOUND` via existing `errorResponse`.
- Auth and registry lookup stay as today’s `files` handler.
- Do not accept a client SHA as the view. Do not add error codes.
- Update the existing exact `files` assertion to include `view: { kind: "working-tree" }`.

- [ ] **Step 1: Write the failing tests**

In `apps/recorder/test/http.test.ts`, change the current files success assertion to expect `view: { kind: "working-tree" }` (this fails until the handler adds `view`).

Add:

```ts
test("lists local branches and serves files and diff for a named branch", async () => {
  await runGit(["init", "-b", "main", "--quiet"]);
  await runGit(["config", "user.email", "fixture@example.test"]);
  await runGit(["config", "user.name", "Fixture"]);
  await runGit(["add", "--", "src/example.ts"]);
  await runGit(["commit", "--quiet", "-m", "main"]);
  await runGit(["switch", "-c", "feat/x", "--quiet"]);
  await writeFile(join(root, "src", "feature-only.ts"), "feature\n", "utf8");
  await runGit(["add", "--", "src/feature-only.ts"]);
  await runGit(["commit", "--quiet", "-m", "feature"]);
  await runGit(["switch", "--quiet", "main"]);
  await writeFile(join(root, "src", "worktree-only.ts"), "dirty\n", "utf8");
  await request("/v1/repositories", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ root, repository_id: "repo-1" }) });

  const unauthorized = await fetch(`${app.server.url}/v1/repositories/repo-1/branches`);
  expect(unauthorized.status).toBe(401);

  const missing = await request("/v1/repositories/repo-missing/branches");
  expect(missing.status).toBe(404);

  const listed = await request("/v1/repositories/repo-1/branches");
  expect(listed.status).toBe(200);
  const listBody = await json<{ success: true; data: { head_branch: string | null; branches: Array<{ name: string; sha: string }> } }>(listed);
  expect(listBody.data.head_branch).toBe("main");
  expect(listBody.data.branches.map((branch) => branch.name)).toEqual(["feat/x", "main"]);

  const defaultFiles = await request("/v1/repositories/repo-1/files");
  const defaultBody = await json<{ success: true; data: { view: { kind: string }; paths: string[] } }>(defaultFiles);
  expect(defaultBody.data.view).toEqual({ kind: "working-tree" });
  expect(defaultBody.data.paths).toContain("src/worktree-only.ts");
  expect(defaultBody.data.paths).not.toContain("src/feature-only.ts");

  const emptyBranch = await request("/v1/repositories/repo-1/files?branch=");
  expect(emptyBranch.status).toBe(422);
  expect(await json<{ success: false; error: { code: string; field?: string } }>(emptyBranch)).toMatchObject({
    success: false,
    error: { code: "INVALID_RECORD", field: "branch" },
  });

  const unknown = await request("/v1/repositories/repo-1/files?branch=origin/main");
  expect(unknown.status).toBe(404);
  expect(await json<{ success: false; error: { code: string } }>(unknown)).toMatchObject({
    success: false,
    error: { code: "REVISION_NOT_FOUND" },
  });

  const branchFiles = await request("/v1/repositories/repo-1/files?branch=feat%2Fx");
  expect(branchFiles.status).toBe(200);
  const branchBody = await json<{ success: true; data: { view: { kind: string; name?: string }; paths: string[] } }>(branchFiles);
  expect(branchBody.data.view).toMatchObject({ kind: "local-branch", name: "feat/x" });
  expect(branchBody.data.paths).toContain("src/feature-only.ts");
  expect(branchBody.data.paths).not.toContain("src/worktree-only.ts");

  const branchDiff = await request(`/v1/repositories/repo-1/diff?path=src%2Fexample.ts&branch=feat%2Fx`);
  expect(branchDiff.status).toBe(200);
  const diffBody = await json<{ success: true; data: { base_sha: string; new_missing: boolean } }>(branchDiff);
  const featureSha = listBody.data.branches.find((branch) => branch.name === "feat/x")!.sha;
  expect(diffBody.data.base_sha).toBe(featureSha);
});
```

This test uses the existing `http.test.ts` `root`, `request`, `json`, `runGit` (`runGit` there takes only git args and uses `cwd: root`). Register after creating commits.

Run:

```bash
bun test apps/recorder/test/http.test.ts
```

Expected: FAIL — no `/branches` route; `files` has no `view`; `branch` ignored.

- [ ] **Step 2: Wire the handlers**

In `handleRequest`, add `GET` when `parts[2] === "branches"` next to the `files` route:

```ts
if (request.method === "GET" && parts.length === 3 && parts[0] === "repositories" && parts[2] === "branches") {
  const repository = await registry.get(parts[1] ?? "");
  if (repository === null) return failure(ERROR_CODES.REPOSITORY_NOT_REGISTERED, "repository is not registered", 404);
  const listed = await resolver.git.listLocalBranches(repository.root);
  return success({
    repository_id: repository.repository_id,
    head_branch: listed.head_branch,
    branches: listed.branches,
  });
}
```

Shared parse for `files` and `diff`:

```ts
function parseBranchQuery(url: URL): { ok: "omitted" } | { ok: "empty" } | { ok: "name"; name: string } {
  if (!url.searchParams.has("branch")) return { ok: "omitted" };
  const name = url.searchParams.get("branch") ?? "";
  if (name.trim().length === 0) return { ok: "empty" };
  return { ok: "name", name: name.trim() };
}
```

`files`: on `empty` return `failure(ERROR_CODES.INVALID_RECORD, "branch query parameter must be a local branch name", 422, "branch")`. On `omitted`, `listWorktreeFiles` + `view: { kind: "working-tree" }`. On `name`, `resolveLocalBranch` then `listCommitFiles(root, branch.sha)` + local-branch `view`. Sort `paths` as today.

`diff`: after `assertTarget`, parse `branch`. Empty → same 422. Omitted → `base = url.searchParams.get("base") ?? "HEAD"`, `resolveRevision`, `readPathDiff(root, baseSha, path)` (three args). Named → `resolveLocalBranch`; `rawBase = url.searchParams.get("base")`; `baseInput = rawBase === null || rawBase === "HEAD" ? branch.sha : rawBase`; `readPathDiff(root, await resolveRevision(root, baseInput), path, { kind: "commit", sha: branch.sha })`.

Run:

```bash
bun test apps/recorder/test/http.test.ts
bun test apps/recorder/test/source-resolution.test.ts
```

Expected: PASS.

## Task 5: Review UI client, header select, and anchors

**Files:**
- Modify: `apps/review-ui/src/api.ts`
- Modify: `apps/review-ui/src/api.test.ts`
- Modify: `apps/review-ui/src/lib/decision-index.ts`
- Modify: `apps/review-ui/src/lib/decision-index.test.ts`
- Modify: `apps/review-ui/src/App.tsx`
- Modify: `apps/review-ui/src/App.test.tsx`
- Modify: `apps/review-ui/src/styles/components.css`

**Interfaces:**
- Import `BranchList` and `RepositoryFiles` from contracts.
- `listBranches(repositoryId: string): Promise<BranchList>`
- `listRepositoryFiles(repositoryId: string, branch?: string): Promise<RepositoryFiles>` — omit the query when `branch` is undefined.
- `getFileDiff(repositoryId, path, base = "HEAD", branch?: string)` — append `branch` only when defined.
- Review view state is `string | null` (`null` = working tree). Memory only. Clear session and full remount (reload) reset it.
- Fetch `listBranches` in parallel with decisions and files after repository open. Show the workspace when files arrive; do not block on branches.
- Render `<label htmlFor="review-view">Review view</label>` and a `<select id="review-view">` only when `branches.length >= 2`. First option value `""` label `Working tree`. Then each `branches[].name`. If `name === head_branch`, append ` (checked out)` to the option label. Do not put `HEAD` or `current branch` in labels.
- Changing the select reloads files with that `branch` and, if a path is selected, reloads diff with the same `branch`. Explorer paths = response `paths` ∪ decision index keys. If the selected path is not in that set, clear the file selection.
- `diffBaseFor` stays as today (`HEAD` or newest commit sha). Pass `branch` as a separate argument so the server remaps omitted/`HEAD` base when a branch is selected.
- `targetAnchor(source, reviewView: "working-tree" | "local-branch" = "working-tree")`: if `reviewView === "local-branch"` and `source.revision.kind !== "commit"`, return `null`. Commit anchors stay old-side. Working-tree resolved anchors stay new-side only for `"working-tree"`.
- If files or diff returns `REVISION_NOT_FOUND` while a branch is selected, set view to working tree, show the existing inline error, and reload files without `branch`.
- Snapshot-diff calls stay unchanged.
- Default `createFetch` mock must answer `GET /v1/repositories/repo-1/branches` with one branch (or `[]`) so existing tests do not see the select, and must include `view: { kind: "working-tree" }` on files payloads.

- [ ] **Step 1: Write the failing tests**

`apps/review-ui/src/api.test.ts`:

```ts
it("lists local branches and passes branch on files and diff", async () => {
  const fetchImpl = vi.fn(async (input: RequestInfo | URL) => {
    const url = String(input);
    if (url.endsWith("/branches")) {
      return response({
        success: true,
        data: { repository_id: "repo-1", head_branch: "main", branches: [{ name: "feat/x", sha: "a".repeat(40) }, { name: "main", sha: "b".repeat(40) }] },
      });
    }
    if (url.includes("/files")) {
      return response({
        success: true,
        data: { repository_id: "repo-1", view: { kind: "local-branch", name: "feat/x", sha: "a".repeat(40) }, paths: ["src/a.ts"] },
      });
    }
    return response({
      success: true,
      data: { path: "src/a.ts", base_sha: "a".repeat(40), hunks: [], old_missing: false, new_missing: false, binary: false },
    });
  });
  const api = new ReviewApi("owner-token", { baseUrl: "http://recorder.test/", fetchImpl });
  await api.listBranches("repo-1");
  await api.listRepositoryFiles("repo-1", "feat/x");
  await api.getFileDiff("repo-1", "src/a.ts", "HEAD", "feat/x");
  expect(fetchImpl).toHaveBeenCalledWith("http://recorder.test/v1/repositories/repo-1/branches", expect.anything());
  expect(fetchImpl).toHaveBeenCalledWith("http://recorder.test/v1/repositories/repo-1/files?branch=feat%2Fx", expect.anything());
  expect(String(fetchImpl.mock.calls[2]![0])).toContain("branch=feat%2Fx");
});
```

Update the existing `listRepositoryFiles` expectation URL to stay without `branch` when the second argument is omitted. Update its mock payload to include `view: { kind: "working-tree" }` if the client starts returning `RepositoryFiles`.

`decision-index.test.ts`:

```ts
it("does not new-side anchor a resolved working-tree source when the review view is a local branch", () => {
  const source: SourceReferenceData = {
    state: "resolved",
    repository_id: "repo-1",
    path: "src/a.ts",
    revision: { kind: "working-tree", contentHash: "hash-a" },
    target: { repository_id: "repo-1", path: "src/a.ts", line_start: 2, line_end: 2, revision: { kind: "working-tree", contentHash: "hash-a" }, content_hash: "hash-a" },
    content: "x",
    content_hash: "hash-a",
  };
  expect(targetAnchor(source, "local-branch")).toBeNull();
  expect(targetAnchor(source, "working-tree")?.side).toBe("new");
});
```

In `App.test.tsx` `createFetch`, add:

```ts
if (url.endsWith("/v1/repositories/repo-1/branches")) {
  return json({ success: true, data: { repository_id: "repo-1", head_branch: "main", branches: [{ name: "main", sha: "a".repeat(40) }] } });
}
```

and add `view: { kind: "working-tree" }` to files JSON. Existing tests must still find no `Review view` combobox.

Add tests (extend `createFetch` via `overrideResponse` or a `branches` argument):

1. Two branches `{ name: "feat/x", sha: "1".repeat(40) }` and `{ name: "main", sha: "2".repeat(40) }` → after `openWorkspace`, `getByLabelText("Review view")` exists. Value is `""`. Options include `Working tree`, `feat/x`, `main (checked out)` when `head_branch` is `main`.
2. Change select to `feat/x` → `listRepositoryFiles` URL includes `branch=feat%2Fx`. If `a.ts` is open, diff URL includes `branch=feat%2Fx`.
3. Zero or one branch → no `Review view` label.
4. After selecting `feat/x`, files mock returns `REVISION_NOT_FOUND` → error alert, select returns to working tree, next files request has no `branch`.
5. Workspace heading appears even if `/branches` is held (reuse the `hold` helper on the branches URL).

Run:

```bash
bun run --cwd apps/review-ui test src/api.test.ts src/lib/decision-index.test.ts src/App.test.tsx
```

Expected: FAIL.

- [ ] **Step 2: Implement the client, anchors, and header**

`api.ts`: add `listBranches`. Add optional `branch` to files/diff using `URLSearchParams` only when `typeof branch === "string"`. Keep token in memory; do not write the branch name to storage.

`decision-index.ts`: add the second argument to `targetAnchor` and thread it through `decisionAnchors(detail, reviewView)`. `App` `currentPathEvidence` / `evidence` must pass `"local-branch"` when `reviewBranch !== null`.

`App.tsx`:
- `const [branchList, setBranchList] = useState<BranchList | null>(null);`
- `const [reviewBranch, setReviewBranch] = useState<string | null>(null);`
- After selecting a repository, `Promise.all` of `listDecisions`, `listRepositoryFiles(id)` (no branch), `listBranches(id)`. Apply files even if branches reject; store branch error in `error` without blocking explorer.
- Header select as specified. `onChange`: `const next = event.target.value === "" ? null : event.target.value; setReviewBranch(next);` then `loadFiles(..., next)` and if `selectedPath` still in the upcoming set, `openFile` with `next`. Compute the new path set from the files response plus `decisionIndex` keys after files return; clear `selectedPath` when absent.
- `loadFiles` / `openFile` take `branch: string | null` and pass it to the API.
- On `ReviewApiError` with `code === "REVISION_NOT_FOUND"` and `reviewBranch !== null`: `setReviewBranch(null)`, `setError(...)`, `loadFiles(..., null)`.
- `resetSession` clears `branchList` and `reviewBranch`.

CSS: `.app-header__view` inline-flex next to `.app-header__repo`, select uses existing input/select tokens (`min-width` ~10rem).

Run:

```bash
bun run --cwd apps/review-ui test
```

Expected: PASS, including prior workspace tests.

## Task 6: E2E branch switch

**Files:**
- Create: `tests/e2e/review-view-branch.spec.ts`

**Interfaces:**
- Playwright against a Recorder with `--ui-root` pointing at `apps/review-ui/dist` (same as `tests/e2e/review-flow.spec.ts`).
- Fixture: `git init -b main`, commit `src/main-only.ts`, branch `feat/x`, commit `src/feature-only.ts` on `feat/x`, switch back to `main`, write uncommitted `src/worktree-only.ts`.
- Register that root. Open the UI with the owner token. Review view select is visible. Default explorer contains `worktree-only.ts` and not `feature-only.ts`. Select `feat/x`. Explorer contains `feature-only.ts` and not `worktree-only.ts`.
- Do not checkout `feat/x` in the fixture after creating it; the registered worktree stays on `main`.

- [ ] **Step 1: Write the failing spec**

Copy helpers (`runCommand`, `startRecorder`, `apiRequest`, `postJson`) from `tests/e2e/review-flow.spec.ts` or import nothing and duplicate the small startup block so this file stays independent.

```ts
test("switches explorer from the working tree to a local branch tip", async ({ page }) => {
  // start recorder, create two-branch repo, POST /v1/repositories
  await page.goto(app.url);
  await page.getByLabel("Owner bearer token").fill(token);
  await page.getByRole("button", { name: "Load repositories" }).click();
  await page.getByLabel("Repository").selectOption(repositoryId);
  await page.getByRole("button", { name: "Open review timeline" }).click();
  await expect(page.getByRole("heading", { name: "Decision review" })).toBeVisible();
  await expect(page.getByRole("button", { name: /worktree-only/ })).toBeVisible();
  await expect(page.getByRole("button", { name: /feature-only/ })).toHaveCount(0);
  await page.getByLabel("Review view").selectOption("feat/x");
  await expect(page.getByRole("button", { name: /feature-only/ })).toBeVisible();
  await expect(page.getByRole("button", { name: /worktree-only/ })).toHaveCount(0);
});
```

Run (build UI first, same as package `e2e` script):

```bash
bun run --cwd apps/review-ui build
bunx playwright test tests/e2e/review-view-branch.spec.ts
```

Expected: FAIL until Task 5 is on the built UI.

- [ ] **Step 2: Confirm the journey**

No production code in this task unless the spec reveals a missing `name` on the explorer button; fix by matching the same accessible name pattern Explorer already uses (`path.split("/").at(-1)`).

Run:

```bash
bun run e2e
```

Expected: PASS, including existing `review-flow` and `security-boundaries`.

- [ ] **Step 3: Full regression**

```bash
bun run test
bun run e2e
```

Expected: PASS. No plugin bundle rebuild. No `.ai-review/` committed.
