---
"@search-docs/mcp-server": patch
"@search-docs/server": patch
"@search-docs/storage": patch
---

MCPサーバ停止プロセス改善

- FileStorageをatomic write（tmp→rename）に変更し、kill時のデータ破損を防止
- MCPサーバのシグナルハンドラを改善し、即座に終了するように
- stopServiceを同期化（mastershipリリース・子プロセス終了待ちを廃止）
