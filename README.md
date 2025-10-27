# 🐕️ search-docs

ローカル文書検索システム - Markdown文書に対するVector検索機能を提供します

## 概要

search-docsは、ローカルに保存されたMarkdown文書に対して高度なVector検索を行うサブシステムです。文書全体だけでなく、セクションごとの情報も自動的に分解してインデックス化し、より精緻な検索を可能にします。

## 主な機能

- **文書の自動分解**: Markdown文書をセクション単位で自動的に分解
- **Vector検索**: 文書全体とセクションごとに対してVector検索を実行
- **ローカル実行**: すべての処理をローカル環境で完結
- **日本語最適化**: 日本語文書に最適化された埋め込みモデルを使用

## 技術スタック

### メイン言語
- **TypeScript**: アプリケーションロジック、API、文書処理

### データベースエンジン
- **Python**: Vector検索とDB管理
- **LanceDB**: Vector database
- **Ruri Embedding Models**: 日本語最適化された埋め込みモデル

## アーキテクチャ

search-docsのDBエンジンは、[sebas-chan](../sebas-chan/)プロジェクトのアーキテクチャを参考に設計されています。

詳細なアーキテクチャ情報については、[docs/architecture.md](docs/architecture.md)を参照してください。

## セットアップ

```bash
# 依存関係のインストール
npm install

# Python環境のセットアップ
pip install -r requirements.txt
```

## 使用方法

詳細な使用方法については、[docs/](docs/)ディレクトリ内のドキュメントを参照してください。

## ライセンス

このプロジェクトはプライベートプロジェクトです。

## 関連プロジェクト

- [sebas-chan](../sebas-chan/): DBエンジンのアーキテクチャ参照元
