# task34: search-docs MCPサーバー Docker化 実装

**作成日**: 2026-04-14
**状態**: 実装中
**Issue**: #67
**ブランチ**: feature/docker-mcp-server
**設計文書**: prompts/tasks/task34.docker-mcp-server-investigation.v1.md

## 実装済み

### 1. Dockerfile (マルチステージビルド)
- **ファイル**: `Dockerfile`
- Stage 1: python-deps (Python依存 + ruri-v3-30mモデル焼き込み)
- Stage 2: node-build (pnpm install + TypeScriptビルド)
- Stage 3: runtime (実行イメージ、非rootユーザー)

### 2. entrypoint.sh (モード分岐)
- **ファイル**: `docker/entrypoint.sh`
- デフォルト: MCPサーバモード（stdio）
- `--mode=embedding-server`: Embeddingサーバモード（HTTP）

### 3. Embedding Server (HTTPサーバ)
- **ファイル**: `packages/db-engine/src/python/embedding_server.py`
- `POST /encode`: テキストのバッチベクトル化
- `GET /health`: ヘルスチェック（モデル情報含む）
- stdlib `http.server` ベース（外部依存なし）

### 4. RemoteEmbeddingModel
- **ファイル**: `packages/db-engine/src/python/embedding.py` に追加
- `EmbeddingModel` 基底クラスを継承
- HTTP経由で `/encode` エンドポイントに接続
- `detect_embedding_server()`: 自動検出関数
  - 検出順: EMBEDDING_URL → Docker network → host.docker.internal → ローカルフォールバック

### 5. 設定固定ルール
- **ファイル**: `packages/server/src/bin/server.ts` に追加
- 環境変数 `SEARCH_DOCS_DOCKER_EMBEDDING_MODEL`, `SEARCH_DOCS_DOCKER_VECTOR_DIMENSION`
- Dockerイメージ内で設定し、.search-docs.json の値を上書き

### 6. Docker Compose
- **ファイル**: `docker/compose.yaml`
- 共有Embeddingサーバ + MCPサーバの構成例

### 7. .dockerignore
- **ファイル**: `.dockerignore`

## 発見事項

- `vectorDimension` は設定ファイルに定義されているが、実際にはPython側で使われていない
  - モデルから自動決定される（ruri-v3-30m → 256d）
  - ただしDocker環境変数で上書きする仕組みは念のため用意
- Docker内でuvキャッシュの権限問題 → `.venv/bin/python` 直接実行で解決
- GLIBC不整合: `python:3.12-slim`(trixie)と`node:22-slim`(bookworm)でGLIBCバージョン不一致
  → `python:3.12-slim-bookworm` に固定して解決
- agentパッケージはまだ未リリース（mainブランチに存在しない）→ Dockerfileから除外

## 残タスク

- [x] Dockerビルド成功確認 (4.46GB)
- [ ] Embedding Server の動作確認
- [ ] stdio transport での動作確認
- [ ] 自動検出ロジックの統合テスト
