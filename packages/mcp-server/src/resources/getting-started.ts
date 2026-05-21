export const GETTING_STARTED_CONTENT = `# search-docsをはじめる

## セットアップ

### 方法1: Claude Code + Docker版（推奨）

\`\`\`bash
claude mcp add search-docs -- docker run --rm -i \\
  -v .:/workspace:ro \\
  -v ./.search-docs:/workspace/.search-docs \\
  otolab/search-docs-mcp:latest
\`\`\`

### 方法2: Claude Code + npx版

\`\`\`bash
claude mcp add search-docs -- npx -y @search-docs/mcp-server
\`\`\`

### 方法3: CLIツール

\`\`\`bash
npx @search-docs/cli config init
npx @search-docs/cli server start
npx @search-docs/cli search "検索クエリ"
\`\`\`

## 設定ファイルの初期化

MCPツールの \`init\` を実行すると \`.search-docs/config.json\` が作成されます。

主な設定項目:
- **files.sources**: 監視対象のglobパターン（デフォルト: \`["**/*.md"]\`）
- **indexing.maxDepth**: セクション分割の最大深度（0-3、デフォルト: 3）
- **indexing.maxTokensPerSection**: セクションの最大トークン数（デフォルト: 2000）

詳しくは設定リファレンス（\`search-docs://config-reference\`）を参照してください。

## initなしで使う

設定ファイルがなくても、\`add_related_project\` で他プロジェクトのsearch-docsサーバに接続し、検索できます。

\`\`\`
add_related_project(name: "other-project", url: "http://localhost:24280")
search(query: "検索キーワード", project: "other-project")
\`\`\`
`;
