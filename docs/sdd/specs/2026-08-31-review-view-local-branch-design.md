# Review UI ローカルブランチの review view

- 日付: 2026-08-31
- 状態: 設計承認待ち
- 分類: architectural
- 用語: [CONTEXT.md](../../../CONTEXT.md)
- 上位仕様: [Review UI 2ペイン](../../superpowers/specs/2026-08-22-review-ui-two-pane-design.md)、[AI Code Review Evidence](../../superpowers/specs/2026-08-20-ai-code-review-evidence-design.md)

登録リポジトリにローカルブランチが2本以上あるとき、Review UI からブランチ tip を読み取り専用で閲覧できるようにする。checkout しない。判断記録の形は変えない。

2ペイン仕様の「現在の作業ツリー」を、この仕様では **review view**（作業ツリー、または選んだローカルブランチ tip）に置き換える。review view が作業ツリーのときは 2ペイン仕様どおり。

## 1. 目的

レビュー中に、同じ登録ルートの別ローカルブランチ tip のファイルツリーと内容を見られるようにする。初期表示と未コミット確認は今と同じ作業ツリーのままにする。

## 2. Goals

- ローカルブランチが2本以上ある登録リポジトリで、ローカルブランチ tip を読み取り専用で見られる。
- 初期 review view は作業ツリー。切替はワークスペースヘッダー。
- 2ペインの比較形を保つ。旧側は diff base、新側は diff current。
- checkout しない。判断記録、プラグイン、edit gate は変えない。

## 3. Non-goals

- remote-tracking / tag / 任意 SHA を review view にする。
- 実ブランチの checkout・作成・削除。
- 判断をブランチで絞り込む。記録にブランチ名を足す。
- review view を URL / cookie / localStorage / sessionStorage に残す。
- ブートストラップ画面でのブランチ選択。
- Git 履歴の自動取得、log、blame。
- スナップショット遷移の意味変更。
- ブランチごとの別 `repository_id`。
- 新しい `ERROR_CODES`。

## 4. 採用したアプローチ

| 案 | 概要 | 判定 |
|---|---|---|
| **1（採用）** | 既存の `files` / `diff` に省略可能な `branch` を足し、ローカルブランチ一覧の GET を1本追加する | checkout せず tip を読める。記録形式を変えない |
| 2 | ブランチごとに登録ルートや worktree を増やす | 実 checkout か `repository_id` の意味変更が要る。不採用 |
| 3 | UI にブランチ名だけ出し、`files` / `diff` の新側は常に作業ツリー | tip 閲覧を満たさない。不採用 |

ADR は書かない。API 追加は後方互換のフィールド追加であり、3条件（覆しにくい・文脈なしでは意外・トレードオフの結果）を同時に満たさない。既定値と禁止事項はこの仕様に置く。

## 5. 用語との対応

- **Review view**: 作業ツリー（既定）またはローカルブランチ tip。checkout しない。
- **Local branch**: `refs/heads` の名前付きブランチ。短い名前で識別する。
- **Diff base**: そのファイルの最新 commit-revision 判断。無ければ review view の tip commit。
- **Diff current**: review view のそのパスの内容。

## 6. アーキテクチャ

Recorder は登録ルートを読んだままにする。ユーザー入力のブランチ名を、そのリクエスト時点の `refs/heads` 一覧と完全一致させてから使う。一致しない文字列を `rev-parse` しない。クライアントから tip SHA を受け取って view にしない。各 `files` / `diff` はその時点の tip を読む。

```
Review UI
  → GET /v1/repositories/:id/branches
  → GET /v1/repositories/:id/files[?branch=<short-name>]
  → GET /v1/repositories/:id/diff?path=&base=&[branch=<short-name>]
GitReader（既存の読み取り専用 git 実行）
  → for-each-ref refs/heads / ls-tree / show blob
  → 作業ツリー時のみ ls-files と作業ツリー読み
```

`branch` クエリを省略した `files` / `diff` は、今の作業ツリー挙動のままにする。`working-tree` という予約ブランチ名は使わない。

判断カード、source 解決、snapshot-diff は今のエンドポイントのままにする。

## 7. API

認証、Origin、登録ルート検証は既存 `/v1` と同じ。新しい error code は足さない。

### 7.1 `GET /v1/repositories/:id/branches`

```jsonc
{
  "repository_id": "…",
  "head_branch": "main", // いま checkout されているローカルブランチの短い名前。detached または未誕生、あるいはその名前が一覧に無いときは null
  "branches": [
    { "name": "feat/x", "sha": "0123456789abcdef0123456789abcdef01234567" },
    { "name": "main", "sha": "89abcdef0123456789abcdef0123456789abcdef" }
  ]
}
```

