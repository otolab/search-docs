---
"@search-docs/server": patch
---

fix: get_outline APIの3つの問題を修正
- セクションの並び順をsection_number辞書順に修正（orderフィールドではなく階層順）
- YAML frontmatterを除去（メタデータブロックが見出しとして扱われる問題を解消）
- document root（depth=0）を結果から除外（常に先頭が"1"になる問題を解消）
