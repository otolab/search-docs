# 🐕️ search-docs - Claude Code用プロジェクトガイド

## プロジェクト概要

**search-docs**は、ローカル文書のVector検索システムです。プロジェクト毎に起動される検索サーバと、複数のクライアント形式で構成されています。

## アーキテクチャ

### プロセス構成

```
MCP Server (stdio)
  ├─ in-process: SearchDocsServer (read-only)
  ├─ in-process: WatcherProcess (write, heartbeat調停)
  ├─ in-process: DBEngine
  └─ subprocess: Embedding Server (stateless, 共有可能)
           │
           ▼
       LanceDB (共有ストレージ)
```

**詳細**: docs/client-server-architecture.md

### アーキテクチャ構成

search-docsは以下の構成で動作します：

1. **MCP Server** (`packages/mcp-server/`)
   - Claude Code統合、stdio通信
   - **SearchDocsServerをin-processで直接保持**（HTTPデーモン不要）
   - SearchDocsServiceインターフェイス経由でサーバ機能を利用

2. **JSON-RPC Server** (`packages/server/src/bin/server.ts`)
   - `search-docs server start` コマンドでHTTPサーバとしてexposeする用途
   - WatcherProcess内蔵、Heartbeat調停で複数インスタンス間を自動協調
   - MCPサーバからは使用されない（外部クライアント向け）

3. **Embedding Server** (`packages/db-engine/src/python/embedding_server.py`)
   - Ollama API互換のHTTP埋め込みサーバ
   - 複数プロセスから共有利用可能

**詳細**: docs/architecture.md

### データモデル

- **DocumentStorage**: 文書の永続化（パス形式のキー）
- **SearchIndex**: Vector検索（LanceDB + Ruri Embedding）
- **Section**: 分割データ（depth 0-3、トークン数ベース）

**詳細**: docs/data-model.md

### システム全体

- **TypeScript**: サーバ、クライアント、CLI、MCP Server
- **Python**: LanceDB操作、Vector化（uvで管理）
- **pnpm**: モノレポ管理

**詳細**: docs/architecture.md

## プロジェクト構造

```
search-docs/
├── packages/              # モノレポパッケージ
│   ├── server/           # 検索サーバ
│   ├── client/           # クライアントライブラリ
│   ├── cli/              # CLIツール
│   ├── mcp-server/       # Claude Code統合
│   ├── storage/          # DocumentStorage
│   └── db-engine/        # LanceDB Pythonラッパー
├── docker/               # Docker関連
│   ├── entrypoint.sh    # モード分岐（MCP/Embedding、簡素化済み）
│   └── compose.yaml     # 共有Embeddingサーバ構成例
├── docs/                 # ドキュメント
├── prompts/              # Claude Code設定
│   └── tasks/           # 作業メモ・計画
├── Dockerfile            # マルチステージビルド
├── pyproject.toml        # Python依存関係（uv）
├── pnpm-workspace.yaml   # pnpmワークスペース
└── package.json          # ルートパッケージ
```

## 開発ガイドライン

### 技術スタック

- **パッケージ管理**: pnpm（Node.js）、uv（Python）
- **TypeScript**: Project References、ESLint（typescript-eslint）
- **テスト**: Vitest
- **Vector DB**: LanceDB
- **埋め込みモデル**: Ruri Embedding (cl-nagoya/ruri-v3-30m)
- **Docker**: マルチステージビルド、1イメージ・2モード構成

### Docker構成

**Docker版がfirst choice**です。ランタイム依存（Node.js, Python, uv）を排除し、セキュアな境界で実行できます。

1つのDockerイメージで2つのモードを提供:
- **MCPサーバモード**（デフォルト）: stdio通信、WatcherProcess内蔵（heartbeat調停で自動協調）
- **Embeddingサーバモード**（`--mode=embedding-server`）: HTTP APIで複数プロセスから共有利用

**起動方法**:
```bash
docker run --rm -i \
  -v .:/workspace:ro \
  -v ./.search-docs:/workspace/.search-docs \
  otolab/search-docs-mcp:latest
```

**環境変数**:
- `EMBEDDING_URL`: 明示的なEmbeddingサーバURL

**npx版**（Docker環境がない場合の代替手段）:
```bash
claude mcp add npx -- -y @search-docs/mcp-server
```

