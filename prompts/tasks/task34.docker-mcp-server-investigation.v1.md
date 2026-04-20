# task34: search-docs MCPサーバー Docker化 調査

**作成日**: 2026-04-13
**状態**: 設計方針確定

## 背景・動機

search-docsのMCPサーバーは、Node.js（TypeScript）とPython（LanceDB + Ruri Embedding）の両方のランタイムが必要。現状の配布・セットアップには以下の課題がある:

1. **デュアルランタイム問題**: ユーザー環境にNode.jsとPython（+ uv）の両方が必要
2. **postinstall の煩雑さ**: `uv sync` を都度実行する運用がきれいでない
3. **npx実行のセキュリティリスク**: ホスト権限のフル付与、サプライチェーン攻撃リスク（別途調査資料あり）

Docker化により、ランタイム依存を排除し、セキュリティ境界を確保する。

## 現状構成

### パッケージ依存グラフ

```
types（共通型定義）
  ↓
storage（ドキュメント永続化）   db-engine（Python Worker / LanceDB）
  ↓                              ↓
server（Express + JSON-RPC検索サーバ）
  ↓
client（JSON-RPCクライアント）
  ↓
cli（CLIツール）  mcp-server（Claude Code統合）  agent（Context-1検索エージェント）
```

### ランタイム要件

| 要素 | バージョン | 用途 |
|------|-----------|------|
| Node.js | ≥ 18.0.0 | TypeScript実行 |
| pnpm | 9.14.4 | パッケージ管理 |
| Python | ≥ 3.11, < 3.14 | LanceDB / Embedding |
| uv | 0.8.12 | Pythonパッケージ管理 |

### Python-Node連携方式

- **通信**: JSON-RPC over stdin/stdout
- **起動**: TypeScriptからPythonプロセスをspawn
  ```bash
  uv --project packages/db-engine run python src/python/worker.py \
    --model=cl-nagoya/ruri-v3-30m \
    --max-batch-tokens=4000 \
    --db-path=/path/to/.search-docs/index
  ```
- db-engineパッケージルートを動的検出して `uv --project` で指定

### MCP Server

- **エントリポイント**: `packages/mcp-server/dist/server.js`
- **通信**: stdio（JSON-RPC）
- **SDK**: `@modelcontextprotocol/sdk@1.20.2`

## 設計方針（確定）

### コンセプト: 1イメージ・2モード

**1つのDockerイメージ**で、起動モードにより役割を切り替える:

```
ghcr.io/otolab/search-docs-mcp:<version>

  A) MCPサーバモード（デフォルト / CMD）
     └─ Embeddingサーバ検出あり → 外部に接続（自動で軽量動作）
     └─ Embeddingサーバ検出なし → ローカルモデルロード（自動で全部入り動作）

  B) Embeddingサーバモード（--mode=embedding-server）
     └─ HTTP で待ち受け、複数MCPサーバから共有利用
```

**ユーザーが意識するのは「Embeddingサーバコンテナを起動するかどうか」だけ**。
MCPサーバ側は自動検出で勝手に切り替わる。

### 利用形態

```
┌─────────────────────────────────────────────────────────────────┐
│ 単体利用（大多数のユーザー）                                      │
│                                                                 │
│   docker mcp run search-docs                                    │
│   → Embeddingサーバなし → ローカルモデルロード → 全部入りで動作     │
│                                                                 │
├─────────────────────────────────────────────────────────────────┤
│ 共有利用（ヘビーユーザー / 複数プロジェクト）                       │
│                                                                 │
│   1回だけ: docker run -d ... --mode=embedding-server             │
│   以降:    docker mcp run search-docs                            │
│   → Embeddingサーバ自動検出 → 軽量動作（メモリ節約）               │
│                                                                 │
│   メモリ: 120MB x N → 120MB x 1（共有サーバ）+ 軽量MCP x N       │
└─────────────────────────────────────────────────────────────────┘
```

### Embeddingサーバ自動検出

MCPサーバ起動時に、以下の順序でEmbeddingサーバを探す:

