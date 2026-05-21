export const CONFIG_REFERENCE_CONTENT = `# 設定リファレンス

設定ファイルは \`.search-docs/config.json\` または \`.search-docs.json\` に配置します。

## project

\`\`\`json
{
  "project": {
    "name": "my-project",
    "root": "."
  }
}
\`\`\`

- \`name\`: プロジェクト名
- \`root\`: プロジェクトルートディレクトリ（通常は \`.\`）

## files

\`\`\`json
{
  "files": {
    "sources": ["**/*.md"],
    "exclude": ["**/node_modules/**"],
    "ignoreGitignore": true
  }
}
\`\`\`

- \`sources\`: 監視対象のglobパターン（推奨、v1.8.6以降）
- \`include\`: \`sources\`の旧名称（後方互換あり、非推奨）
- \`exclude\`: 除外するglobパターン
- \`ignoreGitignore\`: \`.gitignore\` のパターンを尊重するか

**監視方式の自動判定**:
- \`**\` を含むパターン → deep（再帰的に監視）
- \`**\` を含まないパターン → shallow（直下のみ監視）
- 中間globパターン（例: \`systems/*/docs/**\`）→ 起動時に実パスに展開

## indexing

\`\`\`json
{
  "indexing": {
    "maxTokensPerSection": 2000,
    "minTokensForSplit": 100,
    "maxDepth": 3,
    "vectorDimension": 256,
    "embeddingModel": "cl-nagoya/ruri-v3-30m",
    "embeddingUrl": "http://localhost:24281"
  }
}
\`\`\`

- \`maxTokensPerSection\`: セクションの最大トークン数（デフォルト: 2000）
- \`minTokensForSplit\`: 分割する最小トークン数（デフォルト: 100）
- \`maxDepth\`: 最大分割深度 0-3（デフォルト: 3）
- \`vectorDimension\`: ベクトル次元数（デフォルト: 256）
- \`embeddingModel\`: 埋め込みモデル名
- \`embeddingUrl\`: 外部Embeddingサーバの指定（省略時は自動検出・起動）

## search

\`\`\`json
{
  "search": {
    "defaultLimit": 10,
    "maxLimit": 100,
    "includeCleanOnly": false
  }
}
\`\`\`

- \`defaultLimit\`: デフォルトの検索結果数
- \`maxLimit\`: 最大検索結果数
- \`includeCleanOnly\`: Cleanなセクションのみ検索するか

## server

\`\`\`json
{
  "server": {
    "host": "localhost",
    "port": 24280,
    "protocol": "json-rpc"
  }
}
\`\`\`

## storage

\`\`\`json
{
  "storage": {
    "documentsPath": ".search-docs/documents",
    "indexPath": ".search-docs/index",
    "cachePath": ".search-docs/cache"
  }
}
\`\`\`

通常は変更不要です。

## watcher

\`\`\`json
{
  "watcher": {
    "enabled": true,
    "debounceMs": 1000
  }
}
\`\`\`

- \`enabled\`: ファイル監視を有効にするか
- \`debounceMs\`: 変更検知の遅延時間（ミリ秒）

## worker

\`\`\`json
{
  "worker": {
    "enabled": true,
    "interval": 5000,
    "maxConcurrent": 3
  }
}
\`\`\`

- \`enabled\`: ワーカーを有効にするか
- \`interval\`: 処理間隔（ミリ秒）
- \`maxConcurrent\`: 最大同時処理数

## relatedProjects

\`\`\`json
{
  "relatedProjects": {
    "other-project": {
      "url": "http://localhost:24281",
      "description": "関連プロジェクト"
    }
  }
}
\`\`\`

関連プロジェクトのsearch-docsサーバに接続して横断検索が可能です。
ランタイム追加は \`add_related_project\` ツールで行えます（セッション限り）。
`;
