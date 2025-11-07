import { promises as fs } from 'fs';
import { createHash } from 'crypto';
import * as path from 'path';
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
import { StartupSyncWorker } from '../worker/startup-sync-worker.js';

/**
 * SearchDocsサーバのメインクラス
 */
export class SearchDocsServer {
  private splitter: MarkdownSplitter;
  private discovery: FileDiscovery;
  private watcher: FileWatcher | null = null;
  private indexWorker: IndexWorker | null = null;
  private startupSyncWorker: StartupSyncWorker | null = null;
  private startTime: number = 0;
  private requestStats = {
    total: 0,
    search: 0,
    getDocument: 0,
    indexDocument: 0,
    rebuildIndex: 0,
  };
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

    // StartupSyncWorker初期化（常に有効）
    this.startupSyncWorker = new StartupSyncWorker();
  }

  /**
   * サーバ起動
   */
  async start(): Promise<void> {
    this.startTime = Date.now();
    await this.dbEngine.connect();

    // パフォーマンスログを開始（環境変数で制御）
    console.log('[SearchDocsServer] ENABLE_PERFORMANCE_LOG:', process.env.ENABLE_PERFORMANCE_LOG);
    console.log('[SearchDocsServer] PERFORMANCE_LOG_PATH:', process.env.PERFORMANCE_LOG_PATH);
    if (process.env.ENABLE_PERFORMANCE_LOG === '1') {
      const logPath = process.env.PERFORMANCE_LOG_PATH;
      this.dbEngine.startPerformanceLogging(logPath);
      console.log('[SearchDocsServer] Performance logging enabled');
      if (logPath) {
        console.log('[SearchDocsServer] Performance log path (specified):', logPath);
      } else {
        console.log('[SearchDocsServer] Performance log path will be auto-generated in .search-docs/');
      }
    } else {
      console.log('[SearchDocsServer] Performance logging disabled');
    }

    // 起動時にインデックスを同期（バックグラウンドで非同期実行）
    if (this.startupSyncWorker) {
      this.startupSyncWorker.startSync(() => this.rebuildIndex({ force: false }));
    }

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
      case 'change': {
        // 1. ファイルを読み込み（event.pathは相対パスなので絶対パスに変換）
        const absolutePath = path.join(this.config.project.root, event.path);
        const content = await fs.readFile(absolutePath, 'utf-8');

        // 2. ハッシュ計算
        const hash = createHash('sha256').update(content).digest('hex');

        // 3. ストレージに保存
        const existingDoc = await this.storage.get(event.path);
        const document: Document = {
          path: event.path,
          content,
          metadata: {
            createdAt: existingDoc?.metadata.createdAt || new Date(),
            updatedAt: new Date(),
            fileHash: hash,
          },
        };
        await this.storage.save(event.path, document);

        // 4. IndexRequestを作成
        await this.dbEngine.createIndexRequest({
          documentPath: event.path,
          documentHash: hash,
        });
        console.log(`Created IndexRequest for ${event.path} (${hash.slice(0, 8)})`);
        break;
      }

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
    this.requestStats.total++;
    this.requestStats.search++;
    const startTime = Date.now();

    // indexStatusによるフィルタ処理
    let excludePaths: string[] | undefined;
    if (
      request.options?.indexStatus === 'latest_only' ||
      request.options?.indexStatus === 'completed_only'
    ) {
      // pending/processingのリクエストがあるdocument_pathを除外
      excludePaths = await this.dbEngine.getPathsWithStatus(['pending', 'processing']);
    }

    const response = await this.dbEngine.search({
      query: request.query,
      ...request.options,
      excludePaths,
    });

    // 各結果にindex状態情報を付与
    const resultsWithStatus = await Promise.all(
      response.results.map(async (section) => {
        const status = await this.computeIndexStatus(section.documentPath, section.documentHash);
        return {
          ...section,
          indexStatus: status.status,
          isLatest: status.isLatest,
          hasPendingUpdate: status.hasPendingUpdate,
        };
      })
    );

    return {
      results: resultsWithStatus,
      total: response.total,
      took: Date.now() - startTime,
    };
  }

  /**
   * 文書取得API
   */
  async getDocument(request: GetDocumentRequest): Promise<GetDocumentResponse> {
    this.requestStats.total++;
    this.requestStats.getDocument++;

    // pathとsectionIdのどちらか一方は必須
    if (!request.path && !request.sectionId) {
      throw new Error('pathまたはsectionIdのどちらか一方を指定してください');
    }

    // sectionIdが指定されている場合はセクションを取得
    if (request.sectionId) {
      const result = await this.dbEngine.getSectionById(request.sectionId);
      return { document: null, section: result.section };
    }

    // 文書全体を取得
    const document = await this.storage.get(request.path!);

    if (!document) {
      throw new Error(`Document not found: ${request.path}`);
    }

    return { document };
  }

  /**
   * 文書インデックスAPI
   */
  async indexDocument(request: IndexDocumentRequest): Promise<IndexDocumentResponse> {
    this.requestStats.total++;
    this.requestStats.indexDocument++;
    const { path, force = false } = request;

    // 1. ファイル読み込み
    const content = await fs.readFile(path, 'utf-8');

    // 2. ハッシュ計算
    const hash = createHash('sha256').update(content).digest('hex');

    // 3. 既存文書をチェック
    const existingDoc = await this.storage.get(path);
    if (existingDoc && existingDoc.metadata.fileHash === hash && !force) {
      // 文書ハッシュが同じ場合、インデックスが存在するか確認
      const { sections: existingSections } = await this.dbEngine.getSectionsByPath(path);
      if (existingSections.length > 0) {
        // インデックスも存在するので、変更なし
        return { success: true, sectionsCreated: 0 };
      }
      // インデックスが存在しない場合は、IndexRequestを作成する必要がある
      console.log(`Document ${path} exists but has no index sections - creating IndexRequest`);
    }

    // 4. 文書をストレージに保存
    const document: Document = {
      path,
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
    this.requestStats.total++;
    this.requestStats.rebuildIndex++;
    const { paths, force = false } = request;

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
          force,
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
    // DBから統計情報を取得（.select()で最適化済み）
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
        syncing: this.startupSyncWorker?.isSyncInProgress() ?? false,
        requests: {
          total: this.requestStats.total,
          search: this.requestStats.search,
          getDocument: this.requestStats.getDocument,
          indexDocument: this.requestStats.indexDocument,
          rebuildIndex: this.requestStats.rebuildIndex,
        },
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

  /**
   * インデックス状態を計算
   */
  private async computeIndexStatus(
    documentPath: string,
    sectionHash: string
  ): Promise<{
    status: 'latest' | 'outdated' | 'updating';
    isLatest: boolean;
    hasPendingUpdate: boolean;
  }> {
    // 1. storageから最新のdocument_hashを取得
    const doc = await this.storage.get(documentPath);
    if (!doc) {
      return {
        status: 'outdated',
        isLatest: false,
        hasPendingUpdate: false,
      };
    }

    const isLatest = sectionHash === doc.metadata.fileHash;

    // 2. pending/processingのリクエストがあるか確認
    const pendingRequests = await this.dbEngine.findIndexRequests({
      documentPath,
      status: ['pending', 'processing'],
    });

    const hasPendingUpdate = pendingRequests.length > 0;

    // 3. ステータスを判定
    let status: 'latest' | 'outdated' | 'updating';
    if (hasPendingUpdate) {
      status = 'updating';
    } else if (isLatest) {
      status = 'latest';
    } else {
      status = 'outdated'; // 通常ありえない（古いindexは削除されるため）
    }

    return { status, isLatest, hasPendingUpdate };
  }
}
