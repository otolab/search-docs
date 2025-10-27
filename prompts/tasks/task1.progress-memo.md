# 作業進捗メモ - search-docs実装

## 最終更新
2025-01-27

## Phase 1: 基盤パッケージ

### 1.1 packages/types ✅ 完了
- Document, Section, Config, API型を定義
- ビルド成功
- コミット完了

### 1.2 packages/storage ✅ 完了
- FileStorageクラス実装
- 15テストケース作成、全て通過
- ビルド成功
- コミット完了

### 1.3 packages/db-engine ✅ 完了

#### Python実装 ✅ 完了
- ✅ schemas.py: PyArrow schema定義
- ✅ embedding.py: Ruri埋め込みモデル統合
- ✅ worker.py: LanceDB JSON-RPCワーカー実装

**実装詳細**:
```
packages/db-engine/src/python/
├── schemas.py       # sections テーブルスキーマ
├── embedding.py     # RuriEmbedding (256d/768d対応)
└── worker.py        # SearchDocsWorker (JSON-RPC)
```

**参考元**: sebas-chan/packages/db/src/python/

#### TypeScript実装 ✅ 完了
- ✅ TypeScriptラッパー作成 (index.ts)
  - Pythonワーカープロセス起動
  - JSON-RPC通信
  - 型付きインターフェイス提供
- ✅ テスト作成 (db-engine.test.ts)
  - 接続テスト
  - CRUD操作テスト
  - 検索テスト (depth フィルタ含む)
  - Dirty管理テスト
  - 統計情報テスト

#### Python環境 ✅ 完了
- ✅ pyproject.toml設定
- ✅ uv sync実行 (47パッケージインストール)
- ✅ sentence-transformers, lancedb導入完了

**成果物**:
- `@search-docs/db-engine`
- 13テストケース作成
- ビルド成功

## 次のアクション

1. ✅ db-engineの実装完了
2. ⏳ 実装をコミット
3. ⏳ Phase 2 (server実装) に進む
   - 設定管理
   - ファイル検索
   - Markdown分割
   - サーバコア

## メモ

- Pythonワーカーは stdin/stdout で JSON-RPC通信
- sebas-chanの実装パターンを踏襲
- モデル初期化は遅延実行（initialize()メソッド）
- ベクトル次元は256 (ruri-v3-30m) または 768 (ruri-v3-310m)
