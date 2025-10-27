# 型定義リファレンス

## 概要

このドキュメントは、search-docsプロジェクトにおける全ての型定義とその使用方法を記載します。

---

## @search-docs/types

### Document関連

#### Document

文書の基本構造を表す型。

```typescript
export interface Document {
  path: string;
  content: string;
  metadata: DocumentMetadata;
}
```

**フィールド**:

| フィールド | 型 | 必須 | 説明 |
|-----------|---|------|------|
| path | string | ✓ | 文書の一意なパス（正規化されたUNIX形式） |
| content | string | ✓ | 文書の内容（Markdown） |
| metadata | DocumentMetadata | ✓ | メタデータ |

**使用例**:
```typescript
const doc: Document = {
  path: '/docs/README.md',
  content: '# Hello World\n\nThis is a document.',
  metadata: {
    fileHash: 'a1b2c3d4...',
    lastModified: new Date('2025-01-27'),
    size: 1024,
  },
};
```

**制約**:
- `path`はプロジェクトルートからの相対パス
- スラッシュ区切り（`/`）を使用
- 先頭のスラッシュは任意

#### DocumentMetadata

文書のメタデータ。

```typescript
export interface DocumentMetadata {
  fileHash?: string;
  lastModified?: Date;
  size?: number;
}
```

**フィールド**:

| フィールド | 型 | 必須 | 説明 |
|-----------|---|------|------|
| fileHash | string | - | SHA-256ハッシュ（変更検出用） |
| lastModified | Date | - | 最終更新日時 |
| size | number | - | ファイルサイズ（バイト） |

**使用例**:
```typescript
const metadata: DocumentMetadata = {
  fileHash: 'e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855',
  lastModified: new Date(),
  size: 2048,
};
```

**実装ノート**:
- `fileHash`はストレージ層で自動計算
- すべてのフィールドはオプション（将来的な拡張性）

---

### Section関連

#### Section

文書を分割したセクションの構造。

