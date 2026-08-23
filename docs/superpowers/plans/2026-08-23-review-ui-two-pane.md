# Review UI 2ペイン化(エクスプローラ+diff/判断パネル)実装計画

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Review UIを「判断レコード起点」から「ファイル/差分起点」へ再構成し、VS Code風エクスプローラ+構造化diff+判断パネルの3カラムUIを実現する。

**Architecture:** サーバー側に構造化diffを返す新GET API 2本(`/v1/repositories/:id/files`・`/v1/repositories/:id/diff`)を既存 `handleRequest` フロー内に追加する。`GitReader` に `readPathDiff()` を追加し、hunkグループ化を既存 `buildTextDiff`(snapshot patch用)と共有する形へリファクタする。UIは App を状態機械(bootstrap→workspace)とし、純関数ライブラリ(file-tree / decision-index)経由で Explorer → DiffView → JudgmentPanel を配線する。判断の行アンカーはrevision種別とhash検証状態で決める(§5)。既存セキュリティ境界はすべて維持。

**Tech Stack:** Bun runtime, TypeScript, Bun test (recorder/contracts), React 19 + Vite + vitest + @testing-library/react (review-ui), Playwright (E2E)。

**Spec:** `docs/superpowers/specs/2026-08-22-review-ui-two-pane-design.md`

## Global Constraints

- 左側のdiffは **記録revision vs 現在の作業ツリー** の差分(`base` パラメータで記録revisionを指定、省略時 `HEAD`)。
- エクスプローラはリポジトリ全体ツリー + 判断対象ファイルへの件数バッジ。
- 既存「Review timeline」(`DecisionList.tsx`) は廃止。ナビゲーションは ツリー → ファイル → diff上の行/塊選択 に一本化。
- hash不一致targetはdiffアンカー禁止。「現在のコードへ黙って付け替えない」を維持(上位仕様§9)。
- 新エンドポイントは既存 `handleRequest` 内に実装しBearer認証を迂回路なく適用。GET専用のためOrigin検証ルール(mutation限定)は変更しない。
- サイズ上限は既存 `readBounded(maxBytes)` / `maxSourceContentLength` を流用。`ERROR_CODES` に新コードを追加しない。
- XSS対策: Reactテキストノードのみ、`dangerouslySetInnerHTML` 不使用。トークンはメモリ保持のみ(localStorage/URLに書かない)。
- キャッシュ層(TanStack Query等)は導入しない。ファイルを開く度に新鮮なdiff+hash検証を取得。
- UIコピーは既存どおり英語。Explorer内検索ボックス・仮想スクロール・snapshot patch表示切替は scope 外。
- バックエンドテストは `bun test`、フロントエンドテストは `bun run --cwd apps/review-ui test`(vitest run)。新規モジュール(`apps/review-ui/src/lib/**`)のカバレッジ80%以上。

## File Map

- Modify: `packages/contracts/src/api.ts` — `DiffLine`/`DiffHunk`/`FileDiff` 共有型を追加
- Modify: `apps/recorder/src/source/git.ts` — `listWorktreeFiles` 公開化、`resolveRevision`、`readPathDiff` 追加、hunkグループ化を `buildTextDiff` と共有化
- Modify: `apps/recorder/test/source-resolution.test.ts` — `readPathDiff` 構造化出力テスト
- Modify: `apps/recorder/src/http/server.ts` — `/files`・`/diff` ルート追加
- Modify: `apps/recorder/test/http.test.ts` — files/diff ルートテスト
- Create: `apps/review-ui/src/lib/file-tree.ts` — パス配列→ネストツリー(純関数)
- Create: `apps/review-ui/src/lib/file-tree.test.ts`
- Create: `apps/review-ui/src/lib/decision-index.ts` — パス別判断グループ化+アンカー判定+ブロック重なり判定(純関数)
- Create: `apps/review-ui/src/lib/decision-index.test.ts`
- Modify: `apps/review-ui/src/api.ts` — `listRepositoryFiles()`/`getFileDiff()` 追加、`DecisionRecordSummary` に `targets` 追加
- Modify: `apps/review-ui/src/api.test.ts`
- Create: `apps/review-ui/src/components/BootstrapScreen.tsx` — 既存トークン入力画面の抽出
- Create: `apps/review-ui/src/components/Workspace.tsx` — 3カラム配置+選択状態保持
- Create: `apps/review-ui/src/components/Explorer.tsx` — 折りたたみツリー+件数バッジ
- Create: `apps/review-ui/src/components/DiffView.tsx` — hunk描画/行アンカー/ブロック選択/全文モード
- Create: `apps/review-ui/src/components/JudgmentPanel.tsx` — 判断カード列(ブロックで絞り込み)
- Create: `apps/review-ui/src/components/DecisionCard.tsx` — DecisionDetail再構成(disposition/checks/open questions/hash不一致警告)
- Delete: `apps/review-ui/src/components/DecisionList.tsx`
- Delete: `apps/review-ui/src/components/DecisionDetail.tsx`
- Delete: `apps/review-ui/src/components/SourceReference.tsx`
- Delete: `apps/review-ui/src/components/SourceReference.test.tsx`、`apps/review-ui/src/components/DecisionDetail.test.tsx`
- Modify: `apps/review-ui/src/App.tsx` — 状態機械+取得オーケストレーション
- Modify: `apps/review-ui/src/App.test.tsx`
- Modify: `apps/review-ui/src/styles.css` — 3カラムレイアウト+各コンポーネントクラス
- Modify: `tests/e2e/review-flow.spec.ts` — 新ナビゲーションへ書き換え

---

### Task 1: contracts型 + GitReader `readPathDiff`

**Files:**
- Modify: `packages/contracts/src/api.ts`
- Modify: `apps/recorder/src/source/git.ts`
- Test: `apps/recorder/test/source-resolution.test.ts`

**Interfaces:**
- Consumes: 既存 `GitReader.execute`/`verifyRepository`/`verifyRevision`/`listTreePaths`/`readCommitBlob`、private `lineDiff`、`WorkingTreeReader.readEnumeratedFile`、`normalizeSourcePath`。
- Produces: contracts に `interface DiffLine { type: "context" | "add" | "del"; oldLine: number | null; newLine: number | null; content: string }`、`interface DiffHunk { oldStart: number; newStart: number; lines: DiffLine[] }`、`interface FileDiff { path: string; base_sha: string; hunks: DiffHunk[]; old_missing: boolean; new_missing: boolean; binary: boolean }`。
- Produces: `GitReader.listWorktreeFiles(root: string): Promise<string[]>`(旧 private `listWorktreePaths` の公開化、挙動同一)。
- Produces: `GitReader.resolveRevision(root: string, base: string): Promise<string>` — `base==="HEAD"` なら `git rev-parse HEAD^{commit}` 結果のSHA、それ以外は `isSafeRevision` 合格のSHAを検証して解決したSHAを返す。コミット皆無/不正revisionは `GitReaderError(REVISION_NOT_FOUND)`。
- Produces: `GitReader.readPathDiff(root: string, sha: string, relativePath: string): Promise<FileDiff>` — 作業ツリー読み取りは既存 `WorkingTreeReader(this.maxBytes).readEnumeratedFile`(サイズ超過時 `PAYLOAD_TOO_LARGE` を伝播)。削除ファイルは空文字として扱う(既存 `readDiff` と同様)。NULバイト検出時は `binary: true` かつ `hunks: []`。

- [ ] **Step 1: Write the failing tests**

`apps/recorder/test/source-resolution.test.ts` の `describe("source resolution", ...)` ブロック末尾に追加:

```ts
  test("readPathDiff returns structured hunks with exact old and new line numbers", async () => {
    const context = await createResolverFixture();
    const diff = await new GitReader().readPathDiff(context.fixture.root, context.fixture.commitSha, context.fixture.path);

    expect(diff.path).toBe("src/example.ts");
    expect(diff.base_sha).toBe(context.fixture.commitSha);
    expect(diff.old_missing).toBe(false);
    expect(diff.new_missing).toBe(false);
    expect(diff.binary).toBe(false);
    expect(diff.hunks).toHaveLength(1);
    expect(diff.hunks[0]!.oldStart).toBe(1);
    expect(diff.hunks[0]!.newStart).toBe(1);
    const lines = diff.hunks[0]!.lines;
    expect(lines.find((line) => line.type === "del")).toEqual({ type: "del", oldLine: 1, newLine: null, content: "export const version = 1;" });
    expect(lines.find((line) => line.type === "add")).toEqual({ type: "add", oldLine: null, newLine: 1, content: "export const version = 2;" });
    expect(lines.filter((line) => line.type === "context")).toContainEqual({ type: "context", oldLine: 2, newLine: 2, content: "" });
    context.store.close();
  });

  test("readPathDiff marks created and deleted files with missing sides", async () => {
    const context = await createResolverFixture();
    await writeFile(join(context.fixture.root, "src/added.ts"), "brand new\n", "utf8");

    const created = await new GitReader().readPathDiff(context.fixture.root, context.fixture.commitSha, "src/added.ts");
    expect(created.old_missing).toBe(true);
    expect(created.new_missing).toBe(false);
    expect(created.hunks[0]!.lines.every((line) => line.type === "add")).toBe(true);

    await rm(join(context.fixture.root, context.fixture.path), { force: true });
    const deleted = await new GitReader().readPathDiff(context.fixture.root, context.fixture.commitSha, context.fixture.path);
    expect(deleted.new_missing).toBe(true);
    expect(deleted.old_missing).toBe(false);
    expect(deleted.hunks[0]!.lines.every((line) => line.type === "del")).toBe(true);
    context.store.close();
  });

  test("readPathDiff reports binary content without hunks", async () => {
    const context = await createResolverFixture();
    const binaryPath = "src/blob.bin";
    await writeFile(join(context.fixture.root, binaryPath), Buffer.from([0x00, 0x01, 0x02]), "utf8");

    const diff = await new GitReader().readPathDiff(context.fixture.root, context.fixture.commitSha, binaryPath);

    expect(diff.binary).toBe(true);
    expect(diff.hunks).toHaveLength(0);
    expect(diff.old_missing).toBe(true);
    expect(diff.new_missing).toBe(false);
    context.store.close();
  });

  test("resolveRevision normalizes HEAD and rejects unsafe or absent revisions", async () => {
    const context = await createResolverFixture();
    const git = new GitReader();

    expect(await git.resolveRevision(context.fixture.root, "HEAD")).toBe(context.fixture.commitSha);
    expect(await git.resolveRevision(context.fixture.root, context.fixture.commitSha)).toBe(context.fixture.commitSha);
    await expect(git.resolveRevision(context.fixture.root, "../escape")).rejects.toMatchObject({ code: "REVISION_NOT_FOUND" });
    await expect(git.resolveRevision(context.fixture.root, "deadbeefdeadbeefdeadbeefdeadbeefdeadbeef")).rejects.toMatchObject({ code: "REVISION_NOT_FOUND" });

    const emptyRoot = await mkdtemp(join(tmpdir(), "ai-review-source-empty-repo-"));
    temporaryDirectories.push(emptyRoot);
    await runGit(emptyRoot, ["init", "--quiet"]);
    await expect(git.resolveRevision(emptyRoot, "HEAD")).rejects.toMatchObject({ code: "REVISION_NOT_FOUND" });
    context.store.close();
  });

  test("lists tracked working-tree files as a public read-only operation", async () => {
    const context = await createResolverFixture();
    const paths = await new GitReader().listWorktreeFiles(context.fixture.root);
    expect(paths).toContain("src/example.ts");
    expect(paths.every((path) => !path.startsWith("/"))).toBe(true);
    context.store.close();
  });
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `bun test apps/recorder/test/source-resolution.test.ts`
Expected: FAIL — `readPathDiff is not a function` / `resolveRevision is not a function` / `listWorktreeFiles is not a function`。

- [ ] **Step 3: Add contract types**

`packages/contracts/src/api.ts` の `ERROR_CODES` 定義より前に追加:

```ts
export interface DiffLine {
  type: "context" | "add" | "del";
  oldLine: number | null;
  newLine: number | null;
  content: string;
}

export interface DiffHunk {
  oldStart: number;
  newStart: number;
  lines: DiffLine[];
}

export interface FileDiff {
  path: string;
  /** Resolved base commit SHA (rev-parse result when base=HEAD). */
  base_sha: string;
  hunks: DiffHunk[];
  /** The base commit does not contain this file (created after base). */
  old_missing: boolean;
  /** The working tree no longer contains this file. */
  new_missing: boolean;
  /** A NUL byte was detected on either side; hunks is empty when true. */
  binary: boolean;
}
```

- [ ] **Step 4: Implement GitReader changes**

`apps/recorder/src/source/git.ts`:

1. import に型を追加:

```ts
import type { FileDiff, DiffHunk, DiffLine } from "../../../../packages/contracts/src/index";
```

2. 既存 `buildTextDiff` と `formatHunk` を次の共有ヘルパー実装で置き換える(挙動は不変):

```ts
function toEntries(operations: DiffOperation[]): DiffEntry[] {
  const entries: DiffEntry[] = [];
  let oldLine = 0;
  let newLine = 0;
  for (const operation of operations) {
    entries.push({
      operation,
      oldLine: operation.kind === "insert" ? null : oldLine + 1,
      newLine: operation.kind === "delete" ? null : newLine + 1,
      oldBefore: oldLine,
      newBefore: newLine,
    });
    if (operation.kind !== "insert") oldLine += 1;
    if (operation.kind !== "delete") newLine += 1;
  }
  return entries;
}

interface GroupedHunk {
  oldStart: number;
  newStart: number;
  entries: DiffEntry[];
}

function groupHunks(entries: DiffEntry[]): GroupedHunk[] {
  const changes = entries.flatMap((entry, index) => (entry.operation.kind === "equal" ? [] : [index]));
  if (changes.length === 0) return [];
  const ranges: Array<{ start: number; end: number }> = [];
  let start = Math.max(0, changes[0]! - 3);
  let end = Math.min(entries.length - 1, changes[0]! + 3);
  for (let change = 1; change < changes.length; change += 1) {
    const nextStart = Math.max(0, changes[change]! - 3);
    const nextEnd = Math.min(entries.length - 1, changes[change]! + 3);
    if (nextStart <= end + 1) {
      end = Math.max(end, nextEnd);
      continue;
    }
    ranges.push({ start, end });
    start = nextStart;
    end = nextEnd;
  }
  ranges.push({ start, end });
  return ranges.map(({ start, end }) => {
    const hunkEntries = entries.slice(start, end + 1);
    const first = hunkEntries[0]!;
    return {
      oldStart: first.oldLine ?? first.oldBefore + 1,
      newStart: first.newLine ?? first.newBefore + 1,
      entries: hunkEntries,
    };
  });
}

function formatHunk(hunk: GroupedHunk): string {
  const oldCount = hunk.entries.filter((entry) => entry.oldLine !== null).length;
  const newCount = hunk.entries.filter((entry) => entry.newLine !== null).length;
  const body = hunk.entries
    .map((entry) => `${entry.operation.kind === "equal" ? " " : entry.operation.kind === "delete" ? "-" : "+"}${entry.operation.line}`)
    .join("\n");
  return `@@ -${hunk.oldStart},${oldCount} +${hunk.newStart},${newCount} @@\n${body}\n`;
}

function buildTextDiff(path: string, previous: string, current: string, maxWork: number): string {
  const operations = lineDiff(previous.split("\n"), current.split("\n"), maxWork);
  if (operations === null) {
    throw new GitReaderError(ERROR_CODES.PAYLOAD_TOO_LARGE, "Git diff work exceeds the configured source limit");
  }
  const grouped = groupHunks(toEntries(operations));
  if (grouped.length === 0) return "";
  const hunks = grouped.map((hunk) => formatHunk(hunk));
  return `diff --git a/${path} b/${path}\n--- a/${path}\n+++ b/${path}\n${hunks.join("")}`;
}
```

3. private `listWorktreePaths` を公開メソッド `listWorktreeFiles` に変更(本体は同一、シグネチャ `async listWorktreeFiles(root: string): Promise<string[]>`)。`readDiff` 内の呼び出し `this.listWorktreePaths(root)` を `this.listWorktreeFiles(root)` に変更。

4. import に型を追加し、`GitReader` クラス内に次の2メソッドを追加:

```ts
import type { FileDiff, DiffHunk, DiffLine } from "../../../../packages/contracts/src/index";
```

```ts
  async resolveRevision(root: string, base: string): Promise<string> {
    await this.verifyRepository(root);
    if (base !== "HEAD" && !isSafeRevision(base)) {
      throw new GitReaderError(ERROR_CODES.REVISION_NOT_FOUND, "revision is not an allowed commit reference");
    }
    const result = await this.execute(root, ["rev-parse", `${base}^{commit}`]);
    if (result.oversized) throw new GitReaderError(ERROR_CODES.PAYLOAD_TOO_LARGE, "Git metadata exceeds the configured source limit");
    if (result.exitCode !== 0) throw new GitReaderError(ERROR_CODES.REVISION_NOT_FOUND, "revision was not found");
    return result.stdout.trim();
  }

  async readPathDiff(root: string, sha: string, relativePath: string): Promise<FileDiff> {
    const normalizedPath = normalizeSourcePath(relativePath);
    await this.verifyRepository(root);
    await this.verifyRevision(root, sha);
    const treePaths = new Set(await this.listTreePaths(root, sha));
    let previous = "";
    let oldMissing = true;
    if (treePaths.has(normalizedPath)) {
      previous = await this.readCommitBlob(root, sha, normalizedPath);
      oldMissing = false;
    }
    let current = "";
    let newMissing = true;
    const worktreePaths = new Set(await this.listWorktreeFiles(root));
    if (worktreePaths.has(normalizedPath)) {
      try {
        current = (await new WorkingTreeReader(this.maxBytes).readEnumeratedFile(root, normalizedPath)).content;
        newMissing = false;
      } catch (error) {
        if (!(error instanceof WorkingTreePathMissingError)) throw error;
        current = "";
      }
    }
    const binary = previous.includes("\0") || current.includes("\0");
    if (binary) {
      return { path: normalizedPath, base_sha: sha, hunks: [], old_missing: oldMissing, new_missing: newMissing, binary: true };
    }
    const operations = lineDiff(previous.split("\n"), current.split("\n"), this.maxDiffWork);
    if (operations === null) {
      throw new GitReaderError(ERROR_CODES.PAYLOAD_TOO_LARGE, "Git diff work exceeds the configured source limit");
    }
    const hunks: DiffHunk[] = groupHunks(toEntries(operations)).map((hunk) => ({
      oldStart: hunk.oldStart,
      newStart: hunk.newStart,
      lines: hunk.entries.map((entry): DiffLine => ({
        type: entry.operation.kind === "equal" ? "context" : entry.operation.kind === "delete" ? "del" : "add",
        oldLine: entry.oldLine,
        newLine: entry.newLine,
        content: entry.operation.line,
      })),
    }));
    return { path: normalizedPath, base_sha: sha, hunks, old_missing: oldMissing, new_missing: newMissing, binary: false };
  }
