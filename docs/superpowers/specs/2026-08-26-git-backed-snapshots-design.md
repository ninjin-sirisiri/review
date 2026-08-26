# Gitバック参照スナップショット設計

- 日付: 2026-08-26
- ステータス: 承認済み(設計対話によりQ1〜Q3を決定済み)
- 関連: `docs/superpowers/specs/2026-08-22-review-ui-two-pane-design.md`(diff表示・アンカー)、`docs/superpowers/plans/2026-08-20-ai-code-review-evidence.md`(snapshot基盤)

## 1. 背景と目的

判断レコードはコード本体を保存しない(参照のみ)。編集前の内容はゲート運用では作業木から消え、コミット後に「履歴のどこにも存在しない」状態になりうる。明示的スナップショット(`POST /v1/decision-records/:id/snapshot`)が唯一の退避手段だが、現行実装は**生テキストを無圧縮・重複ありで1ファイル保存**する(`apps/recorder/src/store/snapshots.ts` の `create()`)。

典型ケースとして、ゲート時の編集前状態は作業木がきれいなら `HEAD:<path>` のblobとバイト一致する。この内容を本体保存せず `{sha, path}` 参照のみにできれば、主要ユースケースのストレージコストがゼロになる。

**目的**: 明示的snapshot保存を透過的に最適化し、提出内容がレコードtargets内いずれかのパスの `HEAD` blobと一致する場合、参照のみを保存する。

## 2. 決定事項(設計対話の結果)

| 問い | 決定 |
| --- | --- |
| Q1 最適化の方式 | **透過的**。API外形・呼び出し規約は不変。サーバーが保存時に判定する。「explicit-only」不変律は維持される(作成は明示リクエスト時のみ、保存形式だけが最適化される) |
| Q2 判定対象リビジョン | **HEADのみ**。作成時に一度 `rev-parse HEAD` で具体SHA化して照合。履歴全体検索はコストに見合わない(探すものは主に未コミット中間状態であり、gitオブジェクトDBに存在しないため) |
| Q3 v1スコープ | **Recorder完結**(contracts + recorder)。プラグイン自動撮影配線・CAS/圧縮・GC・コミット選択diffビューは将来パス |

## 3. ゴール / 非ゴール

**ゴール**
- HEAD一致のsnapshotがディスク容量ゼロで保存され、UI上は従来の `snapshot-resolved` と同じく全文表示できる。
- 不一致・unborn HEAD・git障害時は従来どおり実blob保存または明示的失敗状態となり、現状より悪化しない。
- 既存クライアント(アダプタ/UI)は無変更で動作し続ける。

**非ゴール(v1でやらない)**
- プラグインからの自動撮影(いつ撮るかのポリシーは別設計)
- 実blobのコンテンツアドレス型ストア化・圧縮
- snapshot自動GC・保持ポリシー
- コミット選択による履歴diff閲覧

## 4. 契約変更(packages/contracts)

### 4.1 型(records.ts)

```ts
export type SnapshotMode = "changed-files" | "patch" | "git";

export interface SnapshotReference {
  snapshot_id: string;
  record_id: string;
  mode: SnapshotMode;
  /** ストレージ内パス。gitモードでは ""(ファイルを作らない)。 */
  path: string;
  content_hash: string;
  created_at: string;
  /** gitモード必須: 参照先コミットの具体SHA(作成時に解決済みの不変値)。 */
  base_sha?: string;
  /** gitモード必須: 登録リポジトリルート相対の対象パス。 */
  source_path?: string;
}
```

### 4.2 検証(validation.ts / validateSnapshotReference)

- 許可キー一覧に `base_sha`, `source_path` を追加。
- `mode === "git"`:
  - `base_sha` 必須。`/^[0-9a-f]{40}$/`(SHA-1コミットSHA)。
  - `source_path` 必須。既存 `normalizeRelativePath` を流用(絶対パス・`..`・空文字を拒否)。
  - `path` は空文字 `""` であること(既存のnonEmptyString検証はgitモードでは適用しない)。
- `mode !== "git"`: `base_sha`, `source_path` が存在してはならない(未定義のみ許容)。曖昧さを排する。
- `content_hash`: 従来どおりSHA-256 hex(最大128文字)。gitモードでは**提出内容全体**のハッシュを保持する(復元時の改竄検証に使う)。

## 5. スキーマ移行(apps/recorder/src/store/schema.ts)

**問題**: 現行 `snapshots.path TEXT NOT NULL UNIQUE` ではgit参照行の `path=""` が2行目以降で衝突する。また `mode` のCHECK制約に `'git'` がない。SQLiteはCHECK/UNIQUEをインプレース変更できないため、**マイグレーションv3でテーブル再build**を行う(v2のsessions/decision_records再buildパターンを踏襲)。