```typescript
export interface Section {
  id: string;
  documentPath: string;
  heading: string;
  depth: number;
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

**フィールド**:

| フィールド | 型 | 必須 | 説明 |
|-----------|---|------|------|
| id | string | ✓ | セクションの一意なID（UUID推奨） |
| documentPath | string | ✓ | 所属する文書のパス |
| heading | string | ✓ | セクションの見出し |
| depth | number | ✓ | 階層の深さ（0-3） |
| content | string | ✓ | セクションの内容 |
| tokenCount | number | ✓ | トークン数 |
| vector | number[] | ✓ | 埋め込みベクトル（256または768次元） |
| parentId | string \| null | ✓ | 親セクションのID（階層の最上位はnull） |
| order | number | ✓ | 文書内での順序（0から開始） |
| isDirty | boolean | ✓ | 更新が必要かどうか |
| documentHash | string | ✓ | 文書のハッシュ値 |
| createdAt | Date | ✓ | 作成日時 |
| updatedAt | Date | ✓ | 更新日時 |

**使用例**:
```typescript
const section: Section = {
  id: 'sec_abc123',
  documentPath: '/docs/README.md',
  heading: 'Getting Started',
  depth: 1,
  content: '## Getting Started\n\nInstall the package...',
  tokenCount: 150,
  vector: [0.1, 0.2, 0.3, /* ...256個 */],
  parentId: null,
  order: 0,
  isDirty: false,
  documentHash: 'e3b0c44...',
  createdAt: new Date('2025-01-27T10:00:00Z'),
  updatedAt: new Date('2025-01-27T10:00:00Z'),
};
```

**制約**:
- `depth`は0-3の範囲
  - 0: 文書全体
  - 1: H1レベル
  - 2: H2レベル
  - 3: H3レベル
- `tokenCount`は`minTokensForSplit`以上、`maxTokensPerSection`以下
- `vector`の次元数は設定で指定（デフォルト256）

#### SectionMetadata

検索結果などで使用する軽量なメタデータ。

```typescript
export interface SectionMetadata {
  id: string;
  documentPath: string;
  heading: string;
  depth: number;
  tokenCount: number;
  isDirty: boolean;
}
```

**使用例**:
```typescript
const metadata: SectionMetadata = {
  id: 'sec_abc123',
  documentPath: '/docs/README.md',
  heading: 'Getting Started',
  depth: 1,
  tokenCount: 150,
  isDirty: false,
};
```

---

### Config関連

#### SearchDocsConfig

プロジェクト全体の設定。

```typescript
export interface SearchDocsConfig {
  version: string;
  files: FileDiscoveryConfig;
  indexing: IndexingConfig;
  server: ServerConfig;
}
```

**フィールド**:

| フィールド | 型 | 必須 | 説明 |
|-----------|---|------|------|
| version | string | ✓ | 設定ファイルのバージョン |
| files | FileDiscoveryConfig | ✓ | ファイル検索設定 |
| indexing | IndexingConfig | ✓ | インデックス作成設定 |
| server | ServerConfig | ✓ | サーバ設定 |

#### FileDiscoveryConfig

ファイル検索の設定。

```typescript
export interface FileDiscoveryConfig {
  include: string[];
  exclude: string[];
  ignoreGitignore: boolean;
}
```

**フィールド**:

| フィールド | 型 | 必須 | デフォルト | 説明 |
|-----------|---|------|-----------|------|
| include | string[] | ✓ | ['**/*.md'] | 含めるファイルパターン（glob） |
| exclude | string[] | ✓ | ['**/node_modules/**', '**/.git/**'] | 除外するパターン |
| ignoreGitignore | boolean | ✓ | true | .gitignoreを考慮するか |

**使用例**:
```typescript
const fileConfig: FileDiscoveryConfig = {
  include: ['**/*.md', '**/*.mdx'],
  exclude: ['**/node_modules/**', '**/dist/**'],
  ignoreGitignore: true,
};
```

#### IndexingConfig

インデックス作成の設定。

```typescript
export interface IndexingConfig {
  maxTokensPerSection: number;
  minTokensForSplit: number;
  maxDepth: number;
  vectorDimension: number;
  embeddingModel: string;
}
```

**フィールド**:

| フィールド | 型 | 必須 | デフォルト | 説明 |
|-----------|---|------|-----------|------|
| maxTokensPerSection | number | ✓ | 2000 | セクションの最大トークン数 |
| minTokensForSplit | number | ✓ | 100 | 分割する最小トークン数 |
| maxDepth | number | ✓ | 3 | 最大階層深さ |
| vectorDimension | number | ✓ | 256 | ベクトルの次元数 |
| embeddingModel | string | ✓ | 'cl-nagoya/ruri-v3-30m' | 埋め込みモデル名 |

**使用例**:
```typescript
const indexingConfig: IndexingConfig = {
  maxTokensPerSection: 2000,
  minTokensForSplit: 100,
  maxDepth: 3,
  vectorDimension: 256,
  embeddingModel: 'cl-nagoya/ruri-v3-30m',
};
```

**モデル選択肢**:
- `cl-nagoya/ruri-v3-30m`: 256次元、120MB
- `cl-nagoya/ruri-v3-310m`: 768次元、1.2GB

#### ServerConfig

サーバの設定。

```typescript
export interface ServerConfig {
  maxConcurrentIndexing: number;
  dirtyCheckInterval: number;
}
```

**フィールド**:

| フィールド | 型 | 必須 | デフォルト | 説明 |
|-----------|---|------|-----------|------|
| maxConcurrentIndexing | number | ✓ | 3 | 同時にインデックス作成する最大ファイル数 |
| dirtyCheckInterval | number | ✓ | 5000 | Dirtyチェック間隔（ミリ秒） |

---

### API関連

#### SearchRequest

検索リクエスト。

```typescript
export interface SearchRequest {
  query: string;
  limit?: number;
  depth?: number | number[];
  includeCleanOnly?: boolean;
}
```

**フィールド**:

| フィールド | 型 | 必須 | デフォルト | 説明 |
|-----------|---|------|-----------|------|
| query | string | ✓ | - | 検索クエリ（自然言語） |
| limit | number | - | 10 | 結果の最大件数 |
| depth | number \| number[] | - | - | フィルタする階層（例: 1 または [1,2]） |
| includeCleanOnly | boolean | - | false | Dirtyなセクションを除外 |

**使用例**:
```typescript
// 基本的な検索
const req1: SearchRequest = {
  query: 'インストール方法',
  limit: 5,
};

