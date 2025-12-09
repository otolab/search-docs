---
"@search-docs/types": patch
"@search-docs/server": patch
"@search-docs/client": patch
"@search-docs/mcp-server": patch
"@search-docs/db-engine": patch
"@search-docs/cli": patch
---

文書構造を表示するget_outlineツールを追加し、ESLintエラーを修正しました。

- 新機能: get_outlineツールで文書のアウトライン（セクション番号・行数・トークン数）を取得
- path/sectionId両対応、関連プロジェクトサポート
- ESLintエラー修正: Python型インターフェースの追加、未使用変数の修正
