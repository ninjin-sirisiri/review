# AI Code Review Evidence

AIコーディングエージェントが行った判断を、実ファイル・Git revision・diff・確認結果と結びつけてレビューするローカルファーストのツールです。

## できること

- Claude Code／Codex／OpenCode／Cursorの判断記録を共通形式へ変換
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

## グローバルコマンド

RecorderとReview UIを、任意のディレクトリから起動できます。

```bash
bun run install:command
```

このコマンドは `bin/ai-review` を `~/.local/bin/ai-review` へシンボリックリンクし、必要ならシェル設定へ `~/.local/bin` を追加します。新しいターミナルを開いたあと:

```bash
ai-review
```

既定値は次のとおりです。

- データディレクトリ: `~/.ai-code-review-evidence`
- ポート: `4318`
- UI: このリポジトリの `apps/review-ui/dist`（未ビルドなら起動時にビルド）

開発用にプロジェクト内へ保存する場合:

```bash
ai-review --data-dir ./.ai-review --port 4318
```

## Recorderの起動

リポジトリ直下から直接起動する場合は、先にReview UIをビルドし、Recorderへ静的UIのルートを渡します。

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

静的UIシェルは公開されていますが、`/v1` APIはowner bearer tokenが必要です。画面でtokenを入力して「Load repositories」を実行すると、Recorderに登録済みのリポジトリが一覧表示されるので選択してタイムラインを開きます。tokenはReactのメモリ内だけに保持され、URL、cookie、localStorage、sessionStorageには保存されません。

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

### 登録済みリポジトリを一覧取得

```bash
curl -sS \
  -H "$(auth_header)" \
  http://127.0.0.1:4318/v1/repositories
```

`repository_id`、canonical `root`、`created_at`の一覧を`created_at`順で返します。UIの「Load repositories」もこのエンドポイントを使用します。

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

`agent_type`は`claude-code`、`codex`、`opencode`、`cursor`のいずれかです。Recorderはsessionとrepositoryの整合性を判断記録の保存前に検証します。

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

### 自動snapshotと遷移比較

インストール済みのClaude Code／OpenCodeプラグインでは、判断に対応する`Edit`／`Write`の直前に、編集前のファイル状態をautomatic snapshotとして保存します。Recorderが停止している、保存に失敗する、対象のhashが変わっているなどの場合、編集も拒否されます。これは編集後に証拠を作るのではなく、編集前の状態を失わないためのfail-closedなゲートです。

Review UIでautomatic snapshotを持つ判断を選択すると、同じ`repository_id`とpathの次のautomatic snapshotとの遷移を表示します。次のcaptureがなければ、現在の作業ツリーを`after: working tree`として使用します。次のcaptureが壊れている、または読み取れない場合は、作業ツリーへ黙ってfallbackせず、`source-unavailable`または`revision-not-found`を表示します。

既存のmanual snapshotは明示的な`POST /snapshot`操作で保存する独立した機能であり、このautomatic chainには入りません。automatic captureを持たない既存の判断記録は従来どおりのsource／Git diff表示を維持します。

automatic captureのAPI形状は次のとおりです。これはインストール済みのローカルアダプターが編集ゲートから呼び出すためのAPIであり、任意のcontentを証拠として注入する一般用途のAPIではありません。Recorderはrecord、対象path、現在のファイル状態とcontent hashを検証します。

```http
POST /v1/decision-records/<recordId>/automatic-snapshot
```

```json
{
  "capture_id": "<capture_id>",
  "source_path": "src/example.ts",
  "content": "<file content>",
  "before_missing": false
}
```

新規captureの成功時は`201`、同一の`capture_id`・record・path・content hash・`before_missing`を持つcaptureの再送時は`200`で、次のようなreferenceを返します。異なるcapture内容で同じ`capture_id`を再利用した場合はエラーになります。

Git objectを参照できる場合の成功例です。owner-local storageへ保存する場合は`mode`が`changed-files`になり、`path`にstorage-relative pathが入ります。

```json
{
  "success": true,
  "data": {
    "snapshot_id": "<snapshot_id>",
    "record_id": "<recordId>",
    "mode": "git",
    "path": "",
    "content_hash": "<sha256>",
    "created_at": "2026-01-01T00:00:00.000Z",
    "source_path": "src/example.ts",
    "capture_kind": "automatic",
    "before_missing": false,
    "base_sha": "<commit_sha>"
  }
}
```

