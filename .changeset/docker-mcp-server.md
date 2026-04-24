---
"@search-docs/db-engine": minor
"@search-docs/server": minor
"@search-docs/mcp-server": minor
"@search-docs/types": minor
"@search-docs/cli": minor
---

### Docker MCP サーバ

Docker化されたMCPサーバとして配布・利用可能に。1イメージ・2モード構成（MCPサーバ / Embeddingサーバ）。

- Dockerfile: マルチステージビルド（python-deps → node-build → runtime）
- entrypoint.sh: モード分岐、Embeddingサーバ自動検出
- compose.yaml: 共有Embeddingサーバ構成例

### Embedding ONNX化 + Ollama API互換サーバ

torch/sentence-transformers依存を完全除去し、ONNX Runtimeベースに移行。Dockerイメージサイズを11GB → 2.5GBに削減。

- embedding_server.py: Ollama API互換HTTPサーバ（/api/tags, /api/embed）
- embedding_onnx.py: ONNX Runtime推論エンジン
- RemoteEmbeddingModel: ローカルモデルロード廃止、HTTP API経由に一本化
- embeddingUrl設定: Embedding ServerのURLを設定可能に

### WatcherProcess + Heartbeat調停

複数サーバインスタンス間でファイル監視を自動協調する仕組み。

- watcher-process.ts: FileWatcher/IndexWorker/StartupSyncWorkerを統合管理
- writer_heartbeatテーブル（LanceDB）による排他制御
- 状態マシン: sleeping → claiming → watching
- サーバ統合: READ_ONLY/ENABLE_WATCHER廃止、全サーバにWatcherProcess内蔵

### 設定ファイル移行

`.search-docs/config.json` を新しい設定ファイルパスとしてサポート。

- ConfigLoader: `.search-docs/config.json` パスの探索・解決に対応
- プロジェクトルート判定: `.search-docs/` サブディレクトリを考慮

### 型定義の拡張

- GetStatusResponse: watcher状態（sleeping/claiming/watching）を公開
- IndexingConfig: embeddingUrl プロパティ追加
- ServerConfig: readOnly プロパティ追加
- デフォルト値: embeddingModel を ruri-v3-30m-onnx に変更、embeddingUrl 追加

### CLI embeddingコマンド

Embeddingサーバの起動・停止・ステータス確認をCLIから直接管理可能に。

- embedding start: デーモン起動、CoreML/CUDA自動検出、モデルパス自動解決（Docker/キャッシュ/HuggingFace Hub）
- embedding stop: PIDファイルベースの停止
- embedding status: ヘルスチェック + プロセス情報表示
- PID/ログは `~/.search-docs/` に配置（プロジェクト横断で共有）

### EmbeddingServerProcess TS統合

Embeddingサーバのライフサイクル管理をTS側（bin/server.ts）に移管。

- EmbeddingServerProcess: 外部検出 → ローカル起動の自動判定
- Docker entrypoint.sh簡素化（Embedding管理ロジック削除）
- MCPツール整理: init/system_status/list_related_projects/add_related_project追加、server_start/server_stop削除

### サーバ内部構造の刷新

- DirtyWorker廃止 → WatcherProcess内のIndexWorkerに統合
- bin/server.ts: EmbeddingServerProcess → DBEngine → SearchDocsServer → WatcherProcess → JsonRpcServer の起動順序に整理
- setupLogRedirect共通化

### バグ修正

- entrypoint.sh: bare except → `except Exception:`（SystemExitの誤キャッチ防止）
- Dockerfile: libssl3追加、UV_CACHE_DIR権限修正
- server.ts: Docker環境でのIPv4/IPv6バインドミスマッチ修正（0.0.0.0バインド）
- @parcel/watcher: 2.5.1 → 2.5.6（Docker bind mountのinotify非伝播修正）
- file-watcher.ts: extglobパターン削除（C++ regex遅延によるイベント消失修正）
- heartbeat: 新規DB接続でreadback（read_consistency_interval問題の回避）
