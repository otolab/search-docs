# @search-docs/server

## 1.2.1

### Patch Changes

- Updated dependencies [f8edbdd]
  - @search-docs/db-engine@1.1.1

## 1.2.0

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
  - @search-docs/db-engine@1.1.0
  - @search-docs/types@1.1.0
  - @search-docs/storage@1.0.11

## 1.1.10

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

- Updated dependencies
  - @search-docs/db-engine@1.0.19

## 1.1.9

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

- Updated dependencies
  - @search-docs/db-engine@1.0.18

## 1.1.8

### Patch Changes

- fix(server): DB 接続の非ブロック化とワーカー起動タイミングの修正

  openPromise パターンを実装し、DB 接続完了を待機可能にすることで、サーバー起動時の DB 接続エラーを解消しました。

  - DB 接続を非ブロッキングで開始し、HTTP サーバーは即座に起動
  - DB 依存のワーカー（IndexWorker、StartupSyncWorker）は DB 接続完了後に起動
  - `waitForConnection()` メソッドで DB 接続完了を待機可能
  - 冪等な接続処理により複数回の`connect()`呼び出しに対応

- Updated dependencies
  - @search-docs/db-engine@1.0.17

## 1.1.7

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
  - @search-docs/db-engine@1.0.16
  - @search-docs/storage@1.0.10
  - @search-docs/types@1.0.12

## 1.1.6

### Patch Changes

- **PID ファイル管理の修正**

  サーバプロセスのライフサイクル管理を標準的なデーモンパターンに変更しました。これにより、タイムアウト時のプロセス多重起動問題を根本的に解決します。

  **変更内容**:

  1. **types package**: PID ファイル型定義を追加

     - `PidFileContent` インターフェイスを追加
     - `getPidFilePath()` ヘルパー関数を追加
     - server/cli 間で型定義を共有

  2. **server package**: サーバ側で PID ファイル管理を実装

     - 起動時に PID ファイル作成（既存 PID チェック付き）
     - SIGTERM/SIGINT ハンドラで PID ファイル削除
     - 異常終了時の整合性向上

  3. **cli package**: CLI 側の PID 管理を削除・修正
     - PID ファイル作成処理を削除（サーバに移管）
     - タイムアウト時にプロセスを SIGTERM で kill
     - 孤児プロセス化の防止

  **修正された問題**:

  - タイムアウト時にサーバプロセスが孤児化していた問題を解決
  - 複数サーバプロセスの同時起動を防止
  - PID ファイル管理の責務を明確化

  **Breaking Changes**: なし

- Updated dependencies
  - @search-docs/types@1.0.11
  - @search-docs/db-engine@1.0.15
  - @search-docs/storage@1.0.9

## 1.1.5

### Patch Changes

- サーバ起動の非同期化で MCP タイムアウトを解消

  StartupSyncWorker を導入し、初期インデックス同期をバックグラウンド化。大規模プロジェクトでの MCP サーバ起動時のコネクションタイムアウトを解決しました。

- Updated dependencies
  - @search-docs/types@1.0.10
  - @search-docs/db-engine@1.0.14
  - @search-docs/storage@1.0.8

## 1.1.4

### Patch Changes

- 1402dc7: メモリリーク解決とコードクリーンアップ

  - TOKENIZERS_PARALLELISM=false 自動設定でメモリリーク 98.5%削減
  - pythonMaxMemoryMB デフォルト 8GB に変更
  - メモリ監視・自動再起動機能の追加
  - 実験用コードの削除とリファクタリング
  - スレッドダンプログを DEBUG モード時のみ有効化

- Updated dependencies [1402dc7]
  - @search-docs/db-engine@1.0.13
  - @search-docs/types@1.0.9
  - @search-docs/storage@1.0.7

## 1.1.3

### Patch Changes

- 5d5cbda: fix(db-engine): テーブルハンドルをキャッシュしてメモリリークを修正

  open_table()を繰り返し呼ぶと各インスタンスが独自の index/metadata キャッシュを持ち、メモリを消費する問題を修正。LanceDB のベストプラクティスに従い、テーブルハンドルを一度だけ開いて再利用するよう変更。

- Updated dependencies [5d5cbda]
  - @search-docs/db-engine@1.0.12

## 1.1.2

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

- Updated dependencies
  - @search-docs/db-engine@1.0.11

## 1.1.1

### Patch Changes

- ビルド成果物の更新

  @parcel/watcher への移行後、dist ファイルが古いままだったため再ビルドしました。

## 1.1.0

### Minor Changes

