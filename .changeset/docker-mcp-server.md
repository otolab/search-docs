---
"@search-docs/db-engine": minor
"@search-docs/server": minor
"@search-docs/mcp-server": minor
"@search-docs/types": patch
"@search-docs/cli": patch
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

### バグ修正

- entrypoint.sh: bare except → `except Exception:`（SystemExitの誤キャッチ防止）
- Dockerfile: libssl3追加、UV_CACHE_DIR権限修正
- server.ts: Docker環境でのIPv4/IPv6バインドミスマッチ修正（0.0.0.0バインド）
- @parcel/watcher: 2.5.1 → 2.5.6（Docker bind mountのinotify非伝播修正）
- file-watcher.ts: extglobパターン削除（C++ regex遅延によるイベント消失修正）
- heartbeat: 新規DB接続でreadback（read_consistency_interval問題の回避）