`mode`はGit objectを参照できる場合の`git`、owner-local storageへ保存する場合の`changed-files`です。後者では`path`がstorage-relative pathになります。認証、Origin、path、現在状態、サイズの検証に失敗した場合は、通常のAPI error envelope（`success:false`）と対応するerror codeを返し、snapshotを保存しません。

遷移比較は次のGET APIです。

```http
GET /v1/decision-records/<recordId>/snapshot-diff?path=src/example.ts
```

次のautomatic snapshotが解決できた場合の形状は次のとおりです。`to`には次のcaptureのreferenceが入り、Git-backed referenceなら`base_sha`と作成時刻を含みます。

```json
{
  "success": true,
  "data": {
    "state": "snapshot-resolved",
    "path": "src/example.ts",
    "from": { "kind": "snapshot", "snapshot_id": "<before_snapshot_id>", "record_id": "<recordId>", "created_at": "<time>", "content_hash": "<sha256>", "source_path": "src/example.ts" },
    "to": { "kind": "snapshot", "snapshot_id": "<next_snapshot_id>", "record_id": "<next_record_id>", "created_at": "<time>", "content_hash": "<sha256>", "source_path": "src/example.ts" },
    "hunks": [{ "oldStart": 1, "newStart": 1, "lines": [{ "type": "del", "oldLine": 1, "newLine": null, "content": "old" }, { "type": "add", "oldLine": null, "newLine": 1, "content": "new" }] }],
    "old_missing": false,
    "new_missing": false,
    "binary": false
  }
}
```

次のcaptureがない場合、`data.to`は`{"kind":"working-tree"}`です。automatic captureがない旧記録の場合は、次のlegacy responseになり、UIは従来の表示へ戻ります。

```json
{
  "success": true,
  "data": { "state": "legacy-fallback", "reason": "automatic-snapshot-not-found", "path": "src/example.ts" }
}
```

遷移のどちらかのsnapshotを検証できない場合は、HTTP成功レスポンス内の`data.state`を`source-unavailable`または`revision-not-found`として返します。これは表示上の失敗状態であり、現在の作業ツリーを代わりに返すものではありません。

## Claude Code／Codex／OpenCode／Cursorアダプター

アダプターはJSONLを標準入力から受け取り、1行につき1件の結果を標準出力へ返します。

Recorderを起動したプロセスとは別に、token pathとRecorder URLを設定します。

```bash
export RECORDER_URL="http://127.0.0.1:4318/v1/decision-records"
export RECORDER_TOKEN_PATH="$PWD/.ai-review/token"
```

### Claude Codeプラグインのローカルインストール

このリポジトリには、Claude Code用のローカルmarketplaceと`ai-code-review-claude`プラグインが含まれています。bundleを更新した場合は先に再生成します。

```bash
bun run build:claude-plugin
claude plugin validate plugins/claude-code
claude plugin marketplace add ./
claude plugin install ai-code-review-claude@ai-code-review-local --scope local
claude plugin list
```

インストール後は`ai-code-review-claude@ai-code-review-local`が`local` scopeで有効になります。プラグインの`bin`には`ai-review-claude-code`と`ai-review-record`が追加されます。

プラグインにはClaude Codeの全エージェント共通の判断ゲートを含めています。`SessionStart` hookがセッション識別子を初期化し、`PreToolUse` hookが`Edit`／`Write`（およびノートブック編集）を、対象ファイルの現在hashに一致する判断記録が先にRecorderへ保存されていない限り拒否します。プラグインhookはClaude Codeのsubagentにも適用されます。`Bash`／`PowerShell`の明らかなファイル変更コマンドも、組み込みの`Edit`／`Write`へ戻すよう拒否します。

編集前に、判断対象を指定して一度だけ使えるpermitを発行します。

```bash
cat <<'JSON' | ai-review-record
{
  "targets": [{"path": "src/example.ts", "lineStart": 10, "lineEnd": 24}],
  "judgment": "この変更は既存の処理を壊さない",
  "rationale": "既存のバリデーションを経由している",
  "checks": [{"name": "focused test", "status": "not-run"}],
  "openQuestions": []
}
JSON
```

出力が`"success":true`になった後だけ`Edit`／`Write`を呼び出します。permitは対象path、現在のcontent hash、セッションに結び付けられ、1回の一致する編集で消費されます。記録失敗、対象hashの変化、別ファイルへの編集、permit期限切れの場合は編集を続けず、記録をやり直してください。`ai-review-record`はコード本文をRecorderへ送らず、現在ファイルのhashだけを計算します。

