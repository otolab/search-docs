#!/bin/bash
set -euo pipefail

# Python scripts パス（pnpm deploy + シンボリックリンク経由）
PYTHON_DIR="/app/python"
export PYTHONPATH="${PYTHON_DIR}:${PYTHONPATH:-}"

# Docker内では python コマンドに統一（.venv/uv 不要）
run_python() {
  exec python "$@"
}

case "${1:-}" in
  --mode=embedding-server)
    # スタンドアロン Embedding サーバ（Docker Compose での共有サーバ用）
    run_python \
      "${PYTHON_DIR}/embedding_server.py" \
      --port="${EMBEDDING_SERVER_PORT:-24281}" \
      --runtime="${EMBEDDING_RUNTIME:-onnx}" \
      --model-path="${SEARCH_DOCS_DOCKER_MODEL_PATH:-/app/.cache/models/ruri-v3-30m-onnx}" \
      --dimension="${SEARCH_DOCS_DOCKER_VECTOR_DIMENSION:-256}"
    ;;
  *)
    # MCPサーバモード（TS側がEmbeddingサーバを管理）
    # --project-dir 省略時は /workspace をデフォルトにする
    if [[ ! " $* " =~ " --project-dir " ]]; then
      exec node dist/server.js --project-dir /workspace "$@"
    else
      exec node dist/server.js "$@"
    fi
    ;;
esac
