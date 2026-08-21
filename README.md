# AI Code Review Evidence

AIコーディングエージェントが行った判断を、実ファイル・Git revision・diff・確認結果と結びつけてレビューするローカルファーストのツールです。

## できること

- Claude Code／Codexの判断記録を共通形式へ変換
- 判断をファイル、行範囲、コミット、content hashへ関連付け
- AIの判断、根拠、確認結果、未確認事項をタイムラインで表示
- `accepted`／`rejected`／`unreviewed` の人間側レビュー状態を保存
- ファイル変更後のhash不一致を検出し、現在のコードへ黙って付け替えない
- 実ファイルとGitをローカルで読み取り、コード本文や会話全文を標準では外部送信しない
- symlink、親symlink、nested Git、Git hooks、fsmonitor、filter、任意コマンドに対する読み取り境界を検証

このツールはコードの脆弱性を自動判定するセキュリティスキャナではありません。AIの判断を証拠付きで確認するための記録・レビュー基盤です。

## 前提

- Bunがインストールされていること
- Gitリポジトリを読み取り可能であること
- Recorderとプラグインは同じユーザー環境で動作すること
- 初期構成はローカル利用です。クラウド保存やチーム共有は含みません

## セットアップ

```bash
bun install
```

UIをビルドします。

```bash
bun run --cwd apps/review-ui build
```

## テストとビルド

プロジェクトの全テストは次で実行します。

```bash
bun run test
```

このコマンドは、次を専用runnerで実行します。

- Bunテスト: contracts、Recorder、プラグイン
- Vitest + jsdom: Review UI

`bun test`を単独で実行すると、Bunのraw test collectorがPlaywright specとDOM依存のReactテストまで収集します。通常は必ず`bun run test`を使用してください。

E2Eテスト:

```bash
bun run e2e
```

contractsのビルド:

```bash
bun run build
```

## Recorderの起動

まずReview UIをビルドし、Recorderへ静的UIのルートを渡します。

```bash
bun run --cwd apps/review-ui build
bun run recorder \
  --data-dir ./.ai-review \
  --port 4318 \
  --ui-root "$PWD/apps/review-ui/dist"
```

起動すると、次の情報が表示されます。

- RecorderのURL
- owner bearer tokenの保存先

標準のデータディレクトリは`~/.ai-code-review-evidence`ですが、開発時はプロジェクト内の`./.ai-review`を推奨します。`.ai-review/`は`.gitignore`に含まれています。

### CLIオプション

| オプション | 内容 |
|---|---|
| `--data-dir <path>` | SQLite、token、snapshotの保存ルート |
| `--port <0-65535>` | 待ち受けポート。`0`で空きポートを使用 |
| `--ui-root <path>` | Review UIの静的ファイルルート |

`--data-dir=/path`のような`=`形式も使用できます。

### UIを開く

`--ui-root`を指定した場合、ブラウザで次を開きます。

```text
http://127.0.0.1:4318/
```

静的UIシェルは公開されていますが、`/v1` APIはowner bearer tokenが必要です。画面でtokenと`repository_id`を入力してください。tokenはReactのメモリ内だけに保持され、URL、cookie、localStorage、sessionStorageには保存されません。

`uiRoot`をRecorderのdata directory、SQLiteファイル、snapshot directoryと重ねることはできません。これはtokenやレビュー記録の静的公開を防ぐためです。

## APIマニュアル

APIは`127.0.0.1`だけで待ち受けます。`/v1`の全リクエストに次のヘッダーが必要です。

```http
Authorization: Bearer <token>
Content-Type: application/json
```

tokenをコマンドライン引数へ渡さないでください。curlではtoken fileを読み取る関数を使います。
```bash
export RECORDER_TOKEN_PATH="$PWD/.ai-review/token"
auth_header() {
  printf 'Authorization: Bearer '
  cat "$RECORDER_TOKEN_PATH"
}
```

### リポジトリを登録

```bash
ROOT="$PWD"

curl -sS -X POST http://127.0.0.1:4318/v1/repositories \
  -H "$(auth_header)" \
  -H "Content-Type: application/json" \
  -d "{\"root\":\"$ROOT\"}"
```

レスポンスの`data.repository_id`を以降の操作で使用します。

Recorderは次を検証します。

- 登録ルートのcanonical path
- symlinkによるルート外参照
- nested Git repository／未登録submodule
- Gitのtop-levelと登録ルートの一致
- 明示したrepository IDの衝突

### Review sessionを作成

