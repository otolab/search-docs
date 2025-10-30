# Claude Code 統合ガイド（MCP Server）

search-docsをClaude Codeから直接利用するためのガイドです。

## 目次

- [概要](#概要)
- [セットアップ](#セットアップ)
- [利用可能なツール](#利用可能なツール)
- [使用例](#使用例)
- [プロジェクトスコープ設定](#プロジェクトスコープ設定)
- [トラブルシューティング](#トラブルシューティング)

## 概要

search-docsは、Model Context Protocol (MCP) Serverとして実装されており、Claude Codeから直接ドキュメント検索を実行できます。

### MCPとは

Model Context Protocol (MCP)は、AI アシスタントが外部ツールやデータソースと連携するための標準プロトコルです。search-docsのMCP Serverを使用すると、Claude Codeが会話の中でプロジェクトのドキュメントを検索できます。

### できること

- 💬 会話中に自然言語でドキュメント検索
- 📄 特定の文書の内容を取得
- 📊 インデックスの状態を確認
- 🔄 プロジェクト固有の設定を自動読み込み

## セットアップ

### 前提条件

1. **search-docsサーバが起動していること**
   ```bash
   search-docs server start --daemon
   ```

2. **プロジェクトに設定ファイルがあること**
   - `.search-docs.json` または `.search-docs/config.json`

### 方法1: プロジェクトスコープ設定（推奨）

プロジェクトルートに `.mcp.json` を配置すると、そのプロジェクトで自動的にMCP Serverが利用可能になります。

`.mcp.json` の例：

```json
{
  "mcpServers": {
    "search-docs": {
      "command": "node",
      "args": [
        "packages/mcp-server/dist/server.js",
        "--project-dir",
        "."
      ]
    }
  }
}
```

**開発環境での絶対パス指定**:

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

**注意**:
- `${workspaceFolder}` は自動的に現在のワークスペースフォルダに置換されます
- 絶対パスを使用する場合は、実際のパスに置き換えてください

### 方法2: グローバル設定

Claude Codeのグローバル設定ファイルに追加します。

**設定ファイルの場所**:
- **Cline**: `~/.cline/cline_mcp_settings.json`
- **Claude Desktop**: `~/Library/Application Support/Claude/claude_desktop_config.json`

**設定例**:

```json
{
  "mcpServers": {
    "search-docs": {
      "command": "search-docs-mcp",
      "args": [
        "--project-dir",
        "${workspaceFolder}"
      ]
    }
  }
}
```

**注意**: グローバルインストール（`npm install -g search-docs`）が必要です。

### 方法3: Claude Code コマンドで追加

```bash
claude mcp add search-docs -- search-docs mcp-server --project-dir $(pwd)
```

## 利用可能なツール

MCP Serverは以下のツールを提供します。

### 1. search

文書を検索します。

**パラメータ**:

| パラメータ | 型 | 必須 | 説明 |
|-----------|-----|------|------|
| `query` | string | ✓ | 検索クエリ |
| `depth` | number \| number[] | - | 検索深度（0-3） |
| `limit` | number | - | 結果数制限（デフォルト: 10） |
| `includeCleanOnly` | boolean | - | Clean状態のみ検索 |

**使用例**（Claude Codeでの会話）:

```
ユーザー: Vector検索に関するドキュメントを探して
Claude: [searchツールを使用]
        query: "Vector検索"
        limit: 5
```

**レスポンス**:

```
検索結果: 5件
処理時間: 45ms

1. docs/README.md - Vector検索とは
   深度: 2, スコア: 0.95

   Vector検索は、文書をベクトル空間に埋め込み、
   意味的な類似性に基づいて検索する技術です。

2. docs/architecture.md - Vector検索エンジン
   ...
```

### 2. get_document

特定の文書の内容を取得します。

**パラメータ**:

| パラメータ | 型 | 必須 | 説明 |
|-----------|-----|------|------|
| `path` | string | ✓ | 文書パス |

**使用例**:

```
ユーザー: docs/architecture.mdの内容を見せて
Claude: [get_documentツールを使用]
        path: "docs/architecture.md"
```

**レスポンス**:

```
文書: docs/architecture.md
タイトル: アーキテクチャ
作成日: 2025-01-27T10:00:00.000Z
更新日: 2025-01-30T12:00:00.000Z

# アーキテクチャ

## 概要

search-docsは、ローカル文書のVector検索を実現するための
多層アーキテクチャを採用しています。
...
```

### 3. index_status

インデックスの状態を確認します。

**パラメータ**: なし

**使用例**:

```
ユーザー: インデックスの状態を確認して
Claude: [index_statusツールを使用]
```

**レスポンス**:

```
インデックス状態
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

サーバ情報:
  バージョン: 0.1.0
  稼働時間: 2h 15m 30s
  PID: 12345

インデックス統計:
  総文書数: 152
  総セクション数: 1018
  Dirty: 0

ワーカー状態:
  実行中: はい
  処理中: 0
  キュー: 0
```

## 使用例

### ドキュメントの検索

```
ユーザー: LanceDBに関するドキュメントを検索して

Claude: LanceDBに関するドキュメントを検索しますね。

[searchツールを使用: query="LanceDB", limit=10]

検索結果から、以下の関連ドキュメントが見つかりました：

1. **docs/architecture.md - Vector検索エンジン**
   LanceDBは高速なVector databaseです。
   ローカルファイルベースストレージで、高速なVector検索を実現...

2. **docs/data-model.md - SearchIndex**
   LanceDBのテーブルとして実装...

詳しく知りたい内容があれば、お知らせください。
```

### 特定の文書の内容確認

```
ユーザー: architecture.mdのVector検索エンジンの部分を詳しく見せて

Claude: architecture.mdの内容を取得します。

[get_documentツールを使用: path="docs/architecture.md"]

Vector検索エンジンの部分は以下です：

## Vector検索エンジン (Python)

sebas-chanのアーキテクチャを参考にした、LanceDBベースの
Vector検索エンジンです。

主要技術スタック:
- LanceDB: Vector database
  - ローカルファイルベースストレージ
  - 高速なVector検索
  ...
```

### インデックス状態の確認

```
ユーザー: インデックスの状態を確認して

Claude: インデックスの状態を確認します。

[index_statusツールを使用]

現在のインデックス状態：

- 総文書数: 152
- 総セクション数: 1018
- Dirty: 0（全てクリーン状態です）

ワーカーは正常に動作しており、現在処理中のタスクはありません。
```

## プロジェクトスコープ設定

search-docsプロジェクト自身でMCP Serverを使用する例です。

### プロジェクトの `.mcp.json`

```json
{
  "mcpServers": {
    "search-docs": {
      "command": "node",
      "args": [
        "packages/mcp-server/dist/server.js",
        "--project-dir",
        "."
      ]
    }
  }
}
```

### 動作確認

1. **Claude Codeを再起動**

2. **検索を試す**
   ```
   ユーザー: このプロジェクトのアーキテクチャについて教えて
   ```

3. **成功の確認**
   - Claude Codeがsearchツールを使用
   - プロジェクトのドキュメントから情報を取得
   - 回答に反映される

## トラブルシューティング

### サーバに接続できない

**エラー**: `Failed to connect to search-docs server`

**原因**:
- サーバが起動していない
- ポートが異なる

**解決方法**:

1. サーバの状態を確認
   ```bash
   search-docs server status
   ```

2. サーバを起動
   ```bash
   search-docs server start --daemon
   ```

3. 設定ファイルのポート番号を確認
   ```json
   {
     "server": {
       "port": 24280
     }
   }
   ```

### 検索結果が0件

**原因**:
- インデックスが作成されていない
- 検索クエリが適切でない

**解決方法**:

1. インデックスを確認
   ```bash
   search-docs index status
   ```

2. インデックスを再構築
   ```bash
   search-docs index rebuild
   ```

### MCP Serverが起動しない

**エラー**: MCP Serverのプロセスが起動しない

**解決方法**:

1. **パスを確認**
   - `.mcp.json`のパスが正しいか確認
   - 絶対パスを使用する

2. **ビルドを確認**
   ```bash
   pnpm build
   ```

3. **手動で起動して確認**
   ```bash
   node packages/mcp-server/dist/server.js --project-dir .
   ```

### Claude Codeがツールを認識しない

**解決方法**:

1. **Claude Codeを再起動**

2. **設定ファイルの構文を確認**
   - JSONが正しいか確認
   - カンマやブラケットの漏れをチェック

3. **ログを確認**（Claude Code側）

## パフォーマンスの最適化

### レスポンス速度の改善

1. **サーバを常時起動**
   ```bash
   search-docs server start --daemon
   ```

2. **不要なファイルを除外**
   `.search-docs.json`の`files.exclude`を調整

3. **depth を制限**
   深い階層の検索を避ける

### メモリ使用量の削減

1. **maxDepth を下げる**
   ```json
   {
     "indexing": {
       "maxDepth": 1
     }
   }
   ```

2. **対象ファイルを絞る**
   ```json
   {
     "files": {
       "include": ["docs/**/*.md"]
     }
   }
   ```

## 高度な設定

### カスタムポート

```json
{
  "server": {
    "port": 24281
  }
}
```

MCP Serverは設定ファイルのポート番号を自動的に読み込みます。

### 複数プロジェクトでの使用

各プロジェクトで異なるポートを使用：

**プロジェクトA**:
```json
{
  "server": {
    "port": 24280
  }
}
```

**プロジェクトB**:
```json
{
  "server": {
    "port": 24281
  }
}
```

## 関連ドキュメント

- [ユーザーガイド](./user-guide.md) - 基本的な使い方
- [CLIリファレンス](./cli-reference.md) - CLIコマンドの詳細
- [クイックスタート](./quick-start.md) - 5分で試す
- [MCP Server README](../packages/mcp-server/README.md) - 開発者向け情報