```

- [ ] **Step 5: Run tests to verify they pass**

Run: `bun test apps/recorder/test/source-resolution.test.ts apps/recorder/test/http.test.ts apps/recorder/test/setup.test.ts`
Expected: PASS(新規テスト+既存 snapshot patch 用 `readDiff` テストすべて)。

- [ ] **Step 6: Commit**

```bash
git add packages/contracts/src/api.ts apps/recorder/src/source/git.ts apps/recorder/test/source-resolution.test.ts
git commit -m "feat: add structured per-path diff to GitReader"
```

### Task 2: `/v1/repositories/:id/files` と `/v1/repositories/:id/diff` ルート

**Files:**
- Modify: `apps/recorder/src/http/server.ts`
- Test: `apps/recorder/test/http.test.ts`

**Interfaces:**
- Consumes: Task 1 の `GitReader.listWorktreeFiles`/`resolveRevision`/`readPathDiff`(`resolver.git` 経由 — `SourceResolver.git` は public readonly)、既存 `registry.get(repositoryId)`、既存 `registry.assertTarget(repositoryId, path)`(canonicalizeTarget・rejectNestedRepository 含む)、既存 `failure()`/`success()`/`errorResponse()`。
- Produces: `GET /v1/repositories/:id/files` → `200 { success: true, data: { repository_id: string, paths: string[] } }`(ルート相対・POSIX区切り・辞書順ソート)。エラー: 401 / 404 REPOSITORY_NOT_REGISTERED / 422 SOURCE_UNAVAILABLE。
- Produces: `GET /v1/repositories/:id/diff?path=…&base=<sha|HEAD>` → `200 { success: true, data: FileDiff }`。`base` 省略時は `HEAD`。エラー: 401 / 404 REPOSITORY_NOT_REGISTERED・REVISION_NOT_FOUND / 422 PATH_OUTSIDE_ROOT・SOURCE_UNAVAILABLE・INVALID_RECORD(path未指定) / 413 PAYLOAD_TOO_LARGE。

- [ ] **Step 1: Write the failing tests**

`apps/recorder/test/http.test.ts` — 既存 import に `spawn` を追加し、git フィクスチャ用ヘルパーを追加:

```ts
import { spawn } from "node:child_process";
```

```ts
async function runGit(args: string[]): Promise<void> {
  const child = spawn("git", args, { cwd: root, stdio: ["ignore", "pipe", "pipe"] });
  const exitCode = await new Promise<number>((resolve) => child.once("exit", (code) => resolve(code ?? 1)));
  if (exitCode !== 0) throw new Error(`git ${args.join(" ")} failed`);
}
```

`describe` ブロック内に追加:

```ts
  test("lists tracked repository files for the explorer", async () => {
    await runGit(["init", "--quiet"]);
    await runGit(["config", "user.email", "fixture@example.test"]);
    await runGit(["config", "user.name", "Fixture"]);
    await runGit(["add", "--", "src/example.ts", "src/other.ts"]);
    await runGit(["commit", "--quiet", "-m", "tracked"]);
    await request("/v1/repositories", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ root, repository_id: "repo-1" }) });

    const unauthorized = await fetch(`${app.server.url}/v1/repositories/repo-1/files`);
    expect(unauthorized.status).toBe(401);

    const response = await request("/v1/repositories/repo-1/files");
    expect(response.status).toBe(200);
    expect(await json<{ success: true; data: { repository_id: string; paths: string[] } }>(response)).toEqual({
      success: true,
      data: { repository_id: "repo-1", paths: ["src/example.ts", "src/other.ts"] },
    });

    const unregistered = await request("/v1/repositories/repo-missing/files");
    expect(unregistered.status).toBe(404);
    expect(await json<{ success: false; error: { code: string } }>(unregistered)).toMatchObject({ success: false, error: { code: "REPOSITORY_NOT_REGISTERED" } });
  });

  test("returns a structured path diff against the recorded revision or HEAD", async () => {
    await request("/v1/repositories", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ root, repository_id: "repo-1" }) });
    await writeFile(join(root, "src", "example.ts"), "first source\nsecond line\n", "utf8");
    await runGit(["init", "--quiet"]);
    await runGit(["config", "user.email", "fixture@example.test"]);
    await runGit(["config", "user.name", "Fixture"]);
    await runGit(["add", "--", "src/example.ts"]);
    await runGit(["commit", "--quiet", "-m", "base"]);
    const baseSha = await new Promise<string>((resolve, reject) => {
      const child = spawn("git", ["rev-parse", "HEAD"], { cwd: root, stdio: ["ignore", "pipe", "pipe"] });
      let stdout = "";
      child.stdout.on("data", (chunk: Buffer) => { stdout += chunk.toString(); });
      child.once("exit", (code) => (code === 0 ? resolve(stdout.trim()) : reject(new Error("rev-parse failed"))));
    });
    // beforeEach already left the working tree at "changed source\n"
    const response = await request(`/v1/repositories/repo-1/diff?path=${encodeURIComponent("src/example.ts")}&base=${baseSha}`);
    expect(response.status).toBe(200);
    const payload = await json<{ success: true; data: { path: string; base_sha: string; binary: boolean; hunks: Array<{ lines: Array<{ type: string; oldLine: number | null; newLine: number | null; content: string }> }> } }>(response);
    expect(payload.success).toBe(true);
    expect(payload.data.path).toBe("src/example.ts");
    expect(payload.data.base_sha).toBe(baseSha);
    expect(payload.data.binary).toBe(false);
    const lines = payload.data.hunks[0]!.lines;
    expect(lines.find((line) => line.type === "del")?.content).toBe("first source");
    expect(lines.find((line) => line.type === "add")?.content).toBe("changed source");

    const headResponse = await request(`/v1/repositories/repo-1/diff?path=${encodeURIComponent("src/example.ts")}`);
    expect(headResponse.status).toBe(200);

    const missingPath = await request(`/v1/repositories/repo-1/diff`);
    expect(missingPath.status).toBe(422);

    const outside = await request(`/v1/repositories/repo-1/diff?path=${encodeURIComponent("../outside.ts")}`);
    expect(outside.status).toBe(422);
    expect(await json<{ success: false; error: { code: string } }>(outside)).toMatchObject({ success: false, error: { code: "PATH_OUTSIDE_ROOT" } });

    const badRevision = await request(`/v1/repositories/repo-1/diff?path=${encodeURIComponent("src/example.ts")}&base=$(touch /tmp/pwned)`);
    expect(badRevision.status).toBe(404);
    expect(await json<{ success: false; error: { code: string } }>(badRevision)).toMatchObject({ success: false, error: { code: "REVISION_NOT_FOUND" } });

    const unregistered = await request(`/v1/repositories/repo-missing/diff?path=src/example.ts`);
    expect(unregistered.status).toBe(404);
  });

  test("rejects oversized working-tree sources on the diff endpoint with 413", async () => {
    const limitedDataDir = await mkdtemp(join(tmpdir(), "ai-review-http-diff-limit-"));
    temporaryDirectories.push(limitedDataDir);
    const limitedRoot = await mkdtemp(join(tmpdir(), "ai-review-http-diff-root-"));
    temporaryDirectories.push(limitedRoot);
    const limitedUi = await mkdtemp(join(tmpdir(), "ai-review-http-diff-ui-"));
    temporaryDirectories.push(limitedUi);
    await mkdir(join(limitedRoot, "src"), { recursive: true });
    await writeFile(join(limitedRoot, "src", "example.ts"), "x".repeat(64), "utf8");
    const limitedApp = await createRecorderServer({
      config: createRecorderConfig({ dataDir: limitedDataDir, port: 0, maxSourceBytes: 16 }),
      uiRoot: limitedUi,
      port: 0,
    });
    try {
      const limitedToken = await readOwnerToken(limitedApp.config);
      const limitedHeaders = new Headers({ Authorization: `Bearer ${limitedToken}` });
      await fetch(`${limitedApp.server.url}/v1/repositories`, { method: "POST", headers: { ...Object.fromEntries(limitedHeaders), "Content-Type": "application/json" }, body: JSON.stringify({ root: limitedRoot, repository_id: "limited-repo" }) });
      const response = await fetch(`${limitedApp.server.url}/v1/repositories/limited-repo/diff?path=src/example.ts`, { headers: limitedHeaders });
      expect(response.status).toBe(413);
      expect(await response.json()).toMatchObject({ success: false, error: { code: "PAYLOAD_TOO_LARGE" } });
    } finally {
      await limitedApp.stop();
    }
  });
```

注意: 3つ目のテストは `createRecorderServer` と `readOwnerToken`(既存 import 済み)をそのまま再利用する。`beforeEach` の `root` は git リポジトリではないため、2つ目のテスト内で `runGit(["init", …])` を行ってから `baseSha` を得る(working tree の内容 `"changed source\n"` は beforeEach 設置のまま使う)。

- [ ] **Step 2: Run tests to verify they fail**

Run: `bun test apps/recorder/test/http.test.ts`
Expected: FAIL — files/diff ルートが未実装のため `unknownRoute()` の 404 が返る。

- [ ] **Step 3: Implement the routes**

`apps/recorder/src/http/server.ts` の `handleRequest` 内、既存 `GET /v1/repositories` ルート(parts.length === 1)の直後に挿入:

```ts
    if (request.method === "GET" && parts.length === 3 && parts[0] === "repositories" && parts[2] === "files") {
      const repository = await registry.get(parts[1] ?? "");
      if (repository === null) return failure(ERROR_CODES.REPOSITORY_NOT_REGISTERED, "repository is not registered", 404);
      const paths = await resolver.git.listWorktreeFiles(repository.root);
      paths.sort();
      return success({ repository_id: repository.repository_id, paths });
    }

    if (request.method === "GET" && parts.length === 3 && parts[0] === "repositories" && parts[2] === "diff") {
      const repository = await registry.get(parts[1] ?? "");
      if (repository === null) return failure(ERROR_CODES.REPOSITORY_NOT_REGISTERED, "repository is not registered", 404);
      const pathParam = url.searchParams.get("path");
      if (pathParam === null || pathParam.trim().length === 0) return failure(ERROR_CODES.INVALID_RECORD, "path query parameter is required", 422, "path");
      await registry.assertTarget(repository.repository_id, pathParam);
      const base = url.searchParams.get("base") ?? "HEAD";
      const baseSha = await resolver.git.resolveRevision(repository.root, base);
      return success(await resolver.git.readPathDiff(repository.root, baseSha, pathParam));
    }
```

エラーマッピングは既存の通り: `errorResponse` → `statusForError`(`PATH_OUTSIDE_ROOT`/`INVALID_RECORD`→422、`REVISION_NOT_FOUND`→404、`PAYLOAD_TOO_LARGE`→413、`SOURCE_UNAVAILABLE`→422)。新コード・新マッピングは不要。

- [ ] **Step 4: Run tests to verify they pass**

Run: `bun test apps/recorder/test/http.test.ts apps/recorder/test/source-resolution.test.ts`
Expected: PASS。

- [ ] **Step 5: Run the full backend suite**

Run: `bun test packages/*/test apps/recorder/test plugins/*/test`
Expected: PASS(既存テストすべてグリーン維持)。

- [ ] **Step 6: Commit**

```bash
git add apps/recorder/src/http/server.ts apps/recorder/test/http.test.ts
git commit -m "feat: add repository file list and per-path diff endpoints"
```

### Task 3: UI純関数ライブラリ `file-tree.ts` / `decision-index.ts`

**Files:**
- Create: `apps/review-ui/src/lib/file-tree.ts`
- Test: `apps/review-ui/src/lib/file-tree.test.ts`
- Create: `apps/review-ui/src/lib/decision-index.ts`
- Test: `apps/review-ui/src/lib/decision-index.test.ts`

**Interfaces:**
- Consumes: Task 4 で拡張する `DecisionRecordSummary`(`targets` 含む)と `SourceReferenceData`。本タスクは型のみに依存するため先に実装してよい(vitest は型検査のみで失敗しない)。
- Produces:
  - `interface FileTreeNode { name: string; path: string; isFile: boolean; decisionCount: number; children: FileTreeNode[] }`(root node は `name: ""`, `path: ""`, `isFile: false`)
  - `buildFileTree(paths: string[], decisionCounts?: ReadonlyMap<string, number>): FileTreeNode` — ディレクトリを先、各レベル内は `localeCompare` 昇順。
  - `buildDecisionIndex(decisions: DecisionRecordSummary[]): Map<string, DecisionRecordSummary[]>` — path別グループ化(targetの重複排除済み)、各リストは `created_at` 降順。
  - `interface DecisionAnchor { side: "old" | "new"; start: number; end: number }`
  - `targetAnchor(source: SourceReferenceData): DecisionAnchor | null` — §5 セマンティクス: commit revision → 常時旧側; working-tree + `resolved`/`snapshot-resolved` → 新側; それ以外は `null`。
  - `decisionAnchors(detail: DecisionRecordDetail): DecisionAnchor[]` — sources を targets 順にアンカーへ変換(null除外)。
  - `interface BlockSelection { oldStart: number | null; oldEnd: number | null; newStart: number | null; newEnd: number | null }`
  - `overlapsBlock(anchor: DecisionAnchor, block: BlockSelection): boolean` — 辺ごと厳密判定(旧側アンカーは旧範囲のみ、新側アンカーは新範囲のみと重なり判定)。
  - `diffBaseFor(decisions: DecisionRecordSummary[]): string` — §4.3: commit revision の判断のうち `created_at` 最大のSHA、無ければ `"HEAD"`。

- [ ] **Step 1: Write the failing tests**

`apps/review-ui/src/lib/file-tree.test.ts`:

```ts
import { describe, expect, it } from "vitest";
import { buildFileTree } from "./file-tree";

describe("buildFileTree", () => {
  it("converts a flat sorted path list into a nested tree with directories first", () => {
    const root = buildFileTree(["src/api.ts", "src/components/App.tsx", "README.md"]);

    expect(root.isFile).toBe(false);
    expect(root.children.map((child) => child.name)).toEqual(["src", "README.md"]);
    const src = root.children[0]!;
    expect(src.isFile).toBe(false);
    expect(src.children.map((child) => child.name)).toEqual(["api.ts", "components"]);
    const components = src.children[1]!;
    expect(components.children[0]!.path).toBe("src/components/App.tsx");
    expect(components.children[0]!.isFile).toBe(true);
    expect(root.children[1]!.path).toBe("README.md");
  });

  it("attaches decision counts to file nodes and leaves directories at zero", () => {
    const counts = new Map([["src/api.ts", 3]]);
    const root = buildFileTree(["src/api.ts", "src/util.ts"], counts);

    const api = root.children[0]!.children[0]!;
    expect(api.decisionCount).toBe(3);
    expect(root.children[0]!.children[1]!.decisionCount).toBe(0);
    expect(root.decisionCount).toBe(0);
  });

  it("returns an empty root for an empty path list", () => {
    const root = buildFileTree([]);
    expect(root.children).toEqual([]);
  });
});
```

`apps/review-ui/src/lib/decision-index.test.ts`:

```ts
import { describe, expect, it } from "vitest";
import type { DecisionRecordDetail, DecisionRecordSummary, SourceReferenceData } from "../api";
import { buildDecisionIndex, decisionAnchors, diffBaseFor, overlapsBlock, targetAnchor } from "./decision-index";

function summary(recordId: string, overrides: Partial<DecisionRecordSummary> = {}): DecisionRecordSummary {
  return {
    record_id: recordId,
    session_id: `session-${recordId}`,
    repository_id: "repo-1",
    agent_type: "codex",
    revision: { kind: "commit", sha: `sha-${recordId}` },
    targets: [
      { repository_id: "repo-1", path: "src/a.ts", line_start: 10, line_end: 12, revision: { kind: "commit", sha: `sha-${recordId}` }, content_hash: "hash-a" },
      { repository_id: "repo-1", path: "src/b.ts", line_start: 1, line_end: 2, revision: { kind: "commit", sha: `sha-${recordId}` }, content_hash: "hash-b" },
    ],
    judgment: `judgment ${recordId}`,
    created_at: "2026-08-20T10:00:00.000Z",
    user_disposition: "unreviewed",
    ...overrides,
  };
}

describe("buildDecisionIndex", () => {
  it("groups decisions per target path newest first without duplicates", () => {
    const older = summary("older", { created_at: "2026-08-19T00:00:00.000Z" });
    const newer = summary("newer", { created_at: "2026-08-21T00:00:00.000Z" });
    const index = buildDecisionIndex([older, newer]);

    expect(index.get("src/a.ts")).toEqual([newer, older]);
    expect(index.get("src/b.ts")).toEqual([newer, older]);
    expect(index.has("src/missing.ts")).toBe(false);
  });

  it("keeps a decision listed once when several targets share a path", () => {
    const duplicated = summary("dup");
    duplicated.targets.push({ ...duplicated.targets[0]! });
    const index = buildDecisionIndex([duplicated]);

    expect(index.get("src/a.ts")).toHaveLength(1);
  });
});

describe("targetAnchor", () => {
  const commitTarget = {
    repository_id: "repo-1",
    path: "src/a.ts",
    line_start: 4,
    line_end: 6,
    revision: { kind: "commit" as const, sha: "abc" },
    content_hash: "expected",
  };

  it("anchors commit-revision targets to the old side without source verification", () => {
    const source: SourceReferenceData = {
      state: "hash-mismatch",
      repository_id: "repo-1",
      path: "src/a.ts",
      revision: { kind: "commit", sha: "abc" },
      target: commitTarget,
      expected_hash: "expected",
    };
    expect(targetAnchor(source)).toEqual({ side: "old", start: 4, end: 6 });
  });

  it("anchors verified working-tree targets to the new side", () => {
    const resolved: SourceReferenceData = {
      state: "resolved",
      repository_id: "repo-1",
      path: "src/a.ts",
      revision: { kind: "working-tree", contentHash: "h1" },
      target: { ...commitTarget, revision: { kind: "working-tree", contentHash: "h1" } },
      content: "code",
      content_hash: "expected",
    };
    expect(targetAnchor(resolved)).toEqual({ side: "new", start: 4, end: 6 });

    const snapshot: SourceReferenceData = { ...resolved, state: "snapshot-resolved" };
    expect(targetAnchor(snapshot)).toEqual({ side: "new", start: 4, end: 6 });
  });

  it.each([
    ["hash-mismatch"],
    ["revision-not-found"],
    ["source-unavailable"],
  ] as const)("returns no anchor for an unverified %s working-tree source", (state) => {
    const source: SourceReferenceData = {
      state,
      repository_id: "repo-1",
      path: "src/a.ts",
      revision: { kind: "working-tree", contentHash: "h1" },
      target: { ...commitTarget, revision: { kind: "working-tree", contentHash: "h1" } },
      expected_hash: "expected",
    };
    expect(targetAnchor(source)).toBeNull();
  });

  it("collects only non-null anchors in target order", () => {
    const detail: DecisionRecordDetail = {
      record: { ...summary("r1"), rationale: "", checks: [], open_questions: [] },
      sources: [
        { state: "resolved", repository_id: "repo-1", path: "src/a.ts", revision: { kind: "commit", sha: "abc" }, target: commitTarget, content: "x", content_hash: "expected" },
        { state: "hash-mismatch", repository_id: "repo-1", path: "src/b.ts", revision: { kind: "working-tree", contentHash: "h" }, target: { ...commitTarget, path: "src/b.ts", revision: { kind: "working-tree", contentHash: "h" } }, expected_hash: "expected" },
      ],
    };
    expect(decisionAnchors(detail)).toEqual([{ side: "old", start: 4, end: 6 }]);
  });
});

