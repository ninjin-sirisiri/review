# Review UI ビジュアル刷新(トークン基盤・ライト/ダークテーマ)設計仕様

- 日付: 2026-08-26
- 状態: 設計承認済み
- 上位仕様: [2026-08-22-review-ui-two-pane-design.md](./2026-08-22-review-ui-two-pane-design.md)

## 1. 目的

Review UI全体をデザイントークン基盤で再構築し、ライト/ダーク両テーマ(OS設定自動追従+手動切替)に対応させる。併せて無スタイルだったDecisionCard等の埋め込み、diff可読性向上、IDE風内部スクロールレイアウトへの移行を行い、開発者ツールとしての視覚的完成度を上げる。

## 2. 要件(確定事項)

1. **素のCSS + カスタムプロパティ**で実装する。CSSフレームワーク(Tailwind等)は導入しない。
2. コンポーネントCSSから生のhexを排除し、**セマンティックトークンのみ**を参照する。
3. テーマは **auto / light / dark の3値**。初期値はauto(OSの`prefers-color-scheme`追従)。手動選択はlocalStorageに永続化し、auto復帰で削除する。
4. フォントは **IBM Plex Sans**(UI)+ **JetBrains Mono**(コード)。ローカルファーストのためランタイムCDN参照は禁止とし、`@fontsource` パッケージでビルド時にバンドルする(新規npm依存はこの2件のみ)。
5. 既存のセキュリティ境界(Bearer認証、トークンのメモリ保持、UIがコードを評価しない等)は一切変更しない。本変更はUI表示層のみに留まる。
6. 既存コンポーネントのBEMクラス名は原則維持し、既存テストを壊さない。

## 3. アプローチ決定

| 案 | 概要 | 判定 |
|---|---|---|
| **1(採用)** | セマンティックトークンによる完全刷新+両テーマ対応 | 「大きな刷新」の要望に合致。以後のUI変更はトークン1箇所の修正で完結 |
| 2 | 既存ダークパレットの変数化+ライト版追加のみ | 見た目がほぼ変わらず刷新感がないため不採用 |

## 4. デザイントークン体系

### 4.1 ファイル構成

単一 `styles.css`(約250行)を分割する。エントリは `App.tsx` の `import "./styles.css"` を維持し、styles.cssから残りを `@import` する。

```
apps/review-ui/src/styles/
  tokens.css      # ダーク/ライト両パレットのトークン定義
  base.css        # リセット・タイポグラフィ・フォーカスリング・共通ユーティリティ
  components.css  # 全コンポーネントスタイル
```

### 4.2 トークン一覧

| カテゴリ | トークン | 用途 |
|---|---|---|
| サーフェス | `--surface-base` | アプリ背景 |
| | `--surface-panel` | パネル・カード面 |
| | `--surface-raised` | hover・選択行 |
| | `--surface-inset` | コード領域(diff全文など) |
| テキスト | `--text-primary` / `--text-secondary` / `--text-muted` | 階層的な文字色 |
| ボーダー | `--border-subtle` / `--border-strong` | 面の枠・区切り |
| アクセント | `--accent` / `--accent-soft` / `--on-accent` | 選択状態・バッジ・プライマリボタン |
| ステータス | `--status-success` / `-warning` / `-danger` と各 `-soft` | disposition・check結果・警告 |
| Diff | `--diff-add-bg` / `--diff-add-text` / `--diff-del-bg` / `--diff-del-text` | 差分行 |
| アンカー | `--diff-anchor` / `--diff-anchor-soft` | 判断対象行の強調 |
| フォーカス | `--focus-ring` | `:focus-visible` 輪郭 |
| その他 | `--font-sans` / `--font-mono`、`--space-*`(4px刻み)、`--radius-sm/md/lg` | タイポ・スペーシング・角丸 |

### 4.3 パレット(GitHub Primer準拠の実績あるペア)

**ダーク**(`data-theme="dark"`、`:root`デフォルト):

| トークン | 値 |
|---|---|
| `--surface-base` | `#0f172a` |
| `--surface-panel` | `#1e293b` |
| `--surface-raised` | `#273449` |
| `--surface-inset` | `#0b1222` |
| `--text-primary` | `#f1f5f9` |
| `--text-secondary` | `#cbd5e1` |
| `--text-muted` | `#94a3b8` |
| `--border-subtle` | `rgb(148 163 184 / 16%)` |
| `--border-strong` | `rgb(148 163 184 / 32%)` |
| `--accent` / `--accent-soft` / `--on-accent` | `#76b7ff` / `rgb(118 183 255 / 16%)` / `#0b1222` |
| `--status-success` / `-soft` | `#4ade80` / `rgb(74 222 128 / 14%)` |
| `--status-warning` / `-soft` | `#fbbf24` / `rgb(251 191 36 / 15%)` |
| `--status-danger` / `-soft` | `#f87171` / `rgb(248 113 113 / 14%)` |
| `--diff-add-text` / `-bg` | `#7ee787` / `rgb(46 160 67 / 15%)` |
| `--diff-del-text` / `-bg` | `#ffa198` / `rgb(248 81 73 / 15%)` |
| `--diff-anchor` / `-soft` | `#d29922` / `rgb(210 153 34 / 16%)` |
| `--focus-ring` | `#76b7ff` |

