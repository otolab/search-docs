---
"@search-docs/cli": minor
"@search-docs/mcp-server": minor
"@search-docs/server": patch
"@search-docs/storage": patch
---

index purge コマンド追加とMCPサーバ停止プロセス改善

- CLI `index purge` / MCP `index_purge` ツールを追加（インデックスファイルの全削除）
- FileStorageをatomic write（tmp→rename）に変更し、kill時のデータ破損を防止
- MCPサーバのシグナルハンドラを改善し、即座に終了するように
