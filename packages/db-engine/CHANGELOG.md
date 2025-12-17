# @search-docs/db-engine

## 1.4.0

### Minor Changes

- 59304d6: fix: セクション番号の表示問題を修正 (Issue #30)

  **破壊的変更**: データベース構造の変更により、インデックスの再構築が必要です。

  ## 問題

  get_outline でセクション番号が「1.1: Level 1」のように、H1 が 1.1 から始まっていました。

  ## 原因

  document root (depth=0) と H1 (depth=1) が同じ sectionNumber `[1]`を持っていたため、表示が重複していました。

  ## 修正内容

  - **データ層**: document root の sectionNumber を`[]`（空配列）に変更
  - **表示層**: 空の sectionNumber を"root"として表示
  - **テスト**: 包括的な sectionNumber 検証テストを追加

  ## 影響

  - **データベース**: sectionNumber の形式が変更されたため、インデックスの再構築が必要
  - **表示**: セクション番号が正しく表示されるようになります
    - 以前: "1.1: Level 1"
    - 修正後: "1: Level 1"

## 1.3.4

### Patch Changes

- 9f54b1a: totalDocuments が 0 になるバグを修正

  get_stats()関数で table.to_lance()を使用していましたが、pylance パッケージへの依存が必要でした。pyproject.toml に pylance>=0.9.0 を追加することで、totalDocuments を正しく取得できるようになりました。

- Updated dependencies [6ecd3e6]
  - @search-docs/types@1.3.2

## 1.3.3

### Patch Changes

- fe67c66: 文書構造を表示する get_outline ツールを追加し、ESLint エラーを修正しました。

  - 新機能: get_outline ツールで文書のアウトライン（セクション番号・行数・トークン数）を取得
  - path/sectionId 両対応、関連プロジェクトサポート
  - ESLint エラー修正: Python 型インターフェースの追加、未使用変数の修正

- Updated dependencies [fe67c66]
  - @search-docs/types@1.3.1

## 1.3.2

### Patch Changes

- 37a9959: Python 3.14 未満に制限（PyTorch torch.compile 互換性のため）

  PyTorch 2.9.1 の torch.compile が Python 3.14 をサポートしていないため、requires-python を">=3.11,<3.14"に変更しました。この制限により、ModernBERT ベースの Ruri 埋め込みモデルが正しく動作します。

  PyTorch 2.10 以降で Python 3.14 サポートが安定したら、この制限を解除する予定です。

## 1.3.1

### Patch Changes

- Updated dependencies [7d87e38]
  - @search-docs/types@1.3.0

## 1.3.0

### Minor Changes

- GPU メモリ最適化とバッチサイズ制御の改善

  - maxTokensPerText 削除、maxBatchTokens に統一して GPU メモリピークを確実に制御
  - バッチサイズを超えるセクションはベクトル化をスキップ
  - PyTorch MPS キャッシュクリア機能を追加
  - バッチ処理ごとにメモリを積極的に解放

### Patch Changes

- Updated dependencies
  - @search-docs/types@1.2.0

## 1.2.2

### Patch Changes

- パフォーマンス最適化とテスト修正

  **db-engine:**

  - findSectionsByPathAndHash()を LIMIT 1 に最適化（42x 高速化: 47.69ms → 1.20ms）
  - sections テーブルに document_hash インデックスを追加
  - デフォルトバッチサイズを 128 に変更して GPU 効率を改善

  **server:**

  - テストファイルの直列実行を設定（Python ワーカーの競合を回避）

## 1.2.1

### Patch Changes

- Apple Silicon MPS GPU 対応を追加しました。

  ## 変更内容

  Python の embedding.py に Apple Silicon MPS (Metal Performance Shaders) GPU 対応を追加しました。

  ### GPU デバイス検出の優先順位

  1. CUDA (NVIDIA GPU)
  2. **MPS (Apple Silicon GPU)** - 新規追加
  3. CPU (フォールバック)

  ### 動作確認

  Apple Silicon Mac (M1/M2/M3 など) で自動的に MPS GPU が検出され、Vector 化処理が高速化されます：

  ```
  Ruri model loaded: cl-nagoya/ruri-v3-30m - Small model (120MB, 256d) on GPU (Apple Silicon MPS)
  ```

  ## ユーザーへの影響

  - Apple Silicon Mac で自動的に GPU 加速が有効化されます
  - PyTorch がインストールされていれば追加設定不要
  - 既存の CUDA/CPU 環境への影響なし

## 1.2.0

### Minor Changes

- バッチ処理と GPU 対応で Vector 化を高速化

  ## バッチ処理対応

  - embedding.py: encode()を常にバッチ処理対応に変更
    - 単一テキスト・複数テキスト両対応（後方互換性維持）
    - SentenceTransformer.encode()の batch_size=32 を活用
  - worker.py: add_sections()でバッチ Vector 化を実装
    - 1 件ずつの encode()から、まとめて encode()に変更

  **パフォーマンス改善見込み:**

  - CPU 環境: 1.5〜2 倍高速化
  - GPU 環境: 3〜5 倍高速化

  ## GPU 対応

  - embedding.py: GPU 自動検出機能を追加
    - torch.cuda.is_available()で自動判定
    - device パラメータを自動設定（'cuda' or 'cpu'）
    - デバイス情報をログ出力
  - pyproject.toml: オプショナル依存を追加
    - [gpu]: CUDA 11.8 用
    - [gpu-cu121]: CUDA 12.1 用

  **GPU 環境がない場合:**

  - 追加設定不要、通常通り CPU で動作

## 1.1.1

### Patch Changes

- f8edbdd: DuckDB 統合による get_stats()の高速化

  Index Status 表示のパフォーマンス問題を解決しました。LanceDB 公式推奨の DuckDB 統合を使用し、ユニークカウント処理を最適化しました。

  - パフォーマンス改善: タイムアウト(30 秒以上) → 約 6 秒
  - DuckDB 依存関係を追加（duckdb>=0.9.0）
  - get_stats()メソッドで COUNT(DISTINCT document_path)を使用

  注意: この変更後、`uv sync`による DuckDB のインストールとサーバー再起動が必要です。

## 1.1.0

### Minor Changes

- 691fccb: インデックス戦略の実装と前方一致検索の追加

  ## LanceDB インデックス戦略 (Phase 1)

  以下のインデックスを新規作成し、クエリパフォーマンスを最適化しました:

  **index_requests テーブル**:

  - `document_path` (BTREE): 等価検索の高速化
  - `document_hash` (BTREE): 等価検索の高速化

  **sections テーブル**:

  - `document_path` (BTREE): 等価検索の高速化、LIKE prefix 検索にも効果が期待される
  - `is_dirty` (BITMAP): Low-cardinality (2 値) カラムの高速化

  ## 前方一致検索機能

  search API に以下のオプションを追加しました:

  - `includePaths`: 指定パスプレフィックス配下のみを検索 (OR 条件)
  - `excludePaths`: 指定パスプレフィックス配下を除外 (AND 条件)

  例:

  ```typescript
  // docs/配下のみを検索
  search({ query: "検索語", options: { includePaths: ["docs/"] } });

  // docs/internal/とtemp/を除外
  search({
    query: "検索語",
    options: { excludePaths: ["docs/internal/", "temp/"] },
  });

  // 組み合わせ: prompts/配下でprompts/tasks/を除外
  search({
    query: "検索語",
    options: {
      includePaths: ["prompts/"],
      excludePaths: ["prompts/tasks/"],
    },
  });
  ```

  ## 技術詳細

  - LanceDB LIKE 演算子による前方一致検索
  - DataFusion 46.0.0 の NOT LIKE 最適化を活用
  - BTREE インデックスの効果は今後のパフォーマンステストで検証予定

### Patch Changes

- Updated dependencies [691fccb]
  - @search-docs/types@1.1.0

## 1.0.19

### Patch Changes

- perf(db-engine): count_rows()と BITMAP インデックスによる劇的な高速化

  件数取得を`to_pandas()` + `len()`から`count_rows(filter=...)`に変更し、status カラムに BITMAP インデックスを作成。

  **主な変更**:

  - `count_index_requests()`: `count_rows(filter=...)`を使用
  - `get_stats()`の dirty_count: `count_rows(filter="is_dirty = true")`を使用
  - `update_many_index_requests()`の count: `count_rows(filter=...)`を使用
  - IndexRequests テーブルの status カラムに BITMAP インデックスを作成
  - インデックス状態の確認ロジックを追加（`list_indices()`使用）

  **パフォーマンス改善**:

  - 修正前: 30 秒タイムアウト（7478 件の pending キュー）
  - 修正後: 0.741 秒（7452 件の pending キュー）
  - **約 40 倍以上の高速化**

  **技術的詳細**:

  - status は 4 値（pending, processing, completed, failed）の low-cardinality カラムのため、BITMAP インデックスが最適
  - `count_rows()`はインデックスを自動的に利用
  - データ本体を取得せずに件数のみを効率的にカウント

## 1.0.18

### Patch Changes

- perf(server): server status コマンドのパフォーマンス最適化

  `server status`コマンドで、pending キューの件数取得が非効率だった問題を修正。
  全データをフェッチしてカウントする代わりに、`count_rows()`を使った専用カウントメソッドを実装。

  **主な変更**:

  - Python worker: `count_index_requests()`メソッドを追加（`table.count_rows()`使用）
  - DBEngine: `countIndexRequests()`メソッドを追加
  - SearchDocsServer: `getStatus()`で`findIndexRequests().length`の代わりに`countIndexRequests()`を使用

  **パフォーマンス改善**:

  - 修正前: 1.210 秒（1000 件キュー）
  - 修正後: 0.834 秒（1000 件キュー）
  - 約 31%の高速化（0.376 秒短縮）

## 1.0.17

### Patch Changes

- fix(server): DB 接続の非ブロック化とワーカー起動タイミングの修正

  openPromise パターンを実装し、DB 接続完了を待機可能にすることで、サーバー起動時の DB 接続エラーを解消しました。

  - DB 接続を非ブロッキングで開始し、HTTP サーバーは即座に起動
  - DB 依存のワーカー（IndexWorker、StartupSyncWorker）は DB 接続完了後に起動
  - `waitForConnection()` メソッドで DB 接続完了を待機可能
  - 冪等な接続処理により複数回の`connect()`呼び出しに対応

## 1.0.16

### Patch Changes

- **PID ファイル競合状態の修正とビルドプロセス改善**

  **修正内容**:

  1. **server: PID ファイル競合状態の修正**

     - デーモン起動時に自分自身の PID を除外するロジックを追加
     - `existingPid.pid !== process.pid` チェックを追加
     - サーバプロセスが自分自身を「既に起動中」と誤認する問題を解決

  2. **すべてのパッケージ: prepublishOnly スクリプト追加**
     - npm publish 時に自動的にビルドを実行
     - 古いビルド成果物が誤って公開される問題を防止
     - 一貫性のあるリリースプロセスを確保

  **修正された問題**:

  - デーモンモードでのサーバ起動タイムアウト
  - npm publish 時の古いコードの公開

  **Breaking Changes**: なし

- Updated dependencies
  - @search-docs/types@1.0.12

## 1.0.15

### Patch Changes

- Updated dependencies
  - @search-docs/types@1.0.11

## 1.0.14

### Patch Changes

- Updated dependencies
  - @search-docs/types@1.0.10

## 1.0.13

### Patch Changes

- 1402dc7: メモリリーク解決とコードクリーンアップ

  - TOKENIZERS_PARALLELISM=false 自動設定でメモリリーク 98.5%削減
  - pythonMaxMemoryMB デフォルト 8GB に変更
  - メモリ監視・自動再起動機能の追加
  - 実験用コードの削除とリファクタリング
  - スレッドダンプログを DEBUG モード時のみ有効化

- Updated dependencies [1402dc7]
  - @search-docs/types@1.0.9

## 1.0.12

### Patch Changes

- 5d5cbda: fix(db-engine): テーブルハンドルをキャッシュしてメモリリークを修正

  open_table()を繰り返し呼ぶと各インスタンスが独自の index/metadata キャッシュを持ち、メモリを消費する問題を修正。LanceDB のベストプラクティスに従い、テーブルハンドルを一度だけ開いて再利用するよう変更。

## 1.0.11

### Patch Changes

- fix(db-engine): メモリリーク修正 - .select()による効率的なカラム取得

  大規模プロジェクト（10 万ファイル）でのメモリ消費を大幅に削減。

  ## 修正内容

  ### worker.py

  1. **get_stats()** - `.select(["document_path"])` でメモリ効率化（約 99%削減）
  2. **find_index_requests()** - デフォルト `limit=1000` を追加
  3. **get_paths_with_status()** - `.select()` によるカラム限定

  ## テスト結果

  - db-engine: 23/23 passed
  - server: 69/69 passed

## 1.0.10

### Patch Changes

- 54b20e9: Fix test failures and improve test stability

  - **db-engine**: Fix Python-TypeScript snake_case/camelCase conversion in search results. Task14 fields (startLine, endLine, sectionNumber) are now correctly converted.
  - **server**: Fix test timeout issues and type errors in test files. Increase beforeAll timeout to handle concurrent Python worker initialization.
  - **storage**: Add dist/ exclusion to vitest config to prevent duplicate test execution.
  - **db-engine**: Enable 2 previously skipped tests (findSectionsByPathAndHash, deleteSectionsByPathExceptHash).

## 1.0.9

### Patch Changes

- depth パラメータを maxDepth（最大深度）として正しく実装しました。

  変更内容:

  - Python 検索条件を `depth = X` から `depth <= X` に変更
  - depth の意味を「この深度まで検索」に明確化
    - 0=文書全体のみ
    - 1=文書全体+章まで（H1 まで）
    - 2=文書全体+章+節まで（H1, H2 まで）
    - 3=すべて（H1, H2, H3 まで）
  - 「枝葉まで検索しない」という用途に対応

- Updated dependencies
  - @search-docs/types@1.0.8

## 1.0.8

### Patch Changes

- depth 配列指定機能を削除し、単一の数値のみを受け付けるように変更しました。

  変更内容:

  - SearchOptions.depth の型を `number | number[]` から `number` に変更
  - Python 側の depth 配列処理を削除
  - CLI 引数を `--depth <depths...>` から `--depth <depth>` に変更
  - MCP ツールの description を改善し、depth（0-3）と includeCleanOnly の意味を明確化
    - depth: 0=文書全体、1=H1(章)、2=H2(節)、3=H3(項)
    - includeCleanOnly: 最新の文書内容のみを検索対象とする
  - 検索結果に含まれる行番号とセクション ID の用途を説明に追加

- Updated dependencies
  - @search-docs/types@1.0.7

## 1.0.7

### Patch Changes

- JSON-RPC 通信で UTF-8 エンコーディングを明示的に指定しました。

  変更内容:

  - Python 側: stdin/stdout を UTF-8 でラップ
  - Python 側: json.dumps に ensure_ascii=False を指定
  - TypeScript 側: Buffer.toString()で UTF-8 を明示的に指定
  - マルチバイト文字（日本語）が確実に正しく扱われるようになりました

## 1.0.6

### Patch Changes

- Updated dependencies
  - @search-docs/types@1.0.6

## 1.0.5

### Patch Changes

- 9b5820a: 検索結果に startLine/endLine/sectionNumber フィールドを追加

  検索結果に文書内の位置情報を追加し、検索結果からソースファイルの該当箇所を特定できるようにしました。

  **主な変更**:

  - Section 型に 3 つの新フィールドを追加（startLine, endLine, sectionNumber）
  - MarkdownSplitter で行番号とセクション番号を自動生成
  - Python-TypeScript 変換層で新フィールドを変換
  - CLI 出力に位置情報を表示
  - MCP Server で新フィールドを提供
  - Python 側でフィールドのバリデーションと型変換を追加（null 値を防止）

  **影響範囲**:

  - 既存のインデックスは再構築が必要です（`search-docs index rebuild`または`.search-docs/index`を削除してサーバ再起動）

- Updated dependencies [9b5820a]
  - @search-docs/types@1.0.5

## 1.0.1

### Patch Changes

- Updated dependencies
  - @search-docs/types@1.0.1

## 1.0.0

### Major Changes

- Initial release of search-docs - Local document vector search system

  ## Features

  - 🔍 Vector search for Markdown documents using LanceDB
  - 📝 Automatic document sectioning (depth 0-3)
  - 🚀 Client-server architecture with JSON-RPC
  - 🐕 CLI tool for easy document searching
  - 🤖 MCP Server for Claude Code integration
  - 🇯🇵 Optimized for Japanese with Ruri Embedding Models
  - 📦 Complete TypeScript + Python hybrid implementation

  ## Packages

  - **@search-docs/cli** - Command-line interface
  - **@search-docs/client** - TypeScript client library
  - **@search-docs/server** - Search server
  - **@search-docs/mcp-server** - MCP Server for Claude Code
  - **@search-docs/storage** - Document storage
  - **@search-docs/db-engine** - LanceDB vector search engine
  - **@search-docs/types** - TypeScript type definitions

### Patch Changes

- Updated dependencies
  - @search-docs/types@1.0.0
