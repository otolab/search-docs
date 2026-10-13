#!/usr/bin/env bash
# Build full search-docs index, wait until idle, then exit (before Environment Version Save).
set -euo pipefail
cd "$(dirname "$0")/../.."
export PATH="${HOME}/.local/bin:${PATH}"

SEARCH_DOCS_CLI="${SEARCH_DOCS_CLI:-@search-docs/cli@1.3.1}"

npx -y "${SEARCH_DOCS_CLI}" server stop 2>/dev/null || true
npx -y "${SEARCH_DOCS_CLI}" embedding stop --force 2>/dev/null || true

npx -y "${SEARCH_DOCS_CLI}" server start
node scripts/cloud-agent/wait-search-docs-index.mjs

echo ""
echo "Index idle. Next: Cloud Agents dashboard → Environment → Save (new version)."
echo "  Persists HF cache under ~/.cache/huggingface and storage paths from .search-docs.json"
echo "Optional: npx -y ${SEARCH_DOCS_CLI} server stop"
