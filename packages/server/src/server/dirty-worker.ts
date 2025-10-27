import type { DBEngine } from '@search-docs/db-engine';
import type { SearchDocsServer } from './search-docs-server.js';

/**
 * Dirtyセクションを定期的に再インデックスするワーカー
 */
export class DirtyWorker {
  private intervalId: NodeJS.Timeout | null = null;
  private isProcessing = false;
  private processingCount = 0;

  constructor(
    private dbEngine: DBEngine,
    private server: SearchDocsServer,
    private interval: number,
    private maxConcurrent: number = 10
  ) {}

  /**
   * ワーカー開始
   */
  start(): void {
    if (this.intervalId) {
      console.warn('DirtyWorker is already running');
      return;
    }

    console.log(`DirtyWorker started (interval: ${this.interval}ms)`);

    this.intervalId = setInterval(() => {
      this.processQueue().catch((error) => {
        console.error('DirtyWorker error:', error);
      });
    }, this.interval);
  }

  /**
   * ワーカー停止
   */
  stop(): void {
    if (this.intervalId) {
      clearInterval(this.intervalId);
      this.intervalId = null;
      console.log('DirtyWorker stopped');
    }
  }

  /**
   * 現在の状態を取得
   */
  getStatus() {
    return {
      running: this.intervalId !== null,
      processing: this.processingCount,
      queue: 0, // getDirtySections()の結果から取得する必要がある
    };
  }

  /**
   * Dirtyキューを処理
   */
  private async processQueue(): Promise<void> {
    if (this.isProcessing) {
      return; // 既に処理中
    }

    this.isProcessing = true;

    try {
      // Dirtyセクションを取得
      const response = await this.dbEngine.getDirtySections(this.maxConcurrent);

      if (response.sections.length === 0) {
        return; // 処理対象なし
      }

      console.log(`Processing ${response.sections.length} dirty sections...`);

      this.processingCount = response.sections.length;

      // 文書ごとにグループ化
      const documentPaths = new Set(
        response.sections.map((section) => section.documentPath)
      );

      // 各文書を再インデックス
      for (const path of documentPaths) {
        try {
          await this.server.indexDocument({ path, force: true });
          console.log(`Re-indexed: ${path}`);
        } catch (error) {
          console.error(`Failed to re-index ${path}:`, error);
        }
      }

      this.processingCount = 0;
    } finally {
      this.isProcessing = false;
    }
  }
}
