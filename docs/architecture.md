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

search-docsは以下の構成で動作します。

### 1. MCP Server (`packages/mcp-server/`)

- **役割**: Claude Code統合、stdio通信
- **実装**: SearchDocsServerをin-processで直接保持
- **インターフェイス**: SearchDocsServiceインターフェイス経由でサーバ機能を利用
- **機能**: search, getDocument, getOutline, getStatus
- **内蔵コンポーネント**:
  - SearchDocsServer（read-only）
  - WatcherProcess（write、heartbeat調停）
  - DBEngine
  - EmbeddingServerProcess（自動検出・起動管理）

### 2. JSON-RPC Server (`packages/server/src/bin/server.ts`)

- **役割**: HTTPサーバとしてSearchDocsServerをexposeする
- **用途**: `search-docs server start` コマンドで起動、外部クライアント向け
- **機能**: search, getDocument, getOutline, getStatus
- **WatcherProcess**: FileWatcher, IndexWorker, StartupSyncWorker（heartbeat調停で複数インスタンス間を自動協調）
- **注**: MCPサーバからは使用されない（MCPはin-processで動作）

### 3. Embedding Server (`packages/db-engine/src/python/embedding_server.py`)

- **役割**: Ollama API互換のHTTP埋め込みサーバ
- **アクセスモード**: ステートレス、複数クライアントから共有利用可能
- **接続**: MCP / HTTPサーバは `EmbeddingServerProcess` を通じて既存サーバを検出するか、ローカルの子プロセスを起動する
- **独立起動**: `embedding start` や Docker Compose で別に起動し、複数プロジェクトから共有できる
- **実装**: `packages/server/src/embedding/embedding-server-process.ts`

### プロセス間の関係

```
MCP Server (stdio)
  ├─ in-process: SearchDocsServer (read-only)
  ├─ in-process: WatcherProcess (write, heartbeat調停)
  │   ├─ FileWatcher (master時のみ起動)
  │   ├─ IndexWorker (master時のみ起動)
  │   └─ StartupSyncWorker (master時のみ起動)
  ├─ EmbeddingServerProcess ── Embedding Server の検出・起動管理
  └─ in-process: DBEngine ── Python worker ── HTTP ── Embedding Server
                                  └── LanceDB (共有ストレージ)

─────────────────────────────────────────

JSON-RPC Server (HTTP) ← `server start` コマンドで起動
  ├─ in-process: SearchDocsServer (read-only)
  ├─ in-process: WatcherProcess (write, heartbeat調停)
  ├─ EmbeddingServerProcess ── Embedding Server の検出・起動管理
  └─ in-process: DBEngine ── Python worker ── HTTP ── Embedding Server
                                  └── LanceDB (共有ストレージ)
```

### Embeddingの共有と寿命

MCPサーバとHTTPサーバはそれぞれ `SearchDocsServer`、`WatcherProcess`、`DBEngine` を自分のプロセス内に持ちます。`WatcherProcess` は名前に反して独立したOSプロセスではなく、同じインデックスを使う各インスタンスの間で heartbeat によりwriterを調停します。embeddingサーバの選択・寿命管理はこのwriter調停とは別です。

builtin providerの場合、設定の `indexing.embedding.url` があれば、それを優先して試します。なければ `EMBEDDING_URL`、次に `indexing.embeddingUrl` を使います。`EMBEDDING_URL` が設定されている場合は、実際に選ばれたURLへの接続に失敗すると後続を試さずエラーになります。したがって builtin の `url` と `EMBEDDING_URL` の両方がある場合は、前者を必須の接続先として扱います。`EMBEDDING_URL` がない場合は、設定URLの失敗後も検出を続けます。URLの指定がない場合は `127.0.0.1:24281` を試し、その後 Docker service、`host.docker.internal` の順に試します。候補が利用できなければローカルの子を起動し、準備を待ちます。既存候補は `/health` と `/ready` で確認し、旧サーバで `/ready` が404の場合は `/health` にフォールバックします。`/health` が利用できない候補では Ollama互換の `/api/tags` も試します。明示した外部providerはその接続先を検証し、失敗してもローカル起動にフォールバックしません。