**ライト**(`data-theme="light"`):

| トークン | 値 |
|---|---|
| `--surface-base` | `#f8fafc` |
| `--surface-panel` | `#ffffff` |
| `--surface-raised` | `#f1f5f9` |
| `--surface-inset` | `#f6f8fa` |
| `--text-primary` | `#0f172a` |
| `--text-secondary` | `#334155` |
| `--text-muted` | `#64748b` |
| `--border-subtle` | `rgb(15 23 42 / 12%)` |
| `--border-strong` | `rgb(15 23 42 / 24%)` |
| `--accent` / `--accent-soft` / `--on-accent` | `#0969da` / `rgb(9 105 218 / 10%)` / `#ffffff` |
| `--status-success` / `-soft` | `#1a7f37` / `rgb(26 127 55 / 12%)` |
| `--status-warning` / `-soft` | `#9a6700` / `rgb(154 103 0 / 12%)` |
| `--status-danger` / `-soft` | `#cf222e` / `rgb(207 34 46 / 10%)` |
| `--diff-add-text` / `-bg` | `#1a7f37` / `rgb(26 127 55 / 10%)` |
| `--diff-del-text` / `-bg` | `#cf222e` / `rgb(207 34 46 / 8%)` |
| `--diff-anchor` / `-soft` | `#9a6700` / `rgb(154 103 0 / 14%)` |
| `--focus-ring` | `#0969da` |

コントラスト方針: 本文相当の文字(`--text-*`)は全サーフェス上で4.5:1以上。ステータス色は文字色としてソフト背景上で4.5:1以上を確保する(上記はPrimerの検証済みペア)。実装時に目視確認する。

### 4.4 タイポグラフィ

```css
--font-sans: "IBM Plex Sans", ui-sans-serif, system-ui, sans-serif;
--font-mono: "JetBrains Mono Variable", ui-monospace, SFMono-Regular, Menlo, monospace;
```

- 依存: `@fontsource/ibm-plex-sans`(400/500/600)+ `@fontsource-variable/jetbrains-mono`
- ベースサイズ16px・行高1.5を維持。コード領域は0.82rem前後の現行密度を踏襲しつつJetBrains Monoへ統一

## 5. テーマ切替機構

### 5.1 状態モデルと永続化

- 設定値: `"auto" | "light" | "dark"`。localStorageキーは `review-ui-theme`
- 実効テーマ(resolved): autoの場合は `matchMedia("(prefers-color-scheme)")` の結果。light/dark選択時はその値
- `<html data-theme="dark|light">` 属性でCSS側へ伝達。tokens.cssは `:root`(ダーク)と `:root[data-theme="light"]`(ライト)で変数を定義する
- matchMedia非対応環境(jsdom等)ではauto=ダークとして扱い、変更リスナーは登録しない
- localStorageアクセスはtry/catchで保護し、失敗時はautoとして動作(例外を表面化させない)

### 5.2 FOUC対策

`index.html` の `<head>` 内にインラインスクリプトを置き、React起動前に `data-theme` を確定する。優先順位: localStorageの明示指定 → `prefers-color-scheme` → ダーク(既定)。localStorage読み取りはtry/catch内で行う。

### 5.3 useThemeフック

新規 `src/lib/useTheme.ts`:

- 戻り値 `{ resolvedTheme: "light" | "dark", setTheme(next: ThemeSetting): void }`
- 初回マウント時にlocalStorageとmatchMediaから状態を復元
- autoモード中は `prefers-color-scheme` のchangeイベントを購読し、resolvedを追従更新(手動モード中は購読しない)
- `setTheme` は属性・DOM・localStorageを更新する。SSRは考慮しない(Vite SPA)

### 5.4 ThemeToggleコンポーネント

新規 `src/components/ThemeToggle.tsx`:

- クリックで auto → light → dark → auto と循環
- 実効テーマに応じたインラインSVGアイコン(auto=半々/light=太陽/dark=月)+ 現在モードのテキストラベル("System (dark)" 等)。アイコン単独では状態を伝えられないため必ずラベルを併記する
- `aria-label="Color scheme"` を付与
- アプリヘッダーとBootstrapScreenの両方に配置する(接続前でもテーマを選べる)。BootstrapScreenでは接続カード外の右上に絶対配置する