現在のプラグインはClaude Codeの全会話を自動収集するhookではありません。下記のJSONL入力を`ai-review-claude-code`へ渡す既存のアダプター経路も利用できます。ただし、この経路は判断記録を保存しますが、編集permitは発行しません。編集前の操作には必ず`ai-review-record`を使用します。

### OpenCodeプラグイン

OpenCode用のプラグインは`plugins/opencode/src/index.ts`です。プロジェクトの`opencode.json`で読み込むか、`.opencode/plugins/`へ配置すると自動的に読み込まれます。

```json
{
  "$schema": "https://opencode.ai/config.json",
  "plugin": ["./plugins/opencode/src/index.ts"]
}
```

設定変更後はOpenCodeを再起動してください。プラグインは次の動作をします。

- `session.created`イベントと初回のgate対象tool呼び出し時に、worktreeをrepositoryとしてRecorderへ自動登録する（agent_typeは`opencode`）
- `edit`／`write`／`patch`（およびノートブック編集）を、対象ファイルの現在hashに一致する判断記録が先に保存されていない限り拒否する
- `bash`の明らかなファイル変更コマンド（リダイレクト、`sed -i`、`git checkout`等）も拒否し、組み込みの`edit`／`write`へ戻す
- 組み込みtool `review_record_judgment` で判断を記録し、対象path・現在content hash・セッションに結び付いた1回使い切りのpermitを発行する
- `shell.env`経由でシェルに`AI_REVIEW_SESSION_ID`、`AI_REVIEW_REPOSITORY_ROOT`、`AI_REVIEW_AGENT_TYPE=opencode`をエクスポートする

編集の流れはClaude Codeプラグインと同じです。まず`review_record_judgment`を呼び、`"success":true`を受け取った後だけ同じ対象へ`edit`を呼びます。permitは一致する1回の編集で消費され、hash変化・別ファイル・期限切れの場合は再記録が必要です。

Recorderが停止していてもゲートは閉じたまま fail-closed で動作し、登録や記録の失敗はOpenCodeのログに警告として出力されます。

OpenCodeの`edit`／`write`もClaude Codeの`Edit`／`Write`と同様に、許可前に編集前automatic snapshotを保存します。Recorderへのautomatic captureが成功しない限り、どちらのプラグインも編集を通しません。手動の`/snapshot`操作やアダプターからのJSONL判断記録だけでは、この遷移用captureは作成されません。

### Cursorプラグイン

Cursor用のプラグインは`plugins/cursor/`です。Cursor Plugins形式（`.cursor-plugin/plugin.json`）で、hooks・skill・MCP toolを同梱します。bundleを更新した場合は先に再生成します。

```bash
bun run build:cursor-plugin
```

このリポジトリはプロジェクトhook（`.cursor/hooks.json`）を同梱します。Cursorは信頼済みworkspaceでこれを自動読み込みするため、プラグインをCustomizeで有効化しなくても編集ゲートは発火します。Cloud agentもプロジェクトhookだけを拾います。

MCP tool `review_record_judgment` とskillが必要な場合は、ローカルmarketplaceを追加するか、次でプラグインを読み込みます。

```bash
ln -s "$PWD/plugins/cursor" ~/.cursor/plugins/local/ai-code-review-cursor
```

特定のリポジトリだけに入れる場合は、実行ファイルをそのリポジトリの`.cursor/plugins/ai-code-review-cursor/`へコピーし、プロジェクトの`.cursor/hooks.json`と`.cursor/mcp.json`から参照します。コピーした`.cursor-plugin/plugin.json`からは`hooks`を外してください。残すとCursorがプラグイン同梱のfail-closedフックも読み、`./bin/ai-review-pre-edit`が削除済みの`~/.cursor/plugins/local/`などをcwdにして`spawn /bin/zsh ENOENT`で編集もShellも止まります。同梱hooksのcommandは`/bin/sh "${CURSOR_PLUGIN_ROOT}/bin/..."`です。CursorはこれをinstallPathで展開します。

プラグイン導入後はCursorを再起動し、Pluginsで`ai-code-review-cursor`が有効であることを確認してください。ゲート自体は次の動作をします。

