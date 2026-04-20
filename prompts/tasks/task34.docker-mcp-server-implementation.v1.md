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

## 発見・修正したバグ (2026-04-14)

### 1. entrypoint.sh - check_health の bare except バグ
- **問題**: Python の `except:` が `exit(0)` の `SystemExit` をキャッチし、常に exit(1) で終了
- **修正**: `except:` → `except Exception:` に変更

### 2. Dockerfile - libssl3 不足
- **問題**: ランタイムイメージに libssl.so.3 がなく、pyarrow/lancedb が動かない
- **修正**: `apt-get install libssl3` をランタイムステージに追加

### 3. Dockerfile - db-engine/.venv 未作成
- **問題**: db-engine の Python 依存関係用 .venv がビルドされておらず、uv run が権限エラー
- **修正**: ビルドステージで `uv sync --project packages/db-engine` を追加、ランタイムにコピー＆権限付与

### 4. Dockerfile - UV_CACHE_DIR 権限エラー
- **問題**: appuser が /home/appuser/.cache/uv を作れない
- **修正**: `ENV UV_CACHE_DIR=/app/.cache/uv` を追加

### 5. server.ts - Docker 環境の IPv4/IPv6 バインドミスマッチ
- **問題**: Docker 内で `localhost` が IPv6 (::1) に解決され、Express がIPv6のみにバインド。Node.js fetch は IPv4 で接続して失敗
- **修正**: Docker 環境検出時に `0.0.0.0` にバインドするよう変更

### 6. .mcp.json - Docker MCP 設定追加
- 2つのMCPサーバ構成を定義: `search-docs`(Docker) と `search-docs-local`(ローカル)

### 7. @parcel/watcher - Docker bind mountでinotifyイベント非伝播
- **問題**: @parcel/watcher 2.5.1ではDocker bind mountのマウントポイント直下をsubscribeするとinotifyイベントが届かなかった
- **修正**: @parcel/watcher 2.5.1 → 2.5.6 に更新

### 8. file-watcher.ts - extglobパターンによるイベント消失
- **問題**: ignoreオプションの `**/*.!(md)` パターンがpicomatch→C++ regexで極端に遅延し、Docker環境でファイル変更イベントが事実上タイムアウトしていた
- **修正**: extglobパターンを削除し、`.md`フィルタは既存の `shouldProcessFile()` に委譲

**詳細**: prompts/tasks/task34.docker-mcp-server-investigation.v1.md の「2026-04-14 実装完了」セクション参照

## 残タスク

- [x] Dockerビルド成功確認 (4.46GB)
- [x] Embedding Server の動作確認
- [x] stdio transport での動作確認
- [x] バグ修正（6件）
- [ ] 自動検出ロジックの統合テスト
- [ ] Docker Compose での共有 Embedding サーバ構成のテスト
- [ ] Docker MCP Catalog への登録準備
