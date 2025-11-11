# @search-docs/types

## 1.2.0

### Minor Changes

- GPU メモリ最適化とバッチサイズ制御の改善

  - maxTokensPerText 削除、maxBatchTokens に統一して GPU メモリピークを確実に制御
  - バッチサイズを超えるセクションはベクトル化をスキップ
  - PyTorch MPS キャッシュクリア機能を追加
  - バッチ処理ごとにメモリを積極的に解放

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

## 1.0.12

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

## 1.0.11

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

## 1.0.10

### Patch Changes

- サーバ起動の非同期化で MCP タイムアウトを解消

  StartupSyncWorker を導入し、初期インデックス同期をバックグラウンド化。大規模プロジェクトでの MCP サーバ起動時のコネクションタイムアウトを解決しました。

## 1.0.9

### Patch Changes

- 1402dc7: メモリリーク解決とコードクリーンアップ

  - TOKENIZERS_PARALLELISM=false 自動設定でメモリリーク 98.5%削減
  - pythonMaxMemoryMB デフォルト 8GB に変更
  - メモリ監視・自動再起動機能の追加
  - 実験用コードの削除とリファクタリング
  - スレッドダンプログを DEBUG モード時のみ有効化

## 1.0.8

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

## 1.0.7

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

## 1.0.6

### Patch Changes

- get_document の path と sectionId をオプショナルに変更し、どちらか一方で取得可能にしました。

  変更内容:

  - path と sectionId をどちらもオプショナルに変更（ただし、どちらか一方は必須）
  - sectionId のみで特定のセクションを取得できるように
  - マルチバイト文字（日本語）のテストを追加し、正しく扱えることを確認

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

## 1.0.1

### Patch Changes

- 初期リリース後の不足機能追加と改善

  - config init コマンドの追加（設定ファイル生成）
  - グローバル--config オプションの実装
  - サーバ起動デフォルトをバックグラウンドに変更
  - 設定ファイル必須化（ポート衝突回避のため）
  - ConfigLoader.resolve()に requireConfig パラメータを追加

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
