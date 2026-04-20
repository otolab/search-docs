# task40: Docker コンテナ動作確認 & MCP接続テスト

## 目的

サーバ統合（583a648）後のDockerイメージをビルドし、コンテナ内での動作確認とMCP接続テストを行う。

## 前提

- ブランチ: `feature/docker-mcp-server`
- 直前の変更: READ_ONLY/ENABLE_WATCHER廃止、全サーバにWatcherProcess内蔵
- Dockerfile: ONNX Runtime ベース、1イメージ・2モード構成

## 計画

### Phase 1: Docker イメージビルド
- [x] Docker Desktop 起動確認
- [x] `docker build` 実行 — キャッシュヒット多、ビルド成功
- [x] ビルド成功確認 — `search-docs-mcp:dev`

### Phase 2: コンテナ内動作確認
- [x] Embeddingサーバモード動作確認（`--mode=embedding-server`）
  - ONNX モデルロード OK (ruri-v3-30m-onnx, 256d, CPU)
  - `/api/tags` OK、`/api/embed` OK (1x256d ベクトル返却)
- [x] MCPサーバモード動作確認（デフォルト）
  - entrypoint.sh: Embedding サーバ自動起動 → MCP サーバ起動 OK
  - 自動起動: CONFIGURED_SERVER_DOWN → JSON-RPC サーバ起動 → RUNNING
  - initialize → tools/list (10ツール) → search (3件、55ms) 全て成功
  - WatcherProcess内蔵の動作確認済み

### Phase 3: MCP接続テスト
- [x] `.mcp.json` にDockerコンテナのMCPサーバ設定済み
- [x] Claude Code セッション再起動後にMCP接続テスト — 成功
- [x] search ツール動作確認 — 3件、21ms で応答

## メモ

### エントリポイントの流れ（MCPモード）
1. `entrypoint.sh` → Embeddingサーバ検出/起動
2. `exec node dist/server.js` → MCP Server (stdio)
3. MCP Server → ServerManager → CLI → JSON-RPC Server spawn
4. JSON-RPC Server に WatcherProcess 内蔵

### Docker 環境変数
- `IS_DOCKER=true` → server.ts で 0.0.0.0 バインド
- `SEARCH_DOCS_DOCKER_*` → モデル・次元・URL固定
- `EMBEDDING_URL` → entrypoint.sh が検出・設定
