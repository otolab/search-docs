import { promises as fs } from 'fs';
import { createHash } from 'crypto';
import * as path from 'path';
import * as os from 'os';
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
 *
 * Heartbeatテーブルによる調停で、複数プロセス間で1つだけが
 * FileWatcherを起動する（masterのみがwatching状態になる）。
 */
export class WatcherProcess {
  private splitter: MarkdownSplitter;
  private discovery: FileDiscovery;
  private watcher?: FileWatcher;
  private indexWorker?: IndexWorker;
  private startupSyncWorker: StartupSyncWorker;

  // Writer coordination
  private writerId: string;
  private writerState: 'sleeping' | 'claiming' | 'watching' = 'sleeping';
  private heartbeatTimer: ReturnType<typeof setInterval> | null = null;
  private masterCheckTimer: ReturnType<typeof setInterval> | null = null;

  // 定数
  private static readonly HEARTBEAT_INTERVAL_MS = 20_000;       // watching時の更新間隔
  private static readonly MASTER_TIMEOUT_MS = 120_000;           // 2分でmaster期限切れ
  private static readonly MASTER_CHECK_INTERVAL_MS = 45_000;     // sleeping時の確認間隔
  private static readonly CLAIM_JITTER_MAX_MS = 5_000;           // claim前のランダム待ち
  private static readonly CLAIM_READBACK_DELAY_MS = 4_000;       // readback前の待ち

