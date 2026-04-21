# Docker構成

search-docsは、Docker化されたMCPサーバとして配布・利用できます。Docker化により、ランタイム依存（Node.js, Python, uv）を排除し、セキュアな境界で実行できます。

## コンセプト: 1イメージ・2モード

**1つのDockerイメージ**で、起動モードにより役割を切り替えます：

```
ghcr.io/otolab/search-docs-mcp:<version>

  A) MCPサーバモード（デフォルト / CMD）
     └─ WatcherProcess内蔵（heartbeat調停で自動協調）
     └─ EmbeddingServerProcessが自動検出・起動（TypeScript管理）
        → 外部検出 → Docker service → host.docker.internal → ローカルspawn

  B) Embeddingサーバモード（--mode=embedding-server）
     └─ HTTP で待ち受け、複数MCPサーバから共有利用
```

**ユーザーが意識するのは「Embeddingサーバコンテナを起動するかどうか」だけ**。MCPサーバ側は自動検出で勝手に切り替わります。ファイル監視（WatcherProcess）は各サーバに内蔵されており、Heartbeat調停で1つだけがmasterとして動作します。

## 利用形態

### 単体利用（大多数のユーザー）

```bash
docker mcp run search-docs
```

→ Embeddingサーバなし → ローカルモデルロード → 全部入りで動作

### 共有利用（ヘビーユーザー / 複数プロジェクト）

```bash
# 1回だけ: Embeddingサーバを起動
docker run -d \
  --name search-docs-embedding \
  --network search-docs-net \
  --restart=unless-stopped \
  -p 127.0.0.1:24281:24281 \
  ghcr.io/otolab/search-docs-mcp:latest \
  --mode=embedding-server

# 各プロジェクト: MCPサーバ（WatcherProcess内蔵、heartbeat調停で自動協調）
docker mcp run search-docs
```

→ Embeddingサーバ自動検出 → 軽量動作（メモリ節約）

メモリ: 120MB x N → 120MB x 1（共有サーバ）+ 軽量MCP x N

### Watcher調停（複数インスタンス）

同じプロジェクトディレクトリで複数のMCPサーバが起動すると、Heartbeat調停により1つだけがmaster（watching状態）になります。他のインスタンスはsleeping状態で待機し、masterが停止すると自動的にfailoverします。

## 環境変数

| 変数 | 説明 | デフォルト |
|------|------|-----------|
| `EMBEDDING_URL` | 明示的なEmbeddingサーバURL | - |
| `EMBEDDING_SERVER_PORT` | Embeddingサーバポート | `24281` |

**注**: 以前の `SEARCH_DOCS_DOCKER_EMBEDDING_URL` 環境変数は廃止されました。`EmbeddingServerProcess`が自動検出するため不要です。

## Embeddingサーバ自動検出

MCPサーバ起動時に、`EmbeddingServerProcess`（TypeScript管理）が以下の順序でEmbeddingサーバを探します：

1. `EMBEDDING_URL` 環境変数（明示指定、最優先）
2. `http://search-docs-embedding:24281/health`（Docker network内）
3. `http://host.docker.internal:24281/health`（ホスト側サービス）
4. すべて失敗（タイムアウト 1s）→ ローカルspawn起動

**注意**: Docker内から `localhost` はコンテナ自身を指します。ホスト側のサービスには `host.docker.internal`（macOS/Windows）を使います。Linux では `--add-host=host.docker.internal:host-gateway` が必要です。

**検出エンドポイント**: `GET /health`を使用します。成功時は`GET /health`ポーリングでreadiness待ちします。

**管理**: `packages/server/src/embedding/EmbeddingServerProcess.ts`

## Dockerイメージ構成

### マルチステージビルド

```
Stage 1: python-deps    ─ Python依存（uv sync）+ モデルダウンロード
Stage 2: node-build     ─ pnpm install + TypeScript build
Stage 3: runtime        ─ 実行環境（Node + Python + 成果物 + モデル）
```

**ベースイメージ**: `node:22-slim` + Python/uvインストール

**イメージ内容**:
- Node.js + TypeScriptビルド成果物
- Python + uv + .venv（LanceDB, sentence-transformers等）
- ruri-v3-30m モデル（約60MB、焼き込み済み）
- エントリポイントスクリプト（モード分岐、簡素化済み28行）

### 設定の固定ルール（Docker実行時）

`embeddingModel` と `vectorDimension` はイメージに焼き込んだモデルと整合性が必須です。Docker実行時はイメージ内蔵値で強制し、`.search-docs.json` の指定は無視します。

| 設定項目 | Docker実行時 | 理由 |
|---------|:-----------:|------|
| `indexing.embeddingModel` | **イメージ内蔵値で強制** | イメージ内のモデルと一致必須 |
| `indexing.vectorDimension` | **イメージ内蔵値で強制** | モデルの出力次元と一致必須 |
| `indexing.embeddingUrl` | **自動検出** | EmbeddingServerProcessが検出・設定 |
| `indexing.maxTokensPerSection` | ユーザー設定を尊重 | 分割粒度、互換性に影響しない |
| `indexing.maxDepth` | ユーザー設定を尊重 | 同上 |
| `files.*` | ユーザー設定を尊重 | プロジェクト固有 |
| `search.*` | ユーザー設定を尊重 | プロジェクト固有 |
| `worker.*` | ユーザー設定を尊重 | チューニング項目 |

`.search-docs.json` に別モデルが書かれていた場合は警告ログを出力します。

