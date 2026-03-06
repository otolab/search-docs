---
"@search-docs/mcp-server": minor
"@search-docs/types": patch
---

add_related_project MCPツールを追加

- 関連プロジェクトを一時的にメモリ上で追加するツールを実装
- 指定ディレクトリの .search-docs.json 存在チェックと名前重複チェックを実施
- 既存ツール（list_related_projects, server_start, system_status）で一時追加分も参照するよう統合
- RelatedProjectConfig型をエクスポートに追加