```
1. EMBEDDING_URL 環境変数（明示指定、最優先）
2. http://search-docs-embedding:8080/health（Docker network内、同一ネットワーク時）
3. http://host.docker.internal:24281/health（ホスト側サービスへの接続）
4. すべて失敗（タイムアウト 500ms）→ ローカルモデルロード
```

**注意**: Docker内から `localhost` はコンテナ自身を指す。
ホスト側のサービスには `host.docker.internal`（macOS/Windows）を使う。
Linux では `--add-host=host.docker.internal:host-gateway` が必要。

3番により、Docker外でMLX付きEmbeddingサーバをホスト側で直接動かすケースもカバー。

### Embeddingサーバ API

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

**次元の整合性チェック**:
- 接続後、サーバの `vectorDimension` と自分の設定値を比較
- 一致 → 使う
- 不一致 → 警告ログ + ローカルモデルロードにフォールバック

### Embeddingサーバのポート

- コンテナ内デフォルト: `8080`
- ホスト側公開デフォルト: `24281`
- 環境変数 `EMBEDDING_SERVER_PORT` で変更可能

### 設定の固定ルール（Docker実行時）

`embeddingModel` と `vectorDimension` はイメージに焼き込んだモデルと整合性が必須。
Docker実行時はイメージ内蔵値で強制し、`.search-docs.json` の指定は無視する。

| 設定項目 | Docker実行時 | 理由 |
|---------|:-----------:|------|
| `indexing.embeddingModel` | **イメージ内蔵値で強制** | イメージ内のモデルと一致必須 |
| `indexing.vectorDimension` | **イメージ内蔵値で強制** | モデルの出力次元と一致必須 |
| `indexing.maxTokensPerSection` | ユーザー設定を尊重 | 分割粒度、互換性に影響しない |
| `indexing.maxDepth` | ユーザー設定を尊重 | 同上 |
| `files.*` | ユーザー設定を尊重 | プロジェクト固有 |
| `search.*` | ユーザー設定を尊重 | プロジェクト固有 |
| `worker.*` | ユーザー設定を尊重 | チューニング項目 |

`.search-docs.json` に別モデルが書かれていた場合は警告ログを出力。

### Dockerイメージ構成

**マルチステージビルド**:

```
Stage 1: python-deps    ─ Python依存（uv sync）+ モデルダウンロード
Stage 2: node-build     ─ pnpm install + TypeScript build
Stage 3: runtime        ─ 実行環境（Node + Python + 成果物 + モデル）
```

**ベースイメージ**: `node:22-slim` + Python/uvインストール（公式イメージの信頼性）

**イメージ内容**:
- Node.js + TypeScriptビルド成果物
- Python + uv + .venv（LanceDB, sentence-transformers等）
- ruri-v3-30m モデル（約60MB、焼き込み済み）
- エントリポイントスクリプト（モード分岐）

### Dockerfile 設計案

```dockerfile
# ============================================================
# Stage 1: Python依存関係 + モデルダウンロード
# ============================================================
FROM python:3.12-slim AS python-deps

COPY --from=ghcr.io/astral-sh/uv:latest /uv /usr/local/bin/uv

WORKDIR /app

COPY pyproject.toml uv.lock ./
COPY packages/db-engine/pyproject.toml packages/db-engine/
RUN uv sync --frozen --no-dev

# モデルを事前ダウンロード（/app/.cache に配置）
ENV HF_HOME=/app/.cache/huggingface
RUN uv run python -c "from sentence_transformers import SentenceTransformer; \
    SentenceTransformer('cl-nagoya/ruri-v3-30m')"

# ============================================================
# Stage 2: Node.jsビルド
# ============================================================
FROM node:22-slim AS node-build

RUN corepack enable && corepack prepare pnpm@9.14.4 --activate

WORKDIR /app

COPY pnpm-workspace.yaml pnpm-lock.yaml package.json ./
COPY packages/types/package.json packages/types/
COPY packages/storage/package.json packages/storage/
COPY packages/db-engine/package.json packages/db-engine/
COPY packages/server/package.json packages/server/
COPY packages/client/package.json packages/client/
COPY packages/cli/package.json packages/cli/
COPY packages/mcp-server/package.json packages/mcp-server/
COPY packages/agent/package.json packages/agent/
RUN pnpm install --frozen-lockfile --prod=false

COPY tsconfig.json tsconfig.base.json ./
COPY packages/ packages/
RUN pnpm run build:all

# ============================================================
# Stage 3: 実行イメージ
# ============================================================
FROM node:22-slim AS runtime

COPY --from=python-deps /usr/local/ /usr/local/
COPY --from=python-deps /app/.venv /app/.venv
COPY --from=python-deps /app/.cache /app/.cache
COPY --from=ghcr.io/astral-sh/uv:latest /uv /usr/local/bin/uv

WORKDIR /app
COPY --from=node-build /app/node_modules ./node_modules
COPY --from=node-build /app/packages ./packages
COPY --from=node-build /app/package.json ./
COPY --from=node-build /app/pnpm-workspace.yaml ./

COPY pyproject.toml uv.lock ./
COPY docker/entrypoint.sh ./entrypoint.sh

# 非rootユーザー作成、権限設定
RUN groupadd --system --gid 1001 appgroup && \
    useradd --system --uid 1001 --gid appgroup appuser && \
    chmod +x ./entrypoint.sh && \
    chown -R appuser:appgroup /app/.cache
USER appuser

ENV PYTHONUNBUFFERED=1
ENV TOKENIZERS_PARALLELISM=false
ENV NODE_ENV=production
ENV HF_HOME=/app/.cache/huggingface

ENTRYPOINT ["./entrypoint.sh"]
CMD []
```

