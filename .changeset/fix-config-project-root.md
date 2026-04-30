---
"@search-docs/types": patch
---

fix: ConfigLoader.resolve()でconfig.project.rootを絶対パスに解決するよう修正。Docker環境でWatcherProcessが正しいディレクトリをスキャンしない問題を修正。
