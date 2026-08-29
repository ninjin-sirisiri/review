# 自動スナップショットと後続状態比較の設計

- 日付: 2026-08-27
- ステータス: 承認済み（設計対話により要件・方針を決定済み）
- 関連: `docs/superpowers/specs/2026-08-26-git-backed-snapshots-design.md`

本設計は、前回設計の「非Gitモードでは`source_path`を持たない」という条件を、自動撮影のファイルバック行に限って更新する。既存の手動非Git行には引き続き`source_path`を許可しない。

## 1. 背景と目的

現在のスナップショットは、`POST /v1/decision-records/:recordId/snapshot` による明示操作でのみ作成される。編集前の判断は保存されるが、その判断の直後に実際にどの変更が進んだかを、次の判断または現在の作業ツリーまでの区間として確認する仕組みはない。

編集ゲートは、判断の記録後に対象ファイルの現在ハッシュとpermitを検証してから編集を許可する。この直前のタイミングで対象ファイルを自動保存すれば、判断時点の内容を確実に退避できる。

本変更の目的は次の二つである。

1. 許可された編集の直前に、対象ファイルの編集前状態を自動スナップショットとして保存する。
2. Review UIでファイルを開き、判断を選択したとき、その判断の編集前スナップショットと同一ファイルの次の自動スナップショット、または現在の作業ツリーとの差分を表示する。

Recorderがスナップショットを保存できない場合は編集を許可しない。これにより、自動撮影を有効にした編集について「証拠なしで編集が進んだ」状態を作らない。

## 2. 決定事項

| 問い | 決定 |
| --- | --- |
| 自動撮影のタイミング | permitが一致した編集の直前 |
| 撮影失敗時 | bounded retry後も失敗したら編集を拒否 |
| 次状態の探索範囲 | 同じ登録リポジトリ・同じ正規化パスの全セッション/全レコード |
| チェーン対象 | 自動撮影のみ。既存の手動`patch`/`changed-files`は除外 |
| 次状態が存在しない場合 | 現在の作業ツリーを使用 |
| UIの変更 | Explorer・判断一覧・中央DiffViewの3ペイン構成は維持。判断選択と中央表示の切替だけ追加 |
| 自動撮影の保存形式 | 通常は全文ファイル。`HEAD` blobと一致する場合は既存のGit参照最適化を利用 |
| 既存レコード | 自動スナップショットがなければ従来のrevision対作業ツリー表示へフォールバック |

## 3. スコープと非ゴール

### 3.1 スコープ

- Claude CodeとOpenCodeの既存編集ゲートへの自動撮影処理の追加
- 自動撮影を表す永続メタデータと冪等性
- 同一リポジトリ・同一パスの次状態探索
- スナップショット対スナップショット、またはスナップショット対作業ツリーの差分生成
- 判断選択に連動した中央DiffViewの表示切替
- 既存データベースからの安全なスキーマ移行
- contracts、Recorder、plugins、Review UI、E2Eのテスト

### 3.2 非ゴール

- 会話ログや全リポジトリの自動保存
- 手動スナップショットAPIの意味変更
- 手動`patch`スナップショットの比較チェーンへの追加
- スナップショットの圧縮、CAS、GC、保持期限
- 新しいタイムライン専用ペインや大規模なUI再設計
- Bashによる任意のファイル変更の自動撮影。既存どおり安全側に拒否する

## 4. 用語と不変条件

- **自動スナップショット**: 編集ゲートでpermitが一致した後、編集ツールの実行前にRecorderへ保存する全文状態。
- **before**: 選択した判断に紐づく自動スナップショット。存在しないファイルも状態として表現する。
- **next**: `before`より後にRecorderが採番した、同じ`repository_id`・同じ`source_path`の最初の自動スナップショット。
- **after**: `next`があればその内容、なければ比較リクエスト時点の現在の作業ツリー。
- **撮影順**: RecorderのDBトランザクション内で採番する単調増加値。UUIDやクライアント時刻を順序判定に使わない。

以下を常に守る。