## 6. コンポーネント適用

### 6.1 レイアウト基盤

- `.app-shell` を `height: 100vh` の縦flexに変更。ヘッダーは固定バー、`.workspace` が残り高さを占有し、**3パネルがそれぞれ独立スクロール**するIDE風レイアウトへ
- 幅850px以下は従来どおり単カラム積み重ね+ページスクロールへフォールバック(fixed heightを解除)

### 6.2 アプリヘッダー

現在の大きな見出し(最大2.8rem)を1行のアプリバーへ圧縮。左端にツール名+リポジトリパス、右端にThemeToggle + Clear sessionボタン。

### 6.3 Explorer

- パネルを `--surface-panel` 面+`--border-subtle` 枠+角丸のカードに
- 折りたたみシェブロン(テキスト `▸▾`)をインラインSVG化(クラス名 `.explorer__chevron` は維持)
- 行hoverで `--surface-raised`、選択ファイルは `--accent-soft` 面+`--accent` 文字
- バッジは `--accent-soft` 背景+`--accent` 文字でコントラスト確保

### 6.4 DiffView

- コード領域は `--surface-inset` 面+`--font-mono`
- add/del行: 文字色に加えて背景ティント(`--diff-add-bg` / `--diff-del-bg`)
- アンカー行: `--diff-anchor` 左罫+`--diff-anchor-soft` 面。選択ブロック: `--accent` 枠+`--accent-soft` 面
- 逆ナビゲーションのパルスアニメーションは `@media (prefers-reduced-motion: reduce)` で無効化

### 6.5 JudgmentPanel / DecisionCard

DecisionCardは現状CSS規則が存在しないため**新規にスタイルを作成する**(マークアップのクラス名 `.decision-card*` `.target-link` 等は既に存在):

- カード: `--surface-panel` 面+ボーダー+角丸。判断タイトル(h3)→ メタ情報(agent·日時·revision)→ rationale → Checks → Open questions → Targets の視覚階層
- Dispositionボタン群をセグメントコントロール風に。aria-pressed=true時にAccept=`--status-success`、Reject=`--status-danger`、unreviewed=ニュートラル。状態はテキストラベルでも判別可能にし、色だけに依存しない
- `source-warning` / `check-status--passed|failed|not-run` をステータストークンで両テーマ対応
- JudgmentPanelの空状態・フィルタ状態も `--text-muted` で整える

### 6.6 BootstrapScreen

中央カードの余白・入力欄・select要素(現状無スタイル)を整備。送信ボタンをプライマリ(`--accent` 背景+`--on-accent` 文字)に。

### 6.7 アクセシビリティ

- 全インタラクション要素で `:focus-visible` に `--focus-ring` の輪郭(現行の3px方式を踏襲)
- ボタンは44px相当のクリック領域を意識したパディング
- 状態表現は色+テキスト/アイコンの二重化(色単独に依存しない)
- アイコンは全てインラインSVG(絵文字禁止)。アイコンライブラリは導入しない

## 7. エラー処理

- localStorage読み書き失敗(プライベートモード等): try/catchで握り、auto挙動にフォールバック。UIにエラーを出さない
- matchMedia未定義環境(jsdom等): auto=ダーク固定、リスナーなし
- API・Recorder側は一切変更しないため新規エラー経路はない

## 8. テスト方針

1. **既存テストの維持**: BEMクラス名を原則維持するため既存vitest/E2Eはそのまま通る。壊れた場合は最小修正
2. **`test-setup.ts` に `matchMedia` モックを追加**(useTheme導入によりApp配下全テストが影響を受ける)
3. **新規unit test**: `useTheme`(循環・永続化・OS設定追従)、`ThemeToggle`(ラベル・アイコンの状態反映)
4. **E2E拡張**(`tests/e2e/review-flow.spec.ts`): 切替操作で `<html>` の `data-theme` が変わること、リロード後も保持されること。FOUCスクリプトはこの経路で検証
5. **完了判定**: `bun run test`(ルートでbare `bun test` は禁止)、`bun run --cwd apps/review-ui build`、`bun run e2e`

スナップショットテスト・ビジュアルリグレッッション専用ツールは導入しない(YAGNI)。

## 9. スコープ外(YAGNI)

- CSSフレームワーク・UIコンポーネントライブラリの導入
- フォント以外の新規npm依存
- Recorder / contracts / plugins への変更(API・型は不変)
- レスポンシブの再設計(既存850px/600pxブレークポイントの考え方を踏襲)
- テーマの細かいカスタマイズ(アクセントカラー変更等)
