#!/bin/bash
set -euo pipefail

export PYTHONPATH="/app/packages/db-engine/src/python:${PYTHONPATH:-}"

# Python実行ヘルパー（exec付き、フォアグラウンド用）
run_python() {
  if [ -x /app/.venv/bin/python ]; then
    exec /app/.venv/bin/python "$@"
  else
    exec uv --project /app run python "$@"
  fi
}

# Python実行ヘルパー（exec無し、バックグラウンド用）
start_python() {
  if [ -x /app/.venv/bin/python ]; then
    /app/.venv/bin/python "$@" &
  else
    uv --project /app run python "$@" &
  fi
}

# Health check（python使用、curl不要）
check_health() {
  local url="$1"
  local python_cmd
  if [ -x /app/.venv/bin/python ]; then
    python_cmd="/app/.venv/bin/python"
  else
    python_cmd="python"
  fi
  $python_cmd -c "
import urllib.request
try:
    urllib.request.urlopen('${url}', timeout=1)
    exit(0)
except:
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
    if check_health "${url}/health"; then
      echo "Embedding server is ready" >&2
      return 0
    fi
    sleep 1
    elapsed=$((elapsed + 1))
  done
  echo "ERROR: Embedding server did not respond within ${max_wait}s" >&2
  return 1
}

# Embedding server の検出
detect_embedding_server() {
  local port="${EMBEDDING_SERVER_PORT:-24281}"

  # 1. EMBEDDING_URL が明示設定されている場合
  if [ -n "${EMBEDDING_URL:-}" ]; then
    if check_health "${EMBEDDING_URL}/health"; then
      echo "${EMBEDDING_URL}"
      return 0
    fi
    echo "WARNING: EMBEDDING_URL=${EMBEDDING_URL} is set but not responding" >&2
  fi

  # 2. Docker network内のサービス名
  if check_health "http://search-docs-embedding:8080/health"; then
    echo "http://search-docs-embedding:8080"
    return 0
  fi

  # 3. ホスト側サービス
  if check_health "http://host.docker.internal:${port}/health"; then
    echo "http://host.docker.internal:${port}"
    return 0
  fi

  # 見つからなかった
  return 1
}

case "${1:-}" in
  --mode=embedding-server)
    run_python \
      packages/db-engine/src/python/embedding_server.py \
      --port="${EMBEDDING_SERVER_PORT:-8080}"
    ;;
  *)
    # MCPサーバモード
    EMBEDDING_PORT="${EMBEDDING_SERVER_PORT:-8080}"

    # Embedding server を検出
    if detected_url=$(detect_embedding_server); then
      echo "Using external embedding server: ${detected_url}" >&2
      export EMBEDDING_URL="${detected_url}"
    else
      # ローカルで起動
      echo "No external embedding server found, starting local..." >&2
      start_python \
        packages/db-engine/src/python/embedding_server.py \
        --port="${EMBEDDING_PORT}"
      EMBEDDING_PID=$!

      if ! wait_for_embedding "http://localhost:${EMBEDDING_PORT}"; then
        kill "${EMBEDDING_PID}" 2>/dev/null || true
        exit 1
      fi

      trap "kill ${EMBEDDING_PID} 2>/dev/null || true" EXIT TERM INT
      export EMBEDDING_URL="http://localhost:${EMBEDDING_PORT}"
    fi

    exec node packages/mcp-server/dist/server.js "$@"
    ;;
esac
