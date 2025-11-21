---
"@search-docs/mcp-server": minor
"@search-docs/types": minor
"@search-docs/cli": patch
---

関連プロジェクト検索機能を追加

複数のsearch-docsプロジェクト間でドキュメントを横断検索できる機能を実装しました。

**主な変更**:
- 設定ファイルに`relatedProjects`セクションを追加
- `search()`と`get_document()`に`project`パラメータを追加
- `ServerManager`クラスで複数プロジェクトのサーバを管理
- 関連プロジェクト情報を`get_system_status`で表示
- サーバプロセスの作業ディレクトリ設定を修正

**使用例**:
```typescript
// 関連プロジェクトを検索
await search({ query: "認証", project: "auth-service" });

// 関連プロジェクトのドキュメント取得
await getDocument({ path: "README.md", project: "auth-service" });
```
