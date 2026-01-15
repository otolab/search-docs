# @search-docs/cli

search-docsのコマンドラインツールです。サーバの管理、文書の検索、インデックスの操作を提供します。

## インストール

### グローバルインストール

```bash
npm install -g @search-docs/cli
```

### npxで直接実行（推奨）

インストール不要で最新版を使用できます：

```bash
npx @search-docs/cli <command>
```

## 基本的な使い方

### 1. 設定ファイルを初期化

```bash
npx @search-docs/cli config init
```

プロジェクトルートに `.search-docs.json` が作成されます。

### 2. サーバを起動

```bash
npx @search-docs/cli server start
```

バックグラウンドでサーバが起動し、ファイル監視とインデックス生成が開始されます。

### 3. 文書を検索

```bash
npx @search-docs/cli search "検索クエリ"
```

## 主要なコマンド

### server - サーバ管理

```bash
# サーバを起動
npx @search-docs/cli server start

# サーバを停止
npx @search-docs/cli server stop

# サーバの状態を確認
npx @search-docs/cli server status

# サーバを再起動
npx @search-docs/cli server restart
```

**オプション**:
- `--port <port>`: ポート番号を指定（デフォルト: 24280）
- `--foreground, -f`: フォアグラウンドで起動（開発時）
- `--log <path>`: ログファイルのパス

### search - 文書検索

```bash
# 基本的な検索
npx @search-docs/cli search "Vector検索"

# 結果数を制限
npx @search-docs/cli search "検索" --limit 5

# 検索深度を指定（0: 文書全体、1: H1、2: H2、3: H3）
npx @search-docs/cli search "検索" --depth 1
```

**オプション**:
- `--limit <number>`: 結果数制限（デフォルト: 10）
- `--depth <number|numbers>`: 検索深度（0-3、カンマ区切りで複数指定可）
- `--include-clean-only`: Clean（最新）な文書のみ検索
- `--format <format>`: 出力形式（`text` | `json`）

### index - インデックス管理

```bash
# インデックスの状態を確認
npx @search-docs/cli index status

# インデックスを再構築
npx @search-docs/cli index rebuild
```

### config - 設定管理

```bash
# 設定ファイルを初期化
npx @search-docs/cli config init

# ポート番号を指定して初期化
npx @search-docs/cli config init --port 24281

# 既存設定を上書き
npx @search-docs/cli config init --force
```

## グローバルオプション

すべてのコマンドで使用可能：

```bash
# カスタム設定ファイルを使用
npx @search-docs/cli --config ./custom.json server start

# バージョン確認
npx @search-docs/cli --version

# ヘルプ表示
npx @search-docs/cli --help
npx @search-docs/cli server --help
```

## 設定ファイル

`.search-docs.json` の基本構成：

```json
{
  "version": "1.0",
  "files": {
    "include": ["**/*.md"],
    "exclude": ["**/node_modules/**"]
  },
  "server": {
    "host": "localhost",
    "port": 24280
  }
}
```

詳細は [ユーザーガイド](../../docs/user-guide.md) を参照してください。

## 詳細なドキュメント

- **[CLIリファレンス](../../docs/cli-reference.md)** - 全コマンドの詳細
- **[ユーザーガイド](../../docs/user-guide.md)** - 設定と使い方
- **[クイックスタート](../../docs/quick-start.md)** - 5分で始める

## トラブルシューティング

### サーバが起動しない

```bash
# ポート競合を確認
lsof -i :24280

# 別のポートで起動
npx @search-docs/cli server start --port 24281
```

### 検索結果が0件

```bash
# インデックス状態を確認
npx @search-docs/cli index status

# 再インデックス
npx @search-docs/cli index rebuild
```

## 関連パッケージ

- `@search-docs/server`: 検索サーバ
- `@search-docs/mcp-server`: Claude Code統合
- `@search-docs/client`: JSON-RPCクライアント