// 階層フィルタ
const req2: SearchRequest = {
  query: 'API',
  depth: [1, 2],  // H1, H2のみ
  includeCleanOnly: true,
};
```

#### SearchResult

検索結果の1件。

```typescript
export interface SearchResult {
  id: string;
  documentPath: string;
  heading: string;
  depth: number;
  content: string;
  score: number;
  isDirty: boolean;
  tokenCount: number;
}
```

**フィールド**:

| フィールド | 型 | 説明 |
|-----------|---|------|
| id | string | セクションID |
| documentPath | string | 文書パス |
| heading | string | 見出し |
| depth | number | 階層 |
| content | string | 内容 |
| score | number | 類似度スコア（L2距離、小さいほど類似） |
| isDirty | boolean | 更新が必要か |
| tokenCount | number | トークン数 |

**使用例**:
```typescript
const result: SearchResult = {
  id: 'sec_abc123',
  documentPath: '/docs/installation.md',
  heading: 'Installation',
  depth: 1,
  content: '## Installation\n\nRun `npm install`...',
  score: 0.15,  // 小さいほど類似
  isDirty: false,
  tokenCount: 120,
};
```

#### SearchResponse

検索レスポンス。

```typescript
export interface SearchResponse {
  results: SearchResult[];
  total: number;
}
```

**フィールド**:

| フィールド | 型 | 説明 |
|-----------|---|------|
| results | SearchResult[] | 検索結果の配列 |
| total | number | 総件数 |

**使用例**:
```typescript
const response: SearchResponse = {
  results: [
    { id: 'sec_1', /* ... */ },
    { id: 'sec_2', /* ... */ },
  ],
  total: 2,
};
```

#### JSONRPCRequest

JSON-RPC 2.0リクエスト。

```typescript
export interface JSONRPCRequest {
  jsonrpc: '2.0';
  method: string;
  params?: unknown;
  id: number | string;
}
```

**使用例**:
```typescript
const rpcReq: JSONRPCRequest = {
  jsonrpc: '2.0',
  method: 'search',
  params: {
    query: 'テスト',
    limit: 10,
  },
  id: 1,
};
```

#### JSONRPCResponse

JSON-RPC 2.0レスポンス。

```typescript
export interface JSONRPCResponse {
  jsonrpc: '2.0';
  result?: unknown;
  error?: JSONRPCError;
  id: number | string;
}

export interface JSONRPCError {
  code: number;
  message: string;
  data?: unknown;
}
```

**使用例**:
```typescript
// 成功
const successResp: JSONRPCResponse = {
  jsonrpc: '2.0',
  result: { results: [...], total: 5 },
  id: 1,
};

