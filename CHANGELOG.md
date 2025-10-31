# Changelog

このプロジェクトの変更履歴を記録します。

形式は [Keep a Changelog](https://keepachangelog.com/ja/1.0.0/) に基づき、
バージョニングは [Semantic Versioning](https://semver.org/lang/ja/) に従います。

## [Unreleased]

## [1.0.4] - 2025-10-31

### Added

- **検索結果に文書内位置情報を追加** (#14)
  - `startLine`: セクションの開始行番号
  - `endLine`: セクションの終了行番号
  - `sectionNumber`: セクション番号の階層配列（例: `[1, 2, 1]` は「第1章 > 第2節 > 第1項」）
  - これらの情報により、検索結果から元の文書の正確な位置を特定可能に

### Changed

- **データモデル拡張**: `Section`型に`startLine`, `endLine`, `sectionNumber`フィールドを追加
- **Pythonスキーマ更新**: LanceDBスキーマに新フィールドを追加
- **MarkdownSplitter改善**: 解析時に行番号とセクション番号を自動生成
- **検索API応答**: Python workerからTypeScriptへの変換層を改善

### Fixed

- Python-TypeScript間の型変換でint64→int32キャストエラーを修正
- Python worker内のsearch()メソッドで新フィールドが返されない問題を修正

### Documentation

- ユーザーガイドに検索結果形式の詳細説明を追加
- CLIリファレンスのJSON出力例を更新

## [1.0.3] - 2025-01-30

### Added

- 検索時の`indexStatus`フィルタ機能 (#13)
  - `latest_only`: 最新状態のセクションのみ検索
  - `all`: すべてのセクションを検索
- IndexRequestベースのインデックス管理システム

### Changed

- `addSection()` APIを削除し、`addSections()`に統一

## [1.0.2] - 2025-01-29

### Added

- インデックス再構築コマンド (`index rebuild`)
- ファイル監視機能
- バックグラウンドワーカー

### Fixed

- サーバ起動時のポート競合検出を改善

## [1.0.1] - 2025-01-28

### Changed

- サーバのデフォルト起動モードをバックグラウンドに変更
- 設定ファイル初期化時にランダムポート番号を生成

## [1.0.0] - 2025-01-27

### Added

- 初回リリース
- Markdown文書のVector検索機能
- クライアント・サーバアーキテクチャ
- CLIツール
- MCP Server統合
- 日本語最適化埋め込みモデル (Ruri v3)

[Unreleased]: https://github.com/otolab/search-docs/compare/v1.0.4...HEAD
[1.0.4]: https://github.com/otolab/search-docs/compare/v1.0.3...v1.0.4
[1.0.3]: https://github.com/otolab/search-docs/compare/v1.0.2...v1.0.3
[1.0.2]: https://github.com/otolab/search-docs/compare/v1.0.1...v1.0.2
[1.0.1]: https://github.com/otolab/search-docs/compare/v1.0.0...v1.0.1
[1.0.0]: https://github.com/otolab/search-docs/releases/tag/v1.0.0
