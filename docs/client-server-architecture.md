# クライアント・サーバアーキテクチャ

## 概要

search-docsは、プロジェクト毎に起動される単一の文書管理・検索サーバと、それと通信するクライアントに分けて実装します。

## アーキテクチャ図

```
┌─────────────────────────────────────────┐
│           Client Applications           │
│  - CLI Tool                             │
│  - MCP Server (Claude Code統合)        │
│  - REST API Client                      │
└──────────────┬──────────────────────────┘
               │ JSON-RPC / HTTP
               │
┌──────────────▼──────────────────────────┐
│         Search-Docs Server              │
│  (プロジェクト毎に1インスタンス)        │
│                                         │
│  ┌─────────────────────────────────┐   │
│  │   Configuration Loader          │   │
│  │   - ファイル検索ルール          │   │
│  │   - インデックス設定            │   │
│  └─────────────────────────────────┘   │
│                                         │
│  ┌─────────────────────────────────┐   │
│  │   Document Manager              │   │
│  │   - DocumentStorage             │   │
│  │   - ファイルウォッチャー        │   │
│  └─────────────────────────────────┘   │
│                                         │
│  ┌─────────────────────────────────┐   │
│  │   Search Engine                 │   │
│  │   - SearchIndex (LanceDB)       │   │
│  │   - Vector検索                  │   │
│  │   - Dirty管理ワーカー           │   │
│  └─────────────────────────────────┘   │
└─────────────────────────────────────────┘
```

## コンポーネント設計

### サーバ側

#### 1. Search-Docs Server

**責務**:
- プロジェクト毎に1インスタンスが起動
- 設定ファイルに基づいてファイルを監視・インデックス
- クライアントからのリクエストを処理

**起動方法**:
```bash
# プロジェクトディレクトリで起動
search-docs-server start

# または設定ファイルを指定
search-docs-server start --config ./search-docs.config.json

# バックグラウンド起動（デフォルト）
search-docs-server start

# フォアグラウンド起動（開発時）
search-docs-server start --foreground

# ポート指定
search-docs-server start --port 24280
```

**プロセス管理**:
- デフォルト: バックグラウンド実行（v1.0.1以降）
- `--foreground`: フォアグラウンド実行
- プロセスIDファイル: `.search-docs/server.pid`
- ログファイル: `.search-docs/server.log`

#### 2. Configuration Loader

**設定ファイルパス**:
1. `.search-docs.json` (プロジェクトルート) - 推奨
2. `search-docs.json` (プロジェクトルート)
3. デフォルト設定

**設定ファイル形式**:
```json
{
  "version": "1.0",
  "project": {
    "name": "my-project",
    "root": "."
  },
  "files": {
    "include": [
      "**/*.md",
      "docs/**/*.txt"
    ],
    "exclude": [
      "**/node_modules/**",
      "**/.git/**",
      "**/dist/**",
      "**/build/**"
    ],
    "ignoreGitignore": true
  },
  "indexing": {
    "maxTokensPerSection": 2000,
    "minTokensForSplit": 100,
    "maxDepth": 3,
    "vectorDimension": 256,
    "embeddingModel": "cl-nagoya/ruri-v3-30m"
  },
  "search": {
    "defaultLimit": 10,
    "maxLimit": 100,
    "includeCleanOnly": false
  },
  "server": {
    "host": "localhost",
    "port": 24280,
    "protocol": "json-rpc"
  },
  "storage": {
    "documentsPath": ".search-docs/documents",
    "indexPath": ".search-docs/index",
    "cachePath": ".search-docs/cache"
  },
  "worker": {
    "enabled": true,
    "interval": 5000,
    "maxConcurrent": 3,
    "pythonMaxMemoryMB": 8192,
    "memoryCheckIntervalMs": 30000
  }
}
```

**設定スキーマ（TypeScript）**:
```typescript
interface SearchDocsConfig {
  version: string;
  project: {
    name: string;
    root: string;
  };
  files: {
    include: string[];      // globパターン
    exclude: string[];      // globパターン
    ignoreGitignore: boolean;
  };
  indexing: {
    maxTokensPerSection: number;
    minTokensForSplit: number;
    maxDepth: number;
    vectorDimension: number;
    embeddingModel: string;
  };
  search: {
    defaultLimit: number;
    maxLimit: number;
    includeCleanOnly: boolean;
  };
  server: {
    host: string;
    port: number;
    protocol: 'json-rpc' | 'http';
  };
  storage: {
    documentsPath: string;
    indexPath: string;
    cachePath: string;
  };
  worker: {
    enabled: boolean;
    interval: number;        // ms
    maxConcurrent: number;
    pythonMaxMemoryMB?: number;        // Pythonワーカーの最大メモリ使用量（MB、デフォルト: 8192）
    memoryCheckIntervalMs?: number;    // メモリ監視の間隔（ms、デフォルト: 30000）
  };
}
```