// エラー
const errorResp: JSONRPCResponse = {
  jsonrpc: '2.0',
  error: {
    code: -32603,
    message: 'Internal error',
    data: 'Database connection failed',
  },
  id: 1,
};
```

---

### Storage関連

#### DocumentStorage

文書ストレージのインターフェイス。

```typescript
export interface DocumentStorage {
  save(path: string, document: Document): Promise<void>;
  get(path: string): Promise<Document | null>;
  delete(path: string): Promise<void>;
  list(): Promise<string[]>;
  exists(path: string): Promise<boolean>;
}
```

**メソッド**:

##### save
文書を保存する。

```typescript
save(path: string, document: Document): Promise<void>
```

**パラメータ**:
- `path`: 保存先のパス
- `document`: 保存する文書

**例**:
```typescript
await storage.save('/docs/README.md', {
  path: '/docs/README.md',
  content: '# Hello',
  metadata: {},
});
```

##### get
文書を取得する。

```typescript
get(path: string): Promise<Document | null>
```

**パラメータ**:
- `path`: 取得するパス

**戻り値**:
- `Document`: 文書が存在する場合
- `null`: 存在しない場合

**例**:
```typescript
const doc = await storage.get('/docs/README.md');
if (doc) {
  console.log(doc.content);
}
```

##### delete
文書を削除する。

```typescript
delete(path: string): Promise<void>
```

**パラメータ**:
- `path`: 削除するパス

**例**:
```typescript
await storage.delete('/docs/old.md');
```

##### list
全文書のパス一覧を取得する。

```typescript
list(): Promise<string[]>
```

**戻り値**:
- `string[]`: パスの配列

**例**:
```typescript
const paths = await storage.list();
// ['/docs/README.md', '/docs/guide.md', ...]
```

##### exists
文書の存在を確認する。

```typescript
exists(path: string): Promise<boolean>
```

**パラメータ**:
- `path`: 確認するパス

**戻り値**:
- `boolean`: 存在する場合true

**例**:
```typescript
if (await storage.exists('/docs/README.md')) {
  console.log('File exists');
}
```

---

## @search-docs/db-engine

### DBEngineOptions

DB Engineの設定。

```typescript
export interface DBEngineOptions {
  embeddingModel?: string;
  dbPath?: string;
}
```

**フィールド**:

| フィールド | 型 | 必須 | デフォルト | 説明 |
|-----------|---|------|-----------|------|
| embeddingModel | string | - | 'cl-nagoya/ruri-v3-30m' | 埋め込みモデル |
| dbPath | string | - | './.search-docs/index' | DBのパス |

**使用例**:
```typescript
const engine = new DBEngine({
  embeddingModel: 'cl-nagoya/ruri-v3-310m',
  dbPath: './custom-db',
});
```

### DBEngineStatus

DB Engineのステータス。

```typescript
export interface DBEngineStatus {
  status: 'ok' | 'error';
  model_name?: string;
  dimension?: number;
}
```

**使用例**:
```typescript
const status = await engine.getStatus();
if (status.status === 'ok') {
  console.log(`Model: ${status.model_name}, Dim: ${status.dimension}`);
}
```

### StatsResponse

統計情報のレスポンス。

```typescript
export interface StatsResponse {
  totalSections: number;
  dirtyCount: number;
  totalDocuments: number;
}
```

**使用例**:
```typescript
const stats = await engine.getStats();
console.log(`Total: ${stats.totalSections}, Dirty: ${stats.dirtyCount}`);
```

---

## 型の命名規則

### インターフェイス
- PascalCase
- 名詞または名詞句
- 例: `Document`, `SearchRequest`, `FileDiscoveryConfig`

### フィールド
- camelCase（TypeScript）
- snake_case（Python）
- 例: `documentPath` (TS) ⇔ `document_path` (Python)

### 列挙型の値
- 小文字または数値
- 例: `status: 'ok' | 'error'`

### ジェネリック型
- 単一大文字または説明的な名前
- 例: `T`, `TResult`, `TParams`

---

## 型の互換性

### TypeScript ⇔ Python

| TypeScript | Python (PyArrow) | 備考 |
|-----------|-----------------|------|
| string | pa.string() | UTF-8 |
| number | pa.int32() / pa.float32() | 用途に応じて |
| boolean | pa.bool_() | - |
| Date | pa.timestamp('ms') | ミリ秒精度 |
| number[] | pa.list_(pa.float32(), N) | 固定長配列 |
| string \| null | pa.string() | Pythonではnullable |

**変換例**:
```typescript
// TypeScript
interface Section {
  createdAt: Date;
}

// Python
pa.field("created_at", pa.timestamp('ms'))
```

---

## 更新履歴

- 2025-01-27: 初版作成（Phase 1完了時）
