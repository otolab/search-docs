# ============================================================
# search-docs MCP Server - Docker Image
# 1イメージ・2モード: MCPサーバ / Embeddingサーバ
# ============================================================

# ============================================================
# Stage 1: Python依存関係 + モデルダウンロード
# ============================================================
# bookwormで統一（node:22-slim のGLIBCバージョンと合わせる）
FROM python:3.12-slim-bookworm AS python-deps

COPY --from=ghcr.io/astral-sh/uv:latest /uv /usr/local/bin/uv

WORKDIR /app

# Python依存関係のインストール（ルートのpyproject.toml + uv.lock を使用）
COPY pyproject.toml uv.lock ./
COPY packages/db-engine/pyproject.toml packages/db-engine/
RUN uv sync --frozen --no-dev

# Embeddingモデルを事前ダウンロード（ビルド時にイメージに焼き込み）
ENV HF_HOME=/app/.cache/huggingface
RUN uv run python -c "from sentence_transformers import SentenceTransformer; SentenceTransformer('cl-nagoya/ruri-v3-30m')"

# ============================================================
# Stage 2: Node.jsビルド
# ============================================================
FROM node:22-slim AS node-build

RUN corepack enable && corepack prepare pnpm@9.14.4 --activate

WORKDIR /app

# pnpm依存関係のインストール（各パッケージのpackage.jsonを先にコピーしてキャッシュ活用）
COPY pnpm-workspace.yaml pnpm-lock.yaml package.json ./
COPY packages/types/package.json packages/types/
COPY packages/storage/package.json packages/storage/
COPY packages/db-engine/package.json packages/db-engine/
COPY packages/server/package.json packages/server/
COPY packages/client/package.json packages/client/
COPY packages/cli/package.json packages/cli/
COPY packages/mcp-server/package.json packages/mcp-server/
# packages/agent はまだ未リリースのため除外
RUN pnpm install --frozen-lockfile --prod=false

# TypeScriptビルド
COPY tsconfig.json tsconfig.base.json ./
COPY packages/ packages/
RUN pnpm run build:all

# ============================================================
# Stage 3: 実行イメージ
# ============================================================
FROM node:22-slim AS runtime

# Python + uv をpython-depsステージからコピー
COPY --from=python-deps /usr/local/ /usr/local/
COPY --from=python-deps /app/.venv /app/.venv
COPY --from=python-deps /app/.cache /app/.cache
COPY --from=ghcr.io/astral-sh/uv:latest /uv /usr/local/bin/uv

WORKDIR /app

# Node.jsビルド成果物をコピー
COPY --from=node-build /app/node_modules ./node_modules
COPY --from=node-build /app/packages ./packages
COPY --from=node-build /app/package.json ./
COPY --from=node-build /app/pnpm-workspace.yaml ./

# Python設定ファイル（uv --project で必要）
COPY pyproject.toml uv.lock ./

# エントリポイントスクリプト
COPY docker/entrypoint.sh ./entrypoint.sh

# 非rootユーザーの作成と権限設定
RUN groupadd --system --gid 1001 appgroup && \
    useradd --system --uid 1001 --gid appgroup appuser && \
    chmod +x ./entrypoint.sh && \
    chown -R appuser:appgroup /app/.cache
USER appuser

# 環境変数
ENV PYTHONUNBUFFERED=1
ENV TOKENIZERS_PARALLELISM=false
ENV NODE_ENV=production
ENV HF_HOME=/app/.cache/huggingface

# Docker設定固定: イメージ内蔵モデルに強制
ENV SEARCH_DOCS_DOCKER_EMBEDDING_MODEL=cl-nagoya/ruri-v3-30m
ENV SEARCH_DOCS_DOCKER_VECTOR_DIMENSION=256

# オフラインモード: モデルは焼き込み済み、ネットワーク不要
ENV HF_HUB_OFFLINE=1
ENV TRANSFORMERS_OFFLINE=1

ENTRYPOINT ["./entrypoint.sh"]
CMD []