```bash
NOW="$(bun -e 'console.log(new Date().toISOString())')"

curl -sS -X POST http://127.0.0.1:4318/v1/sessions \
  -H "$(auth_header)" \
  -H "Content-Type: application/json" \
  -d "{
    \"session_id\": \"session-example-001\",
    \"repository_id\": \"<repository_id>\",
    \"agent_type\": \"codex\",
    \"started_at\": \"$NOW\",
    \"status\": \"active\"
  }"
```

`agent_type`は`claude-code`または`codex`です。Recorderはsessionとrepositoryの整合性を判断記録の保存前に検証します。

### 判断記録を保存

```bash
curl -sS -X POST http://127.0.0.1:4318/v1/decision-records \
  -H "$(auth_header)" \
  -H "Content-Type: application/json" \
  -d '{
    "record_id": "record-example-001",
    "session_id": "session-example-001",
    "repository_id": "<repository_id>",
    "agent_type": "codex",
    "revision": {
      "kind": "commit",
      "sha": "<commit_sha>"
    },
    "targets": [
      {
        "repository_id": "<repository_id>",
        "path": "src/example.ts",
        "line_start": 10,
        "line_end": 24,
        "revision": {
          "kind": "commit",
          "sha": "<commit_sha>"
        },
        "content_hash": "<target_content_hash>"
      }
    ],
    "judgment": "この変更は既存の処理を壊さない",
    "rationale": "既存のバリデーションを経由している",
    "checks": [
      {
        "name": "bun test",
        "status": "passed",
        "details": "対象テストが成功"
      }
    ],
    "open_questions": [],
    "created_at": "2026-01-01T00:00:00Z"
  }'
```

`revision`には次の2形式があります。

```json
{ "kind": "commit", "sha": "<commit_sha>" }
```

```json
{ "kind": "working-tree", "contentHash": "<working_tree_hash>" }
```

判断記録の標準保存内容は参照情報です。コード本文やAI会話全文を判断記録へ重複保存しません。

### 判断記録を取得

```bash
curl -sS \
  -H "$(auth_header)" \
  http://127.0.0.1:4318/v1/decision-records/record-example-001
```

一覧取得には`repository_id`が必要です。

```bash
curl -sS \
  -H "$(auth_header)" \
  "http://127.0.0.1:4318/v1/decision-records?repository_id=<repository_id>"
```

### dispositionを更新

```bash
curl -sS -X PATCH \
  http://127.0.0.1:4318/v1/decision-records/record-example-001/disposition \
  -H "$(auth_header)" \
  -H "Content-Type: application/json" \
  -d '{"user_disposition":"accepted"}'
```

利用できる状態は次の3つだけです。

- `unreviewed`
- `accepted`
- `rejected`

### ソースを解決

コミットまたは作業ツリーから解決:

```bash
curl -sS \
  -H "$(auth_header)" \
  "http://127.0.0.1:4318/v1/decision-records/record-example-001/source?source=repository"
```

snapshotを明示的に選択:

```bash
curl -sS \
  -H "$(auth_header)" \
  "http://127.0.0.1:4318/v1/decision-records/record-example-001/source?source=snapshot:<snapshot_id>"
```

対象が変更された場合は`hash-mismatch`、revisionがない場合は`revision-not-found`、読み取り不能の場合は`source-unavailable`になります。これらの場合、現在のコードを古い判断へ黙って関連付けることはありません。

### snapshotを保存・削除

snapshotは明示操作です。全リポジトリや会話ログを保存する機能ではありません。

```bash
curl -sS -X POST \
  http://127.0.0.1:4318/v1/decision-records/record-example-001/snapshot \
  -H "$(auth_header)" \
  -H "Content-Type: application/json" \
  -d '{"mode":"patch","content":"@@ -10,2 +10,2 @@\n-old\n+new\n"}'
```

```bash
curl -sS -X DELETE \
  http://127.0.0.1:4318/v1/snapshots/<snapshot_id> \
  -H "$(auth_header)"
```

snapshotはowner-local data directory内に保存され、content hashとサイズが検証されます。

## Claude Code／Codexアダプター

アダプターはJSONLを標準入力から受け取り、1行につき1件の結果を標準出力へ返します。

Recorderを起動したプロセスとは別に、token pathとRecorder URLを設定します。

```bash
export RECORDER_URL="http://127.0.0.1:4318/v1/decision-records"
export RECORDER_TOKEN_PATH="$PWD/.ai-review/token"
```

### JSONL入力形式

