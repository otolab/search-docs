---
"@search-docs/db-engine": patch
---

DuckDB統合によるget_stats()の高速化

Index Status表示のパフォーマンス問題を解決しました。LanceDB公式推奨のDuckDB統合を使用し、ユニークカウント処理を最適化しました。

- パフォーマンス改善: タイムアウト(30秒以上) → 約6秒
- DuckDB依存関係を追加（duckdb>=0.9.0）
- get_stats()メソッドでCOUNT(DISTINCT document_path)を使用

注意: この変更後、`uv sync`によるDuckDBのインストールとサーバー再起動が必要です。