- `sessionStart` hookがworkspaceをrepositoryとしてRecorderへ自動登録する（agent_typeは`cursor`）。Cursorは新しいComposer会話の作成時だけ`sessionStart`を呼ぶため、同じ登録を`beforeSubmitPrompt`でも行う。登録結果は後続hook向けに`AI_REVIEW_SESSION_ID`、`AI_REVIEW_REPOSITORY_ROOT`、`AI_REVIEW_AGENT_TYPE=cursor`として返す。Cloud agentは`sessionStart`を実行しないため、初回のgate対象tool呼び出し時にも登録を試みる
- `preToolUse`が`Write`／`StrReplace`／`ApplyPatch`／`Delete`（およびノートブック編集）を、対象ファイルの現在hashに一致する判断記録が先に保存されていない限り拒否する（`failClosed: true`）。許可時も`{"permission":"allow"}`を返す
- `beforeShellExecution`および`preToolUse`の`Shell`で、明らかなファイル変更コマンド（リダイレクト、`sed -i`、`git checkout`等）も拒否し、組み込みの`Write`／`StrReplace`へ戻す
- 同梱MCP tool `review_record_judgment` で判断を記録し、対象path・現在content hash・セッションに結び付いた1回使い切りのpermitを発行する
- 許可前に編集前automatic snapshotを保存する。Recorderへのautomatic captureが成功しない限り編集を通さない

編集の流れはOpenCodeプラグインと同じです。まず`review_record_judgment`を呼び、`"success":true`を受け取った後だけ同じ対象へ`Write`／`StrReplace`を呼びます。permitは一致する1回の編集で消費され、hash変化・別ファイル・期限切れの場合は再記録が必要です。

Recorderが停止していてもゲートは閉じたまま fail-closed で動作します。`sessionStart`／`beforeSubmitPrompt`の登録失敗はstderrへ警告しますが、Cursorへはsession env（またはprompt continuation）を返すため後続hookがセッションIDを使えます。

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
printf '%s\n' '<JSONL入力>' | ai-review-claude-code
```

OpenCode:

```bash
printf '%s\n' '<JSONL入力>' | bun plugins/opencode/src/index.ts
```

Cursor:

```bash
printf '%s\n' '<JSONL入力>' | bun plugins/cursor/src/index.ts
```

プラグイン未インストールの開発時だけ、bundle生成前のsource entrypointを直接実行できます。

ホスト側のhookやイベントからJSONLをアダプターへ接続する設定は、利用するClaude Code／Codex／Cursor環境側で行います。アダプターはリポジトリを直接読み取らず、判断記録だけをRecorderへ送ります。

### アダプターの制約

- tokenはtoken fileから読み取り、コマンドライン引数には置かない
- source body、transcript、未知のフィールドを拒否
- token単位・tool call単位のログを送らない
- Recorder停止時はbounded retry後に構造化エラーを返す
- retry queueはプロセス内・有限容量で、無期限のoffline queueではない
- `session`と`repository`は先にRecorderへ登録する

## AI編集前の判断記録セットアップ

この節では、AIが編集する前に判断をRecorderへ保存し、保存済み判断に対応する編集だけを許可する構成を説明します。

### 重要な前提

`repository_id`とtokenを用意するだけでは、編集は自動記録されません。通常の自動化された処理は次の順序です。

```text
Recorder起動
  → pluginを有効化してホストを再起動
  → SessionStartがrepository/sessionを自動登録
  → AIがai-review-record（Cursorでは review_record_judgment）を実行
  → 判断記録をRecorderへ保存
  → 対象hashに紐づく1回限りの編集permitを発行
  → Edit／Write（Cursorでは Write／StrReplace）を許可
```

`SessionStart` hookはrepository IDやtoken自体を生成しませんが、Recorderへrepositoryとsessionを自動登録します。設定される環境変数は次のとおりです。

- `AI_REVIEW_SESSION_ID`
- `AI_REVIEW_REPOSITORY_ROOT`
- `AI_REVIEW_AGENT_TYPE`

repository IDはcanonicalなrepository rootのSHA-256です。tokenはRecorderの初回起動時にtoken fileへ生成され、既存tokenがあれば再利用されます。

### 1. Recorderを一度起動

Review UIをビルドしてRecorderを起動します。

```bash
bun run --cwd apps/review-ui build
bun run recorder \
  --data-dir "$HOME/.ai-code-review-evidence" \
  --port 4318 \
  --ui-root "$PWD/apps/review-ui/dist"