- beforeまたはnextが改竄・欠損・読み取り不能なら、後続のスナップショットを飛ばさない。
- nextがある場合に現在の作業ツリーへ黙ってフォールバックしない。nextの読み取り失敗は明示的な`source-unavailable`にする。
- 保存済み内容のハッシュを読み取り時に再計算する。
- 自動スナップショットのパスは対象レコードのtargetに含まれるリポジトリ相対パスだけを許可する。
- Gitアクセスは既存の`GitReader`、作業ツリーアクセスは既存の`WorkingTreeReader`を使う。

## 5. 自動撮影フロー

### 5.1 編集前フック

Claude Codeの`PreToolUse`とOpenCodeの`tool.execute.before`で、既存のpermit検証を次の順序に拡張する。

1. 編集対象パスを抽出する。既存ゲートで対象を特定できない呼び出しは拒否する。
2. permitのセッション、リポジトリ、正規化パス、現在内容のハッシュを検証する。
3. permitに保存された`record_id`と一意な`capture_id`を取得する。
4. 編集前のファイル内容と、ファイルが存在するかどうかを読み取る。
5. Recorderの自動撮影APIへ送信する。
6. 成功レスポンスを受け取った場合だけ編集ツールを実行させる。

自動撮影は既存の直接編集ツール（`Edit`、`Write`、`Patch`、`MultiEdit`、`NotebookEdit`およびOpenCode側の対応名）に適用する。複数パスを含む呼び出しを完全に特定できない場合は、既存のゲートと同じく編集を拒否する。

### 5.2 Recorder側の検証

自動撮影APIは、クライアントが送った内容をそのまま信頼しない。

- recordが存在することを確認する。
- `source_path`がrecordのtargetの一つと一致することを確認する。
- `RepositoryRegistry.assertTarget`でリポジトリ境界とsymlink境界を再検証する。
- 現在の作業ツリーを読み、送信内容のハッシュと一致することを確認する。
- `before_missing=true`の場合は対象が存在せず、内容が空文字であることを確認する。空の既存ファイルとは区別する。
- 内容サイズ、UTF-8、既存のsnapshot上限を適用する。

フックとRecorderの間でファイルが変更された場合は競合として失敗させる。フックは編集を拒否し、permitは消費しないため、新しい判断で再試行できる。

### 5.3 冪等性と失敗

permitごとに`capture_id`を生成し、Recorder側で一意にする。同じ`record_id`、`capture_id`、対象パス、内容ハッシュ、missing状態の再送は、既存の同じ参照を返す。capture内容が異なる同一`capture_id`は不正リクエストとして拒否する。

ブリッジは既存のbounded retryを使う。すべての試行が失敗した場合、編集フックは拒否理由を返す。自動撮影成功後に編集ツール自体が失敗した場合は、既存方針どおりpermitを消費しない。同じpermitの再試行は同じ自動スナップショットに収束する。

## 6. データモデルとスキーマ移行

### 6.1 SnapshotReference

既存の`SnapshotReference`へ、自動撮影を表す任意フィールドを追加する。

```ts
type SnapshotCaptureKind = "manual" | "automatic";

interface SnapshotReference {
  snapshot_id: string;
  record_id: string;
  mode: "changed-files" | "patch" | "git";
  path: string;
  content_hash: string;
  created_at: string;
  base_sha?: string;
  source_path?: string;
  capture_kind?: SnapshotCaptureKind;
  before_missing?: boolean;
}
```

`base_sha`と`source_path`の既存Git参照の意味は維持する。自動のファイルバック行では`source_path`を持ち、`base_sha`は持たない。`before_missing`は自動行で必須であり、通常の既存手動行では省略できる。

契約検証では、Gitモードの`source_path`は従来どおり必須とする。非Gitモードの`source_path`は`capture_kind='automatic'`の場合だけ許可・必須とし、手動の非Gitスナップショットでは省略する。`capture_kind`が省略された既存入力は手動として後方互換に扱う。`before_missing`はautomaticの場合だけ許可し、booleanであることを検証する。

`capture_sequence`と`capture_id`は冪等性・探索の内部メタデータであり、公開参照へは含めない。必要な比較情報は専用の`SnapshotDiff`レスポンスで公開する。

### 6.2 snapshotsテーブル

