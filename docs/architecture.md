# アーキテクチャ

## 概要

search-docsは、ローカル文書のVector検索を実現するための多層アーキテクチャを採用しています。TypeScriptをメインとし、Vector検索やDBエンジンにはPythonを使用することで、それぞれの言語の強みを活かした設計となっています。

このアーキテクチャは、[sebas-chan](../../sebas-chan/)プロジェクトのDBエンジン実装を参考にしています。

## システム構成

```
┌─────────────────────────────────────────┐
│         TypeScript Layer                │
│  - 文書解析・セクション分割             │
│  - API / インターフェース               │
│  - アプリケーションロジック             │
└──────────────┬──────────────────────────┘
               │ JSON-RPC
┌──────────────▼──────────────────────────┐
│         Python DB Engine                │
│  - Vector検索                           │
│  - 埋め込み生成                         │
│  - LanceDB管理                          │
└─────────────────────────────────────────┘
```

## コアコンポーネント

### 1. Vector検索エンジン (Python)

sebas-chanのアーキテクチャを参考にした、LanceDBベースのVector検索エンジンです。

#### 主要技術スタック

- **LanceDB**: Vector database
  - ローカルファイルベースストレージ
  - 高速なVector検索
  - PyArrowベースのスキーマ定義

- **Ruri Embedding Models**: 日本語最適化埋め込みモデル
  - `cl-nagoya/ruri-v3-30m`: 256次元 (推奨)
  - `cl-nagoya/ruri-v3-310m`: 768次元 (高精度)

#### コンポーネント構成

```
db_engine/
├── lancedb_worker.py     # メインDB操作クラス
├── embedding.py          # 埋め込みモデル管理
└── schemas.py            # DBスキーマ定義
```

##### lancedb_worker.py

JSON-RPCベースの通信インターフェースを提供し、以下の機能を実装します：

- `add_document()`: 文書の追加
- `add_section()`: セクションの追加
- `search_documents()`: 文書検索
- `search_sections()`: セクション検索

##### embedding.py

埋め込みモデルの管理を行います：

- 抽象基底クラス `EmbeddingModel`
- `RuriEmbedding` 実装クラス
- モデルバリアントの動的切り替え
- ベクトル次元の調整機能
  - 高次元ベクトルの切り詰め
  - 低次元ベクトルのゼロパディング
  - L2正規化

##### schemas.py

PyArrowを使用した型安全なスキーマ定義：

```python
DocumentSchema = pa.schema([
    ("id", pa.string()),
    ("file_path", pa.string()),
    ("title", pa.string()),
    ("content", pa.string()),
    ("metadata", pa.string()),  # JSON文字列
    ("vector", pa.list_(pa.float32(), VECTOR_DIM)),
    ("created_at", pa.timestamp('ms')),
    ("updated_at", pa.timestamp('ms'))
])

SectionSchema = pa.schema([
    ("id", pa.string()),
    ("document_id", pa.string()),
    ("heading", pa.string()),
    ("level", pa.int32()),
    ("content", pa.string()),
    ("metadata", pa.string()),  # JSON文字列
    ("vector", pa.list_(pa.float32(), VECTOR_DIM)),
    ("created_at", pa.timestamp('ms'))
])
```

### 2. 文書処理層 (TypeScript)

Markdown文書の解析とセクション分割を担当します。

#### 文書解析

- Markdownパーサーを使用した構造解析
- 見出し階層の認識と保持
- メタデータの抽出

#### セクション分割戦略

1. **見出しベースの分割**
   - H1, H2, H3などの見出しレベルで分割
   - 親子関係の保持

2. **コンテンツのチャンキング**
   - 長文セクションの適切な分割
   - コンテキストの維持

### 3. Vector化プロセス

#### 埋め込み生成ワークフロー

```
テキスト入力
    ↓
関連フィールドの結合
    ↓
埋め込みモデルでエンコード
    ↓
ベクトル次元の調整
    ↓
L2正規化
    ↓
LanceDBへ保存
```

#### テキスト結合戦略

**文書レベル**:
```
title + "\n" + content
```

**セクションレベル**:
```
heading + "\n" + content
```

### 4. 検索機能

#### Vector類似度検索

- コサイン類似度による検索
- Top-K結果の取得
- スコアベースのランキング

#### フィルタリング機能

- メタデータによるフィルタリング
- タイムスタンプベースの絞り込み
- ファイルパスによる範囲指定

#### 検索フォールバック

1. Vector検索を実行
2. 結果が不十分な場合、テキストベース検索にフォールバック
3. 両方の結果をマージしてランキング

## データストレージ

### ストレージ構造

```
./data/
└── lancedb/
    ├── documents/     # 文書テーブル
    └── sections/      # セクションテーブル
```

### データ型

- **テキストフィールド**: 文字列として保存
- **メタデータ**: JSON文字列としてシリアライズ
- **ベクトル**: 固定長float32配列
- **タイムスタンプ**: ミリ秒精度

## 通信プロトコル

### TypeScript ↔ Python間通信

JSON-RPCパターンを採用：

```typescript
// TypeScriptからの呼び出し例
const result = await dbWorker.call('search_documents', {
  query: "検索クエリ",
  limit: 10,
  filter: { source: 'documentation' }
});
```

```python
# Python側のハンドラ
def search_documents(self, query: str, limit: int = 10, filter: dict = None):
    query_vector = self.embedding_model.encode(query)
    results = self.table.search(query_vector).limit(limit)
    if filter:
        results = results.where(filter)
    return results.to_list()
```

## パフォーマンス最適化

### 埋め込みモデル

- **遅延読み込み**: 初回使用時にモデルをロード
- **モデルキャッシング**: メモリ上にモデルを保持
- **エラーハンドリング**: モデルロード失敗時のグレースフルフォールバック

### データベース

- **効率的なインデックス**: LanceDBの最適化されたVector index
- **Pandasベースの操作**: 高速なデータ操作
- **ページネーション**: 大量データの効率的な取得

## スケーラビリティ

### 水平スケーリング

- 複数のドキュメントセットの並列処理
- バッチ処理による効率化

### 垂直スケーリング

- モデルサイズの選択による調整
- ベクトル次元数の最適化

## sebas-chanからの主な継承要素

1. **LanceDBの採用**: 安定性とパフォーマンスの実績
2. **Ruri Embedding Models**: 日本語文書に対する高い精度
3. **JSON-RPC通信パターン**: 言語間の疎結合
4. **PyArrowスキーマ**: 型安全性の確保
5. **動的ベクトル次元調整**: 柔軟なモデル切り替え

## 拡張性

### 将来的な拡張ポイント

- **多言語サポート**: 他言語向け埋め込みモデルの追加
- **高度なフィルタリング**: より複雑なクエリ条件
- **埋め込みキャッシュ**: 頻繁にアクセスされるベクトルのキャッシング
- **インクリメンタル更新**: 文書の部分更新機能

## 参考文献

- [LanceDB Documentation](https://lancedb.github.io/lancedb/)
- [Sentence Transformers](https://www.sbert.net/)
- [PyArrow](https://arrow.apache.org/docs/python/)
- sebas-chan プロジェクト: `../sebas-chan/`
