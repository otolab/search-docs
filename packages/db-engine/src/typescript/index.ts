import { spawn, ChildProcess } from 'child_process';
import { EventEmitter } from 'events';
import type { Section, SearchOptions, SearchResult } from '@search-docs/types';
import * as path from 'path';
import * as fs from 'fs';
import { fileURLToPath } from 'url';

/**
 * パッケージルートディレクトリを取得
 * 現在のファイル（src/typescript/index.ts または dist/index.js）から相対パスで計算
 */
function getPackageRoot(): string {
  const currentFile = fileURLToPath(import.meta.url);

  // src/typescript/index.ts -> src/typescript/ -> src/ -> packages/db-engine/
  // または
  // dist/index.js -> dist/ -> packages/db-engine/
  const currentDir = path.dirname(currentFile);

  // src/typescript/の場合は2階層上、dist/の場合は1階層上
  if (currentDir.endsWith('src/typescript')) {
    return path.dirname(path.dirname(currentDir));
  } else {
    // dist/の場合
    return path.dirname(currentDir);
  }
}

interface PendingRequest {
  resolve: (value: unknown) => void;
  reject: (error: unknown) => void;
}

interface JsonRpcResponse {
  id: number;
  result?: unknown;
  error?: {
    code: number;
    message: string;
  };
}

export interface DBEngineOptions {
  /**
   * 使用する埋め込みモデル
   * - 'cl-nagoya/ruri-v3-30m': 小型モデル (120MB, 256次元)
   * - 'cl-nagoya/ruri-v3-310m': 大型モデル (1.2GB, 768次元)
   * @default 'cl-nagoya/ruri-v3-30m'
   */
  embeddingModel?: string;

  /**
   * データベースパス
   * @default './.search-docs/index'
   */
  dbPath?: string;
}

export interface DBEngineStatus {
  status: 'ok' | 'error';
  model_name?: string;
  dimension?: number;
}

// SearchParams is deprecated. Use SearchOptions from @search-docs/types
export interface SearchParams extends SearchOptions {
  query: string;
}

// DBEngine returns SearchResponse without 'took' field (added by Server layer)
export interface DBEngineSearchResponse {
  results: SearchResult[];
  total: number;
}

export interface StatsResponse {
  totalSections: number;
  dirtyCount: number;
  totalDocuments: number;
}

// IndexRequest関連の型定義
export interface IndexRequest {
  id: string;
  documentPath: string;
  documentHash: string;
  status: 'pending' | 'processing' | 'completed' | 'failed' | 'skipped';
  createdAt: string;  // ISO 8601
  startedAt?: string;  // ISO 8601
  completedAt?: string;  // ISO 8601
  error?: string;
}

export interface IndexRequestFilter {
  documentPath?: string;
  documentHash?: string;
  status?: IndexRequest['status'] | IndexRequest['status'][];
  createdAt?: {
    $lt?: string;  // ISO 8601
    $gt?: string;  // ISO 8601
  };
  order?: 'created_at ASC' | 'created_at DESC';
}

export interface CreateIndexRequestParams {
  documentPath: string;
  documentHash: string;
}

export interface UpdateIndexRequestParams {
  id: string;
  updates: Partial<Omit<IndexRequest, 'id' | 'documentPath' | 'documentHash'>>;
}

export interface UpdateManyIndexRequestsParams {
  filter: Omit<IndexRequestFilter, 'order'>;
  updates: Partial<Omit<IndexRequest, 'id' | 'documentPath' | 'documentHash'>>;
}

export class DBEngine extends EventEmitter {
  private worker: ChildProcess | null = null;
  private requestId = 0;
  private pendingRequests = new Map<number, PendingRequest>();
  private isReady = false;
  private buffer = ''; // 受信データのバッファ
  private options: Required<DBEngineOptions>;

  constructor(options: DBEngineOptions = {}) {
    super();
    this.options = {
      embeddingModel: options.embeddingModel || 'cl-nagoya/ruri-v3-30m',
      dbPath: options.dbPath || './.search-docs/index',
    };
  }