### エントリポイントスクリプト

```bash
#!/bin/bash
case "${1:-}" in
  --mode=embedding-server)
    # Embeddingサーバモード: FastAPI + sentence-transformers
    exec python packages/db-engine/src/python/embedding_server.py \
      --port="${EMBEDDING_SERVER_PORT:-8080}"
    ;;
  *)
    # MCPサーバモード（デフォルト）: stdio
    exec node packages/mcp-server/dist/server.js "$@"
    ;;
esac
```

### Claude Code設定（.mcp.json）

**注意**: `.mcp.json` では `${workspaceFolder}` 等の変数展開は使えない。
セットアップスクリプトで実パスを埋め込んで生成するか、`claude mcp add-json` で登録する。

**単体利用**:
```bash
# セットアップスクリプトが生成する .mcp.json の例
claude mcp add-json search-docs \
  '{"command":"docker","args":["run","-i","--rm","-v","/path/to/project:/workspace:ro","-v","/path/to/project/.search-docs:/workspace/.search-docs","ghcr.io/otolab/search-docs-mcp:latest"]}'
```

**共有Embeddingサーバ利用時**（`--network` と `--add-host` を追加）:
```bash
claude mcp add-json search-docs \
  '{"command":"docker","args":["run","-i","--rm","--network=search-docs-net","--add-host=host.docker.internal:host-gateway","-v","/path/to/project:/workspace:ro","-v","/path/to/project/.search-docs:/workspace/.search-docs","ghcr.io/otolab/search-docs-mcp:latest"]}'
```

**`--add-host=host.docker.internal:host-gateway`**: Linux環境でホスト側サービスへの接続を有効化。
macOS/WindowsのDocker Desktopでは不要だが、付けても害はない。

### 共有Embeddingサーバの起動

```bash
# ネットワーク作成（初回のみ）
docker network create search-docs-net

# Embeddingサーバ起動（一度だけ）
docker run -d \
  --name search-docs-embedding \
  --network search-docs-net \
  --restart=unless-stopped \
  --memory=1g --cpus=1.0 --cpu-shares=512 \
  -p 127.0.0.1:24281:8080 \
  ghcr.io/otolab/search-docs-mcp:latest \
  --mode=embedding-server
```

`--restart=unless-stopped` により Docker Desktop 起動時に自動再開。
`-p 127.0.0.1:24281:8080` でホスト側の localhost:24281 からのみアクセス可能（外部ネットワークには非公開）
（ホスト側直接実行のEmbeddingサーバと同じポートで自動検出される）。

### compose.yaml（オプション、必須ではない）

便利に使いたい人向けに提供:

