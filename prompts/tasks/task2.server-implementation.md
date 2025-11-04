# Phase 2: サーバ実装計画

> **🔒 この文章はFIXEDです (2025-11-04)**
> 以降の修正は注釈追記のみ許可されます

## 作業日
2025-01-27

## 目的
search-docsサーバパッケージを実装し、文書のインデックス作成・検索機能を提供する。

## 前提条件
- ✅ Phase 1完了 (types, storage, db-engine)
- ✅ ドキュメント作成完了

## 実装順序

Phase 2は以下の順序で実装:

```
2.1 設定管理 → 2.2 ファイル検索 → 2.3 Markdown分割 → 2.4 サーバコア
```

各フェーズは独立してテスト可能。

---

## 2.1 設定管理

### 目的
`.search-docs/config.json`の読み込み、バリデーション、デフォルト値の提供。

### タスク

#### ConfigLoaderクラス
```typescript
export class ConfigLoader {
  static async load(configPath?: string): Promise<SearchDocsConfig>;
  static validate(config: unknown): SearchDocsConfig;
  static getDefaultConfig(): SearchDocsConfig;
}
```

**実装内容**:
- JSONファイル読み込み
- スキーマバリデーション（zodまたは手動）
- デフォルト値のマージ
- エラーハンドリング（不正な設定値）

**ファイル構成**:
```
packages/server/src/
├── config/
│   ├── loader.ts          # ConfigLoader
│   ├── validator.ts       # バリデーション
│   └── __tests__/
│       └── config.test.ts # テスト
```

**テスト観点**:
- ✓ デフォルト設定の取得
- ✓ 有効な設定ファイルの読み込み
- ✓ 不正な設定値の検出
- ✓ 部分的な設定のマージ
- ✓ 存在しないファイルの処理

---

## 2.2 ファイル検索

### 目的
設定に基づいてMarkdownファイルを検索する。

### タスク

#### FileDiscoveryクラス
```typescript
export class FileDiscovery {
  constructor(private config: FileDiscoveryConfig) {}

  async findFiles(rootDir: string): Promise<string[]>;
  private matchesPattern(path: string): boolean;
  private shouldIgnore(path: string): boolean;
}
```

**実装内容**:
- Globパターンマッチング（`minimatch`または`fast-glob`）
- `.gitignore`解析（`ignore`パッケージ）
- 除外パターンの処理
- 相対パス→絶対パス変換

**依存パッケージ**:
- `fast-glob`: 高速なglob実装
- `ignore`: .gitignore互換パーサー

**ファイル構成**:
```
packages/server/src/
├── discovery/
│   ├── file-discovery.ts
│   └── __tests__/
│       └── file-discovery.test.ts
```

**テスト観点**:
- ✓ includeパターンでファイル検索
- ✓ excludeパターンで除外
- ✓ .gitignoreの尊重
- ✓ ネストしたディレクトリ
- ✓ 存在しないディレクトリの処理

---

## 2.3 Markdown分割

### 目的
Markdownファイルをトークンベースでセクションに分割する。

### タスク

#### MarkdownSplitterクラス
```typescript
export class MarkdownSplitter {
  constructor(private config: IndexingConfig) {}

  split(content: string, documentPath: string): Section[];
  private parseMarkdown(content: string): MarkdownNode[];
  private countTokens(text: string): number;
  private splitRecursively(node: MarkdownNode, depth: number): Section[];
}
```

**実装内容**:
- Markdownパーサー（`marked`または`remark`）
- トークンカウンター（`tiktoken`または`gpt-tokenizer`）
- 再帰的分割アルゴリズム
- Section ID生成（nanoid）
- 親子関係の構築

**依存パッケージ**:
- `marked`: 軽量Markdownパーサー
- `gpt-tokenizer`: トークンカウント（tiktoken互換）
- `nanoid`: ID生成

**分割アルゴリズム**:
```
1. Markdownをパース（見出し構造を抽出）
2. depth 0: 文書全体
3. depth 1-3: H1-H3で分割
4. 各セクションのトークン数を計測
5. maxTokensPerSection超過 → 子セクションに分割
6. minTokensForSplit未満 → 親に統合
```

**ファイル構成**:
```
packages/server/src/
├── splitter/
│   ├── markdown-splitter.ts
│   ├── token-counter.ts
│   └── __tests__/
│       ├── markdown-splitter.test.ts
│       └── token-counter.test.ts
```

**テスト観点**:
- ✓ 単純なMarkdownの分割
- ✓ ネストした見出し
- ✓ トークン超過時の分割
- ✓ 小さすぎるセクションの統合
- ✓ コードブロック、リストの処理
- ✓ 日本語テキスト

---

## 2.4 サーバコア

### 目的
JSON-RPCサーバとして動作し、インデックス作成・検索APIを提供する。

### タスク

#### SearchDocsServerクラス
```typescript
export class SearchDocsServer {
  constructor(
    private config: SearchDocsConfig,
    private storage: DocumentStorage,
    private dbEngine: DBEngine
  ) {}

  async start(): Promise<void>;
  async stop(): Promise<void>;

  // API handlers
  async search(params: SearchRequest): Promise<SearchResponse>;
  async indexDocument(path: string): Promise<void>;
  async getDocument(path: string): Promise<Document | null>;
  async rebuildIndex(): Promise<void>;
  async getStatus(): Promise<ServerStatus>;

  private handleRequest(request: JSONRPCRequest): Promise<JSONRPCResponse>;
}
```

**実装内容**:
- JSON-RPCサーバ（stdin/stdoutまたはHTTP）
- APIハンドラの実装
- インデックス作成パイプライン
- Dirtyワーカー（バックグラウンド更新）
- エラーハンドリング