## 既知の問題と修正内容

Docker MCP サーバの実装・動作確認で以下のバグを発見・修正しました（2026-04-14）：

### 1. entrypoint.sh - check_health の bare except バグ

**問題**: Python の `except:` が `exit(0)` の `SystemExit` をキャッチし、常に exit(1) で終了していた

**修正**: `except:` → `except Exception:` に変更

### 2. Dockerfile - libssl3 不足

**問題**: ランタイムイメージ (node:22-slim) に libssl.so.3 がなく、pyarrow/lancedb が動かなかった

**修正**: `apt-get install libssl3` をランタイムステージに追加

### 3. Dockerfile - db-engine/.venv 未作成

**問題**: db-engine の Python 依存関係用 .venv がビルドされておらず、uv run が権限エラーを起こしていた

**修正**: ビルドステージで `uv sync --project packages/db-engine` を追加、ランタイムにコピー＆権限付与

### 4. Dockerfile - UV_CACHE_DIR 権限エラー

**問題**: appuser が /home/appuser/.cache/uv を作れなかった

**修正**: `ENV UV_CACHE_DIR=/app/.cache/uv` を追加

### 5. server.ts - Docker 環境の IPv4/IPv6 バインドミスマッチ

**問題**: Docker 内で `localhost` が IPv6 (::1) に解決され、Express がIPv6のみにバインド。Node.js fetch は IPv4 で接続して失敗

**根本原因**:
```javascript
// Express のデフォルト動作
app.listen(port, 'localhost')  // → IPv6 (::1) にのみバインド

// Node.js fetch の動作
fetch('http://localhost:24280/health')  // → IPv4 (127.0.0.1) に接続
```

**修正**: Docker 環境検出時に `0.0.0.0` にバインドするよう変更。環境変数 `IS_DOCKER=true` で Docker 環境を識別し、Docker 外では従来通り `localhost` を使用（セキュリティ維持）

### 6. @parcel/watcher - Docker bind mountでinotifyイベント非伝播

**問題**: @parcel/watcher 2.5.1ではDocker bind mountのマウントポイント直下をsubscribeするとinotifyイベントが届かなかった

**修正**: @parcel/watcher 2.5.1 → 2.5.6 に更新

### 7. file-watcher.ts - extglobパターンによるイベント消失

**問題**: ignoreオプションの `**/*.!(md)` パターンがpicomatch→C++ regexで極端に遅延し、Docker環境でファイル変更イベントが事実上タイムアウトしていた

**修正**: extglobパターンを削除し、`.md`フィルタは既存の `shouldProcessFile()` に委譲

### 8. entrypoint.sh - Embedding管理のTypeScript統合（2026-04）

**変更**: Embeddingサーバ管理ロジックをシェルスクリプトからTypeScriptに移動（139行 → 28行）

**理由**:
- Embedding検出・起動・ヘルスチェックロジックをTypeScriptで統合管理
- `EmbeddingServerProcess`クラス（`packages/server/src/embedding/`）に集約
- entrypoint.shはモード分岐のみに専念

**影響**:
- `SEARCH_DOCS_DOCKER_EMBEDDING_URL` 環境変数は廃止
- Embedding管理の責務がTypeScript側に一元化

## MLX / GPU の制約

- **Docker内でMLXは不可**（LinuxKit VMの壁）
- Docker内は**CPU-only運用**。ruri-v3-30mは軽量なのでCPU実用的
- MLXを使いたい場合: ホスト側でEmbeddingサーバを直接実行（Docker外）
  - 自動検出の3番 `http://host.docker.internal:24281/health` で繋がる

## リソース制限

```bash
# 単体利用時
docker run --memory=1g --cpus=1.5 --cpu-shares=512 ...

# 共有Embeddingサーバ
docker run --memory=1g --cpus=1.0 --cpu-shares=512 ...

# 軽量MCPサーバ（Embeddingサーバ共有時）
docker run --memory=512m --cpus=1.0 --cpu-shares=512 ...
```

## 技術的な詳細

### Embedding Server API

```
POST /encode
  Body: { "texts": ["text1", "text2"], "dimension": 256 }
  Response: { "vectors": [[0.1, ...], [0.2, ...]] }

GET /health
  Response: {
    "status": "ok",
    "model": "cl-nagoya/ruri-v3-30m",
    "vectorDimension": 256
  }
```

### データの永続化

- `.search-docs/` ディレクトリ（LanceDBインデックス）はボリュームマウント必須
- 設定ファイル `.search-docs.json` の読み取りもマウント必要

## 参考リンク

- [Docker MCP Toolkit 公式](https://docs.docker.com/ai/mcp-catalog-and-toolkit/toolkit/)
- [Docker MCP Catalog](https://docs.docker.com/ai/mcp-catalog-and-toolkit/catalog/)
- [docker/mcp-registry](https://github.com/docker/mcp-registry)
- [github/github-mcp-server](https://github.com/github/github-mcp-server) - Docker化の参考実装
- [MCP Server Best Practices (Docker)](https://www.docker.com/blog/mcp-server-best-practices/)

## 関連ドキュメント

- [システムアーキテクチャ](./architecture.md) - 全体構成
- [MCP統合ガイド](./mcp-integration.md) - Claude Code統合
- [ユーザーガイド](./user-guide.md) - 使い方全般

**設計文書**: [prompts/tasks/task34.docker-mcp-server-investigation.v1.md](../prompts/tasks/task34.docker-mcp-server-investigation.v1.md)