スキーマバージョン4で`snapshots`を再buildする。既存v3の列は保持し、次の列を追加する。

```sql
capture_kind TEXT NOT NULL DEFAULT 'manual'
  CHECK (capture_kind IN ('manual', 'automatic')),
before_missing INTEGER NOT NULL DEFAULT 0
  CHECK (before_missing IN (0, 1)),
capture_sequence INTEGER,
capture_id TEXT,
```

追加制約は次のとおりとする。

- `capture_kind='automatic'`なら`source_path`、`capture_sequence`、`capture_id`が必須。
- `capture_kind='automatic'`では`before_missing=1`の内容ハッシュは空文字のSHA-256と一致する。
- `capture_id`のNULL以外に一意インデックスを作る。
- `capture_sequence`のNULL以外に一意インデックスを作る。
- `source_path`はautomaticでは契約層の相対パス検証を通す。manualのGit参照で既に使われている`source_path`は保持する。

既存手動行は`capture_kind='manual'`、`before_missing=0`、`capture_sequence=NULL`、`capture_id=NULL`として移行する。既存行の`base_sha`と`source_path`は変更しない。

`capture_sequence`は自動行を作るトランザクションで現在の最大値に1を加えて採番する。SQLiteの書き込み直列化により、同時撮影でも順序を一意にする。

### 6.3 自動撮影API

```text
POST /v1/decision-records/:recordId/automatic-snapshot
```

リクエストは次の形とする。

```json
{
  "capture_id": "permit-generated-id",
  "source_path": "src/example.ts",
  "content": "...",
  "before_missing": false
}
```

`mode`はクライアントから受け取らず、自動撮影では全文を表す既存の`changed-files`としてRecorderが設定する。認証、Origin、JSONサイズ上限は既存のmutation APIと同じとする。

同じ`capture_id`の一致する再送は`201`または既存リソースを示す`200`で同じ参照を返す。不一致は`INVALID_RECORD`として拒否する。

### 6.4 比較API

```text
GET /v1/decision-records/:recordId/snapshot-diff?path=<relative-path>
```

成功時の概念形は次のとおりとする。

```ts
interface SnapshotDiff {
  state: "snapshot-resolved";
  path: string;
  from: SnapshotEndpoint;
  to: SnapshotEndpoint | WorkingTreeEndpoint;
  hunks: DiffHunk[];
  old_missing: boolean;
  new_missing: boolean;
  binary: boolean;
}

interface SnapshotEndpoint {
  kind: "snapshot";
  snapshot_id: string;
  record_id: string;
  created_at: string;
  content_hash: string;
  source_path: string;
  base_sha?: string;
}

interface WorkingTreeEndpoint {
  kind: "working-tree";
}
```

比較APIのレスポンスは次の判別可能な形にする。

```ts
type SnapshotDiffResponse =
  | SnapshotDiff
  | { state: "legacy-fallback"; reason: "automatic-snapshot-not-found"; path: string }
  | {
      state: "source-unavailable" | "revision-not-found";
      path: string;
      message: string;
    };
```

`legacy-fallback`は通常のエラーではなく、UIが従来の差分データを使う合図である。未解決状態はHTTP成功エンベロープ内の明示的なstateとして返す。差分計算のサイズ超過は既存APIと同じ`PAYLOAD_TOO_LARGE`エラー（HTTP 413）として返す。

自動beforeが存在し、nextが存在しない場合は`to.kind="working-tree"`にする。nextが存在する場合は、その行を検証してから`to.kind="snapshot"`にする。nextの検証に失敗した場合は、通常の成功差分ではなく`source-unavailable`または`revision-not-found`の明示的状態を返す。

## 7. 次状態の探索と差分生成

Recorderは`record_id`からbeforeを取得し、対象レコードの`repository_id`と、リクエストされた正規化`path`を確定する。

1. `capture_kind='automatic'`かつ`record_id`が対象record、`source_path=path`のbeforeを取得する。
2. `decision_records`とjoinし、同じ`repository_id`・同じ`source_path`・`capture_kind='automatic'`・`capture_sequence > before.sequence`の行を検索する。
3. `capture_sequence ASC`の最初の1件だけをnextとして選ぶ。
4. beforeとnext、またはbeforeと現在作業ツリーを、サイズ制限付きの共通テキスト差分計算へ渡す。