- 対象は `refs/heads` のみ。remote-tracking と tag は含めない。
- `name` は `refname:short`（`refs/heads/` を付けない）。
- `sha` は 40 桁 hex の tip commit。
- `branches` は短い名前の辞書順（既存 `files` の `paths.sort()` と同じ文字列順）。
- 短い名前が既存の安全な revision 文字規則（長さ 1–128、先頭 `-` 禁止、`..` / `@{` / NUL 禁止、`[A-Za-z0-9._/-]+`）を満たさないブランチは一覧から省略する。一件の省略でエンドポイント全体を失敗させない。
- `head_branch` は、HEAD が指すローカルブランチの短い名前が一覧に含まれるときだけその名前。それ以外は `null`。

エラー: `401 UNAUTHORIZED` / `404 REPOSITORY_NOT_REGISTERED` / `422 SOURCE_UNAVAILABLE` / `413 PAYLOAD_TOO_LARGE`。

未誕生リポジトリは `branches: []` かつ `head_branch: null` で 200。

### 7.2 `GET /v1/repositories/:id/files`

既存の `repository_id` と `paths` に `view` を足す。

```jsonc
{
  "repository_id": "…",
  "view": { "kind": "working-tree" },
  "paths": ["src/api.ts"]
}
```

または

```jsonc
{
  "repository_id": "…",
  "view": { "kind": "local-branch", "name": "feat/x", "sha": "0123456789abcdef0123456789abcdef01234567" },
  "paths": ["src/api.ts"]
}
```

| `branch` クエリ | パスの出どころ | `view` |
|---|---|---|
| 省略 | 今どおり `ls-files`（作業ツリー） | `{ kind: "working-tree" }` |
| 一覧にある短い名前 | その tip の `ls-tree` | `{ kind: "local-branch", name, sha }` |
| 空または空白のみ | — | `422 INVALID_RECORD`（field: `branch`） |
| それ以外 | — | `404 REVISION_NOT_FOUND` |

`paths` はルート相対・POSIX 区切り・辞書順。既存のパス検証（ルート外・nested repository）を維持する。

その他のエラーは今の `files` と同じ: `401` / `404 REPOSITORY_NOT_REGISTERED` / `422 SOURCE_UNAVAILABLE` / `413 PAYLOAD_TOO_LARGE`。

### 7.3 `GET /v1/repositories/:id/diff?path=&base=&branch=`

構造化 `FileDiff` を返す。フィールド名は今と同じ。`new_missing` の意味だけ次に固定する: **diff current にそのパスが無い**。

| 条件 | 旧側（diff base） | 新側（diff current） |
|---|---|---|
| `branch` 省略 | `base` 省略時または `HEAD` → 作業ツリーの HEAD。それ以外は今どおりその revision | 作業ツリーのファイル |
| `branch` が一覧にある | `base` 省略時または `HEAD` → そのローカルブランチ tip。それ以外は今どおりその revision | その tip の blob |

`path` 検証は今どおり `normalizeSourcePath` と `registry.assertTarget`。

`branch` の空文字・未知名・危険文字列の扱いは `files` と同じ（空は 422、それ以外の不正は 404）。

`base` が解決できないときは今どおり `404 REVISION_NOT_FOUND`。未誕生で `branch` 省略かつ `base=HEAD` のときは、UI が今どおり「比較対象なし」として扱う。

その他のエラーは今の `diff` と同じ: `401` / `404 REPOSITORY_NOT_REGISTERED` / `422 PATH_OUTSIDE_ROOT` / `422 SOURCE_UNAVAILABLE` / `413 PAYLOAD_TOO_LARGE`。

## 8. データフローと順序

1. トークン入力とリポジトリ選択は今のまま。
2. ワークスペース開始時、次を並行取得する: 判断一覧、`files`（`branch` なし）、`branches`。
3. `files` が返った時点で Explorer を出す。`branches` を待ってワークスペース表示を遅らせない。
4. `branches.length >= 2` のときだけヘッダーに選択 UI を出す。0 または 1 のときは出さない。初期選択は作業ツリー。
5. 選択 UI の先頭は作業ツリー。続けて `branches` の順（辞書順）でローカルブランチ。`name === head_branch` の項目に、checkout されていることだけが分かる印を付ける。ラベルに `HEAD` や "current branch" は使わない。
6. ユーザーがローカルブランチを選んだら、同じ `branch` で `files` と、開いているファイルがあれば `diff` を取り直す。
7. Explorer のパス集合は、その応答の `paths` ∪ 判断索引のパス（2ペイン仕様と同じ和集合）。
8. 開いていたパスが新しい集合に無ければ選択を外す。あればそのパスの diff を新しい review view で出す。
9. review view は React のメモリだけ。リロードと Clear session で作業ツリーに戻す。

判断カードはパス単位の全件のまま。ブランチ名でも Git 祖先でも絞らない。

## 9. 行アンカー

| 判断の revision | review view | アンカー |
|---|---|---|
| commit | 作業ツリーまたはローカルブランチ | 今どおり diff の旧側 |
| working-tree かつ source が `resolved` / `snapshot-resolved` | 作業ツリー | 今どおり diff の新側 |
| working-tree | ローカルブランチ | アンカーしない。カードは出す |
| working-tree かつ source 失敗 | どちらでも | 今どおりアンカーしない |

