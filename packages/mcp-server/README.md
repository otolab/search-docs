# @search-docs/mcp-server

Claude Codeから直接search-docsを利用するためのMCP Serverです。

## 概要

このMCP Serverは、Claude Codeとsearch-docsサーバを接続し、会話から直接ドキュメント検索を実行できるようにします。

## 提供機能

### 動的ツール登録

MCP Serverはシステム状態に応じて利用可能なツールを動的に変更します。

**システム状態とツールの対応**:

| 状態 | init | server_start | server_stop | get_system_status | search | get_document | get_outline | index_status |
|------|------|--------------|-------------|-------------------|--------|--------------|-------------|--------------|
| NOT_CONFIGURED（未設定） | ✓ | - | - | ✓ | - | - | - | - |
| CONFIGURED（設定済み） | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ |

**注意**:
- `init`実行後、全てのツールが利用可能になります
- ただし、**Claude Codeは現在MCP通知に未対応**のため、ツールリスト更新には**再接続が必要**です
- 各ツール内で状態チェックを行うため、適切でない状態でツールを呼び出した場合はエラーメッセージが表示されます

### ツール一覧

#### 1. `init`
設定ファイルを初期化します。

**利用可能条件**: 常時

**パラメータ**:
- `port` (number, オプション): サーバポート番号（省略時はランダムなポート番号が割り当てられます）
- `force` (boolean, オプション): 既存設定を上書き（デフォルト: false）

#### 2. `server_start`
search-docsサーバを起動します。

**利用可能条件**: 設定済み（CONFIGURED_SERVER_DOWN または RUNNING）

**パラメータ**:
- `foreground` (boolean, オプション): フォアグラウンド起動（デフォルト: false、バックグラウンド起動）

#### 3. `server_stop`
search-docsサーバを停止します。

**利用可能条件**: 設定済み（CONFIGURED_SERVER_DOWN または RUNNING）

**パラメータ**: なし

#### 4. `get_system_status`
システムの状態を取得します。設定ファイルの有無、サーバの起動状態、インデックス情報を確認できます。

**利用可能条件**: 常時

**パラメータ**: なし

#### 5. `search`
文書を検索します。クエリに基づいてVector検索を実行し、関連する文書セクションを返します。

**利用可能条件**: サーバ稼働中（RUNNING）

**パラメータ**:
- `query` (string, 必須): 検索クエリ
- `project` (string, オプション): 検索対象のプロジェクト名。未指定の場合はメインプロジェクトを検索します
- `depth` (number, オプション): 最大深度（0-3）。0=文書全体のみ、1=章まで、2=節まで、3=項まで。省略時は全階層を検索
- `limit` (number, オプション): 結果数制限（デフォルト: 10）
- `includeCleanOnly` (boolean, オプション): 最新の文書内容のみを検索対象とする（デフォルト: false）
- `includePaths` (array of string, オプション): 包含するドキュメントパス（前方一致）。例: ["docs/", "README.md"]
- `excludePaths` (array of string, オプション): 除外するドキュメントパス（前方一致）。例: ["docs/internal/", "temp/"]
- `previewLines` (number, オプション): プレビュー行数（デフォルト: 5）

#### 6. `get_document`
文書の内容を取得します。パス指定で文書全体、またはセクションIDで特定セクションを取得できます。

**利用可能条件**: サーバ稼働中（RUNNING）

**パラメータ**:
- `path` (string, オプション): 文書パス（sectionIdを指定しない場合は必須）
- `sectionId` (string, オプション): セクションID（検索結果から取得、pathを指定しない場合は必須）
- `project` (string, オプション): 取得対象のプロジェクト名

**注意**: pathとsectionIdのどちらか一方は必須です。

#### 7. `get_outline`
文書の構造（アウトライン）を取得します。セクション番号、見出し、行数、トークン数、セクションIDを一覧表示します。

**利用可能条件**: サーバ稼働中（RUNNING）

**パラメータ**:
- `path` (string, オプション): 文書パス（sectionIdを指定しない場合は必須）
- `sectionId` (string, オプション): セクションID（指定した場合、そのセクション配下のみ表示）
- `project` (string, オプション): 取得対象のプロジェクト名

**注意**: pathとsectionIdのどちらか一方は必須です。

#### 8. `index_status`
インデックスの状態を確認します。総文書数、セクション数、Dirtyセクション数などを表示します。

**利用可能条件**: サーバ稼働中（RUNNING）

**パラメータ**: なし

## セットアップ

### Docker版（推奨）

**ランタイム依存（Node.js, Python, uv）を排除し、セキュアな境界で実行**できます。

```bash
docker mcp run search-docs
```

その後、Claude Codeで：
1. 「search-docsのセットアップをお願い」と依頼
2. MCPを再接続（reconnect）
3. 「このプロジェクトのアーキテクチャについて教えて」と依頼

→ [Docker構成ガイド](../../docs/docker-deployment.md)

### npm/npx版（Docker環境がない場合）

Docker環境がない場合の代替手段です。

**前提条件**:
- [uv](https://docs.astral.sh/uv/)（Pythonパッケージマネージャ）が必要です
  ```bash
  # macOS (Homebrew)
  brew install uv
  # macOS/Linux (公式インストーラ)
  curl -LsSf https://astral.sh/uv/install.sh | sh
  ```

#### npx版のセットアップ手順

#### サーバ自動起動機能

MCP Serverは自動的にsearch-docsサーバを起動します。

**動作**:
1. MCP Server起動時にサーバへの接続を試みる
2. サーバが起動していない場合、自動的にサーバを起動
3. サーバが起動したら接続を確立

これにより、手動でサーバを起動する必要がなくなりました。

#### 前提条件

ビルド済みであること
```bash
pnpm build
```

#### Claude Code統合

Claude Codeの設定ファイル（`claude_desktop_config.json`または`cline_mcp_settings.json`）に以下を追加：

```json
{
  "mcpServers": {
    "search-docs": {
      "command": "node",
      "args": [
        "/absolute/path/to/search-docs/packages/mcp-server/dist/server.js",
        "--project-dir",
        "${workspaceFolder}"
      ]
    }
  }
}
```

**注意**: `/absolute/path/to/search-docs/` は実際のパスに置き換えてください。

## 開発

### ビルド
```bash
pnpm build
```

### 開発モード（watch）
```bash
pnpm dev
```

### テスト起動
```bash
node dist/server.js --project-dir /path/to/your/project
```

## トラブルシューティング

### サーバに接続できない

**エラー**: `Failed to connect to search-docs server`

**通常は不要**: MCP Serverはサーバを自動起動します。

**手動で確認する場合**:
1. サーバが起動しているか確認
   ```bash
   node packages/cli/dist/index.js server status
   ```

2. 必要に応じてサーバを起動
   ```bash
   node packages/cli/dist/index.js server start
   ```

### 設定ファイルが見つからない

MCP Serverはプロジェクトディレクトリの `.search-docs.json` を読み込みます。

ファイルが存在しない場合はデフォルト設定（`localhost:24280`）を使用します。

## 関連パッケージ

- `@search-docs/client`: JSON-RPCクライアント
- `@search-docs/server`: 検索サーバ
- `@search-docs/cli`: CLIツール
