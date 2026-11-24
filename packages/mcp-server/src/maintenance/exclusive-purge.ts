import { MaintenanceLock, UnconfirmedProcessStopError } from '@search-docs/db-engine';

export interface PurgeLayout {
  indexPath: string;
  documentsPath: string;
  managementPath: string;
}

/** 排他取得または削除前検査が失敗し、保守対象を変更していない。 */
export class MaintenanceNotStartedError extends Error {
  constructor(cause: unknown) {
    super(`削除前の確認に失敗しました: ${cause instanceof Error ? cause.message : String(cause)}`, { cause });
    this.name = 'MaintenanceNotStartedError';
  }
}

/** 未公開。validate は削除対象・元文書・保存領域の安全性を検証する。 */
export async function exclusivePurge(options: {
  confirmed: boolean;
  validate: () => Promise<PurgeLayout>;
  remove: (layout: PurgeLayout) => Promise<void>;
}): Promise<void> {
  if (!options.confirmed) throw new Error('インデックス専用領域であること、他ホストや旧版を含む全アクセスが停止していること、処理中にパスやマウントを変更しないことを確認してください');
  if (process.platform === 'win32') throw new Error('Windows では安全な停止を確認できません');
  let layout: PurgeLayout;
  let lease: Awaited<ReturnType<MaintenanceLock['acquireExclusive']>>;
  try {
    layout = await options.validate();
    lease = await new MaintenanceLock(layout.managementPath).acquireExclusive({ requireComplete: true });
  } catch (error) {
    throw new MaintenanceNotStartedError(error);
  }
  let checked: PurgeLayout;
  try {
    checked = await options.validate();
    if (checked.indexPath !== layout.indexPath || checked.documentsPath !== layout.documentsPath || checked.managementPath !== layout.managementPath) {
      throw new Error('保存領域が検査後に変更されました');
    }
  } catch (error) {
    await lease.release();
    throw new MaintenanceNotStartedError(error);
  }
  let retainLock = false;
  try {
    await lease.markIncomplete();
    await options.remove(checked);
    await lease.complete();
  } catch (error) {
    if (error instanceof UnconfirmedProcessStopError) retainLock = true;
    throw error;
  } finally {
    if (!retainLock) await lease.release();
  }
}
