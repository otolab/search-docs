# 実装詳細ドキュメント

## 概要

このドキュメントでは、search-docsプロジェクトの実装における重要な設計判断、型定義、アーキテクチャの詳細を記録します。

## 目次

1. [型定義とデータモデル](#型定義とデータモデル)
2. [ストレージ層の実装](#ストレージ層の実装)
3. [DB Engine層の実装](#db-engine層の実装)
4. [通信プロトコル](#通信プロトコル)
5. [将来の拡張性](#将来の拡張性)

---

## 型定義とデータモデル

### Document型

```typescript
export interface Document {
  path: string;
  content: string;
  metadata: DocumentMetadata;
}

export interface DocumentMetadata {
  fileHash?: string;
  lastModified?: Date;
  size?: number;
}
```

**設計意図**:
- `path`をドキュメントの一意なキーとして使用
- バージョン管理はv1では実装せず、インターフェイスで将来的な拡張に備える
- `fileHash`はSHA-256ハッシュで変更検出に使用

**実装判断**:
- パスは正規化されたUNIX形式 (`path.normalize()`)
- Windows/Unix間の互換性を保証
- ハッシュ計算は`crypto.createHash('sha256')`を使用

### Section型

```typescript
export interface Section {
  id: string;
  documentPath: string;
  heading: string;
  depth: number;      // 0-3
  content: string;
  tokenCount: number;
  vector: number[];
  parentId: string | null;
  order: number;
  isDirty: boolean;
  documentHash: string;
  createdAt: Date;
  updatedAt: Date;
}
```

**設計意図**:
- トークンベースの分割により、LLMのコンテキストウィンドウに最適化
- `depth`は0-3の階層構造 (H1-H4相当)
- `parentId`と`order`で文書構造を保持
- `isDirty`フラグで非同期更新を管理

**実装判断**:
- `depth`の範囲制限 (0-3):
  - 0: 文書全体
  - 1-3: H1-H3セクション
  - 理由: 深すぎる階層は検索精度を低下させる
- `tokenCount`の閾値:
  - `maxTokensPerSection: 2000` (分割の上限)
  - `minTokensForSplit: 100` (分割の下限)
  - 理由: LLMのコンテキストサイズとのバランス
- `vector`の次元数:
  - デフォルト: 256 (ruri-v3-30m)
  - オプション: 768 (ruri-v3-310m)
  - 理由: メモリ使用量と検索精度のトレードオフ

### SearchDocsConfig型

```typescript
export interface SearchDocsConfig {
  version: string;
  files: {
    include: string[];
    exclude: string[];
    ignoreGitignore: boolean;
  };
  indexing: {
    maxTokensPerSection: number;
    minTokensForSplit: number;
    maxDepth: number;
    vectorDimension: number;
    embeddingModel: string;
  };
  server: {
    maxConcurrentIndexing: number;
    dirtyCheckInterval: number;
  };
}
```

**設計意図**:
- プロジェクト単位の設定を`.search-docs.json`で管理
- Gitignore互換のパターンマッチング
- インデックス作成と更新のパフォーマンス調整

**デフォルト値の選定理由**:
- `maxTokensPerSection: 2000`: Claude 3.5 Sonnetのコンテキスト（200K）の約1%
- `minTokensForSplit: 100`: 検索結果として意味のある最小単位
- `maxDepth: 3`: 一般的なMarkdown文書の階層構造
- `maxConcurrentIndexing: 3`: ファイルI/Oとモデル処理のバランス
- `dirtyCheckInterval: 5000`: ファイル変更検出の応答性

---

## ストレージ層の実装

### DocumentStorageインターフェイス

```typescript
export interface DocumentStorage {
  save(path: string, document: Document): Promise<void>;
  get(path: string): Promise<Document | null>;
  delete(path: string): Promise<void>;
  list(): Promise<string[]>;
  exists(path: string): Promise<boolean>;
}
```

**設計意図**:
- ストレージ実装の抽象化
- 将来的なストレージバックエンドの切り替えを可能に
- テストの容易性

### FileStorage実装

```typescript
export class FileStorage implements DocumentStorage {
  constructor(
    private baseDir: string = './.search-docs/storage'
  ) {}

  private getFilePath(docPath: string): string {
    const normalized = path.normalize(docPath);
    const safePath = normalized.replace(/^(\.\.(\/|\\|$))+/, '');
    return path.join(this.baseDir, safePath + '.json');
  }

  private calculateHash(content: string): string {
    return createHash('sha256').update(content).digest('hex');
  }
}
```

**実装判断**:
- **ファイル配置**: `.search-docs/storage/`以下にJSON形式で保存
- **パス処理**:
  - `path.normalize()`でWindows/Unix互換性
  - `..`を含むパスを除去してディレクトリトラバーサル攻撃を防止
  - 拡張子`.json`を自動付与
- **ハッシュ計算**: SHA-256を使用
  - 理由: 衝突耐性とパフォーマンスのバランス
  - 用途: 文書変更の検出、Dirty管理のトリガー

**ディレクトリ構造例**:
```
.search-docs/
├── config.json
├── storage/
│   ├── docs/
│   │   └── README.md.json
│   └── guides/
│       └── getting-started.md.json
└── index/           # LanceDB
    └── sections/
```

---

## DB Engine層の実装

### アーキテクチャ概要

```
┌─────────────────────────────────────┐
│   TypeScript (Node.js)              │
│                                     │
│   DBEngine Class                   │
│   - JSON-RPC Client                │
│   - Process Management             │
│   - Type-safe Interface            │
└──────────────┬──────────────────────┘
               │ stdin/stdout
               │ (JSON-RPC 2.0)
┌──────────────▼──────────────────────┐
│   Python (uv managed)               │
│                                     │
│   SearchDocsWorker                 │
│   - LanceDB Operations             │
│   - Vector Embedding (Ruri)        │
│   - Schema Management              │
└─────────────────────────────────────┘
```

### なぜTypeScript + Pythonのハイブリッド構成か

**判断理由**:
1. **TypeScript**: プロジェクトの主要言語、型安全性
2. **Python**: LanceDB、sentence-transformersのエコシステム
3. **JSON-RPC**: 言語間通信の標準化、デバッグの容易性

**代替案との比較**:
- ❌ **Python単体**: Node.jsエコシステムとの統合が困難
- ❌ **TypeScript単体**: LanceDBのTypeScriptバインディングが未成熟
- ✅ **ハイブリッド**: 各言語の強みを活かせる

### Python実装 (worker.py)

#### JSON-RPCプロトコル

**リクエスト形式**:
```json
{
  "jsonrpc": "2.0",
  "method": "search",
  "params": {
    "query": "検索クエリ",
    "limit": 10,
    "depth": [1, 2]
  },
  "id": 1
}
```

**レスポンス形式**:
```json
{
  "jsonrpc": "2.0",
  "id": 1,
  "result": {
    "results": [...],
    "total": 42
  }
}
```

**実装判断**:
- stdin/stdoutによる通信
  - 理由: シンプル、プロセス管理が容易
  - 制限: 大きなペイロード（8KB以上）でバッファオーバーフローの可能性
  - 対策: 将来的にIPC通信への移行を検討
- 改行区切りのJSON
  - 理由: ストリーミング処理、パース境界が明確
- タイムアウト: 30秒
  - 理由: 初回モデルロード時間を考慮

#### LanceDBスキーマ (schemas.py)

```python
def get_sections_schema(vector_dimension: int = 256) -> pa.Schema:
    return pa.schema([
        pa.field("id", pa.string()),
        pa.field("document_path", pa.string()),
        pa.field("heading", pa.string()),
        pa.field("depth", pa.int32()),
        pa.field("content", pa.string()),
        pa.field("token_count", pa.int32()),
        pa.field("vector", pa.list_(pa.float32(), vector_dimension)),
        pa.field("parent_id", pa.string()),
        pa.field("order", pa.int32()),
        pa.field("is_dirty", pa.bool_()),
        pa.field("document_hash", pa.string()),
        pa.field("created_at", pa.timestamp('ms')),
        pa.field("updated_at", pa.timestamp('ms'))
    ])
```

**実装判断**:
- **PyArrowスキーマ**: 型安全性、LanceDBとの親和性
- **vector次元の可変性**: モデル選択に応じて256/768を切り替え
- **timestamp精度**: ミリ秒 (`'ms'`)
  - 理由: JavaScriptのDate型との互換性
  - パフォーマンス: マイクロ秒は不要
- **snake_case**: Pythonの慣例に従う
  - TypeScript側でcamelCaseに変換

#### 埋め込みモデル (embedding.py)

```python
class RuriEmbedding(EmbeddingModel):
    MODEL_CONFIGS = {
        'cl-nagoya/ruri-v3-310m': {
            'dimension': 768,
            'description': 'Large model (1.2GB, 768d)',
            'memory': '~1.2GB'
        },
        'cl-nagoya/ruri-v3-30m': {
            'dimension': 256,
            'description': 'Small model (120MB, 256d)',
            'memory': '~120MB'
        }
    }
```

**モデル選定理由**:
1. **cl-nagoya/ruri-v3-30m (デフォルト)**:
   - メモリ使用量: ~120MB
   - 次元数: 256
   - 用途: 一般的な文書検索、リソース制約のある環境

2. **cl-nagoya/ruri-v3-310m (オプション)**:
   - メモリ使用量: ~1.2GB
   - 次元数: 768
   - 用途: 高精度検索、大規模プロジェクト

**遅延ロード戦略**:
```python
def __init__(self, model_name: str = None):
    self.model = None  # モデルは未ロード
    self.available = False

def initialize(self) -> bool:
    # 明示的な初期化で初めてロード
    from sentence_transformers import SentenceTransformer
    self.model = SentenceTransformer(self.model_name)
    self.available = True
```

**実装判断**:
- **遅延ロード**: プロセス起動時間の短縮
- **明示的初期化**: `initModel()`メソッドで制御
- **次元調整**:
  - 768→256: MRL (Matryoshka Representation Learning) による切り詰め + L2正規化
  - 256→768: ゼロパディング
  - 理由: モデル間の互換性、設定変更時の柔軟性

### TypeScript実装 (index.ts)

#### DBEngineクラス

```typescript
export class DBEngine extends EventEmitter {
  private worker: ChildProcess | null = null;
  private requestId = 0;
  private pendingRequests = new Map<number, PendingRequest>();
  private isReady = false;
  private buffer = ''; // 受信データのバッファ
}
```

**実装判断**:
- **EventEmitter継承**: エラーイベントの伝播
- **pendingRequests Map**: リクエスト/レスポンスの非同期マッピング
- **buffer**: 不完全なJSON行の処理
  - 理由: stdoutは任意のタイミングで分割される
  - 戦略: 改行までバッファリング

#### プロセス管理

```typescript
async connect(): Promise<void> {
  // 冪等性保証
  if (this.worker && this.isReady) {
    return;
  }

  // uvでPython実行
  const pythonCmd = 'uv';
  const pythonArgs = ['--project', '.', 'run', 'python', pythonScript];

  this.worker = spawn(pythonCmd, pythonArgs, {
    stdio: ['pipe', 'pipe', 'pipe'],
    cwd: packageRoot,
    env: {
      ...process.env,
      PYTHONUNBUFFERED: '1',
    },
  });

  await this.waitForReady(workerError, () => workerExited);
}
```

**実装判断**:
- **uv使用**: Python環境の一貫性
- **PYTHONUNBUFFERED**: 出力バッファリング無効化
  - 理由: リアルタイムなJSON-RPC通信
- **waitForReady**: 起動確認のリトライ
  - 最大60秒、1秒間隔
  - CI環境での初回モデルダウンロードを考慮
- **エラー追跡**: stderr蓄積、異常終了時の詳細表示

#### リクエスト送信

```typescript
private async sendRequest(method: string, params?: unknown): Promise<unknown> {
  const id = ++this.requestId;
  const request = {
    jsonrpc: '2.0',
    method,
    params,
    id,
  };

  return new Promise((resolve, reject) => {
    this.pendingRequests.set(id, { resolve, reject });

    const timeout = setTimeout(() => {
      this.pendingRequests.delete(id);
      reject(new Error('Request timeout'));
    }, 30000);

    this.worker!.stdin?.write(JSON.stringify(request) + '\n');
  });
}
```

**実装判断**:
- **リクエストID**: 単調増加、レスポンスマッピング
- **タイムアウト**: 30秒
  - 初期化、大量データ挿入を考慮
- **改行追加**: JSON-RPCメッセージ境界

---

## 通信プロトコル

### JSON-RPC 2.0メソッド一覧

| メソッド | パラメータ | 戻り値 | 用途 |
|---------|-----------|--------|------|
| `ping` | - | `{status: 'ok'}` | ヘルスチェック |
| `initModel` | - | `{success, model_name, dimension}` | モデル初期化 |
| `addSection` | `{section}` | `{id}` | セクション追加 |
| `addSections` | `{sections}` | `{count}` | 一括追加 |
| `search` | `{query, limit?, depth?, includeCleanOnly?}` | `{results, total}` | 検索 |
| `getSectionsByPath` | `{documentPath}` | `{sections}` | パス指定取得 |
| `deleteSectionsByPath` | `{documentPath}` | `{deleted}` | パス指定削除 |
| `markDirty` | `{documentPath}` | `{marked}` | Dirtyマーク |
| `getDirtySections` | `{limit?}` | `{sections}` | Dirty取得 |
| `getStats` | - | `{totalSections, dirtyCount, totalDocuments}` | 統計 |

### 検索クエリの仕様

```typescript
interface SearchParams {
  query: string;              // 検索クエリ（自然言語）
  limit?: number;             // デフォルト: 10
  depth?: number | number[];  // フィルタ: 0, 1, 2, 3 または [1,2]
  includeCleanOnly?: boolean; // Dirtyを除外
}
```

**実装判断**:
- **depth配列対応**: 複数階層の同時検索
  - SQL: `depth = 1 OR depth = 2`
- **includeCleanOnly**: インクリメンタル更新中の検索一貫性
- **スコア**: LanceDBの`_distance`（L2距離）を使用
  - 小さいほど類似度が高い

---

## Dirty管理の仕組み

### Dirtyフラグのライフサイクル

```
1. ファイル変更検出
   ↓
2. markDirty(documentPath)
   - 該当パスの全セクションにis_dirty=trueを設定
   ↓
3. バックグラウンドワーカー（Phase 2で実装）
   - getDirtySections()で取得
   - 古い順にソート（created_at）
   - 再インデックス
   ↓
4. 再インデックス完了
   - deleteSectionsByPath() → addSections()
   - is_dirty=falseで新規作成
```

**実装判断**:
- **非同期更新**: ファイル変更と検索を分離
  - 理由: 大きなファイルの再インデックスをブロックしない
- **古い順**: 長期間更新されていないセクションを優先
  - 戦略: dirtyCheckInterval (5秒) で定期実行
- **全セクション置換**: 部分更新ではなく全削除→再作成
  - 理由: Markdown構造変更時の一貫性保証

### データ不整合の防止

**問題**: Dirty中のセクションが検索結果に含まれる

**解決策**:
1. `includeCleanOnly: true`で除外
2. クライアント側でDirtyフラグを表示
3. バックグラウンド更新の優先度制御

---

## 将来の拡張性

### バージョン管理（Phase 2以降）

**現在の設計**:
```typescript
export interface DocumentStorage {
  save(path: string, document: Document): Promise<void>;
  // バージョン管理は未実装
}
```

**将来の拡張**:
```typescript
export interface DocumentStorage {
  save(path: string, document: Document, version?: string): Promise<void>;
  getVersion(path: string, version: string): Promise<Document | null>;
  listVersions(path: string): Promise<string[]>;
}
```

**実装戦略**:
- ファイル名に`@version`サフィックス: `README.md@v1.json`
- Sectionに`document_version`フィールド追加
- 検索時にバージョン指定可能

### マルチモーダル対応

**現在の制限**: テキストのみ

**将来の拡張**:
- コードブロックの特別扱い
  - Syntaxハイライト情報の保持
  - 言語別インデックス
- 画像埋め込み
  - CLIP等のマルチモーダルモデル
  - 画像キャプションの自動生成

### パフォーマンス最適化

**現在の実装**:
- 同期的なベクトル化
- 単一Pythonプロセス

**最適化候補**:
1. **バッチ処理**: 複数セクションを一度にベクトル化
2. **並列処理**: ワーカープロセスプール
3. **キャッシング**: よく使われるクエリのベクトルをキャッシュ
4. **インデックス最適化**: LanceDBのANN設定調整

### エラーハンドリング

**現在の戦略**:
- Python例外 → JSON-RPCエラーレスポンス
- stderr出力を蓄積
- タイムアウト検出

**改善案**:
- リトライロジック（一時的なエラー）
- 部分的な失敗の許容（バッチ処理）
- 構造化ロギング（JSON形式）

---

## テスト戦略

### 単体テスト

**packages/storage** (15テスト):
- CRUD操作
- パス正規化
- ハッシュ計算
- エラーケース

**packages/db-engine** (13テスト):
- 接続管理
- セクションCRUD
- 検索機能
- Dirty管理
- 統計情報

### 統合テスト（Phase 2）

**予定**:
- ファイル変更 → Dirtyマーク → 再インデックス
- 大量文書の検索パフォーマンス
- 同時アクセス

### E2Eテスト（Phase 3-4）

**予定**:
- CLI経由の全操作
- MCP Server経由のClaude Code統合
- 実プロジェクトでの動作確認

---

## 技術的負債と既知の問題

### 1. JSON-RPCバッファサイズ制限

**問題**: 8KB以上のペイロードでバッファオーバーフロー

**影響**: 大きなセクション（長い文書）の追加失敗

**対策案**:
- チャンク分割送信
- spawnオプションでバッファサイズ拡張
- IPC通信への移行

**優先度**: 中（Phase 2で対応）

### 2. モデルダウンロード時間

**問題**: 初回起動時にモデルダウンロード（数分）

**影響**: ユーザー体験の低下

**対策**:
- `DBClient.initialize()`での事前ダウンロード
- インストールスクリプトへの統合

**優先度**: 高（Phase 3で対応）

### 3. エラーメッセージの日本語化

**問題**: Python例外が英語

**影響**: 日本語ユーザーの理解度

**対策**: エラーコード体系とメッセージマッピング

**優先度**: 低（Phase 4以降）

---

## 参考実装

### sebas-chanからの移植

**移植した機能**:
- JSON-RPC通信パターン
- 遅延モデルロード
- PyArrowスキーマ定義
- 次元調整ロジック

**カスタマイズした点**:
- セクション中心の設計（sebas-chanはIssue/Knowledge中心）
- Dirty管理の追加
- トークンベース分割の導入

### 外部ライブラリ

| ライブラリ | バージョン | 用途 |
|-----------|-----------|------|
| lancedb | >=0.5.0 | ベクトルDB |
| sentence-transformers | >=2.2.0 | 埋め込みモデル |
| pyarrow | >=14.0.0 | スキーマ定義 |
| pandas | >=2.0.0 | タイムスタンプ処理 |
| vitest | ^2.1.9 | テスト |

---

## 更新履歴

- 2025-01-27: 初版作成（Phase 1完了時）
