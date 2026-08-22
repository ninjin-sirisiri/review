# Review UI 2ペイン化(VS Code風エクスプローラ+diff / 判断パネル)設計仕様

- 日付: 2026-08-22
- 状態: 設計承認済み
- 上位仕様: [2026-08-20-ai-code-review-evidence-design.md](./2026-08-20-ai-code-review-evidence-design.md)

## 1. 目的

Review UIの主要な操作フローを「判断レコード起点」(タイムラインで判断を選び対象ソースを見る)から「ファイル/差分起点」(VS Codeのようにエクスプローラでファイルを辿り、diff上の行・行の塊を選ぶと、その範囲に対するAIの判断が右ペインに表示される)へ再構成する。

## 2. 要件(確定事項)

1. 左側のdiffは **記録revision vs 現在の作業ツリー** の差分を表示する。
2. エクスプローラは **リポジトリ全体のツリー** を表示し、判断対象があるファイルには件数バッジを付ける。
3. 既存の「Review timeline」(判断一覧リスト)は **廃止** し、ナビゲーションは ツリー → ファイル → diff上の行/塊選択 に一本化する。
4. 既存のセキュリティ境界(Bearer認証、登録ルート外拒否、hash不一致時に現在コードへ黙って付け替えない、トークンのメモリ保持)はすべて維持する。

## 3. アプローチ決定

| 案 | 概要 | 判定 |
|---|---|---|
| **1(採用)** | サーバー側で構造化diffを返す新API2本 + UI再構成 | 要求セマンティクスを正確に実現。既存境界を維持 |
| 2 | バックエンド無変更、既存sourcesのみで再レイアウト | diff・全体ツリーが実現できず不採用 |
| 3 | tree+全diff+判断の一括返却単一エンドポイント | ペイロード肥大・部分失敗扱いが困難でYAGNI違反、不採用 |

`GET /v1/decision-records?repository_id=` は既に完全な `DecisionRecord`(targets[]含む)を返しており、UI側の型が狭めているだけ。判断インデックス構築にバックエンド変更は不要。

## 4. バックエンドAPI

### 4.1 `GET /v1/repositories/:id/files`

エクスプローラ用ファイル一覧。`GitReader.listWorktreePaths()`(private、`ls-files -z`)を公開メソッド `listWorktreeFiles(root)` 化して使用。

```jsonc
// 成功レスポンス data
{ "repository_id": "…", "paths": ["src/api.ts", "src/components/App.tsx"] }
```

- `paths`: ルート相対・POSIX区切り・辞書順ソートのフラット配列。ツリー構造への変換はUI側純関数で行う。
- エラー: 401 UNAUTHORIZED / 404 REPOSITORY_NOT_REGISTERED / 422 SOURCE_UNAVAILABLE。既存 `ERROR_CODES` を流用し新コードは追加しない。

### 4.2 `GET /v1/repositories/:id/diff?path=…&base=<sha|HEAD>`

パス単位のdiff。unifiedテキストではなく **構造化JSON** を返す(`GitReader` 内部の `DiffEntry[]` を活用し、クライアント側パーサーを不要にする)。

```ts
// packages/contracts/src/api.ts に追加する共有型
interface DiffLine { type: "context" | "add" | "del"; oldLine: number | null; newLine: number | null; content: string }
interface DiffHunk { oldStart: number; newStart: number; lines: DiffLine[] }
interface FileDiff {
  path: string;
  base_sha: string;        // 解決済みコミットSHA(base=HEAD時はrev-parse結果)
  hunks: DiffHunk[];
  old_missing: boolean;    // baseコミットに当該ファイルが無い(新規作成)
  new_missing: boolean;    // 作業ツリーから削除済み
  binary: boolean;         // NULバイト検出時 true(hunksは空)
}
```

- 実装: `GitReader` に `readPathDiff(root, sha, relativePath)` を追加。`lineDiff()` とhunkグループ化を既存 `buildTextDiff`(snapshot patch用・挙動維持)と共有する形へリファクタする。削除ファイルは既存 `readDiff` と同様に空文字として扱う。
- パラメータ検証: `path` は `normalizeSourcePath` + `registry.assertTarget(repositoryId, path)` 相当(canonicalizeTarget・rejectNestedRepository経由)。`base` はリテラル `HEAD` または `isSafeRevision` 合格のSHA。省略時は `HEAD`。
- HEAD解決: サーバー側で `git rev-parse HEAD` を実行しSHAへ正規化。コミットが一つもない場合は `REVISION_NOT_FOUND`。
- エラー: 401 / 404 REPOSITORY_NOT_REGISTERED・REVISION_NOT_FOUND / 422 PATH_OUTSIDE_ROOT・SOURCE_UNAVAILABLE / 413 PAYLOAD_TOO_LARGE(作業ツリーファイルが `readBounded` 上限超過時)。

### 4.3 diff base の決定ルール(UI側)