差分計算は既存`GitReader`内のline diffアルゴリズムを無制限に複製しない。任意の二つのテキストを比較できる小さな共通関数へ切り出し、既存の`readPathDiff`も同じ関数を使う。before/afterのmissingフラグにより、空ファイルと存在しないファイルを区別する。

- 内容にNULが含まれる場合は`binary=true`、hunkは空にする。
- UTF-8として読めないGit参照は`source-unavailable`にする。
- サイズまたはdiff work budgetを超えた場合は`PAYLOAD_TOO_LARGE`にする。
- beforeがGit参照なら`base_sha`と`source_path`を検証して既存GitReaderで読む。
- before/nextがファイルバックならSnapshotStoreでファイル境界とハッシュを検証して読む。
- afterが作業ツリーならWorkingTreeReaderで読む。対象消失は`new_missing=true`として差分化し、権限/境界/読み取り障害はエラーにする。

## 8. Review UIの動作

### 8.1 判断選択

現在の`JudgmentPanel`と`DecisionCard`に選択状態を追加する。カードのレイアウトと3ペイン構成は変更しない。

- 選択中の判断には視覚的なselected状態と`aria-pressed`相当の状態を付ける。
- targetリンク、Dispositionボタン、既存のブロックフィルター操作は独立して動作する。
- 選択対象のパスは現在Explorerで開いているパスに限定する。

### 8.2 中央DiffView

判断が選択されたら、現在パスとrecord IDで比較APIを呼ぶ。

- ファイルを開いた直後で判断が未選択の間は、従来のrevision対作業ツリー表示を維持する。
- 選択を解除した場合も、従来の表示へ戻す。

- `snapshot-resolved`なら、中央にbefore→nextまたはbefore→working treeの差分を表示する。
- nextがある場合は、短いsnapshot出自と時刻をヘッダーへ表示する。
- nextがない場合は、afterが現在作業ツリーであることを表示する。
- hunkが空なら、区間に変更がないことを専用の空状態で表示する。
- `source-unavailable`、`revision-not-found`、`PAYLOAD_TOO_LARGE`は既存のinline error表示へ渡す。
- beforeまたはnextが未解決の場合、現在のコードを成功表示しない。

比較差分のbefore側には、選択した判断のtarget行をアンカーする。従来のrevision対作業ツリー表示では、既存のアンカー規則を維持する。

### 8.3 既存レコードとフォールバック

自動撮影がない既存レコードを選択した場合、UIは比較APIの`legacy-fallback`結果に従い、現在のrevision対作業ツリー表示を維持する。これにより、過去データを再撮影せずに既存のレビュー体験を壊さない。

## 9. セキュリティと信頼性

- 新しいmutation APIも127.0.0.1限定、owner bearer token必須、Origin検証対象とする。
- capture_id、record_id、source_pathの組み合わせを検証し、別recordのsnapshot作成や参照を許可しない。
- source_pathは契約層とRecorderの対象検証の二段階で相対パス・symlink境界を確認する。
- Gitコマンドは既存GitReaderの固定引数、hooks/fsmonitor無効化、safe revision検証を使う。
- プラグインはtokenをargvやログへ出さず、既存RecorderBridgeのtoken fileとloopback制約を使う。
- ファイル保存は既存snapshotディレクトリ境界と0600権限を維持する。
- 自動撮影の失敗を隠して編集を続行しない。
- nextの参照が壊れている場合、後続nextや現在作業ツリーへ黙って切り替えない。
- Repository contentsは命令として解釈せず、UIでは既存どおりテキストとして表示する。

## 10. エッジケース

