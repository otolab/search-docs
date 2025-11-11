# @search-docs/mcp-server

Claude Codeから直接search-docsを利用するためのMCP Serverです。

## 概要

このMCP Serverは、Claude Codeとsearch-docsサーバを接続し、会話から直接ドキュメント検索を実行できるようにします。

## 提供機能

### 動的ツール登録

v1.1.6以降、MCP Serverはシステム状態に応じて利用可能なツールを動的に変更します。

**システム状態とツールの対応**:

| 状態 | init | server_start | server_stop | get_system_status | search | get_document | index_status |
|------|------|--------------|-------------|-------------------|--------|--------------|--------------|
| NOT_CONFIGURED（未設定） | ✓ | - | - | ✓ | - | - | - |
| CONFIGURED_SERVER_DOWN（設定済み・サーバ停止） | ✓ | ✓ | ✓ | ✓ | - | - | - |
| RUNNING（稼働中） | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ |

**状態遷移時の自動更新**:
- `init`実行後、自動的にツールリストが更新され、`server_start`などが利用可能になります
- `server_start`実行後、検索系ツール（`search`、`get_document`、`index_status`）が利用可能になります
- `server_stop`実行後、検索系ツールは利用できなくなります

### ツール一覧

#### 1. `init`
設定ファイルを初期化します。

**利用可能条件**: 常時

**パラメータ**:
- `port` (number, オプション): サーバポート番号
- `force` (boolean, オプション): 既存設定を上書き

#### 2. `server_start`
search-docsサーバを起動します。

**利用可能条件**: 設定済み（CONFIGURED_SERVER_DOWN または RUNNING）

**パラメータ**:
- `foreground` (boolean, オプション): フォアグラウンド起動

#### 3. `server_stop`
search-docsサーバを停止します。

**利用可能条件**: 設定済み（CONFIGURED_SERVER_DOWN または RUNNING）

**パラメータ**: なし

#### 4. `get_system_status`
システムの状態を取得します。

**利用可能条件**: 常時

**パラメータ**: なし

#### 5. `search`
文書を検索します。

**利用可能条件**: サーバ稼働中（RUNNING）

**パラメータ**:
- `query` (string, 必須): 検索クエリ
- `depth` (number | number[], オプション): 検索深度（0-3）
- `limit` (number, オプション): 結果数制限（デフォルト: 10）
- `includeCleanOnly` (boolean, オプション): Clean状態のみ検索

**例**:
```
query: "Vector検索"
depth: 1
limit: 5
```

#### 6. `get_document`
文書の内容を取得します。

**利用可能条件**: サーバ稼働中（RUNNING）

**パラメータ**:
- `path` (string, 必須): 文書パス

**例**:
```
path: "docs/architecture.md"
```

#### 7. `index_status`
インデックスの状態を確認します。

**利用可能条件**: サーバ稼働中（RUNNING）

**パラメータ**: なし

## セットアップ

### サーバ自動起動機能

v1.0.1以降、MCP Serverは自動的にsearch-docsサーバを起動します。

**動作**:
1. MCP Server起動時にサーバへの接続を試みる
2. サーバが起動していない場合、自動的にサーバを起動
3. サーバが起動したら接続を確立

これにより、手動でサーバを起動する必要がなくなりました。

### 前提条件

ビルド済みであること
```bash
pnpm build
```

### Claude Code統合

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