1. 当該ファイルに commit revision の判断がある → **そのうち created_at が最大の判断レコードのcommit revision** をbaseにする。
2. 無い場合 → `HEAD`(未コミット変更確認というVS Code的な用途)。
3. リポジトリにコミットが無い → DiffViewにdiff不可の空状態を表示。

## 5. 行↔判断アンカーのセマンティクス

判断対象の行アンカーはrevision種別とhash検証状態で決める:

| target種別 | 条件 | アンカー先 |
|---|---|---|
| commit revision | 常時(SHAが内容を固定するため追加検証不要) | diffの **旧側** 行番号 |
| working-tree revision | 該当レコード詳細取得後、対応するsource(state配列はtargets順に並行)が `resolved` / `snapshot-resolved` | diffの **新側** 行番号 |
| working-tree revision | `hash-mismatch` / `revision-not-found` / `source-unavailable` | **アンカーしない**。カードに警告表示のみ |

「現在のコードへ黙って付け替えない」上位仕様§9を維持する。ハイライト(ガーターマーカー+薄いティント)は検証済みアンカーにのみ付ける。

ファイル選択時、UIはそのファイルに関する全判断の `getDecision()` を並列取得し、sources状態をアンカー判定に使う(併せて右ペインのカードデータにもなる)。sources配列とtargets配列はサーバーが同一順序で生成する(`resolveRecordSources` はtargetsを順に解決する)ため、index対応で紐付ける。

## 6. UI構成

```
┌────────────────────────────────────────────────────────────────────┐
│ Header: Repository <root>                          [Clear session] │
├──────────────┬─────────────────────────────────┬───────────────────┤
│ Explorer     │ DiffView                        │ JudgmentPanel     │
│ 220–300px    │ 可変幅                          │ 340–420px         │
└──────────────┴─────────────────────────────────┴───────────────────┘
```

### 6.1 ファイル構成

```
apps/review-ui/src/
├── App.tsx                  … 状態機械(bootstrap→workspace)+取得オーケストレーション
├── api.ts                   … +listRepositoryFiles() / +getFileDiff()、Summary型にtargets追加
├── lib/
│   ├── file-tree.ts         … パス配列→ネストツリー(純関数)
│   ├── decision-index.ts    … パス別判断グループ化+行範囲オーバーラップ判定(純関数)
│   └── (*.test.ts)
└── components/
    ├── BootstrapScreen.tsx  … 既存のトークン入力画面を抽出
    ├── Workspace.tsx        … 3カラム配置+選択状態保持
    ├── Explorer.tsx         … 折りたたみツリー+判断件数バッジ
    ├── DiffView.tsx         … hunk描画/行アンカー表示/ブロック選択/全文モード
    ├── JudgmentPanel.tsx    … 判断カード列(選択行でフィルタ)
    └── DecisionCard.tsx     … DecisionDetailを再構成(disposition・checks・open questions・
                                hash不一致警告[SourceReferenceの警告部を吸収])
```

削除: `components/DecisionList.tsx`、`components/SourceReference.tsx`、`components/DecisionDetail.tsx`(DecisionCardへ再構成)。更新: `App.test.tsx` および各コンポーネントテスト、`styles.css`。

### 6.2 インタラクション仕様

1. **ファイル選択**: Explorerクリック → `getFileDiff()` と該当 `getDecision()` 群を並列取得。右ペインにそのファイルの判断カード全表示(created_at降順)。Explorerのツリーは `listRepositoryFiles()` ∪ 判断索引パス(作業ツリーから削除された判断対象も辿れるように)。
2. **判断箇所の可視化**: 検証済みアンカー行にガーターマーカー+ティント。未検証行には付けない。
3. **行(塊)選択**: hunk内の連続するadd/delブロック(maximal run)をクリック → ブロックハイライト+右ペインをオーバーラップ判断に絞り込み。同一ブロック再クリックかcontext行クリックで解除(ファイル全体の判断に戻る)。
   - 選択ブロックの範囲は `{oldStart?, oldEnd?, newStart?, newEnd?}`(nullの辺は範囲なし)。
   - 絞り込み述語: 旧側アンカーは旧範囲と、新側アンカーは新範囲とそれぞれ重なり判定(純addブロックに旧側アンカーは合致しない等、辺ごとに厳密判定)。
4. **逆方向ナビゲーション**: カードヘッダーの `path:lines` クリック → DiffViewが最初のアンカー行へスクロール+パルス表示。
5. **disposition**: カード毎のAccept/Reject/Unreviewed。既存PATCH `/v1/decision-records/:id/disposition` フローと楽順更新を流用。
6. **diff空の場合**(hunks.length===0 && !binary): 検証済みsourceを持つ判断があれば `sources.content` を使う全文コンテキスト表示モード(旧=新の同一内容、対象行ハイライト付き)。判断が無い/未解決なら「差分なし」空状態。
7. **バイナリ**: `binary:true` のとき「バイナリファイルは差分表示非対応」を表示。
8. **レスポンシブ/アクセシビリティ**: <850pxで縦積み、Explorer折りたたみ。`aria-current` / `role="alert"` / `aria-live` 等の既存パターン維持。ブロック・ツリー項目はbuttonとしてフォーカス可能。

