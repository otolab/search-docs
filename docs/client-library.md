# クライアントライブラリ仕様

## 概要

`@search-docs/client`は、search-docsサーバとHTTP JSON-RPC 2.0で通信するTypeScriptクライアントライブラリです。

## インストール

```bash
pnpm add @search-docs/client
```

## 基本的な使用方法

### クライアントの作成

```typescript
import { SearchDocsClient } from '@search-docs/client';

// デフォルト設定
const client = new SearchDocsClient();

// カスタム設定
const client = new SearchDocsClient({
  baseUrl: 'http://localhost:24280',
  timeout: 30000, // ミリ秒
});
```

### 設定オプション

```typescript
interface SearchDocsClientConfig {
  /** サーバURL（デフォルト: http://localhost:24280） */
  baseUrl?: string;
  /** リクエストタイムアウト（ミリ秒、デフォルト: 30000） */
  timeout?: number;
}
```

## API メソッド

### search()

文書を検索します。

```typescript
async search(request: SearchRequest): Promise<SearchResponse>
```

**パラメータ**:
```typescript
interface SearchRequest {
  query: string;
  options?: SearchOptions;
}

interface SearchOptions {
  limit?: number;           // 最大結果数（デフォルト: 10）
  offset?: number;          // オフセット（デフォルト: 0）
  depthFilter?: number[];   // 深度フィルタ（例: [0, 1]）
  includeCleanOnly?: boolean; // Dirtyセクションを除外（デフォルト: false）
}
```

**戻り値**:
```typescript
interface SearchResponse {
  results: SearchResult[];
  total: number;
  query: string;
}

interface SearchResult {
  section: Section;
  score: number;
  highlights?: string[];
}
```

**使用例**:
```typescript
const results = await client.search({
  query: 'TypeScript 型定義',
  options: {
    limit: 5,
    depthFilter: [1, 2], // H1, H2セクションのみ
  },
});

console.log(`${results.total}件の結果`);
results.results.forEach(result => {
  console.log(`[${result.score.toFixed(2)}] ${result.section.heading}`);
});
```

### getDocument()

文書を取得します。

```typescript
async getDocument(request: GetDocumentRequest): Promise<GetDocumentResponse>
```

**パラメータ**:
```typescript
interface GetDocumentRequest {
  path: string;
}
```

**戻り値**:
```typescript
interface GetDocumentResponse {
  document: Document | null;
}

interface Document {
  path: string;
  title: string;
  content: string;
  metadata: DocumentMetadata;
}
```

**使用例**:
```typescript
const response = await client.getDocument({
  path: 'docs/architecture.md',
});

if (response.document) {
  console.log(response.document.title);
  console.log(response.document.content);
}
```

### indexDocument()

文書をインデックスします。

```typescript
async indexDocument(request: IndexDocumentRequest): Promise<IndexDocumentResponse>
```

**パラメータ**:
```typescript
interface IndexDocumentRequest {
  path: string;
  force?: boolean; // 強制的に再インデックス（デフォルト: false）
}
```

**戻り値**:
```typescript
interface IndexDocumentResponse {
  success: boolean;
  sectionsCreated: number;
}
```

**使用例**:
```typescript
const result = await client.indexDocument({
  path: 'docs/new-document.md',
  force: true,
});

console.log(`${result.sectionsCreated}個のセクションを作成`);
```

### rebuildIndex()

インデックスを再構築します。

```typescript
async rebuildIndex(request?: RebuildIndexRequest): Promise<RebuildIndexResponse>
```

**パラメータ**:
```typescript
interface RebuildIndexRequest {
  paths?: string[]; // 特定のファイルのみ再構築（省略時は全ファイル）
}
```

**戻り値**:
```typescript
interface RebuildIndexResponse {
  success: boolean;
  documentsProcessed: number;
  sectionsCreated: number;
}
```

**使用例**:
```typescript
// 全ファイルを再構築
const result = await client.rebuildIndex();
console.log(`${result.documentsProcessed}個の文書を処理`);

// 特定のファイルのみ再構築
const result = await client.rebuildIndex({
  paths: ['docs/architecture.md', 'docs/api.md'],
});
```

### getStatus()

サーバのステータスを取得します。

```typescript
async getStatus(): Promise<GetStatusResponse>
```

**戻り値**:
```typescript
interface GetStatusResponse {
  server: {
    version: string;
    uptime: number; // ミリ秒
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

**使用例**:
```typescript
const status = await client.getStatus();

console.log(`サーババージョン: ${status.server.version}`);
console.log(`インデックス: ${status.index.totalDocuments}文書、${status.index.totalSections}セクション`);
console.log(`Dirty: ${status.index.dirtyCount}セクション`);
console.log(`ワーカー: ${status.worker.running ? '実行中' : '停止'}`);
```

### healthCheck()

ヘルスチェックを実行します。

```typescript
async healthCheck(): Promise<unknown>
```

**使用例**:
```typescript
try {
  const health = await client.healthCheck();
  console.log('サーバは正常です');
} catch (error) {
  console.error('サーバに接続できません:', error);
}
```

## エラーハンドリング

クライアントは`JsonRpcClientError`をスローします。

```typescript
class JsonRpcClientError extends Error {
  constructor(
    message: string,
    public readonly code: number,
    public readonly data?: unknown
  );
}
```

**JSON-RPCエラーコード**:
- `-32700`: PARSE_ERROR - JSON解析エラー
- `-32600`: INVALID_REQUEST - 無効なリクエスト
- `-32601`: METHOD_NOT_FOUND - メソッドが見つからない
- `-32602`: INVALID_PARAMS - 無効なパラメータ
- `-32603`: INTERNAL_ERROR - 内部エラー

**使用例**:
```typescript
import { JsonRpcClientError } from '@search-docs/client';

