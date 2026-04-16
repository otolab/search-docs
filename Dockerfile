# ============================================================
# search-docs MCP Server - Docker Image
# 1イメージ・2モード: MCPサーバ / Embeddingサーバ
# ============================================================

# ============================================================
# Stage 1: Python依存関係 + モデルダウンロード
# ============================================================
# bookwormで統一（node:22-slim のGLIBCバージョンと合わせる）
FROM python:3.12-slim-bookworm AS python-deps

ARG RUNTIME_TYPE=cpu

COPY --from=ghcr.io/astral-sh/uv:latest /uv /usr/local/bin/uv

WORKDIR /app

# ONNX Runtime（CPU or GPU）
RUN if [ "$RUNTIME_TYPE" = "gpu" ]; then \
      uv pip install --system "onnxruntime-gpu>=1.20.0"; \
    else \
      uv pip install --system "onnxruntime>=1.20.0"; \
    fi

# Python依存関係をシステムに直接インストール（.venv を作らない）
# torch/sentence-transformers は不要（ONNX Runtime + transformers tokenizer のみ）
RUN uv pip install --system \
    "lancedb==0.25.3" \
    "pyarrow==22.0.0" \
    "pandas==2.3.3" \
    "numpy==2.3.5" \
    "transformers>=4.48.0" \
    "huggingface-hub>=0.27.0" \
    "protobuf==6.33.1" \
    "sentencepiece==0.2.1" \
    "psutil==7.1.3" \
    "duckdb==1.4.2"

# ONNXモデルを事前ダウンロード（ビルド時にイメージに焼き込み）
RUN python -c "from huggingface_hub import snapshot_download; \
    snapshot_download('sirasagi62/ruri-v3-30m-ONNX', \
    local_dir='/app/.cache/models/ruri-v3-30m-onnx', \
    allow_patterns=['onnx/model.onnx', '*.json', '*.txt', '*.model'])"

# ============================================================
# Stage 2: Node.jsビルド + pnpm deploy
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
RUN pnpm install --frozen-lockfile --prod=false

# TypeScriptビルド
COPY tsconfig.json tsconfig.base.json ./
COPY packages/ packages/
RUN pnpm run build:all

# pnpm deploy で最小デプロイパッケージを作成
# workspace依存を解決し、filesフィールドに従って必要ファイルのみコピー
RUN pnpm --filter @search-docs/mcp-server deploy /app/deploy --prod

# Pythonスクリプトへの固定パスシンボリックリンクを作成
# （pnpm .pnpm ストア内の深いパスを隠蔽、相対パスでコピー先に依存しない）
RUN PYTHON_DIR=$(find /app/deploy -path "*/db-engine/src/python" -type d | head -1) && \
    RELATIVE_DIR=${PYTHON_DIR#/app/deploy/} && \
    ln -sf "$RELATIVE_DIR" /app/deploy/python

# ============================================================
# Stage 3: 実行イメージ（最小構成）
# ============================================================
# python:3.12-slim をベースに使うことで、Pythonランタイムのコピーが不要
# Node.js はバイナリだけコピーする
FROM python:3.12-slim-bookworm AS runtime

# pyarrow/lancedb が必要とするシステムライブラリ
RUN apt-get update && apt-get install -y --no-install-recommends libssl3 && rm -rf /var/lib/apt/lists/*

# 非rootユーザーの作成（先に作成し、以降の COPY で --chown を使う）
RUN groupadd --system --gid 1001 appgroup && \
    useradd --system --uid 1001 --gid appgroup appuser

# Node.js バイナリだけコピー（node:22-slim 全体は不要）
COPY --from=node:22-slim /usr/local/bin/node /usr/local/bin/node

# Python パッケージのみコピー（Pythonランタイム本体はベースイメージにある）
COPY --from=python-deps --chown=appuser:appgroup \
    /usr/local/lib/python3.12/site-packages/ \
    /usr/local/lib/python3.12/site-packages/

# ONNXモデルキャッシュ
COPY --from=python-deps --chown=appuser:appgroup /app/.cache /app/.cache

# pnpm deploy 出力（node_modules + dist + Python scripts）
WORKDIR /app
COPY --from=node-build --chown=appuser:appgroup /app/deploy /app

# エントリポイントスクリプト
COPY --chown=appuser:appgroup docker/entrypoint.sh ./entrypoint.sh
RUN chmod +x ./entrypoint.sh

USER appuser

# 環境変数
ENV PYTHONUNBUFFERED=1
ENV TOKENIZERS_PARALLELISM=false
ENV NODE_ENV=production
ENV IS_DOCKER=true

# Docker設定固定: イメージ内蔵モデルに強制
ENV SEARCH_DOCS_DOCKER_EMBEDDING_MODEL=ruri-v3-30m-onnx
ENV SEARCH_DOCS_DOCKER_VECTOR_DIMENSION=256
ENV SEARCH_DOCS_DOCKER_EMBEDDING_URL=http://localhost:8080
ENV SEARCH_DOCS_DOCKER_MODEL_PATH=/app/.cache/models/ruri-v3-30m-onnx

# オフラインモード: モデルは焼き込み済み、ネットワーク不要
ENV HF_HUB_OFFLINE=1
ENV TRANSFORMERS_OFFLINE=1

ENTRYPOINT ["./entrypoint.sh"]
CMD []
