# @search-docs/cli

## 1.0.38

### Patch Changes

- Updated dependencies [f836ac2]
- Updated dependencies [e027884]
  - @search-docs/types@1.3.3
  - @search-docs/server@1.3.4
  - @search-docs/client@1.0.18

## 1.0.37

### Patch Changes

- @search-docs/server@1.3.3

## 1.0.36

### Patch Changes

- @search-docs/server@1.3.2

## 1.0.35

### Patch Changes

- 2ce035d: ドキュメント改善: README.md の作成と更新

  - packages/cli: README.md を新規作成。インストール方法、基本的な使い方、全コマンドの説明を追加
  - packages/mcp-server: README.md を全面的に改善
    - バージョン指定（v1.x.x 以降）を削除
    - get_outline ツールの説明を追加
    - 全ツールの出力例を削除し、パラメータと機能説明に集中
    - 実装に基づいて全パラメータを正確に記述
  - @search-docs/server@1.3.1

## 1.0.34

### Patch Changes

- Updated dependencies [59304d6]
  - @search-docs/server@1.3.0

## 1.0.33

### Patch Changes

- Updated dependencies [21322ee]
- Updated dependencies [21322ee]
- Updated dependencies [6ecd3e6]
  - @search-docs/server@1.2.9
  - @search-docs/types@1.3.2
  - @search-docs/client@1.0.17

## 1.0.32

### Patch Changes

- fe67c66: 文書構造を表示する get_outline ツールを追加し、ESLint エラーを修正しました。

  - 新機能: get_outline ツールで文書のアウトライン（セクション番号・行数・トークン数）を取得
  - path/sectionId 両対応、関連プロジェクトサポート
  - ESLint エラー修正: Python 型インターフェースの追加、未使用変数の修正

- Updated dependencies [fe67c66]
  - @search-docs/types@1.3.1
  - @search-docs/server@1.2.8
  - @search-docs/client@1.0.16

## 1.0.31

### Patch Changes

- @search-docs/server@1.2.7

## 1.0.30

### Patch Changes

- b8a2b70: CI 修正: npm Trusted Publishing 対応のため最新 npm に更新

## 1.0.29

### Patch Changes

- 5ca2ecf: CI 修正: npm 公開時の依存関係順序を修正

## 1.0.28

### Patch Changes

- 7d87e38: 関連プロジェクト検索機能を追加

  複数の search-docs プロジェクト間でドキュメントを横断検索できる機能を実装しました。

  **主な変更**:

  - 設定ファイルに`relatedProjects`セクションを追加
  - `search()`と`get_document()`に`project`パラメータを追加
  - `ServerManager`クラスで複数プロジェクトのサーバを管理
  - 関連プロジェクト情報を`get_system_status`で表示
  - サーバプロセスの作業ディレクトリ設定を修正

  **使用例**:

  ```typescript
  // 関連プロジェクトを検索
  await search({ query: "認証", project: "auth-service" });

  // 関連プロジェクトのドキュメント取得
  await getDocument({ path: "README.md", project: "auth-service" });
  ```

- Updated dependencies [7d87e38]
  - @search-docs/types@1.3.0
  - @search-docs/client@1.0.15
  - @search-docs/server@1.2.6

## 1.0.27

### Patch Changes

- GPU メモリ最適化とバッチサイズ制御の改善

  - maxTokensPerText 削除、maxBatchTokens に統一して GPU メモリピークを確実に制御
  - バッチサイズを超えるセクションはベクトル化をスキップ
  - PyTorch MPS キャッシュクリア機能を追加
  - バッチ処理ごとにメモリを積極的に解放

- Updated dependencies
  - @search-docs/types@1.2.0
  - @search-docs/server@1.2.5
  - @search-docs/client@1.0.14

## 1.0.26

### Patch Changes

- Updated dependencies
  - @search-docs/server@1.2.4

## 1.0.25

### Patch Changes

- @search-docs/server@1.2.3

## 1.0.24

### Patch Changes

- @search-docs/server@1.2.2

## 1.0.23

### Patch Changes

- @search-docs/server@1.2.1

## 1.0.22

### Patch Changes

- Updated dependencies [691fccb]
  - @search-docs/server@1.2.0
  - @search-docs/types@1.1.0
  - @search-docs/client@1.0.13

## 1.0.21

### Patch Changes

- Updated dependencies
  - @search-docs/server@1.1.10

## 1.0.20

### Patch Changes

- Updated dependencies
  - @search-docs/server@1.1.9

## 1.0.19

### Patch Changes

- Updated dependencies
  - @search-docs/server@1.1.8

## 1.0.18

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
  - @search-docs/server@1.1.7
  - @search-docs/client@1.0.12
  - @search-docs/types@1.0.12

## 1.0.17

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
  - @search-docs/server@1.1.6
  - @search-docs/types@1.0.11
  - @search-docs/client@1.0.11

## 1.0.16

### Patch Changes

- Updated dependencies
  - @search-docs/server@1.1.5
  - @search-docs/types@1.0.10
  - @search-docs/client@1.0.10

## 1.0.15

### Patch Changes

- Updated dependencies [1402dc7]
  - @search-docs/server@1.1.4
  - @search-docs/types@1.0.9
  - @search-docs/client@1.0.9

## 1.0.14

### Patch Changes

- 5d5cbda: fix(db-engine): テーブルハンドルをキャッシュしてメモリリークを修正

  open_table()を繰り返し呼ぶと各インスタンスが独自の index/metadata キャッシュを持ち、メモリを消費する問題を修正。LanceDB のベストプラクティスに従い、テーブルハンドルを一度だけ開いて再利用するよう変更。

- Updated dependencies [5d5cbda]
  - @search-docs/server@1.1.3

## 1.0.13

### Patch Changes

- Updated dependencies
  - @search-docs/server@1.1.2

## 1.0.12

### Patch Changes

- Updated dependencies
  - @search-docs/server@1.1.1

## 1.0.11

### Patch Changes

- Updated dependencies [25aa7dd]
  - @search-docs/server@1.1.0

## 1.0.10

### Patch Changes

- Updated dependencies [54b20e9]
  - @search-docs/server@1.0.10

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
  - @search-docs/client@1.0.8
  - @search-docs/server@1.0.9

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
  - @search-docs/client@1.0.7
  - @search-docs/server@1.0.8

## 1.0.7

### Patch Changes

- @search-docs/server@1.0.7

## 1.0.6

### Patch Changes

- Updated dependencies
  - @search-docs/types@1.0.6
  - @search-docs/server@1.0.6
  - @search-docs/client@1.0.6

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
  - @search-docs/server@1.0.5
  - @search-docs/client@1.0.5

## 1.0.3

### Patch Changes

- Bug fixes and improvements

  - **cli**: ESM 互換性修正、config init 改善、depth 表示改善、ログ記録機能追加
  - **server**: file-watcher テスト安定性向上
  - **mcp-server**: --project-dir オプションをオプショナル化

- Updated dependencies
  - @search-docs/server@1.0.3

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
  - @search-docs/server@1.0.2
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
  - @search-docs/server@1.0.1

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
  - @search-docs/server@1.0.0
  - @search-docs/client@1.0.0