describe("overlapsBlock", () => {
  it("matches old-side anchors strictly against the old range of the block", () => {
    const anchor = { side: "old" as const, start: 5, end: 7 };
    expect(overlapsBlock(anchor, { oldStart: 5, oldEnd: 9, newStart: null, newEnd: null })).toBe(true);
    expect(overlapsBlock(anchor, { oldStart: 8, oldEnd: 9, newStart: null, newEnd: null })).toBe(false);
    // pure-add blocks expose no old range
    expect(overlapsBlock(anchor, { oldStart: null, oldEnd: null, newStart: 5, newEnd: 9 })).toBe(false);
  });

  it("matches new-side anchors strictly against the new range of the block", () => {
    const anchor = { side: "new" as const, start: 2, end: 3 };
    expect(overlapsBlock(anchor, { oldStart: null, oldEnd: null, newStart: 1, newEnd: 2 })).toBe(true);
    expect(overlapsBlock(anchor, { oldStart: 1, oldEnd: 4, newStart: null, newEnd: null })).toBe(false);
    expect(overlapsBlock(anchor, { oldStart: null, oldEnd: null, newStart: 4, newEnd: 6 })).toBe(false);
  });
});

describe("diffBaseFor", () => {
  it("uses the newest commit-revision decision covering the file", () => {
    const decisions = [
      summary("older", { created_at: "2026-08-19T00:00:00.000Z" }),
      summary("newer", { created_at: "2026-08-21T00:00:00.000Z", revision: { kind: "commit", sha: "sha-newer" } }),
      summary("worktree", { created_at: "2026-08-22T00:00:00.000Z", revision: { kind: "working-tree", contentHash: "h" } }),
    ];
    expect(diffBaseFor(decisions)).toBe("sha-newer");
  });

  it("falls back to HEAD when no commit-revision decision exists", () => {
    expect(diffBaseFor([])).toBe("HEAD");
    expect(diffBaseFor([summary("w", { revision: { kind: "working-tree", contentHash: "h" } })])).toBe("HEAD");
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `bun run --cwd apps/review-ui test src/lib/file-tree.test.ts src/lib/decision-index.test.ts`
Expected: FAIL — モジュールが存在しない。

- [ ] **Step 3: Implement `file-tree.ts`**

```ts
export interface FileTreeNode {
  name: string;
  /** Root-relative POSIX path; "" for the synthetic root. */
  path: string;
  isFile: boolean;
  decisionCount: number;
  children: FileTreeNode[];
}

export function buildFileTree(paths: string[], decisionCounts: ReadonlyMap<string, number> = new Map()): FileTreeNode {
  const root: FileTreeNode = { name: "", path: "", isFile: false, decisionCount: 0, children: [] };
  for (const path of paths) {
    const segments = path.split("/");
    let node = root;
    segments.forEach((segment, index) => {
      const isFile = index === segments.length - 1;
      const nodePath = index === 0 ? segment : `${node.path}/${segment}`;
      let child = node.children.find((candidate) => candidate.name === segment && candidate.isFile === isFile);
      if (child === undefined) {
        child = { name: segment, path: nodePath, isFile, decisionCount: 0, children: [] };
        node.children.push(child);
      }
      if (isFile) child.decisionCount = decisionCounts.get(path) ?? 0;
      node = child;
    });
  }
  const sortChildren = (node: FileTreeNode): void => {
    node.children.sort((a, b) => (a.isFile === b.isFile ? a.name.localeCompare(b.name) : a.isFile ? 1 : -1));
    node.children.forEach(sortChildren);
  };
  sortChildren(root);
  return root;
}
```

- [ ] **Step 4: Implement `decision-index.ts`**

```ts
import type { DecisionRecordDetail, DecisionRecordSummary, SourceReferenceData } from "../api";

export interface DecisionAnchor {
  side: "old" | "new";
  start: number;
  end: number;
}

export interface BlockSelection {
  oldStart: number | null;
  oldEnd: number | null;
  newStart: number | null;
  newEnd: number | null;
}

export function buildDecisionIndex(decisions: DecisionRecordSummary[]): Map<string, DecisionRecordSummary[]> {
  const byPath = new Map<string, DecisionRecordSummary[]>();
  for (const decision of decisions) {
    for (const target of decision.targets) {
      const existing = byPath.get(target.path) ?? [];
      if (!existing.some((candidate) => candidate.record_id === decision.record_id)) existing.push(decision);
      byPath.set(target.path, existing);
    }
  }
  for (const records of byPath.values()) {
    records.sort((a, b) => b.created_at.localeCompare(a.created_at));
  }
  return byPath;
}

/** Spec §5: commit revisions anchor unconditionally on the old side; verified
 * working-tree revisions anchor on the new side; everything else never anchors. */
export function targetAnchor(source: SourceReferenceData): DecisionAnchor | null {
  if (source.revision.kind === "commit") {
    return { side: "old", start: source.target.line_start, end: source.target.line_end };
  }
  if (source.state === "resolved" || source.state === "snapshot-resolved") {
    return { side: "new", start: source.target.line_start, end: source.target.line_end };
  }
  return null;
}

export function decisionAnchors(detail: DecisionRecordDetail): DecisionAnchor[] {
  return detail.sources
    .map((source) => targetAnchor(source))
    .filter((anchor): anchor is DecisionAnchor => anchor !== null);
}

export function overlapsBlock(anchor: DecisionAnchor, block: BlockSelection): boolean {
  if (anchor.side === "old") {
    return block.oldStart !== null && block.oldEnd !== null && block.oldStart <= anchor.end && anchor.start <= block.oldEnd;
  }
  return block.newStart !== null && block.newEnd !== null && block.newStart <= anchor.end && anchor.start <= block.newEnd;
}

/** Spec §4.3: base the diff on the newest commit-revision decision for the file, else HEAD. */
export function diffBaseFor(decisions: DecisionRecordSummary[]): string {
  const commits = decisions
    .filter((decision) => decision.revision.kind === "commit")
    .sort((a, b) => b.created_at.localeCompare(a.created_at));
  const first = commits[0];
  return first !== undefined && first.revision.kind === "commit" ? first.revision.sha : "HEAD";
}
```

注: `DecisionRecordSummary` の `targets` フィールドは Task 4 で追加する。Task 3 を先に実行する場合、vitest はランタイムでは型のみの不一致で落ちないが、Task 4 完了まで TypeScript エディタ上で型エラーが出る点を実装者に明記すること。

- [ ] **Step 5: Run tests to verify they pass**

Run: `bun run --cwd apps/review-ui test src/lib/file-tree.test.ts src/lib/decision-index.test.ts`
Expected: PASS。

- [ ] **Step 6: Commit**

```bash
git add apps/review-ui/src/lib/file-tree.ts apps/review-ui/src/lib/file-tree.test.ts apps/review-ui/src/lib/decision-index.ts apps/review-ui/src/lib/decision-index.test.ts
git commit -m "feat: add file tree and decision index pure functions"
```

### Task 4: api.ts クライアント拡張

**Files:**
- Modify: `apps/review-ui/src/api.ts`
- Test: `apps/review-ui/src/api.test.ts`

**Interfaces:**
- Consumes: 既存 `ReviewApi.request<T>()`、contracts の `FileDiff`(Task 1)、`TargetReference`。
- Produces:
  - `DecisionRecordSummary` の `Pick<…>` に `"targets"` を追加(`TargetReference[]` が含まれるようになる)。
  - `listRepositoryFiles(repositoryId: string): Promise<{ repository_id: string; paths: string[] }>`
  - `getFileDiff(repositoryId: string, path: string, base?: string): Promise<FileDiff>`(`base` 既定値 `"HEAD"`)。

- [ ] **Step 1: Write the failing tests**

`apps/review-ui/src/api.test.ts` の `describe("ReviewApi", ...)` 内に追加:

```ts
  it("lists repository files under the owner bearer token", async () => {
    const fetchImpl = vi.fn(async () =>
      response({ success: true, data: { repository_id: "repo-1", paths: ["src/a.ts", "src/b.ts"] } }),
    );
    const api = new ReviewApi("owner-token", { fetchImpl });

    const files = await api.listRepositoryFiles("repo-1");

    expect(fetchImpl).toHaveBeenCalledWith(
      "/v1/repositories/repo-1/files",
      expect.objectContaining({ headers: expect.objectContaining({ Authorization: "Bearer owner-token" }) }),
    );
    expect(files).toEqual({ repository_id: "repo-1", paths: ["src/a.ts", "src/b.ts"] });
  });

  it("fetches a structured path diff with an explicit base", async () => {
    const fileDiff = { path: "src/a.ts", base_sha: "abc", hunks: [], old_missing: false, new_missing: false, binary: false };
    const fetchImpl = vi.fn(async () => response({ success: true, data: fileDiff }));
    const api = new ReviewApi("owner-token", { fetchImpl });

    const diff = await api.getFileDiff("repo-1", "src/a.ts", "abc");
    expect(diff).toEqual(fileDiff);
    expect(fetchImpl).toHaveBeenNthCalledWith(
      1,
      "/v1/repositories/repo-1/diff?path=src%2Fa.ts&base=abc",
      expect.objectContaining({ headers: expect.objectContaining({ Authorization: "Bearer owner-token" }) }),
    );

    await api.getFileDiff("repo-1", "src/a.ts");
    expect(fetchImpl).toHaveBeenNthCalledWith(
      2,
      "/v1/repositories/repo-1/diff?path=src%2Fa.ts&base=HEAD",
      expect.anything(),
    );

    await expect(api.getFileDiff("  ", "src/a.ts")).rejects.toMatchObject({ name: "ReviewApiError", code: "INVALID_RECORD" });
  });

  it("propagates diff endpoint error envelopes", async () => {
    const api = new ReviewApi("owner-token", {
      fetchImpl: async () => response({ success: false, error: { code: "PAYLOAD_TOO_LARGE", message: "source exceeds the limit" } }, 413),
    });

    await expect(api.getFileDiff("repo-1", "src/a.ts")).rejects.toMatchObject({
      name: "ReviewApiError",
      code: "PAYLOAD_TOO_LARGE",
      status: 413,
    });
  });
```

さらに既存 `summary` 相当のテストフィクスチャが `targets` を要求するようになるため、`App.test.tsx` 側は Task 10 で更新する(本タスクでは `api.test.ts` のみ修正。`DecisionRecordSummary` に `targets` を追加した時点で `App.test.tsx` の `summary()` ヘルパーが型エラーになるため、Step 3 の後に `bun run --cwd apps/review-ui test` 全体が型エラーで落ちる場合は Task 4 内で `App.test.tsx` の `summary()` に最小限の `targets: []` 追加を行ってよい — コンポーネントの書き換えは Task 10)。実際には App.test.tsx の summary ヘルパーは戻り値型注釈付きのため、次の1行変更だけでよい:

```ts
function summary(recordId: string, judgment: string): DecisionRecordSummary {
  return {
    record_id: recordId,
    session_id: `session-${recordId}`,
    repository_id: "repo-1",
    agent_type: "codex",
    revision: { kind: "commit", sha: "abc123" },
    targets: [],
    judgment,
    created_at: "2026-08-20T10:00:00.000Z",
    user_disposition: "unreviewed",
  };
}
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `bun run --cwd apps/review-ui test src/api.test.ts`
Expected: FAIL — `listRepositoryFiles is not a function` / `getFileDiff is not a function`。

- [ ] **Step 3: Implement**

`apps/review-ui/src/api.ts`:

1. contracts import に `FileDiff` 型を追加:

```ts
import type {
  ApiResponse,
  CheckEvidence,
  DecisionRecord,
  FileDiff,
  RevisionRef,
  TargetReference,
  UserDisposition,
} from "../../../packages/contracts/src/index";
```

2. `DecisionRecordSummary` を変更:

```ts
export type DecisionRecordSummary = Pick<
  DecisionRecord,
  | "record_id"
  | "session_id"
  | "repository_id"
  | "agent_type"
  | "revision"
  | "targets"
  | "judgment"
  | "created_at"
  | "user_disposition"
>;
```

3. `ReviewApi` クラス内、`listRepositories()` の後に追加:

```ts
  listRepositoryFiles(repositoryId: string): Promise<{ repository_id: string; paths: string[] }> {
    const normalizedRepositoryId = repositoryId.trim();
    if (normalizedRepositoryId.length === 0) {
      return Promise.reject(new ReviewApiError("Repository ID is required", { status: 422, code: "INVALID_RECORD" }));
    }
    return this.request<{ repository_id: string; paths: string[] }>(
      `/v1/repositories/${encodeURIComponent(normalizedRepositoryId)}/files`,
    );
  }

  getFileDiff(repositoryId: string, path: string, base = "HEAD"): Promise<FileDiff> {
    const normalizedRepositoryId = repositoryId.trim();
    if (normalizedRepositoryId.length === 0) {
      return Promise.reject(new ReviewApiError("Repository ID is required", { status: 422, code: "INVALID_RECORD" }));
    }
    const params = new URLSearchParams({ path, base });
    return this.request<FileDiff>(`/v1/repositories/${encodeURIComponent(normalizedRepositoryId)}/diff?${params.toString()}`);
  }
```

4. ファイル末尾の再exportに `FileDiff` を追加:

```ts
export type { CheckEvidence, DecisionRecord, FileDiff, TargetReference, UserDisposition };
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `bun run --cwd apps/review-ui test src/api.test.ts`
Expected: PASS。

Run: `bun run --cwd apps/review-ui test`
Expected: PASS(App.test.tsx の `targets: []` 追加後)。

- [ ] **Step 5: Commit**

```bash
git add apps/review-ui/src/api.ts apps/review-ui/src/api.test.ts apps/review-ui/src/App.test.tsx
git commit -m "feat: add files and path-diff client methods to ReviewApi"
```

### Task 5: BootstrapScreen 抽出

**Files:**
- Create: `apps/review-ui/src/components/BootstrapScreen.tsx`
- Create: `apps/review-ui/src/components/BootstrapScreen.test.tsx`
- Modify: `apps/review-ui/src/App.tsx`(bootstrap 分岐のみ差し替え)

**Interfaces:**
- Consumes: 既存 `RegisteredRepositorySummary`。
- Produces:
  - `interface BootstrapScreenProps { tokenInput: string; onTokenChange: (value: string) => void; repositories: RegisteredRepositorySummary[] | null; selectedRepositoryId: string; onRepositoryChange: (id: string) => void; isLoading: boolean; error: string | null; onSubmit: () => void }`
  - 表示コピーとDOM構造(ラベル `Owner bearer token` / `Repository`、`role="alert"`、`aria-labelledby="bootstrap-heading"`)は現行 App から不変で抽出 — E2E/既存テストのセレクタを壊さない。

- [ ] **Step 1: Write the failing test**

`apps/review-ui/src/components/BootstrapScreen.test.tsx`:

```tsx
import { describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen } from "@testing-library/react";
import { BootstrapScreen } from "./BootstrapScreen";

const baseProps = {
  tokenInput: "",
  onTokenChange: vi.fn(),
  repositories: [
    { repository_id: "repo-1", root: "/work/repo-one", created_at: "2026-08-22T00:00:00.000Z" },
    { repository_id: "repo-2", root: "/work/repo-two", created_at: "2026-08-22T01:00:00.000Z" },
  ],
  selectedRepositoryId: "",
  onRepositoryChange: vi.fn(),
  isLoading: false,
  error: null as string | null,
  onSubmit: vi.fn(),
};

describe("BootstrapScreen", () => {
  it("collects the token and submits without embedding it anywhere else", () => {
    const onTokenChange = vi.fn();
    const onSubmit = vi.fn();
    render(<BootstrapScreen {...baseProps} onTokenChange={onTokenChange} onSubmit={onSubmit} />);

    fireEvent.change(screen.getByLabelText("Owner bearer token"), { target: { value: "owner-token" } });
    expect(onTokenChange).toHaveBeenCalledWith("owner-token");

    fireEvent.submit(screen.getByRole("button", { name: "Open review timeline" }).closest("form")!);
    expect(onSubmit).toHaveBeenCalled();
    expect(document.body.innerHTML).not.toContain('value="owner-token"');
  });

  it("renders the repository picker once repositories are loaded", () => {
    render(<BootstrapScreen {...baseProps} />);
    expect(screen.getByLabelText("Repository")).toBeTruthy();
    expect(screen.getByText("/work/repo-one")).toBeTruthy();
    expect(screen.getByRole("button", { name: "Open review timeline" }).textContent).toBe("Open review timeline");
  });

  it("hides the picker before repositories load and shows errors via role=alert", () => {
    render(<BootstrapScreen {...baseProps} repositories={null} isLoading={true} error="Owner token required or not accepted by Recorder." />);
    expect(screen.queryByLabelText("Repository")).toBeNull();
    expect(screen.getByRole("alert").textContent).toContain("Owner token required");
    expect(screen.getByRole("button", { name: "Connecting…" })).toBeTruthy();
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `bun run --cwd apps/review-ui test src/components/BootstrapScreen.test.tsx`
Expected: FAIL — モジュールが存在しない。

- [ ] **Step 3: Implement the component**

`apps/review-ui/src/components/BootstrapScreen.tsx`:

```tsx
import { FormEvent } from "react";
import type { RegisteredRepositorySummary } from "../api";

export interface BootstrapScreenProps {
  tokenInput: string;
  onTokenChange: (value: string) => void;
  repositories: RegisteredRepositorySummary[] | null;
  selectedRepositoryId: string;
  onRepositoryChange: (id: string) => void;
  isLoading: boolean;
  error: string | null;
  onSubmit: () => void;
}

export function BootstrapScreen({
  tokenInput,
  onTokenChange,
  repositories,
  selectedRepositoryId,
  onRepositoryChange,
  isLoading,
  error,
  onSubmit,
}: BootstrapScreenProps) {
  const pickingRepository = repositories !== null;

  function handleSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    onSubmit();
  }

  return (
    <main className="app-shell app-shell--bootstrap">
      <section className="bootstrap-card" aria-labelledby="bootstrap-heading">
        <p className="eyebrow">Local review evidence</p>
        <h1 id="bootstrap-heading">Review decisions with their source</h1>
        <p>Enter the owner token from Recorder and pick one of its registered repositories. The token stays in this browser tab's memory and is never written to storage or included in a URL.</p>
        <form onSubmit={handleSubmit}>
          <fieldset>
            <legend>Recorder connection</legend>
            <label htmlFor="owner-token">Owner bearer token</label>
            <input
              id="owner-token"
              name="owner-token"
              type="password"
              autoComplete="off"
              value={tokenInput}
              onChange={(event) => onTokenChange(event.target.value)}
              required
            />
            {pickingRepository && (
              <>
                <label htmlFor="repository">Repository</label>
                <select
                  id="repository"
                  name="repository"
                  value={selectedRepositoryId}
                  onChange={(event) => onRepositoryChange(event.target.value)}
                  required
                >
                  <option value="" disabled>Select a repository…</option>
                  {repositories.map((candidate) => (
                    <option key={candidate.repository_id} value={candidate.repository_id}>
                      {candidate.root}
                    </option>
                  ))}
                </select>
              </>
            )}
          </fieldset>
          {error !== null && <p className="inline-error" role="alert">{error}</p>}
          <button type="submit" disabled={isLoading}>
            {isLoading
              ? pickingRepository
                ? "Opening…"
                : "Connecting…"
              : pickingRepository
                ? "Open review timeline"
                : "Load repositories"}
          </button>
        </form>
      </section>
    </main>
  );
}
```

- [ ] **Step 4: Rewire App's bootstrap branch**

`apps/review-ui/src/App.tsx`:

1. import 追加・削除:

```tsx
import { useState } from "react";
// FormEvent import は不要になるので削除
import { BootstrapScreen } from "./components/BootstrapScreen";
```

2. `handleSubmit` を純粋なロジック関数に変更(FormEvent 処理を BootstrapScreen 側へ移したため):

```tsx
  async function handleSubmit() {
    setError(null);
    const token = tokenInput.trim();
    if (token.length === 0) {
      setError("Owner bearer token is required.");
      return;
    }
    // 以下、既存 handleSubmit の try/catch 本体をそのまま移動する
    // (repositories === null の分岐 → listRepositories、それ以降は Task 10 まで現行のまま)
```

3. bootstrap 描画(`if (api === null || repositoryId === null) { … }` ブロック全体)を次に置き換え:

```tsx
  if (api === null || repositoryId === null) {
    return (
      <BootstrapScreen
        tokenInput={tokenInput}
        onTokenChange={setTokenInput}
        repositories={repositories}
        selectedRepositoryId={selectedRepositoryId}
        onRepositoryChange={setSelectedRepositoryId}
        isLoading={isLoading}
        error={error}
        onSubmit={() => void handleSubmit()}
      />
    );
  }
```

- [ ] **Step 5: Run tests to verify they pass**

Run: `bun run --cwd apps/review-ui test`
Expected: PASS(`App.test.tsx` 既存2件 + 新規 BootstrapScreen テスト。App の挙動は変えていないため既存テストはそのまま通る)。

- [ ] **Step 6: Commit**

```bash
git add apps/review-ui/src/components/BootstrapScreen.tsx apps/review-ui/src/components/BootstrapScreen.test.tsx apps/review-ui/src/App.tsx
git commit -m "refactor: extract the review UI bootstrap screen"
```

### Task 6: DecisionCard コンポーネント

**Files:**
- Create: `apps/review-ui/src/components/DecisionCard.tsx`
- Test: `apps/review-ui/src/components/DecisionCard.test.tsx`

**Interfaces:**
- Consumes: `DecisionRecordDetail` / `SourceReferenceData` / `UserDisposition`(`api.ts`)。`SourceReference.tsx` の警告部コピー(unresolvedStateCopy)を吸収する。
- Produces:
  - `interface DecisionCardProps { detail: DecisionRecordDetail; onDispositionChange?: (disposition: UserDisposition) => Promise<DecisionRecordDetail | void>; onTargetClick?: (path: string, line: number) => void }`
  - 表示要素: 判断見出し(`judgment`)・meta(agent/作成時刻/revision)・disposition ボタン群(Accept/Reject/Mark unreviewed、`aria-pressed`)・rationale・checks・open questions・target リンクボタン `path:start–end`(クリックで `onTargetClick(path, line_start)`)・未解決source警告(`role="alert"`)。
  - disposition 失敗時はカード内 `role="alert"` 表示(既存 DecisionDetail と同様、楽順更新)。

- [ ] **Step 1: Write the failing tests**

`apps/review-ui/src/components/DecisionCard.test.tsx`:

```tsx
import { describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { DecisionCard } from "./DecisionCard";
import type { DecisionRecordDetail } from "../api";

const target = {
  repository_id: "repo-1",
  path: "src/feature.ts",
  line_start: 12,
  line_end: 16,
  revision: { kind: "commit" as const, sha: "abc123" },
  content_hash: "expected",
};

const detail: DecisionRecordDetail = {
  record: {
    record_id: "record-1",
    session_id: "session-1",
    repository_id: "repo-1",
    agent_type: "codex",
    revision: { kind: "commit", sha: "abc123" },
    targets: [target],
    judgment: "Needs a guard before accessing the value.",
    rationale: "The caller can pass an empty collection.",
    checks: [
      { name: "Type check", status: "passed", details: "No errors" },
      { name: "Regression test", status: "failed", details: "Missing coverage" },
    ],
    open_questions: ["Should the caller own this validation?"],
    created_at: "2026-08-20T10:00:00.000Z",
    user_disposition: "unreviewed",
  },
  sources: [
    {
      state: "resolved",
      repository_id: "repo-1",
      path: "src/feature.ts",
      revision: { kind: "commit", sha: "abc123" },
      target,
      content: "const value = items[0];",
      content_hash: "expected",
    },
  ],
};

describe("DecisionCard", () => {
  it("renders judgment, target link, rationale, checks, and open questions", () => {
    const onTargetClick = vi.fn();
    render(<DecisionCard detail={detail} onTargetClick={onTargetClick} />);

    expect(screen.getByRole("heading", { name: /needs a guard/i })).toBeTruthy();
    const targetLink = screen.getByRole("button", { name: "src/feature.ts:12–16" });
    expect(targetLink).toBeTruthy();
    fireEvent.click(targetLink);
    expect(onTargetClick).toHaveBeenCalledWith("src/feature.ts", 12);
    expect(screen.getByText("The caller can pass an empty collection.")).toBeTruthy();
    expect(screen.getByText("Type check")).toBeTruthy();
    expect(screen.getByText("Regression test")).toBeTruthy();
    expect(screen.getByText("Should the caller own this validation?")).toBeTruthy();
    expect(screen.queryByRole("alert")).toBeNull();
  });

  it("confirms a disposition before updating the displayed state", async () => {
    const onDispositionChange = vi.fn(async () => ({ ...detail, record: { ...detail.record, user_disposition: "accepted" as const } }));
    render(<DecisionCard detail={detail} onDispositionChange={onDispositionChange} />);

    const accepted = screen.getByRole("button", { name: "Accept" });
    fireEvent.click(accepted);
    expect(accepted.getAttribute("aria-pressed")).toBe("false");
    await waitFor(() => expect(accepted.getAttribute("aria-pressed")).toBe("true"));
    expect(onDispositionChange).toHaveBeenCalledWith("accepted");
  });

  it("keeps the current disposition and shows an alert when the mutation fails", async () => {
    const onDispositionChange = vi.fn(async () => {
      throw new Error("Recorder unavailable");
    });
    render(<DecisionCard detail={detail} onDispositionChange={onDispositionChange} />);

    const rejected = screen.getByRole("button", { name: "Reject" });
    fireEvent.click(rejected);
    await waitFor(() => expect(screen.getByRole("alert").textContent).toContain("Recorder unavailable"));
    expect(rejected.getAttribute("aria-pressed")).toBe("false");
    expect(screen.getByRole("button", { name: "Mark unreviewed" }).getAttribute("aria-pressed")).toBe("true");
  });

  it.each([
    ["hash-mismatch", "Source changed since the decision"],
    ["revision-not-found", "The recorded revision is no longer available"],
    ["source-unavailable", "Source is unavailable"],
  ] as const)("warns on an unresolved %s source without showing code", (state, message) => {
    const warned: DecisionRecordDetail = {
      ...detail,
      sources: [{
        state,
        repository_id: "repo-1",
        path: "src/feature.ts",
        revision: { kind: "working-tree", contentHash: "h1" },
        target: { ...target, revision: { kind: "working-tree", contentHash: "h1" } },
        expected_hash: "expected",
        actual_hash: state === "hash-mismatch" ? "actual" : undefined,
      }],
    };
    render(<DecisionCard detail={warned} />);

    const alert = screen.getAllByRole("alert").at(-1)!;
    expect(alert.textContent).toContain(message);
    expect(alert.textContent).toContain("expected");
    expect(screen.queryByText(/const value/)).toBeNull();
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `bun run --cwd apps/review-ui test src/components/DecisionCard.test.tsx`
Expected: FAIL — モジュールが存在しない。

- [ ] **Step 3: Implement**

`apps/review-ui/src/components/DecisionCard.tsx`:

```tsx
import { useEffect, useState } from "react";
import type { DecisionRecordDetail, SourceReferenceData, UserDisposition } from "../api";

interface DecisionCardProps {
  detail: DecisionRecordDetail;
  onDispositionChange?: (disposition: UserDisposition) => Promise<DecisionRecordDetail | void>;
  onTargetClick?: (path: string, line: number) => void;
}

const dispositionOptions: Array<{ value: UserDisposition; label: string }> = [
  { value: "accepted", label: "Accept" },
  { value: "rejected", label: "Reject" },
  { value: "unreviewed", label: "Mark unreviewed" },
];

const unresolvedStateCopy = {
  "hash-mismatch": {
    title: "Source changed since the decision",
    description: "The current source hash does not match the source that was reviewed.",
  },
  "revision-not-found": {
    title: "The recorded revision is no longer available",
    description: "The decision points to a revision that Recorder cannot find.",
  },
  "source-unavailable": {
    title: "Source is unavailable",
    description: "Recorder could not read the recorded source.",
  },
} as const;

function unresolvedSources(detail: DecisionRecordDetail): SourceReferenceData[] {
  return detail.sources.filter((source) => source.state !== "resolved" && source.state !== "snapshot-resolved");
}

function checkStatusLabel(status: "passed" | "failed" | "not-run"): string {
  if (status === "passed") return "Passed";
  if (status === "failed") return "Failed";
  return "Not run";
}

export function DecisionCard({ detail, onDispositionChange, onTargetClick }: DecisionCardProps) {
  const [displayedRecord, setDisplayedRecord] = useState(detail.record);
  const [isUpdating, setIsUpdating] = useState(false);
  const [mutationError, setMutationError] = useState<string | null>(null);

  useEffect(() => {
    setDisplayedRecord(detail.record);
    setMutationError(null);
  }, [detail.record]);

  async function changeDisposition(disposition: UserDisposition) {
    if (onDispositionChange === undefined || isUpdating) return;
    setIsUpdating(true);
    setMutationError(null);
    try {
      const updatedDetail = await onDispositionChange(disposition);
      if (updatedDetail !== undefined) setDisplayedRecord(updatedDetail.record);
    } catch (error) {
      setMutationError(error instanceof Error ? error.message : "Unable to update the disposition");
    } finally {
      setIsUpdating(false);
    }
  }

  const warnings = unresolvedSources(detail);

  return (
    <article className="decision-card" aria-labelledby={`decision-${displayedRecord.record_id}`}>
      <header className="decision-card__header">
        <div>
          <p className="eyebrow">Decision {displayedRecord.record_id}</p>
          <h3 id={`decision-${displayedRecord.record_id}`}>{displayedRecord.judgment}</h3>
          <p className="decision-card__meta">
            {displayedRecord.agent_type} · {new Date(displayedRecord.created_at).toLocaleString()} · revision {revisionText(displayedRecord.revision)}
          </p>
        </div>
        <fieldset className="disposition-controls" disabled={isUpdating || onDispositionChange === undefined}>
          <legend>Disposition</legend>
          {dispositionOptions.map((option) => (
            <button
              key={option.value}
              type="button"
              aria-pressed={displayedRecord.user_disposition === option.value}
              onClick={() => void changeDisposition(option.value)}
            >
              {option.label}
            </button>
          ))}
        </fieldset>
      </header>
      {isUpdating && <p role="status">Saving disposition…</p>}
      {mutationError !== null && <p className="inline-error" role="alert">{mutationError}</p>}

      {warnings.length > 0 && (
        <div className="decision-card__warnings">
          {warnings.map((source) => {
            const copy = unresolvedStateCopy[source.state];
            return (
              <div key={`${source.path}-${source.target.line_start}`} className="source-warning" role="alert">
                <h4>{copy.title}</h4>
                <p>{copy.description}</p>
                {source.message !== undefined && <p>{source.message}</p>}
                <dl className="source-metadata">
                  <div>
                    <dt>Expected hash</dt>
                    <dd><code>{source.expected_hash}</code></dd>
                  </div>
                  {source.actual_hash !== undefined && (
                    <div>
                      <dt>Actual hash</dt>
                      <dd><code>{source.actual_hash}</code></dd>
                    </div>
                  )}
                </dl>
                <p className="source-safety-note">Current code is intentionally not shown until this reference is resolved.</p>
              </div>
            );
          })}
        </div>
      )}

      <p className="preserve-text">{displayedRecord.rationale}</p>

      <section aria-labelledby={`checks-${displayedRecord.record_id}`}>
        <h4 id={`checks-${displayedRecord.record_id}`}>Checks</h4>
        {displayedRecord.checks.length === 0 ? (
          <p className="muted">No checks were recorded.</p>
        ) : (
          <ul className="check-list">
            {displayedRecord.checks.map((check) => (
              <li key={check.name}>
                <span className={`check-status check-status--${check.status}`}>{checkStatusLabel(check.status)}</span>
                <strong>{check.name}</strong>
                {check.details !== undefined && <span>{check.details}</span>}
              </li>
            ))}
          </ul>
        )}
      </section>

      <section aria-labelledby={`questions-${displayedRecord.record_id}`}>
        <h4 id={`questions-${displayedRecord.record_id}`}>Open questions</h4>
        {displayedRecord.open_questions.length === 0 ? (
          <p className="muted">No open questions.</p>
        ) : (
          <ul>
            {displayedRecord.open_questions.map((question) => <li key={question}>{question}</li>)}
          </ul>
        )}
      </section>

      <footer className="decision-card__targets">
        <h4>Targets</h4>
        {displayedRecord.targets.map((target) => (
          <button
            key={`${target.path}-${target.line_start}`}
            type="button"
            className="target-link"
            onClick={() => onTargetClick?.(target.path, target.line_start)}
          >
            <code>{target.path}:{target.line_start}–{target.line_end}</code>
          </button>
        ))}
      </footer>
    </article>
  );
}

function revisionText(revision: DecisionRecordDetail["record"]["revision"]): string {
  return revision.kind === "commit" ? revision.sha : revision.contentHash;
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `bun run --cwd apps/review-ui test src/components/DecisionCard.test.tsx`
Expected: PASS。

- [ ] **Step 5: Commit**

```bash
git add apps/review-ui/src/components/DecisionCard.tsx apps/review-ui/src/components/DecisionCard.test.tsx
git commit -m "feat: add DecisionCard with disposition and unresolved-source warnings"
```

### Task 7: JudgmentPanel コンポーネント

**Files:**
- Create: `apps/review-ui/src/components/JudgmentPanel.tsx`
- Test: `apps/review-ui/src/components/JudgmentPanel.test.tsx`

**Interfaces:**
- Consumes: `DecisionCard`(Task 6)、`decisionAnchors`/`overlapsBlock`/`BlockSelection`(`lib/decision-index.ts`)、`DecisionRecordDetail` / `UserDisposition`。
- Produces:
  - `interface JudgmentEntry { recordId: string; status: "loading" | "ready" | "error"; detail?: DecisionRecordDetail; message?: string }`
  - `interface JudgmentPanelProps { path: string | null; entries: JudgmentEntry[]; selectedBlock: BlockSelection | null; onDispositionChange: (recordId: string, disposition: UserDisposition) => Promise<DecisionRecordDetail>; onRetry: (recordId: string) => void; onTargetClick: (path: string, line: number) => void }`
  - 絞り込み述語: `selectedBlock !== null` のとき、`decisionAnchors(entry.detail)` のいずれかが `overlapsBlock` で一致する ready エントリのみ表示。`null` なら全件。
  - entries は App 側で `created_at` 降順に整列して渡す(パネルは並べ替えしない)。

- [ ] **Step 1: Write the failing tests**

`apps/review-ui/src/components/JudgmentPanel.test.tsx`:

```tsx
import { describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen } from "@testing-library/react";
import { JudgmentPanel, type JudgmentEntry } from "./JudgmentPanel";
import type { DecisionRecordDetail } from "../api";

function entryWithTarget(recordId: string, path: string, lineStart: number, lineEnd: number, side: "commit" | "worktree"): JudgmentEntry {
  const target = {
    repository_id: "repo-1",
    path,
    line_start: lineStart,
    line_end: lineEnd,
    revision: (side === "commit" ? { kind: "commit", sha: "abc" } : { kind: "working-tree", contentHash: "h1" }) as const,
    content_hash: "expected",
  };
  const detail: DecisionRecordDetail = {
    record: {
      record_id: recordId,
      session_id: `session-${recordId}`,
      repository_id: "repo-1",
      agent_type: "codex",
      revision: side === "commit" ? { kind: "commit", sha: "abc" } : { kind: "working-tree", contentHash: "h1" },
      targets: [target],
      judgment: `Judgment ${recordId}`,
      rationale: "",
      checks: [],
      open_questions: [],
      created_at: "2026-08-20T10:00:00.000Z",
      user_disposition: "unreviewed",
    },
    sources: [
      side === "commit"
        ? { state: "resolved" as const, repository_id: "repo-1", path, revision: { kind: "commit", sha: "abc" }, target, content: "code", content_hash: "expected" }
        : { state: "resolved" as const, repository_id: "repo-1", path, revision: { kind: "working-tree", contentHash: "h1" }, target, content: "code", content_hash: "expected" },
    ],
  };
  return { recordId, status: "ready", detail };
}

const baseProps = {
  path: "src/a.ts",
  selectedBlock: null,
  onDispositionChange: vi.fn(async () => {
    throw new Error("not used");
  }),
  onRetry: vi.fn(),
  onTargetClick: vi.fn(),
};

describe("JudgmentPanel", () => {
  it("shows all ready cards newest first and empty states without a file", () => {
    render(<JudgmentPanel {...baseProps} entries={[entryWithTarget("r1", "src/a.ts", 4, 6, "commit")]} />);
    expect(screen.getByRole("heading", { name: "Judgment r1" })).toBeTruthy();

    render(<JudgmentPanel {...baseProps} path={null} entries={[]} />);
    expect(screen.getByText("Select a file in the explorer to review its judgments.")).toBeTruthy();
  });

  it("filters to overlapping decisions when a block is selected and restores on clear", () => {
    const oldSide = entryWithTarget("old-side", "src/a.ts", 5, 7, "commit");
    const newSide = entryWithTarget("new-side", "src/a.ts", 2, 3, "worktree");
    const unrelated = entryWithTarget("unrelated", "src/b.ts", 1, 2, "commit");
    render(
      <JudgmentPanel
        {...baseProps}
        entries={[oldSide, newSide, unrelated]}
        selectedBlock={{ oldStart: 5, oldEnd: 7, newStart: null, newEnd: null }}
      />,
    );

    expect(screen.getByRole("heading", { name: "Judgment old-side" })).toBeTruthy();
    expect(screen.queryByRole("heading", { name: "Judgment new-side" })).toBeNull();
    expect(screen.queryByRole("heading", { name: "Judgment unrelated" })).toBeNull();

    fireEvent.click(screen.getByRole("button", { name: "Clear block filter" }));
    expect(baseProps.onRetry).not.toHaveBeenCalled();
    // clearing is the parent's job through onSelectBlock; the button only reports intent is covered by DiffView tests
  });

  it("renders loading placeholders and per-card errors with retry", () => {
    const onRetry = vi.fn();
    render(
      <JudgmentPanel
        {...baseProps}
        entries={[
          { recordId: "loading-record", status: "loading" },
          { recordId: "broken-record", status: "error", message: "Recorder request failed" },
        ]}
      />,
    );

    expect(screen.getByText("Loading decision…")).toBeTruthy();
    expect(screen.getByRole("alert").textContent).toContain("Recorder request failed");
    fireEvent.click(screen.getByRole("button", { name: /Retry broken-record/ }));
    expect(onRetry).toHaveBeenCalledWith("broken-record");
  });
});
```

注: 「Clear block filter」ボタンはパネルヘッダーに置き、`onSelectBlock` を通じて親へ解除を依頼する。上のテストの第2ケースは `onSelectBlock` prop を介さないため、実装では props に `onSelectBlock: (block: BlockSelection | null) => void` を追加し、テストにも渡すこと(下の Step 3 参照)。テスト第2ケースは次のように書き換える:

```tsx
    const onSelectBlock = vi.fn();
    render(
      <JudgmentPanel
        {...baseProps}
        entries={[oldSide, newSide, unrelated]}
        selectedBlock={{ oldStart: 5, oldEnd: 7, newStart: null, newEnd: null }}
        onSelectBlock={onSelectBlock}
      />,
    );
    expect(screen.getByRole("heading", { name: "Judgment old-side" })).toBeTruthy();
    expect(screen.queryByRole("heading", { name: "Judgment new-side" })).toBeNull();
    expect(screen.queryByRole("heading", { name: "Judgment unrelated" })).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "Clear block filter" }));
    expect(onSelectBlock).toHaveBeenCalledWith(null);
```

(`baseProps` には `onSelectBlock: vi.fn()` を追加しておく。)

- [ ] **Step 2: Run tests to verify they fail**

Run: `bun run --cwd apps/review-ui test src/components/JudgmentPanel.test.tsx`
Expected: FAIL — モジュールが存在しない。

- [ ] **Step 3: Implement**

`apps/review-ui/src/components/JudgmentPanel.tsx`:

```tsx
import type { BlockSelection, DecisionAnchor } from "../lib/decision-index";
import { decisionAnchors, overlapsBlock } from "../lib/decision-index";
import type { DecisionRecordDetail, UserDisposition } from "../api";
import { DecisionCard } from "./DecisionCard";

export interface JudgmentEntry {
  recordId: string;
  status: "loading" | "ready" | "error";
  detail?: DecisionRecordDetail;
  message?: string;
}

interface JudgmentPanelProps {
  path: string | null;
  entries: JudgmentEntry[];
  selectedBlock: BlockSelection | null;
  onSelectBlock: (block: BlockSelection | null) => void;
  onDispositionChange: (recordId: string, disposition: UserDisposition) => Promise<DecisionRecordDetail>;
  onRetry: (recordId: string) => void;
  onTargetClick: (path: string, line: number) => void;
}

function matchesSelectedBlock(detail: DecisionRecordDetail, selectedBlock: BlockSelection): boolean {
  return decisionAnchors(detail).some((anchor: DecisionAnchor) => overlapsBlock(anchor, selectedBlock));
}

export function JudgmentPanel({
  path,
  entries,
  selectedBlock,
  onSelectBlock,
  onDispositionChange,
  onRetry,
  onTargetClick,
}: JudgmentPanelProps) {
  if (path === null) {
    return (
      <section className="judgment-panel" aria-label="Judgments">
        <p className="empty-state">Select a file in the explorer to review its judgments.</p>
      </section>
    );
  }

  const visibleEntries = selectedBlock === null
    ? entries
    : entries.filter((entry) =>
        entry.status === "ready" && entry.detail !== undefined && matchesSelectedBlock(entry.detail, selectedBlock),
      );

  return (
    <section className="judgment-panel" aria-label="Judgments">
      <div className="section-heading">
        <h2>Judgments</h2>
        <span>
          {visibleEntries.length} of {entries.length}
          {selectedBlock !== null && (
            <button type="button" className="button-secondary" onClick={() => onSelectBlock(null)}>
              Clear block filter
            </button>
          )}
        </span>
      </div>

      <div className="judgment-stack">
        {visibleEntries.map((entry) => {
          if (entry.status === "loading") {
            return <p key={entry.recordId} role="status">Loading decision…</p>;
          }
          if (entry.status === "error") {
            return (
              <div key={entry.recordId} className="inline-error" role="alert">
                <p>{entry.message ?? "Unable to load this decision."}</p>
                <button type="button" onClick={() => onRetry(entry.recordId)}>Retry {entry.recordId}</button>
              </div>
            );
          }
          return (
            <DecisionCard
              key={entry.recordId}
              detail={entry.detail!}
              onDispositionChange={(disposition) => onDispositionChange(entry.recordId, disposition)}
              onTargetClick={onTargetClick}
            />
          );
        })}
        {entries.length > 0 && visibleEntries.length === 0 && (
          <p className="empty-state">No judgments overlap the selected lines.</p>
        )}
        {entries.length === 0 && (
          <p className="empty-state">No decisions have been recorded for this file.</p>
        )}
      </div>
    </section>
  );
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `bun run --cwd apps/review-ui test src/components/JudgmentPanel.test.tsx`
Expected: PASS。

- [ ] **Step 5: Commit**

```bash
git add apps/review-ui/src/components/JudgmentPanel.tsx apps/review-ui/src/components/JudgmentPanel.test.tsx
git commit -m "feat: add JudgmentPanel with block-scoped filtering"
```

### Task 8: DiffView コンポーネント

**Files:**
- Create: `apps/review-ui/src/components/DiffView.tsx`
- Test: `apps/review-ui/src/components/DiffView.test.tsx`

**Interfaces:**
- Consumes: contracts の `FileDiff` / `DiffLine`(`packages/contracts/src/index`)、`ReviewApiError`(`../api`)、`DecisionAnchor` / `BlockSelection`(Task 3 の `lib/decision-index.ts`)。
- Produces:
  - 名前付きエクスポート `DiffView`。
  - `export interface DiffViewProps { path: string | null; isLoading: boolean; error: ReviewApiError | Error | null; diff: FileDiff | null; anchors: DecisionAnchor[]; selectedBlock: BlockSelection | null; onSelectBlock: (block: BlockSelection | null) => void; fullText: { content: string; anchors: DecisionAnchor[] } | null; navigateTo: { line: number; token: number } | null; onRetry: () => void }`
  - ブロック選択(§6.2.3): hunk内の連続する同種add/del行(maximal run)をクリック → `onSelectBlock({ oldStart, oldEnd, newStart, newEnd })`(nullの辺は範囲なし)。同一ブロック再クリックかcontext行クリックで `onSelectBlock(null)`。
  - アンカー表示(§6.2.2): 検証済みアンカー行のみに `diff-line--anchored`(ガーターマーカー+ティント)。旧側アンカーは旧行番号、新側アンカーは新行番号で辺ごとに厳密判定。
  - 全文モード(§6.2.6): `hunks.length === 0 && !binary` かつ `fullText !== null` で旧=新の同一内容+検証済み対象行ハイライト(data-new-line付き)。`fullText === null` なら「差分なし」空状態。
  - 逆ナビゲーション(§6.2.4): `navigateTo` 変化で該当行へscroll+1.2秒の `diff-line--pulse`。
  - エラーカード(§7): `REVIEW_NOT_FOUND`ではなく **`REVISION_NOT_FOUND`**→"The recorded revision could not be found." / `PAYLOAD_TOO_LARGE`→"Source exceeds the size limit." / その他→`error.message`+Retryボタン。
  - コピーはすべて英語(Global Constraints)。バイナリ(§6.2.7)は "Binary files cannot be shown in the diff view."。

- [ ] **Step 1: Write the failing tests**

`apps/review-ui/src/components/DiffView.test.tsx`:

```tsx
import { afterEach, describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen } from "@testing-library/react";
import { DiffView } from "./DiffView";
import type { ReviewApiError } from "../api";
import type { DecisionAnchor } from "../lib/decision-index";
import type { DiffLine, FileDiff } from "../../../../packages/contracts/src/index";

function line(partial: DiffLine): DiffLine {
  return partial;
}

function fileDiff(overrides: Partial<FileDiff> = {}): FileDiff {
  return {
    path: "src/a.ts",
    base_sha: "abc123def456",
    old_missing: false,
    new_missing: false,
    binary: false,
    hunks: [
      {
        oldStart: 1,
        newStart: 1,
        lines: [
          line({ type: "context", oldLine: 1, newLine: 1, content: "const before = 1;" }),
          line({ type: "del", oldLine: 2, newLine: null, content: "const removed = 2;" }),
          line({ type: "add", oldLine: null, newLine: 2, content: "const added = 3;" }),
          line({ type: "context", oldLine: 3, newLine: 3, content: "const tail = 4;" }),
        ],
      },
    ],
    ...overrides,
  };
}

const baseProps = {
  path: "src/a.ts",
  isLoading: false,
  error: null,
  diff: fileDiff(),
  anchors: [
    { side: "old", start: 1, end: 1 },
    { side: "new", start: 2, end: 2 },
  ] satisfies DecisionAnchor[],
  selectedBlock: null,
  onSelectBlock: vi.fn(),
  fullText: null,
  navigateTo: null,
  onRetry: vi.fn(),
};

afterEach(() => {
  vi.restoreAllMocks();
});

describe("DiffView", () => {
  it("renders hunk lines with gutters and tints only verified anchored lines", () => {
    render(<DiffView {...baseProps} />);

    const rows = screen.getAllByRole("listitem");
    expect(rows).toHaveLength(4);
    // 旧側アンカー(old 1..1)はcontext行の旧行番号1に一致、新側アンカー(new 2..2)はadd行に一致
    expect(rows[0].className).toContain("diff-line--anchored"); // context old=1
    expect(rows[1].className).not.toContain("diff-line--anchored"); // del: 新側アンカーは新行番号がnullなので不適合
    expect(rows[2].className).toContain("diff-line--anchored"); // add new=2
    expect(rows[3].className).not.toContain("diff-line--anchored");
    expect(screen.getByText("const removed = 2;")).toBeTruthy();
    expect(screen.getByText("-")).toBeTruthy();
    expect(document.querySelector('[data-old-line="2"]')).not.toBeNull();
    expect(document.querySelector('[data-new-line="2"]')).not.toBeNull();
    expect(document.querySelector('[data-new-line="1"]')).toBeNull(); // add行には新行番号のみ
  });

  it("selects a maximal add run on click and clears on context click", () => {
    const onSelectBlock = vi.fn();
    render(<DiffView {...baseProps} onSelectBlock={onSelectBlock} />);

    fireEvent.click(screen.getByText("const added = 3;"));
    expect(onSelectBlock).toHaveBeenLastCalledWith({
      oldStart: null,
      oldEnd: null,
      newStart: 2,
      newEnd: 2,
    });

    fireEvent.click(screen.getByText("const tail = 4;"));
    expect(onSelectBlock).toHaveBeenLastCalledWith(null);
  });

  it("selects the whole del run and reports an old-side-only range", () => {
    const onSelectBlock = vi.fn();
    const diff = fileDiff({
      hunks: [
        {
          oldStart: 1,
          newStart: 1,
          lines: [
            line({ type: "del", oldLine: 1, newLine: null, content: "alpha();" }),
            line({ type: "del", oldLine: 2, newLine: null, content: "beta();" }),
            line({ type: "add", oldLine: null, newLine: 1, content: "gamma();" }),
          ],
        },
      ],
    });
    render(<DiffView {...baseProps} diff={diff} anchors={[]} onSelectBlock={onSelectBlock} />);

    fireEvent.click(screen.getByText("alpha();"));
    expect(onSelectBlock).toHaveBeenLastCalledWith({
      oldStart: 1,
      oldEnd: 2,
      newStart: null,
      newEnd: null,
    });
  });

  it("highlights the selected block and toggles it off when clicked again", () => {
    const onSelectBlock = vi.fn();
    const selectedBlock = { oldStart: null, oldEnd: null, newStart: 2, newEnd: 2 };
    render(<DiffView {...baseProps} selectedBlock={selectedBlock} onSelectBlock={onSelectBlock} />);

    const addRow = screen.getAllByRole("listitem")[2];
    expect(addRow.className).toContain("diff-line--selected");

    fireEvent.click(screen.getByText("const added = 3;"));
    expect(onSelectBlock).toHaveBeenCalledWith(null);
  });

  it("shows a dedicated message for binary files", () => {
    render(<DiffView {...baseProps} diff={fileDiff({ binary: true, hunks: [] })} />);
    expect(screen.getByText("Binary files cannot be shown in the diff view.")).toBeTruthy();
  });

  it("shows full-text mode with anchored highlights when there is no textual diff", () => {
    render(
      <DiffView
        {...baseProps}
        diff={fileDiff({ hunks: [] })}
        fullText={{
          content: "alpha\nbeta\ngamma",
          anchors: [{ side: "new", start: 2, end: 2 }],
        }}
      />,
    );

    const rows = screen.getAllByRole("listitem");
    expect(rows).toHaveLength(3);
    expect(rows[1].className).toContain("diff-line--anchored");
    expect(screen.getByText("beta")).toBeTruthy();
    expect(document.querySelector('[data-new-line="2"]')).not.toBeNull();
  });

  it("shows the no-changes empty state when there is no diff and no resolved source", () => {
    render(<DiffView {...baseProps} diff={fileDiff({ hunks: [] })} />);
    expect(
      screen.getByText("No changes between the recorded revision and the working tree."),
    ).toBeTruthy();
  });

  it.each([
    ["REVISION_NOT_FOUND", 404, "The recorded revision could not be found."],
    ["PAYLOAD_TOO_LARGE", 413, "Source exceeds the size limit."],
  ] as const)("maps %s to its card copy with retry", (code, status, expected) => {
    render(<DiffView {...baseProps} diff={null} error={new ReviewApiError(expected, { code, status })} />);
    expect(screen.getByText(expected)).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Retry" }));
    expect(baseProps.onRetry).toHaveBeenCalled();
  });

  it("shows other errors with their own message and retry", () => {
    render(<DiffView {...baseProps} diff={null} error={new Error("Recorder request failed")} />);
    expect(screen.getByText("Recorder request failed")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Retry" }));
    expect(baseProps.onRetry).toHaveBeenCalled();
  });

  it("shows the loading state", () => {
    render(<DiffView {...baseProps} diff={null} isLoading />);
    expect(screen.getByRole("status").textContent).toContain("Loading diff");
  });

  it("scrolls to and pulses the navigateTo line", () => {
    const scrollIntoView = vi.fn();
    Object.defineProperty(Element.prototype, "scrollIntoView", {
      value: scrollIntoView,
      configurable: true,
    });
    vi.useFakeTimers();
    try {
      render(<DiffView {...baseProps} navigateTo={{ line: 2, token: 1 }} />);
      expect(scrollIntoView).toHaveBeenCalledTimes(1);
      const row = document.querySelector<HTMLElement>('[data-new-line="2"]');
      expect(row?.className).toContain("diff-line--pulse");
      vi.runAllTimers();
      expect(row?.className).not.toContain("diff-line--pulse");
    } finally {
      vi.useRealTimers();
    }
  });

  it("prompts for file selection when no path is chosen", () => {
    render(<DiffView {...baseProps} path={null} diff={null} />);
    expect(screen.getByText("Select a file in the explorer to see its diff.")).toBeTruthy();
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `bun run --cwd apps/review-ui test src/components/DiffView.test.tsx`
Expected: FAIL — `Failed to resolve import "./DiffView"`。

- [ ] **Step 3: Write the implementation**

`apps/review-ui/src/components/DiffView.tsx`:

```tsx
import { useEffect, useRef } from "react";
import type { DiffLine, FileDiff } from "../../../../packages/contracts/src/index";
import type { ReviewApiError } from "../api";
import type { BlockSelection, DecisionAnchor } from "../lib/decision-index";

export interface DiffViewProps {
  path: string | null;
  isLoading: boolean;
  error: ReviewApiError | Error | null;
  diff: FileDiff | null;
  anchors: DecisionAnchor[];
  selectedBlock: BlockSelection | null;
  onSelectBlock: (block: BlockSelection | null) => void;
  fullText: { content: string; anchors: DecisionAnchor[] } | null;
  /** カードからの逆ナビゲーション(§6.2.4)。tokenが変わるたびに再スクロールする。 */
  navigateTo: { line: number; token: number } | null;
  onRetry: () => void;
}

function lineAnchored(row: DiffLine, anchors: DecisionAnchor[]): boolean {
  return anchors.some((anchor) =>
    anchor.side === "old"
      ? row.oldLine !== null && anchor.start <= row.oldLine && row.oldLine <= anchor.end
      : row.newLine !== null && anchor.start <= row.newLine && row.newLine <= anchor.end,
  );
}

/** クリック行を含むmaximal run(§6.2.3)。context行ならnull。 */
function blockRun(rows: DiffLine[], index: number): BlockSelection | null {
  const kind = rows[index].type;
  if (kind === "context") return null;
  let start = index;
  while (start > 0 && rows[start - 1].type === kind) start -= 1;
  let end = index;
  while (end < rows.length - 1 && rows[end + 1].type === kind) end += 1;
  const run = rows.slice(start, end + 1);
  const dels = run.filter((row) => row.type === "del");
  const adds = run.filter((row) => row.type === "add");
  return {
    oldStart: dels.length > 0 ? dels[0].oldLine : null,
    oldEnd: dels.length > 0 ? dels[dels.length - 1].oldLine : null,
    newStart: adds.length > 0 ? adds[0].newLine : null,
    newEnd: adds.length > 0 ? adds[adds.length - 1].newLine : null,
  };
}

function sameBlock(a: BlockSelection | null, b: BlockSelection | null): boolean {
  if (a === null || b === null) return false;
  return (
    a.oldStart === b.oldStart &&
    a.oldEnd === b.oldEnd &&
    a.newStart === b.newStart &&
    a.newEnd === b.newEnd
  );
}

function errorCardMessage(error: ReviewApiError | Error): string {
  if (!(error instanceof ReviewApiError)) return error.message;
  if (error.code === "REVISION_NOT_FOUND") return "The recorded revision could not be found.";
  if (error.code === "PAYLOAD_TOO_LARGE") return "Source exceeds the size limit.";
  return error.message;
}

function LineRow(props: {
  row: DiffLine;
  anchored: boolean;
  selected: boolean;
  onSelect: () => void;
}) {
  const { row, anchored, selected, onSelect } = props;
  const tone =
    row.type === "add" ? "diff-line--add" : row.type === "del" ? "diff-line--del" : "diff-line--context";
  const gutter = row.type === "del" ? row.oldLine : row.newLine;
  return (
    <li
      className={[
        "diff-line",
        tone,
        anchored ? "diff-line--anchored" : "",
        selected ? "diff-line--selected" : "",
      ]
        .filter(Boolean)
        .join(" ")}
      data-old-line={row.oldLine ?? undefined}
      data-new-line={row.newLine ?? undefined}
    >
      <button type="button" className="diff-line__body" onClick={onSelect}>
        <span className="line-number" aria-hidden="true">
          {gutter ?? ""}
        </span>
        <span className="line-sign" aria-hidden="true">
          {row.type === "add" ? "+" : row.type === "del" ? "-" : " "}
        </span>
        <code>{row.content}</code>
      </button>
    </li>
  );
}

export function DiffView({
  path,
  isLoading,
  error,
  diff,
  anchors,
  selectedBlock,
  onSelectBlock,
  fullText,
  navigateTo,
  onRetry,
}: DiffViewProps) {
  const rootRef = useRef<HTMLElement | null>(null);

  useEffect(() => {
    if (navigateTo === null || rootRef.current === null) return;
    const target = rootRef.current.querySelector(
      `[data-old-line="${navigateTo.line}"], [data-new-line="${navigateTo.line}"]`,
    );
    if (!(target instanceof HTMLElement)) return;
    target.scrollIntoView({ block: "center" });
    target.classList.add("diff-line--pulse");
    window.setTimeout(() => target.classList.remove("diff-line--pulse"), 1200);
  }, [navigateTo]);

  const shell = (children: ReactNode, heading = true) => (
    <section ref={rootRef} className="diff-view" aria-label="Source diff">
      {heading && (
        <header className="diff-view__header">
          <h2>{path}</h2>
          {diff !== null && !diff.binary && diff.base_sha.length > 0 && (
            <code className="diff-view__base">vs {diff.base_sha.slice(0, 12)}</code>
          )}
        </header>
      )}
      {children}
    </section>
  );

  if (path === null) {
    return shell(<p className="empty-state">Select a file in the explorer to see its diff.</p>, false);
  }
  if (isLoading) {
    return shell(
      <p role="status" className="empty-state">
        Loading diff…
      </p>,
      false,
    );
  }
  if (error !== null) {
    return shell(
      <div className="inline-error" role="alert">
        <p>{errorCardMessage(error)}</p>
        <button type="button" onClick={onRetry}>
          Retry
        </button>
      </div>,
    );
  }
  if (diff === null) {
    return shell(<p className="empty-state">Select a file in the explorer to see its diff.</p>, false);
  }
  if (diff.binary) {
    return shell(<p className="empty-state">Binary files cannot be shown in the diff view.</p>);
  }
  if (diff.hunks.length === 0 && fullText === null) {
    return shell(
      <p className="empty-state">No changes between the recorded revision and the working tree.</p>,
    );
  }

  if (diff.hunks.length === 0 && fullText !== null) {
    const contents = fullText.content.split("\n");
    return shell(
      <ol className="diff-lines">
        {contents.map((content, index) => {
          const lineNumber = index + 1;
          const anchored = fullText.anchors.some(
            (anchor) => anchor.side === "new" && anchor.start <= lineNumber && lineNumber <= anchor.end,
          );
          return (
            <li
              key={lineNumber}
              className={`diff-line diff-line--context${anchored ? " diff-line--anchored" : ""}`}
              data-new-line={lineNumber}
            >
              <span className="diff-line__static" aria-hidden="true">
                <span className="line-number">{lineNumber}</span>
                <span className="line-sign">{" "}</span>
              </span>
              <code>{content}</code>
            </li>
          );
        })}
      </ol>,
    );
  }

  return shell(
    <>
      {diff.hunks.map((hunk, hunkIndex) => (
        <ol className="diff-lines" key={`${hunk.oldStart}:${hunk.newStart}:${hunkIndex}`}>
          {hunk.lines.map((row, index) => {
            const run = blockRun(hunk.lines, index);
            const selected = sameBlock(run, selectedBlock);
            return (
              <LineRow
                key={`${index}-${row.content}`}
                row={row}
                anchored={lineAnchored(row, anchors)}
                selected={selected}
                onSelect={() => onSelectBlock(run === null || selected ? null : run)}
              />
            );
          })}
        </ol>
      ))}
    </>,
  );
}
```

実装上の注意:
- `ReactNode` を使うため `import { useEffect, useRef, type ReactNode } from "react";` としてimportすること(上のコード冒頭のimportに `type ReactNode` を追加する)。
- `shell()` は全分岐で同じ `rootRef` を共有するため、全文モードでも逆ナビゲーションが機能する。
- `data-*` 属性はReactが `undefined` を属性ごと省略するため、del行に `data-new-line` は出ない(テストの `[data-new-line="1"]` 存在否定がこれを守る)。

- [ ] **Step 4: Run tests to verify they pass**

Run: `bun run --cwd apps/review-ui test src/components/DiffView.test.tsx`
Expected: PASS(11件)

- [ ] **Step 5: Commit**

```bash
git add apps/review-ui/src/components/DiffView.tsx apps/review-ui/src/components/DiffView.test.tsx
git commit -m "feat: add DiffView with structured hunks, verified anchors, and block selection"
```

### Task 9: Explorer コンポーネント

**Files:**
- Create: `apps/review-ui/src/components/Explorer.tsx`
- Test: `apps/review-ui/src/components/Explorer.test.tsx`

**Interfaces:**
- Consumes: `FileTreeNode`(Task 3 の `lib/file-tree.ts`、`buildFileTree` の戻り値。root は `path: ""`)。
- Produces:
  - 名前付きエクスポート `Explorer`。
  - `export interface ExplorerProps { tree: FileTreeNode; selectedPath: string | null; isLoading: boolean; error: Error | null; onRetry: () => void; onOpenFile: (path: string) => void }`
  - ディレクトリは折りたたみ可能(既定は展開)。クリックで `aria-expanded` が切り替わり、子の表示/非表示が変わる。
  - ファイル行はbuttonで、`decisionCount > 0` のとき `.explorer__badge` バッジを表示(§6.2 要件2)。選択中ファイルに `aria-current="true"`(§6.2.8)。
  - エラー時(§7 行1): Explorerペイン内に `role="alert"` + Retry。ロード中は `role="status"`。

- [ ] **Step 1: Write the failing tests**

`apps/review-ui/src/components/Explorer.test.tsx`:

```tsx
import { describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen } from "@testing-library/react";
import { Explorer } from "./Explorer";
import type { FileTreeNode } from "../lib/file-tree";

function node(
  partial: Partial<FileTreeNode> & { name: string; path: string; isFile: boolean },
): FileTreeNode {
  return { decisionCount: 0, children: [], ...partial };
}

function treeFixture(): FileTreeNode {
  return node({
    name: "",
    path: "",
    isFile: false,
    children: [
      node({
        name: "src",
        path: "src",
        isFile: false,
        children: [
          node({ name: "api.ts", path: "src/api.ts", isFile: true, decisionCount: 2 }),
          node({ name: "util.ts", path: "src/util.ts", isFile: true }),
        ],
      }),
      node({ name: "README.md", path: "README.md", isFile: true, decisionCount: 1 }),
    ],
  });
}

const baseProps = {
  tree: treeFixture(),
  selectedPath: null,
  isLoading: false,
  error: null,
  onRetry: vi.fn(),
  onOpenFile: vi.fn(),
};

describe("Explorer", () => {
  it("renders nested directories and files from the tree root", () => {
    render(<Explorer {...baseProps} />);

    expect(screen.getByRole("button", { name: /src/ })).toBeTruthy();
    expect(screen.getByRole("button", { name: /api\.ts/ })).toBeTruthy();
    expect(screen.getByRole("button", { name: /util\.ts/ })).toBeTruthy();
    expect(screen.getByRole("button", { name: /README\.md/ })).toBeTruthy();
  });

  it("opens a file and reports its full path on click", () => {
    const onOpenFile = vi.fn();
    render(<Explorer {...baseProps} onOpenFile={onOpenFile} />);

    fireEvent.click(screen.getByText("api.ts"));
    expect(onOpenFile).toHaveBeenCalledWith("src/api.ts");
  });

  it("marks the selected file with aria-current", () => {
    render(<Explorer {...baseProps} selectedPath="src/api.ts" />);

    const selected = screen.getByText("api.ts").closest("button");
    expect(selected?.getAttribute("aria-current")).toBe("true");
    const other = screen.getByText("README.md").closest("button");
    expect(other?.getAttribute("aria-current")).toBeNull();
  });

  it("collapses and re-expands a directory on click", () => {
    render(<Explorer {...baseProps} />);

    fireEvent.click(screen.getByRole("button", { name: /src/ }));
    expect(screen.queryByText("api.ts")).toBeNull();
    expect(screen.queryByText("util.ts")).toBeNull();

    fireEvent.click(screen.getByRole("button", { name: /src/ }));
    expect(screen.getByText("api.ts")).toBeTruthy();
  });

  it("shows decision count badges only for files with decisions", () => {
    render(<Explorer {...baseProps} />);

    const apiButton = screen.getByText("api.ts").closest("button");
    expect(apiButton?.querySelector(".explorer__badge")?.textContent).toBe("2");
    const readmeButton = screen.getByText("README.md").closest("button");
    expect(readmeButton?.querySelector(".explorer__badge")?.textContent).toBe("1");
    const utilButton = screen.getByText("util.ts").closest("button");
    expect(utilButton?.querySelector(".explorer__badge")).toBeNull();
  });

  it("shows the loading state", () => {
    render(<Explorer {...baseProps} isLoading tree={node({ name: "", path: "", isFile: false })} />);
    expect(screen.getByRole("status").textContent).toContain("Loading repository tree");
  });

  it("shows a pane-level error with retry when listing files fails", () => {
    const onRetry = vi.fn();
    render(<Explorer {...baseProps} error={new Error("Recorder request failed")} onRetry={onRetry} />);

    expect(screen.getByRole("alert").textContent).toContain("Recorder request failed");
    fireEvent.click(screen.getByRole("button", { name: "Retry" }));
    expect(onRetry).toHaveBeenCalled();
  });

  it("shows an empty state for a repository without tracked files", () => {
    render(<Explorer {...baseProps} tree={node({ name: "", path: "", isFile: false })} />);
    expect(screen.getByText("No tracked files found.")).toBeTruthy();
  });
});
```

実装上の注意(テスト用):
- ディレクトリボタンの accessible name はシェブロン記号を含むため `name: /src/` の正規表現で照合する。
- `getByText("api.ts")` はファイル名spanのみに一致する(`src/api.ts` という完全パスはツリー内テキストとして表示しない)。

- [ ] **Step 2: Run tests to verify they fail**

Run: `bun run --cwd apps/review-ui test src/components/Explorer.test.tsx`
Expected: FAIL — `Failed to resolve import "./Explorer"`。

- [ ] **Step 3: Write the implementation**

`apps/review-ui/src/components/Explorer.tsx`:

```tsx
import { useState } from "react";
import type { FileTreeNode } from "../lib/file-tree";

export interface ExplorerProps {
  tree: FileTreeNode;
  selectedPath: string | null;
  isLoading: boolean;
  error: Error | null;
  onRetry: () => void;
  /** ファイル行クリック。引数はルート相対のフルパス。 */
  onOpenFile: (path: string) => void;
}

function TreeItem(props: {
  item: FileTreeNode;
  selectedPath: string | null;
  collapsed: ReadonlySet<string>;
  onToggleDir: (path: string) => void;
  onOpenFile: (path: string) => void;
}) {
  const { item, selectedPath, collapsed, onToggleDir, onOpenFile } = props;

  if (!item.isFile) {
    const isCollapsed = collapsed.has(item.path);
    return (
      <li className="explorer__item">
        <button
          type="button"
          className="explorer__dir"
          aria-expanded={!isCollapsed}
          onClick={() => onToggleDir(item.path)}
        >
          <span className="explorer__chevron" aria-hidden="true">
            {isCollapsed ? "▸" : "▾"}
          </span>
          <span>{item.name}</span>
        </button>
        {!isCollapsed && (
          <ul className="explorer__group">
            {item.children.map((child) => (
              <TreeItem
                key={child.path}
                item={child}
                selectedPath={selectedPath}
                collapsed={collapsed}
                onToggleDir={onToggleDir}
                onOpenFile={onOpenFile}
              />
            ))}
          </ul>
        )}
      </li>
    );
  }

  return (
    <li className="explorer__item">
      <button
        type="button"
        className="explorer__file"
        aria-current={selectedPath === item.path || undefined}
        onClick={() => onOpenFile(item.path)}
      >
        <span className="explorer__name">{item.name}</span>
        {item.decisionCount > 0 && <span className="explorer__badge">{item.decisionCount}</span>}
      </button>
    </li>
  );
}

export function Explorer({ tree, selectedPath, isLoading, error, onRetry, onOpenFile }: ExplorerProps) {
  const [collapsed, setCollapsed] = useState<ReadonlySet<string>>(new Set());

  function toggleDir(path: string) {
    setCollapsed((current) => {
      const next = new Set(current);
      if (next.has(path)) next.delete(path);
      else next.add(path);
      return next;
    });
  }

  return (
    <nav className="explorer" aria-label="Repository explorer">
      <h2 className="explorer__title">Explorer</h2>
      {error !== null ? (
        <div className="inline-error" role="alert">
          <p>{error.message}</p>
          <button type="button" onClick={onRetry}>
            Retry
          </button>
        </div>
      ) : isLoading ? (
        <p role="status" className="empty-state">
          Loading repository tree…
        </p>
      ) : tree.children.length === 0 ? (
        <p className="empty-state">No tracked files found.</p>
      ) : (
        <ul className="explorer__root">
          {tree.children.map((child) => (
            <TreeItem
              key={child.path}
              item={child}
              selectedPath={selectedPath}
              collapsed={collapsed}
              onToggleDir={toggleDir}
              onOpenFile={onOpenFile}
            />
          ))}
        </ul>
      )}
    </nav>
  );
}
```

実装上の注意:
- 折りたたみ状態はコンポーネント内部state(`Set<ディレクトリpath>`)で保持する。Appからのリセット要件は現時点でない(YAGNI)。
- `tree.children` のみを描画し、rootノード(name:"")自身は描画しない。

- [ ] **Step 4: Run tests to verify they pass**

Run: `bun run --cwd apps/review-ui test src/components/Explorer.test.tsx`
Expected: PASS(8件)

- [ ] **Step 5: Commit**

```bash
git add apps/review-ui/src/components/Explorer.tsx apps/review-ui/src/components/Explorer.test.tsx
git commit -m "feat: add Explorer collapsible tree with decision count badges"
```

### Task 10: Workspace + App配線 + styles.css + 旧コンポーネント削除

**Files:**
- Create: `apps/review-ui/src/components/Workspace.tsx`
- Test: `apps/review-ui/src/components/Workspace.test.tsx`
- Modify: `apps/review-ui/src/App.tsx`(取得オーケストレーション全面書き換え)
- Rewrite: `apps/review-ui/src/App.test.tsx`
- Modify: `apps/review-ui/src/styles.css`
- Delete: `apps/review-ui/src/components/DecisionList.tsx` / `DecisionList.test.tsx` / `DecisionDetail.tsx` / `DecisionDetail.test.tsx` / `SourceReference.tsx` / `SourceReference.test.tsx`

**Interfaces:**
- Consumes: `Explorer`(Task 9)、`DiffView`/`DiffViewProps`(Task 8)、`JudgmentPanel`/`JudgmentEntry`(Task 7)、`BootstrapScreen`(Task 5)、`buildFileTree`/`FileTreeNode`(Task 3)、`buildDecisionIndex`/`decisionAnchors`/`diffBaseFor`/`DecisionAnchor`/`BlockSelection`(Task 3)、`listRepositoryFiles`/`getFileDiff`/`FileDiff`(Task 4)。
- Produces:
  - 名前付きエクスポート `Workspace`。
  - `export interface WorkspaceProps { tree: FileTreeNode; selectedPath: string | null; explorerIsLoading: boolean; explorerError: Error | null; onExplorerRetry: () => void; onOpenFile: (path: string) => void; fileIsLoading: boolean; fileError: ReviewApiError | Error | null; diff: FileDiff | null; fullText: { content: string; anchors: DecisionAnchor[] } | null; onFileRetry: () => void; judgments: JudgmentEntry[]; anchors: DecisionAnchor[]; onDispositionChange: (recordId: string, disposition: UserDisposition) => Promise<DecisionRecordDetail>; onJudgmentRetry: (recordId: string) => void }`
  - **選択状態の所有**: ファイル選択(`selectedPath`)は取得オーケストレーションを伴うためAppが保持。ブロック選択と逆ナビゲーション(`navigateTo`)はペイン内完結のためWorkspace内部state(`selectedBlock` / `navigateTo={line, token}`)。`selectedPath` 変化時はブロック選択を解除する。
  - カードtargetクリック → 同一ファイルなら `navigateTo` を更新しDiffViewがスクロール+パルス(§6.2.4)。別ファイルの場合は無視(現行スコープでは発生しない)。

- [ ] **Step 1: Write the failing Workspace tests**

`apps/review-ui/src/components/Workspace.test.tsx`:

```tsx
import { describe, expect, it, vi, afterEach } from "vitest";
import { fireEvent, render, screen } from "@testing-library/react";
import { Workspace } from "./Workspace";
import type { FileTreeNode } from "../lib/file-tree";
import type { DecisionRecordDetail } from "../api";
import type { DiffLine, FileDiff } from "../../../../packages/contracts/src/index";

afterEach(() => {
  vi.restoreAllMocks();
});

function node(
  partial: Partial<FileTreeNode> & { name: string; path: string; isFile: boolean },
): FileTreeNode {
  return { decisionCount: 0, children: [], ...partial };
}

function treeFixture(): FileTreeNode {
  return node({
    name: "",
    path: "",
    isFile: false,
    children: [
      node({
        name: "src",
        path: "src",
        isFile: false,
        children: [
          node({ name: "api.ts", path: "src/api.ts", isFile: true, decisionCount: 1 }),
          node({ name: "util.ts", path: "src/util.ts", isFile: true }),
        ],
      }),
    ],
  });
}

function diffLine(partial: DiffLine): DiffLine {
  return partial;
}

function diffFixture(): FileDiff {
  return {
    path: "src/api.ts",
    base_sha: "abc123def4567890",
    old_missing: false,
    new_missing: false,
    binary: false,
    hunks: [
      {
        oldStart: 1,
        newStart: 1,
        lines: [
          diffLine({ type: "context", oldLine: 1, newLine: 1, content: "const before = 1;" }),
          diffLine({ type: "del", oldLine: 2, newLine: null, content: "const removed = 2;" }),
          diffLine({ type: "add", oldLine: null, newLine: 2, content: "const added = 3;" }),
        ],
      },
    ],
  };
}

export function detailFixture(recordId: string): DecisionRecordDetail {
  const target = {
    repository_id: "repo-1",
    path: "src/api.ts",
    line_start: 2,
    line_end: 3,
    revision: { kind: "commit" as const, sha: "abc123def4567890" },
    content_hash: "hash-a",
  };
  return {
    record: {
      record_id: recordId,
      session_id: `session-${recordId}`,
      repository_id: "repo-1",
      agent_type: "codex",
      revision: target.revision,
      targets: [target],
      judgment: `Guard ${recordId}`,
      rationale: "",
      checks: [],
      open_questions: [],
      created_at: "2026-08-20T10:00:00.000Z",
      user_disposition: "unreviewed",
    },
    sources: [
      {
        state: "resolved",
        repository_id: "repo-1",
        path: "src/api.ts",
        revision: target.revision,
        target,
        content: "const added = 3;",
        content_hash: "hash-a",
      },
    ],
  };
}

const baseProps = {
  tree: treeFixture(),
  selectedPath: "src/api.ts",
  explorerIsLoading: false,
  explorerError: null,
  onExplorerRetry: vi.fn(),
  onOpenFile: vi.fn(),
  fileIsLoading: false,
  fileError: null,
  diff: diffFixture(),
  fullText: null,
  onFileRetry: vi.fn(),
  judgments: [{ recordId: "rec-1", status: "ready" as const, detail: detailFixture("rec-1") }],
  anchors: [{ side: "new" as const, start: 2, end: 2 }],
  onDispositionChange: vi.fn(async () => detailFixture("rec-1")),
  onJudgmentRetry: vi.fn(),
};

describe("Workspace", () => {
  it("renders the three panes", () => {
    render(<Workspace {...baseProps} />);

    expect(screen.getByRole("navigation", { name: "Repository explorer" })).toBeTruthy();
    expect(screen.getByRole("region", { name: "Source diff" })).toBeTruthy();
    expect(screen.getByRole("region", { name: "Judgments" })).toBeTruthy();
  });

  it("forwards file clicks with their full path", () => {
    const onOpenFile = vi.fn();
    render(<Workspace {...baseProps} onOpenFile={onOpenFile} />);

    fireEvent.click(screen.getByText("util.ts"));
    expect(onOpenFile).toHaveBeenCalledWith("src/util.ts");
  });

  it("keeps block selection local and lets the panel clear it", () => {
    render(<Workspace {...baseProps} />);

    fireEvent.click(screen.getByText("const removed = 2;"));
    const delRow = document.querySelector<HTMLElement>('[data-old-line="2"]');
    expect(delRow?.className).toContain("diff-line--selected");
    expect(screen.getByRole("button", { name: "Clear block filter" })).toBeTruthy();

    fireEvent.click(screen.getByRole("button", { name: "Clear block filter" }));
    expect(delRow?.className).not.toContain("diff-line--selected");
  });

  it("scrolls to a judgment target line when its card link is clicked", () => {
    const scrollIntoView = vi.fn();
    Object.defineProperty(Element.prototype, "scrollIntoView", {
      value: scrollIntoView,
      configurable: true,
    });
    render(<Workspace {...baseProps} />);

    fireEvent.click(screen.getByRole("button", { name: "src/api.ts:2–3" }));
    expect(scrollIntoView).toHaveBeenCalledTimes(1);
    const row = document.querySelector<HTMLElement>('[data-new-line="2"]');
    expect(row?.className).toContain("diff-line--pulse");
  });

  it("routes retry intents to the matching pane handlers", () => {
    const onExplorerRetry = vi.fn();
    const onFileRetry = vi.fn();
    render(
      <Workspace
        {...baseProps}
        diff={null}
        error={null}
        explorerError={new Error("Recorder request failed")}
        onExplorerRetry={onExplorerRetry}
        onFileRetry={onFileRetry}
      />,
    );
  it("routes explorer retry to onExplorerRetry", () => {
    const onExplorerRetry = vi.fn();
    render(
      <Workspace {...baseProps} explorerError={new Error("Recorder request failed")} onExplorerRetry={onExplorerRetry} />,
    );

    fireEvent.click(screen.getByRole("navigation", { name: "Repository explorer" }).querySelector<HTMLButtonElement>(".inline-error button")!);
    expect(onExplorerRetry).toHaveBeenCalled();
  });

  it("routes diff retry to onFileRetry", () => {
    const onFileRetry = vi.fn();
    render(
      <Workspace
        {...baseProps}
        diff={null}
        fileError={new Error("The recorded revision could not be found.")}
        onFileRetry={onFileRetry}
      />,
    );

    fireEvent.click(screen.getByRole("region", { name: "Source diff" }).querySelector<HTMLButtonElement>(".inline-error button")!);
    expect(onFileRetry).toHaveBeenCalled();
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `bun run --cwd apps/review-ui test src/components/Workspace.test.tsx`
Expected: FAIL — `Failed to resolve import "./Workspace"`。

- [ ] **Step 3: Implement Workspace**

`apps/review-ui/src/components/Workspace.tsx`:

```tsx
import { useEffect, useRef, useState } from "react";
import type { FileDiff } from "../../../../packages/contracts/src/index";
import type { ReviewApiError, DecisionRecordDetail, UserDisposition } from "../api";
import type { DecisionAnchor, BlockSelection, FileTreeNode } from "../lib/file-tree";
import type { JudgmentEntry } from "./JudgmentPanel";
import { Explorer } from "./Explorer";
import { DiffView } from "./DiffView";
import { JudgmentPanel } from "./JudgmentPanel";

export interface WorkspaceProps {
  tree: FileTreeNode;
  selectedPath: string | null;
  explorerIsLoading: boolean;
  explorerError: Error | null;
  onExplorerRetry: () => void;
  onOpenFile: (path: string) => void;
  fileIsLoading: boolean;
  fileError: ReviewApiError | Error | null;
  diff: FileDiff | null;
  fullText: { content: string; anchors: DecisionAnchor[] } | null;
  onFileRetry: () => void;
  judgments: JudgmentEntry[];
  anchors: DecisionAnchor[];
  onDispositionChange: (recordId: string, disposition: UserDisposition) => Promise<DecisionRecordDetail>;
  onJudgmentRetry: (recordId: string) => void;
}

export function Workspace(props: WorkspaceProps) {
  const {
    tree,
    selectedPath,
    explorerIsLoading,
    explorerError,
    onExplorerRetry,
    onOpenFile,
    fileIsLoading,
    fileError,
    diff,
    fullText,
    onFileRetry,
    judgments,
    anchors,
    onDispositionChange,
    onJudgmentRetry,
  } = props;

  const [selectedBlock, setSelectedBlock] = useState<BlockSelection | null>(null);
  const [navigateTo, setNavigateTo] = useState<{ line: number; token: number } | null>(null);
  const navigationToken = useRef(0);

  useEffect(() => {
    setSelectedBlock(null);
  }, [selectedPath]);

  function handleTargetClick(path: string, line: number) {
    if (path !== selectedPath) return;
    navigationToken.current += 1;
    setNavigateTo({ line, token: navigationToken.current });
  }

  return (
    <div className="workspace">
      <Explorer
        tree={tree}
        selectedPath={selectedPath}
        isLoading={explorerIsLoading}
        error={explorerError}
        onRetry={onExplorerRetry}
        onOpenFile={onOpenFile}
      />
      <DiffView
        path={selectedPath}
        isLoading={fileIsLoading}
        error={fileError}
        diff={diff}
        anchors={anchors}
        selectedBlock={selectedBlock}
        onSelectBlock={setSelectedBlock}
        fullText={fullText}
        navigateTo={navigateTo}
        onRetry={onFileRetry}
      />
      <JudgmentPanel
        path={selectedPath}
        entries={judgments}
        selectedBlock={selectedBlock}
        onSelectBlock={setSelectedBlock}
        onDispositionChange={onDispositionChange}
        onRetry={onJudgmentRetry}
        onTargetClick={handleTargetClick}
      />
    </div>
  );
}
```

実装上の注意:
- `BlockSelection` は `lib/decision-index.ts` の再エクスポート元なので、`../lib/file-tree` からではなく正しいモジュールからimportすること。実際のimport文は次のとおり:

```tsx
import type { FileTreeNode } from "../lib/file-tree";
import type { BlockSelection, DecisionAnchor } from "../lib/decision-index";
```

(上のコード冒頭の1本化されたimport行はこれに置き換える。)

- DiffViewの `aria-label="Source diff"` と JudgmentPanelの `aria-label="Judgments"` は `<section>` へ付いているため `getByRole("region", …)` で取れる(Task 8/7 実装済み)。

- [ ] **Step 4: Run tests to verify they pass**

Run: `bun run --cwd apps/review-ui test src/components/Workspace.test.tsx`
Expected: PASS(6件)

- [ ] **Step 5: Rewrite App.tsx as the fetch orchestrator**

`apps/review-ui/src/App.tsx` を全体で次のように置き換える:

```tsx
import { useMemo, useState } from "react";
import {
  ReviewApi,
  ReviewApiError,
  type DecisionRecordDetail,
  type DecisionRecordSummary,
  type RegisteredRepositorySummary,
  type UserDisposition,
} from "./api";
import { BootstrapScreen } from "./components/BootstrapScreen";
import { Workspace } from "./components/Workspace";
import type { JudgmentEntry } from "./components/JudgmentPanel";
import type { DecisionAnchor, FileTreeNode } from "./lib/decision-index";
import { buildDecisionIndex, decisionAnchors, diffBaseFor } from "./lib/decision-index";
import { buildFileTree } from "./lib/file-tree";
import "./styles.css";

export interface AppProps {
  apiFactory?: (token: string) => ReviewApi;
}

function apiMessage(error: unknown): string {
  if (error instanceof ReviewApiError) {
    if (error.code === "UNAUTHORIZED" || error.status === 401) return "Owner token required or not accepted by Recorder.";
    return error.message;
  }
  return error instanceof Error ? error.message : "Recorder request failed";
}

function asError(error: unknown): Error {
  return error instanceof Error ? error : new Error(apiMessage(error));
}

export function App({ apiFactory = (token) => new ReviewApi(token) }: AppProps) {
  const [tokenInput, setTokenInput] = useState("");
  const [repositories, setRepositories] = useState<RegisteredRepositorySummary[] | null>(null);
  const [selectedRepositoryId, setSelectedRepositoryId] = useState("");
  const [api, setApi] = useState<ReviewApi | null>(null);
  const [repositoryId, setRepositoryId] = useState<string | null>(null);
  const [decisions, setDecisions] = useState<DecisionRecordSummary[]>([]);
  const [isLoading, setIsLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // Explorer state
  const [filePaths, setFilePaths] = useState<string[]>([]);
  const [explorerIsLoading, setExplorerIsLoading] = useState(false);
  const [explorerError, setExplorerError] = useState<Error | null>(null);

  // Open-file state
  const [selectedPath, setSelectedPath] = useState<string | null>(null);
  const [fileIsLoading, setFileIsLoading] = useState(false);
  const [fileError, setFileError] = useState<ReviewApiError | Error | null>(null);
  const [diff, setDiff] = useState<FileDiff | null>(null);
  const [fullText, setFullText] = useState<{ content: string; anchors: DecisionAnchor[] } | null>(null);
  const [recordStates, setRecordStates] = useState<Record<string, JudgmentEntry>>({});
  const [anchors, setAnchors] = useState<DecisionAnchor[]>([]);
  const [workspaceKey, setWorkspaceKey] = useState(0);

  const decisionIndex = useMemo(() => buildDecisionIndex(decisions), [decisions]);
  const tree = useMemo(() => {
    const counts = new Map<string, number>();
    for (const [path, list] of decisionIndex) counts.set(path, list.length);
    const known = new Set<string>(filePaths);
    for (const path of decisionIndex.keys()) known.add(path);
    return buildFileTree([...known].sort((a, b) => a.localeCompare(b)), counts);
  }, [filePaths, decisionIndex]);

  const judgments: JudgmentEntry[] = useMemo(() => {
    if (selectedPath === null) return [];
    return (decisionIndex.get(selectedPath) ?? []).flatMap((summary) => {
      const entry = recordStates[summary.record_id];
      return entry ? [entry] : [];
    });
  }, [selectedPath, decisionIndex, recordStates]);

  async function handleSubmit() {
    setError(null);
    const token = tokenInput.trim();
    if (token.length === 0) {
      setError("Owner bearer token is required.");
      return;
    }

    setIsLoading(true);
    try {
      if (repositories === null) {
        const client = apiFactory(token);
        const found = await client.listRepositories();
        setApi(client);
        setRepositories(found);
        if (found.length === 1) setSelectedRepositoryId(found[0].repository_id);
        return;
      }

      const repository = selectedRepositoryId.trim();
      if (repository.length === 0 || !repositories.some((candidate) => candidate.repository_id === repository)) {
        setError("Select a registered repository.");
        return;
      }

      const client = api ?? apiFactory(tokenInput.trim());
      const records = await client.listDecisions(repository);
      setApi(client);
      setRepositoryId(repository);
      setDecisions(records);
      await loadFiles(client, repository);
    } catch (requestError) {
      if (repositories === null) {
        setApi(null);
        setRepositories(null);
      }
      setError(apiMessage(requestError));
    } finally {
      setIsLoading(false);
    }
  }

  async function loadFiles(client: ReviewApi, repository: string) {
    setExplorerIsLoading(true);
    setExplorerError(null);
    try {
      const data = await client.listRepositoryFiles(repository);
      setFilePaths(data.paths);
    } catch (requestError) {
      setExplorerError(asError(requestError));
    } finally {
      setExplorerIsLoading(false);
    }
  }

  async function openFile(path: string) {
    if (api === null || repositoryId === null) return;
    setSelectedPath(path);
    setSelectedBlockReset();

    const related = decisionIndex.get(path) ?? [];
    const base = diffBaseFor(related);
    setFileIsLoading(true);
    setFileError(null);
    setDiff(null);
    setFullText(null);
    setAnchors([]);
    setRecordStates(Object.fromEntries(
      related.map((summary) => [summary.record_id, { recordId: summary.record_id, status: "loading" as const }]),
    ));

    const diffAttempt = api.getFileDiff(repositoryId, path, base).then(
      (value) => ({ ok: true as const, value }),
      (error: unknown) => ({ ok: false as const, error }),
    );
    const detailAttempts = related.map((summary) =>
      api.getDecision(summary.record_id).then(
        (value) => ({ id: summary.record_id, ok: true as const, value }),
        (error: unknown) => ({ id: summary.record_id, ok: false as const, error }),
      ),
    );
    const [diffResult, details] = await Promise.all([diffAttempt, Promise.all(detailAttempts)]);

    if (diffResult.ok) {
      setDiff(diffResult.value);
    } else {
      setFileError(diffResult.error instanceof ReviewApiError || diffResult.error instanceof Error
        ? diffResult.error
        : asError(diffResult.error));
    }

    const nextStates: Record<string, JudgmentEntry> = {};
    const nextAnchors: DecisionAnchor[] = [];
    for (const attempt of details) {
      if (attempt.ok) {
        nextStates[attempt.id] = { recordId: attempt.id, status: "ready", detail: attempt.value };
        nextAnchors.push(...decisionAnchors(attempt.value));
      } else {
        nextStates[attempt.id] = { recordId: attempt.id, status: "error", message: apiMessage(attempt.error) };
      }
    }
    setRecordStates(nextStates);
    setAnchors(nextAnchors);

    for (const attempt of details) {
      if (!attempt.ok) continue;
      const source = attempt.value.sources.find((candidate) => candidate.state === "resolved" || candidate.state === "snapshot-resolved");
      if (source !== undefined && "content" in source) {
        setFullText({ content: source.content, anchors: decisionAnchors(attempt.value) });
        break;
      }
    }

    setFileIsLoading(false);
  }

  function setSelectedBlockReset() {
    // ブロック選択はWorkspace内部state。ファイル切替時に解除してもらうためkeyでリセットする。
    setWorkspaceKey((current) => current + 1);
  }

  async function handleDisposition(recordId: string, disposition: UserDisposition): Promise<DecisionRecordDetail> {
    if (api === null) throw new ReviewApiError("Not connected to Recorder", { code: "UNKNOWN" });
    const updated = await api.setDisposition(recordId, disposition);
    setDecisions((current) => current.map((decision) => (
      decision.record_id === updated.record.record_id ? updated.record : decision
    )));
    setRecordStates((current) => ({
      ...current,
      [recordId]: { recordId, status: "ready", detail: updated },
    }));
    return updated;
  }

  async function retryJudgment(recordId: string) {
    if (api === null) return;
    setRecordStates((current) => ({ ...current, [recordId]: { recordId, status: "loading" } }));
    try {
      const detail = await api.getDecision(recordId);
      setRecordStates((current) => ({ ...current, [recordId]: { recordId, status: "ready", detail } }));
    } catch (requestError) {
      setRecordStates((current) => ({
        ...current,
        [recordId]: { recordId, status: "error", message: apiMessage(requestError) },
      }));
    }
  }

  function resetSession() {
    setApi(null);
    setRepositoryId(null);
    setRepositories(null);
    setSelectedRepositoryId("");
    setDecisions([]);
    setFilePaths([]);
    setExplorerError(null);
    setSelectedPath(null);
    setFileError(null);
    setDiff(null);
    setFullText(null);
    setRecordStates({});
    setAnchors([]);
    setTokenInput("");
    setError(null);
  }

  if (api === null || repositoryId === null) {
    return (
      <BootstrapScreen
        tokenInput={tokenInput}
        onTokenChange={setTokenInput}
        repositories={repositories}
        selectedRepositoryId={selectedRepositoryId}
        onRepositoryChange={setSelectedRepositoryId}
        isLoading={isLoading}
        error={error}
        onSubmit={() => void handleSubmit()}
      />
    );
  }

  const activeRepository = repositories?.find((candidate) => candidate.repository_id === repositoryId);

  return (
    <main className="app-shell">
      <header className="app-header">
        <div>
          <p className="eyebrow">Local review evidence</p>
          <h1>Decision review</h1>
          <p className="app-header__repo">Repository <code>{activeRepository?.root ?? repositoryId}</code></p>
        </div>
        <button type="button" className="button-secondary" onClick={resetSession}>Clear session</button>
      </header>
      {error !== null && <p className="inline-error" role="alert">{error}</p>}
      <Workspace key={workspaceKey} tree={tree} selectedPath={selectedPath} explorerIsLoading={explorerIsLoading} explorerError={explorerError} onExplorerRetry={() => api !== null && repositoryId !== null ? void loadFiles(api, repositoryId) : undefined} onOpenFile={(path) => void openFile(path)} fileIsLoading={fileIsLoading} fileError={fileError} diff={diff} fullText={fullText} onFileRetry={() => selectedPath !== null && void openFile(selectedPath)} judgments={judgments} anchors={anchors} onDispositionChange={(recordId, disposition) => handleDisposition(recordId, disposition)} onJudgmentRetry={(recordId) => void retryJudgment(recordId)} />
    </main>
  );
}
```

実装上の注意(App):
- `workspaceKey` state(`useState(0)`)を追加する。ファイル切替時のブロック選択リセットは `openFile()` 冒頭の `setSelectedBlockReset()`(= `setWorkspaceKey(c => c+1)`)でWorkspaceをremountして実現する。`setSelectedBlockReset` 内のコメントどおり、ブロックstate自体はWorkspace内部にある。
- `FileDiff` 型は `./api` からre-exportされているので `import type { …, FileDiff } from "./api";` を使うこと(上のコードのcontracts直import行は不要)。つまりApp冒頭の型importは:

```tsx
import {
  ReviewApi,
  ReviewApiError,
  type DecisionRecordDetail,
  type DecisionRecordSummary,
  type FileDiff,
  type RegisteredRepositorySummary,
  type UserDisposition,
} from "./api";
```

- `DecisionAnchor` は `lib/decision-index` から、`FileTreeNode` は `lib/file-tree` からそれぞれimportする(上の統合import行を2行に分ける)。
- `judgments` は `created_at` 降順(`buildDecisionIndex` が保証)のrelated順でmap lookupするため、並べ替えは不要。

- [ ] **Step 6: Rewrite App.test.tsx**

既存の `summary()`/detail フィクスチャと timeline 関連アサーションを削除し、次の内容で置き換える:

```tsx
import { describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { App } from "./App";
import { ReviewApi, type DecisionRecordDetail, type DecisionRecordSummary } from "./api";

const repository = { repository_id: "repo-1", root: "/work/repo-one", created_at: "2026-08-22T00:00:00.000Z" };

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });
}

function summaryFixture(): DecisionRecordSummary {
  return {
    record_id: "rec-1",
    session_id: "session-rec-1",
    repository_id: "repo-1",
    agent_type: "codex",
    revision: { kind: "commit", sha: "abc123" },
    targets: [
      {
        repository_id: "repo-1",
        path: "src/a.ts",
        line_start: 2,
        line_end: 2,
        revision: { kind: "commit", sha: "abc123" },
        content_hash: "hash-a",
      },
    ],
    judgment: "Guard the empty input",
    created_at: "2026-08-20T10:00:00.000Z",
    user_disposition: "unreviewed",
  };
}

function detailFixture(user_disposition: DecisionRecordDetail["record"]["user_disposition"] = "unreviewed"): DecisionRecordDetail {
  const target = summaryFixture().targets[0]!;
  return {
    record: {
      record_id: "rec-1",
      session_id: "session-rec-1",
      repository_id: "repo-1",
      agent_type: "codex",
      revision: { kind: "commit", sha: "abc123" },
      targets: [target],
      judgment: "Guard the empty input",
      rationale: "",
      checks: [],
      open_questions: [],
      created_at: "2026-08-20T10:00:00.000Z",
      user_disposition,
    },
    sources: [
      {
        state: "resolved",
        repository_id: "repo-1",
        path: "src/a.ts",
        revision: { kind: "commit", sha: "abc123" },
        target,
        content: "const value = input ?? {};",
        content_hash: "hash-a",
      },
    ],
  };
}

const fileDiff = {
  path: "src/a.ts",
  base_sha: "abc123def4567890",
  old_missing: false,
  new_missing: false,
  binary: false,
  hunks: [
    {
      oldStart: 1,
      newStart: 1,
      lines: [
        { type: "context", oldLine: 1, newLine: 1, content: "const head = 0;" },
        { type: "add", oldLine: null, newLine: 2, content: "const value = input ?? {};" },
      ],
    },
  ],
};

function createFetch() {
  return vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    if (url.endsWith("/v1/repositories")) return json({ success: true, data: [repository] });
    if (url.includes("/v1/decision-records?repository_id=")) return json({ success: true, data: [summaryFixture()] });
    if (url.endsWith("/v1/repositories/repo-1/files")) return json({ success: true, data: { repository_id: "repo-1", paths: ["src/a.ts", "src/b.ts"] } });
    if (url.startsWith("/v1/repositories/repo-1/diff?")) return json({ success: true, data: fileDiff });
    if (init?.method === "PATCH") return json({ success: true, data: detailFixture().record });
    if (url.endsWith("/v1/decision-records/rec-1")) return json({ success: true, data: detailFixture() });
    throw new Error(`unexpected request: ${url}`);
  });
}

async function openWorkspace(fetchImpl: ReturnType<typeof createFetch>) {
  render(<App apiFactory={(token) => new ReviewApi(token, { fetchImpl })} />);

  fireEvent.change(screen.getByLabelText("Owner bearer token"), { target: { value: "owner-token" } });
  fireEvent.submit(screen.getByRole("button", { name: "Load repositories" }).closest("form")!);

  const picker = await screen.findByLabelText("Repository");
  fireEvent.change(picker, { target: { value: "repo-1" } });
  fireEvent.submit(screen.getByRole("button", { name: "Open review timeline" }).closest("form")!);

  await screen.findByRole("navigation", { name: "Repository explorer" });
}

describe("App", () => {
  it("moves from bootstrap to the workspace with owner-token headers only in memory", async () => {
    const fetchImpl = createFetch();
    await openWorkspace(fetchImpl);

    expect(fetchImpl).toHaveBeenCalledWith("/v1/repositories", expect.objectContaining({
      headers: expect.objectContaining({ Authorization: "Bearer owner-token" }),
    }));
    expect(screen.getByText("/work/repo-one")).toBeTruthy();
  });

  it("fetches the diff and linked decisions together when a file is opened and anchors verified lines", async () => {
    const fetchImpl = createFetch();
    await openWorkspace(fetchImpl);

    fireEvent.click(screen.getByText("a.ts"));

    expect(await screen.findByRole("heading", { name: "Guard the empty input" })).toBeTruthy();
    expect(fetchImpl).toHaveBeenCalledWith(
      `/v1/repositories/repo-1/diff?${new URLSearchParams({ path: "src/a.ts", base: "abc123" })}`,
      expect.anything(),
    );
    expect(fetchImpl).toHaveBeenCalledWith("/v1/decision-records/rec-1", expect.objectContaining({
      headers: expect.objectContaining({ Authorization: "Bearer owner-token" }),
    }));
    await waitFor(() => {
      expect(document.querySelector<HTMLElement>('[data-new-line="2"]')?.className).toContain("diff-line--anchored");
    });
  });

  it("updates a disposition from the judgment card", async () => {
    const fetchImpl = createFetch();
    await openWorkspace(fetchImpl);

    fireEvent.click(screen.getByText("a.ts"));
    const accept = await screen.findByRole("button", { name: "Accept" });
    fireEvent.click(accept);
    await waitFor(() => expect(accept.getAttribute("aria-pressed")).toBe("true"));
    expect(fetchImpl).toHaveBeenCalledWith("/v1/decision-records/rec-1/disposition", expect.objectContaining({ method: "PATCH" }));
  });

  it("returns to bootstrap when clearing the session", async () => {
    const fetchImpl = createFetch();
    await openWorkspace(fetchImpl);

    fireEvent.click(screen.getByRole("button", { name: "Clear session" }));
    expect(screen.getByLabelText("Owner bearer token")).toBeTruthy();
  });
});
```

(注: `createFetch` はPATCH後に返すGET詳細を常に `unreviewed` のまま返しているため、楽順更新はコンポーネント側stateで `aria-pressed` がtrueになる — DecisionCardの楽順パターンの通り。サーバー応答が古くてもUIが先行的に更新されることをこのテストが固定する。)

- [ ] **Step 7: Update styles.css**

`apps/review-ui/src/styles.css`:
1. `.app-layout` のグリッド定義とそれに続く850px/600pxメディアクエリ内の `.app-layout` 規則を削除する。
2. 次のブロックを追記する(既存ダークテーマのカスタムプロパティがあれば同名トークンへ読み替えてよいが、無ければこの値をそのまま使う):

```css
/* ---- Two-pane workspace (spec §6) ---- */
.workspace {
  display: grid;
  grid-template-columns: clamp(220px, 18vw, 300px) minmax(0, 1fr) clamp(340px, 26vw, 420px);
  gap: 16px;
  flex: 1;
  min-height: 0;
}

@media (max-width: 850px) {
  .workspace {
    grid-template-columns: 1fr;
  }
}

.explorer {
  overflow: auto;
  min-height: 0;
  border-right: 1px solid rgba(255, 255, 255, 0.08);
  padding-right: 4px;
}
.explorer__title {
  font-size: 0.8rem;
  text-transform: uppercase;
  letter-spacing: 0.08em;
  opacity: 0.7;
}
.explorer__root,
.explorer__group {
  list-style: none;
  margin: 0;
  padding-left: 0;
}
.explorer__group {
  padding-left: 14px;
}
.explorer__dir,
.explorer__file {
  display: flex;
  align-items: center;
  gap: 6px;
  width: 100%;
  border: 0;
  background: transparent;
  color: inherit;
  font: inherit;
  text-align: left;
  padding: 4px 6px;
  cursor: pointer;
  border-radius: 6px;
}
.explorer__dir:hover,
.explorer__file:hover {
  background: rgba(255, 255, 255, 0.06);
}
.explorer__file[aria-current="true"] {
  background: rgba(88, 166, 255, 0.18);
}
.explorer__name {
  flex: 1;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.explorer__badge {
  font-size: 0.72rem;
  background: rgba(88, 166, 255, 0.25);
  border-radius: 999px;
  padding: 0 6px;
}

.diff-view {
  overflow: auto;
  min-height: 0;
}
.diff-view__header {
  display: flex;
  align-items: baseline;
  gap: 12px;
}
.diff-view__header h2 {
  margin: 0;
  font-size: 0.95rem;
  word-break: break-all;
}
.diff-view__base {
  opacity: 0.6;
  font-size: 0.78rem;
}
.diff-lines {
  list-style: none;
  margin: 8px 0;
  padding: 0;
  font-family: ui-monospace, SFMono-Regular, Menlo, monospace;
  font-size: 0.82rem;
}
.diff-line__body {
  display: flex;
  width: 100%;
  gap: 8px;
  border: 0;
  background: transparent;
  color: inherit;
  font: inherit;
  text-align: left;
  padding: 1px 6px;
  cursor: pointer;
}
.diff-line__static {
  display: flex;
  gap: 8px;
  padding: 1px 6px;
}
.line-number {
  min-width: 3ch;
  text-align: right;
  opacity: 0.5;
}
.line-sign {
  min-width: 1ch;
}
.diff-line--add .line-sign,
.diff-line--add {
  color: #7ee787;
}
.diff-line--del .line-sign,
.diff-line--del {
  color: #ffa198;
}
.diff-line--anchored {
  background: rgba(210, 153, 34, 0.16);
  box-shadow: inset 3px 0 0 #d29922;
}
.diff-line--selected {
  outline: 1px solid rgba(88, 166, 255, 0.7);
  background: rgba(88, 166, 255, 0.12);
}
.diff-line--pulse {
  animation: diff-pulse 1.2s ease-out;
}
@keyframes diff-pulse {
  0% { background: rgba(88, 166, 255, 0.45); }
  100% { background: transparent; }
}

.judgment-panel {
  overflow: auto;
  min-height: 0;
  border-left: 1px solid rgba(255, 255, 255, 0.08);
  padding-left: 12px;
}
.section-heading {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 8px;
}
.section-heading h2 {
  margin: 0;
  font-size: 0.95rem;
}
.judgment-stack {
  display: flex;
  flex-direction: column;
  gap: 12px;
  margin-top: 8px;
}
```

- [ ] **Step 8: Delete obsolete components**

```bash
git rm apps/review-ui/src/components/DecisionList.tsx apps/review-ui/src/components/DecisionList.test.tsx \
       apps/review-ui/src/components/DecisionDetail.tsx apps/review-ui/src/components/DecisionDetail.test.tsx \
       apps/review-ui/src/components/SourceReference.tsx apps/review-ui/src/components/SourceReference.test.tsx
```

- [ ] **Step 9: Run the whole suite to verify green**

Run: `bun run --cwd apps/review-ui test`
Expected: PASS — 削除対象テストが消え、新構成の全テストが通る。`grep -rn "DecisionList\|DecisionDetail\|SourceReference" apps/review-ui/src` がヒットゼロであることも確認する。

- [ ] **Step 10: Commit**

```bash
git add apps/review-ui/src/components/Workspace.tsx apps/review-ui/src/components/Workspace.test.tsx \
        apps/review-ui/src/App.tsx apps/review-ui/src/App.test.tsx apps/review-ui/src/styles.css
git commit -m "feat: wire two-pane workspace orchestration into the review UI"
```

### Task 11: E2E書き換え + カバレッジ + 全グリーン

**Files:**
- Rewrite: `tests/e2e/review-flow.spec.ts`(先頭のjourneyテストを差し替え、末尾2件のadapterテストは触らない)
- Modify: `apps/review-ui/package.json`(devDependencies に `@vitest/coverage-v8`)
- Modify: `apps/review-ui/vite.config.ts`(coverage 設定)

**Interfaces:**
- Consumes: Task 5〜10で実装済みのUI(セレクタ: label `Owner bearer token` / select `Repository` / button `Open review timeline`、Explorerの `/review\.ts/` ボタン、`.diff-line--anchored`、`Clear block filter`、DecisionCardの警告コピー)と、既存E2Eハーネス(`startRecorder` / `createGitRepository` / `runAdapter` / `apiRequest` — 全て現行ファイル内で不変)。
- Produces:
  - 新ナビゲーション(two-pane)を通る journey E2E 1件 + ブロック絞り込み E2E 1件。
  - `bun run --cwd apps/review-ui test --coverage` が `src/lib/**` 80%しきい値で通る。
  - 全スイート(`bun test` / vitest / playwright 2 spec)グリーン。

- [ ] **Step 1: Enable coverage thresholds**

`apps/review-ui/package.json` の `devDependencies` に、**既存の `vitest` エントリと同じバージョン文字列**で追加する(バージョン値は `package.json` の `vitest` 行からそのままコピーする):

```jsonc
"@vitest/coverage-v8": "<vitestと同一のバージョン文字列>"
```

追加後 `bun install` を実行する。

`apps/review-ui/vite.config.ts` の `test` オブジェクトに `coverage` を追加する:

```ts
    coverage: {
      provider: "v8",
      include: ["src/lib/**"],
      thresholds: { statements: 80, branches: 80, functions: 80, lines: 80 },
    },
```

- [ ] **Step 2: Rewrite the journey test for the two-pane navigation**

`tests/e2e/review-flow.spec.ts` の最初の `test("registers a repository, …", …)` を丸ごと次へ置き換える(ヘルパー・`beforeAll`・`afterAll`・末尾2テストは変更しない):

```ts
test("reviews a decision through the explorer, accepts it, and flags a tampered source", async ({ page }) => {
  const session = await createSession(journey, "codex");
  const event = eventFor(journey, session.session_id, "codex", `journey-${randomUUID()}`);
  const submission = await runAdapter("codex", event);
  expect(submission.exitCode).toBe(0);
  expect(submission.result).toMatchObject({ success: true, recordId: event.recordId });

  await page.goto(app.url);
  await expect(page).toHaveTitle("Review decisions");
  await page.getByLabel("Owner bearer token").fill(token);
  await page.getByLabel("Repository").selectOption(journey.repositoryId);
  await page.getByRole("button", { name: "Open review timeline" }).click();
  await expect(page.getByRole("heading", { name: "Decision review" })).toBeVisible();

  await page.getByRole("button", { name: /review\.ts/ }).click();
  await expect(page.getByRole("heading", { name: event.judgment })).toBeVisible();
  // 作業ツリー未変更 → hunks空 + 検証済みsource → 全文モード(§6.2.6)で記録済みソースを表示
  await expect(page.getByText("export const reviewed = true;", { exact: true })).toBeVisible();

  const accept = page.getByRole("button", { name: "Accept", exact: true });
  await accept.click();
  await expect(accept).toHaveAttribute("aria-pressed", "true");
  const acceptedResponse = await apiRequest(`/v1/decision-records/${event.recordId}`);
  expect(acceptedResponse.status).toBe(200);
  const acceptedBody = await acceptedResponse.json() as { data: { record: DecisionRecord } };
  expect(acceptedBody.data.record.user_disposition).toBe("accepted");

  // 改ざん: 作業ツリーだけ書き換える
  const currentSource = "export const reviewed = false;";
  await writeFile(join(journey.root, journey.path), `${currentSource}\n`, "utf8");
  await page.reload();
  const staleResponse = await apiRequest(`/v1/decision-records/${event.recordId}`);
  expect(staleResponse.status).toBe(200);
  const staleBody = await staleResponse.json() as { data: { sources: Array<Record<string, unknown>> } };
  expect(staleBody.data.sources[0]).toMatchObject({ state: "hash-mismatch" });

  // トークンはメモリ保持なので再認証になる(localStorage/URL不変チェックは現行どおり)
  await expect(page.getByLabel("Owner bearer token")).toBeVisible();
  await expect(page).not.toHaveURL(new RegExp(token));
  await expect(page.evaluate(() => localStorage.length)).resolves.toBe(0);

  await page.getByLabel("Owner bearer token").fill(token);
  await page.getByLabel("Repository").selectOption(journey.repositoryId);
  await page.getByRole("button", { name: "Open review timeline" }).click();
  await page.getByRole("button", { name: /review\.ts/ }).click();

  await expect(page.getByRole("heading", { name: event.judgment })).toBeVisible();
  await expect(page.getByText("Source changed since the decision")).toBeVisible();
  await expect(page.getByText("Current code is intentionally not shown until this reference is resolved.")).toBeVisible();
  // カード上に改ざん後コードは出ない(§7)。diffペインはHEADとの差分として現状を表示するが、
  // hash不一致のアンカーは検証済み扱いしないためティントは付かない(§5/§8)
  await expect(page.locator(".judgment-panel").getByText(currentSource)).toHaveCount(0);
  await expect(page.locator(".diff-line--anchored")).toHaveCount(0);
});
```

- [ ] **Step 3: Add a block-selection E2E**

同じファイルの journey テストの直後に追加する:

```ts
test("narrows judgments to the selected diff block and restores them on clear", async ({ page }) => {
  const session = await createSession(adapters, "claude-code");
  const recordId = `block-${randomUUID()}`;
  const event = eventFor(adapters, session.session_id, "claude-code", recordId);
  event.revision = { kind: "commit", sha: adapters.commitSha };
  event.targets[0]!.revision = { kind: "commit", sha: adapters.commitSha };
  event.targets[0]!.contentHash = adapters.contentHash;
  const submission = await runAdapter("claude-code", event);
  expect(submission.exitCode).toBe(0);

  // 1行目を書き換えて1行追加し、実diffを作る
  await writeFile(join(adapters.root, adapters.path), "export const adapter = false;\nexport const extra = 1;\n", "utf8");

  await page.goto(app.url);
  await page.getByLabel("Owner bearer token").fill(token);
  await page.getByLabel("Repository").selectOption(adapters.repositoryId);
  await page.getByRole("button", { name: "Open review timeline" }).click();
  await page.getByRole("button", { name: /adapter\.ts/ }).click();

  // commit revision の判断は旧側1..1に常時アンカー(§5)
  await expect(page.getByRole("heading", { name: event.judgment })).toBeVisible();
  await expect(page.locator('[data-old-line="1"]')).toHaveClass(/diff-line--anchored/);

  // 純addブロック(new側のみ)をクリック → 旧側アンカーは辺ごと厳密判定で合致しない(§6.2.3)
  await page.locator(".diff-line--add").last().click();
  await expect(page.getByText("No judgments overlap the selected lines.")).toBeVisible();

  await page.getByRole("button", { name: "Clear block filter" }).click();
  await expect(page.getByRole("heading", { name: event.judgment })).toBeVisible();
});
```

- [ ] **Step 4: Build the UI and run the flow spec**

Run: `bun run --cwd apps/review-ui build`
Expected: ビルド成功(`apps/review-ui/dist` 更新。recorderは `--ui-root` でここを配信する)。

Run: `bunx playwright test tests/e2e/review-flow.spec.ts`
Expected: PASS(3件 — journey + block filter + 既存2件のうち末尾の2件)。

- [ ] **Step 5: Run every suite green**

Run: `bun test`
Expected: PASS(recorder/contracts/plugins の全バックエンドテスト。Task 1〜2で追加した分を含む)。

Run: `bun run --cwd apps/review-ui test --coverage`
Expected: PASS かつ `src/lib/**` のカバレッジが全指標80%以上(しきい値未達はテスト失敗になる)。

Run: `bunx playwright test`
Expected: PASS(`review-flow.spec.ts` + `security-boundaries.spec.ts` の全件)。

- [ ] **Step 6: Commit**

```bash
git add tests/e2e/review-flow.spec.ts apps/review-ui/package.json apps/review-ui/vite.config.ts bun.lock
git commit -m "test: rewrite review-flow E2E for the two-pane UI and enforce lib coverage"
```

(リポジトリのlockfileは `bun.lock` を確認済み。将来 `bun.lockb` に変わった場合は読み替える。)

---

## 実装順序の対応(仕様§10 ↔ タスク)

| §10 | タスク |
|---|---|
| 1. contracts型 | Task 1 |
| 2. GitReader | Task 1 |
| 3. routes | Task 2 |
| 4. UI lib純関数 | Task 3 |
| 5. api.ts | Task 4 |
| 6. コンポーネント下位から | Task 5(BootstrapScreen)→ 6(DecisionCard)→ 7(JudgmentPanel)→ 8(DiffView)→ 9(Explorer) |
| 7. App配線・styles | Task 10 |
| 8. E2E・全グリーン・カバレッジ | Task 11 |

※仕様§10の6では BootstrapScreen は最後の抽出だが、既存Appのbootstrap分岐を先に部品化しておく方がTask 10のApp全面書き換えの差分が小さくなるため、本計画ではTask 5に前倒しした(挙動不変の純粋リファクタ)。
