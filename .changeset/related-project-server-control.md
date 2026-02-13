---
"@search-docs/mcp-server": patch
---

関連プロジェクトのサーバをserver_start/server_stopで明示的に制御可能に

- server_start/server_stopにprojectパラメータを追加
- search/get_document/get_outlineでの関連プロジェクトサーバの自動起動を削除
- ServerManagerにgetServer/stopRelatedServerメソッドを追加
