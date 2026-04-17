# アーキテクチャ

## 概要

search-docsは、ローカル文書のVector検索を実現するための多層アーキテクチャを採用しています。TypeScriptをメインとし、Vector検索やDBエンジンにはPythonを使用することで、それぞれの言語の強みを活かした設計となっています。Embeddingには ONNX Runtime ベースの自前サーバ（Ollama API互換）を使用し、外部Ollamaへの接続も可能です。

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

## プロセス構成

search-docsは以下の3つのプロセス役割で構成されます。

### 1. MCP Server (`packages/mcp-server/`)

- **役割**: Claude Code統合、stdio通信
- **通信**: クライアント → JSON-RPC Server

### 2. JSON-RPC Server (`packages/server/src/bin/server.ts`)

- **役割**: HTTP JSON-RPCサーバ、検索APIの提供、WatcherProcess内蔵
- **機能**: search, getDocument, getOutline, getStatus
- **WatcherProcess**: FileWatcher, IndexWorker, StartupSyncWorker（heartbeat調停で複数インスタンス間を自動協調）

### 3. Embedding Server (`packages/db-engine/src/python/embedding_server.py`)

- **役割**: Ollama API互換のHTTP埋め込みサーバ
- **アクセスモード**: ステートレス、複数クライアントから共有利用可能
- **起動モード**:
  - 単体利用: MCPサーバプロセス内で自動起動
  - 共有利用: 独立プロセスとして起動（複数プロジェクト共有）

### プロセス間の関係

```
MCP Server
    ↓ JSON-RPC
JSON-RPC Server (WatcherProcess内蔵)
    ↓
┌───────────────────┬────────────────────┐
│                   │                    │
WatcherProcess   DBEngine           Embedding Server
(heartbeat調停)  (read/write)        (stateless)
│                   │                    │
└───────────────────┴────────────────────┘
              LanceDB
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

## SearchDocsServer と WatcherProcess の分離

- **SearchDocsServer**: search, getDocument, getOutline, getStatus のみ（read-only機能）
- **WatcherProcess**: FileWatcher, IndexWorker, StartupSyncWorker, handleFileChange, indexDocument, rebuildIndex（write系全て）

`server.ts` が両方を同一プロセス内で起動し、DBEngineインスタンスを共有します。複数のサーバインスタンスが存在する場合、Heartbeat調停により1つだけがFileWatcherを起動します。

## Heartbeatによる Watcher 調停

複数のWatcherProcessが同時に存在する環境で、1つだけがFileWatcherを起動する仕組みを提供します。

### 調停メカニズム

- **writer_heartbeat テーブル**: LanceDBテーブル（1行のみ、mode='overwrite'で上書き）
- **状態マシン**: sleeping → claiming → watching
- **Master期限切れ**: 2分以上更新なし（`MASTER_TIMEOUT_MS = 120000`）
- **Graceful shutdown**: heartbeatクリア → 即座にfailover

### タイミング定数

| 定数 | 値 | 説明 |
|------|-----|------|
| `HEARTBEAT_INTERVAL_MS` | 20秒 | watching時のheartbeat更新間隔 |
| `MASTER_TIMEOUT_MS` | 120秒 | Master期限切れ判定時間 |
| `MASTER_CHECK_INTERVAL_MS` | 45秒 | sleeping時のmaster確認間隔 |
| `CLAIM_JITTER_MAX_MS` | 5秒 | claim前のランダム待ち時間（thundering herd対策） |
| `CLAIM_READBACK_DELAY_MS` | 4秒 | readback前の待ち時間（排他確認） |

### 状態遷移

1. **sleeping**: 45秒ごとにmasterを確認、期限切れならclaim試行
2. **claiming**: jitter待機 → claim書き込み → readback確認 → 勝者ならwatching、敗者ならsleeping
3. **watching**: 20秒ごとにheartbeat更新、FileWatcher/IndexWorkerを起動

## データストレージ

### ストレージ構造

```
./data/
└── lancedb/
    ├── documents/     # 文書テーブル
    ├── sections/      # セクションテーブル
    └── writer_heartbeat/  # Watcher調停用
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
