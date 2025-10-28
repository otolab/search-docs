/**
 * search-docs JSON-RPCクライアント
 */

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
  JsonRpcRequest,
  JsonRpcResponse,
  JsonRpcError,
} from '@search-docs/types';

/**
 * クライアント設定
 */
export interface SearchDocsClientConfig {
  /** サーバURL（デフォルト: http://localhost:24280） */
  baseUrl?: string;
  /** リクエストタイムアウト（ミリ秒、デフォルト: 30000） */
  timeout?: number;
}

/**
 * JSON-RPCエラー
 */
export class JsonRpcClientError extends Error {
  constructor(
    message: string,
    public readonly code: number,
    public readonly data?: unknown
  ) {
    super(message);
    this.name = 'JsonRpcClientError';
  }
}

/**
 * search-docsクライアント
 *
 * HTTPサーバとJSON-RPC 2.0で通信し、検索・インデックス操作を提供
 */
export class SearchDocsClient {
  private baseUrl: string;
  private timeout: number;
  private requestId = 0;

  constructor(config: SearchDocsClientConfig = {}) {
    this.baseUrl = config.baseUrl || 'http://localhost:24280';
    this.timeout = config.timeout || 30000;
  }

  /**
   * 文書を検索
   */
  async search(request: SearchRequest): Promise<SearchResponse> {
    return this.call<SearchResponse>('search', request);
  }

  /**
   * 文書を取得
   */
  async getDocument(request: GetDocumentRequest): Promise<GetDocumentResponse> {
    return this.call<GetDocumentResponse>('getDocument', request);
  }

  /**
   * 文書をインデックス
   */
  async indexDocument(request: IndexDocumentRequest): Promise<IndexDocumentResponse> {
    return this.call<IndexDocumentResponse>('indexDocument', request);
  }

  /**
   * インデックスを再構築
   */
  async rebuildIndex(request: RebuildIndexRequest = {}): Promise<RebuildIndexResponse> {
    return this.call<RebuildIndexResponse>('rebuildIndex', request);
  }

  /**
   * ステータスを取得
   */
  async getStatus(): Promise<GetStatusResponse> {
    return this.call<GetStatusResponse>('getStatus');
  }

  /**
   * ヘルスチェック
   */
  async healthCheck(): Promise<unknown> {
    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), this.timeout);

    try {
      const response = await fetch(`${this.baseUrl}/health`, {
        signal: controller.signal,
      });

      if (!response.ok) {
        throw new Error(`Health check failed: ${response.status} ${response.statusText}`);
      }

      return await response.json();
    } finally {
      clearTimeout(timeoutId);
    }
  }

  /**
   * JSON-RPCメソッド呼び出し
   */
  private async call<T>(method: string, params?: unknown): Promise<T> {
    const id = ++this.requestId;

    const request: JsonRpcRequest = {
      jsonrpc: '2.0',
      method,
      params,
      id,
    };

    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), this.timeout);

    try {
      const response = await fetch(`${this.baseUrl}/rpc`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
        },
        body: JSON.stringify(request),
        signal: controller.signal,
      });

      if (!response.ok) {
        throw new Error(`HTTP ${response.status}: ${response.statusText}`);
      }

      const rpcResponse = (await response.json()) as JsonRpcResponse;

      // エラーレスポンスのチェック
      if ('error' in rpcResponse) {
        const error = rpcResponse.error as JsonRpcError;
        throw new JsonRpcClientError(error.message, error.code, error.data);
      }

      // 成功レスポンス
      if ('result' in rpcResponse) {
        return rpcResponse.result as T;
      }

      throw new Error('Invalid JSON-RPC response: missing result or error');
    } catch (error) {
      if (error instanceof JsonRpcClientError) {
        throw error;
      }

      if (error instanceof Error) {
        if (error.name === 'AbortError') {
          throw new Error(`Request timeout after ${this.timeout}ms`);
        }
        throw error;
      }

      throw new Error('Unknown error occurred');
    } finally {
      clearTimeout(timeoutId);
    }
  }
}