```json
{
  "sessionId": "session-example-001",
  "repositoryRoot": "/absolute/path/to/repository",
  "revision": {
    "kind": "commit",
    "sha": "<commit_sha>"
  },
  "targets": [
    {
      "path": "src/example.ts",
      "lineStart": 10,
      "lineEnd": 24,
      "revision": {
        "kind": "commit",
        "sha": "<commit_sha>"
      },
      "contentHash": "<target_content_hash>"
    }
  ],
  "judgment": "この変更は既存の処理を壊さない",
  "rationale": "既存のバリデーションを経由している",
  "checks": [
    { "name": "bun test", "status": "passed" }
  ],
  "openQuestions": []
}
```

Codex:

```bash
printf '%s\n' '<JSONL入力>' | bun plugins/codex/src/index.ts
```

Claude Code:

```bash
printf '%s\n' '<JSONL入力>' | bun plugins/claude-code/src/index.ts
```

ホスト側のhookやイベントからJSONLをアダプターへ接続する設定は、利用するClaude Code／Codex環境側で行います。アダプターはリポジトリを直接読み取らず、判断記録だけをRecorderへ送ります。

### アダプターの制約

- tokenはtoken fileから読み取り、コマンドライン引数には置かない
- source body、transcript、未知のフィールドを拒否
- token単位・tool call単位のログを送らない
- Recorder停止時はbounded retry後に構造化エラーを返す
- retry queueはプロセス内・有限容量で、無期限のoffline queueではない
- `session`と`repository`は先にRecorderへ登録する

## セキュリティとデータ境界

- Recorderは`127.0.0.1`のみで待ち受けます
- `/v1`はowner bearer tokenが必要です
- state-changing APIはOrigin検証も行います
- data directory、SQLite、snapshot、token pathの重なりを拒否します
- token path、database path、snapshot pathのsymlink境界を検証します
- Git操作は読み取り専用で、hooks、fsmonitor、filter、任意コマンドを実行しません
- Git、作業ツリー、snapshot、JSON、adapter入力にはサイズ上限があります
- リポジトリ内のコメントやREADMEを命令として扱いません
- UIはコードやMarkdownをHTMLとして評価しません
- `.ai-review/`、token、SQLite、snapshotをGitへコミットしないでください

## トラブルシューティング

### `401 owner bearer token is required`

- Recorderが出力したtoken pathを確認する
- `RECORDER_TOKEN_PATH`が同じRecorderのtokenを指しているか確認する
- tokenをコマンドライン引数へ渡していないか確認する
- UIではtoken入力後にrepository IDを入力する

### `REPOSITORY_NOT_REGISTERED`またはsessionエラー

判断記録の前に、リポジトリとsessionをRecorderへ登録してください。アダプターは自動で登録しません。

### `hash-mismatch`

判断時点から対象ファイルが変更されています。現在のコードを古い判断の対象として扱わず、revisionまたはsnapshotを確認してください。

### `source-unavailable`

リポジトリ、ファイル、Git object、snapshotが読み取り不能です。Recorderはエラーを隠さず、判断記録を保持したまま未解決状態を表示します。

### `uiRoot must not overlap owner storage`

`--ui-root`に`.ai-review`、SQLiteファイル、その親storage、snapshot directoryを指定していないか確認してください。UIは別ディレクトリの`apps/review-ui/dist`を使用します。

### `bun run test`で`vitest: command not found`

プロジェクトルートで依存関係を再インストールしてください。

```bash
bun install
```

### 直接`bun test`でPlaywright／`document is not defined`が出る

プロジェクトのテストコマンドは`bun run test`です。直接の`bun test`はBunのraw collectorで、PlaywrightとDOM依存のUIテストを適切なrunnerなしで読み込みます。

## ディレクトリ構成

```text
packages/contracts/       共通型・runtime validation
apps/recorder/            ローカルAPI、SQLite、Git／file resolver
apps/review-ui/           Review UI、Vitest、Vite build
plugins/common/           共通JSONL mapper／Recorder bridge
plugins/claude-code/      Claude Code adapter
plugins/codex/            Codex adapter
tests/e2e/                 Playwright workflow／security tests
docs/superpowers/         設計仕様と実装計画
```

## 現在の制約

- チーム共有、クラウド同期、マルチユーザー権限は未実装
- AI会話全文の常時保存は未実装
- コード脆弱性の自動スキャンは未実装
- 未追跡ファイルはGit diffの対象外
- バイナリ専用の表示型はなく、source APIはUTF-8 textとして扱う
- 大きなsource/diffはサイズ上限またはdiff-work budgetにより未解決になる場合がある
