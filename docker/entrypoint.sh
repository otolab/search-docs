#!/bin/bash
set -euo pipefail

# Python scripts パス（pnpm deploy + シンボリックリンク経由）
PYTHON_DIR="/app/python"
export PYTHONPATH="${PYTHON_DIR}:${PYTHONPATH:-}"

# Docker内では python コマンドに統一（.venv/uv 不要）
run_python() {
  exec python "$@"
}

start_python() {
  python "$@" &
}

# Ollama API互換チェック（/api/tags で確認、python使用・curl不要）
check_api() {
  local url="$1"
  python -c "
import urllib.request
try:
    urllib.request.urlopen('${url}', timeout=1)
    exit(0)
except Exception:
    exit(1)
" 2>/dev/null
}

# Embedding server の待機
wait_for_embedding() {
  local url="$1"
  local max_wait=30
  local elapsed=0
  echo "Waiting for embedding server at ${url}..." >&2
  while [ $elapsed -lt $max_wait ]; do
    if check_api "${url}/api/tags"; then
      echo "Embedding server is ready" >&2
      return 0
    fi
    sleep 1
    elapsed=$((elapsed + 1))
  done
  echo "ERROR: Embedding server did not respond within ${max_wait}s" >&2
  return 1
}

# Embedding server の検出（Ollama API互換: /api/tags で確認）
detect_embedding_server() {
  local port="${EMBEDDING_SERVER_PORT:-24281}"

  # 1. EMBEDDING_URL が明示設定されている場合
  if [ -n "${EMBEDDING_URL:-}" ]; then
    if check_api "${EMBEDDING_URL}/api/tags"; then
      echo "${EMBEDDING_URL}"
      return 0
    fi
    echo "WARNING: EMBEDDING_URL=${EMBEDDING_URL} is set but not responding" >&2
  fi

  # 2. Docker network内のサービス名（共有Embeddingサーバ）
  if check_api "http://search-docs-embedding:8080/api/tags"; then
    echo "http://search-docs-embedding:8080"
    return 0
  fi

  # 3. ホスト側自前サーバ
  if check_api "http://host.docker.internal:${port}/api/tags"; then
    echo "http://host.docker.internal:${port}"
    return 0
  fi

  # 見つからなかった
  return 1
}

case "${1:-}" in
  --mode=embedding-server)
    run_python \
      "${PYTHON_DIR}/embedding_server.py" \
      --port="${EMBEDDING_SERVER_PORT:-8080}" \
      --runtime="${EMBEDDING_RUNTIME:-onnx}" \
      --model-path="${SEARCH_DOCS_DOCKER_MODEL_PATH:-/app/.cache/models/ruri-v3-30m-onnx}" \
      --dimension="${SEARCH_DOCS_DOCKER_VECTOR_DIMENSION:-256}"
    ;;
  *)
    # MCPサーバモード

    # Read-onlyモード: embedding server 不要（検索のみ）
    if [ "${READ_ONLY:-}" = "true" ]; then
      echo "Starting in READ-ONLY mode (no embedding server)" >&2
      exec node dist/server.js "$@"
    fi

    # 通常モード: embedding server が必要
    EMBEDDING_PORT="${EMBEDDING_SERVER_PORT:-8080}"

    # Embedding server を検出
    if detected_url=$(detect_embedding_server); then
      echo "Using external embedding server: ${detected_url}" >&2
      export EMBEDDING_URL="${detected_url}"
    else
      # ローカルで起動
      echo "No external embedding server found, starting local..." >&2
      start_python \
        "${PYTHON_DIR}/embedding_server.py" \
        --port="${EMBEDDING_PORT}" \
        --runtime="${EMBEDDING_RUNTIME:-onnx}" \
        --model-path="${SEARCH_DOCS_DOCKER_MODEL_PATH:-/app/.cache/models/ruri-v3-30m-onnx}" \
        --dimension="${SEARCH_DOCS_DOCKER_VECTOR_DIMENSION:-256}"
      EMBEDDING_PID=$!

      if ! wait_for_embedding "http://localhost:${EMBEDDING_PORT}"; then
        kill "${EMBEDDING_PID}" 2>/dev/null || true
        exit 1
      fi

      trap "kill ${EMBEDDING_PID} 2>/dev/null || true" EXIT TERM INT
      export EMBEDDING_URL="http://localhost:${EMBEDDING_PORT}"
    fi

    exec node dist/server.js "$@"
    ;;
esac
