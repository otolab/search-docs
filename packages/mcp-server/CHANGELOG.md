# @search-docs/mcp-server

## 1.1.2

### Patch Changes

- @search-docs/cli@1.0.24

## 1.1.1

### Patch Changes

- @search-docs/cli@1.0.23

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
  - @search-docs/cli@1.0.22
  - @search-docs/client@1.0.13

## 1.0.26

### Patch Changes

- @search-docs/cli@1.0.21

## 1.0.25

### Patch Changes

- @search-docs/cli@1.0.20

## 1.0.24

### Patch Changes

- @search-docs/cli@1.0.19

## 1.0.23

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
  - @search-docs/cli@1.0.18
  - @search-docs/client@1.0.12
  - @search-docs/types@1.0.12

## 1.0.22

### Patch Changes

- Updated dependencies
  - @search-docs/cli@1.0.17
  - @search-docs/types@1.0.11
  - @search-docs/client@1.0.11

## 1.0.21

### Patch Changes

- Updated dependencies
  - @search-docs/types@1.0.10
  - @search-docs/cli@1.0.16
  - @search-docs/client@1.0.10

## 1.0.20

### Patch Changes

- Updated dependencies [1402dc7]
  - @search-docs/types@1.0.9
  - @search-docs/cli@1.0.15
  - @search-docs/client@1.0.9

## 1.0.19

### Patch Changes

- 5d5cbda: fix(db-engine): テーブルハンドルをキャッシュしてメモリリークを修正

  open_table()を繰り返し呼ぶと各インスタンスが独自の index/metadata キャッシュを持ち、メモリを消費する問題を修正。LanceDB のベストプラクティスに従い、テーブルハンドルを一度だけ開いて再利用するよう変更。

- Updated dependencies [5d5cbda]
  - @search-docs/cli@1.0.14

## 1.0.18

### Patch Changes

- @search-docs/cli@1.0.13

## 1.0.17

### Patch Changes

- @search-docs/cli@1.0.12

## 1.0.16

### Patch Changes

- @search-docs/cli@1.0.11

## 1.0.15

### Patch Changes

- @search-docs/cli@1.0.10

## 1.0.14

### Patch Changes

- 設定ファイルが見つからない場合のエラーメッセージを改善しました。

  変更内容:

  - 設定ファイル不在時のエラーメッセージをより詳しく、分かりやすく改善
  - CLI コマンドでの初期化方法（npx @search-docs/cli config init）を案内
  - 手動作成する場合の最小限の設定例を表示
  - MCP Server 経由で使用している場合でも対応方法が明確に

## 1.0.13

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
  - @search-docs/cli@1.0.9
  - @search-docs/client@1.0.8

## 1.0.12

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
  - @search-docs/cli@1.0.8
  - @search-docs/client@1.0.7

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