  /**
   * データベースに接続
   */
  async connect(): Promise<void> {
    console.log('[DBEngine.connect] Starting connection...');

    if (this.worker && this.isReady) {
      // 既に接続済みかつ準備完了の場合は何もしない（冪等性）
      console.log('DBEngine: Already connected and ready, skipping reconnection');
      return;
    }

    if (this.worker && !this.isReady) {
      // ワーカーは存在するが準備未完了の場合は待機
      console.log('DBEngine: Worker exists but not ready, waiting for ready state...');
      await this.waitForReady(null, () => false);
      return;
    }

    // パッケージルートを取得（@search-docs/db-engineパッケージのルート）
    const packageRoot = getPackageRoot();
    console.log('[DBEngine.connect] packageRoot:', packageRoot);

    // Pythonスクリプトのパス（パッケージルートからの相対パス）
    const pythonScript = path.join(packageRoot, 'src/python/worker.py');
    console.log('[DBEngine.connect] pythonScript:', pythonScript);
    console.log('[DBEngine.connect] pythonScript exists:', fs.existsSync(pythonScript));

    // pyproject.tomlの存在確認（パッケージルート）
    const pyprojectPath = path.join(packageRoot, 'pyproject.toml');
    console.log('[DBEngine.connect] Checking pyproject.toml at:', pyprojectPath);
    console.log('[DBEngine.connect] pyproject.toml exists:', fs.existsSync(pyprojectPath));

    if (!fs.existsSync(pyprojectPath)) {
      console.error('[DBEngine.connect] ERROR: pyproject.toml not found at:', pyprojectPath);
      throw new Error(
        'pyproject.toml not found. Please ensure the Python environment is properly set up with uv.'
      );
    }
    console.log('[DBEngine.connect] pyproject.toml found OK');

    // uv --project でPythonを実行（パッケージルートを指定）
    const pythonCmd = 'uv';
    const pythonArgs = ['--project', packageRoot, 'run', 'python', pythonScript];

    // モデル選択オプションを追加
    if (this.options.embeddingModel) {
      pythonArgs.push(`--model=${this.options.embeddingModel}`);
    }

    // dbPathを絶対パスに解決して追加
    const absoluteDbPath = path.isAbsolute(this.options.dbPath)
      ? this.options.dbPath
      : path.resolve(process.cwd(), this.options.dbPath);
    pythonArgs.push(`--db-path=${absoluteDbPath}`);

    // デバッグ情報を出力
    console.log('[DBEngine.connect] Starting Python worker with:');
    console.log('  Command:', pythonCmd);
    console.log('  Args:', pythonArgs);
    console.log('  process.cwd():', process.cwd());
    console.log('  this.options.dbPath:', this.options.dbPath);
    console.log('  absoluteDbPath:', absoluteDbPath);

    this.worker = spawn(pythonCmd, pythonArgs, {
      stdio: ['pipe', 'pipe', 'pipe'],
      env: {
        ...process.env,
        PYTHONUNBUFFERED: '1', // Pythonの出力をバッファリングしない
      },
    });

    this.worker.stdout?.on('data', (data: Buffer) => {
      // バッファに追加
      this.buffer += data.toString();

      // 改行で分割して処理
      const lines = this.buffer.split('\n');

      // 最後の要素は不完全な可能性があるので、バッファに残す
      this.buffer = lines.pop() || '';

      // 完全な行だけを処理
      for (const line of lines) {
        if (!line.trim()) continue;

        try {
          const response = JSON.parse(line) as JsonRpcResponse;
          const request = this.pendingRequests.get(response.id);
          if (request) {
            this.pendingRequests.delete(response.id);
            if (response.error) {
              request.reject(new Error(response.error.message));
            } else {
              request.resolve(response.result);
            }
          }
        } catch (error) {
          console.error('Failed to parse response:', error);
          console.error('Line was:', line);
        }
      }
    });

    // stderrの内容を蓄積
    let stderrBuffer = '';

    this.worker.stderr?.on('data', (data: Buffer) => {
      const output = data.toString();
      stderrBuffer += output;
      console.error('Python stderr:', output);
    });

    // ワーカープロセスのエラーや異常終了を追跡
    let workerError: Error | null = null;
    let workerExited = false;

    this.worker.on('error', (error) => {
      console.error('Failed to start Python worker:', error);
      const errorWithCode = error as NodeJS.ErrnoException;
      console.error('  Error code:', errorWithCode.code);
      console.error('  Error syscall:', errorWithCode.syscall);
      console.error('  Error path:', errorWithCode.path);
      workerError = error;
      this.emit('error', error);
    });

    this.worker.on('exit', (code, signal) => {
      console.log(`Python worker exited with code ${code}, signal ${signal}`);
      if (stderrBuffer) {
        console.error('Accumulated stderr output:', stderrBuffer);
      }
      this.isReady = false;
      workerExited = true;
      if (code !== 0 && !workerError) {
        const errorMsg = stderrBuffer
          ? `Python worker exited with code ${code}. Stderr: ${stderrBuffer}`
          : `Python worker exited with code ${code}`;
        workerError = new Error(errorMsg);
      }
      this.worker = null;
    });

    // ワーカーの起動を待つ（実際にpingが通るまで）
    try {
      await this.waitForReady(workerError, () => workerExited);
    } catch (error) {
      // ワーカーが異常終了した場合は、より詳細なエラーを投げる
      if (workerError !== null) {
        // eslint-disable-next-line @typescript-eslint/only-throw-error
        throw workerError;
      }
      if (error instanceof Error) {
        throw error;
      }
      throw new Error(String(error));
    }

    // モデルの初期化を確認
    console.log('[DBEngine.connect] Initializing embedding model...');
    const initResult = await this.initModel();
    if (!initResult.success) {
      throw new Error(
        `Failed to initialize embedding model: ${initResult.model_name}. ` +
        'Vector search will not function properly. ' +
        'Please ensure all Python dependencies (protobuf, sentencepiece) are installed.'
      );
    }
    console.log(`[DBEngine.connect] Embedding model initialized: ${initResult.model_name} (${initResult.dimension}d)`);
  }

