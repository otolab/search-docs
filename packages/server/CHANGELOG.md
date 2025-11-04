# @search-docs/server

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