```yaml
# docker/compose.yaml
services:
  embedding-server:
    image: ghcr.io/otolab/search-docs-mcp:latest
    command: ["--mode=embedding-server"]
    mem_limit: 1g
    cpus: 1.0
    cpu_shares: 512
    ports:
      - "24281:8080"
    healthcheck:
      test: ["CMD", "python", "-c", "import urllib.request; urllib.request.urlopen('http://localhost:8080/health')"]
      interval: 5s
      retries: 3
    restart: unless-stopped

  mcp-server:
    image: ghcr.io/otolab/search-docs-mcp:latest
    mem_limit: 512m
    cpus: 1.0
    cpu_shares: 512
    depends_on:
      embedding-server:
        condition: service_healthy
    stdin_open: true
    # volumes は利用時に指定
```

```bash
# compose利用時
docker compose -f docker/compose.yaml run --rm -i mcp-server
```

### 配布方法

**Phase 1: Docker MCP Catalog プラグイン**
- `docker mcp run search-docs` で即利用（最も楽）
- 全部入り1コンテナとして動作
- Docker-built の恩恵: 暗号化署名、SBOM、脆弱性スキャン

**Phase 2: 共有Embeddingサーバ**
- セットアップスクリプト or `npx @otolab/search-docs-mcp setup --shared` で
  Embeddingサーバの起動 + ネットワーク設定を自動化
- compose.yaml も提供（オプション）

**未解決: `docker mcp run` とネットワーク制御**
- Docker MCP Catalog プラグインとして起動した場合、ネットワークの指定ができるか要調査
- デフォルトネットワークに入ると、別途起動したEmbeddingサーバと通信できない可能性
- この場合、自動検出の3番（`host.docker.internal` 経由）でフォールバック可能
  - ただし Embeddingサーバの `-p 127.0.0.1:24281:8080` ポート公開が前提

### MLX / GPU の制約

- **Docker内でMLXは不可**（LinuxKit VMの壁）
- Docker内は**CPU-only運用**。ruri-v3-30mは軽量なのでCPU実用的
- MLXを使いたい場合: ホスト側でEmbeddingサーバを直接実行（Docker外）
  - 自動検出の3番 `http://localhost:24281/health` で繋がる

### リソース制限

```bash
# 単体利用時
docker run --memory=1g --cpus=1.5 --cpu-shares=512 ...

# 共有Embeddingサーバ
docker run --memory=1g --cpus=1.0 --cpu-shares=512 ...

# 軽量MCPサーバ（Embeddingサーバ共有時）
docker run --memory=512m --cpus=1.0 --cpu-shares=512 ...
```

## 実装上の検討事項

### 1. データの永続化

- `.search-docs/` ディレクトリ（LanceDBインデックス）はボリュームマウント必須
- 設定ファイル `.search-docs.json` の読み取りもマウント必要

### 2. パフォーマンス

- コンテナ起動のオーバーヘッド（数秒）
- ボリュームマウントのI/Oパフォーマンス（特にmacOS上のDocker）
- Embeddingモデルのロード時間

### 3. 開発ワークフローとの両立

- 開発時はホスト直接実行（高速なイテレーション）
- 配布・CI/テストではDocker化イメージを使用

### 4. CLI vs MCP Server

- → **まずMCP Serverのみ**をDocker化対象とする
- CLIはインタラクティブ操作があるためDocker化の恩恵が薄い

### 5. Python実行パスの調整

- 現状: `uv --project packages/db-engine run python ...` でPython Workerを起動
- Docker内: `.venv` を直接使えるので `uv` 経由は不要かもしれない
- db-engineの `createWorkerProcess()` のパス解決ロジックの調整が必要

### 6. embedding.py のHTTP対応

- `worker.py` の `self.embedding_model.encode()` をHTTP呼び出しに置換可能にする
- `EmbeddingModel` 基底クラスに `RemoteEmbeddingModel` 実装を追加
- 環境変数 or 自動検出で切り替え

## 参考リンク

