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
import { DocumentQueue } from '../worker/document-queue.js';
import { StartupSyncWorker } from '../worker/startup-sync-worker.js';
import { reconcileStartup } from './startup-reconciliation.js';

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
  private documentQueue = new DocumentQueue();
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
  private stopping = false;
  private stopPromise: Promise<void> | null = null;
  private coordination: Promise<void> | null = null;
  private heartbeatUpdates = new Set<Promise<void>>();
  private claimAttempted = false;
  private ownershipGeneration = 0;
  private stopConnectionWait!: () => void;
  private readonly connectionStop = new Promise<void>(resolve => { this.stopConnectionWait = resolve; });
  private deletionFailure: Error | null = null;
  private eventHandlers = new Set<Promise<void>>();
  private reconciliationWarnings: string[] = [];

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
        const handling = this.handleFileChange(event).catch((error) => {
          console.error('File change handling error:', error);
          if (event.type === 'unlink') {
            this.deletionFailure = error instanceof Error ? error : new Error(String(error));
          }
        });
        this.eventHandlers.add(handling);
        void handling.finally(() => this.eventHandlers.delete(handling));
      });
      this.watcher.on('error', (error: Error) => {
        console.error('File watcher error:', error);
      });
    }

    if (config.worker.enabled) {
      this.indexWorker = new IndexWorker({
        dbEngine: this.dbEngine,
        documentQueue: this.documentQueue,
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

    const connection = this.dbEngine.connect();
    void connection.then(() => {
      if (this.stopping) this.dbEngine.disconnect();
    }, () => {});

    this.runCoordination(async () => {
      await Promise.race([
        connection.then(() => this.dbEngine.waitForConnection()),
        this.connectionStop,
      ]);
      if (this.stopping) return;
      console.log('[WatcherProcess] DB connected, starting writer coordination');
      this.writerState = 'sleeping';
      await this.checkAndClaimMaster();
      if (!this.stopping) this.startMasterCheck();
    });
  }

  stop(): Promise<void> {
    if (!this.stopPromise) this.stopPromise = this.stopInternal();
    return this.stopPromise;
  }

  private async stopInternal(): Promise<void> {
    console.log('[WatcherProcess] Stopping...');

    this.stopping = true;
    this.stopConnectionWait();
    this.stopMasterCheck();
    await this.coordination;

    if (this.indexWorker) {
      this.indexWorker.stop();
    }
    if (this.watcher?.isRunning()) {
      await this.watcher.stop();
    }
    await this.startupSyncWorker.waitForSync();
    await this.indexWorker?.waitForProcessing();
    await this.documentQueue.drain();
    await Promise.all(this.eventHandlers);
    this.stopHeartbeat();
    await Promise.all(this.heartbeatUpdates);

    let releaseFailure: unknown;
    // Release mastership if we're the master
    if (this.writerState === 'watching' || this.claimAttempted) {
      try {
        const result = await this.dbEngine.releaseWriter({ writerId: this.writerId });
        if (result.success) console.log('[WatcherProcess] Released writer mastership');
        else console.log('[WatcherProcess] Writer mastership already belongs to another writer');
      } catch (error) {
        console.error('[WatcherProcess] Failed to release mastership:', error);
        releaseFailure = error;
      }
    }

    this.dbEngine.disconnect();
    if (this.deletionFailure && releaseFailure) {
      throw new AggregateError([this.deletionFailure, releaseFailure], 'Deletion and writer release failed during shutdown');
    }
    if (this.deletionFailure) throw this.deletionFailure;
    if (releaseFailure) throw new Error(`Writer release failed during shutdown; takeover may be delayed until heartbeat expiry: ${releaseFailure instanceof Error ? releaseFailure.message : 'unknown error'}`);
  }

  /**
   * 即座に停止する（シグナルハンドラ用）
   *
   * mastershipの解放は行わない（120秒で自動復旧する）。
   * タイマーとワーカーを即座に停止し、新規処理を防ぐ。
   */
  shutdown(): void {
    console.log('[WatcherProcess] Shutdown...');
    this.stopHeartbeat();
    this.stopMasterCheck();

    if (this.indexWorker) {
      this.indexWorker.stop();
    }
    if (this.watcher?.isRunning()) {
      // fire-and-forget: watcher.stop()はawaitしない
      void this.watcher.stop();
    }
  }

  /**
   * Master確認とclaim試行
   */
  private async checkAndClaimMaster(): Promise<void> {
    try {
      if (this.stopping) return;
      const response = await this.dbEngine.getWriterHeartbeat();
      if (this.stopping) return;

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
    if (this.stopping) return;

    this.writerState = 'claiming';
    this.claimAttempted = true;
    await this.dbEngine.claimWriter({
      writerId: this.writerId,
      host: os.hostname(),
      pid: process.pid,
    });
    console.log(`[WatcherProcess] Claimed, waiting ${WatcherProcess.CLAIM_READBACK_DELAY_MS}ms for readback`);

    await this.sleep(WatcherProcess.CLAIM_READBACK_DELAY_MS);
    if (this.stopping) return;

    // Readback
    const readback = await this.dbEngine.getWriterHeartbeat();
    if (this.stopping) return;

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
    if (this.stopping || this.writerState === 'watching') return;

    console.log('[WatcherProcess] → WATCHING');

    // Heartbeat を watching に更新
    await this.dbEngine.updateHeartbeat({
      writerId: this.writerId,
      host: os.hostname(),
      pid: process.pid,
      state: 'watching',
    });
    if (this.stopping) return;

    // 前の writer が処理中に終了したリクエストを再実行できるようにする。
    await this.dbEngine.updateManyIndexRequests({ status: 'processing' }, { status: 'pending' });
    if (this.stopping) return;
    this.writerState = 'watching';

    // パフォーマンスログ設定
    console.log('[WatcherProcess] ENABLE_PERFORMANCE_LOG:', process.env.ENABLE_PERFORMANCE_LOG);
    console.log('[WatcherProcess] PERFORMANCE_LOG_PATH:', process.env.PERFORMANCE_LOG_PATH);
    if (process.env.ENABLE_PERFORMANCE_LOG === '1') {
      const logPath = process.env.PERFORMANCE_LOG_PATH;
      this.dbEngine.startPerformanceLogging(logPath);
      console.log(`[WatcherProcess] Performance logging enabled at ${logPath}`);
    }

    // Subscribe before checking absence so later recreation is delivered to the queue.
    this.reconciliationWarnings = [];
    this.startHeartbeat();
    if (this.watcher && !this.watcher.isRunning()) {
      try {
        await this.watcher.start();
        console.log('[WatcherProcess] FileWatcher started');
      } catch (error) {
        const message = `監視を開始できないため起動時照合を保留します: ${error instanceof Error ? error.message : '不明なエラー'}`;
        this.reconciliationWarnings.push(message);
        console.warn(message);
      }
    }
    if (this.stopping || this.writerState !== 'watching') return;
    const generation = this.ownershipGeneration;
    this.startupSyncWorker.startSync(async () => {
      if (this.watcher) {
        await reconcileStartup({
          root: this.config.project.root, storage: this.storage, db: this.dbEngine,
          discovery: this.discovery, queue: this.documentQueue,
          covered: (filePath) => this.watcher?.covers(filePath) ?? false,
          active: () => !this.stopping && this.writerState === 'watching' && generation === this.ownershipGeneration,
          report: (message) => { this.reconciliationWarnings.push(message); console.warn(message); },
        });
      } else {
        const message = '監視が無効のため起動時の削除照合を保留しました';
        this.reconciliationWarnings.push(message);
        console.warn(message);
      }
      if (this.stopping || this.writerState !== 'watching' || generation !== this.ownershipGeneration) return { success: false, documentsProcessed: 0, sectionsCreated: 0 };
      this.indexWorker?.start();
      return this.rebuildIndex({ force: false });
    });
  }

  /**
   * Sleeping状態に遷移（FileWatcher/IndexWorker停止）
   */
  private async transitionToSleeping(): Promise<void> {
    if (this.writerState === 'sleeping') return;

    console.log('[WatcherProcess] → SLEEPING');
    this.writerState = 'sleeping';
    this.ownershipGeneration++;

    this.stopHeartbeat();

    if (this.indexWorker) {
      this.indexWorker.stop();
      console.log('[WatcherProcess] IndexWorker stopped');
    }
    if (this.watcher?.isRunning()) {
      await this.watcher.stop(false);
      console.log('[WatcherProcess] FileWatcher stopped');
    }
  }

  /**
   * Heartbeat定期更新を開始
   */
  private startHeartbeat(): void {
    if (this.heartbeatTimer) return;

    this.heartbeatTimer = setInterval(() => {
      const update = (async () => {
        try {
          await this.dbEngine.updateHeartbeat({
            writerId: this.writerId,
            host: os.hostname(),
            pid: process.pid,
            state: 'watching',
          });
        } catch (error) {
          await this.handleHeartbeatUpdateFailure(error);
        }
      })();
      this.heartbeatUpdates.add(update);
      void update.finally(() => this.heartbeatUpdates.delete(update));
    }, WatcherProcess.HEARTBEAT_INTERVAL_MS);
  }

  /**
   * Heartbeat更新の最終失敗を処理する。
   *
   * Python側では一時的なcommit競合をリトライするため、ここに到達した時点で
   * リトライが枯渇している。再読込で自分のmastershipが残っている場合は、
   * 競合後のheartbeatがまだ反映されている可能性があるためFileWatcherを維持する。
   */
  private async handleHeartbeatUpdateFailure(error: unknown): Promise<void> {
    console.error('[WatcherProcess] Heartbeat update failed after retries:', error);

    try {
      const current = await this.dbEngine.getWriterHeartbeat();
      if (current.exists && current.heartbeat?.writerId === this.writerId) {
        console.warn('[WatcherProcess] Mastership is still held; keeping FileWatcher running');
        return;
      }

      console.log('[WatcherProcess] Mastership lost after heartbeat update failure');
    } catch (readbackError) {
      console.error('[WatcherProcess] Failed to verify mastership after heartbeat update failure:', readbackError);
    }

    await this.transitionToSleeping();
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
      this.runCoordination(() => this.checkAndClaimMaster());
    }, WatcherProcess.MASTER_CHECK_INTERVAL_MS);
  }

  private stopMasterCheck(): void {
    if (this.masterCheckTimer) {
      clearInterval(this.masterCheckTimer);
      this.masterCheckTimer = null;
    }
  }

  private runCoordination(operation: () => Promise<void>): void {
    if (this.stopping || this.coordination) return;
    const pending = operation().catch(error => {
      console.error('[WatcherProcess] Writer coordination failed:', error);
    }).finally(() => {
      if (this.coordination === pending) this.coordination = null;
    });
    this.coordination = pending;
  }

  getStatus(): {
    writerState: 'sleeping' | 'claiming' | 'watching';
    writerId: string;
    indexWorker: { running: boolean; processing: boolean } | null;
    reconciliationWarnings: string[];
  } {
    return {
      writerState: this.writerState,
      writerId: this.writerId,
      indexWorker: this.indexWorker?.getStatus() ?? null,
      reconciliationWarnings: this.reconciliationWarnings,
    };
  }

  private sleep(ms: number): Promise<void> {
    return new Promise((resolve) => setTimeout(resolve, ms));
  }

  // ---- 以下、既存の書き込み系メソッド（変更なし） ----

  private async handleFileChange(event: FileChangeEvent): Promise<void> {
    const generation = this.ownershipGeneration;
    return this.documentQueue.run(event.path, () => this.handleLockedFileChange(event, generation));
  }

  private async handleLockedFileChange(event: FileChangeEvent, generation: number): Promise<void> {
    if (generation !== this.ownershipGeneration) return;
    console.log(`File ${event.type}: ${event.path}`);

    switch (event.type) {
      case 'add':
      case 'change': {
        const absolutePath = path.join(this.config.project.root, event.path);
        const stat = await fs.stat(absolutePath);
        if (generation !== this.ownershipGeneration) return;
        if (stat.size > this.config.files.maxFileSize) {
          console.warn(
            `Skipping oversized file ${event.path} (${stat.size} bytes > ${this.config.files.maxFileSize} bytes)`
          );
          return;
        }

        const content = await fs.readFile(absolutePath, 'utf-8');
        if (generation !== this.ownershipGeneration) return;
        const hash = createHash('sha256').update(content).digest('hex');

        const existingDoc = await this.storage.get(event.path);
        if (generation !== this.ownershipGeneration) return;
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
        if (generation !== this.ownershipGeneration) return;
        await this.dbEngine.createIndexRequest({
          documentPath: event.path,
          documentHash: hash,
        });
        console.log(`Created IndexRequest for ${event.path} (${hash.slice(0, 8)})`);
        break;
      }

      case 'unlink':
        await this.dbEngine.deleteSectionsByPath(event.path);
        if (generation !== this.ownershipGeneration) return;
        await this.storage.delete(event.path);
        break;
    }
  }

  private async indexDocument(filePath: string, force = false): Promise<{ success: boolean; sectionsCreated: number }> {
    const generation = this.ownershipGeneration;
    return this.documentQueue.run(filePath, () => this.indexLockedDocument(filePath, force, generation));
  }

  private async indexLockedDocument(filePath: string, force: boolean, generation: number): Promise<{ success: boolean; sectionsCreated: number }> {
    if (generation !== this.ownershipGeneration) return { success: false, sectionsCreated: 0 };
    const absolutePath = path.join(this.config.project.root, filePath);
    const stat = await fs.stat(absolutePath);
    if (generation !== this.ownershipGeneration) return { success: false, sectionsCreated: 0 };
    if (stat.size > this.config.files.maxFileSize) {
      return { success: false, sectionsCreated: 0 };
    }

    const content = await fs.readFile(absolutePath, 'utf-8');
    if (generation !== this.ownershipGeneration) return { success: false, sectionsCreated: 0 };
    const hash = createHash('sha256').update(content).digest('hex');

    const existingDoc = await this.storage.get(filePath);
    if (generation !== this.ownershipGeneration) return { success: false, sectionsCreated: 0 };
    if (existingDoc && existingDoc.metadata.fileHash === hash && !force) {
      const { sections: existingSections } = await this.dbEngine.getSectionsByPath(filePath);
      if (generation !== this.ownershipGeneration) return { success: false, sectionsCreated: 0 };
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
    if (generation !== this.ownershipGeneration) return { success: false, sectionsCreated: 0 };
    await this.dbEngine.createIndexRequest({
      documentPath: filePath,
      documentHash: hash,
    });

    return { success: true, sectionsCreated: 0 };
  }

  private async rebuildIndex(request: { paths?: string[]; force?: boolean } = {}): Promise<RebuildIndexResponse> {
    const { paths, force = false } = request;
    const generation = this.ownershipGeneration;

    let filesToIndex: string[];
    if (paths && paths.length > 0) {
      filesToIndex = paths;
    } else {
      filesToIndex = await this.discovery.findFiles();
    }

    let documentsProcessed = 0;
    let sectionsCreated = 0;

    for (const fp of filesToIndex) {
      if (generation !== this.ownershipGeneration) break;
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