  /**
   * DBが準備完了するまで待つ
   */
  private async waitForReady(
    workerError: Error | null,
    isWorkerExited: () => boolean
  ): Promise<void> {
    const maxRetries = 60; // CI環境を考慮して60秒待つ
    const retryInterval = 1000; // 1秒ごとにリトライ

    for (let i = 0; i < maxRetries; i++) {
      // ワーカーが異常終了した場合は即座に失敗
      if (isWorkerExited()) {
        if (workerError) {
          throw workerError;
        }
        throw new Error('Python worker exited unexpectedly during initialization');
      }

      try {
        const status = await this.ping();
        if (status.status === 'ok') {
          this.isReady = true;
          console.log('DB is ready:', status);
          return;
        }
      } catch (_e) {
        // pingが失敗しても続ける（ワーカーが生きている限り）
        if (!isWorkerExited()) {
          console.log(`Waiting for DB to be ready... (${i + 1}/${maxRetries})`);
        }
      }
      await new Promise((resolve) => setTimeout(resolve, retryInterval));
    }

    throw new Error('Timeout waiting for DB to be ready');
  }

  /**
   * ヘルスチェック
   */
  async ping(): Promise<DBEngineStatus> {
    // isReadyチェックをスキップ（起動中にも呼ばれるため）
    if (!this.worker) {
      throw new Error('Not connected to database');
    }

    const id = ++this.requestId;
    const request = {
      jsonrpc: '2.0',
      method: 'ping',
      params: {},
      id,
    };

    return new Promise((resolve, reject) => {
      this.pendingRequests.set(id, {
        resolve: resolve as (value: unknown) => void,
        reject,
      });

      const timeout = setTimeout(() => {
        this.pendingRequests.delete(id);
        reject(new Error('Ping timeout'));
      }, 5000); // 5秒のタイムアウト

      this.worker!.stdin?.write(JSON.stringify(request) + '\n');

      // タイムアウトをクリア
      const originalResolve = this.pendingRequests.get(id)!.resolve;
      this.pendingRequests.get(id)!.resolve = (value) => {
        clearTimeout(timeout);
        originalResolve(value);
      };
    });
  }

  /**
   * モデルを初期化
   * connect後に明示的に呼び出す
   */
  async initModel(): Promise<{ success: boolean; model_name: string; dimension: number }> {
    const result = await this.sendRequest('initModel');
    return result as { success: boolean; model_name: string; dimension: number };
  }

  /**
   * データベースとの接続を切断
   */
  disconnect(): void {
    if (this.worker) {
      this.worker.kill();
      this.worker = null;
      this.isReady = false;
      this.buffer = ''; // バッファをクリア
    }
  }

  /**
   * TypeScript Section → Python形式に変換
   */
  private convertSectionToPythonFormat(section: Omit<Section, 'vector'>): unknown {
    return {
      id: section.id,
      document_path: section.documentPath,        // snake_case
      heading: section.heading,
      depth: section.depth,
      content: section.content,
      token_count: section.tokenCount,            // snake_case
      // vector はPython側で生成されるため送信しない
      parent_id: section.parentId,                // snake_case
      order: section.order,
      is_dirty: section.isDirty,                  // snake_case
      document_hash: section.documentHash,        // snake_case
      created_at: section.createdAt,
      updated_at: section.updatedAt,
      summary: section.summary,
      document_summary: section.documentSummary,  // snake_case
      start_line: section.startLine,              // snake_case
      end_line: section.endLine,                  // snake_case
      section_number: section.sectionNumber,      // snake_case
    };
  }

