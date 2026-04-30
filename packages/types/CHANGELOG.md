# @search-docs/types

## 1.4.3

### Patch Changes

- 33563c9: fix: ConfigLoader.resolve()で config.project.root を絶対パスに解決するよう修正。Docker 環境で WatcherProcess が正しいディレクトリをスキャンしない問題を修正。

## 1.4.2

### Patch Changes

- dccec8b: MCP サービスを in-process 化し、関連プロジェクトを URL 接続に限定

  - SearchDocsService インターフェイスを追加し、in-process と HTTP アクセスを透過的に扱えるように
  - MCP サーバが SearchDocsServer インスタンスを直接保持する構成に変更（HTTP デーモン spawn 廃止）
  - RelatedProjectConfig から dir 指定を削除し、url 必須に変更
  - db-engine の get_stats で内部 API(\_dataset)を公開 API(to_lance())に修正
  - lancedb 0.25.3 → 0.30.2 へアップデート（Lance v3.0 対応）
  - Python 依存を全てバージョン固定（サプライチェーン対策）
  - torch/sentence-transformers 依存を削除（ONNX 移行済み）

## 1.4.1

### Patch Changes

- 646485c: add_related_project に URL 接続オプションを追加。Docker 環境での localhost 自動補正対応。

## 1.4.0

### Minor Changes

- bb08dfd: ### Docker MCP サーバ

  Docker 化された MCP サーバとして配布・利用可能に。1 イメージ・2 モード構成（MCP サーバ / Embedding サーバ）。

  - Dockerfile: マルチステージビルド（python-deps → node-build → runtime）
  - entrypoint.sh: モード分岐、Embedding サーバ自動検出
  - compose.yaml: 共有 Embedding サーバ構成例

  ### Embedding ONNX 化 + Ollama API 互換サーバ

  torch/sentence-transformers 依存を完全除去し、ONNX Runtime ベースに移行。Docker イメージサイズを 11GB → 2.5GB に削減。

  - embedding_server.py: Ollama API 互換 HTTP サーバ（/api/tags, /api/embed）
  - embedding_onnx.py: ONNX Runtime 推論エンジン
  - RemoteEmbeddingModel: ローカルモデルロード廃止、HTTP API 経由に一本化
  - embeddingUrl 設定: Embedding Server の URL を設定可能に

  ### WatcherProcess + Heartbeat 調停

  複数サーバインスタンス間でファイル監視を自動協調する仕組み。

  - watcher-process.ts: FileWatcher/IndexWorker/StartupSyncWorker を統合管理
  - writer_heartbeat テーブル（LanceDB）による排他制御
  - 状態マシン: sleeping → claiming → watching
  - サーバ統合: READ_ONLY/ENABLE_WATCHER 廃止、全サーバに WatcherProcess 内蔵

  ### 設定ファイル移行

  `.search-docs/config.json` を新しい設定ファイルパスとしてサポート。

  - ConfigLoader: `.search-docs/config.json` パスの探索・解決に対応
  - プロジェクトルート判定: `.search-docs/` サブディレクトリを考慮

  ### 型定義の拡張

  - GetStatusResponse: watcher 状態（sleeping/claiming/watching）を公開
  - IndexingConfig: embeddingUrl プロパティ追加
  - ServerConfig: readOnly プロパティ追加
  - デフォルト値: embeddingModel を ruri-v3-30m-onnx に変更、embeddingUrl 追加

  ### CLI embedding コマンド

  Embedding サーバの起動・停止・ステータス確認を CLI から直接管理可能に。

  - embedding start: デーモン起動、CoreML/CUDA 自動検出、モデルパス自動解決（Docker/キャッシュ/HuggingFace Hub）
  - embedding stop: PID ファイルベースの停止
  - embedding status: ヘルスチェック + プロセス情報表示
  - PID/ログは `~/.search-docs/` に配置（プロジェクト横断で共有）

  ### EmbeddingServerProcess TS 統合

  Embedding サーバのライフサイクル管理を TS 側（bin/server.ts）に移管。

  - EmbeddingServerProcess: 外部検出 → ローカル起動の自動判定
  - Docker entrypoint.sh 簡素化（Embedding 管理ロジック削除）
  - MCP ツール整理: init/system_status/list_related_projects/add_related_project 追加、server_start/server_stop 削除

  ### サーバ内部構造の刷新

  - DirtyWorker 廃止 → WatcherProcess 内の IndexWorker に統合
  - bin/server.ts: EmbeddingServerProcess → DBEngine → SearchDocsServer → WatcherProcess → JsonRpcServer の起動順序に整理
  - setupLogRedirect 共通化

  ### バグ修正

  - entrypoint.sh: bare except → `except Exception:`（SystemExit の誤キャッチ防止）
  - Dockerfile: libssl3 追加、UV_CACHE_DIR 権限修正
  - server.ts: Docker 環境での IPv4/IPv6 バインドミスマッチ修正（0.0.0.0 バインド）
  - @parcel/watcher: 2.5.1 → 2.5.6（Docker bind mount の inotify 非伝播修正）
  - file-watcher.ts: extglob パターン削除（C++ regex 遅延によるイベント消失修正）
  - heartbeat: 新規 DB 接続で readback（read_consistency_interval 問題の回避）

## 1.3.4

### Patch Changes

- 3361c2e: 全依存パッケージのバージョンを固定（Node.js/Python）
- 49e53ea: server.log ローテーション導入と巨大ファイル読み込み防止

  - RotatingWriteStream によるログローテーション（1MB/3 世代）を導入
  - パフォーマンスログの stderrBuffer 蓄積を停止しメモリリーク防止
  - FilesConfig に maxFileSize（デフォルト 10MB）を追加し、超過ファイルの読み込みをスキップ

## 1.3.3

### Patch Changes

- f836ac2: add_related_project MCP ツールを追加

  - 関連プロジェクトを一時的にメモリ上で追加するツールを実装
  - 指定ディレクトリの .search-docs.json 存在チェックと名前重複チェックを実施
  - 既存ツール（list_related_projects, server_start, system_status）で一時追加分も参照するよう統合
  - RelatedProjectConfig 型をエクスポートに追加

## 1.3.2

### Patch Changes

- 6ecd3e6: maxDepth の上限を 3 から 6 に変更

  Markdown の見出しは H6（######）まで存在するため、config.indexing.maxDepth の範囲を 0-6 に拡張しました。これにより、H4/H5/H6 見出しを独立したセクションとして作成できるようになります。

## 1.3.1

### Patch Changes

- fe67c66: 文書構造を表示する get_outline ツールを追加し、ESLint エラーを修正しました。

  - 新機能: get_outline ツールで文書のアウトライン（セクション番号・行数・トークン数）を取得
  - path/sectionId 両対応、関連プロジェクトサポート
  - ESLint エラー修正: Python 型インターフェースの追加、未使用変数の修正

## 1.3.0

### Minor Changes

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
