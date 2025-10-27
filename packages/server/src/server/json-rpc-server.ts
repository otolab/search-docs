import express, { type Request, type Response } from 'express';
import cors from 'cors';
import type { Server } from 'http';
import type { SearchDocsServer } from './search-docs-server.js';

/**
 * JSON-RPC 2.0 リクエスト
 */
interface JsonRpcRequest {
  jsonrpc: '2.0';
  method: string;
  params?: unknown;
  id?: string | number | null;
}

/**
 * JSON-RPC 2.0 成功レスポンス
 */
interface JsonRpcSuccessResponse {
  jsonrpc: '2.0';
  result: unknown;
  id: string | number | null;
}

/**
 * JSON-RPC 2.0 エラーレスポンス
 */
interface JsonRpcErrorResponse {
  jsonrpc: '2.0';
  error: {
    code: number;
    message: string;
    data?: unknown;
  };
  id: string | number | null;
}

/**
 * JSON-RPC 2.0 エラーコード
 */
const JSON_RPC_ERROR_CODES = {
  PARSE_ERROR: -32700,
  INVALID_REQUEST: -32600,
  METHOD_NOT_FOUND: -32601,
  INVALID_PARAMS: -32602,
  INTERNAL_ERROR: -32603,
} as const;

/**
 * HTTP JSON-RPCサーバ
 * SearchDocsServerをJSON-RPC over HTTPで公開
 */
export class JsonRpcServer {
  private app: express.Application;
  private server: Server | null = null;

  constructor(
    private searchDocsServer: SearchDocsServer,
    private host: string,
    private port: number
  ) {
    this.app = express();
    this.setupMiddleware();
    this.setupRoutes();
  }

  /**
   * ミドルウェア設定
   */
  private setupMiddleware(): void {
    // CORS設定（複数クライアント対応）
    this.app.use(cors());

    // JSONパーサー
    this.app.use(express.json());

    // リクエストログ
    this.app.use((req, _res, next) => {
      console.log(`[${new Date().toISOString()}] ${req.method} ${req.path}`);
      next();
    });
  }

  /**
   * ルート設定
   */
  private setupRoutes(): void {
    // JSON-RPCエンドポイント
    this.app.post('/rpc', this.handleRpcRequest.bind(this));

    // ヘルスチェック
    this.app.get('/health', (_req, res) => {
      res.json({ status: 'ok' });
    });

    // 404ハンドラ
    this.app.use((_req, res) => {
      res.status(404).json({ error: 'Not Found' });
    });
  }

  /**
   * JSON-RPCリクエストハンドラ
   */
  private async handleRpcRequest(req: Request, res: Response): Promise<void> {
    const request = req.body as JsonRpcRequest;

    // リクエストバリデーション
    if (!this.isValidJsonRpcRequest(request)) {
      res.json(this.createErrorResponse(null, JSON_RPC_ERROR_CODES.INVALID_REQUEST, 'Invalid Request'));
      return;
    }

    try {
      const result = await this.executeMethod(request.method, request.params);
      res.json(this.createSuccessResponse(request.id ?? null, result));
    } catch (error) {
      console.error(`[RPC Error] ${request.method}:`, error);
      res.json(
        this.createErrorResponse(
          request.id ?? null,
          JSON_RPC_ERROR_CODES.INTERNAL_ERROR,
          error instanceof Error ? error.message : 'Internal error',
          error instanceof Error ? { stack: error.stack } : undefined
        )
      );
    }
  }

  /**
   * JSON-RPCリクエストのバリデーション
   */
  private isValidJsonRpcRequest(request: unknown): request is JsonRpcRequest {
    if (typeof request !== 'object' || request === null) {
      return false;
    }

    const req = request as Partial<JsonRpcRequest>;
    return req.jsonrpc === '2.0' && typeof req.method === 'string';
  }

  /**
   * メソッド実行
   */
  private async executeMethod(method: string, params: unknown): Promise<unknown> {
    switch (method) {
      case 'search':
        return await this.searchDocsServer.search(params as any);

      case 'getDocument':
        return await this.searchDocsServer.getDocument(params as any);

      case 'indexDocument':
        return await this.searchDocsServer.indexDocument(params as any);

      case 'rebuildIndex':
        return await this.searchDocsServer.rebuildIndex(params as any);

      case 'getStatus':
        return await this.searchDocsServer.getStatus();

      default:
        throw this.createMethodNotFoundError(method);
    }
  }

  /**
   * 成功レスポンス作成
   */
  private createSuccessResponse(id: string | number | null, result: unknown): JsonRpcSuccessResponse {
    return {
      jsonrpc: '2.0',
      result,
      id,
    };
  }

  /**
   * エラーレスポンス作成
   */
  private createErrorResponse(
    id: string | number | null,
    code: number,
    message: string,
    data?: unknown
  ): JsonRpcErrorResponse {
    const error: { code: number; message: string; data?: unknown } = {
      code,
      message,
    };
    if (data !== undefined) {
      error.data = data;
    }
    return {
      jsonrpc: '2.0',
      error,
      id,
    };
  }

  /**
   * メソッド未検出エラー作成
   */
  private createMethodNotFoundError(method: string): Error {
    const error = new Error(`Method not found: ${method}`);
    (error as any).code = JSON_RPC_ERROR_CODES.METHOD_NOT_FOUND;
    return error;
  }

  /**
   * サーバ起動
   */
  async start(): Promise<void> {
    await this.searchDocsServer.start();

    return new Promise((resolve) => {
      this.server = this.app.listen(this.port, this.host, () => {
        console.log(`JSON-RPC server listening on http://${this.host}:${this.port}/rpc`);
        resolve();
      });
    });
  }

  /**
   * サーバ停止
   */
  async stop(): Promise<void> {
    await this.searchDocsServer.stop();

    if (this.server) {
      return new Promise((resolve, reject) => {
        this.server!.close((err) => {
          if (err) {
            reject(err);
          } else {
            console.log('JSON-RPC server stopped');
            resolve();
          }
        });
      });
    }
  }
}