- 25aa7dd: @parcel/watcher への移行でファイル監視を改善

  chokidar から@parcel/watcher へ完全移行し、大規模プロジェクトでの EMFILE 問題を根本的に解決しました。

  **主な変更:**

  - ネイティブ C++実装によるイベントスロットリング
  - Watchman 連携（オプション）による高速化
  - 大規模プロジェクト（10 万ファイル規模）でも効率的に動作

  **破壊的変更:**

  - WatcherConfig から usePolling/pollingInterval を削除（@parcel/watcher はネイティブ実装のため不要）

  **実績:**

  - Parcel, Nuxt.js, Vite で採用実績あり
  - 全 69 テストがパス

## 1.0.10

### Patch Changes

- 54b20e9: Fix test failures and improve test stability

  - **db-engine**: Fix Python-TypeScript snake_case/camelCase conversion in search results. Task14 fields (startLine, endLine, sectionNumber) are now correctly converted.
  - **server**: Fix test timeout issues and type errors in test files. Increase beforeAll timeout to handle concurrent Python worker initialization.
  - **storage**: Add dist/ exclusion to vitest config to prevent duplicate test execution.
  - **db-engine**: Enable 2 previously skipped tests (findSectionsByPathAndHash, deleteSectionsByPathExceptHash).

- Updated dependencies [54b20e9]
  - @search-docs/db-engine@1.0.10
  - @search-docs/storage@1.0.6

## 1.0.9

### Patch Changes

- Updated dependencies
  - @search-docs/types@1.0.8
  - @search-docs/db-engine@1.0.9
  - @search-docs/storage@1.0.5

## 1.0.8

### Patch Changes

- Updated dependencies
  - @search-docs/types@1.0.7
  - @search-docs/db-engine@1.0.8
  - @search-docs/storage@1.0.4

## 1.0.7

### Patch Changes

- Updated dependencies
  - @search-docs/db-engine@1.0.7

## 1.0.6

### Patch Changes

- get_document の path と sectionId をオプショナルに変更し、どちらか一方で取得可能にしました。

  変更内容:

  - path と sectionId をどちらもオプショナルに変更（ただし、どちらか一方は必須）
  - sectionId のみで特定のセクションを取得できるように
  - マルチバイト文字（日本語）のテストを追加し、正しく扱えることを確認

- Updated dependencies
  - @search-docs/types@1.0.6
  - @search-docs/db-engine@1.0.6
  - @search-docs/storage@1.0.3

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
  - @search-docs/db-engine@1.0.5
  - @search-docs/storage@1.0.2

## 1.0.3

### Patch Changes

- Bug fixes and improvements

  - **cli**: ESM 互換性修正、config init 改善、depth 表示改善、ログ記録機能追加
  - **server**: file-watcher テスト安定性向上
  - **mcp-server**: --project-dir オプションをオプショナル化

## 1.0.2

### Patch Changes

- 初期リリース後の不足機能追加と改善

  - config init コマンドの追加（設定ファイル生成）
  - グローバル--config オプションの実装
  - サーバ起動デフォルトをバックグラウンドに変更
  - 設定ファイル必須化（ポート衝突回避のため）
  - ConfigLoader.resolve()に requireConfig パラメータを追加

- Updated dependencies
  - @search-docs/types@1.0.1
  - @search-docs/db-engine@1.0.1
  - @search-docs/storage@1.0.1

## 1.0.1

### Patch Changes

- ## Bug Fixes and Enhancements

  ### CLI: Port Configuration Support

  - Add `resolveServerUrl()` utility to read port configuration from `.search-docs.json`
  - Fix all CLI commands (search, index rebuild, index status) to use configured port instead of hardcoded default
  - Add `--config` option to all client commands for explicit config file path

  ### MCP Server: Auto-start Server

  - Add `ServerManager` class to automatically start search-docs server when not running
  - Use `import.meta.resolve()` to locate `@search-docs/cli` package
  - Add `@search-docs/cli` as dependency to enable auto-start functionality
  - Implement graceful cleanup on process termination (SIGINT/SIGTERM)

  ### Server: Fix EMFILE Error in File Watcher

  - Add directory-level filtering to exclude common directories with many files (node_modules, .git, .venv, dist, build, etc.)
  - Configure chokidar options for better file descriptor management
  - Enable native fsEvents on macOS with `usePolling: false`

  ## User Impact

  **Before**: Users needed to install both `@search-docs/cli` and `@search-docs/mcp-server`, and manually start the server

  **After**: Users only need to install `@search-docs/mcp-server`, which automatically starts the server when needed

  **Port Configuration**: Multiple projects can now run servers on different ports as configured in `.search-docs.json`

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
  - @search-docs/storage@1.0.0
  - @search-docs/db-engine@1.0.0