| 状況 | 挙動 |
| --- | --- |
| permitなし | 従来どおり編集拒否。撮影APIは呼ばない |
| Recorder停止/通信失敗 | bounded retry後に編集拒否 |
| 撮影中にファイルが変化 | ハッシュ競合として撮影失敗、編集拒否、permit未消費 |
| 同じフックの再実行 | capture_idで同じsnapshotに収束 |
| 編集ツールが撮影後に失敗 | snapshotは残る。permitは未消費 |
| 編集前に対象が存在しない | `before_missing=true`で保存 |
| 次の状態で対象が削除 | `new_missing=true`の削除差分 |
| 次の自動snapshotが同じ内容 | 空差分を表示 |
| 次のsnapshotが破損 | 後続や作業ツリーへ飛ばさず明示的失敗 |
| 別セッションの次snapshot | 同じrepository/pathなら比較対象にする |
| 手動snapshotのみ | チェーンに含めず、従来の手動選択を維持 |
| 既存recordに自動snapshotなし | 従来のrevision対作業ツリーへfallback |
| Git参照が消滅 | `revision-not-found` |
| ファイルback snapshotが改竄/欠損 | `source-unavailable` |
| binaryまたは不正UTF-8 | binary表示または`source-unavailable` |

## 11. テスト計画

### 11.1 contracts

- automatic/manualのcapture種別検証
- automaticでのsource_path、before_missing必須検証
- before_missingの型と内容制約
- Git参照、legacy手動参照の後方互換
- path traversal、絶対パス、unsupported fieldの拒否

### 11.2 Recorder store/migration

- v3からv4への既存手動/Git行の保持
- automatic行の制約とcapture_id/capture_sequence一意性
- missing状態の保存と読み出し
- 同じcapture_idの同一再送と不一致再送
- 同時作成時の単調なsequence
- 同一repository/pathの全セッション検索と、異なるrepository/pathの分離
- next削除後の再探索

### 11.3 Plugin/bridge

- permit一致後に撮影APIが編集前に呼ばれる
- 撮影成功前は編集が通らない
- Recorder停止、競合、サイズ超過時に編集が拒否される
- bounded retry後もpermitが誤消費されない
- 同じcapture_idのリトライが重複しない
- 編集失敗時にsnapshotは再利用できる
- Claude CodeとOpenCodeが同じ自動撮影契約を使う

### 11.4 HTTP/resolver/diff

- automatic-snapshotの認証、Origin、record/path所有権
- 現在作業ツリーとのハッシュ競合
- snapshot→snapshotの差分
- snapshot→作業ツリーの差分
- 作成・削除・空ファイル・binary
- nextの改竄/欠損を後続へ飛ばさないこと
- legacy-fallback
- `revision-not-found`、`source-unavailable`、`PAYLOAD_TOO_LARGE`

### 11.5 Review UI/E2E

- 判断カードの選択状態
- 選択判断に対応する中央DiffViewの切り替え
- next snapshotの出自表示
- 作業ツリーfallback表示
- no-change、missing、error表示
- 自動snapshotなしの既存判断の回帰
- 判断記録、編集、次の判断、UIでの差分確認のE2E

## 12. 実装順

1. contractsに自動撮影・missing・比較レスポンスの型と検証を追加する。
2. スキーマv4とSnapshotStoreの自動行・冪等性・順序を追加する。
3. boundedな共通テキスト差分関数とsnapshot transition resolverを追加する。
4. 自動撮影APIとRecorderBridgeの撮影メソッドを追加する。
5. Claude Code/OpenCodeのpermit情報取得と編集前撮影を配線する。
6. 比較APIと既存HTTPエラーモデルを配線する。
7. UIの判断選択、比較API呼び出し、DiffView切り替えを追加する。
8. contracts、Recorder、plugins、UI、E2Eの順にテストし、全体回帰を実行する。

各段階は失敗テストを先に追加し、既存のセキュリティ不変条件を回帰確認する。

## 13. 成功条件

- 新しい直接編集は、自動撮影がRecorderに保存されるまで実行されない。
- 自動撮影は同じリポジトリ・同じパスの全セッションで、Recorderの順序により再現可能に連鎖する。
- 選択した判断について、編集前から次の自動撮影、または現在の作業ツリーまでの差分を中央DiffViewで確認できる。
- nextが壊れている場合に現在のコードへ黙って切り替わらない。
- 自動撮影前の既存recordと手動snapshot APIは従来どおり利用できる。
- Explorer・判断一覧・中央DiffViewのUI大枠を維持する。
- 全テストとE2Eが成功する。
