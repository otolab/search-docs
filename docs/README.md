# 🐕️ search-docs ドキュメント

このディレクトリには、search-docsプロジェクトの技術ドキュメントが含まれています。

## ドキュメント構成

### プロジェクトルート
- **README.md**: プロジェクト概要
- **AGENTS.md**: AI エージェント向けの開発ガイドライン
- **CLAUDE.md**: Claude Code 固有の設定

### docs/ ディレクトリ
技術仕様、設計文書、調査レポート

### 調査レポート配置方針
深い技術調査や設計決定の記録は以下のルールで配置します：

1. **一時的な調査レポート**
   - 配置: `<project-root>/research-report.<topic>.v<N>.md`
   - 理由: 作業中のレポートはルートで管理し、可視性を高める
   - 例: `research-report.section-type-structure.v1.md`

2. **確定した設計文書**
   - 配置: `docs/`
   - 理由: プロジェクトの正式な技術文書として保管
   - 該当する場合は `architecture-decisions.md` に ADR として統合

3. **ライフサイクル**
   - 調査完了後、重要な結論は `docs/` の該当文書に反映
   - 一時レポートは適切なタイミングで削除または `docs/archived/` に移動

## ドキュメント一覧

### コアドキュメント

#### [architecture.md](./architecture.md)
システムアーキテクチャの詳細な説明

- システム構成
- コアコンポーネント
- Vector検索エンジン
- 文書処理層
- データストレージ
- 通信プロトコル
- パフォーマンス最適化

#### [architecture-decisions.md](./architecture-decisions.md)
アーキテクチャ決定記録 (ADR)

- ADR-001: TypeScript + Python ハイブリッド構成
- ADR-002: LanceDB の採用
- ADR-003: JSON-RPC 通信プロトコル
- 将来の重要な設計決定

#### [data-model.md](./data-model.md)
データモデル設計

- Document と Section の構造
- ストレージレイヤーと検索レイヤーの分離
- フラット構造の採用理由 (PyArrow パフォーマンス最適化)
- Dirty 管理と状態遷移

#### [client-server-architecture.md](./client-server-architecture.md)
クライアント・サーバーアーキテクチャ

#### [type-definitions.md](./type-definitions.md)
型定義の詳細

#### [implementation-details.md](./implementation-details.md)
実装の詳細

#### [markdown-splitter-design.md](./markdown-splitter-design.md)
Markdown 分割アルゴリズムの設計

#### [file-watcher-design.md](./file-watcher-design.md)
ファイル監視機能の設計

#### [hierarchical-content-issue.md](./hierarchical-content-issue.md)
階層的コンテンツ処理の課題

### 調査レポート（現在進行中）

#### [../prompts/tasks/research-report.section-type-structure.v1.md](../prompts/tasks/research-report.section-type-structure.v1.md)
Section型構造の調査レポート (2025-01-27)

- TypeScript vs Python 型構造の不一致の発見
- sebas-chan プロジェクトの調査
- フラット構造採用の決定理由
- 実装変更の完全な記録
- **配置**: prompts/tasks（調査完了）

### 今後追加予定

- **setup.md**: セットアップガイド
- **usage.md**: 使用方法
- **api.md**: API リファレンス
- **development.md**: 開発ガイド