**メモリ監視機能**:

search-docsは、Pythonワーカーのメモリ使用量を監視し、上限を超えた場合に自動的に再起動する機能を提供します。

- **pythonMaxMemoryMB**: Pythonワーカーの最大メモリ使用量（MB）
  - デフォルト: 8192MB（8GB）
  - メモリ不足でエラーが発生する場合は、この値を増やしてください
  - 例: 大規模プロジェクトでは16384（16GB）に設定

- **memoryCheckIntervalMs**: メモリチェックの間隔（ミリ秒）
  - デフォルト: 30000ms（30秒）
  - より頻繁にチェックする場合は値を小さくしてください

メモリ上限を超えた場合、Pythonワーカーは自動的に再起動され、メモリリークを防ぎます。

#### 3. Document Manager

**責務**:
- 設定に基づいてファイルを検索
- ファイル変更の監視
- DocumentStorageへの保存

**ファイル検索ロジック**:
```typescript
class FileDiscovery {
  constructor(private config: SearchDocsConfig) {}

  async discoverFiles(): Promise<string[]> {
    // 1. includeパターンでファイル検索
    const included = await this.globFiles(this.config.files.include);

    // 2. excludeパターンで除外
    const excluded = await this.globFiles(this.config.files.exclude);

    // 3. .gitignoreの尊重
    let files = this.filterExcluded(included, excluded);
    if (this.config.files.ignoreGitignore) {
      files = await this.filterGitignored(files);
    }

    return files;
  }
}
```

**ファイルウォッチャー**:
- chokidarなどを使用
- 変更検知 → DocumentStorageに保存 → Dirtyマーク

#### 4. Search Engine

**責務**:
- LanceDBによるVector検索
- Dirty管理ワーカーの実行
- 検索結果の整形

### クライアント側

#### 1. CLI Tool

**コマンド例**:
```bash
# サーバ起動
search-docs server start
search-docs server stop
search-docs server status

# 検索
search-docs search "クエリ" [--depth 1] [--limit 10]

# インデックス管理
search-docs index rebuild
search-docs index status

# 設定
search-docs config init
```

#### 2. MCP Server (Claude Code統合)

**目的**: Claude Codeから直接利用可能に

**実装**:
```typescript
class SearchDocsMCPServer {
  async search(query: string, options?: SearchOptions) {
    // クライアントを通じてサーバにリクエスト
    return await this.client.search(query, options);
  }

  async getDocument(path: string) {
    return await this.client.getDocument(path);
  }
}
```

**Claude Code統合**:
```bash
claude mcp add search-docs -- search-docs mcp-server --project $(pwd)
```

#### 3. Client Library

**TypeScript Client**:
```typescript
class SearchDocsClient {
  constructor(private serverUrl: string) {}

  async search(query: string, options?: SearchOptions): Promise<SearchResult[]> {
    return await this.jsonRpcCall('search', { query, options });
  }

  async getDocument(path: string): Promise<Document | null> {
    return await this.jsonRpcCall('getDocument', { path });
  }

  async indexDocument(path: string): Promise<void> {
    return await this.jsonRpcCall('indexDocument', { path });
  }

  async getStatus(): Promise<ServerStatus> {
    return await this.jsonRpcCall('getStatus', {});
  }
}
```

## 通信プロトコル

### JSON-RPC 2.0

**リクエスト形式**:
```json
{
  "jsonrpc": "2.0",
  "id": 1,
  "method": "search",
  "params": {
    "query": "検索クエリ",
    "options": {
      "depth": 1,
      "limit": 10,
      "includeCleanOnly": false
    }
  }
}
```

**レスポンス形式**:
```json
{
  "jsonrpc": "2.0",
  "id": 1,
  "result": {
    "results": [
      {
        "id": "...",
        "documentPath": "docs/README.md",
        "heading": "概要",
        "depth": 1,
        "content": "...",
        "score": 0.95,
        "isDirty": false
      }
    ],
    "total": 42,
    "took": 123
  }
}
```

### API Methods