- [Docker MCP Toolkit 公式](https://docs.docker.com/ai/mcp-catalog-and-toolkit/toolkit/)
- [Docker MCP Catalog](https://docs.docker.com/ai/mcp-catalog-and-toolkit/catalog/)
- [docker/mcp-registry](https://github.com/docker/mcp-registry)
- [github/github-mcp-server](https://github.com/github/github-mcp-server) - Docker化の参考実装
- [docker/mcp-gateway](https://github.com/docker/mcp-gateway) - Gateway構成の参考
- [MCP Server Best Practices (Docker)](https://www.docker.com/blog/mcp-server-best-practices/)
- [Docker MCP Horror Stories: Supply Chain](https://www.docker.com/blog/mcp-horror-stories-the-supply-chain-attack/)
- [nikolaik/python-nodejs](https://hub.docker.com/r/nikolaik/python-nodejs) - Node+Pythonイメージ
- [mcp-compose](https://github.com/phildougherty/mcp-compose) - Docker Compose MCP構成例
- [MCP Sidecar Pattern](https://hatasaki.medium.com/mcp-sidecar-pattern-89c7ca254db6) - sidecarパターン参考

## 次のステップ

1. [ ] Dockerfile のプロトタイプ作成・ビルド検証
2. [ ] entrypoint.sh のモード分岐実装
3. [ ] Embedding Server（FastAPI）の実装
4. [ ] Embeddingサーバ自動検出ロジック実装
5. [ ] RemoteEmbeddingModel の実装（HTTP経由encode）
6. [ ] 設定固定ルール（embeddingModel/vectorDimension）の実装
7. [ ] stdio transport での動作確認
8. [ ] リソース制限の検証
9. [ ] CI/CD パイプライン（GitHub Actions → ghcr.io）
10. [ ] Docker MCP Catalog へのPR準備

## 2026-04-14 調査メモ: Docker MCPサーバモードのファイル監視

### 今回の調査計画

1. `packages/server/src/discovery/file-watcher.ts` の呼び出し元を追跡する
2. `packages/mcp-server` と `docker/entrypoint.sh` から search-docs server 起動経路を確認する
3. `docker/compose.yaml` の mount 方式と watcher への影響を整理する
4. `file-watcher.test.ts` の失敗要因を実測し、watcher 本体と分離して確認する

### コード確認で確定した事実

- `FileWatcher` は `@parcel/watcher.subscribe(rootDir, ..., { ignore })` を直接呼ぶ実装
- `SearchDocsServer` は `config.watcher.enabled` が `true` のときだけ `new FileWatcher(...)` を作成し、`start()` で `await this.watcher.start()` を実行する
- `DEFAULT_CONFIG.watcher.enabled` は `true`
- Docker 用の `packages/server/src/bin/server.ts` は `embeddingUrl` / `embeddingModel` / `vectorDimension` は上書きするが、watcher 設定は変更しない
- Docker の `entrypoint.sh` は MCP サーバモードで最終的に `node packages/mcp-server/dist/server.js` を `exec` する
- Dockerfile の `WORKDIR` は `/app`
- MCP サーバ本体は `CONFIGURED_SERVER_DOWN` かつ index ディレクトリが存在する場合に `ServerManager.startServer(...)` で search-docs server を自動起動する
- `ServerManager.startServer(...)` は `node <cli> server start --port ... [--config ...]` を子プロセス起動する
- CLI `server start` は `@search-docs/server/dist/bin/server.js` を起動する
- `packages/mcp-server/src/server.ts` は `--project-dir` が未指定なら `process.cwd()` を使う
- したがって Docker 内で MCP サーバが search-docs server を起動した場合も、対象プロジェクトが解決されている限り、設定で無効化しない限り FileWatcher 起動経路に入る
- 一方で現行 Dockerfile + `compose.yaml` コメント例のままではカレントディレクトリは `/app` のままで、`/workspace` を volume mount しても自動ではそこを見ない
- `/workspace` を対象にするには `--project-dir /workspace` か `docker compose run -w /workspace ...` のどちらかが必要

### 実測メモ

- `pnpm -C packages/server test -- --run src/discovery/__tests__/file-watcher.test.ts` は watcher テスト実行前に失敗
- 失敗箇所は `packages/server/vitest.config.ts` が参照する `../db-engine/src/__tests__/globalSetup.ts`
- 失敗メッセージは `failed to open file /Users/naoto.kato/.cache/uv/sdists-v9/.git: Operation not permitted`
- つまりこの失敗は watcher イベント未着より前段の embedding server 起動失敗
- 最小再現として `packages/server` 配下で `@parcel/watcher.subscribe()` を直接呼ぶ Node スクリプトを実行したところ、macOS 側で `Error starting FSEvents stream` で失敗
- この実測から、現在の作業環境では watcher の native backend 初期化自体が失敗している

### 補足

- `docs/file-watcher-design.md` には `markDirty()` / `deleteDocument()` とあるが、現行コードでは add/change 時に storage 保存と `createIndexRequest()`、unlink 時に `deleteSectionsByPath()` と storage 削除を行っている

## 2026-04-14 実装完了: Docker MCP サーバの動作確認とバグ修正

### 実装完了内容

基本的なDocker化実装が完了し、実際の動作確認を行ったところ、複数のバグを発見・修正しました。

### 発見・修正したバグ

#### 1. entrypoint.sh - check_health の bare except バグ

**問題**: 
- Python の `except:` が `exit(0)` の `SystemExit` をキャッチし、常に exit(1) で終了
- ヘルスチェックが常に失敗していた

**修正**: 
```bash
# 修正前
except:
    exit(1)

# 修正後
except Exception:
    exit(1)
```

**ファイル**: `docker/entrypoint.sh`

#### 2. Dockerfile - libssl3 不足

**問題**: 
- ランタイムイメージ (node:22-slim) に libssl.so.3 がなく、pyarrow/lancedb が動かない
- エラー: `ImportError: libssl.so.3: cannot open shared object file`

**修正**: 
- `apt-get install libssl3` をランタイムステージに追加

**ファイル**: `Dockerfile`

#### 3. Dockerfile - db-engine/.venv 未作成

**問題**: 
- db-engine の Python 依存関係用 .venv がビルドされておらず、uv run が権限エラー
- エラー: `Permission denied: '/app/.cache/uv/...'`

**修正**: 
- ビルドステージで `uv sync --project packages/db-engine` を追加
- ランタイムにコピー＆権限付与

**ファイル**: `Dockerfile`

#### 4. Dockerfile - UV_CACHE_DIR 権限エラー

**問題**: 
- appuser が /home/appuser/.cache/uv を作れない
- エラー: `Permission denied: '/home/appuser/.cache/uv'`

**修正**: 
- `ENV UV_CACHE_DIR=/app/.cache/uv` を追加

**ファイル**: `Dockerfile`

#### 5. server.ts - Docker 環境の IPv4/IPv6 バインドミスマッチ

**問題**: 
- Docker 内で `localhost` が IPv6 (::1) に解決され、Express がIPv6のみにバインド
- Node.js fetch は IPv4 で接続して失敗
- エラー: `ECONNREFUSED 127.0.0.1:24280`

**根本原因**:
```javascript
// Express のデフォルト動作
app.listen(port, 'localhost')  // → IPv6 (::1) にのみバインド

// Node.js fetch の動作
fetch('http://localhost:24280/health')  // → IPv4 (127.0.0.1) に接続
```

**修正**: 
- Docker 環境検出時に `0.0.0.0` にバインドするよう変更
- 環境変数 `IS_DOCKER=true` で Docker 環境を識別
- Docker 外では従来通り `localhost` を使用（セキュリティ維持）

**ファイル**: `packages/server/src/bin/server.ts`

**実装詳細**:
```typescript
const isDocker = process.env.IS_DOCKER === 'true';
const host = isDocker ? '0.0.0.0' : 'localhost';
```

#### 6. .mcp.json - Docker MCP 設定追加

**追加内容**:
- 2つのMCPサーバ構成を定義:
  - `search-docs`: Docker版（本番用）
  - `search-docs-local`: ローカル開発版

**ファイル**: `.mcp.json`

### 技術的な学び

#### IPv4/IPv6 バインディングの挙動

- **`localhost` の解決**:
  - Linux/Docker: IPv6 (::1) が優先される場合がある
  - macOS: IPv4 (127.0.0.1) と IPv6 (::1) の両方に解決されることが多い

- **Express の listen()**:
  - `app.listen(port, 'localhost')`: OSの名前解決に依存
  - Docker 内では IPv6 のみにバインドされる可能性
  
- **Node.js fetch の接続**:
  - 実装依存で IPv4 を優先する場合がある
  - DNS解決結果と異なるプロトコルで接続して失敗

- **解決策**:
  - Docker 内: `0.0.0.0` で IPv4/IPv6 両方にバインド
  - ホスト: `localhost` でセキュリティを維持

#### Python の except 構文の落とし穴

- `except:` は `SystemExit`, `KeyboardInterrupt` も含むすべての例外をキャッチ
- `exit(0)` の成功終了も例外として扱われ、意図しない動作に
- ベストプラクティス: `except Exception:` を使用

### 影響範囲

これらの修正により、Docker MCP サーバが正常に動作するようになりました:

1. ヘルスチェックが正常に機能
2. Python依存関係が正しく解決
3. Docker内でのネットワーク通信が安定
4. セキュリティを維持しながら環境間の互換性を確保

### 次のステップ

- [ ] Docker Compose での共有 Embedding サーバ構成のテスト
- [ ] Docker MCP Catalog への登録準備
- [ ] CI/CD パイプライン構築

## 2026-04-15 追加修正: ファイルウォッチャーのDocker対応

### バグ6: @parcel/watcher - Docker bind mountでinotifyイベント非伝播

**問題**:
- @parcel/watcher 2.5.1ではDocker bind mountのマウントポイント直下をsubscribeするとinotifyイベントが伝播しなかった
- Docker環境でファイル変更を検知できず、自動インデックス更新が動作しなかった

**原因**:
- @parcel/watcher 2.5.1のLinux inotify実装がbind mountのマウントポイント直下を正しく監視できない既知のバグ

**修正**:
- @parcel/watcher 2.5.1 → 2.5.6 に更新
- 2.5.6でDockerボリュームマウントのinotifyイベント伝播が修正された

**影響範囲**:
- `packages/server/package.json` の依存関係更新
- Docker MCP サーバモードでのファイル監視機能の正常化

### バグ7: file-watcher.ts - extglobパターンによるイベント消失

**問題**:
- ignoreオプションに `**/*.!(md)` / `**/!(*.md)` といったextglobパターンを指定すると、picomatchがC++ regexに変換する際に極端に遅延
- Docker環境でファイル変更イベントがタイムアウトし、事実上イベントが届かない状態になっていた
- ローカル環境では発生しないがDocker環境で顕著に現れる（I/Oレイテンシの差）

**原因**:
- picomatchのextglobサポートがC++側のregex実装と組み合わさったときのパフォーマンス劣化
- `!(pattern)` 否定パターンの複雑度が高い
- Docker bind mount環境では元々I/Oレイテンシが高く、regex評価の遅延が致命的に

**修正**:
- ignoreオプションからextglobパターン（`**/*.!(md)`, `**/!(*.md)`）を削除
- `.md`ファイルのフィルタリングは既存の `shouldProcessFile()` メソッドに委譲
  - `shouldProcessFile()` は既に拡張子チェックを実装済み
  - ignoreとの役割分担を明確化: ignore=ディレクトリ除外、shouldProcessFile=ファイル種別フィルタ

**実装詳細**:
```typescript
// 修正前
const ignorePatterns = [
  ...DEFAULT_EXCLUDE_PATTERNS,
  '**/*.!(md)',      // .md以外を除外
  '**/!(*.md)',      // 別形式の否定パターン
];

// 修正後
const ignorePatterns = [
  ...DEFAULT_EXCLUDE_PATTERNS,
  // extglobパターンは削除
  // .mdフィルタはshouldProcessFile()に委譲
];
```

**影響範囲**:
- `packages/server/src/discovery/file-watcher.ts`
- Docker MCP サーバモードでのファイル監視機能の正常化
- ローカル環境では既存の挙動を維持（shouldProcessFile()が同じフィルタを実行）

**技術的な学び**:
- picomatchのextglobパターンはJavaScript環境では高速だが、C++実装（@parcel/watcher）との連携ではボトルネックになる可能性
- Docker bind mount環境では正規表現評価のような軽微な遅延も積み重なって顕在化する
- 責務分離: ignoreはパス除外、拡張子フィルタはアプリケーションロジックで行うべき
