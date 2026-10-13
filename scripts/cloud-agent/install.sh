#!/usr/bin/env bash
# Cloud Agent Build `install`: uv + Ruri ONNX (HF cache). Does NOT build the search-docs index.
set -euo pipefail
cd "$(dirname "$0")/../.."

install_uv() {
  if command -v uv >/dev/null 2>&1; then
    return 0
  fi

  local attempt
  for attempt in 1 2 3 4 5; do
    if curl -fsSL --retry 5 --retry-all-errors --retry-delay 2 \
      https://astral.sh/uv/install.sh \
      | env UV_INSTALL_DIR="${HOME}/.local/bin" UV_NO_MODIFY_PATH=1 sh; then
      break
    fi
    if [[ "${attempt}" -eq 5 ]]; then
      echo "cloud-agent/install: failed to download uv from astral.sh after ${attempt} attempts" >&2
      exit 1
    fi
    sleep $((attempt * 2))
  done

  sudo install -m 0755 "${HOME}/.local/bin/uv" /usr/local/bin/uv
  sudo install -m 0755 "${HOME}/.local/bin/uvx" /usr/local/bin/uvx
}

install_uv
uv --version

if [[ -f pnpm-lock.yaml ]]; then
  corepack enable
  pnpm install --frozen-lockfile
fi

HF_PREFETCH_DIR="scripts/hf-prefetch"
echo "Installing huggingface_hub (uv project: ${HF_PREFETCH_DIR})..."
uv sync --directory "${HF_PREFETCH_DIR}"

echo "Prefetching Ruri ONNX (HF_HUB_DISABLE_XET=1, LFS-friendly for egress)..."
export HF_HUB_DISABLE_XET="${HF_HUB_DISABLE_XET:-1}"
uv run --directory "${HF_PREFETCH_DIR}" python prefetch_ruri_onnx.py

echo "cloud-agent/install: done (index not built; see docs/cloud-agent-deployment.md)"