```sql
CREATE TABLE snapshots_rebuilt (
  snapshot_id TEXT PRIMARY KEY,
  record_id TEXT NOT NULL REFERENCES decision_records(record_id) ON DELETE CASCADE,
  mode TEXT NOT NULL CHECK (mode IN ('changed-files', 'patch', 'git')),
  path TEXT NOT NULL,
  content_hash TEXT NOT NULL,
  created_at TEXT NOT NULL,
  base_sha TEXT,
  source_path TEXT,
  CHECK (mode = 'git' OR (base_sha IS NULL AND source_path IS NULL)),
  CHECK (mode <> 'git' OR (base_sha IS NOT NULL AND source_path IS NOT NULL AND path = '')),
  CHECK (base_sha IS NULL OR (length(base_sha) = 40 AND base_sha NOT GLOB '*[^0-9a-f]*'))
);
CREATE UNIQUE INDEX snapshots_storage_path_unique ON snapshots(path) WHERE path <> '';
INSERT INTO snapshots_rebuilt (snapshot_id, record_id, mode, path, content_hash, created_at, base_sha, source_path)
  SELECT snapshot_id, record_id, mode, path, content_hash, created_at, base_sha, source_path FROM snapshots;
DROP TABLE snapshots; ALTER TABLE snapshots_rebuilt RENAME TO snapshots;
PRAGMA foreign_key_check;
```

- `SCHEMA_VERSION` を 2 → 3 に更新。
- ファイルバック行のストレージパス一意性は部分UNIQUEインデックスで維持(git行の `path=""` は対象外)。
- 移行は冪等かつトランザクション内(`withoutForeignKeys: true`)。

## 6. ストア変更(apps/recorder/src/store/snapshots.ts)

SnapshotStoreはgit非依存を保つ(検出ロジックは置かない)。

- `create(recordId, mode, content)`: 変更なし(ファイルバック専用)。`mode==="git"` が渡されたら `PersistenceError(INVALID_RECORD)`。
- `createGitBacked(recordId, baseSha, sourcePath, contentHash)`: 新設。`recordId` の存在チェックを `create()` と同様に行った上で、ファイル書き込みなしでDB行のみ挿入(`path=""`)。`validateSnapshotReference` による契約検証を通す。
- `getReference(snapshotId)`: 新設。行を読み契約検証した `SnapshotReference` のみ返す(ディスクアクセスなし)。行なし/検証失敗は `null`。
- `get(snapshotId)`: ファイルバック専用のまま。`mode==="git"` 行に対しては `null` を返す(誤用防止。resolverはgetReference経由で分岐する)。
- `delete(snapshotId)`: `getReference` でmodeを確認し、git行はunlinkせずDB削除のみ(現行の `resolveStoredPath("")` 例外経路を踏まない)。

## 7. 検出フロー(HTTPハンドラ / apps/recorder/src/http/server.ts)

POST `/v1/decision-records/:recordId/snapshot` ハンドラ(server.ts:492)内:

1. 従来どおり `mode`(`changed-files` | `patch`)と `content` を検証。
2. **検出ヘルパー** `detectGitBackable(deps, record, contentHash)` を呼ぶ(新ファイル `apps/recorder/src/source/gitbacked.ts`):
   - `registry.get(record.repository_id)` でroot取得(未登録/unavailable ⇒ `null`)。
   - `git.resolveRevision(root, "HEAD")` で具体SHA化(unborn HEAD 等 `REVISION_NOT_FOUND`/`SOURCE_UNAVAILABLE` ⇒ `null`)。
   - `record.targets` の順に各 `path` について `git.readCommitFile(root, headSha, path)`(既存サイズ上限内)→ SHA-256比較。**最初に一致したパス**で `{baseSha: headSha, sourcePath: path}` を返す。全不一致 ⇒ `null`。個別パス読み取り失敗は無視して次へ。
3. ヒット ⇒ `store.createGitBacked(...)`。ミス ⇒ 従来どおり `service.createSnapshot(...)`。
4. レスポンスは両者とも `201` + `SnapshotReference` JSON(フィールド追加のみでエンベロープ同一)。

注: 提交内容とworktree現在値は比較しない(比較対象はHEAD blobのみ)。worktreeが既に進んでいても、提出内容==HEAD内容なら参照化される。

## 8. 解決フロー(apps/recorder/src/source/resolve.ts)