**ユーザー向けガイド**: docs/docker-deployment.md  
**設計文書**: prompts/tasks/task34.docker-mcp-server-investigation.v1.md  
**実装メモ**: prompts/tasks/task34.docker-mcp-server-implementation.v1.md

### コーディング方針

参考レシピ:
- **pnpmモノレポ**: `ai-agent-prompts/recipes/pnpm-workspaces-typescript/`
- **ドキュメント・コード・テスト同期**: `ai-agent-prompts/recipes/document-code-test/`
- **Serena統合**: `ai-agent-prompts/recipes/serena-integration/`

### search-docs利用

このプロジェクト自身のドキュメントをsearch-docsで検索可能にしています。

**利用マニュアル**: prompts/SEARCH_DOCS.md

### 作業メモ

作業計画やメモは `prompts/tasks/` に配置します。このディレクトリは、時系列にセッションごとの作業を記録する場所です。

**作業開始時の必須手順**:
1. **必ず最初に**: `ls -la prompts/tasks/` で既存タスクを確認
2. 最新のタスク番号と内容を把握
3. 新規作業の場合、次の連番でタスクファイルを作成
4. 継続作業の場合、該当タスクファイルを更新

**記録する内容**:
- 作業計画（これから何をするか）
- 作業中のメモ（今何をしているか）
- 完了後のまとめ（何をしたか）
- 将来の課題（現在のtaskファイル内にメモとして記載）

作業開始時に作業計画を書き込んでスタート。作業が完了し次の作業セッションに移るまで、同じタスク番号で作業します。

**命名規約**:
- **Issue関連**: `<issue-number>.<memotitle>.<memo-version>.md`
- **一般作業**: `task<連番>.<memotitle>.<memo-version>.md`
  - 連番は時系列順（task1 → task2 → task3...）
  - **作成前に必ず**: `ls -la prompts/tasks/` で最新番号を確認
  - バージョン（v1, v2...）: 作業計画を大きく書き直したときに上げる
  - 古いバージョンは最後に削除

## 主要な設計決定

### 1. バージョン管理
- ✅ v1: バージョン管理なしの全体保存
- ✅ ストレージインターフェイスを分離（将来的な拡張対応）

### 2. 分割戦略
- ✅ Markdown見出し（H1-H4）による機械的分割
- ✅ トークン数閾値（デフォルト: 2000トークン）
- ✅ 再帰的分割（最大depth=3）

### 3. Dirty管理
- ✅ 古いものから順次更新（created_at昇順）
- ✅ バックグラウンドワーカーで非同期処理
- ✅ 時間差を前提とした設計

### 4. 設定ファイル
- ✅ `.search-docs.json` (推奨) または `search-docs.json`
- ✅ ファイル検索ルール（include/exclude glob）
- ✅ .gitignoreの尊重

### 5. LanceDBインデックス戦略
- ✅ カーディナリティベースのインデックスタイプ選択（BTREE/BITMAP）
- ✅ Phase 1インデックス実装（5つ）
  - index_requests: status (BITMAP), document_path (BTREE), document_hash (BTREE)
  - sections: document_path (BTREE), is_dirty (BITMAP)
- ✅ 前方一致検索機能（includePaths/excludePaths）
  - LIKE演算子によるパス絞り込み
  - DataFusion統計ベース最適化の活用
- 📊 Phase 2/3の実装は使用状況に応じて検討

**詳細**: docs/architecture-decisions.md (ADR-016)

## 参考プロジェクト

- **sebas-chan** (`../sebas-chan/`): DBエンジンのアーキテクチャ参照元
  - LanceDB + Ruri Embeddingの実装パターン
  - JSON-RPC通信パターン

## 次の実装ステップ

1. 型定義とインターフェイスの実装
2. パッケージの基本構造作成
3. サーバの基本実装
4. クライアントライブラリの実装
5. CLIツールの実装
6. MCP Serverの実装

## 関連ドキュメント

- README.md - プロジェクト全体概要
- docs/client-server-architecture.md - アーキテクチャ詳細
- docs/data-model.md - データモデル設計
- docs/architecture.md - システムアーキテクチャ
- docs/architecture-decisions.md - アーキテクチャ決定記録（ADR）
- docs/state-model.md - 内部状態モデル（状態遷移・依存関係）
- prompts/README.md - Claude Code設定

---

**プロジェクトマーク**: 🐕️
**管理**: otolab/search-docs
**目的**: ローカル文書のVector検索システム
