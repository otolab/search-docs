---
"@search-docs/types": patch
"@search-docs/db-engine": patch
"@search-docs/server": patch
"@search-docs/cli": patch
"@search-docs/client": patch
"@search-docs/mcp-server": patch
---

検索結果にstartLine/endLine/sectionNumberフィールドを追加

検索結果に文書内の位置情報を追加し、検索結果からソースファイルの該当箇所を特定できるようにしました。

**主な変更**:
- Section型に3つの新フィールドを追加（startLine, endLine, sectionNumber）
- MarkdownSplitterで行番号とセクション番号を自動生成
- Python-TypeScript変換層で新フィールドを変換
- CLI出力に位置情報を表示
- MCP Serverで新フィールドを提供
- Python側でフィールドのバリデーションと型変換を追加（null値を防止）

**影響範囲**:
- 既存のインデックスは再構築が必要です（`search-docs index rebuild`または`.search-docs/index`を削除してサーバ再起動）
