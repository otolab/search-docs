---
"@search-docs/db-engine": patch
"@search-docs/server": patch
"@search-docs/types": patch
---

メモリリーク解決とコードクリーンアップ

- TOKENIZERS_PARALLELISM=false自動設定でメモリリーク98.5%削減
- pythonMaxMemoryMBデフォルト8GBに変更
- メモリ監視・自動再起動機能の追加
- 実験用コードの削除とリファクタリング
- スレッドダンプログをDEBUGモード時のみ有効化