```

既存のRecorderを使用する場合は、次のURLを使用します。

```bash
export RECORDER_URL="http://127.0.0.1:4318/v1/decision-records"
```

### 2. token pathを確認

標準のtoken pathは次です。

```bash
export RECORDER_TOKEN_PATH="${RECORDER_TOKEN_PATH:-$HOME/.ai-code-review-evidence/token}"
test -s "$RECORDER_TOKEN_PATH"
printf 'token path: %s\n' "$RECORDER_TOKEN_PATH"
```

token本体をコマンドライン引数やログへ出力しないでください。`--data-dir ./.ai-review`で起動した場合は、次を設定します。

```bash
export RECORDER_TOKEN_PATH="$PWD/.ai-review/token"
```

### 3. pluginを一度インストール

Claude Code:

```bash
bun run build:claude-plugin
claude plugin validate plugins/claude-code
claude plugin marketplace add ./
claude plugin install ai-code-review-claude@ai-code-review-local --scope user
```

Oh My Pi:

```bash
omp plugin marketplace add ./
omp plugin install ai-code-review-claude@ai-code-review-local --scope user
omp plugin list
```

次の表示があれば、Oh My Piのuser scopeで有効です。

```text
ai-code-review-claude@ai-code-review-local (0.2.0) (user)
```

インストール後はClaude Code／OMPを再起動してください。`omp plugin install ./plugins/claude-code`はnpm/extension packageとして扱われ、`package.json`がないため使用できません。ローカルmarketplace経由でインストールします。

Cursor:

```bash
bun run build:cursor-plugin
ln -s "$PWD/plugins/cursor" ~/.cursor/plugins/local/ai-code-review-cursor
```

このリポジトリでは`.cursor/hooks.json`が編集ゲートを読み込むため、プラグイン未導入でも`preToolUse`／`beforeShellExecution`／`beforeSubmitPrompt`は発火します。MCP toolとskillを使う場合はCursorを再起動し、Pluginsで`ai-code-review-cursor`が有効であることを確認します。

### 4. SessionStartの自動登録

ホストを再起動すると、`sessionStart` hookが次を自動実行します。Cursorは新しいComposer会話の作成時だけ`sessionStart`を呼ぶため、同じ処理を最初の`beforeSubmitPrompt`でも実行します。

1. 現在のrepository rootをcanonical化（`workspace_roots`／`CURSOR_PROJECT_DIR`をプラグインcwdより優先）
2. Recorderへrepositoryを登録
3. `AI_REVIEW_SESSION_ID`に対応するsessionを登録
4. `AI_REVIEW_SESSION_ID`、root、agent typeを環境へ保存（`beforeSubmitPrompt`ではprompt continuationだけを返す）

自動登録の確認:

```bash
printf 'session: %s\n' "$AI_REVIEW_SESSION_ID"
printf 'root: %s\n' "$AI_REVIEW_REPOSITORY_ROOT"
printf 'agent: %s\n' "$AI_REVIEW_AGENT_TYPE"
```

Recorderが停止している場合、SessionStartは警告を出しますが、編集を許可しません。Recorderを起動してホストを再起動するか、手動fallbackを実行してください。

### 5. 手動fallback: repositoryとsessionを登録

OMPがClaude Codeの`CLAUDE_ENV_FILE`互換を提供しない場合や、SessionStartを再実行したい場合は、次の1コマンドを使用します。

```bash
ai-review setup \
  --root "$PWD" \
  --agent-type claude-code
