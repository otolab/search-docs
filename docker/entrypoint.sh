#!/bin/bash
set -euo pipefail

# Python実行: .venvが利用可能な場合は直接実行（Docker内）
# PYTHONPATHにdb-engineのPythonソースを追加（相対インポート解決）
export PYTHONPATH="/app/packages/db-engine/src/python:${PYTHONPATH:-}"

run_python() {
  if [ -x /app/.venv/bin/python ]; then
    exec /app/.venv/bin/python "$@"
  else
    exec uv --project /app run python "$@"
  fi
}

case "${1:-}" in
  --mode=embedding-server)
    # Embeddingサーバモード: HTTPで待ち受け
    run_python \
      packages/db-engine/src/python/embedding_server.py \
      --port="${EMBEDDING_SERVER_PORT:-8080}"
    ;;
  *)
    # MCPサーバモード（デフォルト）: stdio通信
    exec node packages/mcp-server/dist/server.js "$@"
    ;;
esac
