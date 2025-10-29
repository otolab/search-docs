# 🐕️ search-docs - Claude Code用プロジェクトガイド

## プロジェクト概要

**search-docs**は、ローカル文書のVector検索システムです。プロジェクト毎に起動される検索サーバと、複数のクライアント形式で構成されています。

## アーキテクチャ

### クライアント・サーバ構成

```
Client (CLI/MCP/Library)
    ↓ JSON-RPC
Search-Docs Server (プロジェクト毎)
    ↓
DocumentStorage ←→ SearchIndex (LanceDB)
```

**詳細**: @docs/client-server-architecture.md

### データモデル

- **DocumentStorage**: 文書の永続化（パス形式のキー）
- **SearchIndex**: Vector検索（LanceDB + Ruri Embedding）
- **Section**: 分割データ（depth 0-3、トークン数ベース）

**詳細**: @docs/data-model.md

### システム全体

- **TypeScript**: サーバ、クライアント、CLI、MCP Server
- **Python**: LanceDB操作、Vector化（uvで管理）
- **pnpm**: モノレポ管理

**詳細**: @docs/architecture.md

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
├── docs/                 # ドキュメント
├── prompts/              # Claude Code設定
│   └── tasks/           # 作業メモ・計画
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

### コーディング方針

参考レシピ:
- **pnpmモノレポ**: `~/Develop/otolab/ai-agent-prompts/recipes/pnpm-workspaces-typescript/`
- **ドキュメント・コード・テスト同期**: `~/Develop/otolab/ai-agent-prompts/recipes/document-code-test/`
- **Serena統合**: `~/Develop/otolab/ai-agent-prompts/recipes/serena-integration/`

### 作業メモ

作業計画やメモは `prompts/tasks/` に配置：

**目的**: このセッションの作業記録
- 作業計画（これから何をするか）
- 作業中のメモ（今何をしているか）
- 完了後のまとめ（何をしたか）

**重要**: 将来の課題は、今取り組んでいるtaskファイルの中にメモする。作業計画策定前に次のtaskファイルを勝手に作成しない。

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
- ✅ `.search-docs/config.json`
- ✅ ファイル検索ルール（include/exclude glob）
- ✅ .gitignoreの尊重

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

- @README.md - プロジェクト全体概要
- @docs/client-server-architecture.md - アーキテクチャ詳細
- @docs/data-model.md - データモデル設計
- @docs/architecture.md - システムアーキテクチャ
- @prompts/README.md - Claude Code設定

---

**プロジェクトマーク**: 🐕️
**管理**: otolab/search-docs
**目的**: ローカル文書のVector検索システム
