---
'@search-docs/db-engine': minor
'@search-docs/server': minor
'@search-docs/mcp-server': minor
'@search-docs/types': minor
---

インデックス戦略の実装と前方一致検索の追加

## LanceDBインデックス戦略 (Phase 1)

以下のインデックスを新規作成し、クエリパフォーマンスを最適化しました:

**index_requestsテーブル**:
- `document_path` (BTREE): 等価検索の高速化
- `document_hash` (BTREE): 等価検索の高速化

**sectionsテーブル**:
- `document_path` (BTREE): 等価検索の高速化、LIKE prefix検索にも効果が期待される
- `is_dirty` (BITMAP): Low-cardinality (2値) カラムの高速化

## 前方一致検索機能

search APIに以下のオプションを追加しました:

- `includePaths`: 指定パスプレフィックス配下のみを検索 (OR条件)
- `excludePaths`: 指定パスプレフィックス配下を除外 (AND条件)

例:
```typescript
// docs/配下のみを検索
search({ query: "検索語", options: { includePaths: ["docs/"] } })

// docs/internal/とtemp/を除外
search({ query: "検索語", options: { excludePaths: ["docs/internal/", "temp/"] } })

// 組み合わせ: prompts/配下でprompts/tasks/を除外
search({ 
  query: "検索語", 
  options: { 
    includePaths: ["prompts/"], 
    excludePaths: ["prompts/tasks/"] 
  } 
})
```

## 技術詳細

- LanceDB LIKE演算子による前方一致検索
- DataFusion 46.0.0のNOT LIKE最適化を活用
- BTREEインデックスの効果は今後のパフォーマンステストで検証予定
