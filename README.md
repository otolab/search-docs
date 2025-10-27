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

### サーバの起動

```bash
# プロジェクトディレクトリで起動
cd /path/to/your/project
search-docs server start

# バックグラウンド起動
search-docs server start --daemon

# 設定ファイルを指定
search-docs server start --config ./search-docs.config.json
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

詳細な設定オプションは [docs/client-server-architecture.md](docs/client-server-architecture.md) を参照してください。

## ライセンス

このプロジェクトはプライベートプロジェクトです。

## 関連プロジェクト

- [sebas-chan](../sebas-chan/): DBエンジンのアーキテクチャ参照元
