---
"@search-docs/server": minor
"@search-docs/types": minor
"@search-docs/mcp-server": minor
"@search-docs/cli": minor
---

feat: files.include → files.sources リネーム + shallow/deep ツリーウォーク監視

- `files.include` を `files.sources` にリネーム（`include` は非推奨、後方互換あり）
- パターンの `**` 有無で shallow/deep 監視を自動判定
- ツリーウォーク方式でディレクトリを枝刈りしながら監視ターゲットを構築
- shallow subscription に暗黙的ignoreを追加し、不要なinotify走査を排除
- COMMON_IGNORES拡充（`.pnpm-store`, `.yarn`, `.uv`, `__pycache__`等）
- CI: release-prepareでchangeset消費済みの場合にコミットをスキップ