### 6.3 データフロー

```
token入力 → listRepositories → リポジトリ選択 → listDecisions(完全レコード)
  ├→ decision-index.ts: パス別索引+バッジ集計(導出値のためstate保存しない)
  ├→ listRepositoryFiles ∪ 索引パス → file-tree.ts → Explorer
  └→ ファイル選択毎: getFileDiff(path, §4.3ルール) + 該当getDecision並列
       → §5のアンカー検証 → DiffView / JudgmentPanel
```

キャッシュ層(TanStack Query等)は導入しない(YAGNI)。ファイルを開く度に新鮮なdiff+hash検証を取得する健全性モデルを維持。

## 7. エラー処理

| 発生箇所 | 挙動 |
|---|---|
| Explorer(files取得失敗) | Explorerペイン内にエラー+再試行ボタン。他ペインは空状態 |
| DiffView(REVISION_NOT_FOUND) | 「記録revisionが見つからない」カード(コミット消失/初コミット前含む) |
| DiffView(PAYLOAD_TOO_LARGE) | 「ソースがサイズ上限を超過」カード |
| DiffView(その他) | コード別メッセージ+再試行。JudgmentPanelは独立データのため動作継続 |
| 判断カード(getDecision失敗) | カード単位のinline error+再試行。他カードは影響なし |
| disposition更新失敗 | カード内 `role="alert"` 表示(現行どおり) |

エラーメッセージは既存UIの英語コピーに整合させ、トークンやコード本文を含めない。

## 8. セキュリティ(既存境界の維持)

- 新エンドポイントは既存 `handleRequest` フロー内に実装し、Bearer認証を迂回路なく適用。
- GET専用のためOrigin検証(mutation限定の現行ルール)は変更しない。
- パス検証・サイズ上限(`readBounded(maxBytes)`)・XSS対策(Reactテキストノードのみ、`dangerouslySetInnerHTML`不使用)・トークンのメモリ保持はすべて現行維持。
- hash不一致targetのdiffアンカー禁止(§5)により「黙って付け替えない」を維持。
- `files` の新規露出は登録済みリポジトリのトラック済みパス名のみ。既存ソース読み取りと同信頼レベルで新たな露出クラスではない。

## 9. テスト計画(TDD)

**バックエンド(bun test)** — `apps/recorder/test/`
- `http.test.ts`: files(401/404不明リポジトリ/ソート済み一覧)、diff(正常系のtype別行とoldLine/newLine正確性/base=HEAD解決/old_missing/new_missing/binary/PAYLOAD_TOO_LARGE 413/PATH_OUTSIDE_ROOT 422/不正revision 404/401)
- `source-resolution.test.ts` 拡張: 一時gitリポジトリでの `readPathDiff` 構造化出力
- 既存テストはすべてグリーン維持

**フロントエンド(vitest)** — `apps/review-ui/src/`
- `lib/file-tree.test.ts`: フラット→ネスト・ソート・判断のみパスの結合
- `lib/decision-index.test.ts`: グループ化・旧/新側オーバーラップ・未検証除外
- コンポーネント: Explorer(バッジ/展開)、DiffView(hunk描画/ブロック選択/検証済みのみマーカー/全文モード)、JudgmentPanel(絞り込み/disposition連携)、DecisionCard(disposition/不一致警告)、BootstrapScreen・Workspace(遷移)
- `App.test.tsx`: bootstrap→workspace遷移、ファイル選択時の並列取得

**E2E(Playwright)** — `tests/e2e/review-flow.spec.ts` を新ナビゲーションへ書き換え
- token→repo→ツリーでファイル選択→判断カード表示→ブロック選択で絞り込み→Accept→API検証
- 改ざんケース: ファイル変更→reload→警告カード表示・改ざん後コード非表示・localStorage/URLトークン検証は現行のまま維持

カバレッジ: 新規モジュール80%以上。

## 10. 実装順序

1. contracts: `DiffLine`/`DiffHunk`/`FileDiff` 型追加
2. GitReader: `listWorktreeFiles` 公開化・`readPathDiff` 追加(RED→GREEN)
3. routes: `/files`・`/diff`(RED→GREEN)
4. UI lib純関数(RED→GREEN)
5. api.ts クライアント拡張
6. コンポーネント下位から: DecisionCard → JudgmentPanel → DiffView → Explorer → Workspace → BootstrapScreen抽出
7. App配線・styles
8. E2E書き換え・全テストグリーン・カバレッジ確認

## 11. スコープ外(明示的にやらないこと)

- Explorer内の検索・フィルタボックス
- 巨大diffの仮想スクロール最適化
- snapshot patchモードの表示切替
- クライアントキャッシュ・自動リフレッシュ
- i18n(UIコピーは既存どおり英語)