#### 1. search
```typescript
interface SearchRequest {
  query: string;
  options?: {
    depth?: number | number[];  // 特定depth、または配列で複数指定
    limit?: number;
    offset?: number;
    includeCleanOnly?: boolean;
    sortBy?: 'score' | 'depth' | 'path';
  };
}

interface SearchResponse {
  results: SearchResult[];
  total: number;
  took: number;  // ms
}
```

#### 2. getDocument
```typescript
interface GetDocumentRequest {
  path: string;
}

interface GetDocumentResponse {
  document: Document;
}
```

#### 3. indexDocument
```typescript
interface IndexDocumentRequest {
  path: string;
  force?: boolean;  // Dirtyでなくても再インデックス
}

interface IndexDocumentResponse {
  success: boolean;
  sectionsCreated: number;
}
```

#### 4. getStatus
```typescript
interface GetStatusResponse {
  server: {
    version: string;
    uptime: number;  // ms
    pid: number;
  };
  index: {
    totalDocuments: number;
    totalSections: number;
    dirtyCount: number;
  };
  worker: {
    running: boolean;
    processing: number;
    queue: number;
  };
}
```

#### 5. rebuildIndex
```typescript
interface RebuildIndexRequest {
  paths?: string[];  // 指定しない場合は全体
}

interface RebuildIndexResponse {
  success: boolean;
  documentsProcessed: number;
  sectionsCreated: number;
}
```

## ファイル検索ルール

### Globパターン

**include**:
- `**/*.md` - すべてのMarkdownファイル
- `docs/**/*.txt` - docsディレクトリ配下のテキストファイル
- `*.{md,txt}` - ルートのMarkdown/テキストファイル

**exclude**:
- `**/node_modules/**` - node_modules除外
- `**/.git/**` - .git除外
- `**/dist/**`, `**/build/**` - ビルド成果物除外
- `**/.*` - 隠しファイル除外

### .gitignoreの尊重

`ignoreGitignore: true` の場合:
1. `.gitignore`を解析
2. gitignoreパターンに一致するファイルを除外
3. includeパターンでマッチしても除外される

### 優先順位

```
1. excludeパターン（最優先）
2. .gitignore（ignoreGitignore=trueの場合）
3. includeパターン
```

## プロジェクト構成

```
search-docs/
├── packages/
│   ├── server/              # サーバ実装
│   │   ├── src/
│   │   │   ├── server.ts    # メインサーバ
│   │   │   ├── config.ts    # 設定管理
│   │   │   ├── discovery.ts # ファイル検索
│   │   │   ├── watcher.ts   # ファイル監視
│   │   │   └── api/         # APIハンドラ
│   │   └── package.json
│   │
│   ├── client/              # クライアントライブラリ
│   │   ├── src/
│   │   │   ├── client.ts    # メインクライアント
│   │   │   └── types.ts     # 型定義
│   │   └── package.json
│   │
│   ├── cli/                 # CLIツール
│   │   ├── src/
│   │   │   └── index.ts
│   │   └── package.json
│   │
│   ├── mcp-server/          # MCP Server
│   │   ├── src/
│   │   │   └── index.ts
│   │   └── package.json
│   │
│   ├── storage/             # DocumentStorage実装
│   │   ├── src/
│   │   │   └── index.ts
│   │   └── package.json
│   │
│   └── db-engine/           # LanceDB Pythonラッパー
│       ├── src/
│       │   ├── python/
│       │   │   ├── worker.py
│       │   │   ├── schemas.py
│       │   │   └── embedding.py
│       │   └── typescript/
│       │       └── index.ts
│       └── package.json
```

## デプロイメント

### 開発環境
```bash
# サーバ起動（開発モード）
pnpm --filter @search-docs/server dev

# クライアント接続テスト
pnpm --filter @search-docs/cli search "test"
```

### 本番環境
```bash
# グローバルインストール
npm install -g search-docs

# プロジェクトで初期化
cd /path/to/project
search-docs config init

# サーバ起動（バックグラウンド）
search-docs server start

# Claude Code統合
claude mcp add search-docs -- search-docs mcp-server
```

## セキュリティ考慮事項

### アクセス制御
- デフォルト: localhost のみ
- リモート接続が必要な場合は設定で明示的に有効化

### ファイルアクセス
- プロジェクトルート配下のみアクセス可能
- シンボリックリンクの扱いに注意
- パストラバーサル攻撃の防止

## 次のステップ

1. ✅ クライアント・サーバアーキテクチャの設計
2. 🔲 設定ファイルスキーマの実装
3. 🔲 サーバの基本実装
4. 🔲 クライアントライブラリの実装
5. 🔲 CLIツールの実装
6. 🔲 MCP Serverの実装
