---
"@search-docs/mcp-server": minor
---

NOT_CONFIGURED状態でも関連プロジェクト経由で検索可能に

- メインプロジェクト未設定でもadd_related_projectで関連プロジェクトを追加・検索可能
- getAllRelatedProjectsでconfig由来のdirも絶対パスに解決し、パス解決を一本化
- 全ツールを常時有効化し、各ツール内で状態に応じたエラーメッセージを表示
- index_statusにproject指定パラメータを追加