  constructor(
    private config: SearchDocsConfig,
    private storage: FileStorage,
    private dbEngine: DBEngine,
  ) {
    this.writerId = `${os.hostname()}-${process.pid}-${Date.now()}`;
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

  start(): void {
    console.log(`[WatcherProcess] Writer ID: ${this.writerId}`);

    // DB接続をバックグラウンドで開始
    this.dbEngine.connect().catch((error) => {
      console.error('[WatcherProcess] DB connection failed:', error);
    });

    // DB接続完了後に調停プロセスを開始
    this.dbEngine.waitForConnection().then(async () => {
      console.log('[WatcherProcess] DB connected, starting writer coordination');
      this.writerState = 'sleeping';
      await this.checkAndClaimMaster();
      this.startMasterCheck();
    }).catch((error) => {
      console.error('[WatcherProcess] Failed to start writer coordination:', error);
    });
  }

  async stop(): Promise<void> {
    console.log('[WatcherProcess] Stopping...');

    this.stopHeartbeat();
    this.stopMasterCheck();

    // Release mastership if we're the master
    if (this.writerState === 'watching') {
      try {
        await this.dbEngine.releaseWriter({ writerId: this.writerId });
        console.log('[WatcherProcess] Released writer mastership');
      } catch (error) {
        console.error('[WatcherProcess] Failed to release mastership:', error);
      }
    }

    if (this.indexWorker) {
      this.indexWorker.stop();
    }
    if (this.watcher?.isRunning()) {
      await this.watcher.stop();
    }
    this.dbEngine.disconnect();
  }

  /**
   * Master確認とclaim試行
   */
  private async checkAndClaimMaster(): Promise<void> {
    try {
      const response = await this.dbEngine.getWriterHeartbeat();

      if (!response.exists) {
        console.log('[WatcherProcess] No master found, attempting to claim');
        await this.attemptClaim();
        return;
      }

      const hb = response.heartbeat!;
      const isMasterExpired = hb.ageSeconds > (WatcherProcess.MASTER_TIMEOUT_MS / 1000);

      if (hb.writerId === this.writerId) {
        // 自分がmaster → watching維持/遷移
        if (this.writerState !== 'watching') {
          await this.transitionToWatching();
        }
        return;
      }

      if (isMasterExpired) {
        console.log(`[WatcherProcess] Master expired (${hb.ageSeconds.toFixed(1)}s old), attempting to claim`);
        await this.attemptClaim();
        return;
      }

      // 他のプロセスがmaster
      console.log(`[WatcherProcess] Master is ${hb.writerId} (state: ${hb.state}, age: ${hb.ageSeconds.toFixed(1)}s)`);
      if (this.writerState !== 'sleeping') {
        await this.transitionToSleeping();
      }
    } catch (error) {
      console.error('[WatcherProcess] Error checking master:', error);
    }
  }

  /**
   * Master claim を試行（thundering herd対策付き）
   */
  private async attemptClaim(): Promise<void> {
    const jitter = Math.random() * WatcherProcess.CLAIM_JITTER_MAX_MS;
    console.log(`[WatcherProcess] Waiting ${jitter.toFixed(0)}ms jitter before claim`);
    await this.sleep(jitter);

    this.writerState = 'claiming';
    await this.dbEngine.claimWriter({
      writerId: this.writerId,
      host: os.hostname(),
      pid: process.pid,
    });
    console.log(`[WatcherProcess] Claimed, waiting ${WatcherProcess.CLAIM_READBACK_DELAY_MS}ms for readback`);

    await this.sleep(WatcherProcess.CLAIM_READBACK_DELAY_MS);

    // Readback
    const readback = await this.dbEngine.getWriterHeartbeat();

    if (!readback.exists || readback.heartbeat!.writerId !== this.writerId) {
      const winner = readback.heartbeat?.writerId ?? 'unknown';
      console.log(`[WatcherProcess] Claim lost to ${winner}`);
      await this.transitionToSleeping();
      return;
    }

    console.log('[WatcherProcess] Claim won, transitioning to watching');
    await this.transitionToWatching();
  }

  /**
   * Watching状態に遷移（FileWatcher/IndexWorker/StartupSync起動）
   */
  private async transitionToWatching(): Promise<void> {
    if (this.writerState === 'watching') return;

    console.log('[WatcherProcess] → WATCHING');
    this.writerState = 'watching';

    // Heartbeat を watching に更新
    await this.dbEngine.updateHeartbeat({
      writerId: this.writerId,
      host: os.hostname(),
      pid: process.pid,
      state: 'watching',
    });

    // パフォーマンスログ設定
    console.log('[WatcherProcess] ENABLE_PERFORMANCE_LOG:', process.env.ENABLE_PERFORMANCE_LOG);
    console.log('[WatcherProcess] PERFORMANCE_LOG_PATH:', process.env.PERFORMANCE_LOG_PATH);
    if (process.env.ENABLE_PERFORMANCE_LOG === '1') {
      const logPath = process.env.PERFORMANCE_LOG_PATH;
      this.dbEngine.startPerformanceLogging(logPath);
      console.log(`[WatcherProcess] Performance logging enabled at ${logPath}`);
    }

    // StartupSync
    if (this.startupSyncWorker) {
      this.startupSyncWorker.startSync(() => this.rebuildIndex({ force: false }));
    }

    // IndexWorker
    if (this.indexWorker) {
      this.indexWorker.start();
    }

    // FileWatcher
    if (this.watcher && !this.watcher.isRunning()) {
      await this.watcher.start();
      console.log('[WatcherProcess] FileWatcher started');
    }

    // Heartbeat定期更新を開始
    this.startHeartbeat();
  }

  /**
   * Sleeping状態に遷移（FileWatcher/IndexWorker停止）
   */
  private async transitionToSleeping(): Promise<void> {
    if (this.writerState === 'sleeping') return;

    console.log('[WatcherProcess] → SLEEPING');
    this.writerState = 'sleeping';

    this.stopHeartbeat();

    if (this.watcher?.isRunning()) {
      await this.watcher.stop();
      console.log('[WatcherProcess] FileWatcher stopped');
    }

    if (this.indexWorker) {
      this.indexWorker.stop();
      console.log('[WatcherProcess] IndexWorker stopped');
    }
  }

  /**
   * Heartbeat定期更新を開始
   */
  private startHeartbeat(): void {
    if (this.heartbeatTimer) return;

    this.heartbeatTimer = setInterval(() => {
      void (async () => {
        try {
          await this.dbEngine.updateHeartbeat({
            writerId: this.writerId,
            host: os.hostname(),
            pid: process.pid,
            state: 'watching',
          });
        } catch (error) {
          console.error('[WatcherProcess] Heartbeat update failed:', error);
          await this.transitionToSleeping();
        }
      })();
    }, WatcherProcess.HEARTBEAT_INTERVAL_MS);
  }

  private stopHeartbeat(): void {
    if (this.heartbeatTimer) {
      clearInterval(this.heartbeatTimer);
      this.heartbeatTimer = null;
    }
  }

  /**
   * Master定期確認を開始
   */
  private startMasterCheck(): void {
    if (this.masterCheckTimer) return;

    this.masterCheckTimer = setInterval(() => {
      void this.checkAndClaimMaster();
    }, WatcherProcess.MASTER_CHECK_INTERVAL_MS);
  }

  private stopMasterCheck(): void {
    if (this.masterCheckTimer) {
      clearInterval(this.masterCheckTimer);
      this.masterCheckTimer = null;
    }
  }

  getStatus(): {
    writerState: 'sleeping' | 'claiming' | 'watching';
    writerId: string;
    indexWorker: { running: boolean; processing: boolean } | null;
  } {
    return {
      writerState: this.writerState,
      writerId: this.writerId,
      indexWorker: this.indexWorker?.getStatus() ?? null,
    };
  }

  private sleep(ms: number): Promise<void> {
    return new Promise((resolve) => setTimeout(resolve, ms));
  }

  // ---- 以下、既存の書き込み系メソッド（変更なし） ----

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

  private async indexDocument(filePath: string, force = false): Promise<{ success: boolean; sectionsCreated: number }> {
    const absolutePath = path.join(this.config.project.root, filePath);
    const stat = await fs.stat(absolutePath);
    if (stat.size > this.config.files.maxFileSize) {
      return { success: false, sectionsCreated: 0 };
    }

    const content = await fs.readFile(absolutePath, 'utf-8');
    const hash = createHash('sha256').update(content).digest('hex');

    const existingDoc = await this.storage.get(filePath);
    if (existingDoc && existingDoc.metadata.fileHash === hash && !force) {
      const { sections: existingSections } = await this.dbEngine.getSectionsByPath(filePath);
      if (existingSections.length > 0) {
        return { success: true, sectionsCreated: 0 };
      }
    }

    const document: Document = {
      path: filePath,
      content,
      metadata: {
        createdAt: existingDoc?.metadata.createdAt || new Date(),
        updatedAt: new Date(),
        fileHash: hash,
      },
    };

    await this.storage.save(filePath, document);
    await this.dbEngine.createIndexRequest({
      documentPath: filePath,
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
