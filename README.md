# 🐕️ search-docs

ローカル文書検索システム - Markdown文書に対するVector検索機能を提供します

## 概要

search-docsは、ローカルに保存されたMarkdown文書に対して高度なVector検索を行うサブシステムです。文書全体だけでなく、セクションごとの情報も自動的に分解してインデックス化し、より精緻な検索を可能にします。

## 主な機能

- **クライアント・サーバ構成**: プロジェクト毎に起動される検索サーバと、複数のクライアント
- **文書の自動分解**: Markdown文書をセクション単位で自動的に分解（depth 0-3）
- **Vector検索**: 文書全体とセクションごとに対してVector検索を実行
- **設定ファイルベース**: ファイル検索ルールを柔軟に設定可能
- **ローカル実行**: すべての処理をローカル環境で完結
- **日本語最適化**: 日本語文書に最適化された埋め込みモデルを使用
- **Claude Code統合**: MCP Serverとして直接利用可能

## 技術スタック

### メイン言語
- **TypeScript**: アプリケーションロジック、API、文書処理

### データベースエンジン
- **Python**: Vector検索とDB管理
- **LanceDB**: Vector database
- **Ruri Embedding Models**: 日本語最適化された埋め込みモデル

## アーキテクチャ

search-docsは、クライアント・サーバ構成で実装されています。

### コンポーネント

- **Server**: プロジェクト毎に起動される文書管理・検索サーバ
- **Client Library**: サーバと通信するTypeScriptクライアント
- **CLI Tool**: コマンドラインインターフェイス
- **MCP Server**: Claude Code統合用のMCPサーバ

詳細なアーキテクチャ情報については、以下のドキュメントを参照してください：
- [クライアント・サーバアーキテクチャ](docs/client-server-architecture.md)
- [データモデル設計](docs/data-model.md)
- [システムアーキテクチャ](docs/architecture.md)

## セットアップ

### 前提条件

- Node.js (推奨: v18以上)
- [uv](https://github.com/astral-sh/uv) (Python パッケージマネージャー)

### インストール

```bash
# 依存関係のインストール
pnpm install

# Python環境のセットアップ
uv sync

# ビルド
pnpm build
```

### グローバルインストール（本番利用）

```bash
npm install -g search-docs
```

## 使用方法

### 設定ファイルの初期化

プロジェクトで初めてsearch-docsを使用する場合は、まず設定ファイルを作成します：

```bash
# プロジェクトディレクトリに移動
cd /path/to/your/project

# 設定ファイルを初期化（ランダムポート）
search-docs config init

# ポート番号を指定する場合
search-docs config init --port 12345
```

これにより、`.search-docs.json` 設定ファイルが生成されます。ポート番号はエフェメラルポート範囲（49152-65535）からランダムに選択されるため、複数プロジェクトでの衝突を回避できます。

### サーバの起動

```bash
# プロジェクトディレクトリで起動（デフォルト: バックグラウンド）
cd /path/to/your/project
search-docs server start

# フォアグラウンドで起動（開発時）
search-docs server start --foreground

# 設定ファイルを明示的に指定
search-docs --config ./custom-config.json server start
```

### 検索

```bash
# CLIから検索
search-docs search "検索クエリ"

# depth指定
search-docs search "検索クエリ" --depth 1

# 結果数指定
search-docs search "検索クエリ" --limit 20
```

### Claude Code統合

```bash
# MCP Serverとして追加
claude mcp add search-docs -- search-docs mcp-server --project $(pwd)
```

### 設定ファイル

プロジェクトルートに `.search-docs/config.json` を配置：

```json
{
  "version": "1.0",
  "files": {
    "include": ["**/*.md", "docs/**/*.txt"],
    "exclude": ["**/node_modules/**", "**/.git/**"],
    "ignoreGitignore": true
  },
  "indexing": {
    "maxTokensPerSection": 2000,
    "maxDepth": 3
  }
}
```

詳細な設定オプションは [ユーザーガイド](docs/user-guide.md#設定ファイル) を参照してください。

## ドキュメント

### ユーザー向けドキュメント

- **[クイックスタート](docs/quick-start.md)** - 5分で試す基本的な使い方
- **[ユーザーガイド](docs/user-guide.md)** - 包括的な使用方法ガイド
- **[CLIリファレンス](docs/cli-reference.md)** - 全コマンドの詳細な説明
- **[MCP統合ガイド](docs/mcp-integration.md)** - Claude Code統合の手順

### 開発者向けドキュメント

- **[クライアント・サーバアーキテクチャ](docs/client-server-architecture.md)** - システム構成の詳細
- **[データモデル設計](docs/data-model.md)** - データ構造の設計
- **[システムアーキテクチャ](docs/architecture.md)** - 技術スタックと実装詳細
- **[クライアントライブラリ](docs/client-library.md)** - APIリファレンス
- **[ドキュメント一覧](docs/README.md)** - 全ドキュメントの索引

## ライセンス

このプロジェクトはプライベートプロジェクトです。

## 関連プロジェクト

- [sebas-chan](../sebas-chan/): DBエンジンのアーキテクチャ参照元