  /**
   * Python形式 → TypeScript Sectionに変換
   */
  private convertSectionFromPythonFormat(pythonSection: any): Section {
    return {
      id: pythonSection.id,
      documentPath: pythonSection.document_path,
      heading: pythonSection.heading,
      depth: pythonSection.depth,
      content: pythonSection.content,
      tokenCount: pythonSection.token_count,
      vector: pythonSection.vector ? new Float32Array(pythonSection.vector) : new Float32Array(0),
      parentId: pythonSection.parent_id,
      order: pythonSection.order,
      isDirty: pythonSection.is_dirty,
      documentHash: pythonSection.document_hash,
      createdAt: new Date(pythonSection.created_at),
      updatedAt: new Date(pythonSection.updated_at),
      summary: pythonSection.summary,
      documentSummary: pythonSection.document_summary,
      startLine: pythonSection.start_line,
      endLine: pythonSection.end_line,
      sectionNumber: pythonSection.section_number,
    };
  }

  /**
   * 複数のセクションを一括追加
   */
  async addSections(sections: Array<Omit<Section, 'vector'>>): Promise<{ count: number }> {
    const pythonSections = sections.map((s) => this.convertSectionToPythonFormat(s));
    const result = await this.sendRequest('addSections', { sections: pythonSections });
    return result as { count: number };
  }

  /**
   * セクションを検索
   */
  async search(params: SearchParams): Promise<DBEngineSearchResponse> {
    const result = await this.sendRequest('search', params);
    const response = result as any;

    // Pythonから返されたセクションをTypeScript形式に変換
    const convertedResults = response.results.map((section: any) =>
      this.convertSectionFromPythonFormat(section)
    );

    return {
      results: convertedResults,
      total: response.total,
    };
  }

  /**
   * 指定パスのセクションを取得
   */
  async getSectionsByPath(documentPath: string): Promise<{ sections: Section[] }> {
    const result = await this.sendRequest('getSectionsByPath', { documentPath });
    const response = result as any;

    // Pythonから返されたセクションをTypeScript形式に変換
    const convertedSections = response.sections.map((section: any) =>
      this.convertSectionFromPythonFormat(section)
    );

    return { sections: convertedSections };
  }

  /**
   * IDでセクションを取得
   */
  async getSectionById(sectionId: string): Promise<{ section: Section }> {
    const result = await this.sendRequest('getSectionById', { sectionId });
    const response = result as any;

    // Pythonから返されたセクションをTypeScript形式に変換
    const convertedSection = this.convertSectionFromPythonFormat(response.section);

    return { section: convertedSection };
  }

  /**
   * 指定パスのセクションを削除
   */
  async deleteSectionsByPath(documentPath: string): Promise<{ deleted: boolean }> {
    const result = await this.sendRequest('deleteSectionsByPath', { documentPath });
    return result as { deleted: boolean };
  }

  /**
   * 特定のdocument_pathとdocument_hashのセクションを取得
   */
  async findSectionsByPathAndHash(documentPath: string, documentHash: string): Promise<Section[]> {
    const result = await this.sendRequest('findSectionsByPathAndHash', {
      documentPath,
      documentHash
    });
    const response = result as any;

    // Pythonから返されたセクションをTypeScript形式に変換
    return response.sections.map((section: any) => this.convertSectionFromPythonFormat(section));
  }

  /**
   * 指定パスのセクションのうち、指定したhash以外を削除
   */
  async deleteSectionsByPathExceptHash(documentPath: string, documentHash: string): Promise<{ deleted: boolean }> {
    const result = await this.sendRequest('deleteSectionsByPathExceptHash', {
      documentPath,
      documentHash
    });
    return result as { deleted: boolean };
  }

  /**
   * 指定パスのセクションをDirtyにマーク
   */
  async markDirty(documentPath: string): Promise<{ marked: boolean }> {
    const result = await this.sendRequest('markDirty', { documentPath });
    return result as { marked: boolean };
  }

  /**
   * Dirtyなセクションを取得
   */
  async getDirtySections(limit: number = 100): Promise<{ sections: Section[] }> {
    const result = await this.sendRequest('getDirtySections', { limit });
    const response = result as any;

    // Pythonから返されたセクションをTypeScript形式に変換
    const convertedSections = response.sections.map((section: any) =>
      this.convertSectionFromPythonFormat(section)
    );

    return { sections: convertedSections };
  }

  /**
   * 統計情報を取得
   */
  async getStats(): Promise<StatsResponse> {
    const result = await this.sendRequest('getStats');
    return result as StatsResponse;
  }