スナップショット遷移は今のまま。ブランチ view 中でも撮影同士、または撮影 vs 作業ツリーを中央に出してよい。ヘッダーの review view は変えない。

## 10. コンポーネント

**GitReader**  
既存の読み取り専用 `execute` だけを使う。追加責務は次に限る。

- ローカルブランチ一覧（`for-each-ref refs/heads` と HEAD が指すローカルブランチ）
- コミット tree のパス一覧（既存 private `listTreePaths` を公開する）
- `readPathDiff` の新側を作業ツリーまたは指定 commit blob にする

view 用に、一覧に無い文字列を `rev-parse` しない。view 用にクライアント提出の SHA を使わない。

**HTTP**  
`GET /v1/repositories/:id/branches` を追加する。既存 `files` / `diff` に省略可能な `branch` を追加する。プラグインが使う POST / PATCH / source / snapshot-diff は変えない。

**contracts**  
ブランチ一覧型と `files` の `view` を追加する。`FileDiff` のフィールドは維持し、`new_missing` の説明だけ diff current に合わせる。判断記録型は触らない。

**Review UI**  
`ReviewApi` に `listBranches` と、`listRepositoryFiles` / `getFileDiff` への `branch` を追加する。`App` が review view をタブ内 state で持つ。ヘッダーの選択は `branches.length >= 2` のときだけ。`BootstrapScreen`、Explorer のツリー描画、JudgmentPanel、スナップショット遷移の API は今のまま。

**触らないもの**  
RecordStore、RepositoryRegistry、判断の source 解決、git-backed snapshot、全プラグイン、edit gate。

## 11. エラー処理

| 状況 | 挙動 |
|---|---|
| `branch` 省略 | 作業ツリー。既存の files/diff |
| `branch` が空または空白のみ | `422 INVALID_RECORD`（field: `branch`） |
| `branch` が一覧に無い（削除済み、remote 名、tag、危険文字列を含む） | `404 REVISION_NOT_FOUND` |
| 選択中のブランチが再取得や files/diff で `REVISION_NOT_FOUND` | UI は作業ツリーへ戻し、インラインエラーを出す。消えた tip に居残らない |
| 未誕生 | `branches: []`。選択 UI なし。`base=HEAD` の diff は今どおり比較対象なし |
| detached HEAD | `head_branch: null`。一覧は出す。選択 UI は2本以上なら出す |
| for-each-ref / ls-tree がサイズ上限超え | `413 PAYLOAD_TOO_LARGE` |
| Git が読めない | `422 SOURCE_UNAVAILABLE` |
| diff の `path` がルート外 | `422 PATH_OUTSIDE_ROOT` |

checkout 失敗は起きない（checkout しない）。

## 12. テスト

既存 runner 配置に従う（Recorder は bun test、Review UI は vitest、E2E は Playwright）。`branch` を付けない既存 files/diff/source/snapshot テストは回帰させる。

- **GitReader**: ローカルブランチのみ（`feat/x` を含む）、remote と tag を含めない、安全規則外の名前は省略、detached で `head_branch` 相当が無い、未誕生は空、サイズ上限、ブランチ tip を新側にした diff（追加・削除・同一・binary・片側 missing）。`branch` 省略の `readPathDiff` は今と同じ作業ツリー新側。
- **HTTP**: `branches` の 401 と未登録 404。`files` / `diff` は `branch` 省略で今と同じ。一致するローカル名は 200 で `view.kind === "local-branch"`。不一致は 404。空文字は 422。`base` 省略 + `branch` ありの旧側はその tip。
- **contracts**: 一覧と `files.view` の型。
- **Review UI**: 0本と1本で選択 UI なし、2本以上でヘッダーに出る、初期は作業ツリー、切替で files と開いている diff を取り直す、パスが新しい集合に無ければ選択解除、`REVISION_NOT_FOUND` で作業ツリーへ戻す、ブランチ view では作業ツリー判断を新側にアンカーしない。
- **E2E**: ローカルブランチが2本ある fixture でヘッダーから切替し、Explorer がその tip の tree になる。作業ツリーにだけある未コミットファイルはブランチ view の tree に出ない。

## 13. 消費経路

- Review UI ワークスペースヘッダー → `GET .../branches` と `files` / `diff` の `branch`。
- Recorder の GitReader と HTTP。contracts の型を Recorder と Review UI が共有する。
- E2E のレビューフロー。

プラグイン、判断 POST、source 解決、snapshot-diff のクエリは消費しない。

## 14. 既定値・禁止・順序保証

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

## 15. セキュリティ

- Git 実行は既存の hooksPath / fsmonitor / 環境変数制限のまま。
- 履歴全体の walk や fetch を追加しない。
- `branch` 値は、そのリクエスト時点の `refs/heads` 一覧との完全一致後にだけ使う。クライアント提出の SHA を view にしない。
- トークンは今どおりメモリのみ。ブランチ名もストレージに書かない。
- `--ui-root` と data dir の非重複、登録ルート外拒否は維持する。
