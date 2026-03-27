---
"@search-docs/server": patch
"@search-docs/db-engine": patch
"@search-docs/cli": patch
"@search-docs/types": patch
---

server.logローテーション導入と巨大ファイル読み込み防止

- RotatingWriteStreamによるログローテーション（1MB/3世代）を導入
- パフォーマンスログのstderrBuffer蓄積を停止しメモリリーク防止
- FilesConfigにmaxFileSize（デフォルト10MB）を追加し、超過ファイルの読み込みをスキップ
