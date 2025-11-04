---
"@search-docs/db-engine": patch
"@search-docs/server": patch
"@search-docs/cli": patch
"@search-docs/mcp-server": patch
---

fix(db-engine): テーブルハンドルをキャッシュしてメモリリークを修正

open_table()を繰り返し呼ぶと各インスタンスが独自のindex/metadataキャッシュを持ち、メモリを消費する問題を修正。LanceDBのベストプラクティスに従い、テーブルハンドルを一度だけ開いて再利用するよう変更。