try {
  const results = await client.search({ query: 'test' });
} catch (error) {
  if (error instanceof JsonRpcClientError) {
    console.error(`JSON-RPCエラー [${error.code}]: ${error.message}`);
    if (error.data) {
      console.error('詳細:', error.data);
    }
  } else if (error instanceof Error) {
    if (error.message.includes('timeout')) {
      console.error('タイムアウトしました');
    } else {
      console.error('ネットワークエラー:', error.message);
    }
  }
}
```

## タイムアウト制御

デフォルトのタイムアウトは30秒です。カスタマイズできます。

```typescript
const client = new SearchDocsClient({
  timeout: 60000, // 60秒
});
```

タイムアウト時は、以下のエラーがスローされます：

```typescript
Error: Request timeout after 30000ms
```

## 完全な使用例

```typescript
import { SearchDocsClient, JsonRpcClientError } from '@search-docs/client';

async function main() {
  // クライアント作成
  const client = new SearchDocsClient({
    baseUrl: 'http://localhost:24280',
    timeout: 30000,
  });

  try {
    // ヘルスチェック
    await client.healthCheck();
    console.log('✓ サーバ接続成功');

    // ステータス確認
    const status = await client.getStatus();
    console.log(`✓ インデックス: ${status.index.totalDocuments}文書`);

    // 検索実行
    const searchResults = await client.search({
      query: 'TypeScript 型定義',
      options: {
        limit: 5,
        depthFilter: [1, 2],
      },
    });

    console.log(`\n検索結果: ${searchResults.total}件`);
    searchResults.results.forEach((result, i) => {
      console.log(`${i + 1}. [${result.score.toFixed(2)}] ${result.section.heading}`);
      console.log(`   ${result.section.documentPath}`);
    });

    // 文書取得
    if (searchResults.results.length > 0) {
      const docPath = searchResults.results[0].section.documentPath;
      const docResponse = await client.getDocument({ path: docPath });

      if (docResponse.document) {
        console.log(`\n文書: ${docResponse.document.title}`);
        console.log(`内容: ${docResponse.document.content.substring(0, 200)}...`);
      }
    }

  } catch (error) {
    if (error instanceof JsonRpcClientError) {
      console.error(`JSON-RPCエラー [${error.code}]: ${error.message}`);
    } else if (error instanceof Error) {
      console.error('エラー:', error.message);
    }
    process.exit(1);
  }
}

main();
```

## TypeScript型定義

すべての型定義は`@search-docs/types`パッケージから提供されます：

```typescript
import type {
  SearchRequest,
  SearchResponse,
  GetDocumentRequest,
  GetDocumentResponse,
  IndexDocumentRequest,
  IndexDocumentResponse,
  RebuildIndexRequest,
  RebuildIndexResponse,
  GetStatusResponse,
} from '@search-docs/types';
```

詳細は[type-definitions.md](./type-definitions.md)を参照してください。

## 通信プロトコル

クライアントはHTTP JSON-RPC 2.0プロトコルを使用します。

**エンドポイント**:
- `/rpc` - JSON-RPCメソッド呼び出し
- `/health` - ヘルスチェック

**リクエスト形式**:
```json
{
  "jsonrpc": "2.0",
  "method": "search",
  "params": {
    "query": "test",
    "options": {
      "limit": 10
    }
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
    "total": 42,
    "query": "test"
  }
}
```

詳細は[client-server-architecture.md](./client-server-architecture.md)を参照してください。

## 環境要件

- **Node.js**: 18.0.0以上（組み込みfetch APIを使用）
- **TypeScript**: 5.0.0以上（推奨）

## 制限事項

1. **ブラウザサポート**: Node.js専用です。ブラウザでは動作しません（fetchはNode.js組み込みを使用）
2. **同時リクエスト**: 制限なし（サーバ側で制御）
3. **ペイロードサイズ**: 特に制限なし（サーバの設定に依存）

## トラブルシューティング

### 接続エラー

```typescript
Error: Failed to fetch
```

**原因**: サーバが起動していない、または接続先URLが間違っている

**解決策**:
1. サーバが起動していることを確認
2. `baseUrl`が正しいことを確認
3. ファイアウォール設定を確認

### タイムアウトエラー

```typescript
Error: Request timeout after 30000ms
```

**原因**: サーバの応答が遅い、またはネットワーク遅延

**解決策**:
1. `timeout`値を増やす
2. サーバのパフォーマンスを確認
3. ネットワーク状態を確認

### JSON-RPCエラー

```typescript
JsonRpcClientError: Method not found [-32601]
```

**原因**: クライアントとサーバのバージョン不一致

**解決策**:
1. クライアントとサーバのバージョンを確認
2. 両方を最新版に更新

## 参考資料

- [architecture.md](./architecture.md) - システムアーキテクチャ
- [client-server-architecture.md](./client-server-architecture.md) - クライアント・サーバー通信
- [type-definitions.md](./type-definitions.md) - 型定義リファレンス
- [implementation-details.md](./implementation-details.md) - 実装詳細