  /**
   * JSON-RPCリクエストを送信
   */
  private async sendRequest(method: string, params?: unknown): Promise<unknown> {
    if (!this.worker || !this.isReady) {
      throw new Error('Not connected to database');
    }

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
      }, 30000); // 30秒のタイムアウト（CI環境での初期化を考慮）

      this.worker!.stdin?.write(JSON.stringify(request) + '\n');

      // タイムアウトをクリア
      const originalResolve = this.pendingRequests.get(id)!.resolve;
      this.pendingRequests.get(id)!.resolve = (value) => {
        clearTimeout(timeout);
        originalResolve(value);
      };
    });
  }

  /**
   * 現在のステータスを取得
   */
  async getStatus(): Promise<DBEngineStatus> {
    if (!this.isReady) {
      return {
        status: 'error',
      };
    }
    try {
      return await this.ping();
    } catch (_e) {
      return {
        status: 'error',
      };
    }
  }

  // ========================================
  // IndexRequest操作
  // ========================================

  /**
   * IndexRequestを作成
   */
  async createIndexRequest(params: CreateIndexRequestParams): Promise<IndexRequest> {
    // camelCase → snake_caseに変換
    const pythonParams = {
      document_path: params.documentPath,
      document_hash: params.documentHash,
    };

    const result = await this.sendRequest('createIndexRequest', pythonParams);
    return result as IndexRequest;
  }

  /**
   * IndexRequestを検索
   */
  async findIndexRequests(filter: IndexRequestFilter = {}): Promise<IndexRequest[]> {
    // camelCase → snake_caseに変換
    const pythonParams: Record<string, unknown> = {};

    if (filter.documentPath) {
      pythonParams.document_path = filter.documentPath;
    }
    if (filter.documentHash) {
      pythonParams.document_hash = filter.documentHash;
    }
    if (filter.status) {
      pythonParams.status = filter.status;
    }
    if (filter.createdAt) {
      pythonParams.created_at = filter.createdAt;
    }
    if (filter.order) {
      pythonParams.order = filter.order.replace('created_at', 'created_at');
    }

    const result = await this.sendRequest('findIndexRequests', pythonParams);
    const response = result as { requests: IndexRequest[] };
    return response.requests;
  }

  /**
   * IndexRequestを更新
   */
  async updateIndexRequest(id: string, updates: Partial<Omit<IndexRequest, 'id' | 'documentPath' | 'documentHash' | 'createdAt'>>): Promise<IndexRequest> {
    // camelCase → snake_caseに変換
    const pythonUpdates: Record<string, unknown> = {};

    if (updates.status) {
      pythonUpdates.status = updates.status;
    }
    if (updates.startedAt) {
      pythonUpdates.started_at = updates.startedAt;
    }
    if (updates.completedAt) {
      pythonUpdates.completed_at = updates.completedAt;
    }
    if (updates.error) {
      pythonUpdates.error = updates.error;
    }

    const pythonParams = {
      id: id,
      updates: pythonUpdates,
    };

    const result = await this.sendRequest('updateIndexRequest', pythonParams);
    return result as IndexRequest;
  }

  /**
   * 複数のIndexRequestを更新
   */
  async updateManyIndexRequests(
    filter: Partial<IndexRequestFilter>,
    updates: Partial<Omit<IndexRequest, 'id' | 'documentPath' | 'documentHash' | 'createdAt'>>
  ): Promise<{ updated: boolean; count: number }> {
    // camelCase → snake_caseに変換
    const pythonFilter: Record<string, unknown> = {};

    if (filter.documentPath) {
      pythonFilter.document_path = filter.documentPath;
    }
    if (filter.status) {
      pythonFilter.status = filter.status;
    }
    if (filter.createdAt) {
      pythonFilter.created_at = filter.createdAt;
    }

    const pythonUpdates: Record<string, unknown> = {};

    if (updates.status) {
      pythonUpdates.status = updates.status;
    }
    if (updates.completedAt) {
      pythonUpdates.completed_at = updates.completedAt;
    }
    if (updates.error) {
      pythonUpdates.error = updates.error;
    }

    const pythonParams = {
      filter: pythonFilter,
      updates: pythonUpdates,
    };

    const result = await this.sendRequest('updateManyIndexRequests', pythonParams);
    return result as { updated: boolean; count: number };
  }

  /**
   * 特定のstatusを持つdocument_pathを取得
   */
  async getPathsWithStatus(statuses: IndexRequest['status'][]): Promise<string[]> {
    const result = await this.sendRequest('getPathsWithStatus', { statuses });
    const response = result as { paths: string[] };
    return response.paths;
  }
}

export default DBEngine;
