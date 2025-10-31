# @search-docs/mcp-server

## 1.0.11

### Patch Changes

- @search-docs/cli@1.0.7

## 1.0.10

### Patch Changes

- get_document の path と sectionId をオプショナルに変更し、どちらか一方で取得可能にしました。

  変更内容:

  - path と sectionId をどちらもオプショナルに変更（ただし、どちらか一方は必須）
  - sectionId のみで特定のセクションを取得できるように
  - マルチバイト文字（日本語）のテストを追加し、正しく扱えることを確認

- Updated dependencies
  - @search-docs/types@1.0.6
  - @search-docs/cli@1.0.6
  - @search-docs/client@1.0.6

## 1.0.9

### Patch Changes

- get_document ツールに sectionId パラメータを追加しました。

  変更内容:

  - inputSchema に sectionId（オプショナル）パラメータを追加
  - 検索結果に表示されるセクション ID を使って、特定のセクションのみを取得できるように
  - セクション取得時の出力フォーマットを追加（Level, Section, Line などのメタデータを表示）

## 1.0.8

### Patch Changes

- 検索結果の出力フォーマットを 1 行形式に改善し、可読性を向上しました。

  変更内容:

  - メタデータ表示を複数行から 1 行形式に変更（Level, Section, Line, Score を`|`区切りで表示）
  - sectionNumber、startLine、endLine などの新しいフィールドに対応
  - indexStatus は'updating'または'outdated'の場合のみ表示
  - コンテンツを Markdown コードブロックで明確に表示

## 1.0.7

### Patch Changes

- 5781444: package.json からバージョンを動的に読み込むように修正

  ハードコードされていた'0.1.0'を package.json から読み込むように変更し、-V オプションで正しいバージョンが表示されるようにしました。

## 1.0.6

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
  - @search-docs/cli@1.0.5
  - @search-docs/client@1.0.5

## 1.0.4

### Patch Changes

- MCP Server 起動時のログ出力を抑制

  通常モードでは標準エラー出力にログを出さないように変更。
  デバッグ時は`DEBUG=1`環境変数または`NODE_ENV=development`でログ出力。

## 1.0.3

### Patch Changes

- Bug fixes and improvements

  - **cli**: ESM 互換性修正、config init 改善、depth 表示改善、ログ記録機能追加
  - **server**: file-watcher テスト安定性向上
  - **mcp-server**: --project-dir オプションをオプショナル化

- Updated dependencies
  - @search-docs/cli@1.0.3

## 1.0.2

### Patch Changes

- 初期リリース後の不足機能追加と改善

  - config init コマンドの追加（設定ファイル生成）
  - グローバル--config オプションの実装
  - サーバ起動デフォルトをバックグラウンドに変更
  - 設定ファイル必須化（ポート衝突回避のため）
  - ConfigLoader.resolve()に requireConfig パラメータを追加

- Updated dependencies
  - @search-docs/cli@1.0.2
  - @search-docs/types@1.0.1
  - @search-docs/client@1.0.1

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

- Updated dependencies
  - @search-docs/cli@1.0.1

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
  - @search-docs/client@1.0.0
