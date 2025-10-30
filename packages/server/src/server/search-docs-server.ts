import { promises as fs } from 'fs';
import { createHash } from 'crypto';
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
  SearchDocsConfig,
  Document,
} from '@search-docs/types';
import { FileStorage } from '@search-docs/storage';
import { DBEngine } from '@search-docs/db-engine';
import { MarkdownSplitter } from '../splitter/markdown-splitter.js';
import { FileDiscovery } from '../discovery/file-discovery.js';
import { FileWatcher, type FileChangeEvent } from '../discovery/file-watcher.js';
import { IndexWorker } from '../worker/index.js';

/**
 * SearchDocsサーバのメインクラス
 */
export class SearchDocsServer {
  private splitter: MarkdownSplitter;
  private discovery: FileDiscovery;
  private watcher: FileWatcher | null = null;
  private indexWorker: IndexWorker | null = null;
  private startTime: number = 0;

  constructor(
    private config: SearchDocsConfig,
    private storage: FileStorage,
    private dbEngine: DBEngine
  ) {
    this.splitter = new MarkdownSplitter(config.indexing);
    this.discovery = new FileDiscovery({
      rootDir: config.project.root,
      config: config.files,
    });

    // FileWatcher初期化（enabledがtrueの場合のみ）
    if (config.watcher.enabled) {
      this.watcher = new FileWatcher({
        rootDir: config.project.root,
        filesConfig: config.files,
        watcherConfig: config.watcher,
      });

      // イベントハンドラ登録
      this.watcher.on('change', (event: FileChangeEvent) => {
        this.handleFileChange(event).catch((error) => {
          console.error('File change handling error:', error);
        });
      });

      this.watcher.on('error', (error: Error) => {
        console.error('File watcher error:', error);
      });
    }

    // IndexWorker初期化（worker.enabledがtrueの場合のみ）
    if (config.worker.enabled) {
      this.indexWorker = new IndexWorker({
        dbEngine: this.dbEngine,
        storage: this.storage,
        splitter: this.splitter,
        interval: config.worker.interval,
        maxConcurrent: config.worker.maxConcurrent,
      });
    }
  }

  /**
   * サーバ起動
   */
  async start(): Promise<void> {
    this.startTime = Date.now();
    await this.dbEngine.connect();

    // FileWatcher開始
    if (this.watcher) {
      await this.watcher.start();
    }

    // IndexWorker開始
    if (this.indexWorker) {
      this.indexWorker.start();
    }
  }

  /**
   * サーバ停止
   */
  async stop(): Promise<void> {
    // IndexWorker停止
    if (this.indexWorker) {
      this.indexWorker.stop();
    }

    // FileWatcher停止
    if (this.watcher) {
      await this.watcher.stop();
    }

    this.dbEngine.disconnect();
  }

  /**
   * ファイル変更イベント処理
   */
  private async handleFileChange(event: FileChangeEvent): Promise<void> {
    console.log(`File ${event.type}: ${event.path}`);

    switch (event.type) {
      case 'add':
      case 'change':
        // ファイルを読み込んでハッシュ計算
        const content = await fs.readFile(event.path, 'utf-8');
        const hash = createHash('sha256').update(content).digest('hex');

        // IndexRequestを作成
        await this.dbEngine.createIndexRequest({
          documentPath: event.path,
          documentHash: hash,
        });
        console.log(`Created IndexRequest for ${event.path} (${hash.slice(0, 8)})`);
        break;

      case 'unlink':
        // セクションを削除
        await this.dbEngine.deleteSectionsByPath(event.path);
        // ストレージからも削除
        await this.storage.delete(event.path);
        break;
    }
  }

  /**
   * 検索API
   */
  async search(request: SearchRequest): Promise<SearchResponse> {
    const startTime = Date.now();

    const response = await this.dbEngine.search({
      query: request.query,
      ...request.options,
    });

    return {
      results: response.results,
      total: response.total,
      took: Date.now() - startTime,
    };
  }

  /**
   * 文書取得API
   */
  async getDocument(request: GetDocumentRequest): Promise<GetDocumentResponse> {
    const document = await this.storage.get(request.path);

    if (!document) {
      throw new Error(`Document not found: ${request.path}`);
    }

    return { document };
  }

  /**
   * 文書インデックスAPI
   */
  async indexDocument(request: IndexDocumentRequest): Promise<IndexDocumentResponse> {
    const { path, force = false } = request;

    // 1. ファイル読み込み
    const content = await fs.readFile(path, 'utf-8');

    // 2. ハッシュ計算
    const hash = createHash('sha256').update(content).digest('hex');

    // 3. 既存文書をチェック
    const existingDoc = await this.storage.get(path);
    if (existingDoc && existingDoc.metadata.fileHash === hash && !force) {
      // 変更なし
      return { success: true, sectionsCreated: 0 };
    }

    // 4. 文書をストレージに保存
    const document: Document = {
      path,
      title: path, // ファイルパスをタイトルとして使用
      content,
      metadata: {
        createdAt: existingDoc?.metadata.createdAt || new Date(),
        updatedAt: new Date(),
        fileHash: hash,
      },
    };
    await this.storage.save(path, document);

    // 5. IndexRequestを作成（IndexWorkerが処理する）
    await this.dbEngine.createIndexRequest({
      documentPath: path,
      documentHash: hash,
    });

    console.log(`Created IndexRequest for ${path} (${hash.slice(0, 8)})`);

    // Note: IndexWorkerがバックグラウンドで処理するため、
    // sectionsCreatedは0を返す（実際のセクション数は不明）
    return {
      success: true,
      sectionsCreated: 0,
    };
  }

  /**
   * インデックス再構築API
   */
  async rebuildIndex(request: RebuildIndexRequest = {}): Promise<RebuildIndexResponse> {
    const { paths } = request;

    let filesToIndex: string[];

    if (paths && paths.length > 0) {
      // 指定されたパスのみ
      filesToIndex = paths;
    } else {
      // 全ファイル検索
      filesToIndex = await this.discovery.findFiles();
    }

    let documentsProcessed = 0;
    let sectionsCreated = 0;

    for (const filePath of filesToIndex) {
      try {
        const result = await this.indexDocument({
          path: filePath,
          force: true,
        });
        documentsProcessed++;
        sectionsCreated += result.sectionsCreated;
      } catch (error) {
        console.error(`Failed to index ${filePath}:`, error);
      }
    }

    return {
      success: true,
      documentsProcessed,
      sectionsCreated,
    };
  }

  /**
   * ステータス取得API
   */
  async getStatus(): Promise<GetStatusResponse> {
    const stats = await this.dbEngine.getStats();

    // IndexWorkerの状態を取得
    const workerStatus = this.indexWorker?.getStatus() ?? { running: false, processing: false };

    // pendingリクエストの数を取得
    const pendingRequests = await this.dbEngine.findIndexRequests({ status: 'pending' });

    return {
      server: {
        version: '0.1.0',
        uptime: Date.now() - this.startTime,
        pid: process.pid,
      },
      index: {
        totalDocuments: stats.totalDocuments,
        totalSections: stats.totalSections,
        dirtyCount: stats.dirtyCount,
      },
      worker: {
        running: workerStatus.running,
        processing: workerStatus.processing ? 1 : 0,
        queue: pendingRequests.length,
      },
    };
  }
}
