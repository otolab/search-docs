# @search-docs/db-engine

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