**APIハンドラ**:

##### search
```typescript
Request: SearchRequest
Response: SearchResponse
```
DBEngineに委譲。

##### indexDocument
```typescript
Request: { path: string }
Response: { indexed: boolean }
```
1. ファイル読み込み
2. Markdown分割
3. Storageに保存
4. DBEngineに追加

##### getDocument
```typescript
Request: { path: string }
Response: Document | null
```
Storageから取得。

##### rebuildIndex
```typescript
Request: {}
Response: { total: number, indexed: number }
```
1. 全ファイル検索
2. 各ファイルをインデックス
3. 進捗報告

##### getStatus
```typescript
Request: {}
Response: ServerStatus
```
統計情報とサーバ状態。

#### DirtyWorkerクラス
```typescript
export class DirtyWorker {
  constructor(
    private dbEngine: DBEngine,
    private server: SearchDocsServer,
    private interval: number
  ) {}

  start(): void;
  stop(): void;

  private async processQueue(): Promise<void>;
}
```

**実装内容**:
- 定期実行（setInterval）
- getDirtySections()で取得
- 古い順に再インデックス
- エラーハンドリング

**ファイル構成**:
```
packages/server/src/
├── server/
│   ├── search-docs-server.ts
│   ├── dirty-worker.ts
│   ├── handlers/
│   │   ├── search.ts
│   │   ├── index-document.ts
│   │   ├── get-document.ts
│   │   ├── rebuild-index.ts
│   │   └── get-status.ts
│   └── __tests__/
│       ├── server.test.ts
│       └── dirty-worker.test.ts
└── index.ts  # エクスポート
```

**テスト観点**:
- ✓ サーバ起動・停止
- ✓ 各APIハンドラの動作
- ✓ インデックス作成パイプライン
- ✓ Dirtyワーカーの動作
- ✓ エラーハンドリング
- ✓ 並行アクセス

---

## 依存パッケージ

```json
{
  "dependencies": {
    "@search-docs/types": "workspace:*",
    "@search-docs/storage": "workspace:*",
    "@search-docs/db-engine": "workspace:*",
    "fast-glob": "^3.3.2",
    "ignore": "^6.0.2",
    "marked": "^16.0.0",
    "gpt-tokenizer": "^2.6.1",
    "nanoid": "^5.0.11",
    "chokidar": "^4.0.3"
  },
  "devDependencies": {
    "@types/node": "^22.0.0",
    "vitest": "^2.1.9"
  }
}
```

---

## パッケージ構成

```
packages/server/
├── package.json
├── tsconfig.json
├── src/
│   ├── config/
│   │   ├── loader.ts
│   │   └── validator.ts
│   ├── discovery/
│   │   ├── file-discovery.ts
│   │   └── file-watcher.ts
│   ├── splitter/
│   │   ├── markdown-splitter.ts
│   │   └── token-counter.ts
│   ├── server/
│   │   ├── search-docs-server.ts
│   │   ├── dirty-worker.ts
│   │   └── handlers/
│   ├── __tests__/
│   │   └── integration/
│   │       └── end-to-end.test.ts
│   └── index.ts
└── README.md
```

---

## 実装ステップ

### Step 1: パッケージセットアップ
- [ ] package.json作成
- [ ] tsconfig.json設定
- [ ] 依存パッケージインストール

### Step 2: 設定管理 (2.1)
- [ ] ConfigLoader実装
- [ ] バリデーション実装
- [ ] テスト作成（5-7ケース）

### Step 3: ファイル検索 (2.2)
- [ ] FileDiscovery実装
- [ ] Globマッチング
- [ ] .gitignore対応
- [ ] テスト作成（8-10ケース）

### Step 4: Markdown分割 (2.3)
- [ ] TokenCounter実装
- [ ] MarkdownSplitter実装
- [ ] 再帰的分割ロジック
- [ ] テスト作成（10-12ケース）

### Step 5: サーバコア (2.4)
- [ ] SearchDocsServer実装
- [ ] 各APIハンドラ実装
- [ ] DirtyWorker実装
- [ ] 統合テスト作成（15-20ケース）

### Step 6: E2Eテスト
- [ ] 実際のMarkdownファイルでテスト
- [ ] パフォーマンステスト
- [ ] エラーケーステスト

---

## テスト戦略

### 単体テスト
- 各クラスの独立したテスト
- モックを活用

### 統合テスト
- 複数コンポーネントの連携テスト
- 実際のファイルシステムを使用

### E2Eテスト
- 全体フローのテスト
- 実プロジェクトを模したテスト

---

## 完了条件

- [ ] 全コンポーネントの実装完了
- [ ] テストカバレッジ80%以上
- [ ] ビルド成功
- [ ] 統合テスト全通過
- [ ] ドキュメント更新
- [ ] コミット

---

## 次フェーズへの橋渡し

Phase 2完了後、Phase 3（クライアント実装）で使用する:
- SearchDocsServer APIの仕様
- エラーハンドリングのパターン
- パフォーマンス特性

---

## リスク管理

### 技術リスク
1. **トークンカウントの精度**: tiktoken互換ライブラリの選定
2. **Markdown解析**: 複雑な構造への対応
3. **並行処理**: ファイル変更の競合

### 対応策
- 小さく実装して動作確認
- 既存ライブラリの活用
- テストを充実させる

---

## 進捗管理

このファイルでタスクの進捗を管理:
- [ ]: 未着手
- [x]: 完了

---

**作成日**: 2025-01-27
**状態**: 計画作成完了、実装開始待ち
