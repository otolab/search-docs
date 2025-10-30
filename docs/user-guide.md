# 🐕️ search-docs ユーザーガイド

search-docsの包括的な使用方法ガイドです。

## 目次

- [初回セットアップ](#初回セットアップ)
- [基本的な使い方](#基本的な使い方)
- [設定ファイル](#設定ファイル)
- [CLIコマンド](#cliコマンド)
- [Claude Code統合](#claude-code統合)
- [トラブルシューティング](#トラブルシューティング)
- [FAQ](#faq)

## 初回セットアップ

### 前提条件

- **Node.js**: v18以上を推奨
- **Python**: 3.9以上
- **uv**: Python パッケージマネージャー
- **pnpm**: Node.js パッケージマネージャー（開発時）

### インストール

#### 開発環境でのセットアップ

```bash
# リポジトリをクローン
git clone <repository-url>
cd search-docs

# 依存関係のインストール
pnpm install

# Python環境のセットアップ
uv sync

# ビルド
pnpm build
```

#### グローバルインストール（本番利用）

```bash
npm install -g search-docs
```

### 設定ファイルの作成

プロジェクトルートに `.search-docs.json` を作成します：

```bash
cd /path/to/your/project
```

`.search-docs.json` の例：

```json
{
  "version": "1.0",
  "project": {
    "name": "my-project",
    "root": "."
  },
  "files": {
    "include": [
      "**/*.md",
      "docs/**/*.txt"
    ],
    "exclude": [
      "**/node_modules/**",
      "**/.git/**",
      "**/dist/**",
      "**/build/**"
    ],
    "ignoreGitignore": true
  },
  "indexing": {
    "maxTokensPerSection": 2000,
    "minTokensForSplit": 100,
    "maxDepth": 3,
    "vectorDimension": 256,
    "embeddingModel": "cl-nagoya/ruri-v3-30m"
  },
  "search": {
    "defaultLimit": 10,
    "maxLimit": 100,
    "includeCleanOnly": false
  },
  "server": {
    "host": "localhost",
    "port": 24280,
    "protocol": "json-rpc"
  }
}
```

詳細は[設定ファイル](#設定ファイル)セクションを参照してください。

## 基本的な使い方

### 1. サーバの起動

```bash
# フォアグラウンドで起動
search-docs server start

# バックグラウンド（デーモン）で起動
search-docs server start --daemon

# ログファイルを指定
search-docs server start --daemon --log .search-docs/server.log
```

### 2. サーバの状態確認

```bash
search-docs server status
```

出力例：
```
Server Status
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
Status:  Running
PID:     12345
Port:    24280
Project: my-project
Started: 2025-01-30T12:00:00.000Z
```

### 3. 文書の検索

```bash
# 基本的な検索
search-docs search "検索キーワード"

# depth指定（より詳細なセクションを検索）
search-docs search "検索キーワード" --depth 1 2

# 結果数を指定
search-docs search "検索キーワード" --limit 20

# JSON形式で出力
search-docs search "検索キーワード" --format json

# Cleanなセクションのみ検索
search-docs search "検索キーワード" --clean-only
```

### 4. インデックスの管理

```bash
# インデックス状態の確認
search-docs index status

# インデックスの再構築（全文書）
search-docs index rebuild

# 特定のファイルのみ再構築
search-docs index rebuild docs/README.md AGENTS.md

# 強制的に再インデックス（ハッシュチェック無視）
search-docs index rebuild --force
```

### 5. サーバの停止

```bash
search-docs server stop
```

## 設定ファイル

設定ファイル `.search-docs.json` の詳細説明です。

### 配置場所

以下の順で検索されます：
1. `.search-docs.json`（推奨）
2. `search-docs.json`

### 設定項目

#### project

プロジェクト情報を定義します。

```json
{
  "project": {
    "name": "my-project",
    "root": "."
  }
}
```

- `name`: プロジェクト名
- `root`: プロジェクトルートディレクトリ（通常は `.`）

#### files

インデックス対象のファイルを定義します。

```json
{
  "files": {
    "include": ["**/*.md"],
    "exclude": ["**/node_modules/**"],
    "ignoreGitignore": true
  }
}
```

- `include`: インデックス対象のglobパターン
- `exclude`: 除外するglobパターン
- `ignoreGitignore`: `.gitignore`のパターンを尊重するか

**優先順位**:
1. `exclude`パターン（最優先）
2. `.gitignore`（`ignoreGitignore: true`の場合）
3. `include`パターン

#### indexing

インデックス化の設定です。

```json
{
  "indexing": {
    "maxTokensPerSection": 2000,
    "minTokensForSplit": 100,
    "maxDepth": 3,
    "vectorDimension": 256,
    "embeddingModel": "cl-nagoya/ruri-v3-30m"
  }
}
```

- `maxTokensPerSection`: セクションの最大トークン数
- `minTokensForSplit`: 分割する最小トークン数
- `maxDepth`: 最大分割深度（0-3）
- `vectorDimension`: ベクトル次元数（256推奨）
- `embeddingModel`: 埋め込みモデル名

#### search

検索動作の設定です。

```json
{
  "search": {
    "defaultLimit": 10,
    "maxLimit": 100,
    "includeCleanOnly": false
  }
}
```

- `defaultLimit`: デフォルトの検索結果数
- `maxLimit`: 最大検索結果数
- `includeCleanOnly`: Cleanなセクションのみ検索するか

#### server

サーバの設定です。

```json
{
  "server": {
    "host": "localhost",
    "port": 24280,
    "protocol": "json-rpc"
  }
}
```

- `host`: バインドするホスト
- `port`: ポート番号
- `protocol`: 通信プロトコル（現在は`json-rpc`のみ）

#### storage

データ保存場所の設定です（通常は変更不要）。

```json
{
  "storage": {
    "documentsPath": ".search-docs/documents",
    "indexPath": ".search-docs/index",
    "cachePath": ".search-docs/cache"
  }
}
```

#### watcher

ファイル監視の設定です。

```json
{
  "watcher": {
    "enabled": true,
    "debounceMs": 1000
  }
}
```

- `enabled`: ファイル監視を有効にするか
- `debounceMs`: 変更検知の遅延時間（ミリ秒）

#### worker

バックグラウンドワーカーの設定です。

```json
{
  "worker": {
    "enabled": true,
    "interval": 5000,
    "maxConcurrent": 3
  }
}
```

- `enabled`: ワーカーを有効にするか
- `interval`: 処理間隔（ミリ秒）
- `maxConcurrent`: 最大同時処理数

## CLIコマンド

詳細なコマンドリファレンスは [cli-reference.md](./cli-reference.md) を参照してください。

### server コマンド

| コマンド | 説明 |
|---------|------|
| `server start` | サーバを起動 |
| `server stop` | サーバを停止 |
| `server status` | サーバの状態を確認 |
| `server restart` | サーバを再起動 |

### search コマンド

```bash
search-docs search <query> [options]
```

| オプション | 説明 |
|-----------|------|
| `--limit <n>` | 最大結果数（デフォルト: 10） |
| `--depth <depths...>` | 深度フィルタ（例: 1 2） |
| `--format <format>` | 出力形式（text, json） |
| `--clean-only` | Dirtyセクションを除外 |
| `--server <url>` | サーバURL |

### index コマンド

| コマンド | 説明 |
|---------|------|
| `index rebuild [paths...]` | インデックスを再構築 |
| `index status` | インデックスの状態を確認 |

### config コマンド

| コマンド | 説明 |
|---------|------|
| `config init` | 設定ファイルを初期化（未実装） |

## Claude Code統合

詳細は [mcp-integration.md](./mcp-integration.md) を参照してください。

### MCP Serverとしての利用

プロジェクトルートに `.mcp.json` を配置することで、自動的に利用可能になります：

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

### 利用可能なツール

- `search`: 文書検索
- `get_document`: 文書取得
- `index_status`: インデックス状態確認

## トラブルシューティング

### サーバが起動しない

**症状**: `search-docs server start`でエラーが発生する

**解決方法**:

1. **ポート競合の確認**
   ```bash
   lsof -i :24280
   ```
   使用中の場合は別のポートを指定：
   ```bash
   search-docs server start --port 24281
   ```

2. **古いPIDファイルの削除**
   ```bash
   rm .search-docs/server.pid
   ```

3. **Python環境の確認**
   ```bash
   uv sync
   ```

### 検索結果が返ってこない

**症状**: `search-docs search`で結果が0件

**原因**:
- インデックスが作成されていない
- サーバが起動していない

**解決方法**:

1. サーバの状態確認
   ```bash
   search-docs server status
   ```

2. インデックスの状態確認
   ```bash
   search-docs index status
   ```

3. インデックスの再構築
   ```bash
   search-docs index rebuild
   ```

### ファイル変更が反映されない

**症状**: ファイルを更新しても検索結果に反映されない

**原因**:
- ファイルウォッチャーが無効
- IndexWorkerがDirtyセクションを処理中

**解決方法**:

1. 設定ファイルを確認（`watcher.enabled: true`か確認）

2. インデックス状態を確認
   ```bash
   search-docs index status
   ```
   `Dirty`の数をチェック

3. 手動で再構築
   ```bash
   search-docs index rebuild <file-path>
   ```

### メモリ使用量が多い

**症状**: サーバのメモリ使用量が大きい

**原因**:
- 大量の文書をインデックス化している
- 埋め込みモデルがメモリに常駐

**解決方法**:

1. 不要なファイルを除外
   `.search-docs.json`の`files.exclude`を調整

2. `maxDepth`を下げる（セクション数を減らす）
   ```json
   {
     "indexing": {
       "maxDepth": 1
     }
   }
   ```

3. サーバを定期的に再起動

## FAQ

### Q: どのファイル形式をサポートしていますか？

A: 現在はMarkdown (`.md`) ファイルのみサポートしています。将来的には他のテキスト形式も対応予定です。

### Q: 複数のプロジェクトで使えますか？

A: はい。各プロジェクトで独立したサーバを起動できます。ポート番号を変更してください。

### Q: オフラインで使えますか？

A: はい。すべての処理はローカルで完結します。初回のみ埋め込みモデルのダウンロードが必要です。

### Q: 英語の文書でも使えますか？

A: 使えますが、日本語文書に最適化されています。英語の場合は別の埋め込みモデルの使用を検討してください。

### Q: インデックスの更新は自動ですか？

A: はい。ファイルウォッチャーが変更を検知し、バックグラウンドで自動的にインデックスを更新します。

### Q: プライベートな文書を扱っても安全ですか？

A: はい。すべてのデータはローカルに保存され、外部に送信されることはありません。

### Q: 設定ファイルをバージョン管理に含めるべきですか？

A: はい。`.search-docs.json`はプロジェクト固有の設定なので、バージョン管理に含めることを推奨します。ただし、`.search-docs/`ディレクトリは`.gitignore`に追加してください。

### Q: インデックスのサイズはどのくらいになりますか？

A: 文書の量によりますが、通常は元のファイルサイズの1-2倍程度です。ベクトルデータと検索インデックスが含まれます。

### Q: パフォーマンスを向上させるには？

A: 以下の方法があります：
- 不要なファイルを`exclude`パターンで除外
- `maxDepth`を下げる（セクション数を減らす）
- `maxTokensPerSection`を調整
- SSDを使用する

## 次のステップ

- [クイックスタート](./quick-start.md) - 5分で試す
- [CLIリファレンス](./cli-reference.md) - 全コマンドの詳細
- [MCP統合ガイド](./mcp-integration.md) - Claude Code統合
- [開発ガイド](./development.md) - 開発に参加する（未作成）

## 関連ドキュメント

- [アーキテクチャ](./architecture.md)
- [データモデル](./data-model.md)
- [クライアントライブラリ](./client-library.md)
