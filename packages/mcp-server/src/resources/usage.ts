export const USAGE_CONTENT = `# search-docsの使い方

## ツール一覧

| ツール | 用途 |
|--------|------|
| search | ドキュメントからVector検索 |
| get_document | セクションまたは文書全体の内容を取得 |
| get_outline | 文書の目次構造をトークン数付きで表示 |
| index_status | インデックスの詳細状態を確認 |
| get_system_status | システム全体の状態を確認 |
| init | 設定ファイルを初期化 |
| add_related_project | 関連プロジェクトを一時的に追加 |
| list_related_projects | 関連プロジェクトの一覧を表示 |

## 基本的な検索フロー

### 1. 検索する
\`\`\`
search(query: "認証の仕組み")
\`\`\`

結果にはセクションID、ファイルパス、行範囲、プレビューが含まれます。

### 2. セクションの全文を読む
\`\`\`
get_document(sectionId: "検索結果のid")
\`\`\`

### 3. 文書全体を読む
\`\`\`
get_document(path: "docs/auth.md")
\`\`\`

## 検索のコツ

### depth（検索粒度）
- \`depth: 0\` — 文書全体のみ（大まかな関連文書を探す）
- \`depth: 1\` — 章レベルまで（トピック単位で探す）
- \`depth: 2\` — 節レベルまで（具体的な内容を探す）
- \`depth: 3\` — 項レベルまで（ピンポイントで探す、デフォルト）

### パスで絞り込み
\`\`\`
search(query: "API設計", includePaths: ["docs/"])
search(query: "テスト", excludePaths: ["docs/internal/"])
\`\`\`

### 関連プロジェクトの検索
\`\`\`
search(query: "検索キーワード", project: "other-project")
\`\`\`

## ドキュメントのメンテナンス

### 目次で全体像を把握
\`\`\`
get_outline(path: "docs/architecture.md")
\`\`\`
各セクションのトークン数が表示されるので、記述量のバランスを確認できます。

### インデックス状態の確認
\`\`\`
index_status()
\`\`\`
Dirtyセクション数でインデックス更新の進捗を確認できます。

## 関連プロジェクト

### ランタイム追加（セッション限り）
\`\`\`
add_related_project(name: "other", url: "http://localhost:24280")
\`\`\`

対象プロジェクトで \`search-docs server start\` を実行してからURLを指定してください。

### 永続化（設定ファイル）
\`.search-docs/config.json\` の \`relatedProjects\` に記載します。
`;