```

`--session-id`を省略した場合はUUIDを生成します。生成結果は表示されますが、次回hookで同じsessionを使うため、出力されたIDを`AI_REVIEW_SESSION_ID`へexportしてください。token本体は出力されません。

repository IDとsessionをAPIで登録する必要がある場合は、既存のAPIマニュアルにある`POST /v1/repositories`と`POST /v1/sessions`を使用します。

### 6. 編集前に判断を記録

AIが対象ファイルを確認した後、`Edit`または`Write`の前に`ai-review-record`を実行します。

```bash
cat <<'JSON' | ai-review-record
{
  "targets": [
    {"path": "src/example.ts", "lineStart": 10, "lineEnd": 24}
  ],
  "judgment": "この変更は既存の処理を壊さない",
  "rationale": "既存のバリデーションを経由している",
  "checks": [
    {"name": "focused test", "status": "not-run"}
  ],
  "openQuestions": []
}
JSON
```

`"success":true`が返った後だけ編集します。コマンドは対象ファイルの現在hashを計算し、判断をRecorderへ保存してから、対象path・hash・sessionに拘束された1回限りのpermitを発行します。

次の場合は編集が拒否されます。

- `ai-review-record`を実行していない
- Recorderへの保存に失敗した
- 対象ファイルが記録後に変更された
- 記録対象と別のファイルを編集した
- permitを2回以上使用した
- permitが期限切れになった
- `Edit`／`Write`をBashの編集コマンドで迂回した

記録失敗時に一時的なallow-listを作ったり、編集後に記録したりしてはいけません。対象を再確認して新しい判断を記録してください。

複数ファイルを編集する場合は、すべての対象pathを`targets`へ含めます。新規ファイルは、存在しない状態で対象pathと`lineStart: 1`を指定します。

### 7. 動作確認

```bash
printf 'session: %s\n' "$AI_REVIEW_SESSION_ID"
test -s "$RECORDER_TOKEN_PATH"
omp plugin list
```

`ai-review setup`の成功結果には、少なくとも次が含まれます。

```json
{
  "success": true,
  "repositoryId": "<repository_id>",
  "sessionId": "<session_id>",
  "root": "<canonical_root>",
  "agentType": "claude-code",
  "tokenPath": "<token_path>"
}
```

判断記録コマンドの成功結果には、少なくとも次が含まれます。

```json
{
  "success": true,
  "recordId": "<record_id>",
  "permits": 1
}
```

`Edit`／`Write`が`Code edit blocked`になった場合は、Recorderの稼働、token path、pluginの再起動、session IDの一致を順番に確認します。

### 自動記録の範囲

この構成は、AIの判断をhookが勝手に生成して全編集を無条件に記録する仕組みではありません。AIが`ai-review-record`で判断・根拠・対象を明示し、hookがその記録済みpermitを検証してから編集を許可します。

そのため、repository IDとtokenだけを設定しても記録は始まりません。Recorder、repository、session、plugin、判断記録コマンド（`ai-review-record`または`review_record_judgment`）の5つがそろって初めて編集前記録が機能します。

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
- UIではtoken入力後に「Load repositories」で登録済みリポジトリを選択する

### `REPOSITORY_NOT_REGISTERED`またはsessionエラー

SessionStartの自動登録または`ai-review setup`を実行してください。アダプターは判断記録を保存しますが、登録前のsession/repositoryを推測して作成しません。

### フックが別プラグインの `adapter.mjs` を探して失敗する

Cursorはフック実行時に、別プラグインの`CURSOR_PLUGIN_ROOT`を残したままにすることがあります。本プラグインのラッパーは常に自身のディレクトリでこの変数を上書きします。古いラッパーが残っている場合はプラグインを更新し、Cursorを再起動してください。

### `spawn /bin/zsh ENOENT` で fail-closed になる

Cursorはcommandフックを`process.env.SHELL`（macOSでは多くの場合`/bin/zsh`）の`-c`で起動し、プラグインフックのcwdはplugin installPathです。installPathが削除済み（例: アンインストールした`~/.cursor/plugins/local/ai-code-review-cursor`）だと、Nodeは実行ファイルではなくcwd欠如を`spawn /bin/zsh ENOENT`と報告します。判断記録が成功していても、fail-closedな`preToolUse`がWriteもShellも拒否します。

対処:

- ユーザー全体へ入れたプラグインを外したあとはCursorを再起動する
- プロジェクト専用コピーでは`.cursor/hooks.json`だけをゲートにし、コピーした`plugin.json`の`hooks`は外す
- プラグイン同梱hooksは`/bin/sh "${CURSOR_PLUGIN_ROOT}/bin/ai-review-pre-edit"`を使う。相対パス`./bin/...`には戻さない

### `sessionId is required; start the plugin session first`

CursorのMCPサーバーは`sessionStart`が返した環境変数を引き継ぎません。ワークスペースで`sessionStart`または`beforeSubmitPrompt`が成功していれば、`${workspaceFolder}`（`AI_REVIEW_REPOSITORY_ROOT`）または`CURSOR_PROJECT_DIR`からpersisted sessionを復元します。新しい会話を開始するかプロンプトを送り直し、Recorderが起動していることを確認してください。

### `agent_type must be claude-code, codex, or opencode`

起動中のRecorderが`cursor`をまだ認めていません。メッセージに`cursor`が含まれない場合は、このリポジトリの現行ソースからRecorderを再起動してください。contractsの現行メッセージは`claude-code, codex, opencode, or cursor`です。

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
plugins/opencode/         OpenCode plugin（判断ゲート＋record tool）
plugins/cursor/           Cursor plugin（hooks＋MCP review_record_judgment）
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
