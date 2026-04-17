import { promises as fs } from 'fs';
import { createHash } from 'crypto';
import * as path from 'path';
import type {
  SearchDocsConfig,
  Document,
  RebuildIndexResponse,
} from '@search-docs/types';
import { FileStorage } from '@search-docs/storage';
import { DBEngine } from '@search-docs/db-engine';
import { MarkdownSplitter } from '../splitter/markdown-splitter.js';
import { FileDiscovery } from '../discovery/file-discovery.js';
import { FileWatcher, type FileChangeEvent } from '../discovery/file-watcher.js';
import { IndexWorker } from '../worker/index.js';
import { StartupSyncWorker } from '../worker/startup-sync-worker.js';

/**
 * WatcherProcess
 *
 * SearchDocsServer から書き込み系機能を抽出した独立クラス。
 * FileWatcher, IndexWorker, StartupSyncWorker を管理し、
 * ファイル変更イベントの処理とインデックス化を担当する。
 */
export class WatcherProcess {
  private splitter: MarkdownSplitter;
  private discovery: FileDiscovery;
  private watcher?: FileWatcher;
  private indexWorker?: IndexWorker;
  private startupSyncWorker: StartupSyncWorker;

  constructor(
    private config: SearchDocsConfig,
    private storage: FileStorage,
    private dbEngine: DBEngine,
  ) {
    this.splitter = new MarkdownSplitter(config.indexing);
    this.discovery = new FileDiscovery({
      rootDir: config.project.root,
      config: config.files,
    });

    if (config.watcher.enabled) {
      this.watcher = new FileWatcher({
        rootDir: config.project.root,
        filesConfig: config.files,
        watcherConfig: config.watcher,
      });
      this.watcher.on('change', (event: FileChangeEvent) => {
        this.handleFileChange(event).catch((error) => {
          console.error('File change handling error:', error);
        });
      });
      this.watcher.on('error', (error: Error) => {
        console.error('File watcher error:', error);
      });
    }

    if (config.worker.enabled) {
      this.indexWorker = new IndexWorker({
        dbEngine: this.dbEngine,
        storage: this.storage,
        splitter: this.splitter,
        interval: config.worker.interval,
        maxConcurrent: config.worker.maxConcurrent,
        delayBetweenDocuments: config.worker.delayBetweenDocuments,
      });
    }

    this.startupSyncWorker = new StartupSyncWorker();
  }

  async start(): Promise<void> {
    // DB接続をバックグラウンドで開始
    this.dbEngine.connect().catch((error) => {
      console.error('[WatcherProcess] DB connection failed:', error);
    });

    // DB接続完了後にパフォーマンスログ、StartupSyncWorker、IndexWorker を起動
    this.dbEngine.waitForConnection().then(() => {
      console.log('[WatcherProcess] ENABLE_PERFORMANCE_LOG:', process.env.ENABLE_PERFORMANCE_LOG);
      console.log('[WatcherProcess] PERFORMANCE_LOG_PATH:', process.env.PERFORMANCE_LOG_PATH);
      if (process.env.ENABLE_PERFORMANCE_LOG === '1') {
        const logPath = process.env.PERFORMANCE_LOG_PATH;
        this.dbEngine.startPerformanceLogging(logPath);
        console.log(`[WatcherProcess] Performance logging enabled at ${logPath}`);
        console.log('[WatcherProcess] Logs will be rotated at 10MB');
        console.log('[WatcherProcess] Maximum 5 backup files will be kept');
      }

      if (this.startupSyncWorker) {
        this.startupSyncWorker.startSync(() => this.rebuildIndex({ force: false }));
      }

      if (this.indexWorker) {
        this.indexWorker.start();
      }
    }).catch((error) => {
      console.error('[WatcherProcess] Failed to start DB-dependent workers:', error);
    });

    // FileWatcher を開始
    if (this.watcher) {
      await this.watcher.start();
    }
  }

  async stop(): Promise<void> {
    if (this.indexWorker) {
      this.indexWorker.stop();
    }
    if (this.watcher) {
      await this.watcher.stop();
    }
    this.dbEngine.disconnect();
  }

  private async handleFileChange(event: FileChangeEvent): Promise<void> {
    console.log(`File ${event.type}: ${event.path}`);

    switch (event.type) {
      case 'add':
      case 'change': {
        const absolutePath = path.join(this.config.project.root, event.path);
        const stat = await fs.stat(absolutePath);
        if (stat.size > this.config.files.maxFileSize) {
          console.warn(
            `Skipping oversized file ${event.path} (${stat.size} bytes > ${this.config.files.maxFileSize} bytes)`
          );
          return;
        }

        const content = await fs.readFile(absolutePath, 'utf-8');
        const hash = createHash('sha256').update(content).digest('hex');

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
        await this.dbEngine.createIndexRequest({
          documentPath: event.path,
          documentHash: hash,
        });
        console.log(`Created IndexRequest for ${event.path} (${hash.slice(0, 8)})`);
        break;
      }

      case 'unlink':
        await this.dbEngine.deleteSectionsByPath(event.path);
        await this.storage.delete(event.path);
        break;
    }
  }

  private async indexDocument(path: string, force = false): Promise<{ success: boolean; sectionsCreated: number }> {
    const stat = await fs.stat(path);
    if (stat.size > this.config.files.maxFileSize) {
      return { success: false, sectionsCreated: 0 };
    }

    const content = await fs.readFile(path, 'utf-8');
    const hash = createHash('sha256').update(content).digest('hex');

    const existingDoc = await this.storage.get(path);
    if (existingDoc && existingDoc.metadata.fileHash === hash && !force) {
      const { sections: existingSections } = await this.dbEngine.getSectionsByPath(path);
      if (existingSections.length > 0) {
        return { success: true, sectionsCreated: 0 };
      }
    }

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
    await this.dbEngine.createIndexRequest({
      documentPath: path,
      documentHash: hash,
    });

    return { success: true, sectionsCreated: 0 };
  }

  private async rebuildIndex(request: { paths?: string[]; force?: boolean } = {}): Promise<RebuildIndexResponse> {
    const { paths, force = false } = request;

    let filesToIndex: string[];
    if (paths && paths.length > 0) {
      filesToIndex = paths;
    } else {
      filesToIndex = await this.discovery.findFiles();
    }

    let documentsProcessed = 0;
    let sectionsCreated = 0;

    for (const fp of filesToIndex) {
      try {
        const result = await this.indexDocument(fp, force);
        documentsProcessed++;
        sectionsCreated += result.sectionsCreated;
      } catch (error) {
        console.error(`Failed to index ${fp}:`, error);
      }
    }

    return {
      success: true,
      documentsProcessed,
      sectionsCreated,
    };
  }
}
