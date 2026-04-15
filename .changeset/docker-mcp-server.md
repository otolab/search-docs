---
"@search-docs/db-engine": minor
"@search-docs/server": minor
"@search-docs/mcp-server": minor
---

Docker化対応: Embedding Server（HTTP API）、RemoteEmbeddingModel（自動検出付き）、Docker環境での設定固定ルールを追加

**バグ修正**:
- entrypoint.sh: check_health の bare except バグ修正（SystemExit が誤ってキャッチされる問題）
- Dockerfile: libssl3 追加（pyarrow/lancedb の依存関係）
- Dockerfile: db-engine/.venv のビルド・権限設定
- Dockerfile: UV_CACHE_DIR の権限エラー対策
- server.ts: Docker環境でのIPv4/IPv6バインドミスマッチ修正（0.0.0.0 バインド）
- @parcel/watcher: 2.5.1 → 2.5.6 に更新（Docker bind mountでinotifyイベント非伝播の修正）
- file-watcher.ts: extglobパターン削除（picomatch→C++ regexの遅延によるイベント消失の修正）
- .mcp.json: Docker MCP サーバ設定追加
