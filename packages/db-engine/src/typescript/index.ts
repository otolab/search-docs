import { spawn, ChildProcess } from 'child_process';
import { EventEmitter } from 'events';
import type { Section } from '@search-docs/types';
import * as path from 'path';
import * as fs from 'fs';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

interface PendingRequest {
  resolve: (value: unknown) => void;
  reject: (error: unknown) => void;
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

export interface SearchParams {
  query: string;
  limit?: number;
  depth?: number | number[];
  includeCleanOnly?: boolean;
}

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

export interface SearchResponse {
  results: SearchResult[];
  total: number;
}

export interface StatsResponse {
  totalSections: number;
  dirtyCount: number;
  totalDocuments: number;
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
    console.log('[DBEngine.connect] __dirname:', __dirname);

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

    const pythonScript = path.join(__dirname, '../../src/python/worker.py');
    const packageRoot = path.join(__dirname, '../..'); // packages/db-engine

    console.log('[DBEngine.connect] packageRoot:', packageRoot);
    console.log('[DBEngine.connect] pythonScript:', pythonScript);

    // uvを必須とする（環境未整備の場合はエラー）
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

    // uv --project でPythonを実行
    const pythonCmd = 'uv';
    const pythonArgs = ['--project', '.', 'run', 'python', pythonScript];

    // モデル選択オプションを追加
    if (this.options.embeddingModel) {
      pythonArgs.push(`--model=${this.options.embeddingModel}`);
    }

    // デバッグ情報を出力
    console.log('Starting Python worker with:');
    console.log('  Command:', pythonCmd);
    console.log('  Args:', pythonArgs);
    console.log('  CWD:', packageRoot);
    console.log('  Script path:', pythonScript);
    console.log('  Script exists:', fs.existsSync(pythonScript));

    this.worker = spawn(pythonCmd, pythonArgs, {
      stdio: ['pipe', 'pipe', 'pipe'],
      cwd: packageRoot,
      env: {
        ...process.env,
        PYTHONUNBUFFERED: '1', // Pythonの出力をバッファリングしない
      },
    });

    this.worker.stdout?.on('data', (data) => {
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
          const response = JSON.parse(line);
          const request = this.pendingRequests.get(response.id);
          if (request) {
            this.pendingRequests.delete(response.id);
            if (response.error) {
              request.reject(new Error(response.error.message));
            } else {
              request.resolve(response.result);
            }
          }
        } catch (e) {
          console.error('Failed to parse response:', e);
          console.error('Line was:', line);
        }
      }
    });

    // stderrの内容を蓄積
    let stderrBuffer = '';

    this.worker.stderr?.on('data', (data) => {
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
      if (workerError) {
        throw workerError;
      }
      throw error;
    }
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
      } catch (e) {
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
    }) as Promise<DBEngineStatus>;
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
  async disconnect(): Promise<void> {
    if (this.worker) {
      this.worker.kill();
      this.worker = null;
      this.isReady = false;
      this.buffer = ''; // バッファをクリア
    }
  }

  /**
   * セクションを追加
   */
  async addSection(section: Omit<Section, 'vector'>): Promise<{ id: string }> {
    const result = await this.sendRequest('addSection', { section });
    return result as { id: string };
  }

  /**
   * 複数のセクションを一括追加
   */
  async addSections(sections: Array<Omit<Section, 'vector'>>): Promise<{ count: number }> {
    const result = await this.sendRequest('addSections', { sections });
    return result as { count: number };
  }

  /**
   * セクションを検索
   */
  async search(params: SearchParams): Promise<SearchResponse> {
    const result = await this.sendRequest('search', params);
    return result as SearchResponse;
  }

  /**
   * 指定パスのセクションを取得
   */
  async getSectionsByPath(documentPath: string): Promise<{ sections: Section[] }> {
    const result = await this.sendRequest('getSectionsByPath', { documentPath });
    return result as { sections: Section[] };
  }

  /**
   * 指定パスのセクションを削除
   */
  async deleteSectionsByPath(documentPath: string): Promise<{ deleted: boolean }> {
    const result = await this.sendRequest('deleteSectionsByPath', { documentPath });
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
    return result as { sections: Section[] };
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
    } catch (e) {
      return {
        status: 'error',
      };
    }
  }
}

export default DBEngine;