- `SourceResolver.resolveSnapshot` を分岐:
  - `store.getReference(snapshotId)` でreference取得(null ⇒ 改竄・欠損扱いのunavailable。現行挙動を維持)。
  - `reference.record_id !== target.record_id` は呼び出し側(`resolveRecordSources` の所有チェック、server.ts:251-253をgetReferenceベースへ変更)で担保。
  - **gitモード**: `registry.get(target.repository_id)` → root取得(不可 ⇒ `source-unavailable`);`git.readCommitFile(root, base_sha, source_path)`;
    - `REVISION_NOT_FOUND`(rebase/filter-branch/GC等でSHAが消えた)⇒ `revision-not-found`。
    - その他の失敗 ⇒ `source-unavailable`。
    - 成功 ⇒ SHA-256(内容)と `reference.content_hash` を比較。不一致 ⇒ `source-unavailable`(「snapshot is unavailable or has been tampered with」)。一致 ⇒ `snapshot-resolved`(content, contentHash, snapshot付き)。
  - **ファイルバック**: 現行の `store.get()` 経路を維持。
- `serializeSource`(server.ts:210)は `resolved.snapshot` をそのまま展開するため、`base_sha` / `source_path` は追加フィールドとして自動的にAPIに出る。変更不要。

## 9. Review UI(apps/review-ui)

- **必須変更なし**: git参照ソースは `state: "snapshot-resolved"` として到達し、fullTextフォールバック(App.tsx:203-210)と新側アンカー(decision-index.ts `targetAnchor`)は既存ロジックがそのまま機能する。
- **小変更**: 判断詳細ペインに出自バッジ `@<sha8>` を表示(`source.snapshot.base_sha` が存在するときのみ)。既存テストフィクスチャへの影響は最小。

## 10. セキュリティ不変律の維持

- 新エンドポイントなし。認証(bearer)/Origin検証/loopback束縛は無触。
- Git操作は読み取り専用の既存 `GitReader` 経由のみ(hooks/fsmonitor無効化・サイズ上限・safe revision検証を継承)。
- `base_sha` は40桁hex、`source_path` は相対安全パス検証を契約層で実施し、読み取り時も `readCommitFile` の `isSafeRevision` / パス検証が二重に働く。
- 実ファイルは従来どおりdataDir配下限定(git参照行はファイルを持たないため攻撃面はむしろ減る)。
- サイズ上限: 提出content(`maxSnapshotContentLength`)・git読み取り(`maxSourceContentLength`)とも継承。
- 黙った代替を行わない: 参照がdanglingになった場合は明示的な失敗状態を返す(「changedな現在コードへ黙って再接合しない」不変律と整合)。

## 11. エッジケース一覧

| 状況 | 挙動 |
| --- | --- |
| unborn HEAD(コミットゼロのリポジトリ) | 検出不成立 ⇒ 実blob保存 |
| targets内どのパスともHEAD内容が不一致(dirty作業木由来の中間状態など) | 実blob保存 |
| 複数targetが同内容で一致 | targets順の最初を採用(決定的) |
| 対象パスがHEADツリーに存在しない(新ファイル) | 読み取り失敗を無視し次の候補へ |
| 作成後、rebase等でbase_shaが消滅 | 解決時 `revision-not-found`(明示的失敗) |
| base_shaの指す内容が改変された | ハッシュ不一致 ⇒ `source-unavailable` |
| 同一レコードに複数snapshot(混在モード) | 可。所有チェックはrecord_id単位で従来どおり |
| 旧DB(バージョン0〜2)からの起動 | マイグレーションv3が自動適用され、既存行はそのまま |

## 12. テスト計画

- **contracts**(packages/contracts/test): validateSnapshotReferenceの行列追加(git必須/形式/path=""強制/非gitでの新フィールド禁止/40桁hex/相対パス違反)。
- **store**(apps/recorder/test): v2→v3マイグレーション(既存行保持・制約適用)、createGitBacked(行挿入・ファイル不在)、get/getReference/deleteのモード別分岐、`path=""` 複数行許容と実パスの一意性維持。
- **resolver**: git参照の解決成功/SHA消滅(revision-not-found)/改竄(unavailable)/root不在。ファイルバック回帰。
- **HTTP**(apps/recorder/test): 検出ヒット(参照保存・201・レスポンス互換)/ミス(実blob保存)/unborn HEAD/認証・Origin回帰。GET sourceで `snapshot:` 選択時にcontentが返ること。
- **UI**(vitest): バッジ表示(あれば表示・なければ非表示)。fullTextフォールバックが `snapshot-resolved` で効く既存テストの維持。
- **E2E**: 既存specの回帰のみ。

## 13. 実装順の目安(writing-plansへ引き継ぎ)

1. contracts(型+検証)→ 2. schema v3 → 3. SnapshotStore(createGitBacked/getReference/delete分岐)→ 4. 検出ヘルパー+HTTP配線 → 5. resolver分岐 → 6. UIバッジ → 7. 全テスト+E2E回帰。

各ステップはTDD(先行する失敗テスト)で進める。
