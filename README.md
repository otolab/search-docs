# 🐕️ search-docs

**ローカル文書をAIエージェントが検索できるようにする**

プロジェクトのドキュメント、設計書、調査メモ。大量の文書から必要な情報を見つけるのは大変です。

search-docsは、Markdown文書をVector検索可能にし、Claude CodeなどのAIエージェントが自然言語で検索できるようにします。

## コンセプト

- **ローカルファースト**: すべてのデータはローカルに保存、プライバシー重視
- **エージェント統合**: Claude Codeから自然言語で検索
- **自動更新**: ファイル変更を自動検知、常に最新の情報を検索可能
- **セクション分割**: 文書全体だけでなく、関連する章節を精度高く発見

## 仕組み

search-docsは、シンプルな3層構造で動作します：

```
Markdown文書
    ↓ (見出しで分割)
Sections (depth 0-3)
    ↓ (Vector化)
LanceDB Index
    ↓ (自然言語で検索)
AIエージェント / CLI / API
```

**Document**: プロジェクトの.mdファイル
**Section**: 見出しごとに分割された意味のある単位
**Vector Index**: 日本語最適化モデル（Ruri）でVector化
**Server**: プロジェクトごとに起動、変更を自動検知

詳細: [システムアーキテクチャ](docs/architecture.md)

## 30秒で始める（Claude Code）

### Docker版（推奨）

```bash
docker mcp run search-docs
```

→ [Docker構成ガイド](docs/docker-deployment.md)

### npm/npx版

[uv](https://docs.astral.sh/uv/)（Pythonパッケージマネージャ）が必要です。

```bash
# macOS (Homebrew)
brew install uv

# macOS/Linux (公式インストーラ)
curl -LsSf https://astral.sh/uv/install.sh | sh
```

```bash
claude mcp add npx -- -y @search-docs/mcp-server
```

その後、Claude Codeで：
1. 「search-docsのセットアップをお願い」と依頼
2. MCPを再接続（reconnect）
3. 「このプロジェクトのアーキテクチャについて教えて」と依頼

→ [詳しい手順](docs/mcp-integration.md)

## その他の使い方

### CLIツールとして使う

```bash
# グローバルインストール
npm install -g @search-docs/cli

# またはnpxで直接実行（インストール不要）
npx @search-docs/cli server start
npx @search-docs/cli search "検索クエリ"
```

→ [ユーザーガイド](docs/user-guide.md)

### プログラムから使う

TypeScript/JavaScript APIとしても利用できます。

```typescript
import { SearchClient } from '@search-docs/client';

const client = new SearchClient({ port: 24280 });
const results = await client.search('検索クエリ');
```

→ [クライアントライブラリ](docs/client-library.md)

## 主な特徴

### セクション分割検索

文書全体だけでなく、H1〜H4の見出し単位で検索。関連する章節をピンポイントで発見できます。

### リアルタイム更新

ファイル変更を自動検知、バックグラウンドで再インデックス。常に最新の情報を検索できます。

### プロジェクト独立

プロジェクトごとに独立したサーバとインデックス。複数プロジェクトを同時に使用できます。

### 日本語最適化

日本語に最適化された埋め込みモデル（Ruri）を使用。日本語文書の検索精度が高くなっています。

## アーキテクチャ概要

search-docsは**クライアント・サーバ構成**です：

### Server側
- **Server** (`@search-docs/server`): プロジェクトごとに起動
  - DocumentStorage: ファイルの変更検知
  - SearchIndex: LanceDBによるVector検索
  - IndexWorker: バックグラウンドでの自動更新

### Client側
- **MCP Server** (`@search-docs/mcp-server`): Claude Code統合
- **CLI Tool** (`@search-docs/cli`): コマンドライン
- **Client Library** (`@search-docs/client`): プログラマティックな利用

### DB Engine
- **DB Engine** (`@search-docs/db-engine`): Python/LanceDB/Ruri

詳細: [システムアーキテクチャ](docs/architecture.md) | [データモデル](docs/data-model.md)

## ドキュメント

### 📚 使い始める
- [クイックスタート](docs/quick-start.md) - 5分で体験
- [ユーザーガイド](docs/user-guide.md) - 本格的に使う
- [CLIリファレンス](docs/cli-reference.md) - 全コマンドの詳細

### 🔧 詳しく知る
- [システムアーキテクチャ](docs/architecture.md) - 技術スタックと実装
- [データモデル](docs/data-model.md) - データ構造の設計
- [アーキテクチャ決定記録](docs/architecture-decisions.md) - 設計判断の記録

### 🤝 統合する
- [Claude Code統合](docs/mcp-integration.md) - MCP Serverとして使う
- [クライアントライブラリ](docs/client-library.md) - APIリファレンス

→ [全ドキュメント一覧](docs/README.md)

## ライセンス

このプロジェクトはプライベートプロジェクトです。

## 関連プロジェクト

- [sebas-chan](../sebas-chan/): DBエンジンのアーキテクチャ参照元