既存サーバへの相乗りは接続先の応答による判定であり、PIDファイルや起動元の所有権を確認する仕組みではありません。各利用者は独立して接続先を選び、参照数の管理や起動元の寿命の延長は行いません。MCP / HTTPサーバが自分で起動した子は、起動失敗時や終了処理で停止を試みます。既存サーバや外部providerはそのインスタンスの停止対象にはしません。あるインスタンスが別のインスタンスの子に相乗りしていても、起動元の終了時には子が停止され得ます。MCPの終了処理は停止要求を非同期で開始し、HTTPサーバは停止処理を待ちます。異常終了や停止処理の失敗時まで子の回収を保証するものではありません。

ローカル起動後の準備確認もポートへの応答に基づき、その応答元が今回起動した子自身であることまでは確認しません。起動時のポート競合は [Issue #167](https://github.com/otolab/search-docs/issues/167) で追跡しています。

`embedding start` による独立起動は別の経路です。デーモン起動時は `~/.search-docs/embedding.pid` に管理情報を保存し、起動したCLIの終了後も動作します。foreground起動ではPIDファイルを公開しません。MCP / HTTPサーバによる既存サーバの検出はこのファイルを参照せず、逆に自動起動した子をこのファイルに登録しません。独立起動の停止と診断は [CLIリファレンス](cli-reference.md#embedding-コマンド) を参照してください。PID再利用時の停止対象の安全性は [Issue #168](https://github.com/otolab/search-docs/issues/168) で検討中です。

**SearchDocsServiceインターフェイス**:

MCPサーバとJSON-RPCクライアントは、共通のSearchDocsServiceインターフェイス（`packages/types/src/service.ts`）を実装することで、透過的にサーバ機能を利用できます：

- **SearchDocsServer**: in-processで直接実装
- **SearchDocsClient**: HTTP JSON-RPC経由で実装

これにより、MCPツールはサーバがin-processかHTTP経由かを意識せずに利用できます。

### 検索結果のプレゼンテーション層

`@search-docs/common` (`packages/common/`) は `SearchResponse` の text レンダリングを担う軽量なプレゼンテーション層です。MCP の `search` と CLI の `search --format text` が同じレンダラーを共有し、章節項号、プレビュー、indexStatus、クライアント別ヒントの形式を揃えます。依存は `@search-docs/types` のみに限定しています。

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
- **commit競合のリトライ**: `Retryable commit conflict` / `Please retry` は正常系の競合として、最大5試行（50→100→200ms、以降200ms上限）で再試行
- **世代整理**: heartbeat の書き込み30回ごとに `optimize(cleanup_older_than=10分)` を実行し、古いMVCCバージョンとインデックスファイルを整理
- **状態マシン**: sleeping → claiming → watching
- **Master期限切れ**: 2分以上更新なし（`MASTER_TIMEOUT_MS = 120000`）
- **Graceful shutdown**: heartbeatクリア → 即座にfailover

### タイミング定数

| 定数 | 値 | 説明 |
|------|-----|------|
| `HEARTBEAT_INTERVAL_MS` | 20秒 | watching時のheartbeat更新間隔 |
| `HEARTBEAT_OPTIMIZE_INTERVAL` | 30回 | heartbeatのMVCC世代整理を実行する書き込み間隔 |
| `MASTER_TIMEOUT_MS` | 120秒 | Master期限切れ判定時間 |
| `MASTER_CHECK_INTERVAL_MS` | 45秒 | sleeping時のmaster確認間隔 |
| `CLAIM_JITTER_MAX_MS` | 5秒 | claim前のランダム待ち時間（thundering herd対策） |
| `CLAIM_READBACK_DELAY_MS` | 4秒 | readback前の待ち時間（排他確認） |

### 状態遷移

1. **sleeping**: 45秒ごとにmasterを確認、期限切れならclaim試行
2. **claiming**: jitter待機 → claim書き込み → readback確認 → 勝者ならwatching、敗者ならsleeping
3. **watching**: 20秒ごとにheartbeat更新、FileWatcher/IndexWorkerを起動。更新がリトライ後も失敗した場合はmastershipを再読込し、自分がmasterであれば維持、master喪失または確認不能時のみsleepingへ遷移

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
