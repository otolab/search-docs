/**
 * IndexWorker
 * バックグラウンドでIndexRequestを処理するワーカー
 */

import type { DBEngine, IndexRequest } from '@search-docs/db-engine';
import type { DocumentStorage } from '@search-docs/types';
import type { Splitter } from '../splitter/index.js';

export interface IndexWorkerOptions {
  dbEngine: DBEngine;
  storage: DocumentStorage;
  splitter: Splitter;
  interval?: number; // ms（デフォルト: 5000）
  maxConcurrent?: number; // 最大同時処理数（デフォルト: 3）
}

export class IndexWorker {
  private dbEngine: DBEngine;
  private storage: DocumentStorage;
  private splitter: Splitter;
  private interval: number;
  private maxConcurrent: number;
  private timer: NodeJS.Timeout | null = null;
  private isRunning = false;
  private isProcessing = false;

  constructor(options: IndexWorkerOptions) {
    this.dbEngine = options.dbEngine;
    this.storage = options.storage;
    this.splitter = options.splitter;
    this.interval = options.interval ?? 5000;
    this.maxConcurrent = options.maxConcurrent ?? 3;
  }

  /**
   * ワーカーを開始
   */
  start(): void {
    if (this.isRunning) {
      console.log('[IndexWorker] Already running');
      return;
    }

    this.isRunning = true;
    console.log(`[IndexWorker] Starting (interval: ${this.interval}ms, maxConcurrent: ${this.maxConcurrent})`);

    // 初回は即座に実行
    this.processNextRequests().catch((error) => {
      console.error('[IndexWorker] Error in initial processing:', error);
    });

    // 定期実行を設定
    this.timer = setInterval(() => {
      if (!this.isProcessing) {
        this.processNextRequests().catch((error) => {
          console.error('[IndexWorker] Error in periodic processing:', error);
        });
      }
    }, this.interval);
  }

  /**
   * ワーカーを停止
   */
  stop(): void {
    if (!this.isRunning) {
      console.log('[IndexWorker] Not running');
      return;
    }

    console.log('[IndexWorker] Stopping...');
    this.isRunning = false;

    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
    }

    console.log('[IndexWorker] Stopped');
  }

  /**
   * 次のリクエストを処理
   */
  async processNextRequests(): Promise<void> {
    if (this.isProcessing) {
      return;
    }

    this.isProcessing = true;

    try {
      // 1. 処理すべきリクエストを取得
      const requests = await this.getNextRequests();

      if (requests.length === 0) {
        return;
      }

      console.log(`[IndexWorker] Processing ${requests.length} index requests`);

      // 2. 1件ずつ処理（将来的には並列化可能）
      for (const request of requests) {
        await this.processRequest(request);
      }
    } finally {
      this.isProcessing = false;
    }
  }

  /**
   * 次に処理すべきリクエストを取得
   * 各document_path毎に最新のpendingリクエストのみを返す
   */
  private async getNextRequests(): Promise<IndexRequest[]> {
    // 1. すべてのpendingリクエストを取得
    const allPending = await this.dbEngine.findIndexRequests({
      status: 'pending',
      order: 'created_at ASC',
    });

    if (allPending.length === 0) {
      return [];
    }

    // 2. document_path毎にグループ化
    const grouped = new Map<string, IndexRequest[]>();
    for (const request of allPending) {
      if (!grouped.has(request.documentPath)) {
        grouped.set(request.documentPath, []);
      }
      grouped.get(request.documentPath)!.push(request);
    }

    // 3. 各グループで最新のもののみ抽出
    const latest: IndexRequest[] = [];
    for (const [_path, requests] of grouped) {
      // created_at降順でソートして最新を取得
      requests.sort((a, b) => {
        const aTime = new Date(a.createdAt).getTime();
        const bTime = new Date(b.createdAt).getTime();
        return bTime - aTime;
      });
      latest.push(requests[0]);
    }

    console.log(
      `[IndexWorker] Found ${allPending.length} pending requests, processing ${latest.length} latest ones`
    );

    return latest;
  }

  /**
   * 1つのリクエストを処理
   */
  private async processRequest(request: IndexRequest): Promise<void> {
    const hashPrefix = request.documentHash.slice(0, 8);
    console.log(`[IndexWorker] Processing: ${request.documentPath} (${hashPrefix})`);

    try {
      // 1. ステータスを更新
      await this.dbEngine.updateIndexRequest(request.id, {
        status: 'processing',
        startedAt: new Date().toISOString(),
      });

      // 2. 同じdocument_pathの古いpendingリクエストをskip
      await this.dbEngine.updateManyIndexRequests(
        {
          documentPath: request.documentPath,
          status: 'pending',
          createdAt: { $lt: request.createdAt },
        },
        {
          status: 'skipped',
          completedAt: new Date().toISOString(),
        }
      );

      // 3. storageから文書を取得
      const doc = await this.storage.get(request.documentPath);
      if (!doc) {
        throw new Error(`Document not found: ${request.documentPath}`);
      }

      // 4. ハッシュが一致するか確認
      if (doc.metadata.fileHash !== request.documentHash) {
        // 処理中に更新されたので、このリクエストは古い
        console.log(`[IndexWorker] Document updated during processing: ${request.documentPath}`);
        await this.dbEngine.updateIndexRequest(request.id, {
          status: 'completed',
          completedAt: new Date().toISOString(),
        });
        return;
      }

      // 5. 既存の同じハッシュのindexがあるかチェック
      const existingSections = await this.dbEngine.findSectionsByPathAndHash(
        request.documentPath,
        request.documentHash
      );

      if (existingSections.length > 0) {
        console.log(
          `[IndexWorker] Index already exists for ${request.documentPath} (${hashPrefix})`
        );

        // 既に存在する場合は、古いindexだけ削除
        await this.dbEngine.deleteSectionsByPathExceptHash(
          request.documentPath,
          request.documentHash
        );

        await this.dbEngine.updateIndexRequest(request.id, {
          status: 'completed',
          completedAt: new Date().toISOString(),
        });
        return;
      }

      // 6. インデックスを生成
      console.log(`[IndexWorker] Generating index for ${request.documentPath}`);
      const sections = this.splitter.split(
        doc.content,
        request.documentPath,
        request.documentHash
      );

      // 7. 新しいindexを保存（一括追加）
      await this.dbEngine.addSections(sections);
      console.log(`[IndexWorker] Created ${sections.length} sections for ${request.documentPath}`);

      // 8. 古いindexを削除
      await this.dbEngine.deleteSectionsByPathExceptHash(
        request.documentPath,
        request.documentHash
      );

      // 9. リクエストを完了マーク
      await this.dbEngine.updateIndexRequest(request.id, {
        status: 'completed',
        completedAt: new Date().toISOString(),
      });

      console.log(`[IndexWorker] Completed: ${request.documentPath} (${hashPrefix})`);
    } catch (error) {
      console.error(`[IndexWorker] Failed to process ${request.documentPath}:`, error);

      await this.dbEngine.updateIndexRequest(request.id, {
        status: 'failed',
        completedAt: new Date().toISOString(),
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }

  /**
   * ワーカーの状態を取得
   */
  getStatus(): { running: boolean; processing: boolean } {
    return {
      running: this.isRunning,
      processing: this.isProcessing,
    };
  }
}
