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

# Embedding server を起動する共通関数
start_embedding_server() {
  local port="${1:-8080}"

  if detected_url=$(detect_embedding_server); then
    echo "Using external embedding server: ${detected_url}" >&2
    export EMBEDDING_URL="${detected_url}"
    return 0
  fi

  # ローカルで起動
  echo "No external embedding server found, starting local..." >&2
  start_python \
    "${PYTHON_DIR}/embedding_server.py" \
    --port="${port}" \
    --runtime="${EMBEDDING_RUNTIME:-onnx}" \
    --model-path="${SEARCH_DOCS_DOCKER_MODEL_PATH:-/app/.cache/models/ruri-v3-30m-onnx}" \
    --dimension="${SEARCH_DOCS_DOCKER_VECTOR_DIMENSION:-256}"
  EMBEDDING_PID=$!

  if ! wait_for_embedding "http://localhost:${port}"; then
    kill "${EMBEDDING_PID}" 2>/dev/null || true
    return 1
  fi

  export EMBEDDING_URL="http://localhost:${port}"
  return 0
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
    EMBEDDING_PORT="${EMBEDDING_SERVER_PORT:-8080}"
    PIDS_TO_KILL=""

    cleanup() {
      for pid in $PIDS_TO_KILL; do
        kill "$pid" 2>/dev/null || true
      done
    }
    trap cleanup EXIT TERM INT

    # Watcher 起動判定
    if [ "${ENABLE_WATCHER:-}" = "true" ]; then
      echo "Starting Watcher process..." >&2

      # Embedding server が必要（Watcher がインデックス更新するため）
      if ! start_embedding_server "${EMBEDDING_PORT}"; then
        echo "ERROR: Failed to start embedding server for Watcher" >&2
        exit 1
      fi
      if [ -n "${EMBEDDING_PID:-}" ]; then
        PIDS_TO_KILL="${PIDS_TO_KILL} ${EMBEDDING_PID}"
      fi

      # Watcher をバックグラウンドで起動
      node dist/bin/watcher.js &
      WATCHER_PID=$!
      PIDS_TO_KILL="${PIDS_TO_KILL} ${WATCHER_PID}"
      echo "Watcher started (PID: ${WATCHER_PID})" >&2
    fi

    # MCP サーバ起動（常に read-only）
    exec node dist/server.js "$@"
    ;;
esac
