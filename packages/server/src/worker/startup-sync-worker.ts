/**
 * StartupSyncWorker
 * サーバ起動時の初期インデックス同期をバックグラウンドで実行するワーカー
 */

import type { RebuildIndexResponse } from '@search-docs/types';

/**
 * StartupSyncWorker
 *
 * 役割:
 * - 起動時の初期インデックス同期を非同期で実行
 * - HTTPサーバ起動をブロックしない
 * - 同期完了まで状態を管理
 */
export class StartupSyncWorker {
  private isSyncing = false;
  private syncPromise: Promise<void> | null = null;

  /**
   * バックグラウンドで初期同期を開始
   *
   * @param rebuildFn - インデックス再構築関数
   */
  startSync(rebuildFn: () => Promise<RebuildIndexResponse>): void {
    if (this.isSyncing) {
      console.warn('[StartupSyncWorker] Sync already in progress');
      return;
    }

    this.isSyncing = true;
    this.syncPromise = this.runSync(rebuildFn);
  }

  /**
   * 同期処理の実行
   *
   * @param rebuildFn - インデックス再構築関数
   */
  private async runSync(rebuildFn: () => Promise<RebuildIndexResponse>): Promise<void> {
    try {
      console.log('[StartupSyncWorker] Starting initial index sync...');
      const startTime = Date.now();

      const result = await rebuildFn();

      const duration = Date.now() - startTime;
      console.log(
        `[StartupSyncWorker] Sync completed: ${result.documentsProcessed} documents processed in ${duration}ms`
      );
    } catch (error) {
      console.error('[StartupSyncWorker] Sync failed:', error);
    } finally {
      this.isSyncing = false;
    }
  }

  /**
   * 同期中かどうか
   *
   * @returns 同期中の場合true
   */
  isSyncInProgress(): boolean {
    return this.isSyncing;
  }

  /**
   * 同期完了を待機（テスト用）
   *
   * 注意: 本番環境では使用しない。テストでのみ使用。
   */
  async waitForSync(): Promise<void> {
    if (this.syncPromise) {
      await this.syncPromise;
    }
  }
}
